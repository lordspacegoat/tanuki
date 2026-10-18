/**
 * One question, asked in a few places: does this key add text to a field, and
 * what text?
 *
 * `sequence` is the authority, not `name`. A terminal reports a capital letter
 * as `name: "b"` with `shift` set, so reading the name turns every typed capital
 * into a lower-case letter — which silently corrupts a typed API token and makes
 * a group called "Brand A" impossible to create. Space is the other trap: it
 * arrives as the name `"space"`, so a naive one-character test drops it too.
 *
 * Control characters are refused whatever their length, and any ctrl/meta chord
 * is a command rather than text.
 */
export interface TextKey {
  name: string;
  /** The bytes the terminal actually sent, when it reports them. */
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/** The text a key contributes, or null when it contributes none. */
export function textOf(key: TextKey): string | null {
  if (key.ctrl || key.meta) return null;

  const sequence = key.sequence;
  if (sequence !== undefined && sequence.length === 1) {
    const code = sequence.codePointAt(0) ?? 0;
    // 0x20 is space; below that is a control character, and 0x7f is delete.
    return code >= 0x20 && code !== 0x7f ? sequence : null;
  }

  if (key.name === "space") return " ";

  // Terminals that report no sequence fall back to the name, which is enough
  // for the printable characters they send that way.
  const name = key.name;
  if ([...name].length !== 1) return null;
  const code = name.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f ? name : null;
}
