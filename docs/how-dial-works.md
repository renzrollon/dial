# How Dial works

Dial is a pipeline with one direction: **collect → derive → render → write →
surface → hook**. Each stage is a module in `lib/` that takes values and
returns values; only `bin/dial.mjs` touches the process, and only the write
stage touches a vault.

## 1. Collect

`dial sync <repo>` asks each source for facts about one registered repo:

| Source | Reads |
| --- | --- |
| git | branch, dirty, stash, ahead/behind, worktrees, last commit |
| OpenSpec | `openspec/changes/` and its archive, task counts |
| Interlock | `.claude/ship/` run state, outcomes, settle findings, merge verdict, `interlock drift --json` |
| Escapement | the queue under `ESCAPEMENT_HOME` |
| Claude Code sessions | the last session per repo (transcript metadata only) |
| forge cache | `$DIAL_HOME/cache/remote/<repo>.json`, the last PR and CI reply |

Only `--remote` (or `--due-remote`, when the cache is older than
`remoteIntervalMinutes`) runs `gh` or `glab` and refreshes that cache. Every
other run is offline.

### The fact discipline

Every observed value is a **fact**: a value plus one evidence string naming the
file, command or field it came from. A value that could not be observed is
`unobserved: <reason>` (`gh: not authenticated`, `no remote cache`), never a
default. A missing optional file is an observed absence; only a missing source
root or a missing binary is unobserved. Nothing downstream substitutes a guess:
a signal never matches on an unobserved fact, and the note prints it as
`unobserved`.

## 2. Derive

`derive` is pure. From the facts and the existing notes it builds one item per
active or recently archived change, plus a repo-level item for branch facts no
change owns. Each item is in exactly one state, the first of this list whose
signal is present:

| State | needs me | Suggested action |
| --- | --- | --- |
| `archived` | no | none |
| `dropped` | no | none |
| `archive-pending` | yes | `openspec archive <change>` |
| `conflict` | yes | `resolve, then git rebase --continue` |
| `ci-red` | yes | `/interlock:fix-tests` |
| `needs-fix` | yes | `/interlock:settle --review` |
| `manual-test` | yes | `run the plan, add Result:` |
| `pr-open` | unless the merge verdict is `MERGE` | `review and merge` |
| `shipped` | yes | `/interlock:settle --create` |
| `halted` | yes | `/interlock-handoff, re-run ship` |
| `shipping` | no | `wait` |
| `queued` | no | `wait or escapement list` |
| `checkpoint` | yes | `read the spec; answer on the phone` |
| `spec-draft` | yes | `/interlock:review-artifacts` |

`stale` is an overlay, not a state: a change whose newest activity is older
than `staleDays`. The same order drives `dial next` and the `Dial.base` groups.
Derivation is deterministic: the same facts and the same clock (`DIAL_NOW`)
give the same items.

## 3. Render

The renderer turns an item into a note: frontmatter in a fixed key order, the
human-owned `## Next` and `## Narrative` carried over byte for byte, any human
section kept, and the generated `## State` table (`fact | value | evidence`)
last. Repo notes add `## Changes`, `## Drift` and `## Recent narrative`.
Nothing in a written note is computed from the clock, so `updated` moves only
when the bytes do. Rendering reads and writes no file.

## 4. Write

One boundary check guards every vault write: the target must be inside the
vault the repo is registered to, and a repo registered against a directory
root (`roots`) is refused. Writes are atomic (temp file, rename) and skip
unchanged bytes; a note changed during a sync is re-read, not overwritten.
Dial writes notes, `Dial Summary.md`, `Daily/` log lines (append only under
`## Log`) and one `$DIAL_HOME/logs/sync.jsonl` line per repo. It never deletes:
an archived change moves to `Archive/Changes/` after `archivedKeepDays`, and a
dropped one is marked. `--dry-run` runs the pipeline up to here and prints the
plan. Notes carry metadata only: states, counts, names, short evidence.

## 5. Surface

The vault is the surface. Obsidian shows `Dial.base` (four views by state
priority) and `Dial Summary.md`; the terminal shows `dial next` (every
needs-me item, offline) and `dial brief` (at most `briefLines` lines for one
repo). `dial report` reads the notes, the sync log and the daily log and prints
indicators with their denominators, and `dial review --week` writes the weekly
review asking archive, drop or re-spec of each stale item. A human or an agent
adds meaning through `dial handoff` (a narrative entry and `- [ ]` lines) and
`dial narrate` (five lines from a local model, from the session's last turns).

## 6. Hook

The Claude Code plugin closes the loop without a person running anything:
`SessionStart` injects `dial brief --hook`; `SessionEnd` and `PreCompact` run
`dial record`, which syncs and narrates when no handoff was written; a Bash
`PostToolUse` hook syncs after an Interlock or OpenSpec close event. Outside a
session the LaunchAgent runs `dial sync --all --due-remote` every
`syncIntervalMinutes`, and `dial watch` syncs a repo the moment its ship or
OpenSpec state moves. Hooks never block a session and cost one registry read in
an unregistered repo.
