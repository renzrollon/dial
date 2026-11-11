# Spec Delta

## MODIFIED Requirements

### Requirement: The home is created on first write and left alone afterwards
A writing command — `register`, `unregister`, `sync` without `--dry-run`, `record` and `watch` (which sync), and `agent install` — SHALL create the home and its `logs/` subdirectory when they do not exist, and SHALL change no file when they already do. `version`, `limits`, `repos`, `doctor`, `help`, `next`, `brief`, `report` and every other command SHALL NOT create the home. Doctor's `home` check SHALL probe without creating the directory.

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

## ADDED Requirements

### Requirement: The home holds the remote cache and the logs at fixed paths
The home SHALL hold the remote cache at `cache/remote/<repo>.json`, one file per registered repo name, created with its directories by the first fetch that writes it; the sync log at `logs/sync.jsonl`, one JSON line appended per synced repo; and the LaunchAgent's output at `logs/agent.out.log` and `logs/agent.err.log`, the paths the installed plist names.

#### Scenario: Remote sync writes the cache file
- **WHEN** `dial sync katipon --remote` fetches successfully and the home exists without `cache/`
- **THEN** `<home>/cache/remote/katipon.json` exists afterwards and its `dial_schema` is `dial.cache/1`

#### Scenario: A sync without --remote writes no cache
- **WHEN** `dial sync katipon` is run without `--remote` and no cache file exists
- **THEN** `<home>/cache/` does not exist afterwards

#### Scenario: Each sync appends one log line per repo
- **WHEN** `dial sync --all` is run with two registered repos
- **THEN** `<home>/logs/sync.jsonl` has gained exactly two lines, each a JSON object with `ts`, `vault`, `repo`, `needsMe` and `items`, and no earlier line has changed

#### Scenario: The quality set lives under the home
- **WHEN** the human has placed transcript tails under `<home>/eval/items/` and runs `dial narrate --eval <home>/eval`, then later `dial report`
- **THEN** the outputs are written to `<home>/eval/outputs/<id>.md`, `dial report` reads `<home>/eval/labels.jsonl`, and no command creates `<home>/eval/` or `<home>/eval/items/` itself

#### Scenario: The agent logs live under the home
- **WHEN** `dial agent install` writes the plist with `DIAL_HOME=/tmp/h`
- **THEN** its `StandardOutPath` is `/tmp/h/logs/agent.out.log` and its `StandardErrorPath` is `/tmp/h/logs/agent.err.log`

### Requirement: A writing command ensures the home before it writes anything else
`sync`, `record`, `watch` and `agent install` SHALL ensure the home before any vault write, plist write or `launchctl` call. When the home cannot be created or written they SHALL fail with `dial home is not writable: <path> (<OS code>: <OS message>)`, leaving every vault, the LaunchAgents directory and the home unchanged. `sync`, `watch` and `agent install` exit 1 with that reason; `record` writes it as its one stderr line and exits 0.

#### Scenario: Sync with an unwritable home
- **WHEN** `dial sync katipon` is run with `DIAL_HOME` pointing under a directory the user cannot write
- **THEN** stderr is one line `dial: dial home is not writable: <path> (<OS code>: <OS message>)` naming the resolved home, the exit code is 1, and every file under the registered vault is byte-identical to before with none created

#### Scenario: Agent install with an unwritable home
- **WHEN** `dial agent install` is run with `DIAL_HOME` naming an existing regular file
- **THEN** stderr names that path, the exit code is 1, no plist is written under `$HOME/Library/LaunchAgents/`, and `launchctl` is not run

#### Scenario: Record with an unwritable home
- **WHEN** `dial record --event SessionEnd` is run from a registered repo with an unwritable home
- **THEN** stderr is one line naming the home path, the exit code is 0, and no vault file is changed
