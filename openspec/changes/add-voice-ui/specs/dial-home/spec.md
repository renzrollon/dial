# Spec Delta

## MODIFIED Requirements

### Requirement: The home is created on first write and left alone afterwards
A writing command — `register`, `unregister`, `sync` without `--dry-run`, `record` and `watch` (which sync), `agent install`, and `voice` — SHALL create the home and its `logs/` subdirectory when they do not exist, and SHALL change no file when they already do. `voice` SHALL also create the home's `voice/` subdirectory, the working directory of its session, and Dial itself SHALL write no file into it. `version`, `limits`, `repos`, `doctor`, `help`, `next`, `brief`, `report` and every other command SHALL NOT create the home. Doctor's `home` check SHALL probe without creating the directory.

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

#### Scenario: First sync creates the layout
- **WHEN** `dial sync katipon` succeeds and the home did not exist
- **THEN** the home directory, `logs/` and `logs/sync.jsonl` exist afterwards

#### Scenario: Agent install creates the layout
- **WHEN** `dial agent install` succeeds and the home did not exist
- **THEN** the home directory and `logs/` exist afterwards

#### Scenario: A dry-run sync does not create the home
- **WHEN** `dial sync katipon --dry-run` is run and the home does not exist
- **THEN** the command exits 0 and the home still does not exist

#### Scenario: Next, brief and report do not create the home
- **WHEN** `dial next`, `dial brief katipon` or `dial report` is run and the home does not exist
- **THEN** the home still does not exist afterwards

#### Scenario: Voice creates the layout
- **WHEN** `dial voice --no-open` starts listening and the home did not exist
- **THEN** the home directory, `logs/` and `voice/` exist, and `voice/` holds no file Dial wrote

#### Scenario: A voice start that is refused creates nothing
- **WHEN** `dial voice --port 80` is run, or `dial voice` is run with no `claude` on `PATH`, and the home does not exist
- **THEN** the exit code is 1 and the home still does not exist

### Requirement: A writing command ensures the home before it writes anything else
`sync`, `record`, `watch`, `agent install` and `voice` SHALL ensure the home before any vault write, plist write or `launchctl` call, and `voice` before it listens on a port or starts a process. When the home cannot be created or written they SHALL fail with `dial home is not writable: <path> (<OS code>: <OS message>)`, leaving every vault, the LaunchAgents directory and the home unchanged. `sync`, `watch`, `agent install` and `voice` exit 1 with that reason; `record` writes it as its one stderr line and exits 0.

#### Scenario: Sync with an unwritable home
- **WHEN** `dial sync katipon` is run with `DIAL_HOME` pointing under a directory the user cannot write
- **THEN** stderr is one line `dial: dial home is not writable: <path> (<OS code>: <OS message>)` naming the resolved home, the exit code is 1, and every file under the registered vault is byte-identical to before with none created

#### Scenario: Agent install with an unwritable home
- **WHEN** `dial agent install` is run with `DIAL_HOME` naming an existing regular file
- **THEN** stderr names that path, the exit code is 1, no plist is written under `$HOME/Library/LaunchAgents/`, and `launchctl` is not run

#### Scenario: Record with an unwritable home
- **WHEN** `dial record --event SessionEnd` is run from a registered repo with an unwritable home
- **THEN** stderr is one line naming the home path, the exit code is 0, and no vault file is changed

#### Scenario: Voice with an unwritable home
- **WHEN** `dial voice` is run with `DIAL_HOME` naming an existing regular file
- **THEN** stderr is one line `dial: dial home is not writable: <path> (<OS code>: <OS message>)` naming that path, the exit code is 1, no port is bound, and neither `claude` nor `open` is run
