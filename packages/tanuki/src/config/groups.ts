/**
 * Group operations (decision D7).
 *
 * Every function here is pure and returns a new array. That is deliberate: the
 * TUI stages edits and commits them on Apply, so treating group state as
 * immutable values makes "Esc cancels" true by construction rather than by
 * remembering to undo.
 */
import { randomUUID } from "node:crypto";
import type { Group } from "./schema.ts";
import { nameKey, validateName } from "./schema.ts";

export class GroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupError";
  }
}

export function createGroup(name: string, existing: readonly Group[], zoneIds: readonly string[] = []): Group {
  const validated = requireValidName(name, existing);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: validated,
    zoneIds: dedupe(zoneIds),
    createdAt: now,
    updatedAt: now,
  };
}

export function renameGroup(groups: readonly Group[], id: string, name: string): Group[] {
  const group = find(groups, id);
  const validated = requireValidName(name, groups, id);
  if (group.name === validated) return [...groups];

  return groups.map((candidate) =>
    candidate.id === id
      ? { ...candidate, name: validated, updatedAt: new Date().toISOString() }
      : candidate,
  );
}

export function deleteGroup(groups: readonly Group[], id: string): Group[] {
  const group = find(groups, id);
  if (!group) throw new GroupError(`no such group: ${id}`);
  // Removing a group never touches zones (decision D7).
  return groups.filter((candidate) => candidate.id !== id);
}

export function addZones(groups: readonly Group[], id: string, zoneIds: readonly string[]): Group[] {
  find(groups, id);
  return groups.map((candidate) =>
    candidate.id === id
      ? { ...candidate, zoneIds: dedupe([...candidate.zoneIds, ...zoneIds]), updatedAt: new Date().toISOString() }
      : candidate,
  );
}

export function removeZones(groups: readonly Group[], id: string, zoneIds: readonly string[]): Group[] {
  find(groups, id);
  const remove = new Set(zoneIds);
  return groups.map((candidate) =>
    candidate.id === id
      ? { ...candidate, zoneIds: candidate.zoneIds.filter((zoneId) => !remove.has(zoneId)), updatedAt: new Date().toISOString() }
      : candidate,
  );
}

/** Replaces a group's membership wholesale — the editor's Apply path. */
export function setMembership(groups: readonly Group[], id: string, zoneIds: readonly string[]): Group[] {
  find(groups, id);
  return groups.map((candidate) =>
    candidate.id === id
      ? { ...candidate, zoneIds: dedupe(zoneIds), updatedAt: new Date().toISOString() }
      : candidate,
  );
}

export function groupById(groups: readonly Group[], id: string): Group | undefined {
  return groups.find((group) => group.id === id);
}

/** Groups holding a given zone. Plural by design — multi-membership is the model. */
export function groupsForZone(groups: readonly Group[], zoneId: string): Group[] {
  return groups.filter((group) => group.zoneIds.includes(zoneId));
}

/** Used to drop zone IDs that no longer exist, without deleting a group. */
export function pruneZoneIds(groups: readonly Group[], knownZoneIds: ReadonlySet<string>): Group[] {
  return groups.map((group) => {
    const zoneIds = group.zoneIds.filter((zoneId) => knownZoneIds.has(zoneId));
    return zoneIds.length === group.zoneIds.length ? group : { ...group, zoneIds, updatedAt: new Date().toISOString() };
  });
}

export interface GroupStats {
  total: number;
  groupCount: number;
  ungrouped: number;
}

/**
 * Decision U3/§15: the group summary. "Ungrouped" counts zones that belong to
 * no group at all — a zone in two groups is grouped, not double-counted.
 */
export function summarise(zones: readonly string[], groups: readonly Group[]): GroupStats {
  const grouped = new Set(groups.flatMap((group) => group.zoneIds));
  return {
    total: zones.length,
    groupCount: groups.length,
    ungrouped: zones.filter((zoneId) => !grouped.has(zoneId)).length,
  };
}

/** Count of *existing* zones in a group — stale members are excluded. */
export function memberCount(group: Group, knownZoneIds: ReadonlySet<string>): number {
  return group.zoneIds.filter((zoneId) => knownZoneIds.has(zoneId)).length;
}

/** Group names mentioned by a zone, for the editor's `+Brand A` annotation. */
export function membershipLabels(groups: readonly Group[], zoneId: string, exceptGroupId?: string): string[] {
  return groups
    .filter((group) => group.id !== exceptGroupId && group.zoneIds.includes(zoneId))
    .map((group) => group.name);
}

function find(groups: readonly Group[], id: string): Group {
  const group = groups.find((candidate) => candidate.id === id);
  if (!group) throw new GroupError(`no such group: ${id}`);
  return group;
}

function requireValidName(name: string, groups: readonly Group[], exceptId?: string): string {
  const result = validateName(name, "group name");
  if (!result.ok) throw new GroupError(result.reason);

  const key = nameKey(result.name);
  const clash = groups.some((group) => group.id !== exceptId && nameKey(group.name) === key);
  if (clash) throw new GroupError(`a group called "${result.name}" already exists`);

  return result.name;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
