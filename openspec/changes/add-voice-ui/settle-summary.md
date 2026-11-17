# Settle summary — add-voice-ui

- Branch: chore/voice-openspec-changes
- PR: renzrollon/dial#4 (target main)
- Commit message: feat: add dial voice, a local spoken conversation with a Claude Code session (b86e0ef); fix(review): answer the PR #4 review round 1 (aae93d2)
- PR title: feat: add dial voice, a local spoken conversation with Claude Code

## Description

## Summary
- The owner wants to ask Dial questions aloud (can this PR merge, what needs me) and hear the answer, without typing into a Claude Code session. `dial voice` opens a window, listens, answers and speaks.
- A new foreground command serves one page on `127.0.0.1:3425`, opens it as a Chrome window with no browser bar, and runs one isolated `claude -p` session that may only run `dial next|context|brief|sync|repos`.
- Replies are cut into sentences and spoken with macOS `say`. Speech is recognized on the device only, and typed turns always work.
- This branch also carries the spec-only changes `add-voice-orchestrator` and `add-voice-stage-and-capture`. Both have open needs_human decisions and no code yet, and are out of scope for this review.

## Merge confidence

**HUMAN** · score 58 (amber range 40–79; 8 of 17 gating signals clean)
_`MERGE` means every local signal is green. It does not say the platform’s branch rules would let this pull request merge: required checks, required approvals, code owners, a draft state, unresolved review threads and a merge queue are not read here._

Assessed commit `aae93d296a81637be618b4c0a60b91aa94fca12d` against `origin/main` (merge base `5c8835ec98e98a70abefdaa31c2ed4d3fc6b0a32`).

**Needs a fix**

- `spec.coverage` (amber): `6 added source file(s) no spec names: lib/spawn.mjs, lib/voice/engine.mjs, lib/voice/guard.mjs, lib/voice/segment.mjs, lib/voice/server.mjs, lib/voice/speech.mjs`

**Needs a person**

- `diff.shape` (amber): `11433 changed line(s) exceed MERGE_BANDS.maxChangedLinesForMerge = 400; 61 changed file(s) exceed MERGE_BANDS.maxChangedFilesForMerge = 20`

**Needs more evidence**

- `review.ran` (amber): `dimension(s) with unread inputs: language, technical-lead`
- `run.integrity` (unobserved): `no run record: this assessment was not made by a ship run, which writes one at close`

**Flags:** `verify.suite` no-typecheck, `verify.e2e` no-e2e, `verify.coverage` no-coverage, `ci.pipeline` no-pipeline, `conformance.living` requirements-omitted

**Labels:** `interlock/human-review`, `interlock/score-58`

<details>
<summary>All 18 signals</summary>

| Signal | Band | Flags | Reason and evidence |
| --- | --- | --- | --- |
| `review.blockers` | green |  | `no surviving blocker among 26 surviving finding(s); its proof of coverage does not hold`<br>`26 surviving finding(s): no blocker, no unrecognised severity` |
| `review.warnings` | green |  | `0 surviving warning(s), at or under MERGE_BANDS.maxWarningsForMerge = 2; its proof of coverage does not hold`<br>`no surviving warning` |
| `review.ran` | amber |  | `dimension(s) with unread inputs: language, technical-lead`<br>`selected: language, technical-lead`<br>`ran: language, technical-lead`<br>`depth: lean`<br>`unread: language: lib/voice/page.html, page.css, prompt.md (Markup, stylesheet and prompt text, not language or framework logic; outside the changed-source list for this dimension.); Most of the test files in full (test/voice-server, voice…`<br>`unread: technical-lead: design.md, tasks.md and the cli-shell, dial-home, voice-engine and voice delta specs of add-voice-ui, read in full (Only the proposal and the limits spec were read closely. The rest was checked against the code thro…` |
| `review.adversarial` | green |  | `every surviving blocker and warning has at least MERGE_BANDS.minVerdictsPerFinding = 2, no refutation was refused, and the quality band removed no blocker`<br>`refused refutations: 0` |
| `risk.class` | green |  | `class medium is within MERGE_ALLOWED_CLASSES (low, medium)`<br>`class medium`<br>`unmatched-source-change: 12 non-docs path(s) with no matching risk rule: bin/dial.mjs; lib/limits.mjs; lib/spawn.mjs (+9 more)` |
| `verify.suite` | green | no-typecheck | `typecheck skipped: the profile names no type-check command (no-detectable-command); unit: unit suite is green`<br>`typecheck skipped: the profile names no type-check command (no-detectable-command)`<br>`unit: unit suite is green` |
| `verify.e2e` | green | no-e2e | `no end-to-end suite is enabled or requested here (e2e-not-requested)`<br>`e2e skipped: e2e-not-requested` |
| `verify.coverage` | green | no-coverage | `coverage is not configured in this repository (the final verification verdict skipped it as coverage-not-configured)` |
| `ci.pipeline` | green | no-pipeline | `the pipeline input records no checks for the head commit`<br>`pipeline sha aae93d296a81637be618b4c0a60b91aa94fca12d: no checks` |
| `conformance.delta` | green |  | `218 of 218 scenario(s) checked, none unconfirmed`<br>`218 of 218 scenario(s) checked (the command counted 218); 0 unconfirmed` |
| `conformance.living` | green | requirements-omitted | `12 of 12 living requirement(s) checked, none unconfirmed`<br>`12 of 12 living requirement(s) checked (the command counted 12); 0 unconfirmed`<br>`12 requirement(s) asked and 20 left out by the size bound`<br>`left out: claude-plugin: The handoff skill states what a sandboxed session needs`<br>`left out: claude-plugin: The next skill renders dial next as drafted actions`<br>`left out: claude-plugin: Skills call dial on PATH and the package ships the plugin`<br>`left out: claude-plugin: The ask skill refreshes one repo and reads its context`<br>`left out: claude-plugin: The ask skill answers from the context document only`<br>`left out: claude-plugin: The ask skill treats what it reads as data`<br>`left out: claude-plugin: The ask skill states what a sandboxed session needs`<br>`left out: cli-shell: The version is a command and a flag`<br>`left out: cli-shell: Unknown commands are refused`<br>`left out: cli-shell: Options use one syntax and unknown options are refused`<br>`left out: cli-shell: Read commands offer JSON output`<br>`left out: cli-shell: The vault and agent commands dispatch on a subcommand`<br>`left out: cli-shell: DIAL_NOW overrides the clock`<br>`left out: cli-shell: Local dates and times follow the process time zone`<br>`left out: cli-shell: Machine-read timestamps have one written form`<br>`left out: cli-shell: handoff collects every --next in order`<br>`left out: dial-home: The home is resolved from DIAL_HOME with one rule and no fallback`<br>`left out: dial-home: An unusable home is refused with the path and the OS error`<br>`left out: dial-home: The home holds the remote cache and the logs at fixed paths`<br>`left out: limits: Caps print one aligned line each` |
| `spec.coverage` | amber |  | `6 added source file(s) no spec names: lib/spawn.mjs, lib/voice/engine.mjs, lib/voice/guard.mjs, lib/voice/segment.mjs, lib/voice/server.mjs, lib/voice/speech.mjs`<br>`added, named by no spec: lib/spawn.mjs`<br>`added, named by no spec: lib/voice/engine.mjs`<br>`added, named by no spec: lib/voice/guard.mjs`<br>`added, named by no spec: lib/voice/segment.mjs`<br>`added, named by no spec: lib/voice/server.mjs`<br>`added, named by no spec: lib/voice/speech.mjs`<br>`4 of 52 tracked coverable source file(s) are named by a spec` |
| `diff.shape` | amber |  | `11433 changed line(s) exceed MERGE_BANDS.maxChangedLinesForMerge = 400; 61 changed file(s) exceed MERGE_BANDS.maxChangedFilesForMerge = 20`<br>`11433 changed line(s) (added plus deleted), 61 changed file(s)` |
| `decisions.open` | green |  | `37 ledger row(s), none needing a person and none invalid`<br>`agent_resolved D1`<br>`agent_resolved D2`<br>`agent_resolved D3`<br>`agent_resolved D4`<br>`agent_resolved D5`<br>`agent_resolved D6`<br>`agent_resolved D7`<br>`agent_resolved D8`<br>`agent_resolved D9`<br>`agent_resolved D10`<br>`agent_resolved D11`<br>`agent_resolved D12`<br>`agent_resolved D13`<br>`agent_resolved D14`<br>`agent_resolved D15`<br>`agent_resolved D16`<br>`agent_resolved D17`<br>`agent_resolved D18`<br>`agent_resolved D19`<br>`agent_resolved D20`<br>`agent_resolved D21`<br>`agent_resolved D22`<br>`agent_resolved D23`<br>`agent_resolved D24`<br>`agent_resolved D25`<br>`agent_resolved D26`<br>`agent_resolved D27`<br>`agent_resolved D28`<br>`agent_resolved D29`<br>`agent_resolved D30`<br>`agent_resolved D31`<br>`agent_resolved D32`<br>`agent_resolved D33`<br>`agent_resolved D34`<br>`agent_resolved D35`<br>`agent_resolved D36`<br>`agent_resolved D37` |
| `run.integrity` | unobserved |  | `no run record: this assessment was not made by a ship run, which writes one at close` |
| `drift.stale` | green |  | `no living spec cites a file this change removed, and no other unarchived change shares its capabilities`<br>`0 broken citation(s) repo-wide, none of a file this change touched`<br>`1 unarchived change(s), none on this change's capabilities` |
| `policy.humanPaths` | green |  | `no changed path falls under the 0 always-human-review path(s) listed at origin/main`<br>`always-human-review paths read from origin/main: (none)`<br>`61 changed path(s), none under a listed path` |
| `plan.fidelity` | info |  | `no run record`<br>`no run record: plan fidelity is reported from a ship run, and this assessment has none` |

</details>

## Changes
- **voice**: new `dial voice [--port] [--model] [--say-voice] [--lang] [--no-open]`, with its loopback listener, request guard (per-launch token, Host check, Origin check), the page and its events, sentence segmentation and speech
  - `lib/voice/server.mjs`, `guard.mjs`, `segment.mjs`, `speech.mjs`, `page.html`, `page.js`, `page-logic.mjs`, `page.css`
  - Review round 1: the token comparison now checks byte lengths, so a multi-byte token of the right character count gets a 403 instead of a 500 (`lib/voice/guard.mjs`)
- **voice-engine**: one long-lived `claude -p` stream-json child, run with `--safe-mode --restricted --strict-mcp-config` and a five-command allowlist. It fails closed when the session's reported tools, MCP servers or permission mode differ from what was asked, and handles interrupt, resume and restart.
  - `lib/voice/engine.mjs`, `lib/voice/prompt.md`, `lib/spawn.mjs` (async child runner)
- **cli-shell**: usage now lists 21 commands. Adds the `voice` line, its option table and the `spawn`/`listen`/`platform` injectables.
  - `bin/dial.mjs`
- **limits**: three new published caps: `voiceTurnSeconds` 120, `voiceCloseSeconds` 10, `voiceTurnChars` 2000
  - `lib/limits.mjs`
- **dial-home**: `voice` ensures the home and adds a `voice/` directory
- Docs: `README.md`, `docs/how-dial-works.md`

## High Risk Changes
- This is the first time Dial itself starts a Claude session, so voice turns reach Anthropic through the owner's own Claude Code login. Mitigation: the session is isolated (no hooks, plugins, skills, MCP servers or settings files), and Dial refuses to converse if the session reports anything different. It is opt-in: no existing command changes, and rollback is to not run `dial voice` or to revert.
- The five-command list is enforced by Claude Code's permission rules (`--allowedTools` + `dontAsk`), not by Dial (D30). `dial sync` is among them and writes the vault.
- Rollback note: a registry that sets `limits.voiceTurnSeconds`, `voiceCloseSeconds` or `voiceTurnChars` is refused by an older `dial` ("unknown cap"). Remove those keys before downgrading.

## Prerequisites to Production
- `claude` and `dial` on PATH. Chrome 139 or later for on-device speech recognition. macOS `say` for spoken replies (without it, replies are text only).
- No new dependency, env var, hook or migration. The release and version bump are left to the owner (H1.6).

## Testing
- Unit: 9 new test files (spawn, voice-segment/guard/engine/session/speech/server/page/prompt); cli, helpers, limits and plugin tests updated. `npm test`: 1334 tests, 1330 pass, 0 fail, 4 skipped, at `aae93d2`
- Verified locally: the review loop's re-review, and a conformance pass confirming 218 of 218 spec scenarios against the code
- Not covered: the real `claude` handshake and real speech recognition (manual steps H1.1–H1.5 in `tasks.md`); the socket cases skip where loopback binding is refused (EPERM); no guard test yet for a multi-byte token (the review loop does not edit `test/`)
