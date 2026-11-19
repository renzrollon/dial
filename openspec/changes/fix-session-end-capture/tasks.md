# Tasks

Shape: TDD and bug fix. Section 1 starts with the failing reproduction of the bug, and section 2 makes it green.

Reproduction: `dial record --event SessionEnd --json` with no local model returned `narrated: false`, `unobserved: http://127.0.0.1:11434/v1 unreachable` on 2026-11-18, printing nothing in text mode, and the hook waits for that run although its budget is 1.5 seconds.

Known test pins this change alters, each updated in the task that changes the meaning, naming the assertion and the requirement it now pins: `test/hooks.test.mjs:131-143` (the SessionEnd half reads the fake CLI's calls straight after the hook closes) and `test/hooks.test.mjs:145-150` (a failing CLI under SessionEnd), both in 2.2. `test/plugin.test.mjs:45` does not change (D3). Doctor tests that call `diagnose` directly do not change (D7).

## 1. Failing tests first

- [ ] 1.1 Write the failing suite for every new scenario in the delta specs. In `test/hooks.test.mjs`, the repro first: the SessionEnd hook returns within 1 second with its stdout and stderr closed while a fake CLI takes 3 seconds, and the CLI still receives the whole payload (wait for it by polling `calls.jsonl`, with a timeout); then PreCompact still waits, stderr reaches `logs/record.err.log`, and an unopenable error log still starts the CLI. In `test/record.test.mjs`: one line per run, each `miss` case including an absent transcript file against an unreadable one, a home without `logs/`, no line for an unregistered cwd or a bad event, a caught exception with `synced` and `narrated` false, one stderr line with an unwritable home, no API key in the log. In `test/doctor.test.mjs`: listening, nothing listening, fallback only, non-local, hanging address, a probe that fails, using an injected `connect`. In `test/brief.test.mjs`: the line and its position, other repos, PreCompact lines, the current session, a torn or missing log, the 64 KiB window, the drop order, and that nothing is written. Verify with `node --test test/hooks.test.mjs test/record.test.mjs test/doctor.test.mjs test/brief.test.mjs` that no existing test has changed result and that every new test fails for the missing behaviour, starting with the SessionEnd repro, except these regression guards, which pass today and must keep passing: PreCompact still waits, no line for an unregistered cwd or a bad event, one stderr line with an unwritable home, no API key in the log, and, for the brief, a captured session, other repos, PreCompact lines, a torn or missing log, and nothing written.

## 2. Capture, log and report (make §1 green)

- [ ] 2.1 In `lib/record.mjs` make the `record()` wrapper resolve the repo, run, and append one line to `<home>/logs/record.jsonl` for every run with a repo, computing `miss` per D4 and D5, making `logs/` without ever creating the home, writing `synced` and `narrated` as false after an exception, with `home` falling back to `resolveHome(env)` and `record()`'s return value unchanged. Export `NO_TEXT_TURNS` from `lib/narrate.mjs` and use it at the existing literal. Update the header comment of `lib/record.mjs`, which still says the 55-second deadline protects a 60-second hook. Verify with `node --test test/record.test.mjs test/narrate.test.mjs`.
- [ ] 2.2 In `hooks/common.mjs` add the detached path to `runHook` per D1 and D2, used when the plan returns `detach: true`, and in `hooks/record.mjs` set it for SessionEnd only, leaving the PreCompact path as it is. Update the `common.mjs` header. Update `test/hooks.test.mjs:131-143` to wait for the SessionEnd call and `test/hooks.test.mjs:145-150` to use PreCompact, pinning `Hooks never block a session`. Verify with `node --test test/hooks.test.mjs test/plugin.test.mjs`, and that the unregistered-cwd tests at `test/hooks.test.mjs:101-129` pass unchanged.
- [ ] 2.3 In `lib/doctor.mjs` add `probeNarrate`, which never rejects, and the `listening` input to `diagnose` and `checkNarrateEndpoint` per D7, and in `bin/dial.mjs` await the probe in the `doctor` case. Verify with `node --test test/doctor.test.mjs test/cli.test.mjs`, including that a failed probe leaves the report whole and doctor still does not create a missing home.
- [ ] 2.4 In `lib/brief.mjs` read the tail of the record log per D6 and D9, without creating anything, and add the line to `capLines` per D8. This depends on the line fields from 2.1. Verify with `node --test test/brief.test.mjs`.
- [ ] 2.5 Update the docs, which depends on 2.1 to 2.4: `README.md:293` (the hook hands off and the run continues in the background), `README.md:346` (the no-network statement gains doctor's loopback check), `README.md:361` (`narrate-endpoint` can be `warn`), `README.md:474` (record logs each run), `README.md:647` (SessionEnd is detached), `README.md:709` (the check now probes loopback addresses), the logs listing if the README has one, and `docs/how-dial-works.md:102`. Verify by reading each `network call` match from `grep -n "network call" README.md`, none of which may still deny doctor's probe, and with `node --test test/plugin.test.mjs`.

## 3. Integration

- [ ] 3.1 Run `npm test` and confirm it passes. Then, with a throwaway `DIAL_HOME` holding one registered repo and no model listening, pipe a payload into `node hooks/record.mjs --event SessionEnd`, and confirm the hook returns in under 1 second, a line with `miss` true appears in `logs/record.jsonl` within about 5 seconds, and `dial brief <repo>` then shows `last session not captured`.

## H1. Human and manual steps after implementation

- [manual] H1.1 After a version bump and `claude plugin update`, exit one real session with no model running. Confirm `logs/record.jsonl` gains a line with `unobserved` and the next session's brief shows the miss.
- [manual] H1.2 Start a local model, exit one real session that wrote no handoff, and confirm a `local model (…)` entry appears in the note within about 30 seconds.

## Workflow follow-up

- Bump the plugin version and release it, after the owner agrees.
- Archive the change after review.
