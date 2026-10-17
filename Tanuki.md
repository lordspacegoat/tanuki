Tanuki — Cloudflare Cache Management TUI
1. Project Overview

Build Tanuki, a slick, visually impressive terminal UI (TUI) for managing Cloudflare API credentials, organising websites into groups, and invalidating Cloudflare caches quickly and safely.

Tanuki should feel like a premium developer tool: fast, intuitive, colourful, polished, and enjoyable to use. It should make invalidating a single website's cache or clearing caches across dozens of websites feel effortless.

The application must be built using OpenTUI and distributed as an npm package, ideally installable globally with:

npm install -g tanuki


The primary command should be:

tanuki


The application must work interactively in a terminal, support keyboard navigation throughout, and prioritise speed and usability over unnecessary complexity.

2. Core Principles
Fast cache invalidation: Clearing a cache should take as few interactions as possible.
Multiple configurations: Users can manage different Cloudflare accounts, clients, projects, or environments independently.
Domain grouping: Users can organise accessible Cloudflare zones into meaningful groups.
Security by default: API tokens and sensitive configuration data must be encrypted locally.
Clear feedback: Every operation should show its progress, outcome, and any failures.
Premium terminal design: Use rich colours, gradients where supported, borders, columns, animation, and subtle visual effects.
Safe operations: Make it clear which zones will be affected before invalidating multiple caches.
3. Technology and Architecture

Use the following technologies where appropriate:

TypeScript for the application.
OpenTUI for the interactive terminal interface.
The official Cloudflare API for zone discovery and cache invalidation.
A secure local configuration and encrypted credential storage system.
npm for distribution and installation.

Keep the architecture modular. Separate terminal rendering, navigation, configuration management, encryption, Cloudflare API interactions, grouping logic, and cache invalidation into distinct modules.

Use the current, supported OpenTUI APIs rather than inventing component APIs. Check the library documentation and package requirements before implementation.

4. Command-Line Interface

Support the following commands and options:

tanuki
tanuki --config client
tanuki -c client
tanuki --help
tanuki --version


The --config or -c flag selects a named configuration.

For example:

tanuki --config client


This should immediately load the configuration named client, decrypt its credentials when needed, validate that it is usable, and open the main interface.

If the requested configuration does not exist, display a helpful error and offer to create it or return to the configuration selector. Do not silently fall back to another configuration.

If no configuration flag is supplied:

If saved configurations exist, display a configuration selector.
Allow the user to select a configuration or create a new one.
If no configurations exist, launch the onboarding and configuration creation flow automatically.

Provide clear terminal help and actionable error messages.

5. First-Run Experience and Security Onboarding

The first launch should introduce Tanuki and explain its purpose in a polished welcome screen.

Explain that Tanuki stores configuration data locally and encrypts sensitive credentials at rest. The application must not imply that API keys are safe merely because they are stored in a local file.

Before asking for an API token, clearly explain:

Why Tanuki needs a Cloudflare API token.
That the token is used to discover accessible zones and perform cache invalidation.
That the token remains on the local machine and is not intentionally sent to any third-party service.
That requests containing the token are sent to Cloudflare for authentication.
How credentials are encrypted and what protects the encryption key.
That anyone able to access the decrypted credentials or the required encryption secrets may be able to use the token.

Use a secure encryption design. Prefer authenticated encryption such as AES-256-GCM or an appropriate operating-system credential store. Do not hardcode encryption keys, store the encryption key beside the encrypted credentials without additional protection, or rely on simple Base64 encoding.

Prefer OS-backed credential storage where supported. If a portable encrypted-file approach is used, derive a key using a suitable password-based key derivation function, such as scrypt or Argon2id, with a unique salt and appropriate parameters. Never store the password alongside the ciphertext.

The onboarding flow should explain any password or unlock requirement before collecting credentials. Never print tokens to the terminal, logs, crash reports, or error messages.

6. Creating a Configuration

When the user chooses to create a configuration, guide them through a simple wizard.

Step 1: Configuration name

Ask for a friendly name, for example:

client
production
agency
staging

Validate the name and prevent accidental overwriting of existing configurations.

Step 2: Cloudflare API token

Ask the user to paste their Cloudflare API token using a masked or otherwise protected input.

Explain that the token must have the necessary permissions to list accessible zones and invalidate their caches. Follow the principle of least privilege; do not ask for unrestricted account access.

Use Cloudflare's API to validate the token and retrieve the zones it can access.

Step 3: Discover zones

Retrieve all accessible zones, including their zone IDs and domain names. Handle pagination so that large accounts are not silently truncated.

Present the discovered zones in a readable table or list, with columns such as:

Domain
Zone ID
Status, if available

Do not assume that the token can access every zone in the Cloudflare account. Only show zones the token can actually access.

If discovery fails, explain the cause where possible and allow the user to retry, edit the token, or cancel.

Step 4: Save securely

Encrypt and persist the configuration locally. Confirm that it has been saved without exposing the API token.

Step 5: Organise domains

After discovery, let the user create groups and assign domains to them. They should be able to skip this step and organise their zones later.

7. Configuration and Data Model

Each named configuration should contain its own Cloudflare credentials, discovered zones, groups, and preferences.

A configuration conceptually contains:

A unique configuration name.
An encrypted API token or reference to a secure credential store.
The discovered Cloudflare zones and their IDs.
User-created groups and group memberships.
Optional interface preferences.

A group should have a friendly name and a collection of zone IDs. Use zone IDs as the stable identifiers rather than relying exclusively on domain names.

Store configuration files in an appropriate user-specific application directory for the operating system. Apply restrictive file permissions where supported.

Do not save credentials in plaintext in configuration files, backups, debug output, or temporary files. Never include the token in source control.

Refreshing a configuration should update zone metadata without unnecessarily destroying existing group assignments. If a zone becomes inaccessible or is removed, flag the issue and let the user resolve it.

8. Main Terminal Interface

The main screen should be the centre of the application and should immediately communicate that Tanuki is a premium developer tool.

Use OpenTUI to build a responsive terminal layout that adapts to the available terminal width and height.

Visual direction

The aesthetic should be candy-coloured, glossy, neon, and polished, without sacrificing readability.

Consider:

Deep midnight or near-black backgrounds.
Electric magenta, violet, cyan, and bright pink accents.
A signature Tanuki logo or stylised ASCII-art mascot.
Gradient-like colour transitions where terminal capabilities allow.
Crisp borders and carefully aligned columns.
Small status indicators, icons, and visual progress indicators.
Smooth but restrained transitions and animations.
A consistent spacing and typography system.

Use ANSI true colour when supported and gracefully degrade on terminals with limited colour capabilities. Do not rely on graphics that require a specific terminal emulator.

The result should look intentional and cohesive, not like a generic terminal menu with random bright colours.

Suggested layout

Use a two-column layout on sufficiently wide terminals.

Left column — Zone explorer

Display a navigable, hierarchical list:

TANUKI
Cloudflare Cache Manager

▼ Groups
  ▸ EU Sites
  ▸ Brand A
  ▸ Production

▼ Ungrouped Zones
  ▸ example.com
  ▸ example.co.uk
  ▸ example.net


Group headings are parents, and their domains are children. Expanding a group reveals its member domains. Ungrouped zones remain accessible in a separate section.

Right column — Action and details panel

Show the selected zone or group, relevant metadata, and available operations.

For example:

SELECTED: EU SITES

Zones: 6
Provider: Cloudflare

ACTIONS
  > Purge cache
    View zones
    Edit group
    Refresh zone data


Use the available space to show operation status, recent actions, and contextual help without overwhelming the interface.

On narrower terminals, collapse to a single-column layout.

9. Keyboard Navigation

The application must be keyboard-first.

Suggested conventions:

↑ / ↓: Move through selectable items.
← / →: Collapse or expand groups, or navigate supported panels.
Enter: Select an item or open its actions.
Space: Toggle selection in multi-select lists.
/: Search and filter domains and groups.
g: Open group management.
r: Refresh zone data.
?: Show keyboard shortcuts and help.
Esc: Go back or dismiss a dialog.
q: Quit, with appropriate handling if an operation is running.

Show relevant keyboard hints in the footer. Avoid assigning shortcuts that conflict with standard text input behaviour, and make the active selection visually obvious.

10. Group Management

Users must be able to create, rename, edit, and delete groups.

Example groups might include:

EU Sites
Brand A
Customer Websites
Production
Staging
Marketing Sites

A group can contain multiple zones. A zone may belong to multiple groups, allowing users to organise their sites in different ways.

The interface should make group management straightforward:

Select Create group.
Enter a group name.
Select domains using a navigable multi-select list.
Confirm and save.

Also support editing existing memberships, moving between groups, and removing zones from groups without deleting the underlying Cloudflare zone.

Group membership changes must be saved persistently and remain available after restarting Tanuki.

11. The Primary Action: Cache Invalidation

Cache invalidation is the most important feature in Tanuki. Make it easy to perform, prominent in the interface, and reliable.

The user must be able to invalidate the cache for:

One zone: Purge an individual domain's cache.
One group: Purge the caches of every zone in a selected group.
All zones: Purge the caches of every accessible zone in the active configuration.

The user should be able to initiate these actions from the zone explorer or a dedicated action menu.

Use a clear action hierarchy:

CACHE ACTIONS

  > Purge selected domain
    Purge selected group
    Purge all zones


The action labels should explicitly communicate the scope of the operation.

Confirmation

Before a group-wide or all-zone purge, show a confirmation screen containing:

The operation type.
The exact number of zones affected.
The list of affected domains.
Any zones that will be skipped because they are unavailable.
A clear confirmation and cancellation option.

For example:

PURGE ALL ZONES

You are about to purge caches for 24 zones.

This operation will send purge requests
to Cloudflare for every selected zone.

[ Cancel ]    [ Confirm purge ]


Allow individual-zone purges to use a faster confirmation flow, but ensure that the selected domain and action are always clear.

Never interpret a group purge as a global account-wide purge. Never interpret an all-zone purge as applying to configurations other than the currently active configuration.

Cloudflare API behaviour

Use the official Cloudflare API endpoint for cache purging at the zone level.

Support the initial implementation of purging the entire cache for a selected zone. This is different from purging a particular URL or cache tag, so label it accurately.

The architecture should allow future support for targeted purges by URL, hostname, cache tag, or other supported Cloudflare purge methods.

Use the correct zone ID for each request. Validate that the token has permission to perform the operation, and respect Cloudflare API rate limits and request constraints.

For group and all-zone operations:

Process requests with controlled concurrency.
Avoid excessive parallel requests.
Track each zone's result independently.
Handle transient errors and rate limits appropriately.
Do not report a successful purge until Cloudflare has acknowledged the request.
Never silently treat a partial failure as a complete success.
Progress and results

During an operation, display a live progress view.

For example:

PURGING EU SITES

[████████████░░░░] 4 / 6 zones

✓ example.de
✓ example.fr
✓ example.es
✓ example.it
◌ example.nl
◌ example.be

Completed: 4
Remaining: 2
Failed: 0


After completion, show a summary containing:

Total zones requested.
Successful requests.
Failed requests.
Skipped zones.
The reason for each failure, where known.

Provide a retry option for failed zones only. Do not automatically repeat successful purges unless the user explicitly requests it or the API response establishes that a retry is safe.

12. Search and Zone Discovery

As configurations grow, users need to find domains quickly.

Implement a search field that filters zones and groups as the user types.

Search should work across:

Domain names.
Group names.
Optionally, zone IDs.

Keep the selected item and navigation state stable when possible.

Provide a refresh action that re-fetches the zones accessible to the current token. Show loading and error states, and preserve existing local groups when refreshing.

If the API token's access changes, clearly distinguish between zones that are no longer accessible and zones that have been deleted or otherwise removed.

13. Configuration Management

Provide a configuration selector accessible from the main interface.

Users should be able to:

Switch between configurations.
Create configurations.
Rename configurations.
Update an API token.
Validate credentials.
Refresh zones.
Delete configurations.

Always identify the active configuration in the interface.

Switching configurations must also switch the associated credentials, zones, groups, and relevant preferences. It must never inadvertently purge zones from the previously active configuration.

Deleting a configuration should require confirmation and explain that its local settings and stored credential reference will be removed. Do not delete the underlying Cloudflare zones or alter the Cloudflare account itself.

14. Error Handling and Reliability

Design for real-world API failures.

Handle:

Invalid or expired API tokens.
Missing permissions.
Network errors and timeouts.
Cloudflare API errors.
Rate limiting.
Partial failures during group or all-zone purges.
Empty zone lists.
Deleted or inaccessible zones.
Corrupted or undecryptable local configuration.
Unsupported terminal capabilities.
Interrupted application sessions.

Errors should be concise, actionable, and visually distinct from successful operations.

Never display secrets in error messages.

Use structured internal logging where appropriate, but redact credentials and other sensitive information. Avoid storing sensitive request headers or raw authentication payloads.

15. Additional Quality-of-Life Features

Implement these after the core workflows are stable:

Recent purge activity for the active configuration.
Timestamps and per-zone outcomes.
A retry-failed-operations action.
A zone details view with its domain, zone ID, and status.
A group summary showing the number of member zones.
An optional command palette.
An optional URL-specific purge workflow.
A configuration export/import mechanism that never exports plaintext credentials by default.
A non-interactive mode for scripting and automation, with explicit flags, machine-readable output, and safe handling of credentials.

Keep the first version focused. Do not let secondary features delay reliable cache invalidation.

16. Suggested Project Structure

Organise the source code into clear modules. For example:

tanuki/
├── src/
│   ├── cli/
│   │   ├── arguments.ts
│   │   └── commands.ts
│   ├── tui/
│   │   ├── app.ts
│   │   ├── theme.ts
│   │   ├── navigation.ts
│   │   ├── components/
│   │   └── screens/
│   ├── cloudflare/
│   │   ├── client.ts
│   │   ├── zones.ts
│   │   └── purge.ts
│   ├── config/
│   │   ├── manager.ts
│   │   ├── storage.ts
│   │   ├── encryption.ts
│   │   └── groups.ts
│   ├── services/
│   │   ├── purge-service.ts
│   │   └── activity.ts
│   └── index.ts
├── tests/
├── package.json
├── tsconfig.json
└── README.md


Adapt this structure to the chosen OpenTUI packages and build system.

17. Testing Requirements

Write tests for the core application logic, including:

CLI argument parsing and configuration selection.
Configuration creation, loading, updating, and deletion.
Credential encryption and decryption.
Secure storage failure cases.
Zone discovery and pagination.
Group membership and persistence.
Single-zone cache purging.
Group-wide and all-zone purging.
Partial failures, retries, and rate limiting.
API token redaction.
Keyboard navigation and key UI flows where practical.

Use mocked Cloudflare API responses for automated tests. Tests must not require real Cloudflare credentials or accidentally invalidate real caches.

Include a manual test checklist for first-run onboarding, configuration switching, narrow terminal layouts, and interrupted operations.

18. Definition of Done

The first release is complete when a user can:

Install Tanuki globally through npm.
Launch it without arguments and select or create a configuration.
Create multiple named configurations.
Provide a Cloudflare API token securely.
Discover and display all zones accessible to the token.
Organise zones into persistent groups.
Search and navigate zones and groups using the keyboard.
Purge an individual zone's cache.
Purge every zone in a group.
Purge all accessible zones in the active configuration.
See accurate progress and success/failure summaries.
Retry failed zone operations.
Switch configurations without mixing their credentials or zones.
Restart the application and recover its locally saved configuration.
Understand how their credentials are stored and what protects them.
19. Implementation Priorities

Build Tanuki in the following order:

Phase 1 — Foundation

Initialise the TypeScript project and OpenTUI.
Implement CLI argument parsing.
Build the visual theme and navigation framework.
Establish secure configuration and credential storage.

Phase 2 — Cloudflare integration

Implement token validation.
Fetch and paginate accessible zones.
Display zone names and IDs.
Implement and test individual cache purging.

Phase 3 — Group management

Create and edit groups.
Persist group memberships.
Implement group and all-zone purging.
Add confirmation screens, concurrency controls, and progress reporting.

Phase 4 — Polish

Add the premium terminal UI, animations, columns, search, and activity views.
Improve error handling and responsive layouts.
Add automated tests and npm packaging.
Write installation, security, and usage documentation.

Build a working, testable product rather than a static UI mockup. Prioritise correct API behaviour and secure credential handling before visual flourishes, then polish the interface until it feels like a cohesive, premium tool.

Final product goal: Tanuki should be the tool a developer or agency can launch, choose a client, select a group of websites, and confidently purge their Cloudflare caches in seconds.

1. Use scoped Cloudflare API tokens

Require only the permissions needed to list zones and purge caches. Encrypt credentials at rest and make the encryption mechanism understandable to the user. A locally encrypted file is not sufficient if its decryption key is stored alongside it without meaningful protection.

2. Let domains belong to multiple groups

A domain might be part of both EU Sites and Brand A. Store group membership using zone IDs so renaming a domain or refreshing metadata doesn't break the organisation.

3. Make purging the whole cache the default action

For the MVP, focus on Cloudflare's zone-level purge-everything operation. Add URL-specific purges later. This keeps the core experience simple while making the scope of each action explicit.

4. Give Tanuki a recognisable visual identity

Think dark terminal, electric pink and violet accents, candy-gloss highlights, a small mascot, sharp two-column layouts, and animated progress. Keep animations restrained during actual purge operations so the UI remains fast and readable.