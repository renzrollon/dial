# Settle summary — add-dial-ask

- Branch: feat/add-dial-ask
- Commits: 87b0079 feat: answer repo questions with dial context and /dial:ask; 9b5f0b7 fix(review): answer the PR #3 review round 1
- PR: #3 — feat: answer repo questions with dial context and /dial:ask

## Description

## Summary
- Dial could not answer the questions its owner asks most about a repo: do I have open pull requests, can I merge them yet, and what is blocking. `dial brief` takes no question, and a remote sync only looked at the checked-out branch's pull request.
- A remote sync now also lists the repo's open pull requests (`gh pr list` / `glab mr list`). Each entry is cut to data and cached under its own timestamp.
- New offline read command `dial context [<repo>] [--json]` prints one redacted document per repo: git facts, the open PRs (each with a `ready` verdict of `yes` / `no` / `unknown` and named `blockers`), derived items, unticked Next items and the newest narrative.
- New skill `/dial:ask [<question>]` syncs, reads `dial context --json`, and answers from that document only. When the refresh fails it now says so, because each `dial sync --json` row carries a `remote` outcome (review round 1, D24).

## Merge confidence

**HUMAN** · score 56 (amber range 40–79; 7 of 17 gating signals clean)
_`MERGE` means every local signal is green. It does not say the platform’s branch rules would let this pull request merge: required checks, required approvals, code owners, a draft state, unresolved review threads and a merge queue are not read here._

Assessed commit `9b5f0b7d0ea462cea8d4cc8f957e0d00ad6c2988` against `origin/main` (merge base `f1a639a1f8e76440931c2799b8f6dcf9d0e8ee53`).

**Needs a fix**

- `review.warnings` (amber): `3 surviving warning(s) exceed MERGE_BANDS.maxWarningsForMerge = 2`
- `spec.coverage` (amber): `3 added source file(s) no spec names: lib/context.mjs, lib/readiness.mjs, lib/sources/forge.mjs`

**Needs a person**

- `diff.shape` (amber): `3464 changed line(s) exceed MERGE_BANDS.maxChangedLinesForMerge = 400; 37 changed file(s) exceed MERGE_BANDS.maxChangedFilesForMerge = 20`

**Needs more evidence**

- `review.ran` (amber): `dimension(s) with unread inputs: technical-lead`
- `run.integrity` (unobserved): `no run record: this assessment was not made by a ship run, which writes one at close`

**Flags:** `verify.suite` no-typecheck, `verify.e2e` no-e2e, `verify.coverage` no-coverage, `ci.pipeline` no-pipeline, `conformance.living` requirements-omitted

**Labels:** `interlock/human-review`, `interlock/score-56`

<details>
<summary>All 18 signals</summary>

| Signal | Band | Flags | Reason and evidence |
| --- | --- | --- | --- |
| `review.blockers` | green |  | `no surviving blocker among 24 surviving finding(s); its proof of coverage does not hold`<br>`24 surviving finding(s): no blocker, no unrecognised severity` |
| `review.warnings` | amber |  | `3 surviving warning(s) exceed MERGE_BANDS.maxWarningsForMerge = 2`<br>`warning: lib/sync.mjs — The new 'remote' field on each 'dial sync --json' row (D24) has no test`<br>`warning: lib/sync.mjs — The new 'remote' key on 'dial sync --json' rows (D24) has no test`<br>`warning: openspec/changes/add-dial-ask/design.md — Design still says sync's output does not change, which D24 now contradicts` |
| `review.ran` | amber |  | `dimension(s) with unread inputs: technical-lead`<br>`selected: technical-lead`<br>`ran: technical-lead`<br>`depth: lean`<br>`unread: technical-lead: openspec/changes/add-dial-ask/specs/context/spec.md, remote-sources/spec.md, cli-shell/spec.md, limits/spec.md, registry/spec.md and claude-plugin/spec.md, read in full (Read through design.md, decisions.md, tasks.m…` |
| `review.adversarial` | green |  | `every surviving blocker and warning has at least MERGE_BANDS.minVerdictsPerFinding = 2, no refutation was refused, and the quality band removed no blocker`<br>`refused refutations: 0` |
| `risk.class` | green |  | `class medium is within MERGE_ALLOWED_CLASSES (low, medium)`<br>`class medium`<br>`unmatched-source-change: 11 non-docs path(s) with no matching risk rule: .claude-plugin/plugin.json; bin/dial.mjs; lib/context.mjs (+8 more)` |
| `verify.suite` | green | no-typecheck | `typecheck skipped: the profile names no type-check command (no-detectable-command); unit: unit suite is green`<br>`typecheck skipped: the profile names no type-check command (no-detectable-command)`<br>`unit: unit suite is green` |
| `verify.e2e` | green | no-e2e | `no end-to-end suite is enabled or requested here (e2e-not-requested)`<br>`e2e skipped: e2e-not-requested` |
| `verify.coverage` | green | no-coverage | `coverage is not configured in this repository (the final verification verdict skipped it as coverage-not-configured)` |
| `ci.pipeline` | green | no-pipeline | `the pipeline input records no checks for the head commit`<br>`pipeline sha 9b5f0b7d0ea462cea8d4cc8f957e0d00ad6c2988: no checks` |
| `conformance.delta` | green |  | `155 of 155 scenario(s) checked, none unconfirmed`<br>`155 of 155 scenario(s) checked (the command counted 155); 0 unconfirmed` |
| `conformance.living` | green | requirements-omitted | `12 of 12 living requirement(s) checked, none unconfirmed`<br>`12 of 12 living requirement(s) checked (the command counted 12); 0 unconfirmed`<br>`12 requirement(s) asked and 46 left out by the size bound`<br>`left out: claude-plugin: The handoff skill states what a sandboxed session needs`<br>`left out: claude-plugin: The next skill renders dial next as drafted actions`<br>`left out: cli-shell: The version is a command and a flag`<br>`left out: cli-shell: Unknown commands are refused`<br>`left out: cli-shell: Options use one syntax and unknown options are refused`<br>`left out: cli-shell: Every failure is one reason line on stderr`<br>`left out: cli-shell: The vault and agent commands dispatch on a subcommand`<br>`left out: cli-shell: DIAL_NOW overrides the clock`<br>`left out: cli-shell: Local dates and times follow the process time zone`<br>`left out: cli-shell: Machine-read timestamps have one written form`<br>`left out: cli-shell: handoff collects every --next in order`<br>`left out: limits: Caps print one aligned line each`<br>`left out: registry: The registry file has a versioned shape`<br>`left out: registry: A missing registry is an empty registry`<br>`left out: registry: Entries are validated on every load`<br>`left out: registry: A repository is registered with its vault and host`<br>`left out: registry: A repository belongs to exactly one vault`<br>`left out: registry: A repository can be unregistered by path or by name`<br>`left out: registry: Registered repositories are listed`<br>`left out: registry: The registry is written atomically and reproducibly`<br>`left out: registry: The narrate block is validated on every load`<br>`left out: registry: The narrate block does not change the repository listing`<br>`left out: registry: Repo paths are compared through their real paths`<br>`left out: registry: The roots map is validated on every load`<br>`left out: registry: A path's root vault comes from the longest containing root`<br>`left out: registry: A path under a declared root is registered only to that root's vault`<br>`left out: remote-sources: The network is used only by a remote sync`<br>`left out: remote-sources: The registry's host picks the CLI`<br>`left out: remote-sources: GitHub supplies the pull request and its checks`<br>`left out: remote-sources: GitLab supplies the merge request and its pipeline`<br>`left out: remote-sources: No checks and no pipeline are observed as ci none`<br>`left out: remote-sources: No pull request is an observed null; a failed fetch is unobserved`<br>`left out: remote-sources: Without a fetch the facts come from the cache, dated`<br>`left out: vault-writes: vault init scaffolds a vault and reports each path`<br>`left out: vault-writes: vault init refuses an unknown vault or a missing path`<br>`left out: vault-writes: A dry run prints every planned write and writes nothing`<br>`left out: vault-writes: Each sync appends one line per repo to the sync log`<br>`left out: vault-writes: A daily line is appended for each observed state transition`<br>`left out: vault-writes: Writes are refused outside the repo's registered vault`<br>`left out: vault-writes: Writes are atomic and skip unchanged bytes`<br>`left out: vault-writes: A note changed during a sync is re-read, never overwritten`<br>`left out: vault-writes: The daily log is appended under Log and never rewritten`<br>`left out: vault-writes: Archived change notes move to Archive/Changes after the keep period`<br>`left out: vault-writes: drop marks a change note as dropped`<br>`left out: vault-writes: No note is ever deleted`<br>`left out: vault-writes: Writes are refused for a repo registered against its directory root` |
| `spec.coverage` | amber |  | `3 added source file(s) no spec names: lib/context.mjs, lib/readiness.mjs, lib/sources/forge.mjs`<br>`added, named by no spec: lib/context.mjs`<br>`added, named by no spec: lib/readiness.mjs`<br>`added, named by no spec: lib/sources/forge.mjs`<br>`2 of 44 tracked coverable source file(s) are named by a spec` |
| `diff.shape` | amber |  | `3464 changed line(s) exceed MERGE_BANDS.maxChangedLinesForMerge = 400; 37 changed file(s) exceed MERGE_BANDS.maxChangedFilesForMerge = 20`<br>`3464 changed line(s) (added plus deleted), 37 changed file(s)` |
| `decisions.open` | green |  | `24 ledger row(s), none needing a person and none invalid`<br>`agent_resolved D1`<br>`agent_resolved D2`<br>`agent_resolved D3`<br>`agent_resolved D4`<br>`agent_resolved D5`<br>`agent_resolved D6`<br>`agent_resolved D7`<br>`agent_resolved D8`<br>`agent_resolved D9`<br>`agent_resolved D10`<br>`agent_resolved D11`<br>`agent_resolved D12`<br>`agent_resolved D13`<br>`agent_resolved D14`<br>`agent_resolved D15`<br>`agent_resolved D16`<br>`agent_resolved D17`<br>`agent_resolved D18`<br>`agent_resolved D19`<br>`agent_resolved D20`<br>`agent_resolved D21`<br>`agent_resolved D22`<br>`agent_resolved D23`<br>`agent_resolved D24` |
| `run.integrity` | unobserved |  | `no run record: this assessment was not made by a ship run, which writes one at close` |
| `drift.stale` | green |  | `no living spec cites a file this change removed, and no other unarchived change shares its capabilities`<br>`0 broken citation(s) repo-wide, none of a file this change touched`<br>`2 unarchived change(s), none on this change's capabilities` |
| `policy.humanPaths` | green |  | `no changed path falls under the 0 always-human-review path(s) listed at origin/main`<br>`always-human-review paths read from origin/main: (none)`<br>`37 changed path(s), none under a listed path` |
| `plan.fidelity` | info |  | `no run record`<br>`no run record: plan fidelity is reported from a ship run, and this assessment has none` |

</details>

## Changes
- **remote-sources**: open PR listing on GitHub and GitLab. Forge strings are cut to data. The cache gains `prs` / `prsError`, and its marker stays `dial.cache/1`. A failed list keeps the previous one and does not fail the fetch.
  - `lib/sources/github.mjs`, `lib/sources/gitlab.mjs`, new `lib/sources/forge.mjs`, `lib/remote.mjs`
- **context**: `dial context` and the pure merge-readiness rule. It blocks on draft, conflict, behind base, changes requested, review required, failing/pending/cancelled checks and branch protection; anything the forge did not report is `unknown`.
  - new `lib/context.mjs`, `lib/readiness.mjs`, `bin/dial.mjs`
- **claude-plugin**: the `/dial:ask` skill and what it needs in a sandbox. The skill reads the sync row's `remote` to report a failed refresh.
  - new `skills/ask/SKILL.md`, `.claude-plugin/plugin.json` (description only)
- **vault-writes**: each `dial sync --json` row gains a `remote` field (`{ value, evidence }` or `{ value: null, unobserved }`).
  - `lib/sync.mjs`, `bin/dial.mjs`
- **limits**: three new caps: `remotePullRequests` 20, `contextNarrative` 5, `contextLines` 200.
  - `lib/limits.mjs`
- **cli-shell / registry**: usage lists twenty commands. `context` accepts `--json` and resolves its repo through the single rule.
  - `bin/dial.mjs`, `README.md`, `docs/how-dial-works.md`, `scripts/setup.mjs` (prompt text)

## High Risk Changes
- A remote sync makes one more `gh`/`glab` call per repo, bounded by `subprocessTimeoutSeconds`, so a due repo in the periodic agent sync can take up to that much longer. A failing list is recorded as `prsError` and does not fail the fetch. Rollback is a revert, and older caches read as "list not fetched yet".
- A user who sets one of the three new caps in `registry.json` and then downgrades will have the registry refused by the older build ("unknown cap"). Recovery: remove `remotePullRequests`, `contextNarrative` and `contextLines` from `limits` before downgrading.
- `dial sync --json` rows gain a `remote` key. The change is additive, and every reader is internal.

## Prerequisites to Production
None

## Testing
- Unit: new `test/sources-forge.test.mjs`, `test/readiness.test.mjs`, `test/context.test.mjs`; updated remote, sync, limits, cli and plugin tests. `npm test`: 969 passing, 0 failing, on `9b5f0b7`
- Verified locally: 155 of 155 delta scenarios and 12 sampled living requirements confirmed by reading the code at the head
- Not covered: live `gh`/`glab` calls (fixtures under `test/fixtures/remote/`), and the new `remote` field on `dial sync --json` rows has no test yet (surviving review warning)
