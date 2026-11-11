# Spec Delta

## Purpose

How Dial turns one repository's facts into items: one item per change with exactly one state chosen by first-match priority, its `needs_me`, `stale`, evidence rows and suggested action, how branch facts are attributed to a change, and the repo-level item for a branch no change covers.

## ADDED Requirements

### Requirement: There is one item per active or recently archived change
Dial SHALL derive one item for every active change and for every change archived on a date no more than `archivedKeepDays` days before the current local date, and no other change items. Each item SHALL have a `state`, `needs_me`, `stale`, idle days, evidence rows and a suggested action, and SHALL appear as `Changes/<repo>--<change>.md` and, when it needs me, as a `dial next` row. A repo without OpenSpec SHALL have no change items.

#### Scenario: Active and archived changes become items
- **WHEN** katipon has active changes `add-login` and `fix-cache`, `archivedKeepDays` is 30, the date is 2026-11-10, and `archive/2026-10-11-old-auth/` and `archive/2026-10-10-older-auth/` exist
- **THEN** the items are `add-login`, `fix-cache` and `old-auth`, and there is no item for `older-auth`

#### Scenario: No OpenSpec, no change items
- **WHEN** the OpenSpec facts are `unobserved: no openspec dir`
- **THEN** katipon has no change items and only the repo-level item

### Requirement: The first matching signal decides the state
The state SHALL be the first of `archived`, `dropped`, `archive-pending`, `conflict`, `ci-red`, `needs-fix`, `manual-test`, `pr-open`, `shipped`, `halted`, `shipping`, `queued`, `checkpoint`, `spec-draft` whose signal is present, so an item is in exactly one state. A signal SHALL never match on an unobserved fact, except that `shipped` reads an unobserved PR as no PR. This one order SHALL also drive `dial next` and the `Dial.base` group order.

#### Scenario: Priority walk
- **WHEN** `add-login` has an archive entry, a `dropped` key in its note, 3/3 tasks ticked, an attributed PR that is merged and `CONFLICTING`, a rebase in progress, a failing check `lint`, 2 surviving settle findings, a `manual-test-plan.md` with no `Result:` line, a last outcome with `observed.commit`, `run.json.halted` set for it with a live stage pid, an Escapement `pending` entry, and a `needs_human` row
- **THEN** its state is `archived`
- **AND** removing the archive entry gives `dropped`; then removing `dropped` gives `archive-pending`; then unticking one task and reopening the PR gives `conflict`; then ending the rebase and clearing `CONFLICTING` gives `ci-red`; then passing `lint` gives `needs-fix`
- **AND** then clearing the settle findings gives `manual-test`; then adding `Result: pass` gives `pr-open`; then removing the PR gives `shipped`; then nulling the outcome's commit gives `halted`; then clearing `halted` gives `shipping`; then removing the run and stage gives `queued`; then removing the queue entry gives `checkpoint`; then removing the `needs_human` row gives `spec-draft`

#### Scenario: An unobserved check never makes ci-red
- **WHEN** the attributed `ci` fact is `unobserved: no remote cache, run dial sync --remote` and nothing else matches above `spec-draft`
- **THEN** the state is `spec-draft`

#### Scenario: shipped with no remote facts
- **WHEN** the last outcome for `add-login` has `observed.commit` `3f50683`, `pr` is unobserved, and nothing above `shipped` matches
- **THEN** the state is `shipped`

### Requirement: Archived and dropped are read before every other signal
`archived` SHALL match when the OpenSpec archive names the change, and `dropped` when the change note's frontmatter holds a `dropped` key with any value. Both SHALL be read before every other signal, so an archived change is never `archive-pending` and a dropped change keeps `dropped` whatever its other facts until it is archived.

#### Scenario: archived
- **WHEN** `openspec/changes/archive/2026-11-09-add-login/` exists and `openspec/changes/add-login/` does not
- **THEN** the state is `archived`

#### Scenario: Archived beats a merged PR
- **WHEN** the change is archived and its attributed PR is merged
- **THEN** the state is `archived`, never `archive-pending`

#### Scenario: dropped
- **WHEN** `Changes/katipon--add-login.md` holds `dropped: 2026-11-08` and the change has a halted run
- **THEN** the state is `dropped`

#### Scenario: Dropped then archived
- **WHEN** a dropped change is later archived
- **THEN** the state is `archived`

### Requirement: Branch and pull request signals
`archive-pending` SHALL match an active change whose tasks are all ticked with `tasks_total` above 0, or whose attributed PR is merged. `conflict` SHALL match a git rebase or merge in progress, unmerged files, or an attributed PR that is conflicting. `ci-red` SHALL match an attributed `ci` of `fail`. `pr-open` SHALL match an attributed PR whose state is `open`. Git and PR facts SHALL count only for the change they are attributed to.

#### Scenario: archive-pending from ticked tasks
- **WHEN** `add-login` is active with `tasks_done` 9 and `tasks_total` 9 and no PR is observed
- **THEN** the state is `archive-pending` with evidence `openspec/changes/add-login/tasks.md: 9/9`

#### Scenario: Zero of zero is not archive-pending
- **WHEN** `add-login` has no `tasks.md` and nothing else matches
- **THEN** the state is `spec-draft`

#### Scenario: archive-pending from a merged PR
- **WHEN** the attributed PR is merged and 7 of 9 tasks are ticked
- **THEN** the state is `archive-pending` with evidence `gh pr view 38: MERGED 2026-11-09T10:00:00Z`

#### Scenario: conflict from a rebase
- **WHEN** `in_progress` is `rebase` and the branch is attributed to `add-login`
- **THEN** the state is `conflict` with evidence `.git/rebase-merge: present`

#### Scenario: conflict from the PR
- **WHEN** the attributed PR has `mergeable` `CONFLICTING`
- **THEN** the state is `conflict` with evidence `gh pr view 38 mergeable: CONFLICTING`

#### Scenario: ci-red
- **WHEN** the attributed `ci` is `fail` from check `lint`
- **THEN** the state is `ci-red` with evidence `gh pr checks feat/add-login: fail (lint)`

#### Scenario: pr-open
- **WHEN** the attributed PR 38 is open, checks pass, and nothing above matches
- **THEN** the state is `pr-open` with evidence `gh pr view 38: OPEN`

### Requirement: Review and test signals
`needs-fix` SHALL match when the newest settle record has more than 0 surviving findings, its `head` equals the full sha of the checked-out `HEAD`, and the branch is attributed to the change, or when `merge-confidence.json` names the change with verdict `BLOCK`. `manual-test` SHALL match when `manual-test-plan.md` is present with no `Result:` line and no ticked `## Next` box in the change note contains `manual test`, compared case-insensitively.

#### Scenario: needs-fix from settle
- **WHEN** `.claude/ship/settle/review-r3.json` has 2 surviving findings and the branch is attributed to `add-login`
- **THEN** the state is `needs-fix` with evidence `.claude/ship/settle/review-r3.json: 2 surviving`

#### Scenario: A settle record for another commit does not count
- **WHEN** `.claude/ship/settle/review-r3.json` has 2 surviving findings and `head` `a1b2c3d…`, while the checked-out `HEAD` is `3f50683…` on a branch attributed to `add-login`
- **THEN** the state is not `needs-fix`, and the `settle` evidence row reads `.claude/ship/settle/review-r3.json: 2 surviving for head a1b2c3d, not HEAD`

#### Scenario: needs-fix from a BLOCK verdict
- **WHEN** `merge-confidence.json` names `add-login` with `result.verdict` `BLOCK`
- **THEN** the state is `needs-fix` with evidence `.claude/ship/merge-confidence.json result.verdict: BLOCK`

#### Scenario: manual-test
- **WHEN** `manual-test-plan.md` exists with no `Result:` line and nothing above matches
- **THEN** the state is `manual-test` with evidence `openspec/changes/add-login/manual-test-plan.md: no Result: line`

#### Scenario: A ticked Next box clears manual-test
- **WHEN** the change note's `## Next` holds `- [x] Run the Manual Test plan on staging`
- **THEN** the state is not `manual-test`

#### Scenario: An unticked Next box does not
- **WHEN** the change note's `## Next` holds `- [ ] manual test the login form`
- **THEN** the state is `manual-test`

### Requirement: Ship run signals
`shipped` SHALL match when the change's last outcome has a non-null `observed.commit` and there is no attributed PR. `halted` SHALL match when `run.json.change` is the change and its run ended in `run-halt` or has `halted` set, or the run is not closed and has neither a terminal line nor a live stage pid, or an `interrupted/` note for the change's latest run exists. `shipping` SHALL match when that run is not closed and its stage pid is alive, or the change's Escapement entry is `running`.

#### Scenario: shipped
- **WHEN** the last outcome for `add-login` has `observed.commit` `3f50683` and `pr` is observed null
- **THEN** the state is `shipped` with evidence `.claude/learning/outcomes.jsonl: add-login commit 3f50683 verdict MERGE`

#### Scenario: halted from the trajectory
- **WHEN** `run.json` names `add-login` and run `7a587a81` whose trajectory ends `run-halt` with reason `verify red` at `2026-11-09T16:22:00Z`
- **THEN** the state is `halted` with evidence `.claude/ship/runs/7a587a81.jsonl run-halt 2026-11-09T16:22:00Z`
- **AND** the `resume card` row names `.claude/handoff/ship-add-login-7a587a81.md` when it exists

#### Scenario: A killed run reads as halted
- **WHEN** `run.json` names `add-login`, neither `halted` nor `closedAt` is set, the trajectory has no terminal line, and the stage pid is dead
- **THEN** the state is `halted`, the `ship` row's value is `halted: interrupted`, and the evidence is `.claude/ship/add-login/stage.json pid <pid>: dead`

#### Scenario: shipping from a live stage
- **WHEN** `run.json` names `add-login`, the run is not closed, and the stage pid is alive
- **THEN** the state is `shipping` with evidence `.claude/ship/add-login/stage.json pid <pid>: alive`

#### Scenario: shipping from Escapement
- **WHEN** the Escapement entry for `add-login` is `running` and no run names it
- **THEN** the state is `shipping` with evidence `~/.escapement/queue/running/<id>.json: running`

### Requirement: An interrupted note counts only for the change's latest run
The change's latest run SHALL be `run.json`'s run when `run.json.change` is the change; otherwise the newest of the change's interrupted notes (by `at`) and its outcomes (by `ts`). An interrupted note for any other run SHALL NOT match `halted`, and its `spokenAt` SHALL be ignored, because Interlock never deletes the notes and speaks them at the start of any run.

#### Scenario: halted from an interrupted note
- **WHEN** `.claude/ship/interrupted/7a587a81.json` names `add-login` with `at` `2026-11-09T16:30:00.000Z`, `run.json` names another change, and no outcome for `add-login` is newer
- **THEN** the state is `halted` with evidence `.claude/ship/interrupted/7a587a81.json: add-login`

#### Scenario: An old interrupted note does not halt a live re-run
- **WHEN** `.claude/ship/interrupted/7a587a81.json` names `add-login`, and `run.json` names `add-login` with run `9c01d2e4`, not closed, whose stage pid is alive
- **THEN** the state is `shipping`, and the `ship` evidence row reads `.claude/ship/interrupted/7a587a81.json: run 7a587a81, not the latest run`

#### Scenario: A later closed run supersedes an interrupted note
- **WHEN** `.claude/ship/interrupted/7a587a81.json` names `add-login` with `at` `2026-11-09T16:30:00.000Z`, `run.json` names another change, and the last outcome for `add-login` has `ts` `2026-11-10T08:00:00.000Z` and `observed.commit` `3f50683` with no attributed PR
- **THEN** the state is `shipped`, not `halted`

#### Scenario: A spoken note for the latest run still halts
- **WHEN** the only interrupted note for `add-login` has `spokenAt` set and is newer than every outcome for `add-login`, and `run.json` names another change
- **THEN** the state is `halted`

### Requirement: Queue, checkpoint and draft signals
`queued` SHALL match an Escapement `pending` entry for the change. `checkpoint` SHALL match a `needs_human` row in the change's `decisions.md`, or a review-artifacts metrics file for the change with `checkpoint.json` absent or `returned`; when `ESCAPEMENT_CHECKPOINT_URL` is set its value SHALL be appended verbatim to that evidence after `; `. `spec-draft` SHALL match any active change no earlier signal matched, with the `tasks` evidence `n/m`.

#### Scenario: queued
- **WHEN** `~/.escapement/queue/pending/q-123.json` is for `add-login` and nothing above matches
- **THEN** the state is `queued` with evidence `~/.escapement/queue/pending/q-123.json: pending`

#### Scenario: checkpoint from a needs_human row
- **WHEN** `decisions.md` has the `needs_human` row `D1` and `ESCAPEMENT_CHECKPOINT_URL` is `https://checkpoint.example/`
- **THEN** the state is `checkpoint` with evidence `openspec/changes/add-login/decisions.md: needs_human D1; https://checkpoint.example/`

#### Scenario: checkpoint from review-artifacts findings
- **WHEN** `.claude/metrics/review-artifacts-add-login-20261110-091200.json` exists and `checkpoint.json` is absent
- **THEN** the state is `checkpoint`
- **AND** with `checkpoint.json` `decision.state` `approved` and no `needs_human` row, the state is `spec-draft` with the suggested action `/interlock:ship add-login`

#### Scenario: spec-draft
- **WHEN** `add-login` has 2 of 5 tasks ticked and nothing above matches
- **THEN** the state is `spec-draft` with evidence `openspec/changes/add-login/tasks.md: 2/5`

### Requirement: Each state fixes needs_me and the suggested action
`needs_me` SHALL be false for `archived`, `dropped`, `shipping` and `queued`; true for `archive-pending`, `conflict`, `ci-red`, `needs-fix`, `manual-test`, `shipped`, `halted`, `checkpoint` and `spec-draft`; and for `pr-open` true exactly when the change's merge verdict is not `MERGE`, the verdict read from `merge-confidence.json` for the change, else the last outcome's `observed.mergeVerdict`. `archived` and `dropped` SHALL have no suggested action.

#### Scenario: Suggested action per state
- **WHEN** an item for `add-login` is in each state in turn and is not stale
- **THEN** the suggested action is `openspec archive add-login` for `archive-pending`, `resolve, then git rebase --continue` for `conflict`, `/interlock:fix-tests` for `ci-red`, `/interlock:settle --review` for `needs-fix`, `run the plan, add Result:` for `manual-test`, `review and merge` for `pr-open`
- **AND** `/interlock:settle --create` for `shipped`, `/interlock-handoff, re-run ship` for `halted`, `wait` for `shipping`, `wait or escapement list` for `queued`, `read the spec; answer on the phone` for `checkpoint`, `/interlock:review-artifacts` for `spec-draft`

#### Scenario: pr-open with a MERGE verdict
- **WHEN** the item is `pr-open` and `merge-confidence.json` names `add-login` with verdict `MERGE`
- **THEN** `needs_me` is false

#### Scenario: pr-open with a HUMAN verdict from outcomes
- **WHEN** the item is `pr-open`, `merge-confidence.json` does not name the change, and the last outcome's `observed.mergeVerdict` is `HUMAN`
- **THEN** `needs_me` is true

#### Scenario: pr-open with no verdict
- **WHEN** the item is `pr-open` and no verdict is observed
- **THEN** `needs_me` is true

### Requirement: An approved spec suggests ship
A `spec-draft` item whose `checkpoint.json` `decision.state` is `approved` SHALL suggest `/interlock:ship <change>` in place of `/interlock:review-artifacts`, because its spec has already been reviewed and approved.

#### Scenario: Approved draft
- **WHEN** `add-login` has no `needs_human` row, a review-artifacts file, and `checkpoint.json` `decision.state` `approved`
- **THEN** the state is `spec-draft`, `needs_me` is true, and the suggested action is `/interlock:ship add-login`

### Requirement: Every signal read leaves an evidence row
Each item SHALL carry one evidence row `(fact, value, evidence)` per signal read, matched or not, in the order `archive`, `dropped`, `tasks`, `pr`, `conflict`, `ci`, `settle`, `merge_verdict`, `manual test`, `outcome`, `ship`, `stage`, `queue`, `decisions`, `review-artifacts`, `checkpoint`, `resume card`, `last activity`; an unobserved fact's value is `unobserved: <reason>`. These rows become the `## State` table, and the matched signal's evidence is the item's evidence in `dial next`.

#### Scenario: Unmatched signals still appear
- **WHEN** `add-login` is `pr-open` and its `ci` is `pass`
- **THEN** the item has a `ci` row with value `pass` and a `tasks` row, and its evidence in `dial next` is `gh pr view 38: OPEN`

#### Scenario: An unobserved row
- **WHEN** the Escapement home is absent
- **THEN** the `queue` row's value is `unobserved: ~/.escapement: absent`

#### Scenario: Rows are in a fixed order
- **WHEN** two items in different states are derived
- **THEN** both carry their rows in the same fact order

### Requirement: Stale is an overlay from the newest activity
`lastActivity` SHALL be the newest observed of: last commit, last session, PR `updatedAt`, and for the change its newest trajectory `ts`, last outcome `ts`, newest queue transition `ts`, newest mtime under its change dir and newest narrative entry; the note's `updated` SHALL never count. Idle days SHALL be `floor((now − lastActivity) / 86400 s)`; `stale` is idle days above `staleDays`. Stale keeps the state and SHALL force `needs_me` true and the suggested action `archive, drop, or re-spec`.

#### Scenario: Fifteen idle days is stale
- **WHEN** `DIAL_NOW` is `2026-11-10T09:00:00Z`, `staleDays` is 14, the item is `queued`, and its newest activity is `2026-10-26T08:00:00Z`
- **THEN** idle days is 15, `stale` is true, the state stays `queued`, `needs_me` is true, and the suggested action is `archive, drop, or re-spec`

#### Scenario: Exactly staleDays is not stale
- **WHEN** idle days is 14 and `staleDays` is 14
- **THEN** `stale` is false

#### Scenario: The note's own updated date does not count
- **WHEN** the change note has `updated: 2026-11-10` and every activity source is 20 days old
- **THEN** idle days is 20 and the item is stale

#### Scenario: A narrative entry counts as activity
- **WHEN** the newest narrative entry is headed `### 2026-11-09 22:20 · dial handoff` and every other source is older
- **THEN** `lastActivity` is 2026-11-09 22:20 local time

#### Scenario: Archived and dropped are never stale
- **WHEN** an `archived` or `dropped` item's newest activity is 60 days old
- **THEN** `stale` is false and `needs_me` is false

#### Scenario: No observed activity
- **WHEN** every activity source is unobserved
- **THEN** idle days is `unobserved: no activity observed` and `stale` is false

### Requirement: Branch facts are attributed to one change at most
The checked-out branch's git conflict facts, PR and checks SHALL belong to the active change whose name equals a `/`-separated segment of the branch or ends one after a `-` (the longest such name when several match); failing that, to `run.json.change` when it is active; failing that, to the only active change when there is exactly one; otherwise to no change. A detached HEAD SHALL skip the name match.

#### Scenario: Name as a path segment
- **WHEN** the branch is `feat/scaffold-cli-and-registry` and `scaffold-cli-and-registry` is active
- **THEN** the PR and checks belong to `scaffold-cli-and-registry`

#### Scenario: Name as a suffix
- **WHEN** the branch is `carl/123-add-login` and `add-login` is active
- **THEN** the PR belongs to `add-login`

#### Scenario: Longest name wins
- **WHEN** the branch is `feat/add-login` and both `login` and `add-login` are active
- **THEN** the PR belongs to `add-login`

#### Scenario: Fall back to the run
- **WHEN** the branch is `main`, `add-login` and `fix-cache` are active, and `run.json.change` is `fix-cache`
- **THEN** the branch facts belong to `fix-cache`

#### Scenario: Fall back to the only active change
- **WHEN** the branch is `main`, no run names an active change, and `add-login` is the only active change
- **THEN** the branch facts belong to `add-login`

#### Scenario: No attribution
- **WHEN** the branch is `main`, `add-login` and `fix-cache` are active, and no run names either
- **THEN** no change item reads the branch's PR, checks or conflicts, and they feed the repo-level item

### Requirement: The repo-level item covers unattributed branch facts
Each repo SHALL have one repo-level item on `Projects/<repo>.md`, its state the first of `conflict`, `ci-red`, `pr-open`, `merged` (PR merged) matched by unattributed branch facts with the change signals' rules, else `idle`. `needs_me` SHALL be true for `conflict`, `ci-red` and `pr-open` and false for `merged` and `idle`, with the change states' suggested actions; `merged` and `idle` SHALL have none and never be stale. No change note SHALL be made for a branch.

#### Scenario: Repo without OpenSpec or PR
- **WHEN** katipon has no `openspec/` directory and `pr` is observed null
- **THEN** the repo-level item is `idle` with `needs_me` false

#### Scenario: Unattributed conflict
- **WHEN** a merge is in progress on `main` and no change is attributed
- **THEN** the repo-level item is `conflict` with `needs_me` true and suggested action `resolve, then git rebase --continue`, and no change item is `conflict`

#### Scenario: Merged PR without a change
- **WHEN** katipon has no OpenSpec and the branch's PR is merged
- **THEN** the repo-level item is `merged` with `needs_me` false

#### Scenario: Attributed facts leave the repo idle
- **WHEN** the branch `feat/add-login` and its open PR are attributed to `add-login`
- **THEN** the repo-level item is `idle` and the `add-login` item is `pr-open`

#### Scenario: A stale open PR on the repo
- **WHEN** the repo-level item is `pr-open` and the newest of its last commit, last session and PR `updatedAt` is 20 days old with `staleDays` 14
- **THEN** it is stale with suggested action `archive, drop, or re-spec`

### Requirement: Derivation is deterministic
The same facts, the same vault notes and the same current time SHALL yield the same items with the same states, flags, idle days, evidence rows and suggested actions, ordered by change name. The current time SHALL be `DIAL_NOW` when set, else the system clock, and derivation SHALL read no other clock, no network and no randomness.

#### Scenario: Same facts, same items
- **WHEN** `DIAL_NOW=2026-11-10T09:00:00Z dial next --json` runs twice over an unchanged registry, repositories and vaults
- **THEN** both runs print identical bytes

#### Scenario: The clock moves the overlay only
- **WHEN** the same facts are derived with `DIAL_NOW` `2026-11-10T09:00:00Z` and then `2026-11-30T09:00:00Z`, the newest activity being `2026-11-05T09:00:00Z`
- **THEN** the state is the same both times, and idle days goes from 5 to 25 with `stale` from false to true
