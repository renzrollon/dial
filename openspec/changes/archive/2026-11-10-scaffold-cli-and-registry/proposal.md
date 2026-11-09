# Proposal

## Why

Dial does not exist yet: this repository has no commits, and the epic that describes it (`~/IdeaProjects/app-ideas/dial-context-ledger-epic-2026-11-09.md`) is eight stages wide. Every later stage — collectors, the state machine, the vault writer, `dial next`, the Claude Code hooks — needs the same three things first: a command-line shell with Escapement's conventions, a registry that says which repo belongs to which vault, and a doctor that says when the setup is wrong. This change lands exactly those (epic stories 0.1, 0.2 and 7.3) so the rest of the epic can be specced one change at a time on a foundation that already enforces the work/personal boundary.

## What Changes

- A new Node 22, zero-dependency package at the repo root: `package.json`, MIT `LICENSE`, `README.md` in Escapement's section order, `bin/dial.mjs`, `lib/`, `test/`.
- The `dial` command-line shell: `version`, `limits`, `doctor`, `register`, `unregister`, `repos`, `help`; exit 0 on success and 1 with one stderr reason (lowercase prose that quotes values, names, paths, operating-system messages and exception messages as written); `--json` on every read command; usage on stdout; unknown commands and unknown options refused.
- The Dial home: `$DIAL_HOME`, default `~/.config/dial`, resolved with Escapement's rule (trim, tilde expansion, no fallback), created on first write and probed for writability.
- The registry file `$DIAL_HOME/registry.json` with a `dial_schema` version, `vaults`, `repos` (path, vault, host) and `limits`; loading, validation, `register`, `unregister` and `repos`; the boundary rule that a repo belongs to exactly one vault and that repo names are unique; atomic writes.
- Published caps: defaults in `lib/limits.mjs`, overridable from the registry's `limits` block, printed by `dial limits` as text or JSON.
- `dial doctor`: checks for Node, the home, the registry, the vault boundary audit over existing notes, the Claude Code permission rule with a paste-ready snippet, and the optional Obsidian CLI; rendered with the four-character status marks Escapement and Interlock share; exit 1 only on a failing check.
- Tests for every lib module and for the binary as a subprocess, with a shared runner and a byte-for-byte tree snapshot helper.

Nothing is removed and nothing is breaking: there is no prior behaviour.

## Capabilities

### New Capabilities

- `cli-shell`: how the `dial` binary parses arguments, dispatches commands, prints usage and version, reports errors on stderr, chooses between text and `--json` output, and exits.
- `dial-home`: where Dial keeps its own state — resolution of `DIAL_HOME`, the directory layout, creation and the writability probe, and the error when the home cannot be used.
- `registry`: the registry file's schema and validation, how repos are registered and unregistered, the one-vault-per-repo boundary and the unique-name rule, and how the file is written.
- `limits`: the published caps, their defaults and descriptions, how the registry overrides them, and how `dial limits` prints them.
- `doctor`: the precondition checks `dial doctor` runs, the check record shape, the text and JSON rendering, the exit code rule, the permissions snippet, and the vault boundary audit.

### Modified Capabilities

None. `openspec/specs/` is empty; this is the project's first change.

## Impact

- New files only, all inside this repository: `package.json`, `LICENSE`, `README.md`, `bin/dial.mjs`, `lib/{home,registry,limits,doctor,frontmatter,settings}.mjs`, `test/helpers.mjs`, `test/*.test.mjs`, `test/fixtures/`.
- Writes outside the repository at runtime: `$DIAL_HOME/registry.json` and the `$DIAL_HOME` directory, created only on `dial register` and `dial unregister`. `dial doctor` does not create the home; when the home already exists its `home` check writes and unlinks a probe file inside it. `dial doctor` reads the user's Obsidian vaults and Claude Code settings files and writes nothing to either.
- No runtime dependencies and no dev dependencies; `node:test` is the runner.
- Out of scope, each a later change: collectors (epic 1.1–1.5), the state machine (1.6), the renderer and `dial sync` with `dial vault init` (1.7, 0.3, 3.1–3.3), `dial next` and `dial brief` (1.8, 1.9), the Claude Code plugin (4.x), remote sources (2.x), the Escapement and Checkpoint bridge (5.x), the local model (6.x), the LaunchAgent and report (7.1, 7.2, 7.4). The human-only stories 0.4 (enable the Obsidian CLI), 0.5 (baseline week) and 0.6 (AGENTS.md section) are not code.
