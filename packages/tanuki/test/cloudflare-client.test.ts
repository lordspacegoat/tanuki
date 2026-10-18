import { describe, expect, test } from "bun:test";
import { CLOUDFLARE_BASE_URL, CloudflareClient } from "../src/cloudflare/client.ts";
import type { FetchLike } from "../src/cloudflare/client.ts";
import { CloudflareError, userMessage } from "../src/cloudflare/errors.ts";
import type { CloudflareErrorKind } from "../src/cloudflare/errors.ts";
import { apiFailure, fakeCloudflare, ok, rawZone } from "./fake-cloudflare.ts";

const TOKEN = "cfut_0123456789abcdefghijklmnopqrstuvwxyz";

function client(fake: ReturnType<typeof fakeCloudflare>) {
  return new CloudflareClient({ token: TOKEN, fetch: fake.fetch });
}

describe("CloudflareClient", () => {
  test("verifies a token", async () => {
    const fake = fakeCloudflare(() => ok({ id: "tok_1", status: "active" }));
    const result = await client(fake).verifyToken();

    expect(result.status).toBe("active");
    expect(fake.requests[0]!.url).toBe(`${CLOUDFLARE_BASE_URL}/user/tokens/verify`);
  });

  test("sends a bearer token but never puts it in the URL", async () => {
    const fake = fakeCloudflare(() => ok({ id: "tok_1", status: "active" }));
    await client(fake).verifyToken();

    expect(fake.requests[0]!.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(fake.requests[0]!.url).not.toContain(TOKEN);
  });

  test("only ever contacts api.cloudflare.com (decision S8)", async () => {
    const fake = fakeCloudflare((request) => {
      if (request.url.includes("purge_cache")) return ok({ id: "purge_1" });
      if (request.url.includes("subscription")) return ok({ rate_plan: { id: "pro" } });
      if (request.url.includes("/zones/")) return ok(rawZone("z1", "example.com"));
      if (request.url.includes("/zones")) return ok([rawZone("z1", "example.com")], { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 });
      return ok({ id: "tok_1", status: "active" });
    });

    const cf = client(fake);
    await cf.verifyToken();
    await cf.listZonesPage();
    await cf.getZone("z1");
    await cf.zoneSubscription("z1");
    await cf.purgeEverything("z1");

    for (const url of fake.urls()) {
      expect(new URL(url).host).toBe("api.cloudflare.com");
      expect(url.startsWith(CLOUDFLARE_BASE_URL)).toBe(true);
    }
  });

  test("paginates at Cloudflare's maximum per_page", async () => {
    const fake = fakeCloudflare(() => ok([], { page: 1, per_page: 50, count: 0, total_count: 0, total_pages: 1 }));
    await client(fake).listZonesPage({ perPage: 500 });
    expect(fake.requests[0]!.url).toContain("per_page=50");
  });

  test("purges everything with the documented body", async () => {
    const fake = fakeCloudflare(() => ok({ id: "purge_1" }));
    const accepted = await client(fake).purgeEverything("zone_abc");

    expect(accepted.id).toBe("purge_1");
    expect(fake.requests[0]!.method).toBe("POST");
    expect(fake.requests[0]!.url).toContain("/zones/zone_abc/purge_cache");
    expect(JSON.parse(fake.requests[0]!.body!)).toEqual({ purge_everything: true });
    expect(fake.requests[0]!.headers["Content-Type"]).toBe("application/json");
  });

  test("a success envelope without a purge id is not treated as success", async () => {
    const fake = fakeCloudflare(() => ok({}));
    await expect(client(fake).purgeEverything("zone_abc")).rejects.toThrow(/no purge identifier/);
  });

  test("getZone returns null for an unknown zone rather than throwing", async () => {
    const fake = fakeCloudflare(() => apiFailure(404, 7003, "no route"));
    expect(await client(fake).getZone("gone")).toBeNull();
  });

  test("reads the plan tier from the subscription endpoint", async () => {
    const fake = fakeCloudflare(() => ok({ rate_plan: { id: "business" } }));
    expect(await client(fake).zoneSubscription("z1")).toBe("business");
  });

  test("refuses to construct without a token", () => {
    expect(() => new CloudflareClient({ token: "" })).toThrow(/token is required/);
  });
});

describe("error mapping", () => {
  const cases: Array<[string, number, number, string, CloudflareErrorKind]> = [
    ["401 is auth", 401, 10000, "authentication error", "auth"],
    ["403 is permission", 403, 9109, "unauthorized to access requested resource", "permission"],
    ["404 is not-found", 404, 7003, "no route", "not-found"],
    ["429 is rate-limit", 429, 0, "too many requests", "rate-limit"],
    ["1134 is rate-limit even with a 400", 400, 1134, "rate limit reached", "rate-limit"],
    ["500 is server", 500, 0, "internal error", "server"],
  ];

  for (const [name, status, code, message, kind] of cases) {
    test(name, async () => {
      const fake = fakeCloudflare(() => apiFailure(status, code, message));
      const error = await client(fake)
        .purgeEverything("z1")
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CloudflareError);
      expect((error as CloudflareError).kind).toBe(kind);
    });
  }

  test("captures retry-after in seconds", async () => {
    const fake = fakeCloudflare(() => apiFailure(429, 1134, "slow down", { "retry-after": "42" }));
    const error = (await client(fake).purgeEverything("z1").catch((caught: unknown) => caught)) as CloudflareError;

    expect(error.retryAfterSeconds).toBe(42);
    expect(error.retryAfterMs).toBe(42_000);
  });

  test("a default retry-after is used when the header is absent", async () => {
    const fake = fakeCloudflare(() => apiFailure(429, 1134, "slow down"));
    const error = (await client(fake).purgeEverything("z1").catch((caught: unknown) => caught)) as CloudflareError;
    expect(error.retryAfterMs).toBe(1_000);
  });

  test("a non-JSON body is still an error, not a crash", async () => {
    const fake = fakeCloudflare(() => ({ status: 502, text: "<html>bad gateway</html>" }));
    const error = (await client(fake).purgeEverything("z1").catch((caught: unknown) => caught)) as CloudflareError;
    expect(error.kind).toBe("server");
  });

  test("a transport failure becomes a network error", async () => {
    const fake = fakeCloudflare(() => {
      throw new Error("ECONNREFUSED");
    });
    const error = (await client(fake).purgeEverything("z1").catch((caught: unknown) => caught)) as CloudflareError;
    expect(error.kind).toBe("network");
  });

  test("a hung request times out rather than hanging the interface", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });

    const cf = new CloudflareClient({ token: "cfut_test_token_value", fetch, timeoutMs: 20 });
    const error = (await cf.purgeEverything("z1").catch((caught: unknown) => caught)) as CloudflareError;

    expect(error.kind).toBe("timeout");
    expect(userMessage(error)).toContain("did not respond");
  });

  test("a caller cancellation is reported as cancelled, not as a timeout", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });

    const controller = new AbortController();
    const cf = new CloudflareClient({
      token: "cfut_test_token_value",
      fetch,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    const pending = cf.purgeEverything("z1").catch((caught: unknown) => caught);
    controller.abort();
    const error = (await pending) as CloudflareError;

    expect(error.kind).toBe("network");
    expect(error.message).toContain("cancelled");
  });

  test("abort listeners are detached, so a long purge cannot exhaust them", async () => {
    const fake = fakeCloudflare(() => ok({ id: "purge" }));
    const controller = new AbortController();
    const cf = new CloudflareClient({ token: "cfut_test_token_value", fetch: fake.fetch, signal: controller.signal });

    // A leak here would only ever surface as a process warning, so assert the
    // invariant directly: the long-lived signal ends up with no listeners. Only
    // the listeners this client attaches to *this* signal are counted.
    const originalAdd = AbortSignal.prototype.addEventListener;
    const originalRemove = AbortSignal.prototype.removeEventListener;
    let added = 0;
    let removed = 0;
    AbortSignal.prototype.addEventListener = function (this: AbortSignal, ...args: Parameters<typeof originalAdd>) {
      if (this === controller.signal) added += 1;
      return originalAdd.apply(this, args);
    };
    AbortSignal.prototype.removeEventListener = function (
      this: AbortSignal,
      ...args: Parameters<typeof originalRemove>
    ) {
      if (this === controller.signal) removed += 1;
      return originalRemove.apply(this, args);
    };

    try {
      for (let i = 0; i < 25; i++) await cf.purgeEverything(`z${i}`);
    } finally {
      AbortSignal.prototype.addEventListener = originalAdd;
      AbortSignal.prototype.removeEventListener = originalRemove;
    }

    expect(added).toBe(25);
    expect(removed).toBe(25);
    expect(fake.requests).toHaveLength(25);
  });

  test("user messages are actionable and never contain the token", async () => {
    const fake = fakeCloudflare(() => apiFailure(403, 9109, `denied for ${TOKEN}`));
    const error = (await client(fake).purgeEverything("z1").catch((caught: unknown) => caught)) as CloudflareError;

    const message = userMessage(error, "purge");
    expect(message).toContain("Cache Purge");
    expect(message).not.toContain(TOKEN);
  });

  test("a permission error for listing names the read permission", async () => {
    const fake = fakeCloudflare(() => apiFailure(403, 9109, "denied"));
    const error = (await client(fake).listZonesPage().catch((caught: unknown) => caught)) as CloudflareError;
    expect(userMessage(error, "list zones")).toContain("Zone → Zone → Read");
  });
});
