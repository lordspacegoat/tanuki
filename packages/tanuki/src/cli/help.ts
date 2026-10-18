export const USAGE = `tanuki — Cloudflare cache management

USAGE
  tanuki                  Open the configuration selector, or onboarding on first run
  tanuki --config <name>  Open a named configuration directly
  tanuki --help           Show this help
  tanuki --version        Show the version

OPTIONS
  -c, --config <name>     Select a named configuration
  -h, --help              Show this help
  -V, --version           Show the version

CONFIGURATIONS
  A configuration holds its own Cloudflare API token, discovered zones, groups
  and preferences. Zone IDs are the stable identifiers; renaming a configuration
  never moves or orphans its stored credential.

  If --config names a configuration that does not exist, Tanuki says so and
  offers to create it. It never silently falls back to another configuration.

SCOPE
  Purging is always zone-level and always scoped to the active configuration.
  A group purge never means "every zone in the account", and an all-zone purge
  never reaches another configuration.

CREDENTIALS
  Your API token is kept in your operating system's credential store, not in
  Tanuki's configuration files. Onboarding explains the mechanism it detected;
  read SECURITY.md for the full account.
`;

/** Printed when stdout is not a TTY. Escape codes must not go into a pipe. */
export const NOT_A_TTY = `tanuki is an interactive terminal application, but stdout is not a terminal.

Run it directly in a terminal, or see the options above.

If you were looking for a non-interactive mode for scripting: there isn't one
yet. It is deliberately out of scope for this release.
`;

export function versionLine(version: string): string {
  return `tanuki ${version}\n`;
}
