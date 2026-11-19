## MODIFIED Requirements

### Requirement: Hooks never block a session
Every hook script SHALL wrap its work in one top-level guard, exit 0 on every path, write nothing to stdout except the SessionStart envelope, and on any failure (an exception, a CLI the hook waits for exiting non-zero, a CLI the record or sync-on-event hook waits for exiting 0 with a stderr line, which is how `dial record` reports its failure, or the SessionEnd hook failing to start the CLI) write exactly one stderr line `dial <hook> hook error (ignored): <message>`, where `<hook>` is `brief`, `record` or `sync-on-event` and `<message>` is the CLI's stderr (its first line when it exited 0) or the failure's message. A hook SHALL end by setting the exit code and letting stdout drain, never by a hard exit that can cut the SessionStart envelope short.

#### Scenario: CLI fails under record
- **WHEN** the CLI run by the PreCompact record hook exits 1 with the stderr line `dial: boom`
- **THEN** the record hook writes exactly one stderr line `dial record hook error (ignored): dial: boom` and exits 0

#### Scenario: Record fails with exit 0 under the hook
- **WHEN** the real `dial record --event PreCompact` run by the record hook exits 0 with the stderr line `dial: vault personal for katipon does not exist: <path>`
- **THEN** the record hook writes exactly one stderr line `dial record hook error (ignored): dial: vault personal for katipon does not exist: <path>` and exits 0

#### Scenario: A large envelope reaches Claude Code whole
- **WHEN** the SessionStart hook relays an envelope longer than 64 KiB through a pipe
- **THEN** every byte of it is on the hook's stdout

#### Scenario: Exception inside the hook
- **WHEN** the sync-on-event hook throws `boom`
- **THEN** stderr is the one line `dial sync-on-event hook error (ignored): boom`, stdout is empty, and the exit code is 0

#### Scenario: Non-SessionStart hooks are silent on stdout
- **WHEN** the SessionEnd, PreCompact or PostToolUse hook succeeds
- **THEN** its stdout is empty

### Requirement: SessionEnd and PreCompact record the session
For a registered repo the PreCompact hook SHALL run `dial record --event PreCompact` and wait for it, passing the hook payload unchanged on the CLI's stdin. The SessionEnd hook SHALL instead start `dial record --event SessionEnd` as a detached process with the payload unchanged on its stdin, its stdout discarded and its stderr appended to `<home>/logs/record.err.log`, and SHALL exit without waiting for it, holding none of the hook's own stdio open, so the hook returns inside Claude Code's SessionEnd budget and the run outlives it.

#### Scenario: SessionEnd forwards the payload
- **WHEN** the SessionEnd hook receives `{"session_id":"s1","cwd":"/Users/caro/IdeaProjects/katipon","reason":"exit","transcript_path":"/t.jsonl"}`
- **THEN** the CLI runs `record --event SessionEnd` with that JSON on stdin and the hook exits 0

#### Scenario: PreCompact forwards the payload
- **WHEN** the PreCompact hook receives a payload with `trigger` `auto`
- **THEN** the CLI runs `record --event PreCompact` with that payload on stdin

#### Scenario: SessionEnd returns before the record run ends
- **WHEN** the SessionEnd hook runs for a registered repo and the CLI takes 3 seconds
- **THEN** the hook has exited 0 with its stdout and stderr closed within 1 second, and the CLI still receives the whole payload and finishes

#### Scenario: PreCompact waits for the record run
- **WHEN** the PreCompact hook runs for a registered repo and the CLI takes 2 seconds
- **THEN** the hook exits only after the CLI has finished

#### Scenario: The record run's stderr is kept
- **WHEN** the CLI started by the SessionEnd hook writes `dial: boom` to stderr and exits 0, with or without an existing `<home>/logs/`
- **THEN** the hook's own stderr is empty and `<home>/logs/record.err.log` gains the line `dial: boom`

#### Scenario: The error log cannot be opened
- **WHEN** `<home>/logs/record.err.log` cannot be opened for appending
- **THEN** the CLI is still started with the payload, its stderr is discarded, the hook's stderr is empty, and the exit code is 0
