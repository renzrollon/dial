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
- **THEN** it contains one line for each of the twenty-three commands `version`, `limits`, `doctor`, `register`, `unregister`, `repos`, `help`, `vault`, `sync`, `next`, `brief`, `context`, `handoff`, `narrate`, `record`, `drop`, `agent`, `watch`, `voice`, `propose`, `sessions`, `report` and `review`, and its `Environment:` line names `DIAL_HOME`, `DIAL_NOW`, `DIAL_LAUNCHCTL_BIN`, `DIAL_DEADLINE_MS`, `ESCAPEMENT_HOME` and `ESCAPEMENT_CHECKPOINT_URL`

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
