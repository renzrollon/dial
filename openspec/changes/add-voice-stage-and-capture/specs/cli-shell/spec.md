# Spec Delta

## MODIFIED Requirements

### Requirement: Usage is printed on request and never as an error
The binary SHALL print its usage text to stdout and exit 0 when invoked with no command, with the command `help`, or with `--help` anywhere on the command line. The usage text SHALL start with the line `dial — ` followed by a one-line tagline, list every command with a one-line description, and end with an `Environment:` line naming every Dial-specific environment variable the binary reads: `DIAL_HOME`, `DIAL_NOW`, `DIAL_LAUNCHCTL_BIN`, `DIAL_DEADLINE_MS`, `ESCAPEMENT_HOME` and `ESCAPEMENT_CHECKPOINT_URL`.

#### Scenario: Bare invocation
- **WHEN** `dial` is run with no arguments
- **THEN** usage is written to stdout, stderr is empty, and the exit code is 0

#### Scenario: Help after a command
- **WHEN** `dial repos --help` is run
- **THEN** usage is written to stdout and the exit code is 0

#### Scenario: Usage names every command and environment variable
- **WHEN** usage is printed
- **THEN** it contains one line for each of the twenty-four commands `version`, `limits`, `doctor`, `register`, `unregister`, `repos`, `help`, `vault`, `sync`, `next`, `brief`, `context`, `handoff`, `capture`, `narrate`, `record`, `drop`, `agent`, `watch`, `voice`, `propose`, `sessions`, `report` and `review`, and its `Environment:` line names `DIAL_HOME`, `DIAL_NOW`, `DIAL_LAUNCHCTL_BIN`, `DIAL_DEADLINE_MS`, `ESCAPEMENT_HOME` and `ESCAPEMENT_CHECKPOINT_URL`

#### Scenario: Usage names the subcommands
- **WHEN** usage is printed
- **THEN** the `vault` line names `init` and the `agent` line names `install`, `uninstall` and `status`

#### Scenario: The context line follows the brief line
- **WHEN** usage is printed
- **THEN** the line for `context` comes directly after the line for `brief` and names `[<repo>]` and `--json`

#### Scenario: The voice line follows the watch line
- **WHEN** usage is printed
- **THEN** the line for `voice` comes directly after the line for `watch`, names `--port`, `--model`, `--say-voice`, `--lang` and `--no-open`, and does not name `--json`

#### Scenario: The propose and sessions lines follow the voice lines
- **WHEN** usage is printed
- **THEN** the line for `propose` comes directly after the two lines of `voice` and names `<repo>` and `--prompt <text>`, its description on the next line names `--json` and says it starts nothing, and the line for `sessions` comes directly after that and names `--json`

#### Scenario: The capture line follows the handoff lines
- **WHEN** usage is printed
- **THEN** the line for `capture` comes directly after the two lines of `handoff` and names `--vault <name>`, `(--stdin | --text <t>)` and `[--dry-run]`, and its description on the next line names `Inbox` and `--json`

### Requirement: Read commands offer JSON output
Every command that reads or reports state — `version`, `limits`, `repos`, `doctor`, `next`, `brief`, `context`, `sync`, `vault init`, `handoff`, `capture`, `narrate`, `record`, `drop`, `agent status`, `propose`, `sessions`, `report` and `review` — SHALL accept `--json`. With `--json`, stdout SHALL be a single JSON document indented by two spaces and followed by one newline, and the exit code SHALL be the same as in text mode. Any other command or subcommand SHALL refuse `--json` as an unknown option.

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

#### Scenario: context accepts --json and no other option
- **WHEN** `dial context katipon --json` and `dial context katipon --hook` are run
- **THEN** the first prints one two-space-indented JSON document ending with a newline and exits 0, and the second exits 1 with `dial: unknown option: --hook`

#### Scenario: capture, propose and sessions accept --json
- **WHEN** `dial capture --vault personal --text x --dry-run --json`, `dial propose katipon --prompt x --json` and `dial sessions --json` are run
- **THEN** none of them is refused with `unknown option: --json`, and each stdout is one two-space-indented JSON document ending with a newline
