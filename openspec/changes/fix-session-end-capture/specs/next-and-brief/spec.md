## MODIFIED Requirements

### Requirement: next and brief are offline and read-only
`dial next` and `dial brief` SHALL read the registry, the repositories, the session transcripts' modification times, the remote cache and the vault notes, and `dial brief` SHALL also read the last 64 KiB of `<home>/logs/record.jsonl`. They SHALL run no subprocess other than `git`, SHALL make no network call, and SHALL NOT write any vault file, cache file or log line, nor create the Dial home.

#### Scenario: No remote or interlock call
- **WHEN** `dial next` runs with fake `gh`, `glab` and `interlock` binaries on PATH that record each invocation
- **THEN** none of them was invoked and the exit code is 0

#### Scenario: Cached PR state is used
- **WHEN** `$DIAL_HOME/cache/remote/katipon.json` holds an open PR with `fetchedAt` `2026-11-10T08:00:00.000Z`
- **THEN** the katipon row's evidence ends with `as of 2026-11-10T08:00:00.000Z`

#### Scenario: Nothing is written
- **WHEN** `dial brief katipon` and `dial next` run against a vault and a Dial home
- **THEN** a snapshot of the vault and of the Dial home is identical before and after, and a missing home is not created

### Requirement: brief prints a fixed sequence of lines for one repo
`dial brief <repo>` SHALL print, in order: `<repo> · <branch> · dirty <n> · stash <n> · last session <ago>`; `last session not captured — <reason> · <ago> ago → dial doctor` when the repo's previous session was missed; one line `<state> <change> — <evidence> → <suggested>` (` [stale]` after the state when stale) per item not `archived` or `dropped`, in `dial next` order; the newest narrative entry across the repo's notes, heading then non-empty body lines; the unticked `## Next` lines of the attributed change note, else of the repo note; then `dial next for everything else`. The previous session is the newest `SessionEnd` line of the record log for this repo whose `session` is not the one given by `--session`; it was missed when that line has `miss` true. `<reason>` is the line's `error`, `unobserved` or `skipped`, on one line and cut to 120 characters. A missing, unreadable or malformed log or line SHALL add no line and SHALL NOT fail the brief.

#### Scenario: Full brief
- **WHEN** katipon is on `feat/add-login` with 2 dirty entries, 0 stashes, a session 3 hours ago, one item `add-login` in `pr-open`, a newest entry `### 2026-11-09 22:20 · /dial:handoff (claude)` with two body lines, and two unticked Next items
- **THEN** stdout is `katipon · feat/add-login · dirty 2 · stash 0 · last session 3h ago`, `pr-open add-login — <evidence> → review and merge`, the heading, the two body lines, the two `- [ ]` lines, `dial next for everything else`

#### Scenario: Ago units
- **WHEN** the last session was 40 minutes, 5 hours and 3 days ago
- **THEN** the header ends `last session 40m ago`, `last session 5h ago` and `last session 3d ago` respectively

#### Scenario: Unobserved header values
- **WHEN** `git` is not on PATH and no transcript exists
- **THEN** the header is `katipon · unobserved · dirty unobserved · stash unobserved · last session unobserved`

#### Scenario: Detached head
- **WHEN** HEAD is detached at `7682fbf`
- **THEN** the branch field is `detached 7682fbf`

#### Scenario: No changes and no narrative
- **WHEN** the repo has no items and no narrative entry
- **THEN** stdout is the header line then `dial next for everything else`

#### Scenario: Ticked Next items are left out
- **WHEN** the attributed note's `## Next` holds `- [x] merge` and `- [ ] archive`
- **THEN** only `- [ ] archive` appears in the brief

#### Scenario: A missed session
- **WHEN** the newest `SessionEnd` line for katipon is 3 hours old with `miss` true and `unobserved` `http://127.0.0.1:11434/v1 unreachable`
- **THEN** the line after the header is `last session not captured — http://127.0.0.1:11434/v1 unreachable · 3h ago → dial doctor`

#### Scenario: A captured session adds no line
- **WHEN** an older `SessionEnd` line for katipon has `miss` true and the newest has `miss` false
- **THEN** the brief has no `last session not captured` line

#### Scenario: Other repos and PreCompact lines are ignored
- **WHEN** the newest line of the log belongs to another repo, and the newest katipon line is a `PreCompact` line with `miss` true after a `SessionEnd` line with `miss` false
- **THEN** the katipon brief has no `last session not captured` line

#### Scenario: The current session's own line is ignored
- **WHEN** `dial brief katipon --session s2` runs, the newest katipon `SessionEnd` line is for `s2` with `miss` false, and the one before it is for `s1` with `miss` true
- **THEN** the brief reports the miss of `s1`

#### Scenario: A torn or unreadable log adds no line
- **WHEN** the log's last line is cut off mid-JSON, or the log is missing, or `ts` does not parse
- **THEN** the unusable line is ignored, the brief still prints, and the exit code is 0

#### Scenario: Only the end of the log is read
- **WHEN** the newest katipon line lies more than 64 KiB before the end of the log
- **THEN** the brief has no `last session not captured` line

### Requirement: brief is capped at briefLines with a fixed drop order
When the brief would exceed `briefLines` lines, Dial SHALL drop lines from the end of the Next items first, then from the end of the narrative body, then the change lines of the items idle longest, then the `last session not captured` line, until the kept lines plus one fit, and SHALL replace `dial next for everything else` with `… <n> more lines, see Projects/<repo>.md`, where `<n>` is the number of lines dropped. The header line SHALL never be dropped.

#### Scenario: Next items dropped first
- **WHEN** `briefLines` is 10 and the brief has the header, three change lines, a narrative heading, three body lines, three Next items and the final line
- **THEN** stdout is ten lines: the header, three change lines, the heading, three body lines, the first Next item, and `… 2 more lines, see Projects/katipon.md`

#### Scenario: Narrative body dropped after Next items
- **WHEN** `briefLines` is 7 for the same brief
- **THEN** every Next item and the last two body lines are dropped, and the last line is `… 5 more lines, see Projects/katipon.md`

#### Scenario: Under the cap
- **WHEN** the brief has 12 lines and `briefLines` is 40
- **THEN** all 12 lines are printed and the last is `dial next for everything else`

#### Scenario: The missed-session line is dropped last
- **WHEN** `briefLines` is 3 and the brief has the header, a `last session not captured` line, two change lines and the final line
- **THEN** stdout is the header, the `last session not captured` line and `… 2 more lines, see Projects/katipon.md`
