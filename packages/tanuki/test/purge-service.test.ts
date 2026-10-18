import { describe, expect, test } from "bun:test";
import { CloudflareClient } from "../src/cloudflare/client.ts";
import type { ZoneRecord } from "../src/config/schema.ts";
import {
  applyPurgeSummary,
  failedZoneIds,
  isCompleteSuccess,
  purgeZones,
  retryableZones,
} from "../src/services/purge-service.ts";
import type { PurgeSummary } from "../src/services/purge-service.ts";
import { FakeClock, apiFailure, fakeCloudflare, ok } from "./fake-cloudflare.ts";
import type { FakeCloudflare } from "./fake-cloudflare.ts";

function zone(id: string, name: string, extra: Partial<ZoneRecord> = {}): ZoneRecord {
  return {
    id,
    name,
    status: "active",
    accountId: "acct_1",
    accountName: "Acme",
    planId: "pro",
    ...extra,
  };
}

function clientFor(fake: FakeCloudflare) {
  return new CloudflareClient({ token: "cfut_test_token_value", fetch: fake.fetch });
}

function zoneIdFrom(url: string): string {
  const match = /\/zones\/([^/]+)\/purge_cache/.exec(url);
  return match?.[1] ?? "unknown";
}

describe("purgeZones", () => {
  test("purges every zone and reports acceptance", async () => {
    const fake = fakeCloudflare((request) => ok({ id: `purge_${zoneIdFrom(request.url)}` }));
    const zones = [zone("z1", "a.com"), zone("z2", "b.com"), zone("z3", "c.com")];

    const summary = await purgeZones(clientFor(fake), zones, { clock: new FakeClock() });

    expect(summary.accepted).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.cancelled).toBe(false);
    expect(fake.requests).toHaveLength(3);
    expect(summary.outcomes.map((outcome) => outcome.acceptedId)).toEqual([
      "purge_z1",
      "purge_z2",
      "purge_z3",
    ]);
    expect(isCompleteSuccess(summary)).toBe(true);
  });

  test("stale zones are skipped and never reach the network", async () => {
    const fake = fakeCloudflare(() => ok({ id: "purge" }));
    const zones = [
      zone("z1", "a.com"),
      zone("z2", "gone.com", { stale: { reason: "gone", detectedAt: "2026-01-01T00:00:00.000Z" } }),
      zone("z3", "lost.com", { stale: { reason: "not-permitted", detectedAt: "2026-01-01T00:00:00.000Z" } }),
    ];

    const summary = await purgeZones(clientFor(fake), zones, { clock: new FakeClock() });

    expect(summary.accepted).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(fake.requests).toHaveLength(1);

    const skipped = summary.outcomes.filter((outcome) => outcome.status === "skipped");
    expect(skipped.map((outcome) => outcome.reason)).toEqual([
      "this zone no longer exists on Cloudflare",
      "this token can no longer reach this zone",
    ]);
  });

  test("a partial failure is reported as a failure, never folded into success", async () => {
    const fake = fakeCloudflare((request) =>
      zoneIdFrom(request.url) === "z2" ? apiFailure(500, 0, "internal error") : ok({ id: "purge" }),
    );
    const zones = [zone("z1", "a.com"), zone("z2", "b.com"), zone("z3", "c.com")];

    const summary = await purgeZones(clientFor(fake), zones, { clock: new FakeClock() });

    expect(summary.accepted).toBe(2);
    expect(summary.failed).toBe(1);
    expect(isCompleteSuccess(summary)).toBe(false);

    const failure = summary.outcomes.find((outcome) => outcome.zoneId === "z2")!;
    expect(failure.status).toBe("failed");
    expect(failure.errorKind).toBe("server");
    expect(failure.reason).toContain("server error");
  });

  test("a rate-limited zone is re-queued and then accepted", async () => {
    let calls = 0;
    const clock = new FakeClock();
    const fake = fakeCloudflare(() => {
      calls += 1;
      return calls === 1
        ? apiFailure(429, 1134, "rate limit reached", { "retry-after": "1" })
        : ok({ id: "purge_z1" });
    });

    const summary = await purgeZones(clientFor(fake), [zone("z1", "a.com")], { clock });

    expect(summary.accepted).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.outcomes[0]!.attempts).toBe(2);
    // The account bucket was paused before the retry.
    expect(clock.now()).toBeGreaterThanOrEqual(1_000);
  });

  test("after the retry allowance is spent, the truth is reported", async () => {
    const fake = fakeCloudflare(() => apiFailure(429, 1134, "rate limit reached"));
    const clock = new FakeClock();

    const summary = await purgeZones(clientFor(fake), [zone("z1", "a.com")], {
      clock,
      maxRateLimitRetries: 1,
    });

    expect(summary.accepted).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.outcomes[0]!.attempts).toBe(2);
    expect(summary.outcomes[0]!.errorKind).toBe("rate-limit");
    expect(fake.requests).toHaveLength(2);
  });

  test("cancelling before work starts sends nothing", async () => {
    const fake = fakeCloudflare(() => ok({ id: "purge" }));
    const controller = new AbortController();
    controller.abort();

    const summary = await purgeZones(clientFor(fake), [zone("z1", "a.com"), zone("z2", "b.com")], {
      clock: new FakeClock(),
      signal: controller.signal,
    });

    expect(fake.requests).toHaveLength(0);
    expect(summary.cancelled).toBe(true);
    expect(summary.skipped).toBe(2);
    expect(summary.outcomes.every((outcome) => outcome.reason === "cancelled before this zone was purged")).toBe(true);
  });

  test("cancelling mid-run keeps what was accepted and stops the rest", async () => {
    const fake = fakeCloudflare(() => ok({ id: "purge" }));
    const controller = new AbortController();

    const summary = await purgeZones(
      clientFor(fake),
      [zone("z1", "a.com"), zone("z2", "b.com"), zone("z3", "c.com")],
      {
        clock: new FakeClock(),
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.accepted === 1) controller.abort();
        },
      },
    );

    expect(summary.cancelled).toBe(true);
    expect(summary.accepted).toBe(1);
    expect(summary.skipped).toBe(2);
    // It never claims the accepted one was undone.
    expect(summary.outcomes.find((outcome) => outcome.zoneId === "z1")!.status).toBe("accepted");
  });

  test("only one request is in flight per account", async () => {
    const inFlight = new Map<string, number>();
    const peak = new Map<string, number>();

    const fake = fakeCloudflare(async (request) => {
      const id = zoneIdFrom(request.url);
      const account = id.startsWith("a") ? "acct_a" : "acct_b";
      const current = (inFlight.get(account) ?? 0) + 1;
      inFlight.set(account, current);
      peak.set(account, Math.max(peak.get(account) ?? 0, current));
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight.set(account, current - 1);
      return ok({ id: `purge_${id}` });
    });

    const zones = [
      zone("a1", "a1.com", { accountId: "acct_a" }),
      zone("a2", "a2.com", { accountId: "acct_a" }),
      zone("a3", "a3.com", { accountId: "acct_a" }),
      zone("b1", "b1.com", { accountId: "acct_b" }),
      zone("b2", "b2.com", { accountId: "acct_b" }),
    ];

    const summary = await purgeZones(clientFor(fake), zones, { clock: new FakeClock() });

    expect(summary.accepted).toBe(5);
    expect(peak.get("acct_a")).toBe(1);
    expect(peak.get("acct_b")).toBe(1);
  });

  test("progress never reports a rate-limited zone as accepted", async () => {
    let calls = 0;
    const fake = fakeCloudflare(() => {
      calls += 1;
      return calls === 1 ? apiFailure(429, 1134, "slow down", { "retry-after": "1" }) : ok({ id: "purge" });
    });

    const seen: Array<{ accepted: number; failed: number }> = [];
    await purgeZones(clientFor(fake), [zone("z1", "a.com")], {
      clock: new FakeClock(),
      onProgress: (progress) => seen.push({ accepted: progress.accepted, failed: progress.failed }),
    });

    expect(seen.some((progress) => progress.accepted === 1)).toBe(true);
    expect(seen.every((progress) => progress.failed === 0)).toBe(true);
  });

  test("zones without an account still purge", async () => {
    const fake = fakeCloudflare(() => ok({ id: "purge" }));
    const summary = await purgeZones(
      clientFor(fake),
      [{ id: "z1", name: "a.com", status: "active" }],
      { clock: new FakeClock() },
    );
    expect(summary.accepted).toBe(1);
  });

  test("retry targets only the failures", async () => {
    const fake = fakeCloudflare((request) =>
      zoneIdFrom(request.url) === "z2" ? apiFailure(500, 0, "boom") : ok({ id: "purge" }),
    );
    const zones = [zone("z1", "a.com"), zone("z2", "b.com"), zone("z3", "c.com")];
    const summary = await purgeZones(clientFor(fake), zones, { clock: new FakeClock() });

    expect(failedZoneIds(summary)).toEqual(["z2"]);
    expect(retryableZones(summary, zones).map((zone) => zone.id)).toEqual(["z2"]);
  });

  test("an Enterprise account is not paced at the Free rate", async () => {
    const fake = fakeCloudflare(() => ok({ id: "purge" }));
    const clock = new FakeClock();
    const zones = Array.from({ length: 30 }, (_, index) =>
      zone(`z${index}`, `z${index}.com`, { planId: "enterprise" }),
    );

    await purgeZones(clientFor(fake), zones, { clock });

    // 30 zones exceed Free's burst of 25 and would have cost a minute of
    // refill. Enterprise's burst of 500 absorbs them immediately.
    expect(clock.now()).toBe(0);
  });

  test("a Free account is paced, because its burst is only 25", async () => {
    const fake = fakeCloudflare(() => ok({ id: "purge" }));
    const clock = new FakeClock();
    const zones = Array.from({ length: 30 }, (_, index) =>
      zone(`z${index}`, `z${index}.com`, { planId: "free" }),
    );

    await purgeZones(clientFor(fake), zones, { clock });

    // Five zones beyond the burst, at 5/minute.
    expect(clock.now()).toBeGreaterThan(50_000);
  });

  test("conservative mode pins an Enterprise account to the Free ceiling", async () => {
    const fake = fakeCloudflare(() => ok({ id: "purge" }));
    const clock = new FakeClock();
    const zones = Array.from({ length: 30 }, (_, index) =>
      zone(`z${index}`, `z${index}.com`, { planId: "enterprise" }),
    );

    await purgeZones(clientFor(fake), zones, { clock, rateMode: "conservative" });
    expect(clock.now()).toBeGreaterThan(50_000);
  });

  test("the slowest plan in an account wins when zones disagree", async () => {
    const fake = fakeCloudflare(() => ok({ id: "purge" }));
    const clock = new FakeClock();
    const zones = Array.from({ length: 26 }, (_, index) =>
      zone(`z${index}`, `z${index}.com`, { planId: index === 25 ? "free" : "enterprise" }),
    );

    await purgeZones(clientFor(fake), zones, { clock });

    // One Free zone is enough to hold the whole account to Free pacing.
    expect(clock.now()).toBeGreaterThan(0);
  });
});

describe("Cloudflare's reply is kept, not paraphrased", () => {
  test("each accepted zone carries the status, the id and the round trip", async () => {
    const fake = fakeCloudflare(() => ok({ id: "purge_z1" }));
    const summary = await purgeZones(clientFor(fake), [zone("z1", "a.com")]);

    const [outcome] = summary.outcomes;
    expect(outcome!.status).toBe("accepted");
    expect(outcome!.acceptedId).toBe("purge_z1");
    expect(outcome!.httpStatus).toBe(200);
    expect(outcome!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("messages Cloudflare attaches are carried, not swallowed", async () => {
    // A warning from Cloudflare is a thing the user should see, not something to
    // tidy away.
    const fake = fakeCloudflare(() => ({
      status: 200,
      json: {
        success: true,
        errors: [],
        messages: [{ code: 1000, message: "This request is taking longer than usual." }],
        result: { id: "purge_z1" },
      },
    }));

    const summary = await purgeZones(clientFor(fake), [zone("z1", "a.com")]);
    expect(summary.outcomes[0]!.messages).toEqual(["This request is taking longer than usual."]);
  });
});

describe("applyPurgeSummary", () => {
  const at = "2026-06-01T12:00:30.000Z";

  function summaryFor(outcomes: PurgeSummary["outcomes"]): PurgeSummary {
    return {
      total: outcomes.length,
      completed: outcomes.length,
      accepted: outcomes.filter((outcome) => outcome.status === "accepted").length,
      failed: outcomes.filter((outcome) => outcome.status === "failed").length,
      skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
      cancelled: false,
      startedAt: "2026-06-01T12:00:00.000Z",
      durationMs: 30_000,
      outcomes,
    };
  }

  test("stamps the run's end onto every zone it was given", async () => {
    const fake = fakeCloudflare(() => ok({ id: "purge_z1" }));
    const summary = await purgeZones(clientFor(fake), [zone("z1", "a.com")]);

    const [stamped] = applyPurgeSummary([zone("z1", "a.com")], summary);

    expect(stamped!.lastPurge?.ok).toBe(true);
    expect(stamped!.lastPurge?.purgeId).toBe("purge_z1");

    const [unstamped] = applyPurgeSummary([zone("z2", "b.com")], summary);
    expect(unstamped!.lastPurge).toBeUndefined();
  });

  test("a failed attempt is recorded as a failure, with its reason", async () => {
    const summary = summaryFor([
      {
        zoneId: "z1",
        name: "a.com",
        accountId: "acct_1",
        status: "failed",
        attempts: 1,
        reason: "Cloudflare rejected this token for that zone.",
        errorKind: "auth",
      },
    ]);

    const [stamped] = applyPurgeSummary([zone("z1", "a.com")], summary);

    // Leaving the previous success in place would answer "when was this last
    // purged?" with a purge that is not the last thing that happened.
    expect(stamped!.lastPurge).toEqual({ at, ok: false, reason: "Cloudflare rejected this token for that zone." });
  });

  test("a skipped zone is stamped as not ok, and says it was skipped", async () => {
    const summary = summaryFor([
      { zoneId: "z1", name: "a.com", accountId: "acct_1", status: "skipped", attempts: 0, reason: "zone is stale" },
    ]);

    const [stamped] = applyPurgeSummary([zone("z1", "a.com")], summary);
    expect(stamped!.lastPurge?.ok).toBe(false);
    expect(stamped!.lastPurge?.reason).toBe("zone is stale");
  });

  test("zones the run never mentioned are returned untouched", () => {
    const summary = summaryFor([]);
    const untouched = zone("z9", "other.com");
    expect(applyPurgeSummary([untouched], summary)).toEqual([untouched]);
  });
});
