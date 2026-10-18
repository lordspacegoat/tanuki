/**
 * Interface tests. These run a real CliRenderer against an in-memory sink and
 * send real key and paste events, so they exercise the actual React tree, the
 * layout, the key routing and the painted text — not a mock.
 *
 * The transport is faked, so no test can reach the network or purge a real
 * cache. The assertions are deliberately about what a person sees, because that
 * is the layer where "the token is never painted" and "the result says accepted"
 * actually matter.
 *
 * A note on the frame helpers: the test renderer's own `waitForFrame` gives up
 * as soon as its scheduler is idle, so it cannot see work that finishes on the
 * real event loop (a file read, say). `until` below pumps frames *and* yields to
 * the loop, which is what makes the asynchronous screens testable.
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { CloudflareClient } from "../src/cloudflare/client.ts";
import { ConfigManager } from "../src/config/manager.ts";
import type { TanukiConfig, ZoneRecord } from "../src/config/schema.ts";
import { explainCredentials } from "../src/secrets/explanation.ts";
import { PassphrasePrompter } from "../src/secrets/prompt.ts";
import { App } from "../src/tui/app.tsx";
import type { AppDeps, BootInfo } from "../src/tui/app.tsx";
import { TokenEntry } from "../src/tui/screens/token-entry.tsx";
import { ZoneExplorer } from "../src/tui/screens/zone-explorer.tsx";
import { palette } from "../src/tui/theme.ts";
import { fakeCloudflare, apiFailure, ok, rawZone } from "./fake-cloudflare.ts";
import type { Handler } from "./fake-cloudflare.ts";
import { arrow, flatten, press, settle, typeText, until } from "./frame.ts";
import type { FrameHost } from "./frame.ts";
import { fakeStores, tempPaths } from "./helpers.ts";

const TOKEN = "cfut_AbCdEf0123456789_abcdefghijklmnopqrst";
/** A run of the token distinctive enough that its absence means something. */
const TOKEN_FINGERPRINT = "AbCdEf0123456789";
const TOKEN_LENGTH_LABEL = `${TOKEN.length} of 64 characters`;

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
  /** Runs before render; anything it returns is merged into `info`. */
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

describe("first run", () => {
  test("explains the mechanism that was actually detected", async () => {
    const app = await setup();
    try {
      const frame = await until(app, (current) => current.includes("Credentials · step 1 of 2"));
      expect(frame).toContain("the macOS Keychain");
      expect(frame).toContain("Your token is in the macOS Keychain");
      expect(frame).toContain("continue");
    } finally {
      await app.dispose();
    }
  });

  test("the second onboarding screen offers the passphrase opt-out", async () => {
    const app = await setup();
    try {
      await until(app, (current) => current.includes("step 1 of 2"));
      app.mockInput.pressEnter();
      const frame = await until(app, (current) => current.includes("step 2 of 2"));
      expect(frame).toContain("press p");
      expect(frame).toContain("stored nowhere");
      // The default and the opt-out are both spelled out, so neither is a guess.
      // (Frames are flattened, so the two-space column padding reads as one.)
      expect(frame).toContain("enter use the system store");
      expect(frame).toContain("p use a passphrase instead");
      expect(frame).toContain("b back");
    } finally {
      await app.dispose();
    }
  });

  test("with no system store it says so rather than offering one", async () => {
    const app = await setup({
      info: { credentialMode: "passphrase", keychainAvailable: false, credentialLabel: "none detected" },
    });
    try {
      const frame = await until(app, (current) => current.includes("Your token is in an encrypted file"));
      expect(frame).toContain("AES-256-GCM");
      expect(frame).not.toContain("the macOS Keychain");
    } finally {
      await app.dispose();
    }
  });

  test("a named --config that does not exist is stated and never substituted", async () => {
    const app = await setup({
      info: {
        requestedConfig: "ghost",
        missingConfig: true,
        configs: [{ id: "cfg_other", name: "other-client" }],
      },
    });
    try {
      const frame = await until(app, (current) => current.includes("Create configuration"));
      expect(frame).toContain("ghost");
      expect(frame).toContain("will not fall back");
      expect(frame).not.toContain("other-client");
    } finally {
      await app.dispose();
    }
  });

  test("refuses to render below the minimum size", async () => {
    const app = await setup({ width: 30, height: 10 });
    try {
      const frame = flatten(app.captureCharFrame());
      expect(frame).toContain("Terminal too small");
      expect(frame).toContain("need 40×14 · have 30×10");
    } finally {
      await app.dispose();
    }
  });
});

describe("token entry", () => {
  async function reachTokenScreen(handler?: Handler) {
    const app = await setup(handler ? { handler } : {});
    await until(app, (current) => current.includes("step 1 of 2"));
    app.mockInput.pressEnter(); // to step 2
    await until(app, (current) => current.includes("step 2 of 2"));
    app.mockInput.pressEnter(); // accept the keychain
    await until(app, (current) => current.includes("Paste a Cloudflare API token"));
    return app;
  }

  test("never paints the token, only its length", async () => {
    const app = await reachTokenScreen();
    try {
      await app.mockInput.pasteBracketedText(TOKEN);
      const frame = await until(app, (current) => current.includes(TOKEN_LENGTH_LABEL));

      expect(frame).toContain("•");
      // The load-bearing assertions: the secret is not on screen in any form.
      expect(frame).not.toContain(TOKEN);
      expect(frame).not.toContain(TOKEN_FINGERPRINT);
    } finally {
      await app.dispose();
    }
  });

  test("says nothing was written until Cloudflare confirms it", async () => {
    const app = await reachTokenScreen();
    try {
      const frame = await until(app, (current) => current.includes("Paste a Cloudflare API token"));
      expect(frame).toContain("Nothing is written to disk");
    } finally {
      await app.dispose();
    }
  });

  test("a rejected token is explained and leaves the field intact", async () => {
    const app = await reachTokenScreen(() => ok({ id: "tok_1", status: "expired" }));
    try {
      await app.mockInput.pasteBracketedText(TOKEN);
      await until(app, (current) => current.includes(TOKEN_LENGTH_LABEL));
      app.mockInput.pressEnter();

      const frame = await until(app, (current) => current.includes("expired"));
      expect(frame).toContain("Cloudflare reports this token as expired");
      // Still on the token screen, still holding what was pasted.
      expect(frame).toContain(TOKEN_LENGTH_LABEL);
      expect(frame).not.toContain(TOKEN_FINGERPRINT);
      expect(await app.manager.list()).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  test("a verified token creates the configuration and shows its zones", async () => {    const app = await reachTokenScreen((request) => {
      if (request.url.includes("verify")) return ok({ id: "tok_1", status: "active" });
      if (request.url.includes("purge_cache")) return ok({ id: "purge_1" });
      return ok([rawZone("z1", "acme.com"), rawZone("z2", "brand-a.com")], {
        page: 1,
        per_page: 50,
        count: 2,
        total_count: 2,
        total_pages: 1,
      });
    });
    try {
      await app.mockInput.pasteBracketedText(TOKEN);
      await until(app, (current) => current.includes(TOKEN_LENGTH_LABEL));
      app.mockInput.pressEnter();

      const frame = await until(app, (current) => current.includes("acme.com"));
      expect(frame).toContain("Zones · default");
      expect(frame).toContain("brand-a.com");
      expect(frame).toContain("z1");

      // The credential was stored and the zones were persisted.
      const [entry] = await app.manager.list();
      expect(await app.manager.getCredential(entry!.id)).toBe(TOKEN);
      expect((await app.manager.load(entry!.id)).zones).toHaveLength(2);
    } finally {
      await app.dispose();
    }
  });
});

describe("zone explorer", () => {
  async function openExplorer(handler?: Handler) {
    return setup({
      ...(handler ? { handler } : {}),
      info: { requestedConfig: "client" },
      seed: async (manager) => {
        const config = await manager.create({ name: "client" });
        await manager.setCredential(config.id, TOKEN);
        await manager.save({
          ...config,
          zones: [
            zone("z1", "acme.com"),
            zone("z2", "brand-a.com"),
            zone("z3", "acme-shop.com"),
          ],
        });
        return { resolvedConfig: { id: config.id, name: config.name }, activeConfigId: config.id };
      },
    });
  }

  test("an unreadable credential is stated plainly and changes nothing", async () => {
    const app = await setup({
      info: { requestedConfig: "client" },
      seed: async (manager) => {
        // The configuration exists but no credential is stored for it.
        const config = await manager.create({ name: "client", mode: "passphrase" });
        return { resolvedConfig: { id: config.id, name: config.name }, activeConfigId: config.id };
      },
    });
    try {
      const frame = await until(app, (current) => current.includes("Credentials unavailable"));
      expect(frame).toContain("No token is stored");
      expect(frame).toContain("Nothing is removed automatically");
      // The configuration was not deleted or repaired behind the user's back.
      expect(await app.manager.list()).toHaveLength(1);
    } finally {
      await app.dispose();
    }
  });

  test("lists zones by name and by ID", async () => {
    const app = await openExplorer();
    try {
      const frame = await until(app, (current) => current.includes("acme.com"));
      expect(frame).toContain("acme-shop.com");
      expect(frame).toContain("z2");
      expect(frame).toContain("Zones · client · 3");
    } finally {
      await app.dispose();
    }
  });

  test("search filters as you type, and clearing restores the list", async () => {
    const app = await openExplorer();
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "/");
      await typeText(app, "brand");
      const filtered = await until(app, (current) => current.includes("brand-a.com"));
      expect(filtered).not.toContain("acme.com");
      expect(filtered).toContain("1 of 3");

      app.mockInput.pressEscape();
      const cleared = await until(app, (current) => current.includes("▶ acme.com"));
      expect(cleared).toContain("Zones · client · 3");
      // The query really is gone, rather than the title merely containing "3".
      expect(cleared).toContain("/ search");
      expect(cleared).not.toContain(" of 3");
    } finally {
      await app.dispose();
    }
  });

  test("an unmatched search says so instead of showing a blank panel", async () => {
    const app = await openExplorer();
    try {
      await until(app, (current) => current.includes("acme.com"));
      await press(app, "/");
      await typeText(app, "zzzz");
      const frame = await until(app, (current) => current.includes("Nothing matches"));
      expect(frame).toContain("Nothing matches that search.");
    } finally {
      await app.dispose();
    }
  });

  test("arrow keys move the selection and the detail pane follows", async () => {
    const app = await openExplorer();
    try {
      await until(app, (current) => current.includes("acme.com"));

      await arrow(app, "down");
      const frame = await until(app, (current) => current.includes("▶ brand-a.com"));
      expect(frame).toContain("id z2");

      await arrow(app, "up");
      await until(app, (current) => current.includes("▶ acme.com"));
    } finally {
      await app.dispose();
    }
  });

  test("clearing a filter restores the selection, not just the list", async () => {
    const app = await openExplorer();
    try {
      await until(app, (current) => current.includes("acme.com"));

      // Select the third zone, then filter down to the two "acme" matches.
      await arrow(app, "down");
      await arrow(app, "down");
      await until(app, (current) => current.includes("▶ acme-shop.com"));

      await press(app, "/");
      await typeText(app, "acme");
      await until(app, (current) => current.includes("2 of 3"));

      // Clearing puts the cursor back on the zone that was selected before the
      // filter, rather than on whatever now happens to sit at that row index.
      app.mockInput.pressEscape();
      const frame = await until(app, (current) => current.includes("Zones · client · 3"));
      expect(frame).toContain("▶ acme-shop.com");
      expect(frame).toContain("id z3");
      expect(frame).toContain("/ search");
      expect(frame).not.toContain(" of 3");
    } finally {
      await app.dispose();
    }
  });

  test("a single-zone purge asks inline, then reports accepted — not purged", async () => {
    const purged: string[] = [];
    const app = await openExplorer((request) => {
      if (request.url.includes("purge_cache")) {
        purged.push(new URL(request.url).pathname);
        return ok({ id: "purge_1" });
      }
      return ok([], { page: 1, per_page: 50, count: 0, total_count: 0, total_pages: 1 });
    });
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "p");
      const asking = await until(app, (current) => current.includes("y / n"));
      expect(asking).toContain("Purge everything for acme.com?");

      await press(app, "y");
      const done = await until(app, (current) => current.includes("accepted"));
      // Cloudflare's own purge id, not a claim that the cache is now empty.
      expect(done).toContain("Cloudflare accepted · id");
      expect(done).toContain("purge_1");
      // Never claims eviction.
      expect(done).not.toContain("purged");

      expect(purged).toHaveLength(1);
      expect(purged[0]).toContain("/zones/z1/purge_cache");
    } finally {
      await app.dispose();
    }
  });

  test("declining the confirmation sends nothing", async () => {
    const requests: string[] = [];
    const app = await openExplorer((request) => {
      requests.push(request.url);
      return ok({ id: "purge_1" });
    });
    try {
      await until(app, (current) => current.includes("acme.com"));
      const before = requests.length;

      await press(app, "p");
      await until(app, (current) => current.includes("y / n"));
      await press(app, "n");

      const frame = await until(app, (current) => !current.includes("y / n"));
      expect(frame).not.toContain("Purge everything");
      expect(requests.length).toBe(before);
    } finally {
      await app.dispose();
    }
  });

  test("a stale zone refuses to purge and says why", async () => {
    const app = await setup({
      seed: async (manager) => {
        const config = await manager.create({ name: "client" });
        await manager.setCredential(config.id, TOKEN);
        await manager.save({
          ...config,
          zones: [
            zone("z1", "gone.com", { stale: { reason: "gone", detectedAt: "2026-01-01T00:00:00.000Z" } }),
            zone("z2", "acme.com"),
          ],
        });
        return { resolvedConfig: { id: config.id, name: config.name }, activeConfigId: config.id };
      },
    });
    try {
      await until(app, (current) => current.includes("gone.com"));

      await press(app, "p");
      const frame = await until(app, (current) => current.includes("nothing to purge"));
      expect(frame).toContain("Gone from Cloudflare");
      // It never even asks the yes/no question.
      expect(frame).not.toContain("y / n");
    } finally {
      await app.dispose();
    }
  });

  test("r re-reads the zone list from Cloudflare", async () => {
    const app = await openExplorer((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/purge_cache")) return ok({ id: "purge_1" });
      // The disappearance probe: z2 and z3 are gone, z1 is still reachable.
      if (path.endsWith("/zones/z2") || path.endsWith("/zones/z3")) {
        return apiFailure(404, 7003, `Could not route to ${path}`);
      }
      if (path.endsWith("/zones/z1")) return ok(rawZone("z1", "acme.com"));
      return ok([rawZone("z1", "acme.com"), rawZone("z9", "newly-added.com")], {
        page: 1,
        per_page: 50,
        count: 2,
        total_count: 2,
        total_pages: 1,
      });
    });
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "r");
      const frame = await until(app, (current) => current.includes("newly-added.com"));
      expect(frame).toContain("Zones refreshed");
      expect(frame).toContain("1 new");
      expect(frame).toContain("2 now stale");

      // The discovery was persisted, not just displayed: the vanished zones are
      // kept and marked, never silently dropped.
      const [entry] = await app.manager.list();
      const persisted = (await app.manager.load(entry!.id)).zones;
      expect(persisted.map((row) => row.id).sort()).toEqual(["z1", "z2", "z3", "z9"]);
      expect(persisted.find((row) => row.id === "z2")?.stale?.reason).toBe("gone");
    } finally {
      await app.dispose();
    }
  });

  test("g opens the groups screen, and esc comes back to the zones", async () => {
    const app = await openExplorer();
    try {
      await until(app, (current) => current.includes("acme.com"));

      await press(app, "g");
      const groups = await until(app, (current) => current.includes("Groups · client · 0"));
      expect(groups).toContain("No groups yet. Press n to create one.");
      expect(groups).toContain("3 zones in this configuration");

      app.mockInput.pressEscape();
      const back = await until(app, (current) => current.includes("Zones · client · 3"));
      expect(back).toContain("acme.com");
      expect(back).toContain("purge all");
      expect(back).toContain("q quit");
    } finally {
      await app.dispose();
    }
  });

  test("a group made in the interface is saved to the configuration", async () => {
    const app = await openExplorer();
    try {
      await until(app, (current) => current.includes("acme.com"));
      await press(app, "g");
      await until(app, (current) => current.includes("Groups · client · 0"));

      await press(app, "n");
      await typeText(app, "Brand A");
      app.mockInput.pressEnter();
      await until(app, (current) => current.includes("Created Brand A"));

      // Persisted through the real manager, not just painted.
      const [entry] = await app.manager.list();
      const saved = await app.manager.load(entry!.id);
      expect(saved.groups.map((saved_group) => saved_group.name)).toEqual(["Brand A"]);
    } finally {
      await app.dispose();
    }
  });
});

describe("configuration selector", () => {
  test("lists the saved configurations and marks the active one", async () => {
    const app = await setup({
      seed: async (manager) => {
        await manager.create({ name: "acme" });
        const beta = await manager.create({ name: "beta" });
        await manager.setActive(beta.id);
        return { activeConfigId: beta.id };
      },
    });
    try {
      const frame = await until(app, (current) => current.includes("acme"));
      expect(frame).toContain("Configurations · 2");
      expect(frame).toContain("beta");
      expect(frame).toContain("active");
    } finally {
      await app.dispose();
    }
  });

  test("n starts a new configuration", async () => {
    const app = await setup({
      seed: async (manager) => {
        await manager.create({ name: "acme" });
      },
    });
    try {
      await until(app, (current) => current.includes("Configurations · 1"));
      await press(app, "n");
      await until(app, (current) => current.includes("step 1 of 2"));
    } finally {
      await app.dispose();
    }
  });
});

describe("zone list persistence", () => {
  test("a failed save is reported rather than announced as success", async () => {
    const paths = await tempPaths();
    const manager = new ConfigManager(paths, fakeStores());
    const created = await manager.create({ name: "client" });
    const config: TanukiConfig = await manager.save({ ...created, zones: [zone("z1", "acme.com")] });

    const fake = fakeCloudflare((request) => {
      if (request.url.includes("purge_cache")) return ok({ id: "purge_1" });
      return ok([rawZone("z1", "acme.com")], {
        page: 1,
        per_page: 50,
        count: 1,
        total_count: 1,
        total_pages: 1,
      });
    });

    const app = await testRender(
      <ZoneExplorer
        config={config}
        getClient={async () => new CloudflareClient({ token: TOKEN, fetch: fake.fetch })}
        onQuit={() => {}}
        onZonesChanged={() => {
          throw new Error("the disk caught fire");
        }}
        onOpenGroups={() => {}}
        onReplaceToken={() => {}}
        colours={palette}
        mode="single-column"
        height={6}
      />,
      { width: 100, height: 24 },
    );

    try {
      await settle(app);
      await press(app, "r");
      const frame = await until(app, (current) => current.includes("the disk caught fire"));
      // The refresh succeeded, but it was not saved, so success must not be claimed.
      expect(frame).not.toContain("Zones refreshed");
    } finally {
      await app.dispose();
    }
  });
});

describe("token entry failure handling", () => {
  /**
   * The connect service reports failures as values, but an unexpected throw is
   * still possible — and a screen that waits forever on "checking" is the worst
   * outcome, because it looks like work in progress rather than a dead end.
   */
  test("a thrown verification error is shown, and the field handed back", async () => {
    const explanation = explainCredentials({
      mode: "keychain",
      keychainAvailable: true,
      keychainLabel: "the macOS Keychain",
      platform: "darwin",
    });

    const app = await testRender(
      <TokenEntry
        configName="client"
        explanation={explanation}
        colours={palette}
        onCancel={() => {}}
        onSubmit={async () => {
          // The message deliberately carries the token: the error path has to
          // redact before it reaches the screen.
          throw new Error(`the drive caught fire (${TOKEN})`);
        }}
      />,
      { width: 100, height: 24 },
    );

    try {
      await settle(app);
      await app.mockInput.pasteBracketedText(TOKEN);
      await until(app, (current) => current.includes(TOKEN_LENGTH_LABEL));
      app.mockInput.pressEnter();

      const frame = await until(app, (current) => current.includes("the drive caught fire"));
      // The pasted field survived the failure...
      expect(frame).toContain(TOKEN_LENGTH_LABEL);
      // ...and the token that was quoted in the error text was redacted.
      expect(frame).not.toContain(TOKEN_FINGERPRINT);
      expect(frame).toContain("[redacted]");
    } finally {
      await app.dispose();
    }
  });
});
