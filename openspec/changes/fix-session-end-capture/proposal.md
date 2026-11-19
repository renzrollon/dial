# Proposal

## Why

Dial has never written a narrative entry from a session end. The SessionEnd hook waits for `dial record`, which plans for 55 seconds, while Claude Code gives SessionEnd hooks a shared budget of 1.5 seconds that a plugin's own timeout does not raise. When no local model is running, `dial record` finishes with `unobserved: http://127.0.0.1:11434/v1 unreachable`, prints nothing, exits 0 and logs nothing, so about 30 sessions on 2026-11-18 left no trace and no reason.

## What Changes

- The SessionEnd hook starts `dial record --event SessionEnd` as a detached process with the payload on its stdin and returns at once. The run's stderr goes to `<home>/logs/record.err.log`. PreCompact keeps waiting, as it has a full 60 seconds.
- `dial record` appends one line per run for a registered repo to `<home>/logs/record.jsonl`, naming the outcome and whether the session was missed.
- `dial doctor`'s `narrate-endpoint` check tries a loopback connection and warns when no narrate endpoint is listening. **BREAKING** for the doctor spec's promise that the check opens no connection.
- `dial brief` gains one line after the header when the repo's previous session was missed, and reads the end of the record log to find out.
- Out of scope: retrying missed sessions automatically, and setting `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`, which would make exit and `/clear` wait.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-plugin`: the SessionEnd hook starts the record run detached instead of waiting, and no longer relays its stderr.
- `handoff-and-narrative`: record logs every run and marks missed sessions; the 55-second deadline no longer rests on the hook's timeout at SessionEnd.
- `doctor`: the `narrate-endpoint` check reports whether anything is listening.
- `next-and-brief`: the brief reads the record log and shows a missed session.
- `dial-home`: the home holds `logs/record.jsonl` and `logs/record.err.log`.

## Impact

- Code: `hooks/common.mjs`, `hooks/record.mjs`, `lib/record.mjs`, `lib/narrate.mjs`, `lib/doctor.mjs`, `lib/brief.mjs`, `bin/dial.mjs`.
- Tests: `test/hooks.test.mjs`, `test/record.test.mjs`, `test/doctor.test.mjs`, `test/brief.test.mjs`.
- Docs: `README.md`, `docs/how-dial-works.md`.
- Hooks run from the installed plugin copy, so the fix reaches real sessions only after a version bump and a plugin update.
