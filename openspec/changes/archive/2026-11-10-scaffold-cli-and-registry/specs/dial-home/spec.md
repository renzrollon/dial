# Spec Delta

## Purpose

Where Dial keeps its own state on this machine: the one directory named by `DIAL_HOME`, how it is resolved, created and checked for writability, and what happens when it cannot be used.

## ADDED Requirements

### Requirement: The home is resolved from DIAL_HOME with one rule and no fallback
The home directory SHALL be `~/.config/dial` when `DIAL_HOME` is unset or blank after trimming. A value of `~` or starting with `~/` SHALL be expanded against the user's home directory. Any other value SHALL be resolved to an absolute path against the current working directory. The binary SHALL never fall back to a second location when the resolved home is unusable.

#### Scenario: Default home
- **WHEN** `DIAL_HOME` is unset
- **THEN** the home is `<user home>/.config/dial`

#### Scenario: Tilde expansion
- **WHEN** `DIAL_HOME` is `~/dial-state`
- **THEN** the home is `<user home>/dial-state`

#### Scenario: Blank is the same as unset
- **WHEN** `DIAL_HOME` is set to whitespace only
- **THEN** the home is `<user home>/.config/dial`

### Requirement: The home is created on first write and left alone afterwards
A writing command SHALL create the home and its `logs/` subdirectory when they do not exist, and SHALL change no file when they already do. `version`, `limits`, `repos`, `doctor` and `help` SHALL NOT create the home. Doctor's `home` check SHALL probe without creating the directory.

#### Scenario: First register creates the layout
- **WHEN** `dial register` succeeds and the home did not exist
- **THEN** the home directory and `logs/` exist afterwards

#### Scenario: Creating twice is byte-identical
- **WHEN** the home is ensured a second time over an existing layout
- **THEN** every file under the home is byte-identical to before

#### Scenario: Reading does not create the home
- **WHEN** `dial repos` is run and the home does not exist
- **THEN** the command exits 0 and the home still does not exist

#### Scenario: Doctor does not create the home
- **WHEN** `dial doctor` is run and the home does not exist, and the nearest existing ancestor is writable
- **THEN** the home still does not exist, and the `home` check is `ok` with the detail `will be created on first register`

#### Scenario: Doctor probes an existing home
- **WHEN** `dial doctor` is run and the home already exists and is writable
- **THEN** the `home` check is `ok` and no probe file remains under the home

### Requirement: An unusable home is refused with the path and the OS error
A command that needs the home SHALL exit 1 with `dial home is not writable: <path> (<OS code>: <OS message>)` when the home cannot be created or cannot be written. A writing command SHALL prove that by creating and removing a probe file, not by inspecting permissions. Doctor SHALL report the `home` check as `fail` with that reason and SHALL keep running.

#### Scenario: Home under a read-only directory
- **WHEN** `dial register` is run with `DIAL_HOME` pointing under a directory the user cannot write
- **THEN** stderr names the resolved home path and the OS error code, the exit code is 1, and no registry file is written

#### Scenario: Home path is a file
- **WHEN** `DIAL_HOME` names an existing regular file
- **THEN** a writing command exits 1 with a reason naming that path

#### Scenario: Doctor tolerates a bad home
- **WHEN** `dial doctor` is run and the home is unusable
- **THEN** doctor still runs, reports the `home` check as failing with that reason, and exits 1
