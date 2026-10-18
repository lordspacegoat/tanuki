/**
 * Cloudflare wire types.
 *
 * Deliberately narrow: only the fields Tanuki reads. The API returns far more,
 * and pretending otherwise would mean maintaining a copy of someone else's
 * schema.
 */

export interface ResultInfo {
  page: number;
  per_page: number;
  count: number;
  total_count: number;
  total_pages: number;
}

export interface ApiMessage {
  code: number;
  message: string;
  documentation_url?: string;
  source?: { pointer?: string };
}

/** The envelope every v4 endpoint uses. */
export interface Envelope<T> {
  success: boolean;
  errors: ApiMessage[];
  messages: ApiMessage[];
  result: T;
  result_info?: ResultInfo;
}

export interface RawZone {
  id: string;
  name: string;
  status: "initializing" | "pending" | "active" | "moved" | string;
  paused?: boolean;
  account?: { id?: string; name?: string };
  /** Deprecated, but still populated — and free to read (decision C5). */
  plan?: { id?: string; name?: string; legacy_id?: string };
}

export interface RawSubscription {
  id?: string;
  rate_plan?: { id?: string; name?: string; public_name?: string };
}

export interface VerifyResult {
  id: string;
  status: "active" | "disabled" | "expired" | string;
  expires_on?: string;
  not_before?: string;
}

/** Cloudflare's own answer to a purge request. */
export interface PurgeAck {
  id: string;
  /** HTTP status Cloudflare answered with. */
  status: number;
  /** Round trip, in milliseconds, measured around the request. */
  durationMs: number;
  /** Any `messages` Cloudflare attached to the envelope. */
  messages: string[];
}

export interface ListZonesParams {
  page?: number;
  perPage?: number;
  name?: string;
  status?: string;
}
