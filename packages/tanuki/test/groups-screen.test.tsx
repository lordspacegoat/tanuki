/**
 * Group management tests: the summary, create/rename/delete, the membership
 * editor and the group purge.
 *
 * These drive the real screen against a faked transport, so no test can reach
 * the network or clear a real cache. What is being pinned here is mostly the
 * *staging* contract — nothing is written until Apply, Esc discards, and a
 * deletion never touches a zone — because those are the promises a destructive
 * interface has to keep.
 */
import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { CloudflareClient } from "../src/cloudflare/client.ts";
import type { Group, TanukiConfig, ZoneRecord } from "../src/config/schema.ts";
import { GroupsScreen } from "../src/tui/screens/groups.tsx";
import { palette } from "../src/tui/theme.ts";
import { fakeCloudflare, ok } from "./fake-cloudflare.ts";
import type { Handler } from "./fake-cloudflare.ts";
import { arrow, press, settle, typeText, until } from "./frame.ts";

const TOKEN = "cfut_AbCdEf0123456789_abcdefghijklmnopqrst";
const STALE = { stale: { reason: "gone" as const, detectedAt: "2026-01-01T00:00:00.000Z" } };

function zone(id: string, name: string, extra: Partial<ZoneRecord> = {}): ZoneRecord {
  return { id, name, status: "active", accountId: "acct_1", accountName: "Acme", planId: "pro", ...extra };
}

function group(id: string, name: string, zoneIds: string[]): Group {
  return { id, name, zoneIds, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

function configFor(zones: ZoneRecord[], groups: Group[]): TanukiConfig {
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

const purgeHandler: Handler = (request) =>
  request.url.includes("purge_cache") ? ok({ id: "purge_1" }) : ok([], undefined);

/**
 * `pressKey("enter")` is not the Enter key — the mock sends the literal letters
 * e-n-t-e-r, so every "enter" in these tests goes through `pressEnter`.
 */
async function enter(app: Parameters<typeof settle>[0] & { mockInput: { pressEnter: () => void } }) {
  app.mockInput.pressEnter();
  await settle(app, 2);
}

/**
 * Renders the screen under a small stateful parent, standing in for the app
 * shell: a save replaces the group list, exactly as `manager.save` does, so the
 * screen is exercised the way it is actually mounted.
 */
async function openGroups(
  zones: ZoneRecord[],
  groups: Group[] = [],
  handler: Handler = purgeHandler,
) {
  const fake = fakeCloudflare(handler);
  const persisted: Group[][] = [];
  const backed: boolean[] = [];

  function Harness() {
    const [config, setConfig] = useState<TanukiConfig>(() => configFor(zones, groups));
    return (
      <GroupsScreen
        config={config}
        getClient={async () => new CloudflareClient({ token: TOKEN, fetch: fake.fetch })}
        onGroupsChanged={(next) => {
          persisted.push(next);
          setConfig((current) => ({ ...current, groups: next }));
        }}
        onBack={() => backed.push(true)}
        colours={palette}
        mode="single-column"
        height={10}
      />
    );
  }

  const rendered = await testRender(<Harness />, { width: 110, height: 30 });
  await settle(rendered);
  return { ...rendered, fake, persisted, backed };
}

describe("group summary", () => {
  test("counts members, and a zone in two groups is grouped, not double-counted", async () => {
    const app = await openGroups(
      [zone("z1", "acme.com"), zone("z2", "brand-a.com"), zone("z3", "shop.com")],
      [group("g1", "Brand A", ["z1", "z3"]), group("g2", "Brand B", ["z3"])],
    );
    try {
      const frame = await until(app, (current) => current.includes("Groups · client · 2"));
      // z2 belongs to nothing; z3 belongs to two groups and is still one zone.
      expect(frame).toContain("3 zones in this configuration · 1 ungrouped");
      expect(frame).toContain("Brand A");
      expect(frame).toContain("2 zones");
      expect(frame).toContain("Brand B");
      expect(frame).toContain("1 zone");
    } finally {
      await app.dispose();
    }
  });

  test("a member whose zone is stale is still listed, but not counted as purgeable", async () => {
    const app = await openGroups(
      [zone("z1", "acme.com"), zone("z2", "gone.com", STALE)],
      [group("g1", "Brand A", ["z1", "z2"])],
    );
    try {
      // The group keeps both IDs; the row says what a purge would reach, which
      // is the same number the confirmation screen will show.
      const frame = await until(app, (current) => current.includes("Brand A"));
      expect(frame).toContain("1 zone");
      expect(frame).toContain("2 zones in this configuration");
    } finally {
      await app.dispose();
    }
  });

  test("an empty list invites a first group instead of showing a blank panel", async () => {
    const app = await openGroups([zone("z1", "acme.com")]);
    try {
      const frame = await until(app, (current) => current.includes("Groups · client · 0"));
      expect(frame).toContain("No groups yet. Press n to create one.");
      expect(frame).toContain("1 ungrouped");
    } finally {
      await app.dispose();
    }
  });
});

describe("creating, renaming and deleting", () => {
  test("n creates a group with a name that may contain a space", async () => {
    const app = await openGroups([zone("z1", "acme.com")]);
    try {
      await until(app, (current) => current.includes("Groups · client · 0"));
      await press(app, "n");
      await typeText(app, "Brand A");
      const typing = await until(app, (current) => current.includes("new group: Brand A"));
      expect(typing).toContain("enter save");

      app.mockInput.pressEnter();
      const frame = await until(app, (current) => current.includes("Created Brand A"));
      expect(frame).toContain("Groups · client · 1");
      expect(app.persisted.at(-1)?.map((entry) => entry.name)).toEqual(["Brand A"]);
    } finally {
      await app.dispose();
    }
  });

  test("a duplicate name is refused on the prompt line and nothing is saved", async () => {
    const app = await openGroups([zone("z1", "acme.com")], [group("g1", "Brand A", ["z1"])]);
    try {
      await until(app, (current) => current.includes("Groups · client · 1"));
      await press(app, "n");
      await typeText(app, "Brand A");
      app.mockInput.pressEnter();

      const frame = await until(app, (current) => current.includes("already exists"));
      expect(frame).toContain('a group called "Brand A" already exists');
      // Still typing, with the text intact, and nothing written.
      expect(frame).toContain("new group: Brand A");
      expect(app.persisted).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  test("esc abandons a name being typed", async () => {
    const app = await openGroups([zone("z1", "acme.com")]);
    try {
      await until(app, (current) => current.includes("Groups · client · 0"));
      await press(app, "n");
      await typeText(app, "Half typed");
      app.mockInput.pressEscape();

      const frame = await until(app, (current) => !current.includes("Half typed"));
      expect(frame).toContain("No groups yet");
      expect(app.persisted).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  test("r renames, starting from the current name", async () => {
    const app = await openGroups([zone("z1", "acme.com")], [group("g1", "Brand A", ["z1"])]);
    try {
      await until(app, (current) => current.includes("Brand A"));
      await press(app, "r");
      const prompt = await until(app, (current) => current.includes("rename to: Brand A"));
      expect(prompt).toContain("rename to: Brand A");

      app.mockInput.pressBackspace();
      await settle(app, 2);
      await typeText(app, "B");
      app.mockInput.pressEnter();

      const frame = await until(app, (current) => current.includes("Renamed to Brand B."));
      expect(frame).toContain("Brand B");
      expect(app.persisted.at(-1)?.map((entry) => entry.name)).toEqual(["Brand B"]);
    } finally {
      await app.dispose();
    }
  });

  test("deleting a group says the zones are not touched, and does not touch them", async () => {
    const app = await openGroups(
      [zone("z1", "acme.com"), zone("z2", "brand-a.com")],
      [group("g1", "Brand A", ["z1", "z2"])],
    );
    try {
      await until(app, (current) => current.includes("Brand A"));
      await press(app, "d");

      const asking = await until(app, (current) => current.includes("Its zones are not touched."));
      expect(asking).toContain("Delete Brand A?");

      await press(app, "y");
      const frame = await until(app, (current) => current.includes("Deleted Brand A."));
      expect(frame).toContain("Its zones were not touched.");
      expect(frame).toContain("Groups · client · 0");
      // The zones are still in the configuration, in full.
      expect(frame).toContain("2 zones in this configuration");
      expect(app.persisted.at(-1)).toEqual([]);
    } finally {
      await app.dispose();
    }
  });
});

describe("membership editor", () => {
  test("enter opens the checkbox list with the current members marked", async () => {
    const app = await openGroups(
      [zone("z1", "acme.com"), zone("z2", "brand-a.com"), zone("z3", "shop.com")],
      [group("g1", "Brand A", ["z1"])],
    );
    try {
      await until(app, (current) => current.includes("Brand A"));
      await enter(app);

      const frame = await until(app, (current) => current.includes("Group · Brand A · 1 of 3 selected"));
      expect(frame).toContain("[x] acme.com");
      expect(frame).toContain("[ ] brand-a.com");
      expect(frame).toContain("[ ] shop.com");
      expect(frame).toContain("space toggle");
    } finally {
      await app.dispose();
    }
  });

  test("space stages a change and a writes it", async () => {
    // The group already holds brand-a.com, so the first row (acme.com) starts
    // unchecked and space adds it.
    const app = await openGroups(
      [zone("z1", "acme.com"), zone("z2", "brand-a.com")],
      [group("g1", "Brand A", ["z2"])],
    );
    try {
      await until(app, (current) => current.includes("Brand A"));
      await enter(app);
      await until(app, (current) => current.includes("1 of 2 selected"));

      await press(app, " ");
      const staged = await until(app, (current) => current.includes("2 of 2 selected"));
      expect(staged).toContain("[x] acme.com");
      expect(staged).toContain("[x] brand-a.com");
      // Staged is not saved: nothing has been written yet.
      expect(app.persisted).toHaveLength(0);

      await press(app, "a");
      const frame = await until(app, (current) => current.includes("Brand A now holds 2 zones."));
      expect(frame).toContain("Groups · client · 1");
      expect([...(app.persisted.at(-1)?.[0]?.zoneIds ?? [])].sort()).toEqual(["z1", "z2"]);
    } finally {
      await app.dispose();
    }
  });

  test("esc discards staged edits, whatever they were", async () => {
    const app = await openGroups(
      [zone("z1", "acme.com"), zone("z2", "brand-a.com")],
      [group("g1", "Brand A", ["z1"])],
    );
    try {
      await until(app, (current) => current.includes("Brand A"));
      await enter(app);
      await until(app, (current) => current.includes("1 of 2 selected"));

      await press(app, " ");
      await until(app, (current) => current.includes("1 change not saved yet"));
      app.mockInput.pressEscape();

      const frame = await until(app, (current) => current.includes("Groups · client · 1"));
      expect(frame).toContain("1 zone");
      expect(frame).not.toContain("change not saved");
      expect(app.persisted).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  test("a zone held by another group says so, because groups are not exclusive", async () => {
    const app = await openGroups(
      [zone("z1", "acme.com")],
      [group("g1", "Brand A", ["z1"]), group("g2", "Brand B", [])],
    );
    try {
      await until(app, (current) => current.includes("Brand B"));
      // The cursor starts on Brand A, so step down to open Brand B.
      await arrow(app, "down");
      await enter(app);

      const frame = await until(app, (current) => current.includes("Group · Brand B"));
      expect(frame).toContain("also in Brand A");
    } finally {
      await app.dispose();
    }
  });

  test("the filter narrows the checkbox list, and clearing it restores it", async () => {
    const app = await openGroups(
      [zone("z1", "acme.com"), zone("z2", "brand-a.com")],
      [group("g1", "Brand A", [])],
    );
    try {
      await until(app, (current) => current.includes("Brand A"));
      await enter(app);
      await until(app, (current) => current.includes("Group · Brand A"));

      await press(app, "/");
      await typeText(app, "brand");
      const filtered = await until(app, (current) => current.includes("[ ] brand-a.com"));
      expect(filtered).not.toContain("acme.com");

      app.mockInput.pressEscape();
      await until(app, (current) => current.includes("[ ] acme.com"));
    } finally {
      await app.dispose();
    }
  });
});

describe("purging a group", () => {
  test("an empty group is refused in its own words, not told it vanished", async () => {
    const app = await openGroups([zone("z1", "acme.com")], [group("g1", "Brand A", [])]);
    try {
      await until(app, (current) => current.includes("Brand A"));
      await press(app, "p");

      const frame = await until(app, (current) => current.includes("That group has no zones in it yet."));
      expect(frame).not.toContain("Purge cache — confirm");
      expect(app.fake.requests).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  test("a group purge names the group and sends only its members", async () => {
    const app = await openGroups(
      [zone("z1", "acme.com"), zone("z2", "brand-a.com"), zone("z3", "shop.com")],
      [group("g1", "Brand A", ["z1", "z3"])],
    );
    try {
      await until(app, (current) => current.includes("Brand A"));
      await press(app, "p");

      const asking = await until(app, (current) => current.includes("Purge cache — confirm"));
      expect(asking).toContain("Brand A");
      expect(asking).toContain("2 zones across 1 account.");
      expect(app.fake.requests).toHaveLength(0);

      await press(app, "y");
      const done = await until(app, (current) => current.includes("Cloudflare accepted 2 of 2 zones."));

      app.mockInput.pressEnter();
      const notice = await until(app, (current) => current.includes("Cloudflare accepted all 2 zones."));
      // The one-line report lands on the group list, which is still a group list.
      expect(notice).toContain("Groups · client · 1");

      const paths = app.fake.requests
        .filter((request) => request.url.includes("purge_cache"))
        .map((request) => new URL(request.url).pathname)
        .sort();
      expect(paths).toEqual([
        "/client/v4/zones/z1/purge_cache",
        "/client/v4/zones/z3/purge_cache",
      ]);
      expect(done).not.toContain("purged");
    } finally {
      await app.dispose();
    }
  });

  test("a stale member is counted on the confirmation and never sent", async () => {
    const app = await openGroups(
      [zone("z1", "acme.com"), zone("z2", "gone.com", STALE)],
      [group("g1", "Brand A", ["z1", "z2"])],
    );
    try {
      await until(app, (current) => current.includes("Brand A"));
      await press(app, "p");

      const asking = await until(app, (current) => current.includes("Purge cache — confirm"));
      expect(asking).toContain("1 zone across 1 account.");
      expect(asking).toContain("1 stale zone will be skipped.");

      await press(app, "y");
      await until(app, (current) => current.includes("Cloudflare accepted 1 of 1 zone."));

      const purges = app.fake.requests.filter((request) => request.url.includes("purge_cache"));
      expect(purges).toHaveLength(1);
      expect(purges[0]!.url).toContain("/zones/z1/purge_cache");
    } finally {
      await app.dispose();
    }
  });
});

describe("leaving the screen", () => {
  test("esc asks the shell to go back", async () => {
    const app = await openGroups([zone("z1", "acme.com")], [group("g1", "Brand A", ["z1"])]);
    try {
      await until(app, (current) => current.includes("Brand A"));
      app.mockInput.pressEscape();
      // A lone Escape is ambiguous with the start of an escape sequence, so the
      // parser waits before reporting it.
      await until(app, () => app.backed.length > 0);
      expect(app.backed).toHaveLength(1);
    } finally {
      await app.dispose();
    }
  });
});
