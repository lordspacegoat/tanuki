#!/usr/bin/env bun
/**
 * Renders Tanuki's screens to SVG against a seeded, fake configuration.
 *
 * The README needs to show what the interface looks like, and a picture taken by
 * hand goes stale the first time the layout changes. This drives the real
 * application — the real React tree, the real renderer, the real key handling —
 * over a temporary configuration and a faked Cloudflare transport, then paints
 * each captured frame to a standalone SVG.
 *
 * Two rules make the output reproducible, which is what lets it be committed:
 *
 *  - the clock is frozen. "2 minutes ago" in a detail pane, and every "412 ms"
 *    round trip, would otherwise be a different string on every run, and a
 *    screenshot that churns in git is worse than no screenshot.
 *  - nothing here can reach the network or a real credential. The transport is
 *    `test/fake-cloudflare.ts`, shared with the test suite, and the "keychain"
 *    is an in-memory map.
 *
 * Usage:
 *   bun run screenshots                 # write every screen to assets/screenshots
 *   bun run screenshots --only zones    # one screen, while working on it
 *   bun run screenshots --out /tmp/shots
 */
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { CloudflareClient } from "../src/cloudflare/client.ts";
import { ConfigManager } from "../src/config/manager.ts";
import type { Group, TanukiConfig, ZoneRecord } from "../src/config/schema.ts";
import { PassphrasePrompter } from "../src/secrets/prompt.ts";
import { resolveScope } from "../src/services/purge-scope.ts";
import { App } from "../src/tui/app.tsx";
import type { AppDeps, BootInfo } from "../src/tui/app.tsx";
import { palette, resolvePalette } from "../src/tui/theme.ts";
import { PurgeRun } from "../src/tui/screens/purge-flow.tsx";
import { fakeCloudflare, ok } from "../test/fake-cloudflare.ts";
import { fakeStores, tempPaths } from "../test/helpers.ts";
import { press, settle, until } from "../test/frame.ts";
import type { FrameHost } from "../test/frame.ts";
import type { Frame } from "./frame-types.ts";
import { frameToSvg } from "./terminal-svg.ts";

/** The real clock, restored once the seeded world is torn down. */
const realNow = Date.now;

/** A canned "now". See the note above about reproducibility. */
const FIXED_NOW = Date.parse("2026-05-14T09:41:00.000Z");
/** Pretend each purge request takes this long, so round trips are not all zero. */
const FAKE_ROUND_TRIP_MS = 38;

const WIDTH = 112;
const HEIGHT = 30;
const TOKEN = "cfut_ScreenshotToken0000000000000000000";

// ---------------------------------------------------------------------------
// A seed configuration that exercises the interesting states: several accounts,
// different plans, a stale zone, an ignored zone, and a zone that was purged.
// ---------------------------------------------------------------------------

const ACME = { id: "acct_9f2c1a", name: "Acme Corporation", plan: "free" };
const GLOBEX = { id: "acct_4b7de0", name: "Globex", plan: "pro" };
const INITECH = { id: "acct_c1a5e3", name: "Initech", plan: "business" };

const ZONE_NAMES: Array<{ name: string; account: typeof ACME }> = [
  ...["acme.com", "acme-shop.com", "acme-cdn.com", "acme-blog.com", "acme-api.com", "acme-docs.com", "acme-help.com", "acme-status.com", "acme-careers.com", "acme-labs.com", "acme-mail.com", "acme-wiki.com", "acme-delivery.com", "acme-payments.com", "acme-orders.com", "acme-billing.com", "acme-search.com", "acme-assets.com", "acme-forms.com", "acme-legacy.com"].map((name) => ({ name, account: ACME })),
  ...["globex.com", "globex-cloud.com", "globex-media.com", "globex-tv.com", "globex-store.com", "globex-events.com", "globex-jobs.com", "globex-partners.com"].map((name) => ({ name, account: GLOBEX })),
  ...["initech.dev", "initech-io.dev", "initech-docs.dev", "initech-sandbox.dev"].map((name) => ({ name, account: INITECH })),
];

/** A stable 32-hex zone id that looks like Cloudflare's, without inventing one by hand. */
function zoneId(name: string): string {
  return createHash("sha256").update(`tanuki-screenshot:${name}`).digest("hex").slice(0, 32);
}

function seededZones(): ZoneRecord[] {
  const staleAt = new Date(FIXED_NOW - 3 * 24 * 60 * 60 * 1000).toISOString();

  return ZONE_NAMES.map(({ name, account }) => {
    const base = {
      id: zoneId(name),
      name,
      status: "active" as const,
      accountId: account.id,
      accountName: account.name,
      planId: account.plan,
    };

    if (name === "acme-legacy.com") return { ...base, stale: { reason: "gone" as const, detectedAt: staleAt } };
    if (name === "initech-sandbox.dev") return { ...base, ignored: true };
    if (name === "acme.com") {
      return {
        ...base,
        lastPurge: {
          at: new Date(FIXED_NOW - 2 * 60 * 1000).toISOString(),
          ok: true,
          purgeId: createHash("sha256").update("purge:acme.com").digest("hex").slice(0, 32),
          durationMs: 412,
        },
      };
    }
    if (name === "globex-tv.com") {
      return {
        ...base,
        lastPurge: {
          at: new Date(FIXED_NOW - 5 * 60 * 60 * 1000).toISOString(),
          ok: false,
          reason: "Cloudflare rate limited the request",
        },
      };
    }

    return base;
  });
}

function seededGroups(zones: readonly ZoneRecord[]): Group[] {
  const at = new Date(FIXED_NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
  const ids = (...names: string[]) => names.map(zoneId);

  return [
    {
      id: "group_production",
      name: "Production",
      zoneIds: ids("acme.com", "acme-shop.com", "acme-api.com", "acme-payments.com", "acme-orders.com", "globex.com", "globex-store.com", "initech.dev"),
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "group_cdn",
      name: "CDN only",
      zoneIds: ids("acme-cdn.com", "acme-assets.com", "globex-media.com"),
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "group_staging",
      name: "Staging",
      zoneIds: ids("acme-labs.com", "acme-forms.com", "initech-io.dev"),
      createdAt: at,
      updatedAt: at,
    },
  ].filter((group) => group.zoneIds.every((id) => zones.some((zone) => zone.id === id)));
}

// ---------------------------------------------------------------------------
// The world each screenshot is rendered against.
// ---------------------------------------------------------------------------

interface World {
  deps: AppDeps;
  /** The `acme` configuration, with its seeded zones and groups. */
  config: TanukiConfig;
  info: (overrides?: Partial<BootInfo>) => BootInfo;
  dispose: () => Promise<void>;
}

async function world(): Promise<World> {
  const paths = await tempPaths("tanuki-shot-");
  const stores = fakeStores();
  const manager = new ConfigManager(paths, stores);

  const zones = seededZones();
  const acme = await manager.save({ ...(await manager.create({ name: "acme" })), zones, groups: seededGroups(zones) });
  const globex = await manager.create({ name: "globex" });
  const initech = await manager.create({ name: "initech" });
  for (const entry of [acme, globex, initech]) await manager.setCredential(entry.id, TOKEN);

  // A purge request advances the frozen clock, so each round trip is a real,
  // repeatable duration rather than 0 ms; anything else answers immediately.
  let clock = FIXED_NOW;
  Date.now = () => clock;
  const fetch = fakeCloudflare((request) => {
    if (request.url.includes("purge_cache")) {
      clock += FAKE_ROUND_TRIP_MS;
      const zone = request.url.split("/zones/")[1]?.split("/")[0] ?? "unknown";
      return ok({ id: createHash("sha256").update(`purge:${zone}`).digest("hex").slice(0, 32) });
    }
    return ok([]);
  });

  const deps: AppDeps = {
    manager,
    stores,
    clientFor: (token) => new CloudflareClient({ token, fetch: fetch.fetch }),
    prompter: new PassphrasePrompter(),
  };

  const configs = [
    { id: acme.id, name: acme.name },
    { id: globex.id, name: globex.name },
    { id: initech.id, name: initech.name },
  ];

  return {
    deps,
    config: acme,
    info: (overrides = {}) => ({
      requestedConfig: "acme",
      resolvedConfig: { id: acme.id, name: acme.name },
      missingConfig: false,
      configs,
      activeConfigId: acme.id,
      credentialLabel: "the macOS Keychain",
      credentialMode: "keychain",
      keychainAvailable: true,
      platform: "darwin",
      ...overrides,
    }),
    dispose: async () => {
      Date.now = realNow;
      await rm(paths.root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Capturing.
// ---------------------------------------------------------------------------

interface Capture {
  svg: string;
}

/** A host that can also hand back styled spans, which is what the SVG is drawn from. */
type CaptureHost = FrameHost & { captureSpans: () => Frame };

async function boot(info: BootInfo, deps: AppDeps) {
  const app = await testRender(<App info={info} deps={deps} />, { width: WIDTH, height: HEIGHT });
  await settle(app, 30);
  return app;
}

/**
 * Waits out the header's tanuki, so a screenshot is never caught mid-scurry.
 *
 * The capture is polled rather than assumed, because the sprite's timer drives
 * a React update and the renderer's output buffer can be mid-paint when the
 * frame is asked for. A busy buffer is not an error here — it means "not yet".
 */
async function waitForIdleHeader(app: FrameHost, timeoutMs = 8000): Promise<void> {
  const start = performance.now();

  while (performance.now() - start < timeoutMs) {
    try {
      await app.renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (app.captureCharFrame().includes("Cloudflare cache manager")) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function capture(frame: CaptureHost, title: string): Promise<Capture> {
  // `SHOT_DEBUG=1` prints the captured frame as text alongside painting it: when
  // the picture and the words disagree, the words are what a reader can diff.
  if (process.env.SHOT_DEBUG) {
    const raw = frame.captureCharFrame();
    for (const [index, line] of raw.split("\n").entries()) {
      process.stderr.write(`${String(index).padStart(2)} [${line.length}] ${JSON.stringify(line)}\n`);
    }
  }
  return { svg: frameToSvg(frame.captureSpans(), { title, background: palette.base }) };
}

function write(name: string, capture: Capture, out: string): Promise<void> {
  return writeFile(join(out, `${name}.svg`), capture.svg, "utf8");
}

// ---------------------------------------------------------------------------
// The screens.
// ---------------------------------------------------------------------------

type Screen = (world: World) => Promise<Capture>;

const screens: Record<string, Screen> = {
  /** First run: the explanation of where the token will be kept. */
  onboarding: async (world) => {
    const app = await boot(world.info({ requestedConfig: null, resolvedConfig: null, configs: [], activeConfigId: null }), world.deps);
    try {
      await until(app, (frame) => frame.includes("step 1 of 2"));
      return capture(app, "tanuki — first run");
    } finally {
      await app.dispose();
    }
  },

  /** The configuration selector, with three configurations. */
  "config-select": async (world) => {
    const app = await boot(world.info({ requestedConfig: null, resolvedConfig: null }), world.deps);
    try {
      await until(app, (frame) => frame.includes("Configurations · 3"));
      return capture(app, "tanuki — configurations");
    } finally {
      await app.dispose();
    }
  },

  /** The zone explorer: the list, and the detail pane for the selected zone. */
  zones: async (world) => {
    const app = await boot(world.info(), world.deps);
    try {
      await until(app, (frame) => frame.includes("Zones · acme ·"));
      return capture(app, "tanuki — zones");
    } finally {
      await app.dispose();
    }
  },

  /** The counted confirmation before an all-zone purge. */
  "purge-confirm": async (world) => {
    const app = await boot(world.info(), world.deps);
    try {
      await until(app, (frame) => frame.includes("Zones · acme ·"));
      await press(app, "a");
      await until(app, (frame) => frame.includes("Purge cache — confirm"));
      return capture(app, "tanuki — purge");
    } finally {
      await app.dispose();
    }
  },

  /** A purge in flight. The run is held open so the middle of it can be caught. */
  "purge-running": async (world) => {
    const resolved = resolveScope({ kind: "all" }, world.config.zones, world.config.groups, "auto");
    const colours = resolvePalette({ rgb: true });
    const app = await testRender(
      <box flexDirection="column" flexGrow={1} paddingX={1} backgroundColor={palette.base}>
        <box flexDirection="row" flexGrow={1} paddingTop={1}>
          <PurgeRun
            resolved={resolved}
            colours={colours}
            run={async (_zones, _signal, onProgress) => {
              onProgress({
                total: resolved.zones.length,
                completed: 17,
                accepted: 17,
                failed: 0,
                skipped: 0,
                outcomes: [],
              });
              // Never settles: the shot is of a run that is still going.
              return new Promise(() => {});
            }}
            onDone={() => {}}
          />
        </box>
      </box>,
      { width: WIDTH, height: HEIGHT },
    );
    try {
      await settle(app, 20);
      return capture(app as unknown as CaptureHost, "tanuki — purging");
    } finally {
      await app.dispose();
    }
  },

  /** What the run left behind: Cloudflare's own acknowledgements. */
  "purge-result": async (world) => {
    const app = await boot(world.info(), world.deps);
    try {
      await until(app, (frame) => frame.includes("Zones · acme ·"));
      await press(app, "a");
      await until(app, (frame) => frame.includes("Purge cache — confirm"));
      await press(app, "y");
      await until(app, (frame) => frame.includes("Purge cache — result"));
      // The header's tanuki crossed the tagline as the run started; let it finish
      // so the picture does not depend on how many frames were pumped.
      await waitForIdleHeader(app);
      return capture(app, "tanuki — purge result");
    } finally {
      await app.dispose();
    }
  },

  /** Groups, and the zone counts a purge would actually reach. */
  groups: async (world) => {
    const app = await boot(world.info(), world.deps);
    try {
      await until(app, (frame) => frame.includes("Zones · acme ·"));
      await press(app, "g");
      await until(app, (frame) => frame.includes("Groups · acme ·"));
      return capture(app, "tanuki — groups");
    } finally {
      await app.dispose();
    }
  },
};

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function parseArguments(argv: string[]): { only: string | null; out: string } {
  const repo = resolve(import.meta.dir, "..", "..", "..");
  let only: string | null = null;
  let out = join(repo, "assets", "screenshots");

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--only") only = argv[++index] ?? null;
    else if (flag === "--out") out = resolve(argv[++index] ?? out);
    else if (flag === "--help" || flag === "-h") {
      process.stdout.write("usage: bun run screenshots [--only <name>] [--out <dir>]\n");
      process.stdout.write(`screens: ${Object.keys(screens).join(", ")}\n`);
      process.exit(0);
    }
  }

  if (only !== null && !(only in screens)) {
    process.stderr.write(`unknown screen "${only}". Known: ${Object.keys(screens).join(", ")}\n`);
    process.exit(2);
  }

  return { only, out };
}

async function main(): Promise<void> {
  const { only, out } = parseArguments(process.argv.slice(2));
  await mkdir(out, { recursive: true });

  const names = only === null ? Object.keys(screens) : [only];
  const shots = await world();

  try {
    for (const name of names) {
      const screen = screens[name]!;
      const result = await screen(shots);
      await write(name, result, out);
      process.stdout.write(`${name}.svg\n`);
    }
  } finally {
    await shots.dispose();
  }
}

if (import.meta.main) {
  await main();
}
