# local-sources Specification

## Purpose
The facts Dial derives offline from git, OpenSpec, Interlock, Escapement and Claude Code sessions for one registered repository: which files and commands each fact comes from, the evidence string it carries, and the `unobserved: <reason>` value it takes when a source cannot answer.

## Requirements

### Requirement: Every fact carries evidence or is unobserved with a reason
Every value a local source reports SHALL be a fact: observed, with a value and one evidence string `<origin>: <detail>` (origin is the command as run, or the file path relative to the repository root, or `~`-collapsed outside it), or `unobserved: <reason>` with no value. A source SHALL NOT substitute a default for an unobserved fact, and a missing source SHALL leave `dial sync` at exit 0. A fact value SHALL be a name, count, id, enum, timestamp or path, never file contents or a diff.

#### Scenario: Observed fact names its origin
- **WHEN** `dial sync katipon` runs and the working tree has two changed entries
- **THEN** the `dirty` fact is 2 with evidence `git status --porcelain=v2 --branch: 2 entries`

#### Scenario: Missing source root is unobserved, not an error
- **WHEN** the registered repository has no `openspec/` directory
- **THEN** every OpenSpec fact is `unobserved: no openspec dir`, the repo note is still written, and `dial sync katipon` exits 0

#### Scenario: Unobserved is never replaced by a default
- **WHEN** `git` cannot run in the repository
- **THEN** `dirty`, `stash`, `ahead` and `behind` are `unobserved: <reason>`, never 0, and `Projects/katipon.md` shows `dirty: unobserved`

#### Scenario: A file whose schema is not understood
- **WHEN** `.claude/ship/run.json` has `"schema": "interlock.run/2"`
- **THEN** the run facts are `unobserved: .claude/ship/run.json schema interlock.run/2 not understood` and the other Interlock files are still read

#### Scenario: Unreadable JSON
- **WHEN** `.claude/ship/merge-confidence.json` is not valid JSON
- **THEN** the merge verdict fact is `unobserved: .claude/ship/merge-confidence.json not valid JSON`

#### Scenario: An absent optional file is an observed absence
- **WHEN** a change directory has no `checkpoint.json`
- **THEN** the checkpoint fact is observed with value `absent` and evidence `openspec/changes/<change>/checkpoint.json: absent`

### Requirement: Local subprocesses are optional, bounded and never touch the network
Local sources SHALL run only `git` (in the repository) and, under `dial sync` only, `interlock drift --json`; each SHALL be killed after `subprocessTimeoutSeconds`. A binary not on PATH SHALL make its facts `unobserved: <bin>: not on PATH`, a timeout `unobserved: <bin>: timed out after <n>s`, and a non-zero exit `unobserved: <bin>: <first stderr line>`. No local source SHALL fetch, push, or open a network connection. Every `git` call SHALL run with `GIT_OPTIONAL_LOCKS=0` in its environment, so `git status` takes no `.git/index.lock` and a killed call leaves none behind.

#### Scenario: git takes no optional lock
- **WHEN** `dial sync katipon` runs `git status --porcelain=v2 --branch`
- **THEN** that call's environment holds `GIT_OPTIONAL_LOCKS=0` and `.git/index.lock` is not created

#### Scenario: git missing from PATH
- **WHEN** `dial sync katipon` runs with a PATH that holds no `git`
- **THEN** every git fact is `unobserved: git: not on PATH` and the exit code is 0

#### Scenario: A subprocess times out
- **WHEN** the registry's `limits` holds `subprocessTimeoutSeconds: 2` and `git status` does not return within 2 seconds
- **THEN** the facts from that command are `unobserved: git: timed out after 2s` and `dial sync` still exits 0

#### Scenario: A failing command reports its first stderr line
- **WHEN** `git stash list` exits 128 with stderr `fatal: bad object refs/stash` followed by more lines
- **THEN** the `stash` fact is `unobserved: git: fatal: bad object refs/stash`

#### Scenario: Drift runs only from sync
- **WHEN** a fake `interlock` on PATH records each invocation, and `dial next` then `dial brief katipon` are run
- **THEN** `interlock` was never invoked
- **AND** `dial sync katipon` invokes `interlock drift --json` once in the repository

#### Scenario: Drift result
- **WHEN** `interlock drift --json` prints `{"root":".","unarchived":[{"change":"add-login","tasks":9,"path":"openspec/changes/add-login"}],"stale":{"skipped":false,"reason":null,"broken":[{"spec":"openspec/specs/auth/spec.md","file":"lib/old.mjs"}],"aging":[{"spec":"openspec/specs/auth/spec.md","specCommitted":"2026-10-01T00:00:00Z","newerFiles":["lib/a.mjs"],"linkedFiles":3},{"spec":"openspec/specs/ui/spec.md","specCommitted":"2026-10-02T00:00:00Z","newerFiles":["lib/b.mjs"],"linkedFiles":1}],"indexed":4,"graphBuiltAt":"2026-11-09T08:00:00Z"},"orphans":{"skipped":true,"reason":"no --changed file list was supplied","orphans":[],"considered":0},"hasFindings":true}`
- **THEN** the drift fact holds `unarchived` `["add-login"]`, `broken` 1 (the length of `stale.broken`) and `aging` 2 (the length of `stale.aging`), with evidence `interlock drift --json: 1 unarchived, 1 broken, 2 aging`
- **AND** `orphans` is not read, because Dial never passes `--changed` and Interlock then always reports it skipped

#### Scenario: Drift without a graph
- **WHEN** `interlock drift --json` prints `"unarchived":[]` and `"stale":{"skipped":true,"reason":"no graph has been built — run /interlock:bootstrap once","broken":[],"aging":[],"graphBuiltAt":null}`
- **THEN** `unarchived` is `[]`, observed, and `broken` and `aging` are each `unobserved: interlock drift: no graph has been built — run /interlock:bootstrap once`, never 0
- **AND** the canned reply in `test/fixtures/interlock/` is captured from a real `interlock drift --json` run and its provenance row names the Interlock version

#### Scenario: interlock missing
- **WHEN** `dial sync katipon` runs and `interlock` is not on PATH
- **THEN** the drift fact is `unobserved: interlock: not on PATH` and the exit code is 0

#### Scenario: No network from a local sync
- **WHEN** fake `gh` and `glab` binaries on PATH record each invocation and `dial sync katipon` runs without `--remote`
- **THEN** neither was invoked and no git command run was `fetch`, `pull`, `push` or `ls-remote`

### Requirement: Git reports branch, cleanliness and position
The git source SHALL report `branch` from `git rev-parse --abbrev-ref HEAD`; when that prints `HEAD`, `detached` SHALL be true and `branch` the output of `git rev-parse --short HEAD`. From `git status --porcelain=v2 --branch` it SHALL report `dirty` (the count of non-`#` lines) and `ahead`/`behind` (from `# branch.ab +n -m`), and from `git stash list` the `stash` line count. A directory that is not a work tree SHALL make every git fact `unobserved: git: not a work tree`.

#### Scenario: Branch checked out
- **WHEN** the repository is on `feat/add-login`
- **THEN** `branch` is `feat/add-login` with evidence `git rev-parse --abbrev-ref HEAD: feat/add-login` and `detached` is false

#### Scenario: Detached HEAD
- **WHEN** HEAD is detached at a commit whose short sha is `3f50683`
- **THEN** `detached` is true and `branch` is `3f50683` with evidence `git rev-parse --short HEAD: 3f50683 (detached)`

#### Scenario: Ahead and behind
- **WHEN** the status header holds `# branch.ab +1 -3`
- **THEN** `ahead` is 1, `behind` is 3, and the evidence is `git status --porcelain=v2 --branch: branch.ab +1 -3`

#### Scenario: No upstream
- **WHEN** the status output has no `# branch.ab` line
- **THEN** `ahead` and `behind` are `unobserved: git: no upstream for feat/add-login`

#### Scenario: Stash count
- **WHEN** `git stash list` prints two lines
- **THEN** `stash` is 2 with evidence `git stash list: 2`

#### Scenario: Not a work tree
- **WHEN** the registered path exists but is not inside a git work tree
- **THEN** every git fact is `unobserved: git: not a work tree` and `dial sync` exits 0

### Requirement: Git reports conflicts, worktrees and the last commit
The git source SHALL report `in_progress` as `rebase` when `rebase-merge/` or `rebase-apply/` exists under `git rev-parse --git-dir`, `merge` when `MERGE_HEAD` does, else `none`; `unmerged` as the paths of `u` entries in the porcelain status; `worktrees` as the linked worktrees of `git worktree list --porcelain` (excluding the main checkout) with their branches; and `last_commit` as the 7-character sha and committer date from `git log -1 --format=%H%x09%cI`, keeping the full sha as `head`.

#### Scenario: Rebase in progress
- **WHEN** `.git/rebase-merge/` exists
- **THEN** `in_progress` is `rebase` with evidence `.git/rebase-merge: present`

#### Scenario: Merge in progress
- **WHEN** `.git/MERGE_HEAD` exists and no rebase directory does
- **THEN** `in_progress` is `merge` with evidence `.git/MERGE_HEAD: present`

#### Scenario: Unmerged files
- **WHEN** the porcelain status has one `u` entry for `lib/auth.mjs`
- **THEN** `unmerged` is `["lib/auth.mjs"]` with evidence `git status --porcelain=v2 --branch: unmerged lib/auth.mjs`

#### Scenario: Linked worktrees
- **WHEN** `git worktree list --porcelain` lists the main checkout and one worktree at `/Users/caro/IdeaProjects/katipon/.claude/worktrees/fix-a` on `fix-a`
- **THEN** `worktrees` is 1 with evidence `git worktree list --porcelain: 1 linked (fix-a)`

#### Scenario: Last commit
- **WHEN** `git log -1 --format=%H%x09%cI` prints `3f50683c1e…<tab>2026-11-10T09:12:00+08:00`
- **THEN** `last_commit` is `3f50683` dated `2026-11-10T09:12:00+08:00` with evidence `git log -1: 3f50683 2026-11-10T09:12:00+08:00`
- **AND** no commit subject, author or diff is read

### Requirement: OpenSpec reports active and archived changes
With an `openspec/` directory present, the OpenSpec source SHALL report the active changes as the directory names under `openspec/changes/` other than `archive`, and the archived changes as the directories under `openspec/changes/archive/` named `<YYYY-MM-DD>-<name>`, each with its name and archive date. Archive directories not matching that pattern SHALL be ignored. For each active change it SHALL report the newest mtime of any file under its directory.

#### Scenario: Active and archived changes
- **WHEN** `openspec/changes/` holds `add-login/`, `fix-cache/` and `archive/2026-11-10-scaffold-cli-and-registry/`
- **THEN** the active changes are `add-login` and `fix-cache` with evidence `openspec/changes/: 2 active`
- **AND** `scaffold-cli-and-registry` is archived on 2026-11-10 with evidence `openspec/changes/archive/2026-11-10-scaffold-cli-and-registry/`

#### Scenario: Unrecognised archive entry
- **WHEN** `openspec/changes/archive/old-thing/` exists
- **THEN** it is neither an active nor an archived change

#### Scenario: Newest activity in a change directory
- **WHEN** `openspec/changes/add-login/design.md` was modified at 2026-11-08T10:00:00Z and every other file earlier
- **THEN** the change's last activity is 2026-11-08T10:00:00Z with evidence `openspec/changes/add-login/design.md`

### Requirement: OpenSpec reports tasks, the manual test plan, decisions and the checkpoint
Per active change the source SHALL report `tasks_done`/`tasks_total` from `tasks.md` lines `- [<one character>] ` (done only on `x` or `X`; `0/0` when absent); the presence of `manual-test-plan.md` and its last `^Result:\s*(pass|fail)` line; the ids of `decisions.md` table rows whose third cell is `needs_human`; and `checkpoint.json` `decision.state` (`approved` or `returned`), gated on `schema: interlock.checkpoint/1`.

#### Scenario: Ticked of total
- **WHEN** `tasks.md` holds `- [x] 1.1`, `- [X] 1.2`, `- [ ] 1.3`, `- [~] 1.4` and `- [human] H1`
- **THEN** `tasks_done` is 2 and `tasks_total` is 4 with evidence `openspec/changes/add-login/tasks.md: 2/4`

#### Scenario: No tasks file
- **WHEN** the change directory has no `tasks.md`
- **THEN** `tasks_done` and `tasks_total` are 0 with evidence `openspec/changes/add-login/tasks.md: absent`

#### Scenario: Manual test plan without a result
- **WHEN** `manual-test-plan.md` exists and has no line matching `^Result:\s*(pass|fail)`
- **THEN** the manual test fact is `present, no result` with evidence `openspec/changes/add-login/manual-test-plan.md: no Result: line`

#### Scenario: Manual test plan with a result
- **WHEN** `manual-test-plan.md` holds the line `Result: pass`
- **THEN** the manual test fact is `pass` with evidence `openspec/changes/add-login/manual-test-plan.md: Result: pass`

#### Scenario: needs_human rows
- **WHEN** `decisions.md` holds rows `| D1 | Pin zod? | needs_human | — | — |` and `| D2 | Reuse helper | agent_resolved | yes | lib/a.mjs:4 |`
- **THEN** the decisions fact is `["D1"]` with evidence `openspec/changes/add-login/decisions.md: needs_human D1`

#### Scenario: Checkpoint returned
- **WHEN** `checkpoint.json` holds `"schema": "interlock.checkpoint/1"` and `decision.state` `returned`
- **THEN** the checkpoint fact is `returned` with evidence `openspec/changes/add-login/checkpoint.json decision.state: returned`

### Requirement: OpenSpec reports the living specs
With an `openspec/` directory present, the OpenSpec source SHALL walk `openspec/specs/` recursively and report one entry per living spec: the directory's path relative to `openspec/specs/`, segments joined by `/`, and the count of lines starting with `### Requirement:`, ordered by that path in code-unit order. A directory that holds a `spec.md` SHALL still be walked. The source SHALL report nothing else from a spec file.

#### Scenario: Capabilities and requirement counts
- **WHEN** `openspec/specs/` holds `registry/spec.md` with three lines starting `### Requirement:` and `doctor/spec.md` with two
- **THEN** the living specs are `doctor` with 2 requirements and `registry` with 3, in that order, with evidence `openspec/specs/: 2 living`

#### Scenario: A nested capability is named by its path
- **WHEN** `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`, `openspec/specs/ui/spec.md` has two, and `openspec/specs/ui/button/spec.md` has three
- **THEN** the living specs are `doctor` with 1, `ui` with 2 and `ui/button` with 3, in that order, with evidence `openspec/specs/: 3 living`

#### Scenario: Only the name and the count are reported
- **WHEN** `openspec/specs/registry/spec.md` holds a `## Purpose` paragraph, one `### Requirement:` line and two `#### Scenario:` blocks
- **THEN** the entry for `registry` holds its name and the count 1 and nothing else

#### Scenario: A symlinked spec file is read
- **WHEN** `openspec/specs/registry/spec.md` is a symlink to a file inside the repository with two lines starting `### Requirement:`
- **THEN** `registry` is a living spec with 2 requirements

### Requirement: The specs walk ignores what is not a capability
The walk SHALL NOT enter a dot-directory or a symlinked directory. A `spec.md` directly in `openspec/specs/` SHALL NOT be a living spec. A directory named `spec.md` SHALL be entered and SHALL NOT be read as a file. A `spec.md` symlink SHALL be read only when it resolves to a file inside the repository. A dangling link, or one that resolves to a directory, SHALL be skipped and SHALL NOT unobserve the fact. A directory with no `spec.md` SHALL NOT be an entry.

#### Scenario: A directory without a spec file is ignored
- **WHEN** `openspec/specs/drafts/` holds `notes.md` and no `spec.md`, and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs are `doctor` with 1, and `drafts` is not a living spec

#### Scenario: A dot-directory is not walked
- **WHEN** `openspec/specs/.drafts/spec.md` has four lines starting `### Requirement:`, `openspec/specs/.drafts/secret/spec.md` has two, and `openspec/specs/doctor/spec.md` has one
- **THEN** the living specs are `doctor` with 1, with evidence `openspec/specs/: 1 living`

#### Scenario: A spec file directly in the specs directory is not a capability
- **WHEN** `openspec/specs/spec.md` has four lines starting `### Requirement:` and `openspec/specs/doctor/spec.md` has one
- **THEN** the living specs are `doctor` with 1, and no entry has an empty path

#### Scenario: A symlinked directory is not entered
- **WHEN** `openspec/specs/linked` is a symlink to a directory whose `spec.md` has two lines starting `### Requirement:`, and `openspec/specs/doctor/spec.md` has one
- **THEN** the living specs are `doctor` with 1, with evidence `openspec/specs/: 1 living`

#### Scenario: A spec symlink to a directory is skipped
- **WHEN** `openspec/specs/registry/spec.md` is a symlink to a directory, and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs are `doctor` with 1, observed, with evidence `openspec/specs/: 1 living`

#### Scenario: A dangling spec symlink is skipped
- **WHEN** `openspec/specs/registry/spec.md` is a symlink to a missing path, and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs are `doctor` with 1, observed, with evidence `openspec/specs/: 1 living`

#### Scenario: A directory named spec.md is walked, not read
- **WHEN** `openspec/specs/registry/spec.md` is a directory that holds no `spec.md`, and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs are `doctor` with 1, the fact is observed, and the reason is not `EISDIR`

### Requirement: An empty specs tree is observed
A present `openspec/specs` with no living spec SHALL be an observed empty list with evidence `openspec/specs/: 0 living`. When `openspec/specs` is absent the fact SHALL be an observed empty list with evidence `openspec/specs/: absent`.

#### Scenario: A specs directory with no living spec
- **WHEN** `openspec/specs/` exists and holds `drafts/notes.md` and no `spec.md`
- **THEN** the living specs are an empty list with evidence `openspec/specs/: 0 living`

#### Scenario: No specs directory
- **WHEN** the repository has an `openspec/` directory and no `openspec/specs`
- **THEN** the living specs are an empty list with evidence `openspec/specs/: absent`

### Requirement: An unreadable specs path is unobserved
When `openspec/specs` exists but cannot be listed, when a directory the walk reaches cannot be listed, when a `spec.md` file cannot be read, or when a `spec.md` symlink resolves outside the repository, the whole specs fact SHALL be `unobserved`, naming that path and the reason. A partial list SHALL NOT be reported. The other OpenSpec facts SHALL still be reported. With no `openspec/` directory the fact SHALL be `unobserved: no openspec dir`.

#### Scenario: The specs path exists but cannot be listed
- **WHEN** `openspec/specs` is a file and `openspec/changes/add-login/` exists
- **THEN** the living specs fact is `unobserved: openspec/specs/: ENOTDIR`, the active changes are still reported, and `dial sync katipon` exits 0

#### Scenario: A directory the walk cannot list
- **WHEN** listing `openspec/specs/ui/button` fails with EACCES and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs fact is `unobserved: openspec/specs/ui/button: EACCES`, `doctor` is not reported as a living spec, the other OpenSpec facts are still reported, and `dial sync katipon` exits 0

#### Scenario: A spec file that cannot be read
- **WHEN** `openspec/specs/registry/spec.md` cannot be read (`EACCES`) and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs fact is `unobserved: openspec/specs/registry/spec.md: EACCES`, `doctor` is not reported as a living spec, the other OpenSpec facts are still reported, and `dial sync katipon` exits 0

#### Scenario: A spec symlink that leaves the repository is unobserved
- **WHEN** `openspec/specs/registry/spec.md` is a symlink to a file outside the repository, and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs fact is `unobserved: openspec/specs/registry/spec.md: outside the repository`, and `doctor` is not reported as a living spec

#### Scenario: No openspec directory
- **WHEN** the registered repository has no `openspec/` directory
- **THEN** the living specs fact is `unobserved: no openspec dir`

### Requirement: Interlock reports the current run and its liveness
The Interlock source SHALL read `.claude/ship/run.json` (`schema: interlock.run/1`) for `runId`, `change`, whether it ended (`halted` or `closedAt` set) and `stateHome`; `.claude/ship/<change>/stage.json` (its `pid` alive when signal 0 reaches it); `.claude/ship/state.json` and `plan.json` for waves done of total; the terminal `run-halt` (with `reason`) or `run-complete` line of `runs/<runId>.jsonl`, skipping other schemas and unknown `type`s.

#### Scenario: Live stage
- **WHEN** `.claude/ship/add-login/stage.json` names a pid held by a running process
- **THEN** the stage fact is `alive` with evidence `.claude/ship/add-login/stage.json pid <pid>: alive`

#### Scenario: Dead stage pid
- **WHEN** the stage pid is held by no process
- **THEN** the stage fact is `dead` with evidence `.claude/ship/add-login/stage.json pid <pid>: dead`

#### Scenario: Halted trajectory
- **WHEN** `run.json` names run `7a587a81` and `.claude/ship/runs/7a587a81.jsonl` ends with `{"schema":"interlock.ship-run/1","type":"run-halt","reason":"verify red","ts":"2026-11-09T16:22:00Z"}`
- **THEN** the terminal fact is `run-halt` with reason `verify red` and evidence `.claude/ship/runs/7a587a81.jsonl run-halt 2026-11-09T16:22:00Z`

#### Scenario: Unknown trajectory types are skipped
- **WHEN** the trajectory's last line has `type` `run-teleport` and an earlier line is `run-complete`
- **THEN** the terminal fact is `run-complete`

#### Scenario: State home redirection
- **WHEN** `run.json` holds `stateHome` `/Users/caro/IdeaProjects/katipon` and the repository is a linked worktree of it
- **THEN** the trajectory, `outcomes.jsonl`, the review-artifacts metrics and the resume card are read under `/Users/caro/IdeaProjects/katipon/.claude/`, and their evidence paths begin `~/IdeaProjects/katipon/.claude/`

### Requirement: Interlock lists every interrupted note
The Interlock source SHALL list every `.claude/ship/interrupted/*.json` note (`schema: interlock.interrupted/1`) with its `runId`, `change` and `at`. Which note, if any, counts for a change SHALL be the state model's rule, not the source's.

#### Scenario: Interrupted note
- **WHEN** `.claude/ship/interrupted/7a587a81.json` holds `runId` `7a587a81`, `change` `add-login` and `at` `2026-11-09T16:30:00.000Z`
- **THEN** the interrupted fact lists one note for `add-login` with run `7a587a81` and `at` `2026-11-09T16:30:00.000Z`, with evidence `.claude/ship/interrupted/7a587a81.json: add-login`

### Requirement: Interlock reports verdicts, outcomes, findings and the resume card
Interlock SHALL also read `.claude/ship/merge-confidence.json` (`interlock.merge-evidence/1`) for `change` and `result.verdict`; the last `.claude/learning/outcomes.jsonl` line per change for `observed.commit`, `observed.mergeVerdict` and `ts`; the `surviving` count and the `head` sha of the highest-N `.claude/ship/settle/review-r<N>.json`; the blocker count of the newest `.claude/metrics/review-artifacts-<change>-*.json`; and the resume card `.claude/handoff/ship-<change>-<runId>.md`.

#### Scenario: Merge verdict
- **WHEN** `merge-confidence.json` holds `change` `add-login` and `result.verdict` `HUMAN`
- **THEN** the merge verdict for `add-login` is `HUMAN` with evidence `.claude/ship/merge-confidence.json result.verdict: HUMAN`

#### Scenario: Last outcome per change
- **WHEN** `outcomes.jsonl` holds two lines for `add-login`, the later with `observed.commit` `3f50683` and `observed.mergeVerdict` `MERGE`
- **THEN** the outcome fact for `add-login` is commit `3f50683`, verdict `MERGE`, with evidence `.claude/learning/outcomes.jsonl: add-login commit 3f50683 verdict MERGE`

#### Scenario: Outcome committed by hand
- **WHEN** the last outcome line for `add-login` has `observed.commit` null
- **THEN** the outcome fact's commit is null, observed

#### Scenario: Newest settle round
- **WHEN** `.claude/ship/settle/` holds `review-r2.json` and `review-r10.json`, and `review-r10.json` has two `surviving` findings
- **THEN** the settle fact is 2 surviving with the record's `head`, with evidence `.claude/ship/settle/review-r10.json: 2 surviving`

#### Scenario: Review-artifacts blockers
- **WHEN** the newest file is `.claude/metrics/review-artifacts-add-login-20261110-091200.json` with findings of severity `blocker` and `minor`
- **THEN** the review-artifacts fact for `add-login` is 1 blocker with evidence `.claude/metrics/review-artifacts-add-login-20261110-091200.json: 1 blocker`

#### Scenario: Resume card
- **WHEN** `.claude/handoff/ship-add-login-7a587a81.md` exists and `run.json` names run `7a587a81` for `add-login`
- **THEN** the resume card fact is that path, observed

### Requirement: Escapement queue entries are read from files only
The home SHALL be `ESCAPEMENT_HOME` trimmed and tilde-expanded, else `~/.escapement`; Dial reads `queue/{pending,running,done,halted,failed}/<id>.json`. An entry belongs to a repo when its resolved `repo`, or its real path, equals the registered path. Its state is its directory; an id in two directories takes the one matching its last `transitions[].to`. An absent home SHALL make every Escapement fact `unobserved: <home>: absent`. Dial SHALL never execute `escapement` nor create its home.

#### Scenario: Pending entry
- **WHEN** `~/.escapement/queue/pending/q-123.json` has `repo` `/Users/caro/IdeaProjects/katipon` and `change` `add-login`
- **THEN** the queue fact for `add-login` is `pending` with evidence `~/.escapement/queue/pending/q-123.json: pending`

#### Scenario: Duplicate id after a crash
- **WHEN** `q-123.json` is in both `running/` and `done/` and its last transition has `to` `done`
- **THEN** the queue fact is `done`

#### Scenario: Symlinked repository path
- **WHEN** the entry's `repo` is `/Users/caro/code/katipon`, a symlink to the registered `/Users/caro/IdeaProjects/katipon`
- **THEN** the entry belongs to `katipon`

#### Scenario: Home absent
- **WHEN** `ESCAPEMENT_HOME` is unset and `~/.escapement` does not exist
- **THEN** every Escapement fact is `unobserved: ~/.escapement: absent`, `dial sync` exits 0, and `~/.escapement` still does not exist

#### Scenario: The binary is never run
- **WHEN** a fake `escapement` on PATH records each invocation and `dial sync katipon`, `dial next` and `dial brief katipon` run
- **THEN** `escapement` was never invoked

### Requirement: Escapement journal observations annotate an entry
For each matched entry, the source SHALL read `journal/<UTC date>.jsonl` for today and yesterday (UTC) and take the newest line with `event: "observation"` and `entry` equal to the entry id, reporting `detail.class`, `detail.category`, `detail.reason` and `detail.runId`. Malformed lines SHALL be skipped. The newest `transitions[].ts` of the entry SHALL be reported as its last activity.

#### Scenario: Newest observation
- **WHEN** `~/.escapement/journal/2026-11-10.jsonl` holds two observation lines for `q-123`, the later with `detail` `{ "class": "halt", "category": "verify-red", "reason": "tests failed", "runId": "7a587a81" }`
- **THEN** the observation fact is class `halt`, category `verify-red`, reason `tests failed`, run `7a587a81` with evidence `~/.escapement/journal/2026-11-10.jsonl observation q-123: halt verify-red`

#### Scenario: Only yesterday's file holds it
- **WHEN** `DIAL_NOW` is `2026-11-10T01:00:00Z` and the only observation for `q-123` is in `journal/2026-11-09.jsonl`
- **THEN** that observation is reported

#### Scenario: No observation
- **WHEN** neither journal file has an observation for `q-123`
- **THEN** the observation fact is observed as none with evidence `~/.escapement/journal: no observation for q-123`

### Requirement: The last Claude Code session comes from transcript mtimes
The sessions source SHALL derive the slug from the registered absolute path by replacing every character outside `[A-Za-z0-9-]` with `-`, list depth-1 `*.jsonl` under `~/.claude/projects/<slug>/`, every `<slug>--claude-worktrees-*` directory and each linked worktree's slug, and report `last_session` as the newest mtime. Under `dial brief --session <id>`, `<id>.jsonl` SHALL be excluded. No file found SHALL give `unobserved: no sessions under ~/.claude/projects/<slug>`. Contents SHALL not be read.

#### Scenario: Slug derivation
- **WHEN** the registered path is `/Users/caro/IdeaProjects/dial`
- **THEN** the source reads `~/.claude/projects/-Users-caro-IdeaProjects-dial/`
- **AND** for `/Users/caro/My Repo.v2` it reads `~/.claude/projects/-Users-caro-My-Repo-v2/`

#### Scenario: Worktree sessions roll up
- **WHEN** the newest transcript is `~/.claude/projects/-Users-caro-IdeaProjects-dial--claude-worktrees-fix-a/s2.jsonl`
- **THEN** `last_session` is its mtime with evidence `~/.claude/projects/-Users-caro-IdeaProjects-dial--claude-worktrees-fix-a/s2.jsonl`

#### Scenario: Only depth-1 transcripts count
- **WHEN** `~/.claude/projects/-Users-caro-IdeaProjects-dial/s1/subagents/a.jsonl` is newer than every depth-1 `*.jsonl`
- **THEN** it does not set `last_session`

#### Scenario: The live session is excluded
- **WHEN** `dial brief dial --session s9` runs and `s9.jsonl` is the newest transcript
- **THEN** `last_session` is the mtime of the next newest transcript

#### Scenario: No sessions
- **WHEN** `~/.claude/projects/-Users-caro-IdeaProjects-dial/` does not exist and no worktree slug directory does
- **THEN** `last_session` is `unobserved: no sessions under ~/.claude/projects/-Users-caro-IdeaProjects-dial` and the exit code is 0

### Requirement: Sessions are also found under the real path's slug
When a registered path differs from its real path, the sessions source SHALL also derive a slug from the real path and read its transcripts, because Claude Code derives its slug from its physical working directory.

#### Scenario: A symlinked registration reads the physical slug too
- **WHEN** the registered path is `/Users/caro/code/dial`, a symlink to `/Users/caro/IdeaProjects/dial`, and the only transcripts are under `~/.claude/projects/-Users-caro-IdeaProjects-dial/`
- **THEN** `last_session` is the newest of those transcripts
