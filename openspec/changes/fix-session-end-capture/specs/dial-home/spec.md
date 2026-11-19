## MODIFIED Requirements

### Requirement: The home holds the remote cache and the logs at fixed paths
The home SHALL hold the remote cache at `cache/remote/<repo>.json`, one file per registered repo name, created with its directories by the first fetch that writes it; the sync log at `logs/sync.jsonl`, one JSON line appended per synced repo; the record log at `logs/record.jsonl`, one JSON line appended per `dial record` run for a registered repo; the stderr of detached record runs at `logs/record.err.log`; and the LaunchAgent's output at `logs/agent.out.log` and `logs/agent.err.log`, the paths the installed plist names.

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

#### Scenario: Each record run appends one log line
- **WHEN** `dial record --event SessionEnd` runs twice from a registered repo
- **THEN** `<home>/logs/record.jsonl` has gained exactly two lines and no earlier line has changed
