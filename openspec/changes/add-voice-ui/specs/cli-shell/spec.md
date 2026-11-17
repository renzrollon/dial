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
- **THEN** it contains one line for each of the twenty-one commands `version`, `limits`, `doctor`, `register`, `unregister`, `repos`, `help`, `vault`, `sync`, `next`, `brief`, `context`, `handoff`, `narrate`, `record`, `drop`, `agent`, `watch`, `voice`, `report` and `review`, and its `Environment:` line names `DIAL_HOME`, `DIAL_NOW`, `DIAL_LAUNCHCTL_BIN`, `DIAL_DEADLINE_MS`, `ESCAPEMENT_HOME` and `ESCAPEMENT_CHECKPOINT_URL`

#### Scenario: Usage names the subcommands
- **WHEN** usage is printed
- **THEN** the `vault` line names `init` and the `agent` line names `install`, `uninstall` and `status`

#### Scenario: The context line follows the brief line
- **WHEN** usage is printed
- **THEN** the line for `context` comes directly after the line for `brief` and names `[<repo>]` and `--json`

#### Scenario: The voice line follows the watch line
- **WHEN** usage is printed
- **THEN** the line for `voice` comes directly after the line for `watch`, names `--port`, `--model`, `--say-voice`, `--lang` and `--no-open`, and does not name `--json`

### Requirement: Every failure is one reason line on stderr
When a command fails, the binary SHALL exit 1 and write exactly one line to stderr of the form `dial: <reason>`, where the reason is lowercase prose that quotes values, names, paths, operating-system messages and exception messages exactly as written, with no stack trace. Success output SHALL go to stdout only. An unexpected exception SHALL be reported the same way, using the exception message as the reason. A command that fails for several items at once (several repos under `sync --all`, several vaults under `review --week`) SHALL fold them into that one line and keep the per-item detail in `--json`. A `dial: <path> changed during the write; skipped` warning, written while a command goes on, is not the failure line; neither is the `dial: could not open Chrome (<reason>); open the address above in Chrome` warning of `voice`. The one exception is `record`, which runs from a hook: once its command line has been parsed, every failure of `record` SHALL write the one `dial: <reason>` line and exit 0. A command line the parser refuses (an unknown option, a value option without a value) exits 1 for `record` as for every other command.

#### Scenario: Failure writes one stderr line
- **WHEN** any command other than `record` fails for a known reason
- **THEN** stderr contains exactly one line starting with `dial: ` that is not one of the warnings named above, and the exit code is 1

#### Scenario: Unexpected exception
- **WHEN** a command throws an error the binary did not anticipate
- **THEN** stderr is `dial: <error message>` with no stack trace, and the exit code is 1

#### Scenario: Record fails with exit 0
- **WHEN** `dial record --event Stop` is run, or `dial record --event SessionEnd` is run against a vault that does not exist
- **THEN** stderr is exactly one `dial: <reason>` line and the exit code is 0

#### Scenario: Record refuses an unknown option with exit 1
- **WHEN** `dial record --event SessionEnd --bogus` is run
- **THEN** stderr is exactly `dial: unknown option: --bogus` and the exit code is 1

#### Scenario: Several failed vaults are one line
- **WHEN** `dial review --week` is run and two of three vaults cannot be written
- **THEN** stderr is exactly one line `dial: 2 of 3 vaults not reviewed: <first reason>` and the exit code is 1

#### Scenario: A voice warning is not the failure line
- **WHEN** `dial voice` cannot open Chrome, keeps running, and is then interrupted
- **THEN** stderr holds the one `dial: could not open Chrome` warning and the exit code is 0

#### Scenario: A voice warning beside the failure line
- **WHEN** `dial voice` cannot open Chrome, its session is then refused, and it is interrupted
- **THEN** stderr holds exactly two lines, the `dial: could not open Chrome` warning and `dial: voice session refused: <reason>`, and the exit code is 1
