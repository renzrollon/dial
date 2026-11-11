# Spec Delta

## Purpose

When and how Dial writes into a registered vault: `dial vault init`, `dial sync` and its dry run, the boundary check against the registry, atomic and idempotent writes, the daily log append, archiving, `dial drop`, and the rule that no note is ever deleted.

## ADDED Requirements

### Requirement: vault init scaffolds a vault and reports each path
`dial vault init <name> [--force]` SHALL ensure `Projects/`, `Changes/` and `Templates/` exist and copy `Dial.base`, `Templates/Dial Change.md`, `Dial Queries.md` and `Templates/Daily.md` when absent, printing one line `<verb> <path>` per path in that order, the verb `created`, `unchanged` or `rewritten`. `--force` SHALL rewrite a copied file whose bytes differ. Last it SHALL print `append <path of AGENTS-dial-section.md> to <vault path>/AGENTS.md by hand`.

#### Scenario: First run on an empty vault
- **WHEN** `dial vault init personal` runs and the vault `personal` holds only `.obsidian/` and `AGENTS.md`
- **THEN** stdout is `created Projects/`, `created Changes/`, `created Templates/`, `created Dial.base`, `created Templates/Dial Change.md`, `created Dial Queries.md`, `created Templates/Daily.md`, then the `append … by hand` line, and the exit code is 0

#### Scenario: Second run is byte-identical
- **WHEN** `dial vault init personal` runs twice
- **THEN** every line of the second run says `unchanged` and every file in the vault is byte-identical to after the first run

#### Scenario: An edited template is kept without force
- **WHEN** a human edited `Templates/Dial Change.md` and `dial vault init personal` runs
- **THEN** its line is `unchanged Templates/Dial Change.md` and the file keeps the human's bytes

#### Scenario: Force rewrites a differing template
- **WHEN** a human edited `Dial.base` and `dial vault init personal --force` runs
- **THEN** its line is `rewritten Dial.base` and the file equals the shipped template

#### Scenario: AGENTS.md and .obsidian are never touched
- **WHEN** `dial vault init personal --force` runs on a vault with `AGENTS.md` and `.obsidian/`
- **THEN** both are byte-identical afterwards and no file under `.obsidian/` was read

### Requirement: vault init refuses an unknown vault or a missing path
`dial vault` without a subcommand SHALL exit 1 with `dial: vault needs one of init`; an unknown subcommand with `dial: unknown vault subcommand: <x>`; `vault init` without a name with `dial: vault init needs <name>`; a name absent from `vaults` with `dial: no vault named <name> in the registry`; a vault whose path does not exist with `dial: vault <name> does not exist: <path>`. Nothing SHALL be created in any of these cases.

#### Scenario: No subcommand
- **WHEN** `dial vault` is run
- **THEN** stderr is `dial: vault needs one of init` and the exit code is 1

#### Scenario: Unknown vault name
- **WHEN** `dial vault init clients` is run and `vaults` has no `clients` key
- **THEN** stderr is `dial: no vault named clients in the registry` and the exit code is 1

#### Scenario: Vault path missing
- **WHEN** the vault `personal` points at `/Users/caro/Documents/gone`, which does not exist
- **THEN** stderr is `dial: vault personal does not exist: /Users/caro/Documents/gone`, the exit code is 1, and the directory is not created

### Requirement: sync runs the pipeline for each selected repo and reports the outcome
`dial sync <repo>` SHALL sync the one registered repo the argument resolves to under the registry's repo resolution rule, and `dial sync --all` every registered repo, each collecting, deriving, rendering and writing its notes and appending daily lines, then printing `<repo>: <items> items, <needsMe> need me, <n> written`. `--json` SHALL print an array of `{ repo, vault, items, needsMe, writes: [{ verb, path }] }`.

#### Scenario: One repo
- **WHEN** `dial sync katipon` runs and katipon has three items, one needing the human, and two notes differ from disk
- **THEN** stdout is `katipon: 3 items, 1 need me, 2 written` and the exit code is 0

#### Scenario: Neither repo nor all
- **WHEN** `dial sync` is run with no repo and no `--all`
- **THEN** stderr is `dial: sync needs <repo> or --all` and the exit code is 1

#### Scenario: Both repo and all
- **WHEN** `dial sync katipon --all` is run
- **THEN** stderr is `dial: sync takes <repo> or --all, not both` and the exit code is 1

#### Scenario: Unknown repo
- **WHEN** `dial sync nothing-here` is run
- **THEN** stderr is `dial: no registered repo matches nothing-here` and the exit code is 1

#### Scenario: One repo fails under all
- **WHEN** `dial sync --all` runs over three repos and one repo's vault path does not exist
- **THEN** the other two repos are synced and reported, stdout carries `<repo>: skipped, <reason>` for the third, stderr is `dial: 1 of 3 repos not synced`, and the exit code is 1

#### Scenario: Folders created on demand
- **WHEN** a vault has no `Changes/` or `Daily/` folder and a sync writes a change note and a daily line
- **THEN** both folders are created, and `Dial.base` and `Templates/` are not created when absent

#### Scenario: Due remote
- **WHEN** `dial sync --all --due-remote` runs and a repo's remote cache was fetched 45 minutes ago with `remoteIntervalMinutes` 30
- **THEN** that repo is synced as if `--remote` had been given, and a repo whose cache is 10 minutes old is synced from its cache

### Requirement: A dry run prints every planned write and writes nothing
`dial sync … --dry-run` SHALL print one line `<verb> <absolute path>` per planned path, the verb one of `create`, `update`, `unchanged`, `append`, `move`, with a move printed as `move <from> → <to>`, and SHALL write nothing: no vault file, no folder, no cache file, no sync log line, and no home directory.

#### Scenario: Plan of a first sync
- **WHEN** `dial sync katipon --dry-run` runs on a vault with no Dial notes and katipon has one change `add-login`
- **THEN** stdout carries `create <vault>/Changes/katipon--add-login.md`, `create <vault>/Projects/katipon.md` and `create <vault>/Dial Summary.md`, and a snapshot of the vault and the Dial home is identical before and after

#### Scenario: Plan of an unchanged vault
- **WHEN** `dial sync katipon` ran and `dial sync katipon --dry-run` runs with the same facts
- **THEN** every printed line starts with `unchanged`

#### Scenario: Planned archive move
- **WHEN** an archived change note is due for archiving
- **THEN** the plan carries `move <vault>/Changes/katipon--add-login.md → <vault>/Archive/Changes/katipon--add-login.md` and both paths are as they were after the run

### Requirement: Each sync appends one line per repo to the sync log
After a repo is synced without `--dry-run`, Dial SHALL append one JSON line `{ "ts", "vault", "repo", "needsMe", "items" }` to `$DIAL_HOME/logs/sync.jsonl`, creating the home and `logs/` when absent, with `ts` the ISO time of the sync (`DIAL_NOW` when set). A skipped repo SHALL append nothing.

#### Scenario: Log line after a sync
- **WHEN** `DIAL_NOW=2026-11-10T09:00:00Z dial sync katipon` runs and katipon has three items, one needing the human, in vault `personal`
- **THEN** the last line of `sync.jsonl` parses to `{ "ts": "2026-11-10T09:00:00.000Z", "vault": "personal", "repo": "katipon", "needsMe": 1, "items": 3 }`

#### Scenario: Earlier lines kept
- **WHEN** `sync.jsonl` already holds ten lines and a sync of two repos runs
- **THEN** the file holds twelve lines and the first ten are unchanged

### Requirement: A daily line is appended for each observed state transition
For each change note that already exists, a sync SHALL append a transition line to the daily log when the note's previous `state` and its new state are both observed and differ. A note's first creation, a transition from or to `unobserved`, and the repo note's state SHALL NOT be logged. A change note whose change directory is gone with no archive entry SHALL be left untouched and SHALL NOT be logged.

#### Scenario: State moved
- **WHEN** the note for `katipon/add-login` holds `state: shipping` and the sync derives `pr-open`
- **THEN** one transition line `… katipon/add-login: shipping → pr-open (…) [[katipon--add-login]]` is appended to today's daily note

#### Scenario: First creation is silent
- **WHEN** a sync creates the note for a new change in `spec-draft`
- **THEN** no daily line is appended for it

#### Scenario: Unobserved is silent
- **WHEN** a note's previous state is `unobserved`
- **THEN** no daily line is appended for that note

#### Scenario: A vanished change is left alone
- **WHEN** `openspec/changes/add-login/` was deleted without an archive entry
- **THEN** `Changes/katipon--add-login.md` is byte-identical after the sync and no daily line names it

### Requirement: Writes are refused outside the repo's registered vault
Every write for a repo SHALL target the path of the vault the registry names for it, and only `Projects/`, `Changes/`, `Archive/Changes/`, `Daily/`, `Templates/`, `Inbox/` or the root files `Dial.base`, `Dial Summary.md` and `Dial Queries.md`. A write into another path SHALL be refused with `dial: <repo> is registered to vault <v>; refusing to write into <path>` and exit 1; a repo whose vault path does not exist with `dial: vault <v> for <repo> does not exist: <path>`.

#### Scenario: Write into another vault
- **WHEN** a planned write for `katipon`, registered to `personal`, targets a path under the vault `work`
- **THEN** stderr is `dial: katipon is registered to vault personal; refusing to write into <path>`, the exit code is 1, and no file in either vault changed

#### Scenario: Vault path missing
- **WHEN** `dial sync katipon` runs and the vault `personal` points at `/Users/caro/Documents/gone`, which does not exist
- **THEN** stderr is `dial: vault personal for katipon does not exist: /Users/caro/Documents/gone`, the exit code is 1, and the directory is not created

#### Scenario: Obsidian settings are out of bounds
- **WHEN** any Dial command runs against a vault
- **THEN** no file under `.obsidian/` is read, created or modified, and `AGENTS.md` is not modified

### Requirement: Writes are atomic and skip unchanged bytes
A file SHALL be written only when its new bytes differ from those on disk. A write SHALL go to the hidden file `.<name>.<pid>.tmp` in the target's directory and then be renamed over the target; on failure the temp file SHALL be removed and the target SHALL keep its previous bytes.

#### Scenario: Unchanged file is not rewritten
- **WHEN** `dial sync katipon` runs twice with the same facts
- **THEN** after the second run every note's bytes and modification time are those of the first run

#### Scenario: Failed write leaves the note intact
- **WHEN** the rename of a note's temp file fails
- **THEN** the note holds its previous bytes and no `.*.tmp` file remains in its directory

#### Scenario: No temp file left after success
- **WHEN** a sync writes five notes
- **THEN** no file matching `.*.tmp` remains anywhere in the vault

### Requirement: A note changed during a sync is re-read, never overwritten
Every write SHALL compare the target's bytes just before the rename with the bytes the write was planned from. When they differ the write SHALL be planned again once from the new bytes, so the other writer's narrative entry, `## Next` line or daily line is kept; when the bytes differ again the write SHALL be skipped with the stderr line `dial: <path> changed during the write; skipped` and the sync's exit code SHALL be unchanged. A daily-log append SHALL follow the same rule.

#### Scenario: A handoff lands between plan and apply
- **WHEN** a sync has planned `Changes/katipon--add-login.md`, and a `dial handoff` prepends an entry to its `## Narrative` before the sync renames its temp file
- **THEN** the note holds the handoff's entry and the sync's new `## State`, and no entry is lost

#### Scenario: Two daily appends at once
- **WHEN** a handoff and a sync each append a line to `Daily/2026-11-10.md` and their reads interleave
- **THEN** the file holds both lines under `## Log`

#### Scenario: The file keeps changing
- **WHEN** the target's bytes differ from the planned bytes on both checks
- **THEN** the target holds the other writer's bytes, stderr has one `dial: <path> changed during the write; skipped` line, and no `.*.tmp` file remains

### Requirement: The daily log is appended under Log and never rewritten
A daily line SHALL go into `Daily/YYYY-MM-DD.md` for the local date, created from the vault's `Templates/Daily.md` byte for byte when present, else from Dial's skeleton (frontmatter `type: daily`, then `## Log`). A missing `## Log` heading SHALL be appended at the end of the file. Lines SHALL be added at the end of the `## Log` section, before the next `##` heading or at end of file; only an existing `updated` key SHALL be set to today; no other byte SHALL change.

#### Scenario: Created from the vault template
- **WHEN** no daily note exists for 2026-11-10 and `Templates/Daily.md` exists
- **THEN** `Daily/2026-11-10.md` starts with the template's bytes and ends with the new line under `## Log`

#### Scenario: Created from the skeleton
- **WHEN** no daily note and no `Templates/Daily.md` exist
- **THEN** `Daily/2026-11-10.md` has frontmatter with `type: daily`, a `## Log` heading and the new line under it

#### Scenario: Log heading added when missing
- **WHEN** `Daily/2026-11-10.md` exists with a `## Notes` section and no `## Log`
- **THEN** `## Log` is appended at the end of the file with the line under it, and `## Notes` is byte-identical

#### Scenario: Appended before the next section
- **WHEN** the daily note holds `## Log` with two lines followed by `## Reading`
- **THEN** the new line becomes the third line of `## Log`, before `## Reading`, and the two earlier lines are unchanged

### Requirement: Archived change notes move to Archive/Changes after the keep period
On every sync, a change note with `state: archived` whose OpenSpec archive date is more than `archivedKeepDays` days before today SHALL be moved to `Archive/Changes/<same name>.md` with `status: archived` and `archived: <today>` set and every other byte kept. When the target already exists the move SHALL be skipped and both files left unchanged. A change note whose change is in the OpenSpec archive but that derive no longer makes an item for, because the first sync after the archive came after the keep period, and whose `state` is neither `archived` nor `dropped`, SHALL first get `state: archived` and `needs_me: false` (and `stale: false` when it has a `stale` key), every other byte kept, and SHALL then be moved in the same sync.

#### Scenario: Moved after the keep period
- **WHEN** `add-login` was archived as `archive/2026-10-01-add-login/`, `archivedKeepDays` is 30 and today is 2026-11-10
- **THEN** `Changes/katipon--add-login.md` no longer exists and `Archive/Changes/katipon--add-login.md` holds its sections with `status: archived` and `archived: 2026-11-10`

#### Scenario: Kept within the period
- **WHEN** the change was archived on 2026-11-01 and today is 2026-11-10
- **THEN** the note stays in `Changes/` with `state: archived`

#### Scenario: An archive found after the keep period
- **WHEN** `Changes/katipon--add-login.md` says `state: archive-pending` and `needs_me: true`, `add-login` was archived 35 days ago, `archivedKeepDays` is 30, and `dial sync katipon` runs for the first time since
- **THEN** the note is at `Archive/Changes/katipon--add-login.md` with `state: archived`, `needs_me: false` and `status: archived`, and `Dial Summary.md` no longer lists it as needing me

#### Scenario: Target already exists
- **WHEN** `Archive/Changes/katipon--add-login.md` already exists
- **THEN** neither file changes

### Requirement: drop marks a change note as dropped
`dial drop <repo> <change>` SHALL set `dropped: <today>`, `state: dropped`, `needs_me: false` and `updated: <today>` in the change note's frontmatter, keep every other byte, leave the repository untouched, and print `dropped [[<repo>--<change>]]`. A note already dropped SHALL keep its first `dropped` date and not be rewritten. A missing note SHALL exit 1 with `dial: no note for <repo>/<change> in vault <v>`.

#### Scenario: Drop a change
- **WHEN** `dial drop katipon add-login` runs on 2026-11-10
- **THEN** stdout is `dropped [[katipon--add-login]]`, the note carries `dropped: 2026-11-10`, `state: dropped`, `needs_me: false`, and nothing under the repository changed

#### Scenario: Dropped stays dropped
- **WHEN** `dial sync katipon` runs after the drop and the change dir still exists
- **THEN** the note keeps `state: dropped` and `needs_me: false`

#### Scenario: Drop twice
- **WHEN** `dial drop katipon add-login` runs on 2026-11-10 and again on 2026-11-12
- **THEN** the note still carries `dropped: 2026-11-10` and its bytes are unchanged by the second run

#### Scenario: No such note
- **WHEN** `dial drop katipon nothing-here` runs and the vault `personal` has no `Changes/katipon--nothing-here.md`
- **THEN** stderr is `dial: no note for katipon/nothing-here in vault personal` and the exit code is 1

#### Scenario: Missing argument
- **WHEN** `dial drop katipon` is run
- **THEN** stderr is `dial: drop needs <repo> <change>` and the exit code is 1

### Requirement: No note is ever deleted
No Dial command SHALL unlink a note or any other file in a vault, other than its own `.<name>.<pid>.tmp` files. A note SHALL leave its path only by the archive move, and a note whose change, repo or registry entry is gone SHALL stay where it is.

#### Scenario: Unregistered repo keeps its notes
- **WHEN** `dial unregister katipon` runs and then `dial sync --all`
- **THEN** `Projects/katipon.md` and every `Changes/katipon--*.md` still exist with the same bytes

#### Scenario: File count never drops
- **WHEN** any sequence of `dial vault init`, `dial sync`, `dial drop` runs against a vault
- **THEN** the number of `.md` files under the vault never decreases, counting a moved note at its new path

### Requirement: Writes are refused for a repo registered against its directory root
A repo whose registered path has a root vault (registry `roots`) other than its registered vault SHALL have every write refused with `dial: <repo> is under <root>, which belongs to vault <rv>; refusing to write into vault <v>` and exit 1; under `sync --all` it is a skipped repo with that reason.

#### Scenario: Entry registered before its root was declared
- **WHEN** `agentbase` at `~/VSCodeProjects/agentbase` is registered to `personal`, `roots` is then set to `{ "~/VSCodeProjects": "work" }`, and `dial sync agentbase` runs
- **THEN** stderr is `dial: agentbase is under ~/VSCodeProjects, which belongs to vault work; refusing to write into vault personal`, the exit code is 1, and no file in either vault changed
