/**
 * Typed Cloudflare client (decision C1).
 *
 * Raw `fetch`, injected, and four endpoints wide. The injection is what makes
 * every test in this repo run against a fake transport with no network and no
 * chance of purging a real cache.
 */
import {
  abortedError,
  errorFromResponse,
  networkError,
  timeoutError,
  CloudflareError,
} from "./errors.ts";
import type {
  Envelope,
  ListZonesParams,
  PurgeAck,
  RawSubscription,
  RawZone,
  VerifyResult,
} from "./types.ts";

export const CLOUDFLARE_BASE_URL = "https://api.cloudflare.com/client/v4";

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

export interface CloudflareClientOptions {
  token: string;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  userAgent?: string;
}

export class CloudflareClient {
  private readonly token: string;
  private readonly doFetch: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;
  private readonly userAgent: string;

  constructor(options: CloudflareClientOptions) {
    if (!options.token) throw new Error("a Cloudflare API token is required");
    this.token = options.token;
    this.doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = (options.baseUrl ?? CLOUDFLARE_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.signal = options.signal;
    this.userAgent = options.userAgent ?? "tanuki";
  }

  /** Decision S9: validate before persisting anything. */
  async verifyToken(signal?: AbortSignal): Promise<VerifyResult> {
    return this.request<VerifyResult>("/user/tokens/verify", { signal });
  }

  async listZonesPage(params: ListZonesParams = {}, signal?: AbortSignal): Promise<{
    zones: RawZone[];
    resultInfo: Envelope<RawZone[]>["result_info"];
  }> {
    const query = new URLSearchParams();
    query.set("page", String(params.page ?? 1));
    // Cloudflare caps per_page at 50 (decision C2).
    query.set("per_page", String(Math.min(params.perPage ?? 50, 50)));
    if (params.name) query.set("name", params.name);
    if (params.status) query.set("status", params.status);

    const envelope = await this.requestEnvelope<RawZone[]>(`/zones?${query.toString()}`, { signal });
    return { zones: envelope.envelope.result ?? [], resultInfo: envelope.envelope.result_info };
  }

  /** Returns null when the zone does not exist (404 / 7003) — decision C10. */
  async getZone(zoneId: string, signal?: AbortSignal): Promise<RawZone | null> {
    try {
      return await this.request<RawZone>(`/zones/${encodeURIComponent(zoneId)}`, { signal });
    } catch (error) {
      if (error instanceof CloudflareError && error.kind === "not-found") return null;
      throw error;
    }
  }

  /** Decision C5: the refinement when `zone.plan` is absent or unreadable. */
  async zoneSubscription(zoneId: string, signal?: AbortSignal): Promise<string | undefined> {
    const subscription = await this.request<RawSubscription>(
      `/zones/${encodeURIComponent(zoneId)}/subscription`,
      { signal },
    );
    return subscription.rate_plan?.id ?? subscription.rate_plan?.name;
  }

  /**
   * Purge everything for one zone. This is a full-cache purge, not a URL purge
   * (decision C3).
   *
   * Resolves only when Cloudflare has accepted the request, and returns what
   * Cloudflare actually said — its acknowledgement id, the status it answered
   * with, the round trip it took and any messages it attached — so the result
   * screen can show the reply rather than a claim about it. "Accepted" is still
   * not "evicted", and nothing here says otherwise (decision C12).
   */
  async purgeEverything(zoneId: string, signal?: AbortSignal): Promise<PurgeAck> {
    const startedAt = Date.now();
    const { envelope, status } = await this.requestEnvelope<{ id?: string }>(
      `/zones/${encodeURIComponent(zoneId)}/purge_cache`,
      {
        method: "POST",
        body: JSON.stringify({ purge_everything: true }),
        signal,
      },
    );

    const result = envelope.result;
    if (!result || typeof result.id !== "string") {
      throw new CloudflareError({
        kind: "unknown",
        message: "Cloudflare accepted the request but returned no purge identifier.",
      });
    }

    return {
      id: result.id,
      status,
      durationMs: Math.max(0, Date.now() - startedAt),
      messages: envelope.messages.map((message) => message.message),
    };
  }

  // ------------------------------------------------------------------ plumbing

  private async request<T>(path: string, init: { method?: string; body?: string; signal?: AbortSignal }): Promise<T> {
    const { envelope } = await this.requestEnvelope<T>(path, init);
    return envelope.result;
  }

  private async requestEnvelope<T>(
    path: string,
    init: { method?: string; body?: string; signal?: AbortSignal },
  ): Promise<{ envelope: Envelope<T>; status: number }> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // Compose abort sources by hand, and detach them afterwards. Leaking a
    // listener per request onto a long-lived signal would eventually trip
    // MaxListenersExceededWarning during a large purge.
    const parents = [this.signal, init.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    const forwardAbort = () => controller.abort();
    for (const parent of parents) {
      if (parent.aborted) {
        controller.abort();
        break;
      }
      parent.addEventListener("abort", forwardAbort, { once: true });
    }

    const detach = () => {
      clearTimeout(timer);
      for (const parent of parents) parent.removeEventListener("abort", forwardAbort);
    };

    let response: FetchResponse;
    try {
      response = await this.doFetch(url, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "User-Agent": this.userAgent,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbort(error)) {
        throw controller.signal.aborted && !parents.some((parent) => parent.aborted)
          ? timeoutError(this.timeoutMs)
          : abortedError();
      }
      throw networkError(error);
    } finally {
      detach();
    }

    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    const text = await response.text().catch(() => "");
    const envelope = parseEnvelope<T>(text);

    if (!response.ok || envelope === null || envelope.success === false) {
      throw errorFromResponse(response.status, envelope, retryAfter);
    }

    return { envelope, status: response.status };
  }
}

function parseEnvelope<T>(text: string): Envelope<T> | null {
  if (text.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Envelope<T>;
  } catch {
    // A non-JSON body from Cloudflare is an error page, not an envelope.
    return null;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds;

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.round((date - Date.now()) / 1000));
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")
  );
}
