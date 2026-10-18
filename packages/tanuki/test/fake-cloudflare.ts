/**
 * A fake Cloudflare transport. Every test here runs against this, so no test
 * can reach the network or purge a real cache.
 */
import type { FetchLike, FetchResponse } from "../src/cloudflare/client.ts";

export interface RecordedRequest {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

export interface FakeReply {
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export type Handler = (request: RecordedRequest) => FakeReply | Promise<FakeReply>;

export interface FakeCloudflare {
  fetch: FetchLike;
  requests: RecordedRequest[];
  urls(): string[];
}

export function fakeCloudflare(handler: Handler): FakeCloudflare {
  const requests: RecordedRequest[] = [];

  const fetch: FetchLike = async (url, init) => {
    const request: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      ...(init?.body ? { body: init.body } : {}),
      headers: init?.headers ?? {},
    };

    // Real fetch rejects immediately on an already-aborted signal, and rejects
    // when the signal fires mid-request. Modelling that here is what makes the
    // cancellation tests test Tanuki rather than the fake.
    const signal = init?.signal;
    if (signal?.aborted) throw abortError();

    requests.push(request);

    const reply = signal ? await raceAbort(handler(request), signal) : await handler(request);

    const headers = new Map(
      Object.entries(reply.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const text = reply.text ?? JSON.stringify(reply.json ?? {});

    const response: FetchResponse = {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => text,
    };
    return response;
  };

  return {
    fetch,
    requests,
    urls: () => requests.map((request) => request.url),
  };
}

export function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

/** Races a handler against abort, and detaches the listener either way. */
async function raceAbort(work: FakeReply | Promise<FakeReply>, signal: AbortSignal): Promise<FakeReply> {
  if (signal.aborted) throw abortError();

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function ok<T>(result: T, resultInfo?: unknown): FakeReply {
  return {
    status: 200,
    json: {
      success: true,
      errors: [],
      messages: [],
      result,
      ...(resultInfo ? { result_info: resultInfo } : {}),
    },
  };
}

export function apiFailure(status: number, code: number, message: string, headers?: Record<string, string>): FakeReply {
  return {
    status,
    ...(headers ? { headers } : {}),
    json: { success: false, errors: [{ code, message }], messages: [], result: null },
  };
}

export function rawZone(id: string, name: string, options: {
  status?: string;
  accountId?: string;
  accountName?: string;
  planId?: string;
} = {}) {
  return {
    id,
    name,
    status: options.status ?? "active",
    account: { id: options.accountId ?? "acct_1", name: options.accountName ?? "Acme" },
    ...(options.planId ? { plan: { id: options.planId } } : {}),
  };
}

export class FakeClock {
  private time = 0;

  now(): number {
    return this.time;
  }

  async sleep(ms: number): Promise<void> {
    this.time += Math.max(0, ms);
  }

  advance(ms: number): void {
    this.time += ms;
  }
}
