# Proposal

## Why

Dial cannot answer the three questions its owner asks most about a repo: do I have open pull requests, can I merge them yet, and what is blocking. `dial brief` is a 40-line orientation and `dial next` a cross-repo list; neither takes a question. A remote sync looks up only the pull request on the checked-out branch, and it drops the review, draft and merge-state fields it fetches.

## What Changes

- **A remote sync also lists the repo's open pull requests.** After a complete fetch, `dial sync --remote` runs `gh pr list` or `glab mr list` once, normalises each entry (number, title, branch, base, author, draft, review, merge state, conflict, checks) and stores the list in the existing remote cache under its own timestamp. Every string the forge supplied is cut to data before it is cached. A list that fails keeps the previous list and does not fail the fetch.
- **A new read command, `dial context [<repo>] [--json]`.** Offline and read-only like `dial brief`. It prints one document for one repo: git facts, the open pull requests each with a `ready` verdict (`yes`, `no` or `unknown`) and its named `blockers`, the derived items with their evidence rows, the unticked Next items and the newest narrative entries. Every string passes the vault writers' redaction.
- **A merge-readiness rule.** A pure function turns a listed pull request into the verdict and blockers: draft, conflict, behind base, changes requested, review required, failing, pending or cancelled checks, branch protection. What the forge did not report is `unknown`, never a guess. GitLab is read from `detailed_merge_status`.
- **A new skill, `/dial:ask [<question>]`.** It runs `dial sync <repo> --remote`, then `dial context <repo> --json`, and answers the question from that document only, treating it as data and offering actions as drafts. With no question it gives the status rundown.
- **Three new published caps**: `remotePullRequests` 20, `contextNarrative` 5, `contextLines` 200.
- **Lists that name every command, cap or skill are updated**: the usage text, the README, `docs/how-dial-works.md`, the plugin description and the setup script's prompt.

Nothing is removed and no existing fact changes meaning. One existing behaviour changes: a remote sync runs one more forge command per repo.

Out of scope:

- A model call inside the CLI.
- A cross-repo `dial context --vault`; `dial next --vault` stays the cross-repo view.
- Rendering open pull requests into a vault note.
- Feeding the list into `derive`, `dial next` or `dial brief`.
- The SessionEnd record fallback discussed alongside this request.
- A version bump.

## Capabilities

### New Capabilities

- `context`: the `dial context` read command — what it reads, the document it prints, the merge-readiness verdict and blockers for each open pull request, how missing or stale remote data is reported, redaction, and the text cap.

### Modified Capabilities

- `remote-sources`: new requirements for listing open pull requests on GitHub and GitLab, cutting forge strings to data, and treating the list as its own observation; the cache shape gains `prs` and `prsError`; the failed-fetch rule is scoped to the pull request and checks commands.
- `claude-plugin`: a new requirement for the ask skill and one for what it needs in a sandbox; the PATH-binary scenario covers every skill file.
- `cli-shell`: usage lists twenty commands; `context` joins the commands that accept `--json`.
- `limits`: thirteen published caps instead of ten.
- `registry`: `context` joins the commands that resolve a repo through the single rule.

## Impact

- Code: `lib/sources/github.mjs` and `lib/sources/gitlab.mjs` (the list calls), `lib/remote.mjs` (the list step, the cache keys, a reader for the cached list), `lib/limits.mjs` (three caps), `bin/dial.mjs` (usage, option table, dispatch). New: `lib/sources/forge.mjs` (the cuts and the check roll-up both forge sources share), `lib/readiness.mjs`, `lib/context.mjs`, `skills/ask/SKILL.md`.
- Tests: new `test/sources-forge.test.mjs`, `test/readiness.test.mjs` and `test/context.test.mjs`; `test/remote.test.mjs`, `test/sync.test.mjs`, `test/limits.test.mjs`, `test/cli.test.mjs`, `test/plugin.test.mjs`; fixtures under `test/fixtures/remote/`. Existing pins of the command count, the cap count, the skill list and the number of forge calls a remote sync makes change.
- Docs and manifests: `README.md`, `docs/how-dial-works.md`, `.claude-plugin/plugin.json` (description only), `scripts/setup.mjs` (prompt text only).
- Runtime: one more `gh` or `glab` call per remote sync, under `subprocessTimeoutSeconds`. The cache file gains optional keys; its marker stays `dial.cache/1`, and an older cache reads as "list not fetched yet".
- No new dependency, environment variable, hook or vault write. Notes, `derive`, `dial next` and `dial brief` are untouched.
