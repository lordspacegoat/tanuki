# Tanuki

A terminal UI for managing Cloudflare API credentials, grouping zones, and
purging caches quickly and safely.

```sh
npm install -g @spacegoat/tanuki
tanuki
```

> **Naming.** The npm name `tanuki` is held by an unrelated package, so the
> install string is scoped. The command is still `tanuki`.

- [Install](#install)
- [First run](#first-run)
- [Using Tanuki](#using-tanuki)
- [Keyboard reference](#keyboard-reference)
- [Security](#security)
- [Where your files live](#where-your-files-live)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Licence](#licence)

## Install

Requires Node 18 or newer. There is no build step and no Bun requirement for
anyone installing the published package:

```sh
npm install -g @spacegoat/tanuki
tanuki
```

Prebuilt binaries are published for macOS (arm64, x64) and Linux (x64, arm64,
glibc and musl). Windows x64 is published on a best-effort basis.

```sh
tanuki                 # open the configuration selector
tanuki --config acme   # open a named configuration directly
tanuki --help          # command-line help
tanuki --version       # print the version
```

Tanuki is an interactive terminal application. It refuses to run when stdout is
not a terminal rather than filling a pipe with escape codes — there is no
non-interactive mode yet, and that is deliberate for this release.

## First run

The first run has no configuration to open, so Tanuki walks you through two
steps.

**1. How your token is stored.** Tanuki keeps your Cloudflare API token in your
operating system's credential store — the macOS Keychain, libsecret on Linux, or
Windows Credential Manager. It tells you which mechanism it actually detected,
so the explanation cannot drift from what happens.

Where no system store exists — or where you would rather not touch it — press
`p` to protect the token with a passphrase instead. The passphrase is asked for
twice when you set it, masked as you type, and stored nowhere: not in the file,
not in the keychain, not in a hint. It is asked for again the next time Tanuki
opens the vault — once per session, then held in memory for that session only.
Tanuki cannot tell a wrong passphrase from a right one until it tries, so a
failed attempt is reported and the prompt is offered again. `SECURITY.md`
describes the mechanism exactly.

**2. Paste the token.** The field is masked and stays masked. Nothing is written
to disk before Cloudflare confirms the token, so a rejected token leaves no
trace. `enter` verifies the token, then discovers every zone it can reach.

Create the token with exactly two permissions:

| Permission | Why |
|---|---|
| `Zone → Zone → Read` | to discover the zones your token can reach |
| `Zone → Cache Purge → Purge` | to clear caches |

Scope the token to the zones you actually operate on. Tanuki does not need, and
should not be given, account-wide access.

## Using Tanuki

### Configurations

A configuration is one named client, project or environment: its own token, its
own discovered zones, its own groups and preferences. A configuration file holds
no secrets, so copying or sharing one does not share a credential.

Running `tanuki` with no arguments opens the selector; `tanuki --config <name>`
opens one directly. If `--config` names something that does not exist, Tanuki
says so and offers to create it — it never silently falls back to a different
configuration.

The selector is where every configuration is looked after. **`r`** renames one
(the display name only — the file and the credential key are its ID, so a rename
can never orphan a token), **`t`** replaces its token, and **`d`** deletes it.

Deleting a configuration is the one irreversible action in Tanuki, so it asks
first and says what goes: its file, its zone list, its groups and its stored
token. Deleting the last one returns to onboarding. Zones on Cloudflare are not
touched — deleting a configuration forgets them here, it does not delete them
there.

Replacing a token is not a delete-then-create. The new token is verified with
Cloudflare first, and only then is the old one replaced, so a mistyped token
cannot leave you without a working one. When it is replaced, the zone list is
re-read: a token with different permissions can see a different set of zones.
In passphrase mode the vault keeps the passphrase it already had: replacing a
token never asks you to choose a new one, so it cannot silently change what
protects the token.

### Zones

The explorer lists every zone the active configuration knows about, by domain
**and** by ID, because the ID is the stable identifier: a zone can be renamed
without becoming a different zone.

`/` searches as you type, matching domains and zone IDs, and highlights what
matched. `esc` clears the filter and puts the cursor back on the zone you had
selected rather than on whatever now sits at that row.

`r` re-reads the zone list from Cloudflare. Zones that disappear are **not**
deleted — they are kept, marked stale, and left out of every purge with the
reason stated. That is deliberate: a zone missing from the list could have been
deleted, or could simply be outside this token's scope, and guessing between
those two would be worse than keeping it.

**`x`** ignores the highlighted zone, after a confirmation that says the zone
stays on Cloudflare and only its cache is spared. An ignored zone is hidden from
the list by default, never sent a purge request, and counted separately from
stale ones in the panel title; **`i`** shows ignored zones so they can be
un-ignored. Ignoring is how you take a live zone out of an all-zone purge without
pretending it no longer exists.

The detail pane remembers the last purge: when it was, whether Cloudflare
accepted it, and the **purge id** Cloudflare returned. That identifier is the
evidence that the request landed, so it is kept rather than summarised away.
**`t`** replaces the token for the open configuration, without going back to the
selector.

### Purging

Purging is always zone-level and always scoped to the active configuration. A
group purge never means "every zone in the account", and an all-zone purge never
reaches another configuration.

- **`p`** purges the highlighted zone, confirming inline.
- **`a`** purges every zone in the active configuration.

A multi-zone purge asks first, naming the counted scope: how many zones, across
how many accounts, which plan sets the pace, and whether the whole thing fits
inside the account's burst limit or has to be paced out over time. Then it shows
live progress.

Cloudflare's purge limit is per **account** and shared across that account's
zones — as low as 5 requests per minute on Free, with a burst of 25. Tanuki
paces requests to the slowest plan in each account and runs accounts in
parallel, so a 20-zone purge on Free goes out at once instead of trickling, and
a 500-zone purge does not fail halfway through.

While a purge is running, `q` asks whether to stop. Stopping halts new requests;
requests already accepted by Cloudflare cannot be recalled, and Tanuki says so
rather than implying a rollback. When the run finishes, `r` retries **only** what
failed — a success is never re-sent.

Starting a purge also sends a small tanuki across the header. It is decoration,
but it is honest decoration: it runs exactly while a run is happening, and the
header keeps its shape while it does.

A result of *accepted* means Cloudflare acknowledged the request. It is not a
claim that the cache is already empty everywhere; edge eviction is Cloudflare's
side of the bargain. Each accepted zone is reported with the purge id Cloudflare
returned for it, and the round trip that took.

### Groups

Groups are named sets of zones, and a zone can belong to more than one. `g` from
the zone list opens them.

- **`enter`** opens the highlighted group's membership: a checkbox list of every
  zone, filtered as you type, with each row showing the other groups that already
  hold it. **`space`** toggles, **`a`** applies, **`esc`** discards — nothing is
  written until you apply, so leaving is always safe.
- **`n`** creates a group, **`r`** renames the highlighted one, **`d`** deletes
  it. Deleting a group never touches a zone.
- **`p`** purges the highlighted group. It goes through the same confirmation as
  an all-zone purge, naming the group and counting its zones.

The zone count on a row is what a purge would actually reach: a member whose zone
has gone stale is still in the group and still listed, but it is not counted,
because a purge will skip it. That is the same number the confirmation shows.

## Keyboard reference

| Screen | Keys |
|---|---|
| Zones | `↑`/`↓` or `j`/`k` move · `/` search · `enter` keep filter · `esc` clear filter · `tab` toggle detail pane · `p` purge this zone · `a` purge every zone · `x` ignore this zone · `i` show ignored · `t` replace token · `g` groups · `r` refresh · `q` quit |
| Groups | `↑`/`↓` or `j`/`k` move · `/` search · `enter` edit zones · `n` new · `r` rename · `d` delete · `p` purge group · `esc` or `q` back to zones |
| Group membership | `↑`/`↓` or `j`/`k` move · `space` toggle · `/` filter · `a` apply · `esc` discard |
| Purge confirmation | `y` purge · `n` or `esc` cancel |
| Purge progress | `q` ask to stop · `y` stop · `n` keep going |
| Purge result | `r` retry what failed · `enter` done |
| Configuration selector | `↑`/`↓` move · `enter` open · `n` new · `r` rename · `t` replace token · `d` delete · `q` quit |
| Onboarding | `enter` continue · `p` use a passphrase instead · `b` back |
| Passphrase prompt | type · `enter` next or unlock · `tab` switch field · `esc` cancel |
| Token entry | paste · `enter` check with Cloudflare · `esc` cancel |

The footer always carries the keys for the screen you are on, and it never
advertises a key that would do something else. On the groups screen `q` goes back
to the zones rather than quitting, and the footer says `q back` there. Where a
terminal is too narrow for the full line, the hint is a shorter sentence rather
than a truncated one — so `q quit` is always readable.

## Security

Your token lives in your operating system's credential store — or, if you chose
passphrase mode, in a file encrypted with AES-256-GCM under a key derived from a
passphrase that is stored nowhere. Never in Tanuki's configuration files. Tanuki
never prints your token *or your passphrase* to the terminal, a log, a crash
report or an error message, and never sends your token anywhere except
`api.cloudflare.com`. There is no telemetry, no analytics, no crash reporting
and no update check.

Read [SECURITY.md](./SECURITY.md) for exactly what is protected, what is not,
the token permissions Tanuki needs, and the one known limitation of the macOS
Keychain write path.

## Where your files live

| Platform | Location |
|---|---|
| macOS | `~/Library/Application Support/tanuki` |
| Linux | `$XDG_CONFIG_HOME/tanuki`, or `~/.config/tanuki` |
| Windows | `%APPDATA%\tanuki` |

Set `TANUKI_HOME` to put that tree somewhere else entirely. The directory holds
`config.json` (the configuration list and active selection) and one
`configs/<id>.json` per configuration — zone IDs, groups and preferences, with
no secrets in either. In passphrase mode, one encrypted `vaults/<id>.json` per
configuration is added; it holds the ciphertext, its salt and its KDF
parameters, and nothing that can be read without the passphrase.

## Troubleshooting

**"Cloudflare rejected this token."** The token is wrong, revoked, or lacks the
permissions above. Tanuki reports the status Cloudflare gives; check the token in
the Cloudflare dashboard and confirm both permissions are present.

**"Credentials unavailable."** The configuration exists but its token is not in
the credential store — most often because the entry was removed outside Tanuki.
Nothing has been deleted or changed; re-enter the token to use that
configuration again.

**"That passphrase did not unlock this vault."** The passphrase is not the one
the vault was sealed with. Tanuki asks again, and says so rather than silently
repeating the question. `esc` abandons the attempt: nothing is read, written or
changed, and you are returned to the list. A forgotten passphrase cannot be
recovered — the vault has to be replaced by re-entering the token.

**A big purge is slow.** That is Cloudflare's per-account limit, not Tanuki
waiting unnecessarily. The confirmation screen tells you the expected wait before
anything is sent, and the plan that sets the pace.

**A zone is marked stale.** It stopped appearing in the token's zone list.
Press `r` to re-check. Tanuki keeps stale zones visible and refuses to purge
them, because it cannot tell a deleted zone from one outside the token's scope.

**A zone is marked ignored.** You asked Tanuki to leave it alone with `x`, so it
is left out of every purge. Press `i` to show ignored zones, then `x` on it to
put it back.

**"Terminal too small."** Tanuki needs at least 40 columns by 14 rows. Below
that it says so rather than drawing something unreadable.

**"stdout is not a terminal."** Tanuki is interactive only. Piping it, or
running it from a script, gets this message instead of a broken terminal.

## Contributing

### Prerequisites

[Bun](https://bun.sh) for tests and builds (`brew install bun`). Node 26.4 or
newer can also run the source directly, since OpenTUI is FFI over a native core:

```sh
node --experimental-ffi src/index.ts --help
```

Published users need neither: the shipped artifact is a compiled binary that
embeds Bun, behind a dependency-free Node shim.

### Commands

```sh
bun install
bun test              # unit and interface tests
bun run typecheck     # tsc --noEmit, the package and the build script
bun run dev           # run from source
bun run build         # compile this machine's binary to packages/tanuki/dist/tanuki
bun run build:packages  # compile every platform binary into its package (all seven)
```

### Layout

```
packages/tanuki/
  bin/tanuki.js       Node shim: resolves the platform package and spawns it
  src/
    cli/              argument parsing, help text, the non-TTY refusal
    config/           paths, schema, migrations, storage, manager, groups
    secrets/          credential stores, crypto, and the runtime explanation
    cloudflare/       client, errors, plan tiers, rate limiting, zone discovery
    services/         connect flow, purge orchestrator, purge scope, redaction
    tui/              theme, list rules, key handling, masked field, components,
                      screens, app
  test/               fake transport, render harness, unit and interface tests
packages/tanuki-<os>-<arch>[-musl]/
  package.json        a published package: declares os, cpu and (for musl) libc,
                      so npm installs exactly one of them on any machine
  bin/tanuki          the compiled binary it serves — built, never committed
```

`scripts/build-platform.ts` writes those binaries and knows which Bun target and
which OpenTUI native library each one needs; `.github/workflows/release.yml` runs
it once per platform. The shim, the build script and the manifests are kept in
step by tests, not by each other.

The layers point one way: `tui` depends on `services`, which depends on
`config` and `cloudflare`. Nothing in `services` or `cloudflare` imports from
`tui`, so the rules stay testable without a renderer.

### Testing

Every test runs against a faked transport (`test/fake-cloudflare.ts`). No test
can reach the network or clear a real cache, and none uses a real credential —
that is a hard rule, not a convention.

- Pure rules — list windows, scope resolution, pacing, plan detection — are
  tested directly, without a renderer.
- Interface tests drive a **real** renderer and assert on painted text
  (`test/render.test.tsx`, `test/purge-flow.test.tsx`,
  `test/passphrase-prompt.test.tsx`), with shared frame helpers in
  `test/frame.ts`. Those helpers pump frames *and* yield to the event loop,
  because the renderer's own `waitForFrame` cannot see asynchronous work. The
  passphrase tests drive the real credential store over a temporary directory,
  so the vault they unlock is a real vault.

### Conventions worth knowing

- A successful purge is reported as **accepted**, never "purged" — Cloudflare
  acknowledging a request is not the cache being gone.
- The token never reaches the screen, a log or an error message; a single
  redaction routine guards both boundaries. A passphrase is masked the same way
  — only its length is ever painted.
- A screen owns the keys it handles, so a key is never handled twice. A
  passphrase prompt *replaces* the screen it interrupted rather than floating
  over it, because the renderer delivers every keypress to every registered
  handler: an overlay would let `q` quit while the user was typing a passphrase.
- Text entry reads a key's **sequence**, never its name: a terminal reports a
  capital letter as a lower-case name plus shift, so inserting the name would
  silently lower-case typed text. See `tui/keys.ts`.
- In interface tests, `press(app, "enter")` types the letters e-n-t-e-r. Use
  `app.mockInput.pressEnter()`. A lone escape is ambiguous with an escape
  sequence, so `pressEscape()` needs a pumped frame before it registers.
- Decisions and their rationale are recorded in an internal decision record.
  The rules that matter for the code are restated where they are enforced, and
  the ones that matter for users are in this file and in `SECURITY.md`.

### Releasing

A release is a tag. `v1.2.3` must equal the `version` in
`packages/tanuki/package.json` (and `src/version.ts` — a test keeps those two in
step), and the tag starts a workflow that:

1. asks `scripts/build-platform.ts` which targets exist, and builds one per
   runner — macOS targets on macOS, because a darwin binary carries the
   linker-signed ad-hoc signature macOS arm64 needs to execute it;
2. runs each binary it can, and checks the version string it prints;
3. publishes the seven platform packages, then the shim.

`NPM_TOKEN` must be set in the repository's Actions secrets; without it the
workflow still builds and warns that it published nothing. Publishing is
skipped for a package whose version is already on npm, so a re-run after a
partial failure finishes the job instead of needing a version bump.

The first publish of a version, and any re-run, has no new tag to push, so the
workflow also takes a manual dispatch with **publish** ticked.

Nothing needs committing to release: the binaries are built in CI, and the
platform manifests are already in the repository with an empty `bin/`. To see
what a package would contain:

```sh
bun run build:packages                    # or: bun run scripts/build-platform.ts --target linux-x64
cd packages/tanuki-linux-x64 && npm pack --dry-run
```

That build fetches the OpenTUI native library for each target from npm, and
fails rather than shipping a binary whose native library is missing — a check
that matters most for the targets that cannot be executed on the machine that
built them. The Bun version in the workflow is pinned because it decides the
runtime embedded in every binary, and `test/platform-packages.test.ts` keeps the
shim, the target list and the platform manifests in agreement.

## Licence

MIT
