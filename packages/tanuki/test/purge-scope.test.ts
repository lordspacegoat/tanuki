/**
 * Scope resolution tests.
 *
 * The estimate is the part worth testing hardest: a number shown to a person
 * before a destructive action has to be right in both directions. Too high and
 * the tool looks broken; too low and a purge appears to hang.
 */
import { describe, expect, test } from "bun:test";
import {
  blockedReason,
  resolveScope,
  scopeLines,
  type PurgeScope,
} from "../src/services/purge-scope.ts";
import type { ZoneRecord, Group } from "../src/config/schema.ts";

function zone(
  id: string,
  name: string,
  accountId: string,
  planId: string,
  extra: Partial<ZoneRecord> = {},
): ZoneRecord {
  return { id, name, status: "active", accountId, accountName: `Account ${accountId}`, planId, ...extra };
}

const stale = { stale: { reason: "gone" as const, detectedAt: "2026-01-01T00:00:00.000Z" } };

function group(id: string, name: string, zoneIds: string[]): Group {
  return { id, name, zoneIds, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

describe("resolveScope", () => {
  test("all-zone scope counts every zone in the configuration", () => {
    const zones = [zone("z1", "a.com", "A", "pro"), zone("z2", "b.com", "A", "pro")];
    const resolved = resolveScope({ kind: "all" }, zones);

    expect(resolved.zones).toHaveLength(2);
    expect(resolved.accounts).toHaveLength(1);
    expect(resolved.label).toBe("every zone in this configuration");
    expect(resolved.empty).toBe(false);
  });

  test("a zone scope names the domain, not the ID", () => {
    const zones = [zone("z1", "acme.com", "A", "pro"), zone("z2", "other.com", "A", "pro")];
    const resolved = resolveScope({ kind: "zone", zoneId: "z1" }, zones);

    expect(resolved.label).toBe("acme.com");
    expect(resolved.zones.map((z) => z.id)).toEqual(["z1"]);
  });

  test("a group scope selects by membership and ignores dangling IDs", () => {
    const zones = [zone("z1", "a.com", "A", "pro"), zone("z2", "b.com", "A", "pro"), zone("z3", "c.com", "A", "pro")];
    const groups = [group("g1", "Brand A", ["z1", "z3", "z-missing"])];
    const resolved = resolveScope({ kind: "group", groupId: "g1" }, zones, groups);

    expect(resolved.label).toBe("Brand A");
    expect(resolved.zones.map((z) => z.id).sort()).toEqual(["z1", "z3"]);
  });

  test("a group that no longer exists matches nothing", () => {
    const resolved = resolveScope({ kind: "group", groupId: "ghost" }, [zone("z1", "a.com", "A", "pro")], []);
    expect(resolved.empty).toBe(true);
    expect(resolved.targetMissing).toBe(true);
    expect(blockedReason(resolved)).toBe("That group is no longer saved here, so there is nothing to purge.");
  });

  test("a group with no zones in it says exactly that, not that it vanished", () => {
    // Reachable from the groups screen: create a group, do not add anything,
    // press p. "No longer saved here" would be a lie about a group on screen.
    const groups = [group("g1", "Brand A", [])];
    const resolved = resolveScope({ kind: "group", groupId: "g1" }, [zone("z1", "a.com", "A", "pro")], groups);

    expect(resolved.empty).toBe(true);
    expect(resolved.targetMissing).toBe(false);
    expect(blockedReason(resolved)).toBe("That group has no zones in it yet.");
  });

  test("a group holding only stale zones is not the same as an empty one", () => {
    const groups = [group("g1", "Brand A", ["gone"])];
    const resolved = resolveScope({ kind: "group", groupId: "g1" }, [zone("gone", "gone.com", "A", "pro", stale)], groups);

    expect(resolved.empty).toBe(false);
    expect(resolved.targetMissing).toBe(false);
    expect(blockedReason(resolved)).toBe(
      "Every zone in scope is stale, so nothing would be sent to Cloudflare.",
    );
  });

  test("stale zones are carried separately, never in the purge set", () => {
    const zones = [zone("z1", "gone.com", "A", "pro", stale), zone("z2", "a.com", "A", "pro")];
    const resolved = resolveScope({ kind: "all" }, zones);

    expect(resolved.zones.map((z) => z.id)).toEqual(["z2"]);
    expect(resolved.skipped.map((z) => z.id)).toEqual(["z1"]);
    expect(resolved.empty).toBe(false);
  });

  test("a scope of only stale zones is empty to purge but not unmatched", () => {
    const zones = [zone("z1", "gone.com", "A", "pro", stale)];
    const resolved = resolveScope({ kind: "all" }, zones);

    expect(resolved.empty).toBe(false);
    expect(blockedReason(resolved)).toBe(
      "Every zone in scope is stale, so nothing would be sent to Cloudflare.",
    );
  });

  test("an empty configuration blocks plainly", () => {
    const resolved = resolveScope({ kind: "all" }, []);
    expect(resolved.empty).toBe(true);
    expect(blockedReason(resolved)).toBe("Nothing matched, so there is nothing to purge.");
  });
});

describe("pacing estimate", () => {
  test("the wait is the slowest account, not the sum across accounts", () => {
    // Free: capacity 25, refill 5/min. 30 zones overflows by 5 → 60s.
    // Pro: capacity 25, refill 5/sec. 100 zones overflows by 75 → 15s.
    // The two run in parallel, so the estimate is 60s, not 75s.
    const zones = [
      zone("f1", "free.com", "FREE", "free"),
      ...Array.from({ length: 29 }, (_, i) => zone(`f${i + 2}`, `f${i}.com`, "FREE", "free")),
      ...Array.from({ length: 100 }, (_, i) => zone(`p${i}`, `p${i}.com`, "PRO", "pro")),
    ];
    const resolved = resolveScope({ kind: "all" }, zones);

    expect(resolved.estimateMs).toBe(60_000);
    expect(resolved.bottleneck?.accountId).toBe("FREE");
    expect(resolved.exceedsBurst).toBe(true);
  });

  test("a scope inside the burst is immediate", () => {
    const zones = Array.from({ length: 24 }, (_, i) => zone(`f${i}`, `f${i}.com`, "FREE", "free"));
    const resolved = resolveScope({ kind: "all" }, zones);

    expect(resolved.estimateMs).toBe(0);
    expect(resolved.exceedsBurst).toBe(false);
    expect(scopeLines(resolved)).toContain("Every request goes out at once — this fits the burst limit.");
  });

  test("one account on a mixed plan paces by its slowest plan", () => {
    // A Pro zone and a Free zone in the same account: the bucket is shared, so
    // the account must be paced at Free's 5/min, not Pro's 5/sec.
    const zones = [
      ...Array.from({ length: 40 }, (_, i) => zone(`p${i}`, `p${i}.com`, "MIXED", "pro")),
      zone("f0", "free.com", "MIXED", "free"),
    ];
    const resolved = resolveScope({ kind: "all" }, zones);

    expect(resolved.bottleneck?.tier).toBe("free");
    expect(resolved.bottleneck?.policy.label).toBe("5/min");
    // 41 zones, burst 25, so 16 flow at 5/min → 192s.
    expect(resolved.estimateMs).toBe(192_000);
  });

  test("conservative mode paces every account as free", () => {
    const zones = Array.from({ length: 40 }, (_, i) => zone(`p${i}`, `p${i}.com`, "PRO", "pro"));
    const resolved = resolveScope({ kind: "all" }, zones, [], "conservative");

    expect(resolved.bottleneck?.policy.label).toBe("5/min");
    expect(resolved.estimateMs).toBe(180_000);
  });

  test("an unknown plan is paced as free rather than guessing fast", () => {
    const zones = Array.from({ length: 30 }, (_, i) => zone(`u${i}`, `u${i}.com`, "U", "mystery-plan"));
    const resolved = resolveScope({ kind: "all" }, zones);

    expect(resolved.bottleneck?.tier).toBe("unknown");
    expect(resolved.bottleneck?.policy.label).toBe("5/min");
  });
});

describe("scopeLines", () => {
  test("names the count, the controlling plan and the wait", () => {
    const zones = [
      ...Array.from({ length: 30 }, (_, i) => zone(`f${i}`, `f${i}.com`, "FREE", "free")),
      zone("p0", "p.com", "PRO", "pro"),
    ];
    const lines = scopeLines(resolveScope({ kind: "all" }, zones));

    expect(lines[0]).toBe("31 zones across 2 accounts.");
    expect(lines[1]).toBe("Slowest plan: Free — 5/min.");
    expect(lines[2]).toBe("That burst is not enough, so this paces out over about 1 min.");
  });

  test("says how many stale zones will be skipped", () => {
    const zones = [zone("z1", "a.com", "A", "pro"), zone("z2", "gone.com", "A", "pro", stale)];
    const lines = scopeLines(resolveScope({ kind: "all" }, zones));
    expect(lines).toContain("1 stale zone will be skipped.");
  });

  test("a single zone reads in the singular", () => {
    const lines = scopeLines(resolveScope({ kind: "all" }, [zone("z1", "a.com", "A", "pro")]));
    expect(lines[0]).toBe("1 zone across 1 account.");
  });
});

describe("resolveScope seeding", () => {
  test("an unset search does not drag a Pro account down to Free", () => {
    // Regression guard for the seeding rule: the slowest-plan search must start
    // unset. Seeding it with a fallback would make every real plan look faster
    // than the seed, or the seed slower than every plan.
    const zones = Array.from({ length: 30 }, (_, i) => zone(`p${i}`, `p${i}.com`, "PRO", "pro"));
    const resolved = resolveScope({ kind: "all" }, zones);
    expect(resolved.bottleneck?.tier).toBe("pro");
    expect(resolved.estimateMs).toBe(1_000);
  });
});

describe("scope kind coverage", () => {
  test("every scope kind resolves to a label and a target list", () => {
    const zones = [zone("z1", "a.com", "A", "pro")];
    const groups = [group("g1", "All", ["z1"])];
    const kinds: PurgeScope[] = [
      { kind: "zone", zoneId: "z1" },
      { kind: "group", groupId: "g1" },
      { kind: "all" },
    ];

    for (const scope of kinds) {
      const resolved = resolveScope(scope, zones, groups);
      expect(resolved.zones).toHaveLength(1);
      expect(resolved.label.length).toBeGreaterThan(0);
      expect(blockedReason(resolved)).toBeNull();
    }
  });
});
