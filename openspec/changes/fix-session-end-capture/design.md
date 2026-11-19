# Design

## Context

See `proposal.md` for the motivation and the specs for the required behaviour. Three facts shape the approach:

- `runHook` (`hooks/common.mjs:39-79`) reads the payload, resolves the repo in-process, then blocks in `spawnSync`. Everything before the spawn is fast, so only the spawn has to change.
- Every outcome already passes through `record()` (`lib/record.mjs:147-153`), which never throws and which `bin/dial.mjs` turns into at most one stderr line.
- `diagnose` (`lib/doctor.mjs`) is synchronous and called directly by the doctor tests, while a connection attempt is asynchronous.

Evidence from the reproduction on 2026-11-18: `dial record --event SessionEnd --json` for a finished session took 0.37 s and returned `narrated: false`, `unobserved: http://127.0.0.1:11434/v1 unreachable`.

## Goals / Non-Goals

**Goals:**

- The SessionEnd hook returns well inside 1.5 seconds and the record run still completes.
- Every record run for a registered repo leaves one line saying what happened.
- A miss is visible in `dial doctor` (is a model up now?) and in the next brief (was the last session lost?).

**Non-Goals:**

- Retrying missed sessions. The log makes that possible later.
- Changing PreCompact, which has its full 60 seconds.
- Backfilling earlier sessions. That is a separate, manual step.
- Log rotation.

## Decisions

**D1. The payload travels over a stdin pipe.** The hook spawns with `detached: true`, `stdio: ['pipe', 'ignore', <fd or 'ignore'>]`, calls `child.stdin.end(raw)` with an `error` listener, then `child.unref()`. `readProcessStdin` and `runRecord` stay as they are. A test on this machine showed the hook returning in 0.028 s for payloads of 200 B and 5 KB with its stdio held as pipes, and the child reading the full payload after the hook exited, including after the hook's process group was SIGKILLed. A temp file would put session paths on disk and need cleanup; env or argv would expose the payload in `ps` and need a new option.

**D2. The child's stderr appends to `logs/record.err.log`.** `dial record` reports a failure as one stderr line, and detaching removes the reader. The hook first makes `<home>/logs` with a non-recursive `mkdir`, ignoring any failure, so a home without that folder still gets the file and a missing home is never created. It then opens the file in append mode, passes the descriptor, and closes its copy after the spawn. If the open fails, stderr is `ignore`, because the outcome log still records the result. The child never inherits the hook's stdout or stderr, which would hold the hook open. The file sits beside `agent.err.log` (`lib/agent.mjs:45-46`). This keeps compound note N2 (record failures must not vanish): PreCompact still relays the line, and for SessionEnd the failure lands in this file, in the `error` field of the record log, and in the next brief.

`runHook` gains a `detach` flag on the plan's return value, set by `hooks/record.mjs` for SessionEnd only. PreCompact keeps the `spawnSync` path, its 58-second kill and its stderr relay.

**D3. `hooks.json` keeps `timeout: 60` for SessionEnd.** It has no effect on the shared budget and the hook now returns at once, so changing it would only move a test pin (`test/plugin.test.mjs:45`).

**D4. `record()` writes the log line.** The exported wrapper resolves the repo, calls `run`, and appends the line for every result that has a repo, including one built from a caught exception. This puts the write at the one place every outcome passes. `run`'s return shape and `--json` output do not change, so `miss` exists only in the log. No line is written for an unregistered `cwd` or a bad event, which keeps "touches nothing". The appender follows `appendSyncLog` (`lib/sync.mjs:80-90`) with one addition: a non-recursive `mkdir` of `<home>/logs`, its failure ignored, so a run that never reached `ensureHome` still logs and a missing home is never created. It returns a result that `record()` ignores, so an unwritable home still gives exactly one stderr line. When an exception ends the run, `synced` and `narrated` are written as false, because the run reported neither. `ts` comes from `now`, so `DIAL_NOW` applies.

**D5. The writer decides `miss`.** Reasons are free text, so a reader matching them would break silently. `lib/record.mjs` computes `miss`: any `error`; any `unobserved` other than the no-text-turns reason, exported from `lib/narrate.mjs` as `NO_TEXT_TURNS`, or a transcript file that does not exist; or the no-transcript skip, a named constant in `lib/record.mjs`. An absent file means there is no conversation to capture, and a session that was opened and left may have none, so counting it would put a false line in the next brief. A file that exists but cannot be read is still a miss. When `tailTurns` fails, `run` tells the two apart with `existsSync` and hands that verdict to the wrapper beside its result, so `tailTurns` and the value `record()` returns do not change.

**D6. The brief judges the newest `SessionEnd` line from another session.** A PreCompact miss is retried by that session's SessionEnd, so it is not final. Skipping the `--session` id follows `excludeSession` (`lib/sources/sessions.mjs:23-70`), so a resumed session does not report on itself. Lines are taken in file order, as `lib/report.mjs:123-145` does for the sync log.

**D7. Doctor extends `narrate-endpoint` and probes before `diagnose`.** A new exported async `probeNarrate({ env, connect })` in `lib/doctor.mjs` resolves the endpoints with the registry loaded read-only, and returns each address's state: `listening`, `not listening` or `not a local endpoint`. The `doctor` case in `bin/dial.mjs` awaits it and passes the result as `diagnose({ env, cwd, listening })`. `diagnose` stays synchronous, and without `listening` the check keeps today's result, so the twelve-check ids, counts and direct-call tests do not move. The probe runs outside the `advise()` guard, so `probeNarrate` catches its own failures and never rejects: any failure yields no `listening`, and doctor reports as it does without a probe. The probe is a TCP connect with a 1-second limit, run on both addresses at once, only for addresses `isLocalEndpoint` accepts, and only when a primary resolves. It sends no data and loads no model. `connect` is injectable so tests open no socket. The status is `warn`, never `fail`: a sleeping local model is not a broken install, and advisory checks cannot fail. Either address listening is `ok`, because `askModel` needs only one.

**D8. The brief line follows the header and is dropped last.** It is what the reader most needs to act on, and placing it after the change lines in the drop order keeps the `briefLines` cap true at small values. It passes through the same `redact` as every other line, and `capLines` counts it like any other.

**D9. The brief reads at most the last 64 KiB, by a module constant.** `open`, `fstat`, one positioned `read`, `close`, inside a `try` that yields no line on any failure. When the read starts mid-file the first fragment is discarded. Each line is parsed on its own and bad ones skipped. A line is about 200 bytes, so the window holds roughly 300 runs across all repos. `LIMITS` is a closed, documented list and this is not a user-facing cap.

**D10. No rotation.** Two small lines per session at most, and no other Dial log rotates (`lib/sync.mjs:80-90`, `lib/agent.mjs:45-46`).

**D11. A brief can be one run behind after `/clear`.** SessionStart can run while the previous session's record run is still working, so the brief then shows the line before it. Waiting is not possible inside the hook budget, and the next brief corrects it.

## Risks / Trade-offs

- [Claude Code might end detached children by some means other than the process group] → The child has its own session and is reparented when the hook exits. The manual check in `tasks.md` confirms it on a real session after the plugin update.
- [A background record overlaps another sync] → Vault writes are atomic and re-check the target before renaming (`lib/vault.mjs:244-285`); the loser is skipped with a warning, which reaches `record.err.log`.
- [Without a local model every session shows the brief line] → This is intended: it is the signal the owner asked for, and it costs one line.
- [Doctor now opens a socket] → Loopback only, no data, 1 second at most.
- [`record.err.log` grows without limit] → It only receives failure and warning lines. Same stance as `agent.err.log`.

## Migration Plan

No data migration. The two logs appear on first use. The change reaches real sessions after a version bump and `claude plugin update`, because hooks run from the installed copy. To roll back, reinstall the previous plugin version; the log files can stay or be deleted.
