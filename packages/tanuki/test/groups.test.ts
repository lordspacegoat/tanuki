import { describe, expect, test } from "bun:test";
import {
  addZones,
  createGroup,
  deleteGroup,
  groupsForZone,
  memberCount,
  membershipLabels,
  pruneZoneIds,
  removeZones,
  renameGroup,
  setMembership,
  summarise,
} from "../src/config/groups.ts";

const zones = ["z1", "z2", "z3", "z4"];

describe("group operations", () => {
  test("creates a group with a generated id, not a name-derived one", () => {
    const group = createGroup("EU Sites", []);
    expect(group.name).toBe("EU Sites");
    expect(group.id.length).toBeGreaterThan(10);
    expect(group.id).not.toContain("EU");
  });

  test("dedupes members on creation", () => {
    const group = createGroup("EU Sites", [], ["z1", "z1", "z2"]);
    expect(group.zoneIds).toEqual(["z1", "z2"]);
  });

  test("rejects duplicate names case-insensitively", () => {
    const groups = [createGroup("EU Sites", [])];
    expect(() => createGroup("eu sites", groups)).toThrow(/already exists/);
  });

  test("trims names and rejects empty or control characters", () => {
    expect(createGroup("  Brand A  ", []).name).toBe("Brand A");
    expect(() => createGroup("   ", [])).toThrow(/cannot be empty/);
    expect(() => createGroup("bad\u0007name", [])).toThrow(/control characters/);
  });

  test("renaming keeps the id, so membership and references survive", () => {
    const original = createGroup("EU Sites", [], ["z1"]);
    const renamed = renameGroup([original], original.id, "Europe")[0]!;
    expect(renamed.id).toBe(original.id);
    expect(renamed.name).toBe("Europe");
    expect(renamed.zoneIds).toEqual(["z1"]);
  });

  test("renaming to its own name is a no-op, not a duplicate error", () => {
    const group = createGroup("EU Sites", []);
    expect(() => renameGroup([group], group.id, "EU Sites")).not.toThrow();
  });

  test("deleting a group never deletes zones", () => {
    const groups = [createGroup("EU Sites", [], ["z1", "z2"])];
    expect(deleteGroup(groups, groups[0]!.id)).toEqual([]);
    expect(zones).toEqual(["z1", "z2", "z3", "z4"]);
  });

  test("a zone can belong to several groups at once", () => {
    const first = createGroup("EU Sites", [], ["z1"]);
    const second = createGroup("Brand A", [first], ["z1", "z2"]);
    const groups = [first, second];

    expect(groupsForZone(groups, "z1").map((group) => group.name)).toEqual(["EU Sites", "Brand A"]);
    expect(membershipLabels(groups, "z1", second.id)).toEqual(["EU Sites"]);
  });

  test("add and remove are additive and non-destructive", () => {
    const group = createGroup("EU Sites", [], ["z1"]);
    const added = addZones([group], group.id, ["z2", "z1"])[0]!;
    expect(added.zoneIds).toEqual(["z1", "z2"]);

    const removed = removeZones([added], group.id, ["z1"])[0]!;
    expect(removed.zoneIds).toEqual(["z2"]);
  });

  test("setMembership replaces wholesale and dedupes", () => {
    const group = createGroup("EU Sites", [], ["z1", "z2"]);
    const updated = setMembership([group], group.id, ["z3", "z3", "z4"])[0]!;
    expect(updated.zoneIds).toEqual(["z3", "z4"]);
  });

  test("pruning drops vanished zone ids without deleting the group", () => {
    const group = createGroup("EU Sites", [], ["z1", "gone"]);
    const pruned = pruneZoneIds([group], new Set(["z1"]))[0]!;
    expect(pruned.id).toBe(group.id);
    expect(pruned.zoneIds).toEqual(["z1"]);
    expect(pruned.name).toBe("EU Sites");
  });

  test("member counts ignore stale ids", () => {
    const group = createGroup("EU Sites", [], ["z1", "gone"]);
    expect(memberCount(group, new Set(["z1"]))).toBe(1);
  });

  test("summary counts a zone in two groups once", () => {
    const first = createGroup("EU Sites", [], ["z1", "z2"]);
    const second = createGroup("Brand A", [first], ["z1"]);
    expect(summarise(["z1", "z2", "z3"], [first, second])).toEqual({
      total: 3,
      groupCount: 2,
      ungrouped: 1,
    });
  });

  test("operations do not mutate their input", () => {
    const group = createGroup("EU Sites", [], ["z1"]);
    const before = JSON.stringify(group);
    addZones([group], group.id, ["z2"]);
    expect(JSON.stringify(group)).toBe(before);
  });
});
