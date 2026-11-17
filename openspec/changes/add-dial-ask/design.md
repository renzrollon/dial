# Design

## Context

See `proposal.md` — Why. The ground was read on 2026-11-16 and 2026-11-17; the conclusions are in `.claude/handoff/explore-add-dial-ask-20261117-002853.md`. What shapes the approach:

- **Only the pull request of the checked-out branch is ever looked up.** `fetchGithub` runs `gh pr view <branch>` and `gh pr checks <branch>` (`lib/sources/github.mjs:37-65`); `fetchGitlab` runs the `glab` twins (`lib/sources/gitlab.mjs:37-63`). `PR_FIELDS` asks for `mergeStateStatus`, `reviewDecision` and `isDraft` (`lib/sources/github.mjs:9`) and the `pr` object drops them (`:46-53`).
- **One door to the network.** `gh` and `glab` run only under `dial sync --remote` or `--due-remote` (living spec `remote-sources`, "The network is used only by a remote sync"). Every other command reads the cache and never writes it.
- **The cache is one file per repo, written whole.** `remoteFacts` builds `{ fetchedAt, host, branch, pr, checks }` and hands it to `writeCache` without reading the old file (`lib/remote.mjs:58-59`). `readCache` checks the marker only (`lib/cache.mjs:38-44`); `remoteFacts` validates `pr` and `checks` and ignores every other key (`lib/remote.mjs:71`). A cache for another branch reads as unobserved (`:68`).
- **The read side already exists.** `repoView` returns `{ facts, derived, notes }` for one repo, offline (`lib/next.mjs:46-62`). `brief` shows the pattern for a model-facing read command: resolve, view, build lines, pass every line through `redact(line, [repo, ...change names])` (`lib/brief.mjs:105-139`).
- **Forge strings are attacker-chosen.** Check names are cut to `[A-Za-z0-9 ._:/()-]` and 40 characters where they are read (`lib/sources/github.mjs:70-77,99`). A pull request title, branch or author is chosen the same way, by anyone who can open a pull request.

Constraints are unchanged: Node 22+, no dependencies, every missing source is one `unobserved` value, nothing throws out of a source.

## Goals / Non-Goals

**Goals:**

- One command answers "which pull requests are open, which can merge, what blocks the rest" from data Dial holds, with the verdict computed by a tested function and not by the model.
- A remote sync keeps that data current at the cost of one more forge call.
- What reaches a model session is cut and redacted the way the brief is.
- No existing fact, note, state or command output changes.

**Non-Goals:**

- No change to `collectRepo`, `RepoFacts`, `derive`, `dial next`, `dial brief` or any rendered note (D21).
- No second network door: `dial context` has no refresh flag (D3).
- No merge, approve or rebase action. Dial reports; the owner acts.
- No per-reviewer detail, no review comments, no diff. The verdict uses the forge's own summary fields.

## Decisions

### Scope (D1, D2, D16)

This change is `/dial:ask` and what it needs. The SessionEnd record fallback discussed beside it is left for its own change (D1): the request names only the skill and its three questions, and the fallback touches `record` and `narrate`, none of this change's files. There is no cross-repo form (D2): `dial next --vault` already lists what needs the owner across repos (`lib/next.mjs:69-75`), and a per-repo context printed for every repo would exceed any useful cap. The package version does not move (D16): the plugin spec requires `plugin.json` to equal `package.json`, not a bump per skill.

### Three layers, one direction of data

```
dial sync --remote                    dial context [<repo>]              /dial:ask
  fetch pr + checks  (unchanged)        repoView()  ── facts, items,       1. dial sync <repo> --remote
  list open PRs      (new)              notes (unchanged, offline)         2. dial context <repo> --json
  writeCache({ …, prs, prsError })      openPullRequests() ── cache        3. answer from that document
                                        readiness(pr) per item
                                        redact → JSON or text
```

Collect writes; context reads; the skill runs both. Nothing flows back.

### The list is a step of the remote fetch (D5, D6, D17, D22)

`remoteFacts` gains one step after `forge.fetch` returns `ok` and before `writeCache`: `forge.list({ cwd, exec, timeoutMs, max })`, where `max` is `limits.remotePullRequests` (falling back to the published default when the caller passes limits without it, as `lib/remote.mjs:55` does for the timeout). It uses the same `exec` and `timeoutMs` as the fetch, so `subprocessTimeoutSeconds` and `DIAL_DEADLINE_MS` bound it without new code.

- **All open pull requests, with the author recorded (D5).** The registry holds a host, not a forge login (`lib/registry.mjs:14`), so "mine" cannot be computed without another call or a new registry key. The owner's repos are small; the cap is 20.
- **A failed list does not fail the fetch (D6).** Making it part of the all-or-nothing fetch would let a slow list take away today's `pr` and `ci` facts. So the cache is written with the fresh `pr` and `checks` either way. On a failed list `remoteFacts` reads the previous cache, keeps its `prs` when its `host` matches, and writes `prsError: { at, reason }`. On success it writes the new `prs` and no `prsError`. This is the one place the write path now reads the old cache first.
- **The list runs only after a complete fetch (D17).** A failed fetch must leave the cache byte for byte, and a detached HEAD has no fetch at all (`lib/remote.mjs:48`); the cache's `branch` key is required by its readers (`:68`). Running the list alone would need a cache without a branch. The cost: on a detached HEAD the list is as old as the last complete fetch, and `dial context` prints that age.
- **Not under `--dry-run`.** A dry run writes no cache, so a list would be a forge call whose result is thrown away.
- **Sync's own output does not change (D22).** `remoteFacts` still returns exactly `pr`, `ci` and `remote`. A failed list is visible in the cache and in `dial context`, nowhere else. Alternative rejected: a fourth fact, which would add a row to every State table and a line to `sync.jsonl` for something only `context` reads.

Commands: `gh pr list --state open --limit <n+1> --json number,title,headRefName,baseRefName,url,author,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,updatedAt` and `glab mr list -F json -P <n+1>`. Asking for one more than the cap is how `more` is known without a count call.

### The cache gains two optional keys and keeps its marker (D11)

```
{ dial_schema: "dial.cache/1", fetchedAt, host, branch, pr, checks,
  prs?:      { fetchedAt, items: [PullRequest…], more },
  prsError?: { at, reason } }
```

The marker stays `dial.cache/1`. Every existing reader ignores unknown keys (`lib/remote.mjs:71`), so an old binary reads a new cache correctly, and a new binary reads an old cache as "list not fetched yet". Bumping the marker would make every existing cache unreadable until the next remote sync, for no reader's benefit. `prs.fetchedAt` is separate from the top-level one because after a failed list the two differ.

### One normalised shape for both forges (D12)

```
PullRequest = { number, title, branch, base, url, author, draft, review, mergeState, conflicting, checks, updatedAt }
```

| field | GitHub (`gh pr list --json`) | GitLab (`glab mr list -F json`) |
|---|---|---|
| `number` | `number` | `iid` |
| `branch`, `base` | `headRefName`, `baseRefName` | `source_branch`, `target_branch` |
| `url`, `author` | `url`, `author.login` | `web_url`, `author.username` |
| `draft` | `isDraft` | `draft` or `work_in_progress` |
| `review` | `reviewDecision` lowercased, `""` → `none` | null |
| `mergeState` | `mergeStateStatus` lowercased | `detailed_merge_status` lowercased |
| `conflicting` | `mergeable === 'CONFLICTING'` | `has_conflicts === true` |
| `checks` | `statusCheckRollup` → `[{ name, bucket }]` | null |

`mergeState` keeps the forge's own word. Translating both vocabularies into a third at write time would lose the word a person can look up, and would need a cache rewrite each time a forge adds a state. The translation happens once, in `readiness`.

GitLab's list reports no review decision and no pipeline, so both are null (D12). `detailed_merge_status` already encodes approval, discussion and pipeline gates (`not_approved`, `discussions_not_resolved`, `ci_must_pass`, `ci_still_running`), so readiness loses little. A per-merge-request pipeline call was rejected: up to 20 more subprocesses per sync.

Roll-up entries come in two shapes, read from the `gh` source (`api/export_pr.go`, read 2026-11-17): a check run has `name`, `status` and `conclusion`; a status context has `context` and `state`. The bucket mapping is in the `remote-sources` delta; a word Dial does not know is `pending`, so a new forge state can delay a "yes" but never produce one.

### Forge strings are cut twice, by one module (D7, D18, D19)

New module `lib/sources/forge.mjs` holds what the two sources share:

- `cutText(value, max, empty)` — the check-name rule with a length and a fallback. `checkName` in `lib/sources/github.mjs` becomes `cutText(name, 40, 'unnamed')` and stays exported; its output does not change.
- `cutRef(value)` — branch and base: characters outside `[A-Za-z0-9_./-]` become `-`, first 100 kept.
- `cutUrl(value)` — kept only when it starts with `https://`, holds no whitespace and is at most 200 characters.
- `cutWord(value)` — lowercased, null unless it matches `^[a-z_]+$`.
- `rollup(checks)` and `listed(names)` — the `fail > pending > cancel > pass` roll-up and the "three names, else a count" rule, moved out of `describeGithub` so readiness uses the same code and not a copy.
- `cutPullRequest(item)` — applies the cuts above to one normalised item, returns null without an integer `number`.

The cuts run when the list is cached, so the Dial home never holds raw forge text, and again in `openPullRequests` when it is read (D18), because the cache is a plain file and `readCache` checks only its marker. `describeGithub` already cuts check names at read time for that reason. The cuts are idempotent, so the second pass changes nothing in a cache Dial wrote.

The lengths are sanitiser constants like `NAME_MAX` and `NAMES_LISTED` (`lib/sources/github.mjs:67-68`), not published caps (D19): they bound a string's shape, not how much Dial shows, and no owner would tune them.

Titles, branches and authors stay in the Dial home and in `dial context` output (D7). No vault note gains them, so the open question D8 of `bootstrap-project-context` (may Dial copy repository prose into the vault) is not prejudged here.

### Readiness is a pure function (D8, D12, D20)

New module `lib/readiness.mjs` exports `readiness(pr) → { ready: 'yes' | 'no' | 'unknown', blockers: string[] }`. It takes a normalised item and nothing else: no clock, no host, no I/O. The host does not matter because the two vocabularies do not collide.

Blockers are named in a fixed order, each at most once:

1. `draft` — `draft` true, or state `draft` / `draft_status`
2. `conflict` — `conflicting` true, or state `dirty` / `conflict`
3. `behind base` — state `behind` / `need_rebase`
4. `changes requested` — review `changes_requested`, or state `requested_changes`
5. `review required` — review `review_required`, or state `not_approved`
6. `unresolved discussions` — state `discussions_not_resolved`
7. checks — `ci failing: <names>`, `checks pending: <names>`, `ci cancelled: <names>` by the roll-up; state `ci_must_pass` → `ci must pass`, `ci_still_running` → `checks pending`
8. fallback — state `blocked` with nothing named above → `blocked by branch protection`; any other state outside the pass-through list → `merge state: <words>`

Pass-through states, which name no blocker: `clean`, `has_hooks`, `mergeable`, `unstable`, `unknown`, `unchecked`, `checking`, `preparing`, `approvals_syncing`. `ready` is `no` with any blocker, `yes` only for `clean`, `has_hooks` or `mergeable`, else `unknown`.

- **Stricter than the merge button (D8).** GitHub's `unstable` means "mergeable, but its commit statuses are not all passing". Dial names the failing check and says `no`. `derive` already treats any failing check as needing the owner (`lib/derive.mjs:106,236`), and a second, looser meaning of "CI is fine" in the same tool would be a trap. The owner can still merge; Dial just does not call it ready.
- **Never `yes` from silence.** `unknown` (GitHub computes mergeability lazily), a null state, or `checking` gives `unknown`, with whatever blockers the other fields prove.
- **A state Dial has no rule for blocks (D20).** Both forges report a named state only when something prevents a plain merge: GitHub's `MergeStateStatus` has eight values and GitLab's `detailed_merge_status` twenty-four (forge documentation, read 2026-11-17), and every one outside the pass-through list is a reason the merge is refused. So an unrecognised word is printed as `merge state: status checks must pass` and not swallowed into `unknown`. GitLab adds states between versions; this rule means a new one shows up by name with no code change.

Alternative rejected: relay the raw fields and let the session judge. That is untestable and varies by run, and "can I merge" is the question the owner most needs to be the same answer twice.

### `dial context` is a new capability built on `repoView` (D3, D9, D14, D15, D21)

New module `lib/context.mjs`:

- `context({ registry, arg, limits, env, now, home, exec }) → { ok: true, doc } | { ok: false, unregistered: true, reason }` — resolve the repo as `brief` does, call `repoView` unchanged, call `openPullRequests`, build the document, redact every string.
- `formatContext(doc, { contextLines })` — the text form, capped.

`openPullRequests({ repo, home, limits, now })` lives in `lib/remote.mjs` beside the code that writes the list. It returns the `pullRequests` object of the spec minus the per-item verdict: observed or not, the reason, the age, `stale` (older than `remoteIntervalMinutes`, the cap that already means "a cached forge reply is no longer fresh"), `more`, `error`, and the re-cut items. It compares the cache's `host` with the registry's and ignores the cache's `branch`: the list is repo-wide and must survive a branch switch.

- **Offline (D3).** Context is one of "every other command" in the network rule. A `--refresh` flag would be a second door; freshness is the skill's job (D4).
- **A separate reader, not a new fact (D21).** `collectRepo` has one `remoteFacts` caller (`lib/collect.mjs:77`) whose result feeds `derive`. Adding the list there would put it in front of `derive`, the State table and three other commands for no reader but this one.
- **A new capability (D9).** `next-and-brief` is "the two offline read commands" with a 40-line orientation contract; context has a different reader and a different cap.
- **A pull request is tied to a change only through `derive` (D15).** `change` is the derived item whose `pr` leaf already holds that number (`lib/derive.mjs:331-337`); `current` is true when the cache's own `pr` for the checked-out branch has that number. No second attribution rule, so context can never disagree with the State table about which change owns a pull request.
- **Notes: unticked Next items and the newest narrative entries (D14).** That is all `readNotes` returns besides frontmatter (`lib/vault.mjs:66-92`). Human-written sections other than those two are not relayed.
- **Items include those that do not need the owner.** "What is blocking this repo" needs the `shipping` and `pr-open` items too, each with its evidence rows. Order is `compareItems`, so the top of the list agrees with `dial next`.
- **Redaction.** JSON: every string value passes `redact(value, keep)` with `keep = [repo, ...change names]`, as the brief does per line. Text: each line is redacted after it is built. A pull request title is cut first and redacted second.

The text form is for a person at a terminal; the skill reads `--json`. `contextLines` cuts only the text form: the JSON document is already bounded by `remotePullRequests`, `contextNarrative` and the number of active changes, and a cut JSON document is not JSON.

`bin/dial.mjs` gains `context: { options: { json: 'flag' }, args: 1 }`, a usage line after `brief`, and a dispatch case shaped like `brief` without `--hook` and `--session`. It does not read `DIAL_DEADLINE_MS`: no hook runs it.

Exit codes follow the one-reason-line rule with no exception (compound note N5, which found `agent status` exiting 1 with an empty stderr): `dial context` exits 0 whenever the repo resolves, whatever is unobserved, and its only exit 1 is a refusal that prints one `dial: <reason>` line.

### Three published caps (D10)

`remotePullRequests` 20 (`open pull requests kept per repo by a remote sync`), `contextNarrative` 5 (`narrative entries dial context prints`), `contextLines` 200 (`maximum lines dial context prints as text`), appended to `LIMITS` and `DESCRIPTIONS` in that order. The limits spec requires every applied cap to be published, and the registry's override check reads `LIMITS`, so the three become overridable with no other code.

### The skill (D4, D13)

`skills/ask/SKILL.md`, frontmatter `name: ask`, `argument-hint: "[<question>]"`, `allowed-tools: Bash(dial sync:*), Bash(dial context:*)`.

1. Run `dial sync <repo> --remote --json`. If it fails, say so in one line and go on. If the row's `remote` is `unobserved`, the refresh failed: say so with the reason, and that the list is the cached one (D24).
2. Run `dial context <repo> --json`.
3. Answer `$ARGUMENTS` from that document only. With no question, give the rundown: open pull requests with `ready` and `blockers`, items with `needsMe`, the Next items.

- **A remote sync on every ask (D4).** `--due-remote` would reuse a list up to `remoteIntervalMinutes` (30) old, too coarse for "can I merge now". The sync is three forge calls. When it fails, the document still carries the cached list with its age and `stale` flag, and the skill is told to say so.
- **`$ARGUMENTS`, not `$1` (D13).** A question is free text with spaces. Positional arguments are 0-based in Claude Code skills, which `skills/handoff/SKILL.md:10` gets wrong today; that file is outside this change.
- **The repo** is the session's repository, by name or path, unless the question names another registered repo.
- **Data, not instructions.** The skill says so in words, and the cuts and redaction above are what make it safe when the words are not enough. `suggested` commands are drafts, as in `/dial:next`.
- **No other command.** `allowed-tools` grants only the two. The skill is told not to run `gh` to fill a gap: an `unobserved` list is the answer.
- **A Sandbox section**, as the handoff skill has: the sync writes the vault and the Dial home and reaches the forge.

### Lists that enumerate commands, caps and skills

Each has a reader that pins it, and each gets a task: the usage text and option table (`bin/dial.mjs:27-93`), the command-count test (`test/cli.test.mjs:17-22`), the skill and pack lists (`test/plugin.test.mjs:59,95`), `test/limits.test.mjs`, the README (commands, caps table, plugin section), `docs/how-dial-works.md`, the plugin description (`.claude-plugin/plugin.json:4`) and the setup script's prompt (`scripts/setup.mjs:182`). No manifest lists skills; they are found by directory.

## Risks / Trade-offs

- [A remote sync makes a third forge call, so tests that count calls change] → The known pins are named in `tasks.md` and updated in the red wave. `--dry-run` and failed fetches make the same number of calls as before.
- [The roll-up mapping is verified against the `gh` source, not a live reply; this repo has no CI] → An unknown word is `pending`, which can only withhold a `yes`. H1 pins a real reply as a fixture.
- [GitLab list fields are verified against the API documentation, not a live GitLab] → A missing `detailed_merge_status` (GitLab before 15.6) gives `unknown`, never `yes`. H1 pins a real reply.
- [GitHub computes mergeability lazily; a first list can say `UNKNOWN`] → `ready` is `unknown` and the next sync settles it. The skill reports `unknown` as printed.
- [A list that keeps failing is easy to miss: sync still exits 0] → `dial context` prints `last list failed: <reason>` and the age of the list it kept; the skill is told to say both.
- [A failed fetch is easy to miss: sync still exits 0, the cache stays byte for byte, and a list under `remoteIntervalMinutes` is not `stale`] → `dial sync --json` carries the run's `remote` fact per repo; the skill runs the sync with `--json` and reports an `unobserved` `remote` as a failed refresh, with its reason (D24).
- [Every `/dial:ask` runs a full sync, which rewrites the repo's notes when something changed] → That is what `dial sync` does everywhere else, and the background agent runs it every `syncIntervalMinutes` anyway.
- [On a detached HEAD the list is not refreshed (D17)] → The age and `stale` flag say so.
- [A fresh fetch and a cached read word their `pr` and `ci` evidence differently, so a remote sync followed by a plain sync rewrites the note (compound note N4, open since `build-the-dial-ledger`); each `/dial:ask` adds one such cycle] → Not fixed here (D23). This change adds no new difference, because the list reaches no note, and the fix would reword existing evidence that the living `remote-sources` spec pins. Flagged for its own change.
- [Pull request titles from other people sit in `~/.config/dial/cache`] → Cut to a fixed character set and length before they are written; never rendered into a vault.
- [`claude-plugin`'s Purpose line names two skills and a delta cannot edit it] → Reads stale until the living spec is edited by hand after archive.
- [Up to 20 pull requests with long blocker lists could crowd the text form] → `contextLines` 200 cuts it and points at `--json`.
