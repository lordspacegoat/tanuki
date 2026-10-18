# Security

## Where your Cloudflare API token lives

Tanuki stores your token in your operating system's credential store — the macOS
Keychain, libsecret (via `secret-tool`) on Linux, or Windows Credential Manager.
It does **not** write your token into Tanuki's configuration files. Those files
contain zone IDs, groups and preferences only; there are no secrets in them, so
copying or sharing a configuration file does not share a credential.

Where no credential store is available, Tanuki falls back to a passphrase mode:
your token is encrypted with AES-256-GCM under a key derived from your
passphrase using scrypt (N=2^17, r=8, p=1) with a fresh random salt for each
vault. The passphrase is not stored anywhere — not in the vault, not in the
keychain, not in a hint. If you lose it, the token cannot be recovered and must
be re-entered.

The vault is one file per configuration, `vaults/<id>.json` inside Tanuki's
directory. It holds the ciphertext, the salt and the KDF parameters, and nothing
that can be read without the passphrase. The passphrase is masked on screen
(only its length is painted, exactly as the token field is), is never written
down, and is held in memory only for the session in which a vault is opened.

Tanuki asks for the passphrase wherever one is needed: when it opens a vault,
and when it creates one. It cannot check a passphrase without trying it, so a
wrong one is reported and asked for again rather than being treated as a
corrupted vault; `esc` abandons the attempt and changes nothing. Replacing a
token re-seals an existing vault with the passphrase it already had, so changing
a token never silently changes what protects it.

A file encrypted with a key stored beside it is not protection. Tanuki does not
do that, which is why the default is the keychain rather than a file.

**What this does not protect against:** anyone with access to your unlocked
machine, or to your keychain, can use your token. That is true of any locally
stored credential. Use a scoped, least-privilege token, and revoke it from the
Cloudflare dashboard if you believe it has been exposed.

## Token scope

Tanuki needs exactly two permissions:

- `Zone → Zone → Read` — to discover the zones your token can reach
- `Zone → Cache Purge → Purge` — to purge caches

It does not need, and should not be given, account-wide or unrestricted access.
The onboarding flow asks you to scope the token to the zones you operate on.

## What Tanuki never does

- It never prints your token **or your passphrase** to the terminal, a log, a
  crash report or an error message. A single redaction routine is applied at both
  the logging boundary and the error boundary; the passphrase field paints the
  length of what has been typed and nothing else, and has no reveal toggle.
- It never sends your token anywhere except `api.cloudflare.com`.
- It contains **no telemetry, no analytics, no crash reporting and no update
  check**. `api.cloudflare.com` is the only host Tanuki ever contacts.
- It never writes credentials to temporary files or source control.

## Known limitation

On macOS, writing a secret to the Keychain goes through `security
add-generic-password`, which accepts the secret as a command-line argument. It is
therefore briefly visible to a same-user `ps` while the write is in progress.
There is no scriptable stdin path in that tool. The exposure window is
milliseconds, is limited to an account that already has Keychain access, and the
value is never logged. This is documented rather than hidden.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a
public issue.
