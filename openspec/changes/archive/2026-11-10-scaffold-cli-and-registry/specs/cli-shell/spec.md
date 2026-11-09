# Spec Delta

## Purpose

The command-line contract of the `dial` binary: how arguments are parsed, commands dispatched, output and errors reported, and exit codes chosen, so every tool, hook and person that drives Dial can rely on one shape.

## ADDED Requirements

### Requirement: Usage is printed on request and never as an error
The binary SHALL print its usage text to stdout and exit 0 when invoked with no command, with the command `help`, or with `--help` anywhere on the command line. The usage text SHALL start with the line `dial — ` followed by a one-line tagline, list every command with a one-line description, and end with an `Environment:` line naming every environment variable the binary reads.

#### Scenario: Bare invocation
- **WHEN** `dial` is run with no arguments
- **THEN** usage is written to stdout, stderr is empty, and the exit code is 0

#### Scenario: Help after a command
- **WHEN** `dial repos --help` is run
- **THEN** usage is written to stdout and the exit code is 0

#### Scenario: Usage names every command and environment variable
- **WHEN** usage is printed
- **THEN** it contains one line for each of `version`, `limits`, `doctor`, `register`, `unregister`, `repos` and `help`, and its `Environment:` line names `DIAL_HOME`

### Requirement: The version is a command and a flag
The binary SHALL print the package version when invoked as `dial version` or `dial --version`, and SHALL exit 0.

#### Scenario: Version as text
- **WHEN** `dial version` is run
- **THEN** stdout is the version string from the package manifest followed by one newline, and the exit code is 0

#### Scenario: Version as JSON
- **WHEN** `dial version --json` is run
- **THEN** stdout is a JSON object with a single `version` key holding that string, and the exit code is 0

### Requirement: Unknown commands are refused
The binary SHALL treat a first positional argument that is not a known command as an error: usage is written to stdout, one line `dial: unknown command: <name>` is written to stderr, and the exit code is 1.

#### Scenario: Misspelled command
- **WHEN** `dial frobnicate` is run
- **THEN** stderr is exactly `dial: unknown command: frobnicate` and the exit code is 1

### Requirement: Options use one syntax and unknown options are refused
Options SHALL be accepted as `--name value` or `--name=value` and MAY appear anywhere after the command. An option the command does not define SHALL be refused with `dial: unknown option: --<name>` on stderr and exit 1. An option that requires a value and has none SHALL be refused with `dial: --<name> needs a value` and exit 1.

#### Scenario: Equals and space forms are equivalent
- **WHEN** `dial register <path> --vault=personal --host github` is run
- **THEN** the command behaves exactly as `dial register <path> --vault personal --host github`

#### Scenario: Unknown option
- **WHEN** `dial repos --colour` is run
- **THEN** stdout is empty, stderr is `dial: unknown option: --colour`, and the exit code is 1

#### Scenario: Value flag without a value
- **WHEN** `dial register <path> --vault` is run with nothing after `--vault`
- **THEN** stderr is `dial: --vault needs a value` and the exit code is 1

### Requirement: Every failure is one reason line on stderr
When a command fails, the binary SHALL exit 1 and write exactly one line to stderr of the form `dial: <reason>`, where the reason is lowercase prose that quotes values, names, paths, operating-system messages and exception messages exactly as written, with no stack trace. Success output SHALL go to stdout only. An unexpected exception SHALL be reported the same way, using the exception message as the reason.

#### Scenario: Failure writes one stderr line
- **WHEN** any command fails for a known reason
- **THEN** stderr contains exactly one line starting with `dial: ` and the exit code is 1

#### Scenario: Unexpected exception
- **WHEN** a command throws an error the binary did not anticipate
- **THEN** stderr is `dial: <error message>` with no stack trace, and the exit code is 1

### Requirement: Read commands offer JSON output
Every command that reads state — `version`, `limits`, `repos`, `doctor` — SHALL accept `--json`. With `--json`, stdout SHALL be a single JSON document indented by two spaces and followed by one newline, and the exit code SHALL be the same as in text mode.

#### Scenario: JSON is pretty-printed and parseable
- **WHEN** `dial repos --json` is run
- **THEN** stdout parses as JSON, is indented by two spaces, ends with a newline, and nothing else is written to stdout

#### Scenario: Exit code is unchanged by --json
- **WHEN** `dial doctor --json` is run and a check fails
- **THEN** stdout is the JSON report and the exit code is 1, exactly as the text mode would exit
