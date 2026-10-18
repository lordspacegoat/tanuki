/**
 * CLI argument parsing (decision F5, U9, U11).
 *
 * Hand-rolled rather than commander, for two reasons: `--help` and `--version`
 * must print and exit *before* the renderer takes over the terminal, and the
 * compiled binary stays lean.
 *
 * The surface is exactly what the spec lists:
 *   tanuki
 *   tanuki --config client
 *   tanuki -c client
 *   tanuki --help
 *   tanuki --version
 */

export type CliCommand =
  | { kind: "run"; config: string | null }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export function parseArguments(argv: readonly string[]): CliCommand {
  let config: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--") {
      const rest = argv.slice(i + 1);
      if (rest.length > 0) {
        return { kind: "error", message: `unexpected argument: ${rest[0]}` };
      }
      break;
    }

    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }

    if (arg === "--version" || arg === "-V") {
      return { kind: "version" };
    }

    if (arg === "--config" || arg === "-c") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { kind: "error", message: `${arg} requires a configuration name` };
      }
      const parsed = parseConfigValue(value, arg);
      if (typeof parsed !== "string") return parsed;
      config = parsed;
      i++;
      continue;
    }

    if (arg.startsWith("--config=")) {
      const parsed = parseConfigValue(arg.slice("--config=".length), "--config");
      if (typeof parsed !== "string") return parsed;
      config = parsed;
      continue;
    }

    if (arg.startsWith("-") && arg !== "-") {
      return { kind: "error", message: `unknown option: ${arg}` };
    }

    return { kind: "error", message: `unexpected argument: ${arg}` };
  }

  return { kind: "run", config };
}

/**
 * Returns the trimmed name, or a CliCommand error. The name is not validated
 * against the naming rules here — that happens where the configuration is
 * actually created or resolved, so that `--config` can produce a
 * "no such configuration" error rather than a "bad name" error.
 */
function parseConfigValue(value: string, flag: string): string | CliCommand {
  const name = value.trim();
  if (name.length === 0) {
    return { kind: "error", message: `${flag} requires a configuration name` };
  }
  return name;
}
