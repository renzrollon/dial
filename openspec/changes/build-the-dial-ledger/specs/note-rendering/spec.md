# Spec Delta

## Purpose

The content of every file Dial writes into a vault: the change note, the repo note, the narrative entry, the daily log line, `Dial Summary.md`, `Dial.base` and the templates, which sections a human owns and Dial preserves, and the metadata-only rule that keeps diffs, file bodies and secrets out of every vault.

## ADDED Requirements

### Requirement: A change note's frontmatter has a fixed key order
A change note SHALL open with flat frontmatter whose Dial-owned keys appear in this order: `title, type, repo, change, scope, state, needs_me, stale, branch, pr, pr_state, ci, merge_verdict, tasks_done, tasks_total, last_commit, last_session, last_activity, created, updated, status, tags, aliases, dial_schema`, then `dropped` and `archived` when set. `title` SHALL be `<repo> — <change>`, `type` `change`, `scope` the vault name, `tags` `[dial]`, `aliases` `[]`, `dial_schema` `dial.change/1`.

#### Scenario: A new change note
- **WHEN** `dial sync katipon` renders the change `add-login` of repo `katipon` in vault `personal` for the first time on 2026-11-10
- **THEN** the frontmatter keys appear exactly in the order above, with `title: katipon — add-login`, `type: change`, `repo: katipon`, `change: add-login`, `scope: personal`, `created: 2026-11-10`, `updated: 2026-11-10`, `status: active`, `tags: [dial]`, `aliases: []`, `dial_schema: dial.change/1`, and no `dropped` or `archived` key

#### Scenario: Dropped and archived follow the schema marker
- **WHEN** a change note carries `dropped: 2026-11-08` and is later moved to `Archive/Changes/` on 2026-12-20
- **THEN** the last three Dial-owned keys are `dial_schema: dial.change/1`, `dropped: 2026-11-08`, `archived: 2026-12-20`, and `status` is `archived`

#### Scenario: Status of an archived-state note not yet moved
- **WHEN** a change's state is `archived` and its archive date is within `archivedKeepDays`
- **THEN** the note stays in `Changes/` with `state: archived` and `status: active`

#### Scenario: No PR is an observed absence
- **WHEN** the branch has no PR and `gh` reported none
- **THEN** `pr: none` and `pr_state: none` are written, not `unobserved`

### Requirement: Frontmatter values are written as flat scalars with one quoting rule
Every frontmatter value SHALL be one line. Booleans and integers SHALL be bare; dates SHALL be `YYYY-MM-DD` and timestamps ISO 8601, bare. A string SHALL be double-quoted, with `\` and `"` backslash-escaped, when it contains `: ` or `#`, starts with one of `- ? [ ] { } , & * ! | > ' " % @` or a backtick, or would read back as a boolean or an integer. Every other string SHALL be bare. `tags` and `aliases` SHALL be flow lists.

#### Scenario: A branch with a colon-space is quoted
- **WHEN** the branch is `fix: login`
- **THEN** the line is `branch: "fix: login"`

#### Scenario: A hash is quoted
- **WHEN** the change is named `fix#12`
- **THEN** the line is `change: "fix#12"`

#### Scenario: A URL and a timestamp stay bare
- **WHEN** `pr` is `https://github.com/renzrollon/interlock/pull/38` and `last_session` is `2026-11-09T22:17:00+08:00`
- **THEN** both lines are written without quotes

#### Scenario: A numeric-looking string is quoted
- **WHEN** the branch is named `1234`
- **THEN** the line is `branch: "1234"` while `tasks_done: 9` stays bare

### Requirement: A change note has a fixed section order ending in the generated State table
After the frontmatter a change note SHALL hold `## Next`, then `## Narrative`, then every other `##` section a human added in its original order, then `## State  <!-- dial:generated, do not edit -->` as the last section. The State section SHALL be a table with the header `| fact | value | evidence |`, first the row `state`, then one row per evidence row, and SHALL be rebuilt from the facts on every render, whatever the note held.

#### Scenario: A new note gets empty human sections
- **WHEN** a change note is rendered for the first time
- **THEN** the body is `## Next`, `## Narrative`, then the State heading with exactly two spaces before `<!-- dial:generated, do not edit -->`, and the Next and Narrative sections are empty

#### Scenario: A human section stays before State
- **WHEN** a human added `## Links` after `## Narrative`
- **THEN** a re-render keeps `## Links` with its body between `## Narrative` and the State heading

#### Scenario: A deleted generated section is rebuilt identically
- **WHEN** a human deletes the `## State` section from a note and `dial sync` runs on unchanged facts on the same day as the sync that last wrote it
- **THEN** the note's bytes equal those before the deletion
- **AND** on a later day the State section is rebuilt the same way and `updated` becomes that day, because the file was rewritten

#### Scenario: An edited State table is overwritten
- **WHEN** a human edits a cell in the State table
- **THEN** the next render replaces the table with the one derived from the facts

#### Scenario: A pipe inside a cell is escaped
- **WHEN** an evidence string contains `|`
- **THEN** the cell carries `\|` and the table keeps three columns

### Requirement: Human-owned content and unknown keys survive every render
A re-render SHALL copy `## Next`, `## Narrative` and every human-added section byte for byte, SHALL keep every frontmatter key Dial does not own as written, after Dial's keys in their original order, SHALL keep `created`, `dropped` and `archived` once written Rendering twice from the same facts SHALL yield identical bytes. A note with CRLF line endings SHALL be read the same way: its `---\r\n` block is its frontmatter, so a render, `dial drop` or an archive move edits that block in place and never adds a second one.

#### Scenario: Edited Next and Narrative survive
- **WHEN** a human rewrites two `## Next` lines and adds a paragraph to `## Narrative`, then `dial sync` runs
- **THEN** both sections are byte-identical to the human's text

#### Scenario: Unknown keys survive
- **WHEN** the note's frontmatter holds `source: meeting` and `aliases: [login work]`
- **THEN** after a render `source: meeting` is still present and `aliases` is still `[login work]`

#### Scenario: A CRLF note keeps one frontmatter block
- **WHEN** `Changes/katipon--add-login.md` was saved with CRLF line endings and `dial drop katipon add-login` runs
- **THEN** the note holds exactly one frontmatter block, with `state: dropped`, its `repo` key kept, and its other lines still ending in CRLF

### Requirement: updated changes only when the file does
Dial SHALL decide `updated` by rendering the note with its existing `updated` value. When those bytes equal the file on disk the file SHALL NOT be written; otherwise `updated` SHALL be set to today and the note rendered again.

#### Scenario: Nothing changed, nothing written
- **WHEN** `dial sync` runs on 2026-11-12 with the same facts as the sync on 2026-11-10
- **THEN** `updated` stays `2026-11-10` and the file is not rewritten

#### Scenario: A state change bumps updated
- **WHEN** the state moves from `shipping` to `pr-open` on 2026-11-12
- **THEN** `updated` becomes `2026-11-12` and `created` keeps its first value

### Requirement: Written notes carry no value computed from the clock
No file Dial writes into a vault, other than the weekly review note, SHALL carry idle days or any other value that changes with the clock alone; activity SHALL be written as the `last_activity` key (the item's `lastActivity` timestamp, or `unobserved`) or its local date. The only clock-dependent values in a note SHALL be `stale`, `created`, `updated`, `dropped` and `archived`. The `last activity` row of the State table SHALL hold the timestamp.

#### Scenario: A quiet day writes nothing
- **WHEN** `dial sync katipon` runs on 2026-11-10 and again on 2026-11-11 with the same facts and no item crossing `staleDays`
- **THEN** the second sync writes no note, and `Dial Summary.md` is unchanged

#### Scenario: Crossing staleDays is a real change
- **WHEN** an item's idle days go from 14 to 15 with `staleDays` 14 between two syncs
- **THEN** its note is rewritten with `stale: true` and `updated` set to the second day

### Requirement: A repo note has generated Changes, Drift, Recent narrative and State sections
`Projects/<repo>.md` SHALL carry the keys `title, type, repo, scope, state, needs_me, stale, branch, dirty, stash, ahead, behind, worktrees, last_commit, last_session, last_activity, active_changes, created, updated, status, tags, aliases, dial_schema` in that order, with `title` the repo name, `type: repo`, `dial_schema: dial.repo/1`, then `## Next`, `## Narrative`, and the generated `## Changes`, `## Drift`, `## Recent narrative`, `## State`, under the same preservation rule as a change note.

#### Scenario: Changes table links every item
- **WHEN** repo `katipon` has the items `add-login` (`pr-open`, needs me, last activity 2026-11-08T21:00:00.000Z) and `fix-cache` (`shipping`, last activity 2026-11-10T08:00:00.000Z), with `TZ=UTC`
- **THEN** `## Changes` holds a table with the header `| change | state | needs_me | last activity |` and the rows `| [[katipon--add-login]] | pr-open | true | 2026-11-08 |` and `| [[katipon--fix-cache]] | shipping | false | 2026-11-10 |`, ordered by the state priority list, and an item with no observed activity shows `—`

#### Scenario: Repo-level state
- **WHEN** the repo has no `openspec/` directory and no PR
- **THEN** the repo note has `state: idle` and `needs_me: false`

#### Scenario: Drift is unobserved without interlock
- **WHEN** `interlock` is not on PATH during `dial sync`
- **THEN** `## Drift` holds `unobserved: interlock: not on PATH`

#### Scenario: Drift counts
- **WHEN** the drift fact holds two unarchived changes, `broken` 1 and `aging` 3
- **THEN** `## Drift` holds exactly the lines `- unarchived: 2`, `- broken: 1`, `- aging: 3`

#### Scenario: Drift with no graph
- **WHEN** the drift fact holds no unarchived change and `broken` and `aging` are `unobserved: interlock drift: no graph has been built — run /interlock:bootstrap once`
- **THEN** `## Drift` holds `- unarchived: 0`, `- broken: unobserved: interlock drift: no graph has been built — run /interlock:bootstrap once` and the same reason for `- aging:`

#### Scenario: Recent narrative holds three entries
- **WHEN** the repo's change notes hold five narrative entries in total
- **THEN** `## Recent narrative` holds the three newest, newest first, each heading followed by ` · [[<repo>--<change>]]` and then its body as written

### Requirement: A narrative entry is a dated heading labelled with its source
Each entry in `## Narrative` SHALL start with the heading `### YYYY-MM-DD HH:mm · <source>` in local time, followed by its body. Entries SHALL be ordered newest first. The source labels SHALL be `dial handoff` by default, `/dial:handoff (claude)` from the skill and `local model (<model id>)` from narrate.

#### Scenario: Skill entry heading
- **WHEN** the handoff skill writes an entry at 22:20 local time on 2026-11-09
- **THEN** the heading is `### 2026-11-09 22:20 · /dial:handoff (claude)`

#### Scenario: Newest first
- **WHEN** a note holds an entry dated 2026-11-09 22:20 and a new one is written at 2026-11-10 09:05
- **THEN** the 2026-11-10 entry is the first `###` heading under `## Narrative`

#### Scenario: Local model label
- **WHEN** narrate writes an entry with the model `mtplx-qwen38-27b-optimized-speed`
- **THEN** the heading ends with `· local model (mtplx-qwen38-27b-optimized-speed)`

### Requirement: Daily log lines have two fixed shapes
A transition line SHALL be `- HH:mm dial · <repo>/<change>: <from> → <to> (<detail>) [[<repo>--<change>]]`, where `<detail>` is the evidence of the new state's matched signal. A handoff line SHALL be `- HH:mm dial · <repo>/<change>: handoff (<source>) [[<repo>--<change>]]`, or `- HH:mm dial · <repo>: handoff (<source>) [[<repo>]]` for a repo-note handoff. `HH:mm` SHALL be local time.

#### Scenario: Transition line
- **WHEN** `specflow/clear-the-directory-validation-findings` moves from `shipping` to `pr-open` at 22:20 with the evidence `verdict HUMAN`
- **THEN** the line is `- 22:20 dial · specflow/clear-the-directory-validation-findings: shipping → pr-open (verdict HUMAN) [[specflow--clear-the-directory-validation-findings]]`

#### Scenario: Handoff line
- **WHEN** `dial handoff katipon add-login --source "/dial:handoff (claude)"` runs at 09:05
- **THEN** the line is `- 09:05 dial · katipon/add-login: handoff (/dial:handoff (claude)) [[katipon--add-login]]`

#### Scenario: Repo-note handoff line
- **WHEN** `dial handoff katipon --text "paused"` runs at 18:00 with no change
- **THEN** the line is `- 18:00 dial · katipon: handoff (dial handoff) [[katipon]]`

### Requirement: Dial Summary.md lists needs-me items as short bullets
`Dial Summary.md` at the vault root SHALL hold frontmatter `type: note`, `tags: [dial]`, `dial_schema: dial.summary/1` in that order, then `Needs me: <n>` counting the vault's needs-me items, then one bullet per item `- [[<note>]] · <state> · <last activity date>` (`—` when unobserved), ordered by the state priority list, then oldest last activity first, then note name, and capped at `nextRows` bullets, followed by `- … and <n> more` when capped. It SHALL contain no table.

#### Scenario: Two items
- **WHEN** the vault holds `katipon/add-login` (`pr-open`, `last_activity` 2026-11-08T21:00:00.000Z) and `specflow/fix-docs` (`halted`, `last_activity` 2026-11-05T09:00:00.000Z) as its only needs-me items, with `TZ=UTC`
- **THEN** after the frontmatter the body is `Needs me: 2`, `- [[katipon--add-login]] · pr-open · 2026-11-08`, `- [[specflow--fix-docs]] · halted · 2026-11-05`

#### Scenario: A repo-level item links the repo note
- **WHEN** repo `katipon` has an unattributed branch in `conflict` with `last_activity` on 2026-11-09
- **THEN** the summary carries `- [[katipon]] · conflict · 2026-11-09`

#### Scenario: Capped at nextRows
- **WHEN** `nextRows` is 2 and the vault has five needs-me items
- **THEN** the body is `Needs me: 5`, two item bullets and `- … and 3 more`

#### Scenario: No table
- **WHEN** the summary is rendered with any number of items
- **THEN** no line of the file starts with `|`

#### Scenario: Nothing needs me
- **WHEN** no item in the vault needs the human
- **THEN** the body is the single line `Needs me: 0`

### Requirement: The summary is rebuilt from the vault's notes once per sync
The summary's items SHALL be read from the frontmatter of every `Changes/*.md` and `Projects/*.md` note in the vault whose `repo` is registered to that vault, after the sync's note writes (under `--dry-run`, from the planned contents, so the printed verb is the one a real sync would use). The summary SHALL be written once per vault, after the last repo of the sync, and its write SHALL count toward no repo's `written` total.

#### Scenario: A one-repo sync keeps the other repos
- **WHEN** the summary lists `specflow--fix-docs` and `dial sync katipon` runs
- **THEN** the rewritten summary still lists `specflow--fix-docs`, read from `Changes/specflow--fix-docs.md`

#### Scenario: An unregistered repo's notes are not counted
- **WHEN** `Changes/old-repo--x.md` has `needs_me: true` and `old-repo` is no longer registered
- **THEN** the summary does not list it

### Requirement: Note filenames are sanitised slugs
Dial SHALL name notes `Projects/<repo>.md` and `Changes/<repo>--<change>.md`, replacing every character in `: / \ ? * " < > | # ^ [ ]` in the repo or change name with `-`. Every wikilink Dial writes SHALL use the sanitised name without `.md`. Names SHALL NOT be converted to Title Case.

#### Scenario: Forbidden characters are replaced
- **WHEN** repo `katipon` has a change named `fix#12:cache`
- **THEN** the note is `Changes/katipon--fix-12-cache.md` and its wikilink is `[[katipon--fix-12-cache]]`

#### Scenario: Case is kept
- **WHEN** the repo is `beta-rabbitdeploy`
- **THEN** the repo note is `Projects/beta-rabbitdeploy.md`

### Requirement: Dial.base has four views grouped by the state priority list
`Dial.base` SHALL filter on `type == "change"` and define four views: `Needs me` (kanban, `needs_me == true` and `state != "archived"`, grouped by `note.state`), `In flight` (table, `state == "queued" || state == "shipping"`), `Stale` (table, `stale == true`) and `By repo` (table, grouped by `note.repo`). The `Needs me` `groupOrder` SHALL equal the state priority list.

#### Scenario: Four named views
- **WHEN** `Dial.base` is read as YAML after `dial vault init personal`
- **THEN** `views` holds four entries named `Needs me`, `In flight`, `Stale`, `By repo`, of types `kanban`, `table`, `table`, `table`

#### Scenario: Group order is the priority list
- **WHEN** the `Needs me` view's `groupOrder` is read
- **THEN** it is `[archived, dropped, archive-pending, conflict, ci-red, needs-fix, manual-test, pr-open, shipped, halted, shipping, queued, checkpoint, spec-draft]`

### Requirement: The shipped templates carry the skeletons and the agent rules
The package SHALL ship `Dial Change.md` (a `## Next` then `## Narrative` skeleton with no `## State`), `Dial.base`, `Dial Queries.md` (worked prompts for an agent over Dial notes), `Daily.md` (frontmatter with `type: daily`, then `## Log`) and `AGENTS-dial-section.md`, which SHALL state that `type: change` and `type: repo` extend the vault's `type` enum, that Dial filenames are slugs rather than Title Case, and that `## State` is generated while `## Next` and `## Narrative` are human-owned.

#### Scenario: Change template skeleton
- **WHEN** `Templates/Dial Change.md` is read after `dial vault init personal`
- **THEN** it holds `## Next` followed by `## Narrative` and no `## State` heading

#### Scenario: Daily template
- **WHEN** `Templates/Daily.md` is read after `dial vault init personal`
- **THEN** its frontmatter holds `type: daily` and its body holds a `## Log` heading

#### Scenario: AGENTS section states the exceptions
- **WHEN** `templates/AGENTS-dial-section.md` is read
- **THEN** it names `type: change` and `type: repo` and states the filename exception

### Requirement: Unobserved facts are printed as unobserved with their reason
A fact Dial could not observe SHALL be written as the bare value `unobserved` in frontmatter and as `unobserved: <reason>` in the value cell of the State table, with its evidence or `—` in the evidence cell. Dial SHALL NOT write a default value in place of an unobserved fact.

#### Scenario: CI unobserved
- **WHEN** `gh` is not on PATH during a sync under `--remote`
- **THEN** the frontmatter carries `ci: unobserved` and the State table row is `| ci | unobserved: gh: not on PATH | — |`

#### Scenario: Git missing
- **WHEN** `git` is not on PATH
- **THEN** `branch`, `dirty`, `stash`, `ahead`, `behind` and `last_commit` in the repo note are each `unobserved`, not `0` or empty

### Requirement: Written files carry metadata only
Dial SHALL NOT write a diff, a file's contents, a token, an environment variable's value or an API key into any vault file. Before writing, every fact value, evidence string and narrative entry Dial authors SHALL have each secret-looking string replaced by `[redacted]`: a word starting `ghp_`, `gho_`, `ghr_`, `ghs_`, `ghu_`, `github_pat_`, `glpat-`, `glptt-`, `gldt-`, `sk-`, `AKIA` or `xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, `xoxs-`; `Bearer ` and the word after it; an assignment, `=` or `:` form, bare or quoted, to a key whose name contains `password`, `passwd`, `secret`, `token`, `apikey`, `api_key`, `api-key` or ends `_key`/`-key` (in any letter case), with its value word; `export <NAME>=` and the rest of its word; a whole line containing `-----BEGIN` or `diff --git`.

#### Scenario: Common token shapes are redacted
- **WHEN** a narrative entry holds `github_pat_11ABC`, `gho_x`, `ghs_y`, `xoxb-1-2`, `AWS_SECRET_ACCESS_KEY: abc`, `"apiKey": "zz"` and `api_key=q`
- **THEN** each of them is written as `[redacted]`

#### Scenario: Planted strings never reach the vault
- **WHEN** a fixture vault is synced from facts whose branch names and commit subjects contain `ghp_abc123`, `glpat-xyz`, `sk-live1`, `AKIAEXAMPLE`, `Bearer abc`, `password=hunter2`, `token=t0k`, `diff --git a/x b/x` and `export API_KEY=v`
- **THEN** no written file matches `-----BEGIN`, `diff --git`, `Bearer `, `password=`, `token=`, `export [A-Z_]+=`, or `(^|[^A-Za-z0-9_-])(ghp_|glpat-|sk-|AKIA)`, the prefixes matched only at the start of a word
- **AND** a written file containing the change name `risk-model` still passes the check

#### Scenario: Human-written bytes are preserved
- **WHEN** a human typed text into `## Next` by hand
- **THEN** Dial copies that section byte for byte and does not redact it

### Requirement: Redaction matches whole words and never renames a note
A redaction prefix SHALL match only at the start of a word: at the start of the text or after a character outside `[A-Za-z0-9_-]`. Repo and change names in filenames, wikilinks and the `repo`, `change` and `title` keys SHALL NOT be redacted, because a note's name must match its change. The patterns SHALL run on the text as written, and a match SHALL be left alone only when it consists of repo and change names and the separators `-`, `_`, `.` and `/` alone; a name that overlaps a pattern's trigger word SHALL NOT shield the secret beside it.

#### Scenario: A change named like a trigger word does not shield a secret
- **WHEN** a change is named `export` or `token` and its narrative holds `export AWS_SECRET_ACCESS_KEY=abcd1234` or `token=abc123secret`
- **THEN** the written note holds `[redacted]` in their place and the change name is written unredacted elsewhere

#### Scenario: Ordinary words are not redacted
- **WHEN** a change is named `risk-model`
- **THEN** the note is `Changes/<repo>--risk-model.md` and the name is written unredacted
