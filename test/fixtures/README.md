# Fixtures

Authored on 2026-11-10 for the `scaffold-cli-and-registry` change from the
delta specs under `openspec/changes/scaffold-cli-and-registry/specs/`. Paths
inside them (`/vaults/...`, `/repos/...`) are placeholders; tests that need real
directories copy a fixture into a temp home and rewrite those paths.

| file | derived from | what it pins |
|------|--------------|--------------|
| `registry-valid.json` | `specs/registry/spec.md`, "Well-formed file loads" | marker `dial.registry/1`, two vaults, one repo, empty `limits` |
| `registry-wrong-schema.json` | `specs/registry/spec.md`, "Wrong schema marker" | `dial_schema` is `dial.registry/0`; refused naming the file and the value |
| `registry-not-json.txt` | `specs/registry/spec.md`, "File is not JSON" | text that fails `JSON.parse` |
| `settings-allow-dial.json` | `specs/doctor/spec.md`, permissions; shape of Interlock `settings-sources.mjs` | `permissions.allow` holds `Bash(dial:*)`, covering the `dial` requirement |
| `settings-allow-narrow.json` | `specs/doctor/spec.md`, permissions | `Bash(dial doctor:*)` is narrower and must not cover `dial` |
| `settings-broken.json` | `specs/doctor/spec.md`, "Unreadable settings file" | truncated JSON; reported as an error, never thrown |

## `build-the-dial-ledger` additions

Authored on 2026-11-11 for the `build-the-dial-ledger` change (task 1.1) from
`openspec/changes/build-the-dial-ledger/design.md` §The fact and §The state
machine, and `specs/state-model/spec.md`. Every `facts/` file is one envelope,
`{ now, limits, facts, notes, expect }`: `facts` is a `RepoFacts` bundle
(`{ value, evidence }` or `{ value: null, unobserved, evidence? }` at every
leaf; an observed absence is the value `absent` or `none`, never `unobserved`),
`notes` is a `NoteView` keyed by note name (`katipon--add-login`), `now` is the
`DIAL_NOW` the scenario fixes, `limits` the two caps it reads, and `expect` what
`derive` must return for the `add-login` item (`state`, `needsMe`, `suggested`,
and where the spec pins them `evidence`, evidence `rows` by fact, `stale`,
`idleDays`, `lastActivity`). Every bundle is the same spec-draft baseline with
only the signals its state needs changed, so a state's fixture matches nothing
above it. The `ESCAPEMENT_CHECKPOINT_URL` suffix is already in `checkpoint.json`'s
`needsHuman` evidence, because `derive` takes no environment. Per-change maps
(`stages`, `outcomes`, `reviewArtifacts`, `resumeCards`, `trajectoryTs`,
`escapement.entries`) carry an explicit observed-absent fact for `add-login`.
The facts are hand-authored, not captured from a real repository; the paths
(`/repos/katipon`) and ids are placeholders. The vault fixtures are hand-written
notes in the shape of `specs/note-rendering/spec.md`, not renderer output.

| file | derived from | what it pins |
|------|--------------|--------------|
| `facts/archived.json` | `state-model`, "archived" | archive entry names the change, no active dir; `needs_me` false, no suggestion |
| `facts/dropped.json` | `state-model`, "dropped" | note frontmatter `dropped: 2026-11-08` beside a halted run; still `dropped` |
| `facts/archive-pending.json` | `state-model`, "archive-pending from ticked tasks" | 9/9 tasks, no PR; evidence `tasks.md: 9/9` |
| `facts/conflict.json` | `state-model`, "conflict from a rebase" | `inProgress` `rebase`; evidence `.git/rebase-merge: present` |
| `facts/ci-red.json` | `state-model`, "ci-red" | open PR 38, `ci` `fail` from `lint` |
| `facts/needs-fix.json` | `state-model`, "needs-fix from settle" | settle 2 surviving with `head` equal to the checked-out `HEAD` |
| `facts/manual-test.json` | `state-model`, "manual-test" | plan present with no `Result:`; the note's only `## Next` box is unticked and unrelated |
| `facts/pr-open.json` | `state-model`, "pr-open" | open PR 38, checks pass, no merge verdict so `needs_me` true |
| `facts/shipped.json` | `state-model`, "shipped" | last outcome commit `3f50683`, PR observed `none` |
| `facts/halted.json` | `state-model`, "halted from the trajectory" | `run-halt` `verify red` at `2026-11-09T16:22:00Z`, resume card present |
| `facts/shipping.json` | `state-model`, "shipping from a live stage" | unclosed run `9c01d2e4`, stage pid 48211 alive |
| `facts/queued.json` | `state-model`, "queued" | Escapement `pending` entry `q-123` |
| `facts/checkpoint.json` | `state-model`, "checkpoint from a needs_human row" | `needs_human` row `D1`, checkpoint URL in the evidence |
| `facts/spec-draft.json` | `state-model`, "spec-draft" | 2/5 tasks, nothing else |
| `facts/spec-approved.json` | `state-model`, "Approved draft" | review-artifacts file plus `checkpoint.json` `approved`; suggests `/interlock:ship add-login` |
| `facts/all-signals.json` | `state-model`, "Priority walk" | every signal present; yields `archived`; `expect.walk` is the order removing them walks |
| `facts/repo-only.json` | `state-model`, "Repo without OpenSpec or PR" | `no openspec dir`, branch `main`; no items, repo-level `idle` |
| `facts/stale.json` | `state-model`, "Fifteen idle days is stale" | `queued`, newest activity `2026-10-26T08:00:00Z` (the queue transition), `now` 2026-11-10T09:00:00Z |
| `facts/interrupted-old-run.json` | `state-model`, "An old interrupted note does not halt a live re-run" | note for run `7a587a81` beside a live run `9c01d2e4`; `shipping` |
| `facts/interrupted-superseded.json` | `state-model`, "A later closed run supersedes an interrupted note" | note at 2026-11-09T16:30Z, outcome at 2026-11-10T08:00Z, `run.json` names `fix-cache`; `shipped` |
| `facts/settle-other-head.json` | `state-model`, "A settle record for another commit does not count" | settle `head` `a1b2c3d…`, checked-out `3f50683…`; `spec-draft`, with the `settle` row text |
| `vault/Notes/Login ideas.md` | `note-rendering`, "human-owned bytes" | a hand-written `type: note`; no Dial key, never rewritten |
| `vault/Changes/katipon--add-login.md` | `note-rendering`, change-note anatomy | a Dial change note: edited `## Next` (one ticked box), one `## Narrative` entry, a human `## Scratch` section, the unknown frontmatter key `source`, a generated `## State` table |

## `escapement/` (task 3.5)

Hand-authored on 2026-11-11 from the queue-entry and journal shapes in
`design.md` §Context (Escapement `lib/home.mjs`); not captured from a live
home. `__REPO__` is replaced with a real temp path by the test.

| file | what it pins |
|------|--------------|
| `escapement/entry-pending.json` | a `pending` entry `q-123` for `add-login`, one transition |
| `escapement/entry-crashed.json` | the same id after a crash; last transition `to: done`, so the `done/` copy wins over `running/` |
| `escapement/journal-2026-11-10.jsonl` | two `observation` lines for `q-123` (the later is `halt`/`verify-red`), a malformed line, a non-observation, another entry's observation |

## `transcripts/session.jsonl` (task 3.6)

Hand-authored on 2026-11-11 in the shape of a Claude Code transcript; not a
real session. Six text turns once filtered: user, one assistant message
(`msg_1`) split over three lines with `thinking`, `tool_use` and two `text`
blocks around a `tool_result` user line, a user line with two `text` blocks,
and `msg_2`. It also holds a `summary` line, an `isMeta` user line, an
`isSidechain` assistant line and one malformed line, all of which must not
appear.


## Source fixtures (tasks 3.2, 3.4, 3.7)

Authored on 2026-11-11 for the `build-the-dial-ledger` change.

| file | derived from | what it pins |
|------|--------------|--------------|
| `git/status-dirty-ab.txt`, `status-no-upstream.txt`, `status-unmerged.txt` | hand-written in the shape of `git status --porcelain=v2 --branch` (git 2.x) | two entries with `# branch.ab +1 -3`; no `# branch.ab` line; one `u` entry for `lib/auth.mjs` |
| `git/worktree-list.txt`, `git/log-last.txt` | hand-written in the shape of `git worktree list --porcelain` and `git log -1 --format=%H%x09%cI` | main checkout plus one linked worktree on `fix-a`; a full sha, a tab, a committer date |
| `interlock/run.json`, `run-halted-statehome.json`, `run-schema-2.json` | `interlock.run/1` as written by Interlock 1.16.0 (fields trimmed to those Dial reads) | open run `7a587a81`; a halted run with `stateHome` (`__STATEHOME__` is replaced by the test); an unknown schema |
| `interlock/trajectory-{halt,complete,open}.jsonl` | `interlock.ship-run/1` lines (fields trimmed) | a run ending in `run-halt` with a foreign-schema line, a non-JSON line and an unknown trailing type; one ending in `run-complete`; an open run |
| `interlock/outcomes.jsonl`, `merge-confidence.json`, `interrupted-7a587a81.json`, `settle-r{2,10}.json`, `review-artifacts-add-login-*.json`, `ship-add-login-7a587a81.md`, `state.json`, `plan.json` | the shapes in `design.md` §Interlock (hand-trimmed, not captured) | a null-commit outcome, a HUMAN verdict, an interrupted note with `spokenAt`, two settle rounds (r10 beats r2), two review-artifacts files, a resume card, a wave cursor of a four-wave plan |
| `interlock/drift.json` | captured from a real `interlock drift --json` run, Interlock 1.16.0, on 2026-11-11, in a scratch repository with one fully ticked change and a built graph | `unarchived` holds `add-login`; `stale.skipped` false, empty `broken` and `aging` |
| `interlock/drift-no-graph.json` | captured from a real `interlock drift --json` run, Interlock 1.16.0, on 2026-11-11, in this repository (no graph) | `stale.skipped` true with the no-graph reason |
| `remote/gh-pr*.json`, `gh-checks*.json`, `glab-mr.json`, `glab-ci.json` | field lists of `gh` 2.93.0 and `glab` 1.102.0 `--help`; values hand-written | open, conflicting and merged PRs; pending and failing checks; a GitLab MR with conflicts and a failed pipeline. NOT captured from a live forge |
| `remote/gh-pr-none.stderr.txt`, `gh-checks-none.stderr.txt`, `glab-mr-none.stderr.txt`, `glab-ci-none.txt`, `gh-auth.stderr.txt` | message strings read out of the installed `gh` 2.93.0 and `glab` 1.102.0 binaries (`no pull requests found for branch %q`, `no checks reported on the '%s' branch`, `no open merge request available for %q`, `No pipelines running or available on branch: %s`); the auth text is gh's documented not-logged-in message | the no-PR, no-checks, no-MR and no-pipeline replies. NOT live captures: the session's `gh` token was invalid and the sandbox allowed no forge host, so the exit codes and stream (stderr or stdout) are assumed. Re-capture against a real repository before relying on them |
