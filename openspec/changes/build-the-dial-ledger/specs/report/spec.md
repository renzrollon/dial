# Spec Delta

## Purpose

Whether Dial is working, in numbers: `dial report` prints the indicators read from the vault notes, the sync log and the daily log, each with its denominator or `unobserved: <reason>`, and `dial review --week` writes the weekly review note that asks archive, drop or re-spec of every stale item.

## ADDED Requirements

### Requirement: Report reads three inputs and never writes
`dial report` SHALL read every Dial change and repo note (`Changes/*.md`, `Projects/*.md` whose frontmatter `dial_schema` is `dial.change/1` or `dial.repo/1`) in every registered vault, `$DIAL_HOME/logs/sync.jsonl`, the `## Log` lines of `Daily/*.md` in every registered vault, and `$DIAL_HOME/eval/labels.jsonl`. It SHALL create, modify or delete no file, including the Dial home, and exit 0.

#### Scenario: Read-only
- **WHEN** `dial report` is run against a registry with two vaults
- **THEN** a snapshot of both vaults and the Dial home taken before and after is identical, and the exit code is 0

#### Scenario: No home yet
- **WHEN** the Dial home does not exist
- **THEN** report exits 0 and the home still does not exist

#### Scenario: Notes without the Dial schema are ignored
- **WHEN** `Changes/` holds a hand-written note with no `dial_schema`
- **THEN** that note is not counted in any indicator

### Requirement: Items are counted by state with a denominator
Report SHALL count the change notes by their frontmatter `state` and print one line per state present, `<state> <n> of <N>`, in the state table's order, where `<N>` is the number of change notes read. A note whose `state` is `unobserved` SHALL be counted under `unobserved`.

#### Scenario: Seventeen notes
- **WHEN** the vaults hold 17 change notes, 3 with `state: pr-open` and 2 with `state: halted`
- **THEN** stdout includes `pr-open 3 of 17` and `halted 2 of 17`, and `pr-open` precedes `halted`

#### Scenario: No change notes
- **WHEN** no registered vault holds a Dial change note
- **THEN** the items line is `items by state: unobserved: no Dial change notes (0 of <v> vaults)`

### Requirement: Median idle days is printed over the items that carry it
Report SHALL print `median idle days: <m> (<k> of <N> items)`, the median over change items that are neither `archived` nor `dropped` of the idle days computed from each change note's `last_activity` against the current time; `<k>` is the count of items whose `last_activity` is observed.

#### Scenario: Median over live items
- **WHEN** five live items have idle days 1, 2, 4, 9 and 30 and two archived items exist among seven change notes
- **THEN** stdout includes `median idle days: 4 (5 of 7 items)`

#### Scenario: No idle values
- **WHEN** no change note has an observed `last_activity`
- **THEN** stdout includes `median idle days: unobserved: no last_activity in change notes (0 of <N> items)`

### Requirement: Needs-me is counted per day for four weeks
From `$DIAL_HOME/logs/sync.jsonl` report SHALL take, for each of the 28 local days ending today and each `vault`/`repo` pair, the last line of that day, and print per day `<YYYY-MM-DD> <sum of needsMe>`, or `<YYYY-MM-DD> unobserved: no sync that day`, under a header `needs me per day (<d> of 28 days observed)`.

#### Scenario: Last line of the day wins
- **WHEN** `sync.jsonl` holds for 2026-11-09 the lines `{repo: katipon, needsMe: 3}` at 09:00 and `{repo: katipon, needsMe: 1}` at 17:00, and `{repo: dial, needsMe: 2}` at 12:00
- **THEN** the line for 2026-11-09 is `2026-11-09 3`

#### Scenario: Gaps are unobserved
- **WHEN** the log holds lines on 21 of the last 28 days
- **THEN** the header is `needs me per day (21 of 28 days observed)` and each of the other 7 days prints `unobserved: no sync that day`

#### Scenario: No sync log
- **WHEN** `$DIAL_HOME/logs/sync.jsonl` does not exist
- **THEN** stdout includes `needs me per day: unobserved: no sync log at <path> (0 of 28 days)`

### Requirement: The baseline week is shown beside the current week
Report SHALL parse `## Log` lines `- HH:mm baseline · reorient <n>m · lookups <n>`. The baseline week SHALL be the seven days from the earliest such line's date; the current week the seven days ending today. For each it SHALL print the date range, the mean reorient minutes rounded to a whole minute, the total lookups, and `<d> of 7 days`; a week with no line SHALL print `unobserved: no baseline lines (0 of 7 days)`.

#### Scenario: Both weeks observed
- **WHEN** the baseline lines from 2026-10-01 to 2026-10-07 have reorient 10, 14 and 12 minutes and 3, 4 and 2 lookups on 3 days, and today is 2026-11-10 with lines reorient 4 and 6 minutes and 1 and 0 lookups on 2 days
- **THEN** stdout includes `baseline week 2026-10-01..2026-10-07: reorient 12m · lookups 9 (3 of 7 days)` and `current week 2026-11-04..2026-11-10: reorient 5m · lookups 1 (2 of 7 days)`

#### Scenario: No current-week lines
- **WHEN** baseline lines exist only in October and none in the seven days ending today
- **THEN** the current-week line ends `unobserved: no baseline lines (0 of 7 days)`

#### Scenario: Other log lines are ignored
- **WHEN** `## Log` holds `- 14:05 dial · katipon/add-login: pr-open → ci-red (checks) [[katipon--add-login]]`
- **THEN** that line contributes to neither week

### Requirement: The narrative source split covers every change note
Report SHALL classify each change note by the source of its newest `## Narrative` entry as `/dial:handoff` (source starts `/dial:handoff`), `local model` (source starts `local model`), `other` (any other source), or `none` (no entry), and print each class as `<n> of <N>` change notes.

#### Scenario: Mixed sources
- **WHEN** of 10 change notes 4 have a newest entry from `/dial:handoff (claude)`, 2 from `local model (qwen3.6)`, 1 from `dial handoff` and 3 have no entry
- **THEN** stdout includes `/dial:handoff 4 of 10`, `local model 2 of 10`, `other 1 of 10` and `none 3 of 10`

### Requirement: The narrative quality score comes from the labelled set
Report SHALL read `$DIAL_HOME/eval/labels.jsonl` (`{ id, nextCorrect, nothingInvented }`) and print `narrative quality: nextCorrect <k> of <n> · nothingInvented <k> of <n>`, `<n>` being the number of label rows. Without the file it SHALL print `narrative quality: unobserved: no labels at <path>`.

#### Scenario: Twenty labels
- **WHEN** `labels.jsonl` has 20 rows, 14 with `nextCorrect: true` and 18 with `nothingInvented: true`
- **THEN** stdout includes `narrative quality: nextCorrect 14 of 20 · nothingInvented 18 of 20`

#### Scenario: No labels
- **WHEN** the file does not exist
- **THEN** stdout includes `narrative quality: unobserved: no labels at <home>/eval/labels.jsonl` and the exit code is 0

### Requirement: Report offers the same indicators as JSON
With `--json` report SHALL print one object with the keys `itemsByState`, `medianIdleDays`, `needsMePerDay`, `baseline`, `narrativeSources` and `narrativeQuality`; each value SHALL carry its counts and denominator, or `{ "unobserved": "<reason>" }` when it cannot be computed.

#### Scenario: JSON with one indicator missing
- **WHEN** `dial report --json` is run with no sync log
- **THEN** stdout parses as JSON, `needsMePerDay.unobserved` is `no sync log at <path>`, `itemsByState` holds a count per state and the total, and the exit code is 0

### Requirement: Review writes one weekly note per vault
`dial review --week` SHALL write `Inbox/Dial Review YYYY-MM-DD.md` (local date) in each registered vault holding `Projects/` or `Changes/`, creating `Inbox/` when absent: frontmatter `title`, `created`, `updated`, `type: note`, `status: inbox`, `tags: [dial]`, `dial_schema: dial.review/1`, then `![[Dial.base#Stale]]`, then `## Drift` with the totals. `dial review` without `--week` SHALL refuse with `dial: review needs --week`.

#### Scenario: Weekly note
- **WHEN** `DIAL_NOW=2026-11-15T10:00:00Z dial review --week` is run with one scaffolded vault
- **THEN** `Inbox/Dial Review 2026-11-15.md` exists in it, contains `![[Dial.base#Stale]]` and a `## Drift` section, stdout is `created <vault>/Inbox/Dial Review 2026-11-15.md`, and the exit code is 0

#### Scenario: Vault without Dial notes
- **WHEN** a registered vault has neither `Projects/` nor `Changes/`
- **THEN** no file is written into it and stdout includes `skipped <vault>: no Dial notes`

#### Scenario: Missing flag
- **WHEN** `dial review` is run
- **THEN** stderr is `dial: review needs --week`, the exit code is 1, and nothing is written

### Requirement: The review's drift totals carry their denominator
The review's `## Drift` SHALL hold the lines `- unarchived: <n>`, `- broken: <n>` and `- aging: <n>`, each the sum over the vault's repo notes whose `## Drift` line for it is observed, followed by `(<k> of <N> repos)`.

#### Scenario: One repo without a graph
- **WHEN** the vault has three repo notes, two with `- broken: 1` and one with `- broken: unobserved: interlock drift: no graph has been built — run /interlock:bootstrap once`
- **THEN** the review holds `- broken: 2 (2 of 3 repos)`

### Requirement: Review asks three questions of each stale item
For each change note in the vault with `stale: true`, the review SHALL have a `### [[<repo>--<change>]] · <state> · <idle>d` heading followed by exactly three unticked checkboxes: `- [ ] archive: \`openspec archive <change>\` in <repo>`, `- [ ] drop: \`dial drop <repo> <change>\``, `- [ ] re-spec: \`/interlock:spec <change>\``. A vault with no stale item SHALL say `No stale items.` instead.

#### Scenario: One stale item
- **WHEN** `Changes/katipon--add-login.md` has `stale: true`, `state: spec-draft`, and its `last_activity` is 21 days before the current time
- **THEN** the review holds `### [[katipon--add-login]] · spec-draft · 21d` followed by the archive, drop and re-spec checkboxes naming `add-login` and `katipon`

#### Scenario: Nothing stale
- **WHEN** no change note in the vault is stale
- **THEN** the review holds the line `No stale items.` and no checkbox

### Requirement: Review is idempotent for the day and never deletes
When `Inbox/Dial Review YYYY-MM-DD.md` for today already exists, review SHALL leave it byte for byte, print `unchanged <path>`, and exit 0. Review SHALL never delete, move or rewrite any other note, and SHALL write only into registered vaults, never into `.obsidian/`.

#### Scenario: Run twice on the same day
- **WHEN** `dial review --week` is run twice on 2026-11-15 and a checkbox was ticked by hand between the runs
- **THEN** the file keeps the ticked checkbox, stdout of the second run is `unchanged <vault>/Inbox/Dial Review 2026-11-15.md`, and the exit code is 0

#### Scenario: A new week leaves the old review
- **WHEN** review runs on 2026-11-15 and again on 2026-11-22
- **THEN** both `Inbox/Dial Review 2026-11-15.md` and `Inbox/Dial Review 2026-11-22.md` exist and the first is unchanged
