## RENAMED Requirements

- FROM: `### Requirement: Record finishes within the hook timeout`
- TO: `### Requirement: Record finishes within its own deadline`

## MODIFIED Requirements

### Requirement: Record finishes within its own deadline
Record SHALL take a deadline of 55 seconds from its start. Under PreCompact that sits inside the hook's 60-second timeout; under SessionEnd the run is detached, so the deadline alone bounds it. Each model call's timeout SHALL be the smaller of `narrateTimeoutSeconds` and the time left before the deadline minus 2 seconds; a call with less than 5 seconds left SHALL NOT be made and SHALL count as a failed attempt with the reason `no time left before the hook deadline`. The deadline SHALL bound the sync too: each subprocess the sync runs SHALL be killed after the smaller of `subprocessTimeoutSeconds` and the time left before the deadline minus 2 seconds, and one that would start with no time left SHALL NOT start and SHALL count as timed out. Record SHALL take the attribution from the sync's own derived view and re-read only the notes, never collecting the repo a second time.

#### Scenario: A slow primary leaves no time for the fallback
- **WHEN** the sync takes 10 seconds, `narrateTimeoutSeconds` is 30, and the primary endpoint never answers
- **THEN** the primary call is aborted after 30 seconds, the fallback call is bounded by the 13 seconds left before the deadline, and record exits 0 within 55 seconds of its start

#### Scenario: Slow git cannot outlast the deadline
- **WHEN** every `git` call hangs
- **THEN** the sync's git calls are killed by the deadline, record runs no further git call after the sync, and record returns within 55 seconds of its start

#### Scenario: No time left at all
- **WHEN** the sync takes 52 seconds
- **THEN** no model call is made, no narrative entry is written, stderr is empty, the exit code is 0, and the run's line in `logs/record.jsonl` has `miss` true

## ADDED Requirements

### Requirement: Record logs one line per run
For a registered repo every `dial record` run SHALL append one JSON line to `<home>/logs/record.jsonl` holding `ts`, `event`, `repo`, `session` (the payload's `session_id`, or null), `synced`, `narrated` and `miss`, plus `skipped`, `unobserved` or `error` when the run has one. A failed append SHALL change neither the output nor the exit code and SHALL NOT create the home. An unregistered `cwd` or a bad event name SHALL append nothing.

#### Scenario: A narrated session
- **WHEN** `dial record --event SessionEnd` narrates session `s1` of katipon at `2026-11-10T16:40:00.000Z`
- **THEN** `logs/record.jsonl` gains one line with `ts` `2026-11-10T16:40:00.000Z`, `event` `SessionEnd`, `repo` `katipon`, `session` `s1`, `synced` true, `narrated` true and `miss` false, and no earlier line has changed

#### Scenario: No model is listening
- **WHEN** both narrate endpoints refuse the connection
- **THEN** the line has `synced` true, `narrated` false, `miss` true and `unobserved` `http://127.0.0.1:11434/v1 unreachable`, stdout and stderr are empty, and the exit code is 0

#### Scenario: A failed sync is logged
- **WHEN** the sync fails because the repo's vault path does not exist
- **THEN** the line has `synced` false, `miss` true and `error` holding the sync's reason, and stderr is still exactly one line starting `dial: `

#### Scenario: A failure inside record is logged
- **WHEN** an unexpected exception ends the run after the repo was resolved
- **THEN** the line has `repo` set, `synced` false, `narrated` false, `miss` true and `error` holding the exception's message

#### Scenario: The logs folder is missing
- **WHEN** the Dial home exists without `logs/` and a record run for a registered repo ends
- **THEN** `logs/` is created and holds `record.jsonl` with the run's line

#### Scenario: Nothing is logged for an unregistered cwd
- **WHEN** the payload's `cwd` is in no registered repo
- **THEN** `logs/record.jsonl` is not created or changed and the Dial home is not created

#### Scenario: The log cannot be written
- **WHEN** the Dial home is unwritable and the sync fails
- **THEN** stderr is still exactly one line and the exit code is 0

#### Scenario: No key reaches the log
- **WHEN** the primary endpoint has the API key `sk-local-123` and the model call fails
- **THEN** `logs/record.jsonl` does not contain `sk-local-123`

### Requirement: The log line marks a missed session
A line's `miss` SHALL be false when the run narrated, when an existing narrative entry already covers the transcript, when the transcript file does not exist, and when the transcript has no text turns. It SHALL be true for every other run that has `error` or `unobserved`, and when the run was skipped because the payload names no transcript.

#### Scenario: The transcript cannot be read
- **WHEN** the transcript path exists but cannot be read as a file
- **THEN** the line has `miss` true and `unobserved` holding the read failure

#### Scenario: The transcript file does not exist
- **WHEN** the session left no file at its transcript path
- **THEN** the line has `miss` false and `unobserved` `no transcript at <path>`

#### Scenario: The payload names no transcript
- **WHEN** the payload has neither `transcript_path` nor `session_id`
- **THEN** the line has `miss` true, `session` null and `skipped` `no transcript_path or session_id in the payload`

#### Scenario: A handoff already covers the session
- **WHEN** the attributed note's newest entry is a handoff newer than the transcript's first `timestamp`
- **THEN** the line has `miss` false and `skipped` `a narrative entry is newer than the session start`

#### Scenario: A session with nothing to narrate
- **WHEN** the transcript has no text turns
- **THEN** the line has `miss` false and `unobserved` `transcript has no text turns`
