/**
 * Entry point (decisions F5, U9, U11).
 *
 * Order matters: `--help` and `--version` print and exit *before* anything
 * touches the renderer, and a non-TTY stdout is refused rather than filled with
 * escape codes.
 */
import { parseArguments } from "./cli/arguments.ts";
import { NOT_A_TTY, USAGE, versionLine } from "./cli/help.ts";
import { VERSION } from "./version.ts";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isTTY: boolean;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const command = parseArguments(argv);

  switch (command.kind) {
    case "help":
      io.stdout(USAGE);
      return 0;

    case "version":
      io.stdout(versionLine(VERSION));
      return 0;

    case "error":
      io.stderr(`tanuki: ${command.message}\n\nRun \`tanuki --help\` for usage.\n`);
      return 2;

    case "run": {
      if (!io.isTTY) {
        io.stdout(NOT_A_TTY);
        return 1;
      }

      // Imported lazily so that `--help`, `--version` and the non-TTY path
      // never load the renderer or the native library.
      const { launch } = await import("./tui/app.tsx");
      return launch({ config: command.config });
    }
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isTTY: Boolean(process.stdout.isTTY),
  });
  process.exit(code);
}
