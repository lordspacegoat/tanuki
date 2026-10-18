/**
 * Multi-zone purge tests: the confirmation, the run, cancellation and retry.
 *
 * These drive the real explorer against a faked transport, so no test can reach
 * the network or clear a real cache. The assertions are about what a person
 * sees, because the wording is the product here: "accepted" is not "purged",
 * a cancellation never claims to have rolled anything back, and a stale zone is
 * counted rather than quietly dropped.
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { CloudflareClient } from "../src/cloudflare/client.ts";
import type { Group, TanukiConfig, ZoneRecord } from "../src/config/schema.ts";
import { resolveScope } from "../src/services/purge-scope.ts";
import { PurgeConfirm } from "../src/tui/screens/purge-flow.tsx";
import { ZoneExplorer } from "../src/tui/screens/zone-explorer.tsx";
import { palette } from "../src/tui/theme.ts";
import { apiFailure, fakeCloudflare, ok } from "./fake-cloudflare.ts";
import type { Handler } from "./fake-cloudflare.ts";
import { press, settle, until } from "./frame.ts";

const TOKEN = "cfut_AbCdEf0123456789_abcdefghijklmnopqrst";
const STALE = { stale: { reason: "gone" as const, detectedAt: "2026-01-01T00:00:00.000Z" } };

function zone(id: string, name: string, extra: Partial<ZoneRecord> = {}): ZoneRecord {
  return { id, name, status: "active", accountId: "acct_1", accountName: "Acme", planId: "pro", ...extra };
}

function group(id: string, name: string, zoneIds: string[]): Group {
  return { id, name, zoneIds, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

function config(zones: ZoneRecord[], groups: Group[] = []): TanukiConfig {
  return {
    schemaVersion: 1,
    id: "cfg_1",
    name: "client",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    credential: { mode: "keychain", ref: "cfg_1" },
    zones,
    groups,
    prefs: { purgeRate: "auto" },
  };
}

/** Renders the explorer directly, so no configuration needs to be on disk. */
async function openExplorer(zones: ZoneRecord[], handler: Handler, groups: Group[] = []) {
  const fake = fakeCloudflare(handler);
  const rendered = await testRender(
    <ZoneExplorer
      config={config(zones, groups)}
      getClient={async () => new CloudflareClient({ token: TOKEN, fetch: fake.fetch })}
      onQuit={() => {}}
      onZonesChanged={() => {}}
      onOpenGroups={() => {}}
      onReplaceToken={() => {}}
      colours={palette}
      mode="single-column"
      height={8}
    />,
    { width: 110, height: 30 },
  );

  await settle(rendered);
  return { ...rendered, fake };
}

const purgeHandler: Handler = (request) =>
  request.url.includes("purge_cache") ? ok({ id: "purge_1" }) : ok([], undefined);

describe("purge confirmation", () => {
  test("names the counted scope before anything is sent", async () => {
    const app = await openExplorer(
      [zone("z1", "acme.com"), zone("z2", "brand-a.com"), zone("z3", "shop.com")],
      purgeHandler,
    );
    try {
      await until(app, (frame) => frame.includes("acme.com"));
      await press(app, "a");

      const frame = await until(app, (current) => current.includes("Purge cache — confirm"));
      expect(frame).toContain("every zone in this configuration");
      expect(frame).toContain("3 zones across 1 account.");
      expect(frame).toContain("Slowest plan: Pro — 5/sec.");
      expect(frame).toContain("Every request goes out at once — this fits the burst limit.");
      expect(frame).toContain("y purge 3 zones");
      expect(frame).toContain("n cancel");
      // Nothing has gone out yet: this is a question, not a pep talk.
      expect(app.fake.requests).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  test("enter does not accept; a purge takes a letter", async () => {
    const app = await openExplorer([zone("z1", "acme.com")], purgeHandler);
    try {
      await until(app, (frame) => frame.includes("acme.com"));
      await press(app, "a");
      await until(app, (current) => current.includes("Purge cache — confirm"));

      app.mockInput.pressEnter();
      await settle(app, 2);

      const frame = await until(app, (current) => current.includes("Purge cache — confirm"));
      expect(frame).toContain("y purge 1 zone");
      expect(app.fake.requests).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  test("n sends nothing and returns to the list", async () => {
    const app = await openExplorer([zone("z1", "acme.com"), zone("z2", "b.com")], purgeHandler);
    try {
      await until(app, (frame) => frame.includes("acme.com"));
      await press(app, "a");
      await until(app, (current) => current.includes("Purge cache — confirm"));

      await press(app, "n");
      const frame = await until(app, (current) => current.includes("Zones · client · 2"));
      expect(frame).not.toContain("Purge cache — confirm");
      expect(app.fake.requests).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  test("a group scope names the group and previews its zones", async () => {
    const zones = [zone("z1", "acme.com"), zone("z2", "brand-a.com")];
    const resolved = resolveScope({ kind: "group", groupId: "g1" }, zones, [group("g1", "Brand A", ["z1", "z2"])]);

    const app = await testRender(<PurgeConfirm resolved={resolved} colours={palette} onConfirm={() => {}} onCancel={() => {}} />, {
      width: 100,
      height: 24,
    });
    try {
      await settle(app);
      const frame = await until(app, (current) => current.includes("Purge cache — confirm"));
      expect(frame).toContain("Brand A");
      expect(frame).toContain("acme.com, brand-a.com");
      expect(frame).toContain("2 zones across 1 account.");
    } finally {
      await app.dispose();
    }
  });
});

describe("purge run", () => {
  test("reports every zone as accepted, never purged", async () => {
    const app = await openExplorer(
      [zone("z1", "acme.com"), zone("z2", "brand-a.com"), zone("z3", "shop.com")],
      purgeHandler,
    );
    try {
      await until(app, (frame) => frame.includes("acme.com"));
      await press(app, "a");
      await until(app, (current) => current.includes("Purge cache — confirm"));

      await press(app, "y");
      const frame = await until(app, (current) => current.includes("Cloudflare accepted 3 of 3 zones."));
      expect(frame).toContain("Purge cache — result");
      expect(frame).not.toContain("purged");

      const purges = app.fake.requests.filter((request) => request.url.includes("purge_cache"));
      expect(purges).toHaveLength(3);
      expect(purges.map((request) => new URL(request.url).pathname).sort()).toEqual([
        "/client/v4/zones/z1/purge_cache",
        "/client/v4/zones/z2/purge_cache",
        "/client/v4/zones/z3/purge_cache",
      ]);
    } finally {
      await app.dispose();
    }
  });

  test("closing the result leaves a one-line report on the list", async () => {
    const app = await openExplorer([zone("z1", "acme.com"), zone("z2", "b.com")], purgeHandler);
    try {
      await until(app, (frame) => frame.includes("acme.com"));
      await press(app, "a");
      await until(app, (current) => current.includes("Purge cache — confirm"));
      await press(app, "y");
      await until(app, (current) => current.includes("Cloudflare accepted 2 of 2 zones."));

      app.mockInput.pressEnter();
      const frame = await until(app, (current) => current.includes("Cloudflare accepted all 2 zones."));
      expect(frame).toContain("Zones · client · 2");
    } finally {
      await app.dispose();
    }
  });

  test("stale zones are counted on the confirmation and never sent", async () => {
    const app = await openExplorer([zone("z1", "acme.com"), zone("z2", "gone.com", STALE)], purgeHandler);
    try {
      await until(app, (frame) => frame.includes("acme.com"));
      await press(app, "a");

      const asking = await until(app, (current) => current.includes("Purge cache — confirm"));
      expect(asking).toContain("1 zone across 1 account.");
      expect(asking).toContain("1 stale zone will be skipped.");
      expect(asking).toContain("y purge 1 zone");

      await press(app, "y");
      await until(app, (current) => current.includes("Cloudflare accepted 1 of 1 zone."));

      const purges = app.fake.requests.filter((request) => request.url.includes("purge_cache"));
      expect(purges).toHaveLength(1);
      expect(purges[0]!.url).toContain("/zones/z1/purge_cache");
    } finally {
      await app.dispose();
    }
  });

  test("a scope of only stale zones is refused before the question is asked", async () => {
    const app = await openExplorer([zone("z1", "gone.com", STALE)], purgeHandler);
    try {
      await until(app, (frame) => frame.includes("gone.com"));
      await press(app, "a");

      const frame = await until(app, (current) =>
        current.includes("Every zone in scope is stale, so nothing would be sent to Cloudflare."),
      );
      expect(frame).not.toContain("Purge cache — confirm");
      expect(app.fake.requests).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  test("an empty configuration says there is nothing to purge", async () => {
    const app = await openExplorer([], purgeHandler);
    try {
      await until(app, (frame) => frame.includes("No zones yet"));
      await press(app, "a");

      const frame = await until(app, (current) => current.includes("nothing to purge"));
      expect(frame).not.toContain("Purge cache — confirm");
    } finally {
      await app.dispose();
    }
  });
});

describe("cancelling a purge", () => {
  test("q asks first, and stopping never pretends to have rolled anything back", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const app = await openExplorer(
      [zone("z1", "acme.com"), zone("z2", "brand-a.com"), zone("z3", "shop.com")],
      async (request) => {
        // Hold the first request open so the run is genuinely in flight.
        if (request.url.includes("purge_cache")) await gate;
        return ok({ id: "purge_1" });
      },
    );

    try {
      await until(app, (frame) => frame.includes("acme.com"));
      await press(app, "a");
      await until(app, (current) => current.includes("Purge cache — confirm"));

      await press(app, "y");
      const running = await until(app, (current) => current.includes("Purging the cache for"));
      expect(running).toContain("0 of 3 zones");
      expect(running).toContain("requests already sent cannot be recalled");

      // The first `q` is a question, not an order: nothing is aborted yet.
      await press(app, "q");
      const asking = await until(app, (current) => current.includes("Stop sending new purge requests?"));
      expect(asking).toContain("y stop");
      expect(app.fake.requests).toHaveLength(1);

      await press(app, "y");
      const done = await until(app, (current) => current.includes("Stopped early"));
      expect(done).toContain("Cloudflare accepted 0 of 3 zones.");
      expect(done).toContain("Requests already accepted cannot be recalled.");
      // Only the one request that was already in flight was ever sent.
      expect(app.fake.requests).toHaveLength(1);

      app.mockInput.pressEnter();
      const notice = await until(app, (current) => current.includes("Zones · client · 3"));
      expect(notice).toContain("Stopped early — Cloudflare accepted 0 of 3 zones.");
      expect(notice).toContain("cannot be recalled");
    } finally {
      release();
      await app.dispose();
    }
  });

  test("n keeps the purge going", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const app = await openExplorer([zone("z1", "acme.com")], async () => {
      await gate;
      return ok({ id: "purge_1" });
    });

    try {
      await until(app, (frame) => frame.includes("acme.com"));
      await press(app, "a");
      await until(app, (current) => current.includes("Purge cache — confirm"));
      await press(app, "y");
      await until(app, (current) => current.includes("Purging the cache for"));

      await press(app, "q");
      await until(app, (current) => current.includes("Stop sending new purge requests?"));
      await press(app, "n");

      release();
      const frame = await until(app, (current) => current.includes("Cloudflare accepted 1 of 1 zone."));
      expect(frame).not.toContain("Stopped early");
    } finally {
      release();
      await app.dispose();
    }
  });
});

describe("retrying failures", () => {
  test("r re-sends only what failed, and never a success", async () => {
    let z3Fails = true;

    const app = await openExplorer(
      [zone("z1", "acme.com"), zone("z2", "brand-a.com"), zone("z3", "shop.com")],
      (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/purge_cache")) {
          if (path.includes("/zones/z3/") && z3Fails) {
            z3Fails = false;
            return apiFailure(403, 9109, "Not allowed to purge this zone");
          }
          return ok({ id: "purge_1" });
        }
        return ok([], undefined);
      },
    );

    try {
      await until(app, (frame) => frame.includes("acme.com"));
      await press(app, "a");
      await until(app, (current) => current.includes("Purge cache — confirm"));
      await press(app, "y");

      const result = await until(app, (current) => current.includes("Cloudflare accepted 2 of 3 zones."));
      expect(result).toContain("1 could not be purged:");
      expect(result).toContain("shop.com — ");
      expect(result).toContain("r retry 1 failed zone");

      await press(app, "r");
      const retried = await until(app, (current) => current.includes("Cloudflare accepted 1 of 1 zone."));
      expect(retried).toContain("accepted");

      // z3 went twice; z1 and z2 were not re-sent.
      const purges = app.fake.requests
        .filter((request) => request.url.includes("purge_cache"))
        .map((request) => new URL(request.url).pathname);
      expect(purges.filter((path) => path.includes("/zones/z3/"))).toHaveLength(2);
      expect(purges.filter((path) => path.includes("/zones/z1/"))).toHaveLength(1);
      expect(purges.filter((path) => path.includes("/zones/z2/"))).toHaveLength(1);

      app.mockInput.pressEnter();
      const notice = await until(app, (current) => current.includes("Cloudflare accepted"));
      expect(notice).toContain("Zones · client · 3");
    } finally {
      await app.dispose();
    }
  });
});
