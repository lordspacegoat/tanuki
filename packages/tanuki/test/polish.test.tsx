/**
 * The polish pass: deleting and renaming configurations, replacing a token,
 * ignoring a zone, and the row budget that keeps a list from painting over the
 * hint underneath it.
 *
 * These drive the real React tree against a faked transport, like the other
 * interface tests, and they assert on painted text for the same reason: every
 * claim here is something a person reading the screen would notice.
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { CloudflareClient } from "../src/cloudflare/client.ts";
import { ConfigManager } from "../src/config/manager.ts";
import type { TanukiConfig, ZoneRecord } from "../src/config/schema.ts";
import { App } from "../src/tui/app.tsx";
import type { AppDeps, BootInfo } from "../src/tui/app.tsx";
import { PassphrasePrompter } from "../src/secrets/prompt.ts";
import { lastPurgeLines } from "../src/tui/screens/zone-explorer.tsx";
import { fakeCloudflare, apiFailure, ok, rawZone } from "./fake-cloudflare.ts";
import type { Handler } from "./fake-cloudflare.ts";
import { press, settle, typeText, until } from "./frame.ts";
import { fakeStores, tempPaths } from "./helpers.ts";

const TOKEN = "cfut_AbCdEf0123456789_abcdefghijklmnopqrst";
const NEW_TOKEN = "cfut_ZyXwVu9876543210_zyxwvutsrqponmlkjihg";

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

const defaultHandler: Handler = (request) => {
  if (request.url.includes("verify")) return ok({ id: "tok_1", status: "active" });
  if (request.url.includes("purge_cache")) return ok({ id: "purge_1" });
  return ok([], { page: 1, per_page: 50, count: 0, total_count: 0, total_pages: 1 });
};

interface SetupOptions {
  info?: Partial<BootInfo>;
  width?: number;
  height?: number;
  handler?: Handler;
  configs?: number;
  zones?: ZoneRecord[];
  seed?: (manager: ConfigManager) => Promise<Partial<BootInfo> | void>;
}

async function setup(options: SetupOptions = {}) {
  const paths = await tempPaths();
  const stores = fakeStores();
  const manager = new ConfigManager(paths, stores);

  const seeded = (await options.seed?.(manager)) ?? {};
  const manifest = await manager.loadManifest();

  const fake = fakeCloudflare(options.handler ?? defaultHandler);
  const deps: AppDeps = {
    manager,
    stores,
    clientFor: (token) => new CloudflareClient({ token, fetch: fake.fetch }),
    prompter: new PassphrasePrompter(),
  };

  const info: BootInfo = {
    requestedConfig: null,
    resolvedConfig: null,
    missingConfig: false,
    configs: manifest.configs.map((entry) => ({ id: entry.id, name: entry.name })),
    activeConfigId: manifest.activeConfigId,
    credentialLabel: "the macOS Keychain",
    credentialMode: "keychain",
    keychainAvailable: true,
    platform: "darwin",
    ...options.info,
    ...seeded,
  };

  const rendered = await testRender(<App info={info} deps={deps} />, {
    width: options.width ?? 120,
    height: options.height ?? 30,
  });
  await settle(rendered);

  return { ...rendered, manager, stores, fake };
}

/** A configuration with three zones, opened straight onto the explorer. */
async function onExplorer(options: SetupOptions = {}) {
  return setup({
    ...options,
    info: { requestedConfig: "client" },
    seed: async (manager) => {
      const config = await manager.create({ name: "client" });
      await manager.setCredential(config.id, TOKEN);
      await manager.save({
        ...config,
        zones: options.zones ?? [zone("z1", "acme.com"), zone("z2", "brand-a.com"), zone("z3", "acme-shop.com")],
      });
      return { resolvedConfig: { id: config.id, name: config.name }, activeConfigId: config.id };
    },
  });
}

describe("ignoring a zone", () => {
  test("x asks first, and y stops it being purged", async () => {
    const app = await onExplorer();
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "x");
      const question = await until(app, (current) => current.includes("Ignore acme.com?"));
      // Ignoring is not deletion, and the question has to say so: the zone is
      // still on Cloudflare, and its cache is untouched.
      expect(question).toContain("It stays on Cloudflare");

      await press(app, "y");
      const done = await until(app, (current) => current.includes("is ignored"));

      expect(done).toContain("acme.com is ignored");
      // Hidden from the list by default, and counted in the title so it is not
      // simply forgotten.
      expect(done).not.toContain("▶ acme.com");
      expect(done).toContain("2 · 1 ignored");

      const entry = (await app.manager.list())[0]!;
      const saved = await app.manager.load(entry.id);
      expect(saved.zones.find((row) => row.id === "z1")?.ignored).toBe(true);
    } finally {
      await app.dispose();
    }
  });

  test("the question can be declined, and nothing is written", async () => {
    const app = await onExplorer();
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "x");
      await until(app, (current) => current.includes("Ignore acme.com?"));
      await press(app, "n");

      const kept = await until(app, (current) => current.includes("▶ acme.com"));
      // No badge: the row is not marked ignored. (The panel's key hint mentions
      // "i ignored", so the check is the row, not the word.)
      expect(kept).not.toContain("acme.com ignored");

      const entry = (await app.manager.list())[0]!;
      const saved = await app.manager.load(entry.id);
      expect(saved.zones.find((row) => row.id === "z1")?.ignored).toBeUndefined();
    } finally {
      await app.dispose();
    }
  });

  test("i brings ignored zones back, badged, and x undoes it", async () => {
    const app = await onExplorer();
    try {
      await until(app, (current) => current.includes("acme.com"));
      await press(app, "x");
      await until(app, (current) => current.includes("Ignore acme.com?"));
      await press(app, "y");
      await until(app, (current) => current.includes("acme.com is ignored"));

      await press(app, "i");
      const shown = await until(app, (current) => current.includes("ignored zone shown"));
      expect(shown).toContain("acme.com");
      expect(shown).toContain("ignored");

      // No confirmation to go back: un-ignoring only re-enables purging.
      await press(app, "x");
      const restored = await until(app, (current) => current.includes("no longer ignored"));

      const entry = (await app.manager.list())[0]!;
      const saved = await app.manager.load(entry.id);
      expect(saved.zones.find((row) => row.id === "z1")?.ignored).toBeUndefined();
      expect(restored).toContain("▶ acme.com");
    } finally {
      await app.dispose();
    }
  });

  test("an ignored zone refuses to be purged, and says who decided that", async () => {
    const app = await onExplorer({
      zones: [zone("z1", "acme.com", { ignored: true }), zone("z2", "brand-a.com")],
    });
    try {
      // The ignored zone is hidden, so it has to be shown before it can be
      // selected.
      await press(app, "i");
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "p");
      const refused = await until(app, (current) => current.includes("stop ignoring it"));

      expect(refused).toContain("Press x to stop ignoring it");
      // Nothing was sent. The purge request never leaves the fake.
      expect(app.fake.urls().filter((url) => url.includes("purge_cache"))).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  test("purging every zone leaves ignored zones out of the count", async () => {
    const app = await onExplorer({
      zones: [zone("z1", "acme.com", { ignored: true }), zone("z2", "brand-a.com")],
    });
    try {
      await until(app, (current) => current.includes("brand-a.com"));

      await press(app, "a");
      const confirm = await until(app, (current) => current.includes("Purge cache — confirm"));

      // One zone, not two, and the ignored one is named as skipped rather than
      // silently dropped from a count that has to agree with the list.
      expect(confirm).toContain("1 zone across 1 account");
      expect(confirm).toContain("1 ignored zone will be skipped");
    } finally {
      await app.dispose();
    }
  });
});

describe("what Cloudflare said", () => {
  test("a single-zone purge reports Cloudflare's purge id, not just 'sent'", async () => {
    const app = await onExplorer({
      handler: (request) =>
        request.url.includes("purge_cache") ? ok({ id: "purge_acme" }) : defaultHandler(request),
    });
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "p");
      await until(app, (current) => current.includes("Purge everything for acme.com?"));
      await press(app, "y");

      const done = await until(app, (current) => current.includes("Cloudflare accepted"));
      expect(done).toContain("id purge_acme");
      // Accepted is still not purged.
      expect(done).not.toContain("purged");
    } finally {
      await app.dispose();
    }
  });

  test("the last purge is remembered on the zone and shown in the detail pane", async () => {
    const app = await onExplorer({
      handler: (request) =>
        request.url.includes("purge_cache") ? ok({ id: "purge_acme" }) : defaultHandler(request),
    });
    try {
      await until(app, (current) => current.includes("acme.com"));
      expect(await until(app, (current) => current.includes("last purge"))).toContain("never");

      await press(app, "p");
      await until(app, (current) => current.includes("Purge everything for acme.com?"));
      await press(app, "y");
      const done = await until(app, (current) => current.includes("Cloudflare accepted"));

      // The detail pane follows the notice, and the record survives the save.
      expect(done).toContain("just now · accepted");
      expect(done).toContain("id purge_acme");

      const entry = (await app.manager.list())[0]!;
      const saved = await app.manager.load(entry.id);
      const record = saved.zones.find((row) => row.id === "z1")?.lastPurge;
      expect(record?.ok).toBe(true);
      expect(record?.purgeId).toBe("purge_acme");
    } finally {
      await app.dispose();
    }
  });

  test("a failure is remembered as a failure, with the reason", () => {
    // Pure, so the wording is pinned without a renderer.
    const failed = zone("z1", "acme.com", {
      lastPurge: { at: new Date(Date.now() - 120_000).toISOString(), ok: false, reason: "Cloudflare throttled this." },
    });
    expect(lastPurgeLines(failed, Date.now())).toEqual([
      "2 minutes ago · failed",
      "reason: Cloudflare throttled this.",
    ]);
  });

  test("a zone that has never been purged says so in one line", () => {
    expect(lastPurgeLines(zone("z1", "acme.com"), Date.now())).toEqual(["never"]);
  });

  test("the identifier gets its own line, because a real one is 32 characters", () => {
    // Lorem ipsum of purge ids: the shape Cloudflare actually returns. In a
    // single `label: value` field the identifier would be cut to about half of
    // itself, which is a purge id that identifies nothing.
    const id = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    const accepted = zone("z1", "acme.com", {
      lastPurge: { at: new Date().toISOString(), ok: true, purgeId: id, durationMs: 214 },
    });
    const lines = lastPurgeLines(accepted, Date.now());

    expect(lines[0]).toBe("just now · accepted");
    expect(lines[1]).toBe(`id ${id} · 214 ms`);
    expect(lines[1]).toContain(id);
    expect(lines[1]).not.toContain("…");
  });
});

describe("a configuration can be repaired from the selector", () => {
  async function onSelector(options: SetupOptions = {}) {
    return setup({
      ...options,
      seed: async (manager) => {
        const first = await manager.create({ name: "client" });
        await manager.setCredential(first.id, TOKEN);
        await manager.save({ ...first, zones: [zone("z1", "acme.com")] });
        const second = await manager.create({ name: "other client" });
        await manager.setCredential(second.id, TOKEN);
        await manager.save({ ...second, zones: [zone("z9", "other.com")] });
        return {};
      },
    });
  }

  test("r renames, and the new name is written", async () => {
    const app = await onSelector();
    try {
      const start = await until(app, (current) => current.includes("Configurations · 2"));
      expect(start).toContain("client");

      await press(app, "r");
      const prompt = await until(app, (current) => current.includes("rename to:"));
      // Seeded with the current name, so a rename is an edit rather than a
      // retype.
      expect(prompt).toContain("rename to: client");

      for (let index = 0; index < "client".length; index += 1) app.mockInput.pressBackspace();
      await settle(app, 2);
      await typeText(app, "renamed client");
      app.mockInput.pressEnter();

      const renamed = await until(app, (current) => current.includes("renamed client"));
      expect(renamed).not.toContain("rename to:");

      const names = (await app.manager.list()).map((entry) => entry.name).sort();
      expect(names).toEqual(["other client", "renamed client"]);
    } finally {
      await app.dispose();
    }
  });

  test("a name that is already taken is refused, and what was typed is kept", async () => {
    const app = await onSelector();
    try {
      await until(app, (current) => current.includes("Configurations · 2"));

      await press(app, "r");
      await until(app, (current) => current.includes("rename to:"));
      for (let index = 0; index < "client".length; index += 1) app.mockInput.pressBackspace();
      await settle(app, 2);
      await typeText(app, "other client");
      app.mockInput.pressEnter();

      const refused = await until(app, (current) => current.includes("already"));
      expect(refused).toContain("rename to: other client");

      const names = (await app.manager.list()).map((entry) => entry.name).sort();
      expect(names).toEqual(["client", "other client"]);
    } finally {
      await app.dispose();
    }
  });

  test("d asks with y, and deleting removes the configuration and its token", async () => {
    const app = await onSelector();
    try {
      await until(app, (current) => current.includes("Configurations · 2"));

      await press(app, "d");
      const question = await until(app, (current) => current.includes("cannot be recovered"));
      // The consequence is stated, because this is the one action with no undo.
      expect(question).toContain("Delete client?");

      await press(app, "y");
      const gone = await until(app, (current) => current.includes("Configurations · 1"));

      expect(gone).not.toContain("▶ client");
      const remaining = await app.manager.list();
      expect(remaining.map((entry) => entry.name)).toEqual(["other client"]);
      // The token went with it.
      expect(await app.manager.getCredential(remaining[0]!.id)).toBe(TOKEN);
    } finally {
      await app.dispose();
    }
  });

  test("n keeps the configuration", async () => {
    const app = await onSelector();
    try {
      await until(app, (current) => current.includes("Configurations · 2"));

      await press(app, "d");
      await until(app, (current) => current.includes("cannot be recovered"));
      await press(app, "n");

      await until(app, (current) => current.includes("Configurations · 2"));
      expect((await app.manager.list()).map((entry) => entry.name).sort()).toEqual(["client", "other client"]);
    } finally {
      await app.dispose();
    }
  });

  test("deleting the active configuration moves the badge with the pointer", async () => {
    const app = await onSelector();
    try {
      await until(app, (current) => current.includes("client active"));

      await press(app, "d");
      await until(app, (current) => current.includes("cannot be recovered"));
      await press(app, "y");

      // The manifest moved its active pointer; a badge left pointing at the
      // deleted row would mark nothing and leave the real one unmarked.
      const moved = await until(app, (current) => current.includes("other client active"));
      expect(moved).toContain("Configurations · 1");

      const remaining = (await app.manager.list())[0]!;
      expect(remaining.name).toBe("other client");
      expect((await app.manager.loadManifest()).activeConfigId).toBe(remaining.id);
    } finally {
      await app.dispose();
    }
  });

  test("deleting the last configuration lands on onboarding, not an empty list", async () => {
    const app = await setup({
      seed: async (manager) => {
        const only = await manager.create({ name: "client" });
        await manager.setCredential(only.id, TOKEN);
        return {};
      },
    });
    try {
      await until(app, (current) => current.includes("Configurations · 1"));

      await press(app, "d");
      await until(app, (current) => current.includes("cannot be recovered"));
      await press(app, "y");

      // A selector with nothing in it is a dead end; the first-run screen is the
      // way forward.
      const onboarding = await until(app, (current) => current.includes("Credentials · step 1 of 2"));
      expect(onboarding).toContain("the macOS Keychain");
      expect(await app.manager.list()).toEqual([]);
    } finally {
      await app.dispose();
    }
  });
});

describe("replacing a token", () => {
  test("t takes a new token, verifies it, and swaps the credential", async () => {
    const seen: string[] = [];
    const app = await onExplorer({
      handler: (request) => {
        const authorization = request.headers["Authorization"] ?? request.headers["authorization"] ?? "";
        if (authorization) seen.push(authorization);
        return defaultHandler(request);
      },
    });
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "t");
      const screen = await until(app, (current) => current.includes("Replace token"));
      expect(screen).toContain("Replace token · client");
      // The old token is not thrown away before the new one is proven.
      expect(screen).toContain("keeps working until Cloudflare confirms");

      await typeText(app, NEW_TOKEN);
      app.mockInput.pressEnter();

      await until(app, (current) => current.includes("acme.com"));

      const entry = (await app.manager.list())[0]!;
      expect(await app.manager.getCredential(entry.id)).toBe(NEW_TOKEN);
      expect(seen.some((header) => header.includes(NEW_TOKEN))).toBe(true);
    } finally {
      await app.dispose();
    }
  });

  test("a rejected token changes nothing", async () => {
    const app = await onExplorer({
      handler: (request) =>
        request.url.includes("verify")
          ? apiFailure(401, 10000, "Invalid API Token")
          : defaultHandler(request),
    });
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "t");
      await until(app, (current) => current.includes("Replace token"));

      await typeText(app, NEW_TOKEN);
      app.mockInput.pressEnter();

      // The verdict is Tanuki's own sentence, not Cloudflare's raw error text:
      // raw API text is never shown to the user (decision S3).
      const refused = await until(app, (current) => current.includes("Cloudflare rejected this token"));

      const entry = (await app.manager.list())[0]!;
      expect(await app.manager.getCredential(entry.id)).toBe(TOKEN);
      // Still on the token screen, so pasting again is one keystroke away.
      expect(refused).toContain("Replace token");
      // And the raw message from the API is nowhere on screen.
      expect(refused).not.toContain("Invalid API Token");
    } finally {
      await app.dispose();
    }
  });

  test("the new token re-reads the zones, because permissions may have changed", async () => {
    const app = await onExplorer({
      handler: (request) => {
        if (request.url.includes("verify")) return ok({ id: "tok_1", status: "active" });
        if (request.url.includes("/zones")) {
          return ok([rawZone("z1", "acme.com"), rawZone("z2", "brand-a.com")], {
            page: 1,
            per_page: 50,
            count: 2,
            total_count: 2,
            total_pages: 1,
          });
        }
        return ok([], undefined);
      },
    });
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "t");
      await until(app, (current) => current.includes("Replace token"));
      await typeText(app, NEW_TOKEN);
      app.mockInput.pressEnter();

      // acme-shop.com is gone from the new token's view and a refresh would mark
      // it, but the point here is that the list was re-read at all.
      const refreshed = await until(app, (current) => current.includes("acme.com"));
      expect(refreshed).toContain("Zones · client");

      const entry = (await app.manager.list())[0]!;
      const saved = await app.manager.load(entry.id);
      expect(saved.zones.map((row) => row.id).sort()).toContain("z1");
    } finally {
      await app.dispose();
    }
  });
});

describe("nothing overlaps", () => {
  test("a long name is shortened inside its own row, not wrapped onto another", async () => {
    const long = "an-extremely-long-zone-name-that-would-otherwise-wrap-the-row.example.com";
    const app = await onExplorer({ zones: [zone("z1", long), zone("z2", "b.com")], width: 100, height: 24 });
    try {
      await until(app, (current) => current.includes("b.com"));
      const raw = app.captureCharFrame();

      // The cut is visible, and the row still exists.
      expect(raw).toContain("…");
      // Two zone rows, so b.com is on the row right after the long one rather
      // than two rows below it. A wrapped label would push it down.
      const lines = raw.split("\n");
      const first = lines.findIndex((line) => line.includes("an-extremely-long") && line.includes("z1"));
      const second = lines.findIndex((line) => line.includes("b.com"));
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBe(first + 1);
      // And the footer is still the last thing on the screen.
      const footer = lines.findIndex((line) => line.includes("made with"));
      expect(footer).toBeGreaterThan(second);
    } finally {
      await app.dispose();
    }
  });

  test("a long notice is clipped to one row, and the footer survives", async () => {
    const app = await onExplorer({
      zones: [zone("z1", "acme.com")],
      handler: () => apiFailure(403, 9109, "A very long explanation that keeps going and going and going"),
      width: 100,
      height: 24,
    });
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "p");
      await until(app, (current) => current.includes("Purge everything for acme.com?"));
      await press(app, "y");

      const frame = await until(app, (current) => current.includes("was not purged"));
      // The footer is the last row, so a notice that wrapped would push it off
      // the screen instead of being clipped.
      expect(frame).toContain("made with");
      expect(frame).toContain("q quit");
    } finally {
      await app.dispose();
    }
  });

  test("a running purge owns the footer instead of advertising keys that lie", async () => {
    const app = await onExplorer({
      zones: [zone("z1", "acme.com"), zone("z2", "brand-a.com")],
      handler: (request) => {
        if (request.url.includes("purge_cache")) return ok({ id: "purge_1" });
        return defaultHandler(request);
      },
    });
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "a");
      const confirm = await until(app, (current) => current.includes("Purge cache — confirm"));
      // The confirmation carries its own keys, so the footer must not claim
      // `q` quits while `q` would mean "cancel this question".
      expect(confirm).toContain("y purge");
      expect(confirm).toContain("n cancel");
    } finally {
      await app.dispose();
    }
  });

  test("the footer keeps q quit visible on a single-column terminal", async () => {
    const app = await onExplorer({ width: 64, height: 30 });
    try {
      const frame = await until(app, (current) => current.includes("acme.com"));
      expect(frame).toContain("q quit");
      expect(frame).toContain("made with");
    } finally {
      await app.dispose();
    }
  });

  test("the footer keeps q quit visible on a compact terminal", async () => {
    const app = await onExplorer({ width: 50, height: 30 });
    try {
      const frame = await until(app, (current) => current.includes("acme.com"));
      expect(frame).toContain("q quit");
      expect(frame).toContain("made with");
    } finally {
      await app.dispose();
    }
  });

  test("the panel's key line is a whole phrase, not a cut one", async () => {
    // A 44-column terminal gives the panel about 38 columns. `p purge · a purge
    // all · x ignore · t replace token` does not fit and used to end mid-word
    // ("t repl…"), which reads as a rendering bug rather than as a hint.
    const app = await onExplorer({ width: 44, height: 24 });
    try {
      const frame = await until(app, (current) => current.includes("acme.com"));

      expect(frame).toContain("p purge · a purge all · x ignore");
      expect(frame).not.toContain("…");
      expect(frame).not.toContain("t replace");
    } finally {
      await app.dispose();
    }
  });

  test("the groups screen shortens its key line the same way", async () => {
    const app = await onExplorer({ width: 44, height: 24 });
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "g");
      const frame = await until(app, (current) => current.includes("Groups"));

      expect(frame).toContain("enter edit · n new · p purge");
      expect(frame).not.toContain("d delete");
      expect(frame).not.toContain("…");
    } finally {
      await app.dispose();
    }
  });
});

describe("the header mascot", () => {
  test("all five rows are painted, to the right of the wordmark", async () => {
    const app = await onExplorer();
    try {
      await until(app, (current) => current.includes("acme.com"));
      const raw = app.captureCharFrame();

      // Ears, brow, eyes, snout, chin — the whole face, not a trimmed part.
      expect(raw).toContain("▄▄▄   ▄▄▄");
      expect(raw).toContain("▐█████████▌");
      expect(raw).toContain("▐█ •   • █▌");
      expect(raw).toContain("▐█   ᴥ   █▌");
      expect(raw).toContain("▀▀▀▀▀▀▀▀▀");

      // The ear row is the wordmark's row: the face is anchored right, alongside
      // TANUKI, rather than stacked under it.
      const earRow = raw.split("\n").find((line) => line.includes("▄▄▄   ▄▄▄"))!;
      expect(earRow).toContain("TANUKI");
    } finally {
      await app.dispose();
    }
  });

  test("it disappears rather than clipping on a compact terminal", async () => {
    const app = await onExplorer({ width: 50, height: 30 });
    try {
      await until(app, (current) => current.includes("acme.com"));
      expect(app.captureCharFrame()).not.toContain("ᴥ");
    } finally {
      await app.dispose();
    }
  });

  test("a purge starts the runner across the tagline", async () => {
    const app = await onExplorer({
      zones: [zone("z1", "acme.com")],
      handler: (request) =>
        request.url.includes("purge_cache") ? ok({ id: "purge_1" }) : defaultHandler(request),
    });
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "p");
      await until(app, (current) => current.includes("Purge everything for acme.com?"));
      await press(app, "y");

      // A run begins with the whole sprite on the track, so it is there on the
      // very first frame rather than a sliver arriving from off-stage. Either
      // stride counts: which paw goes first is not the point.
      const frame = await until(
        app,
        (current) => (current.includes("(^ᴥ^)") || current.includes("(>ᴥ<)")) && current.includes("cache manager"),
      );
      expect(frame).toContain("TANUKI");
      expect(frame).toContain("cache manager");
    } finally {
      await app.dispose();
    }
  });
});
