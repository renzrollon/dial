# Spec Delta

## MODIFIED Requirements

### Requirement: sync runs the pipeline for each selected repo and reports the outcome
`dial sync <repo>` SHALL sync the one registered repo the argument resolves to under the registry's repo resolution rule, and `dial sync --all` every registered repo, each collecting, deriving, rendering and writing its notes and appending daily lines, then printing `<repo>: <items> items, <needsMe> need me, <n> written`. `--json` SHALL print an array of `{ repo, vault, items, needsMe, writes: [{ verb, path }], remote }`, where `remote` is the run's `remote` fact: `{ value, evidence }` when the remote facts came from a completed fetch or a readable cache, else `{ value: null, unobserved }` with the fact's reason, redacted as the vault writers redact with the repo name kept. A fetch that fails leaves the exit code 0, so under `--remote` an unobserved `remote` is the row's sign that the refresh failed.

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

#### Scenario: A failed fetch shows in the JSON row
- **WHEN** `dial sync katipon --remote --json` runs, `gh pr view` fails with `error connecting to api.github.com`, and the remote cache holds a list fetched 10 minutes ago
- **THEN** the exit code is 0, the cache is byte for byte as it was, and the row's `remote` is `{ "value": null, "unobserved": "gh: error connecting to api.github.com" }`

#### Scenario: A completed fetch shows in the JSON row
- **WHEN** `DIAL_NOW=2026-11-10T09:00:00Z dial sync katipon --remote --json` runs and the fetch completes
- **THEN** the row's `remote` is `{ "value": "ok", "evidence": "remote cache: fetched 2026-11-10T09:00:00.000Z" }`
