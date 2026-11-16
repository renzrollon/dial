# Settle summary — build-the-dial-ledger

- Branch: `feat/build-the-dial-ledger` → `feat/scaffold-cli-and-registry` (PR #1)
- Commits: `77931ea` feat: build the dial ledger from repo facts to vault notes; `8d385b5` fix(review) round 1; `10b9ab9` fix(review) round 2
- PR title: feat: build the dial ledger from repo facts to vault notes

## Description

## Summary
- **Why:** after the scaffold change, Dial had a shell, a registry and a doctor, but it still read nothing from a repo and wrote nothing into a vault. This PR builds the rest of the epic as one pipeline: collect → derive → render → write → surface → hook. It ships as the single OpenSpec change `build-the-dial-ledger`, so the whole pipeline shares one vocabulary of facts, states and note shapes.
- Offline collectors (git, OpenSpec, Interlock, Escapement, Claude Code sessions) plus `--remote` collectors (GitHub via `gh`, GitLab via `glab`, cached). They feed a pure state machine and a renderer whose `## Next` and `## Narrative` sections are preserved byte for byte.
- A boundary-checked, atomic, idempotent vault writer behind `vault init`, `sync`, `drop`, `next`, `brief`, `handoff`, `narrate`, `record`, `agent`, `watch`, `report` and `review --week`. It never deletes, and notes carry metadata only.
- A Claude Code plugin (hooks, plus the `/dial:handoff` and `/dial:next` skills). Every hook exits 0. Two review-fix rounds (`8d385b5`, `10b9ab9`) answered 35 review findings. Among them: wider secret redaction, `GIT_OPTIONAL_LOCKS=0`, hook deadlines (`DIAL_DEADLINE_MS`), a registry reload in `watch`, CRLF-safe notes and `ESCAPEMENT_CHECKPOINT_URL`.

## Merge confidence

**HUMAN** · score 51 (amber range 40–79; 5 of 17 gating signals clean)
_`MERGE` means every local signal is green. It does not say the platform’s branch rules would let this pull request merge: required checks, required approvals, code owners, a draft state, unresolved review threads and a merge queue are not read here._

Assessed commit `10b9ab9d80e006558e9102f90a873089dfd8b436` against `origin/feat/scaffold-cli-and-registry` (merge base `3f5068348c939c3d1eaf0f337ebdaa9a9c358df8`).

**Needs a fix**

- `review.warnings` (amber): `18 surviving warning(s) exceed MERGE_BANDS.maxWarningsForMerge = 2`
- `spec.coverage` (amber): `31 added source file(s) no spec names: hooks/brief.mjs, hooks/common.mjs, hooks/record.mjs, hooks/sync-on-event.mjs, lib/agent.mjs, lib/brief.mjs, lib/cache.mjs, lib/collect.mjs, lib/derive.mjs, lib/facts.mjs, lib/handoff.mjs, lib/narrate.…`

**Needs a person**

- `risk.class` (amber): `class high is outside MERGE_ALLOWED_CLASSES (low, medium), so a person decides`
- `diff.shape` (amber): `22950 changed line(s) exceed MERGE_BANDS.maxChangedLinesForMerge = 400; 163 changed file(s) exceed MERGE_BANDS.maxChangedFilesForMerge = 20`
- `run.integrity` (amber): `the run degraded: 2 handoff report(s) were rejected`

**Needs more evidence**

- `review.ran` (amber): `dimension(s) with unread inputs: domain, language, regression, technical-lead`

**Flags:** `review.ran` blast-radius-skipped, `review.ran` domain-partial, `verify.suite` no-typecheck, `verify.e2e` no-e2e, `verify.coverage` no-coverage, `ci.pipeline` no-pipeline, `conformance.living` no-graph, `conformance.living` requirements-omitted, `drift.stale` no-graph

**Labels:** `interlock/human-review`, `interlock/score-51`

<details>
<summary>All 18 signals</summary>

| Signal | Band | Flags | Reason and evidence |
| --- | --- | --- | --- |
| `review.blockers` | green |  | `no surviving blocker among 42 surviving finding(s); its proof of coverage does not hold`<br>`42 surviving finding(s): no blocker, no unrecognised severity` |
| `review.warnings` | amber |  | `18 surviving warning(s) exceed MERGE_BANDS.maxWarningsForMerge = 2`<br>`warning: bin/dial.mjs — An option placed before the vault/agent subcommand is refused, though options may appear anywhere after the command`<br>`warning: lib/agent.mjs — Reinstall can leave no agent and no plist: bootout's result is ignored and bootstrap runs straight after it`<br>`warning: test/derive.test.mjs — derive tests are not TZ-pinned and fail west of UTC-10`<br>`warning: lib/brief.mjs — Attribution is recovered by regex-parsing a rendered evidence string, duplicated in two modules`<br>`warning: lib/watch.mjs — Round 2 turned a thrown summary failure into a silent one for watch and record`<br>`warning: lib/remote.mjs — The remote cache outlives unregister, and a later repo with the same name reads it`<br>`warning: lib/watch.mjs — Round 2 made syncSummary never throw, so watch prints 'synced' for a sync whose summary failed`<br>`warning: lib/watch.mjs — A failed watch sync is never retried until the repo's mtime moves again`<br>`warning: test/cli.test.mjs — Usage test does not check DIAL_DEADLINE_MS, which round 2 added to the spec`<br>`warning: lib/record.mjs — The round-2 D45 narration rule (narrationSkip, lastTurnAt) has no test, so three new happy-path scenarios are unpinned`<br>`warning: lib/sources/paths.mjs — ESCAPEMENT_CHECKPOINT_URL is added at the fact level, so it reaches non-checkpoint evidence, and the LaunchAgent never has it, so notes flip between agent and shell syncs`<br>`warning: bin/dial.mjs — DIAL_DEADLINE_MS is untested end to end, and the README and the usage pin leave it out`<br>`warning: lib/watch.mjs — watch still records the new mtime before a sync that may fail, so a failed repo is never retried (round-2 finding not fixed)`<br>`warning: lib/record.mjs — The D45 narration rule (narrationSkip, lastTurnAt) has no test, so three happy-path spec scenarios are unpinned`<br>`warning: lib/sources/paths.mjs — ESCAPEMENT_CHECKPOINT_URL is appended at the fact level, so it reaches non-checkpoint evidence, and the LaunchAgent never sees it`<br>`warning: bin/dial.mjs — DIAL_DEADLINE_MS and boundedExec are untested, and the README and the usage pin omit the variable`<br>`warning: lib/agent.mjs — Reinstall ignores bootout's result and bootstraps straight away; a failed bootstrap leaves no agent and no plist`<br>`warning: lib/watch.mjs — watch records the new mtime before a sync that may fail, so a failed repo is never retried` |
| `review.ran` | amber | blast-radius-skipped, domain-partial | `dimension(s) with unread inputs: domain, language, regression, technical-lead`<br>`selected: domain, language, regression, technical-lead`<br>`ran: domain, language, regression, technical-lead`<br>`depth: lean`<br>`blast-radius review skipped: no graph at .claude/graph/graph.json`<br>`domain review ran on a degraded input: requirements left out of the domain reviewer's text by the size bound (LIMITS.maxDomainSpecChars); no graph, so domain was judged against the declared capabilities only`<br>`unread: domain: registry: 3 living requirements left out to fit the size cap (not delivered in the requirement block; recorded as degraded by the skill); lib/settings.mjs (settingsSources/coverage internals) (not in the changed-file scope.…`<br>`unread: language: the full test suite ('npm test') (the brief allows running only a single test file; nine individual files were run); openspec/changes/build-the-dial-ledger design.md, proposal.md, tasks.md and the 15 delta specs (language…`<br>`unread: regression: full bodies of the remaining new test files (render, derive, vault, sync, narrate, etc.) and all fixtures (they were added whole, not modified, so they cannot hold a deleted or weakened case. Only the pre-existing test …`<br>`unread: technical-lead: design.md and decisions.md in full (read only the round-2 hunks and the D45/D50 references; the other decision subsections were not read line by line); full bodies of the local-sources, note-rendering, report, next-…` |
| `review.adversarial` | green |  | `every surviving blocker and warning has at least MERGE_BANDS.minVerdictsPerFinding = 2, no refutation was refused, and the quality band removed no blocker`<br>`refused refutations: 0` |
| `risk.class` | amber |  | `class high is outside MERGE_ALLOWED_CLASSES (low, medium), so a person decides`<br>`class high`<br>`auth-session-permissions-tenancy: path lib/sources/sessions.mjs` |
| `verify.suite` | green | no-typecheck | `typecheck skipped: the profile names no type-check command (no-detectable-command); unit: unit suite is green`<br>`typecheck skipped: the profile names no type-check command (no-detectable-command)`<br>`unit: unit suite is green` |
| `verify.e2e` | green | no-e2e | `no end-to-end suite is enabled or requested here (e2e-not-requested)`<br>`e2e skipped: e2e-not-requested` |
| `verify.coverage` | green | no-coverage | `coverage is not configured in this repository (the final verification verdict skipped it as coverage-not-configured)` |
| `ci.pipeline` | green | no-pipeline | `the pipeline input records no checks for the head commit`<br>`pipeline sha 10b9ab9d80e006558e9102f90a873089dfd8b436: no checks` |
| `conformance.delta` | green |  | `558 of 558 scenario(s) checked, none unconfirmed`<br>`558 of 558 scenario(s) checked (the command counted 558); 0 unconfirmed` |
| `conformance.living` | green | no-graph, requirements-omitted | `12 of 12 living requirement(s) checked, none unconfirmed`<br>`12 of 12 living requirement(s) checked (the command counted 12); 0 unconfirmed`<br>`partial list: no graph (no graph has been built — run /interlock:bootstrap once): the changed files were not mapped to capabilities, so domain is judged against the declared capabilities only (cli-shell, dial-home, doctor, limits, registry)`<br>`12 requirement(s) asked and 3 left out by the size bound`<br>`left out: registry: A repository can be unregistered by path or by name`<br>`left out: registry: Registered repositories are listed`<br>`left out: registry: The registry is written atomically and reproducibly` |
| `spec.coverage` | amber |  | `31 added source file(s) no spec names: hooks/brief.mjs, hooks/common.mjs, hooks/record.mjs, hooks/sync-on-event.mjs, lib/agent.mjs, lib/brief.mjs, lib/cache.mjs, lib/collect.mjs, lib/derive.mjs, lib/facts.mjs, lib/handoff.mjs, lib/narrate.…`<br>`added, named by no spec: hooks/brief.mjs`<br>`added, named by no spec: hooks/common.mjs`<br>`added, named by no spec: hooks/record.mjs`<br>`added, named by no spec: hooks/sync-on-event.mjs`<br>`added, named by no spec: lib/agent.mjs`<br>`added, named by no spec: lib/brief.mjs`<br>`added, named by no spec: lib/cache.mjs`<br>`added, named by no spec: lib/collect.mjs`<br>`added, named by no spec: lib/derive.mjs`<br>`added, named by no spec: lib/facts.mjs`<br>`added, named by no spec: lib/handoff.mjs`<br>`added, named by no spec: lib/narrate.mjs`<br>`added, named by no spec: lib/next.mjs`<br>`added, named by no spec: lib/note.mjs`<br>`added, named by no spec: lib/record.mjs`<br>`added, named by no spec: lib/remote.mjs`<br>`added, named by no spec: lib/render.mjs`<br>`added, named by no spec: lib/report.mjs`<br>`added, named by no spec: lib/sources/escapement.mjs`<br>`added, named by no spec: lib/sources/git.mjs`<br>`added, named by no spec: lib/sources/github.mjs`<br>`added, named by no spec: lib/sources/gitlab.mjs`<br>`added, named by no spec: lib/sources/interlock.mjs`<br>`added, named by no spec: lib/sources/openspec.mjs`<br>`added, named by no spec: lib/sources/paths.mjs`<br>`added, named by no spec: lib/sources/sessions.mjs`<br>`added, named by no spec: lib/subprocess.mjs`<br>`added, named by no spec: lib/sync.mjs`<br>`added, named by no spec: lib/transcript.mjs`<br>`added, named by no spec: lib/vault.mjs`<br>`added, named by no spec: lib/watch.mjs`<br>`2 of 38 tracked coverable source file(s) are named by a spec` |
| `diff.shape` | amber |  | `22950 changed line(s) exceed MERGE_BANDS.maxChangedLinesForMerge = 400; 163 changed file(s) exceed MERGE_BANDS.maxChangedFilesForMerge = 20`<br>`22950 changed line(s) (added plus deleted), 163 changed file(s)` |
| `decisions.open` | green |  | `67 ledger row(s), none needing a person and none invalid`<br>`agent_resolved D18`<br>`agent_resolved D19`<br>`agent_resolved D20`<br>`agent_resolved D21`<br>`agent_resolved D22`<br>`agent_resolved D23`<br>`agent_resolved D24`<br>`agent_resolved D25`<br>`agent_resolved D26`<br>`agent_resolved D27`<br>`agent_resolved D28`<br>`agent_resolved D29`<br>`agent_resolved D30`<br>`agent_resolved D31`<br>`agent_resolved D32`<br>`agent_resolved D33`<br>`agent_resolved D34`<br>`agent_resolved D35`<br>`agent_resolved D36`<br>`agent_resolved D37`<br>`agent_resolved D38`<br>`agent_resolved D39`<br>`agent_resolved D40`<br>`agent_resolved D41`<br>`agent_resolved D42`<br>`agent_resolved D43`<br>`agent_resolved D44`<br>`agent_resolved D45`<br>`agent_resolved D46`<br>`agent_resolved D47`<br>`agent_resolved D48`<br>`agent_resolved D49`<br>`agent_resolved D50`<br>`agent_resolved D51`<br>`agent_resolved D52`<br>`agent_resolved D53`<br>`agent_resolved D54`<br>`agent_resolved D55`<br>`agent_resolved D56`<br>`agent_resolved D57`<br>`agent_resolved D58`<br>`agent_resolved D59`<br>`agent_resolved D60`<br>`agent_resolved D61`<br>`agent_resolved D62`<br>`agent_resolved D63`<br>`agent_resolved D64`<br>`agent_resolved D65`<br>`agent_resolved D66`<br>`agent_resolved D67`<br>`agent_resolved D68`<br>`agent_resolved D69`<br>`agent_resolved D70`<br>`agent_resolved D71`<br>`agent_resolved D72`<br>`agent_resolved D73`<br>`agent_resolved D74`<br>`agent_resolved D75`<br>`agent_resolved D76`<br>`agent_resolved D77`<br>`agent_resolved D78`<br>`agent_resolved D79`<br>`agent_resolved D80`<br>`agent_resolved D81`<br>`agent_resolved D82`<br>`agent_resolved D83`<br>`agent_resolved D84` |
| `run.integrity` | amber |  | `the run degraded: 2 handoff report(s) were rejected` |
| `drift.stale` | green | no-graph | `the stale-citation check did not run, so its empty result is not read as clean: no graph has been built — run /interlock:bootstrap once`<br>`the stale-citation check did not run: no graph has been built — run /interlock:bootstrap once` |
| `policy.humanPaths` | green |  | `no changed path falls under the 0 always-human-review path(s) listed at origin/feat/scaffold-cli-and-registry`<br>`always-human-review paths read from origin/feat/scaffold-cli-and-registry: (none)`<br>`168 changed path(s), none under a listed path` |
| `plan.fidelity` | info |  | `the run record carries no planned and touched path sets in this version` |

</details>

## Changes
- **local-sources / remote-sources**: Dial reads repo facts offline, and reads forge facts only under `--remote`. An absent source is reported as `unobserved` with a reason.
  - `lib/sources/*.mjs`, `lib/{subprocess,cache,remote,collect,transcript}.mjs`
- **state-model**: each change gets one state by first-match priority, with evidence, a `stale` overlay, `needs_me` and a suggested command.
  - `lib/{facts,derive}.mjs`
- **note-rendering**: renders change and repo notes, daily lines, `Dial Summary.md`, `Dial.base` and the templates. Human-owned sections survive re-syncs, and secret-shaped strings are redacted.
  - `lib/{note,render}.mjs`, `templates/*`
- **vault-writes**: `dial vault init`, `dial sync [--remote] [--dry-run]` and `dial drop`. Writes are atomic and checked against the registry's vault and `roots` boundary. Archiving moves notes and never unlinks them.
  - `lib/{vault,sync}.mjs`
- **next-and-brief**: `dial next` (needs-me across repos) and `dial brief <repo> [--hook]` (capped at `briefLines`, redacted).
  - `lib/{next,brief}.mjs`
- **handoff-and-narrative**: `dial handoff`, `dial narrate` (loopback-only model, redirects refused, one fallback) and `dial record` (hook-triggered, every subprocess bounded by a 55 s deadline).
  - `lib/{handoff,narrate,record}.mjs`
- **claude-plugin**: plugin and marketplace manifests, SessionStart / SessionEnd / PreCompact / PostToolUse hooks with deadlines below their kill timeouts, two skills.
  - `.claude-plugin/*`, `hooks/*`, `skills/*`
- **launch-agent / report**: `dial agent install|uninstall|status` (macOS LaunchAgent, with the `idle` outcome for an interval job between runs), `dial watch` (reloads the registry each poll), `dial report` and `dial review --week`.
  - `lib/{agent,watch,report}.mjs`
- **cli-shell / dial-home / registry / limits / doctor (modified)**:
  - Usage lists every new command and the six environment variables, now including `DIAL_DEADLINE_MS`.
  - The registry accepts optional `narrate` and `roots` blocks (D18), and repo names are unique in their note-filename form.
  - `limits` publishes ten caps.
  - Doctor gains six advisory checks that cannot fail.
  - `record` exits 0 with one stderr line. The delta specs now say so explicitly.
  - Files: `bin/dial.mjs`, `lib/{registry,limits,doctor}.mjs`, `README.md`, `docs/how-dial-works.md`, `package.json`.

## High Risk Changes
- **Writes outside the repo**: notes inside registered vaults, under `$DIAL_HOME`, and `~/Library/LaunchAgents/com.dial.sync.plist` on `agent install`. Mitigation: every vault write goes through one boundary check, writes are temp-file-then-rename, and nothing is ever deleted. Rollback: `dial agent uninstall`, then remove the notes Dial wrote; human-owned sections are never rewritten.
- **Hooks run in every Claude Code session in a registered repo.** Mitigation: every hook path exits 0, prints nothing in an unregistered repo, and bounds its subprocesses below the hook's kill timeout. Rollback: uninstall the plugin.
- **`narrate` sends a transcript tail to a local model endpoint.** Only loopback hosts are called, and redirects are refused. The key goes only in the request header and is never written.
- **Background `git status`** from the agent, `watch` and the hooks runs with `GIT_OPTIONAL_LOCKS=0`, so it does not take `.git/index.lock` in your repo.
- **Known open items the review left**: 16 surviving warnings no fix round took, and 2 protected-test findings left for a person (see the reply tables). They include the `watch` sync-retry rule (pinned by `test/watch.test.mjs:108-128`), missing tests for the round-2 narration rule and `DIAL_DEADLINE_MS`, `ESCAPEMENT_CHECKPOINT_URL` reaching non-checkpoint evidence, and LaunchAgent reinstall after a bootout.

## Prerequisites to Production
- Node ≥ 22. No npm dependency.
- The human steps under `## H0.` and `## H1.` in `tasks.md`: declare the vaults (and the work `roots`), enable the Obsidian CLI, run the baseline week, then install the plugin and the agent.

## Testing
- Unit: 31 test files added or updated. `npm test` passes 807 of 807 at `10b9ab9`. The fix rounds added no tests, because `test/` was protected from the fixer.
- Verified locally: integration task 6.7, a clean-home run of `vault init` → `register` → `sync` twice (byte-identical) → `next` → `brief --hook` → `doctor` → hooks. Each fix round was gated on a green suite before it was committed.
- Not covered:
  - The `[manual]` and `[human]` steps in `tasks.md`.
  - Tests for `narrationSkip`/`lastTurnAt`, `DIAL_DEADLINE_MS` and `boundedExec`.
  - The derive suite is not pinned to a time zone: it fails one test under `TZ=Pacific/Pago_Pago`.
  - No CI checks are configured on this repository.
