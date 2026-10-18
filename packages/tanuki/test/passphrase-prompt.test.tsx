/**
 * The passphrase prompt, on its own and inside the application.
 *
 * The store tests in `passphrase-store.test.ts` pin the mechanism; this file
 * pins what a person sees and can do: that the passphrase is never painted, that
 * a wrong one can be retried, that escaping is clean, and — the reason the
 * prompt takes the whole screen — that typing a `q` inside a passphrase does not
 * quit the application.
 *
 * The application tests here use the *real* passphrase store over a temporary
 * directory with the fast test KDF, so the vault on disk is a real vault and the
 * prompt is answered by pressing keys rather than by stubbing anything.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { CloudflareClient } from "../src/cloudflare/client.ts";
import { ConfigManager } from "../src/config/manager.ts";
import type { TanukiConfig, ZoneRecord } from "../src/config/schema.ts";
import { writeFileAtomic, FILE_MODE } from "../src/config/storage.ts";
import type { TanukiPaths } from "../src/config/paths.ts";
import { FAST_KDF_FOR_TESTS, open as openVault, seal } from "../src/secrets/crypto.ts";
import type { Vault } from "../src/secrets/crypto.ts";
import { PassphrasePrompter } from "../src/secrets/prompt.ts";
import { createCredentialStores } from "../src/secrets/store.ts";
import type { KeychainBackend } from "../src/secrets/keychain.ts";
import { App } from "../src/tui/app.tsx";
import type { AppDeps, BootInfo } from "../src/tui/app.tsx";
import { PassphrasePrompt } from "../src/tui/screens/passphrase-prompt.tsx";
import { palette } from "../src/tui/theme.ts";
import { ok, rawZone, fakeCloudflare } from "./fake-cloudflare.ts";
import type { Handler } from "./fake-cloudflare.ts";
import { settle, typeText, until } from "./frame.ts";
import type { FrameHost } from "./frame.ts";
import { tempPaths } from "./helpers.ts";

const PASSPHRASE = "correct horse battery staple";
const TOKEN = "cfut_AbCdEf0123456789_abcdefghijklmnopqrst";
/** Contains a `q`, because `q` is how you quit every other screen. */
const QUARTZ = "liquid-quartz-phrase";

const noop = () => {};

async function enter(app: FrameHost): Promise<void> {
  app.mockInput.pressEnter();
  await settle(app, 2);
}

/** The default fake: a valid token, one zone, and a purge that is accepted. */
const defaultHandler: Handler = (request) => {
  if (request.url.includes("verify")) return ok({ id: "tok_1", status: "active" });
  if (request.url.includes("purge_cache")) return ok({ id: "purge_1" });
  return ok([rawZone("z1", "acme.com")], { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 });
};

function prompt(props: Partial<Parameters<typeof PassphrasePrompt>[0]> = {}) {
  return (
    <PassphrasePrompt
      reason="unlock"
      onSubmit={noop}
      onCancel={noop}
      colours={palette}
      {...props}
    />
  );
}

describe("the prompt", () => {
  test("paints the length of the passphrase and never the passphrase", async () => {
    const app = await testRender(prompt({ subject: "client" }), { width: 100, height: 30 });
    try {
      await settle(app);
      await typeText(app, "hunter two");

      const frame = app.captureCharFrame();
      expect(frame).toContain("Unlock client");
      expect(frame).toContain("The token for this configuration is in an encrypted file.");
      expect(frame).toContain("•".repeat("hunter two".length));
      expect(frame).toContain("10 of 256");
      expect(frame).not.toContain("hunter");
      expect(frame).not.toContain("two");
    } finally {
      await app.dispose();
    }
  });

  test("hands the passphrase over on enter, and refuses an empty one", async () => {
    const answers: string[] = [];
    const app = await testRender(prompt({ onSubmit: (value) => answers.push(value) }), {
      width: 100,
      height: 30,
    });
    try {
      await settle(app);

      await enter(app);
      expect(answers).toEqual([]);

      await typeText(app, QUARTZ);
      await enter(app);
      expect(answers).toEqual([QUARTZ]);
    } finally {
      await app.dispose();
    }
  });

  test("escape is a dismissal, and it is offered on the screen", async () => {
    let cancelled = 0;
    const app = await testRender(prompt({ onCancel: () => (cancelled += 1) }), {
      width: 100,
      height: 30,
    });
    try {
      await settle(app);
      expect(flattened(app)).toContain("esc cancel");

      app.mockInput.pressEscape();
      // A lone Escape is ambiguous with the start of an escape sequence, so the
      // parser waits before reporting it. Pumping frames is what resolves it.
      await until(app, () => cancelled > 0);
      expect(cancelled).toBe(1);
    } finally {
      await app.dispose();
    }
  });

  test("a store failure is shown as the reason to try again", async () => {
    const app = await testRender(prompt({ error: "That passphrase did not unlock this vault." }), {
      width: 100,
      height: 30,
    });
    try {
      await settle(app);
      expect(flattened(app)).toContain("That passphrase did not unlock this vault.");
    } finally {
      await app.dispose();
    }
  });

  test("a pasted passphrase is accepted, and still never painted", async () => {
    const answers: string[] = [];
    const app = await testRender(prompt({ onSubmit: (value) => answers.push(value) }), {
      width: 100,
      height: 30,
    });
    try {
      await settle(app);
      // The path a password manager uses. A space is part of a passphrase, so
      // this also pins that whitespace survives the trip.
      await app.mockInput.pasteBracketedText(QUARTZ);
      await settle(app, 2);

      const frame = app.captureCharFrame();
      expect(frame).toContain("•".repeat(QUARTZ.length));
      expect(frame).not.toContain("quartz");

      await enter(app);
      expect(answers).toEqual([QUARTZ]);
    } finally {
      await app.dispose();
    }
  });
});

describe("the new-passphrase prompt", () => {
  test("asks twice, and will not save a short or mismatched pair", async () => {
    const answers: string[] = [];
    const app = await testRender(prompt({ reason: "create", onSubmit: (value) => answers.push(value) }), {
      width: 100,
      height: 30,
    });
    try {
      await settle(app);
      expect(flattened(app)).toContain("New passphrase");
      expect(flattened(app)).toContain("Confirm");

      // Too short to be sent: the message is the rule, stated where it is broken.
      await typeText(app, "short");
      await enter(app);
      expect(answers).toEqual([]);
      expect(flattened(app)).toContain("Use at least 8 characters.");

      // Long enough, so the second field takes over.
      await typeText(app, "-enough");
      await enter(app);
      expect(answers).toEqual([]);

      await typeText(app, "different");
      await enter(app);
      expect(answers).toEqual([]);
      expect(flattened(app)).toContain("The two passphrases do not match.");

      // Replaced with the matching one, typed twice: sent.
      app.mockInput.pressKey("u", { ctrl: true });
      await settle(app, 2);
      await typeText(app, "short-enough");
      await enter(app);
      expect(answers).toEqual(["short-enough"]);
    } finally {
      await app.dispose();
    }
  });
});

interface SetupOptions {
  info?: Partial<BootInfo>;
  width?: number;
  height?: number;
  handler?: Handler;
  /** Runs before render; anything it returns is merged into `info`. */
  seed?: (manager: ConfigManager, paths: TanukiPaths) => Promise<Partial<BootInfo> | void>;
}

/**
 * An application whose credential store is the real passphrase store, with a
 * keychain that is not there. That is exactly the environment the fallback is
 * for, and it is the only way a test can drive the prompt through a real vault.
 */
async function setup(options: SetupOptions = {}) {
  const paths = await tempPaths();
  const prompter = new PassphrasePrompter();
  const stores = await createCredentialStores({
    paths,
    prompt: prompter.request,
    kdf: FAST_KDF_FOR_TESTS,
    backend: unavailableKeychain,
  });
  const manager = new ConfigManager(paths, stores);

  const seeded = (await options.seed?.(manager, paths)) ?? {};
  const manifest = await manager.loadManifest();
  const fake = fakeCloudflare(options.handler ?? defaultHandler);

  const deps: AppDeps = {
    manager,
    stores,
    clientFor: (token) => new CloudflareClient({ token, fetch: fake.fetch }),
    prompter,
  };
  const info: BootInfo = {
    requestedConfig: null,
    resolvedConfig: null,
    missingConfig: false,
    configs: manifest.configs.map((entry) => ({ id: entry.id, name: entry.name })),
    activeConfigId: manifest.activeConfigId,
    credentialLabel: "none detected",
    credentialMode: "passphrase",
    keychainAvailable: false,
    platform: "linux",
    ...options.info,
    ...seeded,
  };

  const app = await testRender(<App info={info} deps={deps} />, {
    width: options.width ?? 120,
    height: options.height ?? 34,
  });
  await settle(app);

  return { ...app, manager, stores, prompter, paths, fake };
}

/** A machine with no credential store at all, which is what makes this fallback earn its keep. */
const unavailableKeychain: KeychainBackend = {
  label: "no system credential store",
  isAvailable: async () => false,
  get: async () => null,
  set: async () => {
    throw new Error("there is no system credential store on this machine");
  },
  remove: async () => {},
};

function zone(id: string, name: string): ZoneRecord {
  return {
    id,
    name,
    status: "active",
    accountId: "acct_1",
    accountName: "Acme",
    planId: "pro",
  };
}

/**
 * A configuration in passphrase mode with a real sealed vault and a zone list.
 *
 * The zones are saved rather than left for a refresh, so the explorer has
 * something to paint the moment the passphrase is accepted — which is the thing
 * the unlock is being tested for.
 */
async function seedPassphraseConfig(
  manager: ConfigManager,
  paths: TanukiPaths,
  passphrase: string,
): Promise<Partial<BootInfo>> {
  const config = await manager.create({ name: "client", mode: "passphrase" });
  await manager.save({ ...config, zones: [zone("z1", "acme.com")] });
  await seedVault(paths, config.id, passphrase, TOKEN);
  return { resolvedConfig: { id: config.id, name: config.name }, activeConfigId: config.id };
}

/** Writes a vault the way the store would have: a real seal, on disk. */
async function seedVault(paths: TanukiPaths, id: string, passphrase: string, token: string): Promise<void> {
  const vault = await seal(passphrase, token, FAST_KDF_FOR_TESTS);
  await writeFileAtomic(join(paths.vaultsDir, `${id}.json`), JSON.stringify(vault, null, 2), FILE_MODE);
}

async function readVault(paths: TanukiPaths, id: string, passphrase: string): Promise<string> {
  const raw = await Bun.file(join(paths.vaultsDir, `${id}.json`)).text();
  return openVault(passphrase, JSON.parse(raw) as Vault);
}

function flattened(app: FrameHost): string {
  return app.captureCharFrame().replace(/\s+/g, " ");
}

describe("opening a passphrase configuration", () => {
  async function seeded(options: { passphrase: string } = { passphrase: PASSPHRASE }) {
    return setup({
      seed: async (manager, paths) => seedPassphraseConfig(manager, paths, options.passphrase),
    });
  }

  test("asks for the passphrase by name, then opens the zones", async () => {
    const app = await seeded();
    try {
      const asked = await until(app, (frame) => frame.includes("Unlock client"));
      expect(asked).toContain("The token for this configuration is in an encrypted file.");
      // The footer describes the prompt, not the list it replaced.
      expect(asked).toContain("type your passphrase");

      await typeText(app, PASSPHRASE);
      await enter(app);

      expect(await until(app, (frame) => frame.includes("acme.com"))).toContain("acme.com");
    } finally {
      await app.dispose();
    }
  });

  test("a wrong passphrase is offered again, with the reason, and an empty field", async () => {
    const app = await seeded();
    try {
      await until(app, (frame) => frame.includes("Unlock client"));

      await typeText(app, "not the passphrase");
      await enter(app);

      const retried = await until(app, (frame) => frame.includes("did not unlock"));
      expect(retried).not.toContain("not the passphrase");
      // No length counter at all: the rejected passphrase is not left in the box.
      expect(retried).not.toContain("of 256");

      await typeText(app, PASSPHRASE);
      await enter(app);

      expect(await until(app, (frame) => frame.includes("acme.com"))).toContain("acme.com");
    } finally {
      await app.dispose();
    }
  });

  test("a passphrase containing q does not quit the application", async () => {
    // The screen has been replaced, so the list's `q quit` rule is not live while
    // the prompt is up. Without that, this passphrase would be untypeable.
    const app = await seeded({ passphrase: QUARTZ });
    try {
      await until(app, (frame) => frame.includes("Unlock client"));

      await typeText(app, QUARTZ);
      await enter(app);

      expect(await until(app, (frame) => frame.includes("acme.com"))).toContain("acme.com");
    } finally {
      await app.dispose();
    }
  });

  test("a pasted passphrase unlocks, and its spaces are part of it", async () => {
    // The passphrase under test has spaces in it, and it is pasted rather than
    // typed: the route a password manager uses. Stripping whitespace anywhere
    // along that path would seal the vault under something unrepeatable.
    const app = await seeded();
    try {
      await until(app, (frame) => frame.includes("Unlock client"));

      await app.mockInput.pasteBracketedText(PASSPHRASE);
      await settle(app, 2);
      expect(app.captureCharFrame()).not.toContain("correct");

      await enter(app);
      expect(await until(app, (frame) => frame.includes("acme.com"))).toContain("acme.com");
    } finally {
      await app.dispose();
    }
  });

  test("escaping changes nothing and returns to the list", async () => {
    const app = await seeded();
    try {
      await until(app, (frame) => frame.includes("Unlock client"));

      await typeText(app, "half-typed");
      app.mockInput.pressEscape();

      // The selector's title is only on the selector: the prompt says
      // "Unlock client", so this cannot be satisfied by the prompt itself.
      const list = await until(app, (frame) => frame.includes("Configurations · 1"));
      // Not the "credentials unavailable" screen: nothing is wrong.
      expect(list).not.toContain("Credentials unavailable");
      expect(list).toContain("enter open");

      // The configuration, its zones and its vault are all untouched.
      const [entry] = await app.manager.list();
      expect(entry?.name).toBe("client");
      expect(await readVault(app.paths, entry!.id, PASSPHRASE)).toBe(TOKEN);
    } finally {
      await app.dispose();
    }
  });
});

describe("creating a passphrase configuration", () => {
  /** Onboarding → token entry, choosing passphrase mode. */
  async function toTokenScreen(app: Awaited<ReturnType<typeof setup>>) {
    await until(app, (frame) => frame.includes("Credentials · step 1 of 2"));
    await enter(app);
    await until(app, (frame) => frame.includes("step 2 of 2"));
    app.mockInput.pressKey("p");
    await settle(app, 2);
    await until(app, (frame) => frame.includes("Paste a Cloudflare API token"));
  }

  test("asks for a new passphrase after the token is accepted, and seals the vault with it", async () => {
    const app = await setup();
    try {
      await toTokenScreen(app);

      await typeText(app, TOKEN);
      await enter(app);

      // Only after Cloudflare has confirmed the token, so a rejected token never
      // costs the user a passphrase decision.
      const asked = await until(app, (frame) => frame.includes("New passphrase"));
      expect(asked).toContain("stored nowhere");
      expect(app.fake.urls().some((url) => url.includes("verify"))).toBe(true);

      await typeText(app, PASSPHRASE);
      await enter(app);
      await typeText(app, PASSPHRASE);
      await enter(app);

      expect(await until(app, (frame) => frame.includes("acme.com"))).toContain("acme.com");

      const [entry] = await app.manager.list();
      expect(entry?.name).toBe("default");
      expect(await readVault(app.paths, entry!.id, PASSPHRASE)).toBe(TOKEN);
    } finally {
      await app.dispose();
    }
  });

  test("escaping the new passphrase abandons the configuration rather than half-creating it", async () => {
    const app = await setup();
    try {
      await toTokenScreen(app);
      await typeText(app, TOKEN);
      await enter(app);
      await until(app, (frame) => frame.includes("New passphrase"));

      app.mockInput.pressEscape();

      // Nothing was written: no configuration, no vault, and the app is back at
      // the start rather than on an emptied token form.
      await until(app, (frame) => frame.includes("Credentials · step 1 of 2"));
      expect(await app.manager.list()).toHaveLength(0);
      expect(app.prompter.current).toBeNull();
    } finally {
      await app.dispose();
    }
  });

  test("replacing a token keeps the vault's own passphrase", async () => {
    const app = await setup({
      seed: async (manager, paths) => seedPassphraseConfig(manager, paths, PASSPHRASE),
    });
    try {
      // Open it first: this is the ordinary route to the explorer, and it leaves
      // the passphrase cached for the session.
      await until(app, (frame) => frame.includes("Unlock client"));
      await typeText(app, PASSPHRASE);
      await enter(app);
      await until(app, (frame) => frame.includes("acme.com"));

      app.mockInput.pressKey("t");
      await settle(app, 2);
      const replacing = await until(app, (frame) => frame.includes("Replace token"));
      expect(replacing).toContain("client");

      await typeText(app, "cfut_second_token_value_abcdefghijkl");
      await enter(app);

      // No second question: the vault was unlocked for this session, so swapping
      // the token cannot silently change what protects it.
      await until(app, (frame) => frame.includes("acme.com"));
      expect(app.prompter.current).toBeNull();

      const [entry] = await app.manager.list();
      const config = (await app.manager.load(entry!.id)) as TanukiConfig;
      expect(await readVault(app.paths, config.id, PASSPHRASE)).toBe(
        "cfut_second_token_value_abcdefghijkl",
      );
    } finally {
      await app.dispose();
    }
  });
});
