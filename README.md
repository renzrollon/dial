# Dial

## Purpose

Dial keeps a ledger of every repository's changes in Obsidian, one vault per
repository, with the work/personal boundary kept sound: a Dial note must live
in the vault its repository is registered to. It reads what is already on disk
(git, OpenSpec, Interlock's ship state, Escapement's queue, Claude Code
sessions, a cached forge reply), derives one state per change, and writes
metadata-only notes into the registered vault. `docs/how-dial-works.md` tells
the pipeline end to end.

## Install

Node >= 22, no runtime dependencies.

```sh
git clone <this repo> && cd dial
npm i -g .
dial doctor
```

`dial doctor` is the first thing to run. It exits 1 when any check fails. The
skills and hooks call `dial` by name, so it must be on `PATH` (`doctor` warns
under `on-path` when it is not).

First use, in order:

```sh
# 1. declare the vault in $DIAL_HOME/registry.json under "vaults" (Dial never creates a vault)
dial vault init personal            # scaffold Projects/, Changes/, Templates/, Dial.base
dial register ~/IdeaProjects/dial --vault personal --host github
dial sync dial --dry-run            # the planned writes, nothing written
dial sync dial                      # write the notes
dial next                           # what needs you, across repos
```

## Commands

```
dial <command> [options]

  version                      print the version (--json)
  limits                       print the published caps (--json)
  doctor                       check preconditions, the vault boundary and the permission rule (--json)
  register <path> --vault <name> --host github|gitlab
                               register a git work tree against exactly one vault
  unregister <path-or-name>    remove a registered repo
  repos                        list registered repos (--json)
  vault init <name> [--force]  scaffold a registered vault's folders and templates (--json)
  sync [<repo>] [--all] [--remote] [--due-remote] [--dry-run]
                               collect, derive and write the notes of one repo or every repo (--json)
  next [--vault <name>]        every item that needs you, across repos, offline (--json)
  brief [<repo>] [--hook] [--session <id>]
                               the short orientation for one repo, offline (--json)
  handoff <repo> [<change>] (--stdin | --text <t>) [--source <label>] [--next <text>]...
                               prepend a dated narrative entry to a note (--json)
  narrate <repo> [<change>] --transcript <path> [--turns <n>] [--dry-run], or narrate --eval <dir>
                               ask a local model for the five narrative lines (--json)
  record --event SessionEnd|PreCompact
                               the hook side: sync, then narrate when no handoff was written (--json)
  drop <repo> <change>         mark a change note dropped (--json)
  agent install|uninstall|status
                               the background sync LaunchAgent (status: --json)
  watch                        sync a repo whenever its ship or OpenSpec state moves
  report                       what the ledger shows over time (--json)
  review --week                write the weekly review of stale items into each vault (--json)
  help                         print this text (also --help after any command)

```

`dial --version` is the same as `dial version`. Failures print one
`dial: <reason>` line on stderr and exit 1; `--help` exits 0. Unknown options
and value flags with no value are refused. Only the commands marked `--json`
accept it, and then print one two-space-indented JSON document.

- `register` takes a path to a git work tree and prints the repo name (the
  directory's basename). `unregister` takes the stored path, the expanded
  path, or the name. A repo is registered against exactly one vault.
- `vault init <name>` creates `Projects/`, `Changes/` and `Templates/` and
  copies `Dial.base`, `Dial Queries.md` and the templates when absent, one
  `created`, `unchanged` or `rewritten` line per path. `--force` rewrites a
  copied file whose bytes differ. It never touches `.obsidian/` or `AGENTS.md`.
- `sync <repo>` or `sync --all` collects, derives and writes. `--dry-run`
  prints every planned write and writes nothing. `--remote` fetches the PR and
  checks with `gh` or `glab`; `--due-remote` does so only for a repo whose
  cached reply is older than `remoteIntervalMinutes`. Without either flag no
  network command runs. A repo argument may be a name or a path inside the repo.
- `next [--vault <name>]` lists every item that needs you, offline, in state
  priority order, capped at `nextRows`.
- `brief [<repo>]` prints at most `briefLines` lines of orientation for one
  repo; `--hook` wraps it in the Claude Code SessionStart envelope and prints
  nothing for an unregistered repo; `--session <id>` names the session. `--hook`
  and `--json` cannot be combined.
- `handoff <repo> [<change>]` prepends a dated narrative entry to a note, from
  `--stdin` or `--text`, labelled by `--source`, and appends each `--next` as a
  `- [ ]` line.
- `narrate <repo> [<change>] --transcript <path>` asks a local model for five
  labelled lines (`Done:`, `Decided:`, `Next:`, `Blocked:`, `Open:`) from the
  last `--turns` turns and writes them as a narrative entry; `--dry-run` prints
  the prompt, the endpoints and the turns and calls nothing. `narrate --eval
  <dir>` runs the quality set under `<dir>/items/`.
- `record --event SessionEnd|PreCompact` is the hook side: sync, then narrate
  when no handoff was written. It exits 0 on every path.
- `drop <repo> <change>` marks a change note `dropped: YYYY-MM-DD`.
- `report` prints the indicators read from the vault notes, the sync log and
  the daily log, each with its denominator or `unobserved: <reason>`; it writes
  nothing, not even the home.
- `review --week` writes `Inbox/Dial Review YYYY-MM-DD.md` into each vault that
  holds Dial notes, asking archive, drop or re-spec of every stale item. A
  review that already exists for the day is left byte for byte. `dial review`
  alone is refused with `dial: review needs --week`.
- `watch` polls each repo's `.claude/ship/` and `openspec/changes/` newest
  mtime every `watchPollSeconds` and syncs a repo whose mtime moved, printing
  `HH:mm synced <repo> (needs me <n>)`. The first poll only records mtimes.
  It runs until SIGINT, then exits 0. It takes no `--json`.

### Notes, anatomy

A change note is `Changes/<repo>--<change>.md`; a repo note is
`Projects/<repo>.md`. Names are slugs: each of `: / \ ? * " < > | # ^ [ ]`
becomes `-`.

A change note is, in order:

1. frontmatter: `title, type, repo, change, scope, state, needs_me, stale,
   branch, pr, pr_state, ci, merge_verdict, tasks_done, tasks_total,
   last_commit, last_session, last_activity, created, updated, status, tags,
   aliases, dial_schema` (plus `dropped` and `archived` when set). A value Dial
   could not observe is written `unobserved`, never guessed.
2. `## Next`: human-owned checkboxes.
3. `## Narrative`: human-owned entries headed `### YYYY-MM-DD HH:mm · <source>`,
   newest first.
4. any other `##` section a human added, kept in place.
5. `## State  <!-- dial:generated, do not edit -->`: a `fact | value |
   evidence` table rebuilt on every sync.

A repo note adds generated `## Changes`, `## Drift` (counts) and `## Recent
narrative`. Each vault also holds `Dial Summary.md` (needs-me bullets),
`Dial.base` (four views grouped by state priority), `Dial Queries.md`, and
`Daily/YYYY-MM-DD.md` where Dial appends `- HH:mm dial ...` lines at the end of
`## Log`. `updated` changes only when the file's bytes do, so a sync with
nothing new writes nothing.

### The rules Dial keeps

- Metadata only. Notes hold states, counts, names and short evidence strings,
  never a diff, a file body or a secret.
- Never delete. Dial never deletes a note. An archived change's note moves to
  `Archive/Changes/` with `status: archived` and `archived: YYYY-MM-DD` after
  `archivedKeepDays`; a dropped one carries `dropped: YYYY-MM-DD`.
- Every vault write goes through one check that the repo's registered vault is
  the target. A write outside it, or for a repo registered against a directory
  root, is refused.
- Human-owned sections and unknown frontmatter keys survive every render.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DIAL_HOME` | `~/.config/dial` | Dial's state directory. `~` is expanded; blank means the default. |
| `DIAL_NOW` | the system clock | ISO-8601 clock override with `Z` or a `+HH:mm` offset; anything else is refused. Only commands that read the clock check it. |
| `DIAL_LAUNCHCTL_BIN` | `/bin/launchctl` | The `launchctl` the `agent` command and `doctor` run. |
| `ESCAPEMENT_HOME` | `~/.escapement` | Where the Escapement queue is read from. |
| `ESCAPEMENT_CHECKPOINT_URL` | unset | Appended to checkpoint evidence. |

Local dates and times follow the process time zone (`TZ`).

## Home layout

```
$DIAL_HOME/
  registry.json       the registry; absent until the first write
  cache/remote/       <repo>.json, the last PR and CI reply per repo
  logs/               sync.jsonl, one line per synced repo; agent.out.log and agent.err.log
  eval/               items/, outputs/, labels.jsonl: the narrate quality set, made by hand
```

The home is created by a writing command (`register`, `unregister`, `sync`,
`handoff`, `agent install`, `watch`) and never by a read command. A missing
registry is the empty registry. A home that cannot be written is refused with
`dial: dial home is not writable: <path> (<OS code>)` before any vault file is
touched.

## Registry

`registry.json` is written atomically, with a fixed key order and repos sorted
by name.

```json
{
  "dial_schema": "dial.registry/1",
  "vaults": { "personal": "/absolute/path/to/personal-vault", "work": "/absolute/path/to/work-vault" },
  "repos": [{ "path": "~/IdeaProjects/dial", "vault": "personal", "host": "github" }],
  "roots": { "~/VSCodeProjects": "work" },
  "narrate": { "provider": "mtplx", "url": "http://127.0.0.1:8000/v1", "model": "qwen3.6" },
  "limits": {}
}
```

- `vaults` maps a vault name to its directory. Dial never creates a vault
  directory: add it here by hand, then `dial vault init <name>`.
- `repos` holds one entry per repo: `path` (a leading home directory is stored
  as `~`), `vault` (a key of `vaults`) and `host` (`github` or `gitlab`).
- A repo belongs to exactly one vault, and repo names must be unique.
- `roots` (optional) maps a directory to a vault. `register` refuses a repo
  under a root whose vault differs from `--vault`, and `doctor`'s `boundary`
  check fails on an entry that contradicts its root.
- `narrate` (optional) has the keys `provider`, `url`, `model`, `apiKeyEnv`,
  `fallbackUrl` and `fallbackModel`. By default the endpoint comes from pi's
  `~/.pi/agent/models.json` (provider `mtplx`); `apiKeyEnv` names an
  environment variable holding the key, never the key itself.
- `limits` may override a published cap by name with a positive integer.

`register` checks, in order: the host, that the vault exists, that the repo is
not registered to another vault, then that the path is a directory holding a
`.git` entry. Registering an already-registered repo to the same vault updates
its host.

## Published caps

`dial limits` prints the effective caps, defaults overridden by the registry's
`limits` block.

| Cap | Value | Meaning |
| --- | --- | --- |
| `staleDays` | 14 | days without activity before a change is stale |
| `archivedKeepDays` | 30 | days an archived change stays on the board |
| `briefLines` | 40 | maximum lines in a brief |
| `subprocessTimeoutSeconds` | 10 | seconds before a git, gh, glab or interlock call is abandoned |
| `remoteIntervalMinutes` | 30 | minutes a cached forge reply stays fresh |
| `syncIntervalMinutes` | 15 | minutes between background syncs |
| `narrateTurns` | 20 | most recent conversation turns sent to the local model |
| `narrateTimeoutSeconds` | 30 | seconds before a local model call is abandoned |
| `nextRows` | 50 | maximum rows dial next prints |
| `watchPollSeconds` | 30 | seconds between watch polls |

An unknown cap name or a non-positive-integer value is refused, naming the key
and the file.

## Claude Code plugin

```
/plugin marketplace add renzrollon/dial
/plugin install dial@dial
```

The plugin registers four hooks and two skills. Every hook reads its payload
from stdin leniently, resolves the repo from it, costs one registry read for an
unregistered repo, runs the plugin's own CLI, and never blocks a session.

| Event | Hook | Effect |
| --- | --- | --- |
| `SessionStart` | `hooks/brief.mjs` | injects `dial brief --hook` |
| `SessionEnd`, `PreCompact` | `hooks/record.mjs` | `dial record --event ...`: sync, then narrate when no handoff was written |
| `PostToolUse` (Bash) | `hooks/sync-on-event.mjs` | syncs after an Interlock or OpenSpec close event |

Skills: `/dial:handoff [<repo>] [<change>]` writes five lines of the session
into the note through `dial handoff`; `/dial:next [--vault <name>]` shows
`dial next` as drafted actions.

Sandbox note for the skills: `dial handoff` and `dial sync` write into the
vault and the Dial home, so in a sandboxed Claude Code session both the vault
directory and `$DIAL_HOME` must be writable from the sandbox. When a `dial`
command fails with a permission error, report the failure and the command; do
not retry it another way.

## The LaunchAgent

`dial agent install` writes `~/Library/LaunchAgents/com.dial.sync.plist` and
bootstraps it: it runs `dial sync --all --due-remote` at load and every
`syncIntervalMinutes`, with only `DIAL_HOME` and `PATH` in its environment and
its output under `$DIAL_HOME/logs/`. `dial agent uninstall` boots it out and
removes the plist, leaving the logs. `dial agent status` reports one of
`running` (exit 0), `loaded-not-running`, `not-loaded`, `paths-missing` or
`not-installed` (exit 1) with a fix. The agent commands are macOS only.

## The AGENTS.md section

`dial vault init` ends by printing `append <path of AGENTS-dial-section.md> to
<vault>/AGENTS.md by hand`. Dial never edits `AGENTS.md`. The section
(`templates/AGENTS-dial-section.md`) tells an agent working in the vault which
sections are human-owned, which are generated, that Dial's slug filenames must
not be renamed, and the never-delete and metadata-only rules.

## Doctor

`dial doctor` runs twelve checks in order and prints `DIAL OK` or `DIAL BLOCKED`
with counts. Each check is `ok`, `warn`, `FAIL` or `skip`; evidence and a fix
are shown for warnings and failures. A `skip` does not count as passed.

1. `node`: Node is at least 22.
2. `home`: the home is writable, or can be created on first write.
3. `registry`: the registry parses and validates; a vault that is not a
   directory fails, a repo path that moved warns.
4. `obsidian-cli`: `obsidian` is on `PATH`; absent is a skip, not a failure.
5. `boundary`: no Dial note sits in a vault other than its repo's registered
   one, and no registry entry lies under another vault's `roots` entry. Skipped
   when the registry did not load.
6. `permissions`: `Bash(dial:*)` is allowed in a Claude Code settings file; a
   warning with a paste-ready snippet when it is not:

   ```
   Add to ~/.claude/settings.json → permissions.allow:
   "Bash(dial:*)"
   ```

The last six never fail:

7. `vault-scaffold`: every vault has `Projects/`, `Changes/` and `Dial.base`;
   warns with `dial vault init <name>` otherwise.
8. `vault-nesting`: warns when one registered vault lies inside another.
9. `narrate-endpoint`: the resolved endpoint and model, read from files with no
   network call and no key printed; skip when none is configured.
10. `launch-agent`: the LaunchAgent status; skip when not installed.
11. `on-path`: warns with `npm i -g .` when `dial` is not on `PATH`.
12. `fields`: always ok; its `--json` evidence lists every frontmatter key Dial
    writes, so you can see exactly what leaves a repository.

Exit code is 1 only when a check fails; warnings and skips exit 0. `--json`
prints the full report.

## Non-goals

- Dial does not create a vault directory; it scaffolds one you declared.
- Dial calls GitHub or GitLab only under `--remote` or `--due-remote`.
- Dial does not move a repo between vaults. Unregister and register again.
- Dial never deletes a note and never writes a diff, a file body or a secret.
- Dial has no runtime dependencies; the only background process is the optional
  LaunchAgent.
