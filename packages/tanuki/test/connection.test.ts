import { describe, expect, test } from "bun:test";
import { CloudflareClient } from "../src/cloudflare/client.ts";
import { ConfigManager } from "../src/config/manager.ts";
import { connect, normaliseToken, summariseAccounts } from "../src/services/connection.ts";
import { PassphraseCancelledError } from "../src/secrets/types.ts";
import type { ZoneRecord } from "../src/config/schema.ts";
import { apiFailure, fakeCloudflare, ok, rawZone } from "./fake-cloudflare.ts";
import type { FakeCloudflare } from "./fake-cloudflare.ts";
import { fakeStores, tempPaths } from "./helpers.ts";
import type { FakeStores } from "./helpers.ts";

const TOKEN = "cfut_AbCdEf0123456789_abcdefghijklmnop";

interface Harness {
  manager: ConfigManager;
  stores: FakeStores;
  client: CloudflareClient;
}

async function harness(fake: FakeCloudflare, stores = fakeStores()): Promise<Harness> {
  const paths = await tempPaths();
  return {
    manager: new ConfigManager(paths, stores),
    stores,
    client: new CloudflareClient({ token: TOKEN, fetch: fake.fetch }),
  };
}

/** A transport that answers verify and one page of zones. */
function happyTransport(zones: ReturnType<typeof rawZone>[] = [rawZone("z1", "a.com")]) {
  return fakeCloudflare((request) => {
    if (request.url.includes("/user/tokens/verify")) return ok({ id: "tok_1", status: "active" });
    if (request.url.includes("/zones")) {
      return ok(zones, { page: 1, per_page: 50, count: zones.length, total_count: zones.length, total_pages: 1 });
    }
    return apiFailure(404, 7003, "no route");
  });
}

describe("connect", () => {
  test("verifies the token, then persists the configuration and its zones", async () => {
    const fake = happyTransport([rawZone("z1", "a.com"), rawZone("z2", "b.com")]);
    const { manager, client } = await harness(fake);

    const result = await connect(manager, { name: "Acme", token: TOKEN, client });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.zones.map((zone) => zone.id).sort()).toEqual(["z1", "z2"]);
    expect(result.config.name).toBe("Acme");
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(false);

    // It really persisted, and the credential landed in the store.
    const reloaded = await manager.load(result.config.id);
    expect(reloaded.zones).toHaveLength(2);
    expect(await manager.getCredential(result.config.id)).toBe(TOKEN);
    expect(await manager.findByName("Acme")).not.toBeNull();
  });

  test("writes nothing at all when the token is rejected (decision S9)", async () => {
    const fake = fakeCloudflare(() => apiFailure(401, 10000, "authentication error"));
    const { manager, stores, client } = await harness(fake);

    const result = await connect(manager, { name: "Acme", token: TOKEN, client });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("token-rejected");
    expect(result.message).toContain("rejected this token");

    // No configuration, no credential, no file.
    expect(await manager.list()).toHaveLength(0);
    expect(stores.keychain.values.size).toBe(0);
  });

  test("a token Cloudflare knows but will not accept is not a success", async () => {
    const fake = fakeCloudflare(() => ok({ id: "tok_1", status: "disabled" }));
    const { manager, client } = await harness(fake);

    const result = await connect(manager, { name: "Acme", token: TOKEN, client });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("token-not-active");
    expect(result.message).toContain("disabled");
    expect(await manager.list()).toHaveLength(0);
  });

  test("a valid token missing Zone:Read is reported before any write", async () => {
    const fake = fakeCloudflare((request) =>
      request.url.includes("verify") ? ok({ id: "tok_1", status: "active" }) : apiFailure(403, 9109, "denied"),
    );
    const { manager, stores, client } = await harness(fake);

    const result = await connect(manager, { name: "Acme", token: TOKEN, client });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing-permission");
    expect(result.message).toContain("Zone → Zone → Read");
    expect(await manager.list()).toHaveLength(0);
    expect(stores.keychain.values.size).toBe(0);
  });

  test("an unreachable Cloudflare is a network failure, not a data change", async () => {
    const fake = fakeCloudflare(() => {
      throw new Error("ECONNREFUSED");
    });
    const { manager, client } = await harness(fake);

    const result = await connect(manager, { name: "Acme", token: TOKEN, client });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("network");
    expect(await manager.list()).toHaveLength(0);
  });

  test("refuses a duplicate name without touching the network", async () => {
    const fake = happyTransport();
    const { manager, client } = await harness(fake);
    await connect(manager, { name: "Acme", token: TOKEN, client });
    const requestsAfterFirst = fake.requests.length;

    const result = await connect(manager, { name: "acme", token: TOKEN, client });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("name-taken");
    // Case-insensitive, and it did not spend a round trip finding out.
    expect(fake.requests.length).toBe(requestsAfterFirst);
  });

  test("an empty token is rejected before anything else happens", async () => {
    const fake = happyTransport();
    const { manager, client } = await harness(fake);

    const result = await connect(manager, { name: "Acme", token: "   \n ", client });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("empty-token");
    expect(fake.requests).toHaveLength(0);
  });

  test("a token pasted with whitespace is stored normalised", async () => {
    const fake = happyTransport();
    const { manager, stores, client } = await harness(fake);

    const result = await connect(manager, { name: "Acme", token: ` ${TOKEN.slice(0, 10)}\n${TOKEN.slice(10)} `, client });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await manager.getCredential(result.config.id)).toBe(TOKEN);
    expect([...stores.keychain.values.values()]).toEqual([TOKEN]);
  });

  test("a configuration whose credential fails to store is rolled back, not left behind", async () => {
    const fake = happyTransport();
    const stores = fakeStores();
    // The keychain rejects the write — a locked store, a full disk, a refusal.
    stores.keychain.set = async () => {
      throw new Error("the keychain refused the write");
    };
    const { manager, client } = await harness(fake, stores);

    const result = await connect(manager, { name: "Acme", token: TOKEN, client });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("credential-store");
    expect(result.rolledBack).toBe(true);

    // The half-made configuration is gone: no config, no manifest entry, no
    // orphaned file. A configuration with no credential would look usable.
    expect(await manager.list()).toHaveLength(0);
    expect(await manager.active()).toBeNull();
    await expect(manager.load(result.rolledBack ? "anything" : "")).rejects.toThrow();
  });

  test("a dismissed passphrase prompt is a cancellation, not a storage failure", async () => {
    const fake = happyTransport();
    const stores = fakeStores();
    // What the passphrase store does when the user presses escape instead of
    // choosing a passphrase.
    stores.passphrase.set = async () => {
      throw new PassphraseCancelledError("c1");
    };
    const { manager, client } = await harness(fake, stores);

    const result = await connect(manager, { name: "Acme", token: TOKEN, mode: "passphrase", client });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // "The credential store failed" would send the user hunting for a problem
    // that does not exist, so a decision has its own reason and its own words.
    expect(result.reason).toBe("interrupted");
    expect(result.message).toContain("nothing was saved");
    expect(result.rolledBack).toBe(true);
    expect(await manager.list()).toHaveLength(0);
  });

  test("honours the passphrase mode when asked", async () => {    const fake = happyTransport();
    const { manager, stores, client } = await harness(fake);

    const result = await connect(manager, { name: "Acme", token: TOKEN, mode: "passphrase", client });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.credential.mode).toBe("passphrase");
    expect(stores.passphrase.values.size).toBe(1);
    expect(stores.keychain.values.size).toBe(0);
  });

  test("records that a truncated zone list was truncated", async () => {
    const fake = fakeCloudflare((request) => {
      if (request.url.includes("verify")) return ok({ id: "tok_1", status: "active" });
      const page = Number(new URL(request.url).searchParams.get("page"));
      // Claim a thousand pages so the safety cap is hit.
      return ok([rawZone(`z${page}`, `z${page}.com`)], {
        page,
        per_page: 50,
        count: 1,
        total_count: 1000,
        total_pages: 1000,
      });
    });
    const { manager, client } = await harness(fake);

    const result = await connect(manager, { name: "Acme", token: TOKEN, client });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.zones).toHaveLength(400);
  });

  test("a cancelled connect leaves nothing behind", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = happyTransport();
    const { manager, client } = await harness(fake);

    const result = await connect(manager, {
      name: "Acme",
      token: TOKEN,
      client,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(await manager.list()).toHaveLength(0);
  });
});

describe("summariseAccounts", () => {
  function zone(id: string, accountId: string, accountName: string, planId: string): ZoneRecord {
    return { id, name: `${id}.com`, status: "active", accountId, accountName, planId };
  }

  test("rolls zones up per account, largest first", () => {
    const accounts = summariseAccounts([
      zone("z1", "a", "Acme", "pro"),
      zone("z2", "a", "Acme", "pro"),
      zone("z3", "b", "Beta", "free"),
    ]);

    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ id: "a", name: "Acme", zoneCount: 2 });
    expect(accounts[1]).toMatchObject({ id: "b", zoneCount: 1 });
  });

  test("reports the account's pace as the slowest of its zones", () => {
    // The number on screen is the number the purge engine will actually use.
    const [account] = summariseAccounts([zone("z1", "a", "Acme", "enterprise"), zone("z2", "a", "Acme", "free")]);
    expect(account!.tier).toBe("free");
    expect(account!.rateLabel).toBe("5/min");
  });

  test("an unknown plan is paced conservatively and said to be unknown", () => {
    const [account] = summariseAccounts([zone("z1", "a", "Acme", "quantum")]);
    expect(account!.tier).toBe("unknown");
    expect(account!.rateLabel).toBe("5/min");
  });

  test("zones with no account are grouped rather than dropped", () => {
    const accounts = summariseAccounts([{ id: "z1", name: "a.com", status: "active" }]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.id).toBe("unknown");
    expect(accounts[0]!.zoneCount).toBe(1);
  });
});

describe("normaliseToken", () => {
  test("strips every kind of whitespace a paste can carry", () => {
    expect(normaliseToken(" a\r\nb\tc ")).toBe("abc");
  });
});
