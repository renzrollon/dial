# Spec Delta

## MODIFIED Requirements

### Requirement: Usage is printed on request and never as an error
The binary SHALL print its usage text to stdout and exit 0 when invoked with no command, with the command `help`, or with `--help` anywhere on the command line. The usage text SHALL start with the line `dial — ` followed by a one-line tagline, list every command with a one-line description, and end with an `Environment:` line naming every Dial-specific environment variable the binary reads: `DIAL_HOME`, `DIAL_NOW`, `DIAL_LAUNCHCTL_BIN`, `ESCAPEMENT_HOME` and `ESCAPEMENT_CHECKPOINT_URL`.

#### Scenario: Bare invocation
- **WHEN** `dial` is run with no arguments
- **THEN** usage is written to stdout, stderr is empty, and the exit code is 0

#### Scenario: Help after a command
- **WHEN** `dial repos --help` is run
- **THEN** usage is written to stdout and the exit code is 0

#### Scenario: Usage names every command and environment variable
- **WHEN** usage is printed
- **THEN** it contains one line for each of the nineteen commands `version`, `limits`, `doctor`, `register`, `unregister`, `repos`, `help`, `vault`, `sync`, `next`, `brief`, `handoff`, `narrate`, `record`, `drop`, `agent`, `watch`, `report` and `review`, and its `Environment:` line names `DIAL_HOME`, `DIAL_NOW`, `DIAL_LAUNCHCTL_BIN`, `ESCAPEMENT_HOME` and `ESCAPEMENT_CHECKPOINT_URL`

#### Scenario: Usage names the subcommands
- **WHEN** usage is printed
- **THEN** the `vault` line names `init` and the `agent` line names `install`, `uninstall` and `status`

### Requirement: Read commands offer JSON output
Every command that reads or reports state — `version`, `limits`, `repos`, `doctor`, `next`, `brief`, `sync`, `vault init`, `handoff`, `narrate`, `record`, `drop`, `agent status`, `report` and `review` — SHALL accept `--json`. With `--json`, stdout SHALL be a single JSON document indented by two spaces and followed by one newline, and the exit code SHALL be the same as in text mode. Any other command or subcommand SHALL refuse `--json` as an unknown option.

#### Scenario: JSON is pretty-printed and parseable
- **WHEN** `dial repos --json` is run
- **THEN** stdout parses as JSON, is indented by two spaces, ends with a newline, and nothing else is written to stdout

#### Scenario: Exit code is unchanged by --json
- **WHEN** `dial doctor --json` is run and a check fails
- **THEN** stdout is the JSON report and the exit code is 1, exactly as the text mode would exit

#### Scenario: New read commands accept --json
- **WHEN** `dial next --json`, `dial sync --all --dry-run --json` or `dial agent status --json` is run
- **THEN** none of them is refused with `unknown option: --json`, and each stdout is one two-space-indented JSON document ending with a newline

#### Scenario: A command without JSON output refuses the flag
- **WHEN** `dial watch --json` or `dial agent install --json` is run
- **THEN** stdout is empty, stderr is `dial: unknown option: --json`, and the exit code is 1

## ADDED Requirements

### Requirement: The vault and agent commands dispatch on a subcommand
`vault` SHALL take the subcommand `init`, and `agent` SHALL take `install`, `uninstall` or `status`, as the first positional argument after the command. A missing subcommand SHALL be refused with `dial: vault needs one of init` or `dial: agent needs one of install, uninstall, status`; an unrecognised one with `dial: unknown vault subcommand: <x>` or `dial: unknown agent subcommand: <x>`. Each refusal exits 1 with empty stdout. Options are checked against the subcommand.

#### Scenario: Vault without a subcommand
- **WHEN** `dial vault` is run
- **THEN** stdout is empty, stderr is exactly `dial: vault needs one of init`, and the exit code is 1

#### Scenario: Unknown vault subcommand
- **WHEN** `dial vault create personal` is run
- **THEN** stderr is exactly `dial: unknown vault subcommand: create` and the exit code is 1

#### Scenario: Agent without a subcommand
- **WHEN** `dial agent` is run
- **THEN** stdout is empty, stderr is exactly `dial: agent needs one of install, uninstall, status`, and the exit code is 1

#### Scenario: Unknown agent subcommand
- **WHEN** `dial agent restart` is run
- **THEN** stderr is exactly `dial: unknown agent subcommand: restart` and the exit code is 1

#### Scenario: Help after a subcommand
- **WHEN** `dial agent --help` or `dial vault init --help` is run
- **THEN** usage is written to stdout and the exit code is 0

#### Scenario: Option checked against the subcommand
- **WHEN** `dial vault init personal --force` is run
- **THEN** `--force` is accepted, while `dial agent status --force` exits 1 with `dial: unknown option: --force`

### Requirement: DIAL_NOW overrides the clock
When `DIAL_NOW` is set and not blank after trimming, every command SHALL use its value as the current time wherever it reads the clock (idle days, `stale`, note dates, daily and narrative times, log and cache timestamps, the remote due check). The value SHALL be an ISO-8601 date-time with `Z` or a `±HH:mm` offset. Any other value SHALL be refused with `dial: DIAL_NOW is not an ISO-8601 timestamp: <value>` and exit 1.

#### Scenario: Frozen clock drives idle days
- **WHEN** `DIAL_NOW=2026-11-10T09:00:00Z dial next --json` is run over a change whose newest activity is `2026-10-20T09:00:00Z`
- **THEN** that change's `idleDays` is 21 and it is `stale` with the default `staleDays` 14

#### Scenario: Same clock, same bytes
- **WHEN** `dial sync katipon` is run twice against two copies of the same repository and vault, both with `DIAL_NOW=2026-11-10T09:00:00Z`
- **THEN** the two vaults are byte-identical afterwards

#### Scenario: A value without an offset is refused
- **WHEN** `DIAL_NOW=2026-11-10T14:05:00 dial next` is run
- **THEN** stderr is exactly `dial: DIAL_NOW is not an ISO-8601 timestamp: 2026-11-10T14:05:00` and the exit code is 1

#### Scenario: Unparseable value
- **WHEN** `DIAL_NOW=yesterday dial next` is run
- **THEN** stdout is empty, stderr is exactly `dial: DIAL_NOW is not an ISO-8601 timestamp: yesterday`, and the exit code is 1

#### Scenario: Blank is the same as unset
- **WHEN** `DIAL_NOW` is set to whitespace only
- **THEN** commands use the system clock and nothing is refused

#### Scenario: A command that never reads the clock ignores it
- **WHEN** `DIAL_NOW=yesterday dial version` is run
- **THEN** stdout is the version and the exit code is 0

### Requirement: Local dates and times follow the process time zone
Local dates and times SHALL be the current instant in the process time zone (`TZ`, else the system's). Scenarios in these specs that print a local date or time assume `TZ=UTC` unless they name another zone, and the test harness SHALL run every CLI subprocess with `TZ=UTC` unless a test sets `TZ`.

#### Scenario: Local time follows TZ
- **WHEN** `TZ=Asia/Manila DIAL_NOW=2026-11-10T06:05:00Z dial handoff katipon add-login --text x` is run
- **THEN** the new narrative heading is `### 2026-11-10 14:05 · dial handoff` and the daily line goes into `Daily/2026-11-10.md`

### Requirement: Machine-read timestamps have one written form
Every timestamp Dial writes into a machine-read file (`sync.jsonl` `ts`, the remote cache `fetchedAt`) SHALL be the UTC form `YYYY-MM-DDTHH:mm:ss.sssZ` that `Date.prototype.toISOString` produces. Readers SHALL accept any ISO-8601 date-time with an offset.

#### Scenario: Written timestamps have one form
- **WHEN** `DIAL_NOW=2026-11-10T17:00:00+08:00 dial sync katipon --remote` is run and the fetch succeeds
- **THEN** the new `sync.jsonl` line has `ts` `2026-11-10T09:00:00.000Z` and the cache has `fetchedAt` `2026-11-10T09:00:00.000Z`

### Requirement: handoff collects every --next in order
`dial handoff` SHALL accept `--next <text>` any number of times, in either the space or the equals form, and SHALL keep every occurrence in the order given. A `--next` with no value SHALL be refused with `dial: --next needs a value`. Every other value option keeps one value.

#### Scenario: Two next steps in order
- **WHEN** `dial handoff katipon uat-readiness --text "Done: plan written" --next "run the plan" --next="open the PR"` is run
- **THEN** the `## Next` section of `Changes/katipon--uat-readiness.md` ends with `- [ ] run the plan` followed by `- [ ] open the PR`, and the exit code is 0

#### Scenario: No next step
- **WHEN** `dial handoff katipon --text "Done: plan written"` is run without `--next`
- **THEN** the `## Next` section of `Projects/katipon.md` is byte-identical to before

#### Scenario: Next without a value
- **WHEN** `dial handoff katipon --text "Done: x" --next` is run with nothing after `--next`
- **THEN** stderr is `dial: --next needs a value`, the exit code is 1, and no note is changed
