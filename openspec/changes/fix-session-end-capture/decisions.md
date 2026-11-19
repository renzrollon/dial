# Decisions — fix-session-end-capture

| id | question | class | resolution | evidence |
|----|----------|-------|------------|----------|
| D1 | How does the payload reach a detached child once the hook has exited? | agent_resolved | Over a stdin pipe closed with `end(raw)`; the CLI is unchanged | explore brief §Codebase Findings, experiment on 2026-11-18: hook returned in 0.028 s, child read the payload after the hook's process group was killed |
| D2 | Where does a detached record run's stderr go? | agent_resolved | Appended to `<home>/logs/record.err.log`, making `logs/` first without ever creating the home; discarded when the file cannot be opened | lib/agent.mjs:45-46 log convention; hooks/common.mjs:56-60 is the relay being lost; test/helpers.mjs:30-37 makes homes without `logs/` |
| D3 | Does the SessionEnd timeout in `hooks.json` change? | agent_resolved | No, it stays 60 | test/plugin.test.mjs:45; the timeout does not raise the shared SessionEnd budget |
| D4 | Which code writes the record log, and for which runs? | agent_resolved | The `record()` wrapper, for every run with a resolved repo; it makes `logs/` if needed, ignores append failures, never creates the home, and writes `synced` and `narrated` as false after an exception | lib/record.mjs:147-153; openspec/specs/handoff-and-narrative/spec.md:222-224; test/record.test.mjs:237-252 |
| D5 | What counts as a missed session? | agent_resolved | Any error, any unobserved reason except no text turns or an absent transcript file, or the no-transcript skip; the writer records it as `miss` | lib/record.mjs:173-193; lib/narrate.mjs:226; lib/transcript.mjs:20-24 |
| D6 | Which log line does the brief judge? | agent_resolved | The newest `SessionEnd` line for the repo from a session other than `--session` | lib/sources/sessions.mjs:23-70 excludeSession precedent |
| D7 | How does doctor check that an endpoint is listening? | agent_resolved | Extend `narrate-endpoint`; a 1-second loopback TCP probe run before the synchronous `diagnose`; `warn` only when no address listens; `skip` unchanged when no primary resolves; the probe never rejects, and a failed probe leaves the check as it is without one | Owner's approved plan, step 4, 2026-11-18; lib/doctor.mjs:355-359; lib/narrate.mjs:44 |
| D8 | Where does the brief line sit, and when is it dropped? | agent_resolved | Right after the header, dropped after the change lines | lib/brief.mjs:73-85 drop loop |
| D9 | How much of the log does the brief read? | agent_resolved | The last 64 KiB, by a module constant, not a published cap | lib/limits.mjs:52-65 closed cap list; lib/transcript.mjs:20-57 reads whole files, so it is not reused |
| D10 | Do the new logs rotate? | agent_resolved | No | lib/sync.mjs:80-90; lib/agent.mjs:45-46 |
| D11 | What may the brief show while the previous record run is still working? | agent_resolved | The line before it; the next brief corrects it | hooks/hooks.json:6 SessionStart budget; explore brief §Risks / Gaps |
