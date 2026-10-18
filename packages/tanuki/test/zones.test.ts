import { describe, expect, test } from "bun:test";
import { CloudflareClient } from "../src/cloudflare/client.ts";
import {
  discoverZones,
  ignoredZones,
  planTierFor,
  purgeableZones,
  refreshZones,
  staleZones,
  toZoneRecord,
} from "../src/cloudflare/zones.ts";
import type { ZoneRecord } from "../src/config/schema.ts";
import { apiFailure, fakeCloudflare, ok, rawZone } from "./fake-cloudflare.ts";

function clientFor(fake: ReturnType<typeof fakeCloudflare>) {
  return new CloudflareClient({ token: "cfut_test_token_value", fetch: fake.fetch });
}

function page(zones: ReturnType<typeof rawZone>[], pageNumber: number, totalPages: number) {
  return ok(zones, {
    page: pageNumber,
    per_page: 50,
    count: zones.length,
    total_count: totalPages * 50,
    total_pages: totalPages,
  });
}

function existing(id: string, name: string, extra: Partial<ZoneRecord> = {}): ZoneRecord {
  return { id, name, status: "active", accountId: "acct_1", accountName: "Acme", planId: "pro", ...extra };
}

describe("zone mapping", () => {
  test("maps the fields Tanuki uses and nothing else", () => {
    const record = toZoneRecord(rawZone("z1", "example.com", { planId: "pro", accountName: "Acme" }));
    expect(record).toEqual({
      id: "z1",
      name: "example.com",
      status: "active",
      accountId: "acct_1",
      accountName: "Acme",
      planId: "pro",
    });
  });

  test("an unrecognised Cloudflare status becomes unknown rather than crashing", () => {
    expect(toZoneRecord(rawZone("z1", "a.com", { status: "quantum" })).status).toBe("unknown");
  });

  test("the plan tier is read from whichever field Cloudflare populated", () => {
    expect(planTierFor({ id: "z", name: "a", status: "active", plan: { id: "pro" } })).toBe("pro");
    expect(planTierFor({ id: "z", name: "a", status: "active", plan: { legacy_id: "BIZ" } })).toBe("business");
    expect(planTierFor({ id: "z", name: "a", status: "active", plan: { name: "Free" } })).toBe("free");
    expect(planTierFor({ id: "z", name: "a", status: "active" })).toBe("unknown");
  });
});

describe("discoverZones", () => {
  test("follows pagination to the end", async () => {
    const fake = fakeCloudflare((request) => {
      const url = new URL(request.url);
      const pageNumber = Number(url.searchParams.get("page"));
      return page([rawZone(`z${pageNumber}`, `z${pageNumber}.com`)], pageNumber, 3);
    });

    const result = await discoverZones(clientFor(fake));

    expect(result.zones).toHaveLength(3);
    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(false);
    expect(fake.requests.map((request) => new URL(request.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  test("requests fifty per page, which is Cloudflare's maximum", async () => {
    const fake = fakeCloudflare(() => page([], 1, 1));
    await discoverZones(clientFor(fake));
    expect(new URL(fake.requests[0]!.url).searchParams.get("per_page")).toBe("50");
  });

  test("deduplicates zones that shift between pages mid-pagination", async () => {
    const fake = fakeCloudflare((request) => {
      const pageNumber = Number(new URL(request.url).searchParams.get("page"));
      // The same zone appears on page 1 and page 2, as happens when the list
      // changes underneath a multi-page read.
      return page([rawZone("z1", "a.com"), rawZone(`z${pageNumber}`, `z${pageNumber}.com`)], pageNumber, 2);
    });

    const result = await discoverZones(clientFor(fake));
    expect(result.zones.map((zone) => zone.id).sort()).toEqual(["z1", "z2"]);
  });

  test("stops after a short page when the API reports no totals", async () => {
    const fake = fakeCloudflare(() => ok([rawZone("z1", "a.com")]));
    const result = await discoverZones(clientFor(fake));
    expect(result.pages).toBe(1);
    expect(result.zones).toHaveLength(1);
  });

  test("stops at the safety cap and says so instead of looping forever", async () => {
    const fake = fakeCloudflare((request) => {
      const pageNumber = Number(new URL(request.url).searchParams.get("page"));
      return page([rawZone(`z${pageNumber}`, `z${pageNumber}.com`)], pageNumber, 1_000);
    });

    const result = await discoverZones(clientFor(fake));
    expect(result.truncated).toBe(true);
    expect(result.pages).toBe(400);
    expect(fake.requests).toHaveLength(400);
  });

  test("sorts by domain name for a stable list", async () => {
    const fake = fakeCloudflare(() =>
      page([rawZone("z2", "b.com"), rawZone("z1", "a.com"), rawZone("z3", "c.com")], 1, 1),
    );
    const result = await discoverZones(clientFor(fake));
    expect(result.zones.map((zone) => zone.name)).toEqual(["a.com", "b.com", "c.com"]);
  });

  test("propagates a permission failure rather than returning an empty account", async () => {
    const fake = fakeCloudflare(() => apiFailure(403, 9109, "denied"));
    await expect(discoverZones(clientFor(fake))).rejects.toThrow(/denied/);
  });
});

describe("refreshZones", () => {
  test("adds new zones and updates changed metadata", async () => {
    const fake = fakeCloudflare((request) => {
      if (request.url.includes("/zones/")) return ok(rawZone("z1", "renamed.com"));
      return page([rawZone("z1", "renamed.com"), rawZone("z2", "new.com")], 1, 1);
    });

    const result = await refreshZones(clientFor(fake), [existing("z1", "old.com")]);

    expect(result.changes.added.map((zone) => zone.id)).toEqual(["z2"]);
    expect(result.changes.updated.map((zone) => zone.id)).toEqual(["z1"]);
    expect(result.zones.map((zone) => zone.name)).toEqual(["new.com", "renamed.com"]);
  });

  test("a zone that is gone from Cloudflare is marked gone", async () => {
    const fake = fakeCloudflare((request) => {
      if (request.url.includes("/zones/z1")) return apiFailure(404, 7003, "no route");
      return page([rawZone("z2", "b.com")], 1, 1);
    });

    const result = await refreshZones(clientFor(fake), [existing("z1", "a.com")]);
    const stale = result.zones.find((zone) => zone.id === "z1")!;

    expect(stale.stale?.reason).toBe("gone");
    expect(result.changes.stale.map((change) => change.zone.id)).toEqual(["z1"]);
  });

  test("a zone the token can no longer reach is distinguished from a deleted one", async () => {
    const fake = fakeCloudflare((request) => {
      if (request.url.includes("/zones/z1")) return apiFailure(403, 9109, "denied");
      return page([rawZone("z2", "b.com")], 1, 1);
    });

    const result = await refreshZones(clientFor(fake), [existing("z1", "a.com")]);
    expect(result.zones.find((zone) => zone.id === "z1")!.stale?.reason).toBe("not-permitted");
  });

  test("a network failure is reported as unknown, not guessed", async () => {
    const fake = fakeCloudflare((request) => {
      if (request.url.includes("/zones/z1")) throw new Error("ECONNRESET");
      return page([rawZone("z2", "b.com")], 1, 1);
    });

    const result = await refreshZones(clientFor(fake), [existing("z1", "a.com")]);
    expect(result.zones.find((zone) => zone.id === "z1")!.stale?.reason).toBe("unknown");
  });

  test("membership is preserved: a vanished zone is not dropped", async () => {
    const fake = fakeCloudflare((request) => {
      if (request.url.includes("/zones/z1")) return apiFailure(404, 7003, "no route");
      return page([], 1, 1);
    });

    const before = [existing("z1", "a.com"), existing("z2", "b.com")];
    const result = await refreshZones(clientFor(fake), before);

    // Both IDs survive, so group membership keyed on zone ID survives with them.
    expect(result.zones.map((zone) => zone.id).sort()).toEqual(["z1", "z2"]);
  });

  test("a zone reachable by id but absent from the listing is not marked stale", async () => {
    // The probe is authoritative: if GET /zones/{id} succeeds, the zone exists
    // and is permitted. Calling that "not-permitted" would be a false alarm.
    const fake = fakeCloudflare((request) => {
      if (request.url.includes("/zones/z1")) return ok(rawZone("z1", "a.com"));
      return page([rawZone("z2", "b.com")], 1, 1);
    });

    const result = await refreshZones(clientFor(fake), [existing("z1", "a.com")]);

    expect(result.zones.find((zone) => zone.id === "z1")!.stale).toBeUndefined();
    expect(result.changes.stale).toEqual([]);
  });

  test("a zone that comes back is restored and reported", async () => {
    const fake = fakeCloudflare(() => page([rawZone("z1", "a.com")], 1, 1));

    const result = await refreshZones(clientFor(fake), [
      existing("z1", "a.com", { stale: { reason: "gone", detectedAt: "2026-01-01T00:00:00.000Z" } }),
    ]);

    expect(result.zones[0]!.stale).toBeUndefined();
    expect(result.changes.restored.map((zone) => zone.id)).toEqual(["z1"]);
  });

  test("only newly stale zones are reported, not ones already flagged", async () => {
    const fake = fakeCloudflare((request) => {
      if (request.url.includes("/zones/z1")) return apiFailure(404, 7003, "no route");
      return page([], 1, 1);
    });

    const result = await refreshZones(clientFor(fake), [
      existing("z1", "a.com", { stale: { reason: "gone", detectedAt: "2026-01-01T00:00:00.000Z" } }),
    ]);

    expect(result.changes.stale).toEqual([]);
  });

  test("purgeableZones excludes stale entries", () => {
    const zones = [
      existing("z1", "a.com"),
      existing("z2", "b.com", { stale: { reason: "gone", detectedAt: "2026-01-01T00:00:00.000Z" } }),
    ];
    expect(purgeableZones(zones).map((zone) => zone.id)).toEqual(["z1"]);
    expect(staleZones(zones).map((zone) => zone.id)).toEqual(["z2"]);
  });

  test("purgeableZones excludes ignored entries too", () => {
    // The user's own instruction, not Cloudflare's: an ignored zone is never
    // sent a request, exactly like a stale one.
    const zones = [existing("z1", "a.com"), existing("z2", "b.com", { ignored: true })];
    expect(purgeableZones(zones).map((zone) => zone.id)).toEqual(["z1"]);
    expect(ignoredZones(zones).map((zone) => zone.id)).toEqual(["z2"]);
    // Ignoring is not staleness; the two are counted separately everywhere.
    expect(staleZones(zones)).toEqual([]);
  });

  test("a refresh does not resurrect an ignored zone", async () => {
    // The whole reason ignoring is a flag rather than a deletion: /zones returns
    // every zone the token can reach, so a deleted row would come straight back.
    const fake = fakeCloudflare(() => page([rawZone("z1", "a.com")], 1, 1));

    const result = await refreshZones(clientFor(fake), [existing("z1", "a.com", { ignored: true })]);

    expect(result.zones[0]!.ignored).toBe(true);
    expect(purgeableZones(result.zones)).toEqual([]);
  });

  test("a refresh keeps the record of the last purge", async () => {
    // Discovery knows nothing about purges. Dropping the field here would erase
    // the answer to "when was this last purged?" on the very refresh the user
    // pressed to tidy up.
    const lastPurge = { at: "2026-01-01T00:00:00.000Z", ok: true, purgeId: "purge_1", durationMs: 214 };
    const fake = fakeCloudflare(() => page([rawZone("z1", "a.com")], 1, 1));

    const result = await refreshZones(clientFor(fake), [existing("z1", "a.com", { lastPurge })]);

    expect(result.zones[0]!.lastPurge).toEqual(lastPurge);
  });
});
