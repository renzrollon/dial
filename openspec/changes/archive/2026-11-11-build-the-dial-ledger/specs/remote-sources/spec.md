# Spec Delta

## Purpose

The pull request and CI facts Dial fetches from GitHub through `gh` and from GitLab through `glab`: when a fetch runs, which fields are read, how "no PR" differs from a failed fetch, and the cache under the Dial home that lets an offline read still show the last-seen state.

## ADDED Requirements

### Requirement: The network is used only by a remote sync
`gh` and `glab` SHALL be run only by `dial sync --remote`, and by `dial sync --due-remote` for a repo whose cache is absent or whose `fetchedAt` is older than `remoteIntervalMinutes`. Every other command, including `dial sync` without either flag, `dial next` and `dial brief`, SHALL read remote facts from the cache only and SHALL never write it. The branch looked up SHALL be the git source's `branch`.

#### Scenario: Offline sync
- **WHEN** fake `gh` and `glab` binaries on PATH record each invocation and `dial sync katipon` runs
- **THEN** neither binary was invoked and the exit code is 0

#### Scenario: next and brief never fetch
- **WHEN** the same fakes are on PATH and `dial next` and `dial brief katipon` run
- **THEN** neither binary was invoked and `$DIAL_HOME/cache/remote/katipon.json` is unchanged

#### Scenario: Remote sync fetches
- **WHEN** `dial sync katipon --remote` runs on branch `feat/add-login` with host `github`
- **THEN** `gh pr view feat/add-login …` and `gh pr checks feat/add-login …` are each invoked once in the repository

#### Scenario: Due remote skips a fresh cache
- **WHEN** `remoteIntervalMinutes` is 30, `DIAL_NOW` is `2026-11-10T09:00:00Z`, and katipon's cache has `fetchedAt` `2026-11-10T08:50:00Z`
- **THEN** `dial sync katipon --due-remote` does not invoke `gh`
- **AND** with `fetchedAt` `2026-11-10T08:15:00Z` it does

#### Scenario: Detached HEAD is not looked up
- **WHEN** `dial sync katipon --remote` runs with HEAD detached
- **THEN** `gh` is not invoked and the `pr` and `ci` facts are `unobserved: detached HEAD, no branch to look up`

### Requirement: The registry's host picks the CLI
A repo whose registry `host` is `github` SHALL be fetched with `gh` only, and one whose host is `gitlab` with `glab` only. Each call SHALL run in the repository with the `subprocessTimeoutSeconds` cap. A CLI not on PATH SHALL make `pr` and `ci` `unobserved: <bin>: not on PATH`, and a timeout `unobserved: <bin>: timed out after <n>s`; `dial sync` SHALL still exit 0.

#### Scenario: GitLab repo never calls gh
- **WHEN** `dial sync work-api --remote` runs for an entry with host `gitlab` and both fakes on PATH
- **THEN** only `glab` was invoked

#### Scenario: CLI missing
- **WHEN** `dial sync katipon --remote` runs with host `github` and no `gh` on PATH
- **THEN** `pr` and `ci` are `unobserved: gh: not on PATH` and the exit code is 0

### Requirement: GitHub supplies the pull request and its checks
For a GitHub repo Dial SHALL run `gh pr view <branch> --json number,state,url,mergeable,mergeStateStatus,reviewDecision,isDraft,mergedAt,updatedAt,headRefName` and, when a PR exists, `gh pr checks <branch> --json name,bucket,state,link`. A checks reply whose stdout parses as a JSON array SHALL be a result whatever the exit code, including exit 8 while checks are pending. `ci` SHALL be `fail` if any `bucket` is `fail`, else `pending`, else `cancel`, else `pass`.

#### Scenario: Open pull request
- **WHEN** `gh pr view` prints `{"number":38,"state":"OPEN","url":"https://github.com/renzrollon/katipon/pull/38","mergeable":"MERGEABLE","isDraft":false,"updatedAt":"2026-11-09T22:10:00Z",…}`
- **THEN** `pr` is number 38, state `open`, url `https://github.com/renzrollon/katipon/pull/38`, with evidence `gh pr view 38: OPEN`

#### Scenario: Conflicting pull request
- **WHEN** the reply has `"mergeable":"CONFLICTING"`
- **THEN** `pr` is conflicting with evidence `gh pr view 38 mergeable: CONFLICTING`

#### Scenario: Merged pull request
- **WHEN** the reply has `"state":"MERGED"` and `"mergedAt":"2026-11-09T10:00:00Z"`
- **THEN** `pr` is state `merged`, merged at `2026-11-09T10:00:00Z`, with evidence `gh pr view 38: MERGED 2026-11-09T10:00:00Z`

#### Scenario: Pending checks exit 8
- **WHEN** `gh pr checks` exits 8 and prints `[{"name":"unit","bucket":"pass"},{"name":"e2e","bucket":"pending"}]`
- **THEN** `ci` is `pending` with evidence `gh pr checks feat/add-login: pending (e2e)`

#### Scenario: A failing check
- **WHEN** the checks are `lint` with bucket `fail` and `unit` with bucket `pass`
- **THEN** `ci` is `fail` with evidence `gh pr checks feat/add-login: fail (lint)`

### Requirement: GitLab supplies the merge request and its pipeline
For a GitLab repo Dial SHALL run `glab mr view <branch> -F json`, reading `iid`, `state`, `web_url`, `has_conflicts`, `draft`, `merged_at`, `updated_at` and `source_branch`, with `opened` read as `open` and `locked` as `closed`; and `glab ci status -b <branch> -F json`, reading the pipeline `status`, with `failed` as `fail`, `success` as `pass`, `canceled` as `cancel`, `skipped` as `skipping`, and every other status as `pending`.

#### Scenario: Open merge request with conflicts
- **WHEN** `glab mr view feat/add-login -F json` prints `{"iid":12,"state":"opened","web_url":"https://gitlab.example/team/api/-/merge_requests/12","has_conflicts":true,…}`
- **THEN** `pr` is number 12, state `open`, conflicting, with evidence `glab mr view 12: opened, has_conflicts`

#### Scenario: Failed pipeline
- **WHEN** `glab ci status -b feat/add-login -F json` prints a pipeline with `"status":"failed"`
- **THEN** `ci` is `fail` with evidence `glab ci status -b feat/add-login: failed`

#### Scenario: Running pipeline
- **WHEN** the pipeline status is `running`
- **THEN** `ci` is `pending`

### Requirement: No checks and no pipeline are observed as ci none
`ci` SHALL be `none`, a result and never a failed fetch, when `gh pr checks` prints an empty array, when it exits non-zero with stderr `no checks reported on the '<branch>' branch`, or when `glab ci status` reports that the branch has no pipeline. The no-checks and no-pipeline replies SHALL be captured from the real binaries and pinned under `test/fixtures/remote/`.

#### Scenario: A PR with no checks
- **WHEN** `gh pr checks feat/add-login` exits 1 with stderr `no checks reported on the 'feat/add-login' branch`
- **THEN** `ci` is `none` with evidence `gh pr checks feat/add-login: no checks`, the fetch counts as complete, and the cache is written

#### Scenario: An empty checks array
- **WHEN** `gh pr checks` prints `[]` and exits 0
- **THEN** `ci` is `none`, not `pass`

#### Scenario: A branch with no pipeline
- **WHEN** `glab ci status -b feat/add-login -F json` gives the pinned no-pipeline reply
- **THEN** `ci` is `none` with evidence `glab ci status -b feat/add-login: no pipeline`, and the cache is written

### Requirement: No pull request is an observed null; a failed fetch is unobserved
When `gh` reports `no pull requests found` or `glab` reports `no open merge request`, `pr` SHALL be observed as null with evidence `<bin> pr view <branch>: no pull request` (`mr view` for glab), `ci` SHALL be observed as null, and the checks command SHALL not run. Any other non-zero exit, including an authentication or rate-limit failure, SHALL fail the fetch with the reason `<bin>: <first stderr line>`, which `pr` and `ci` carry as `unobserved` when no previous cache exists.

#### Scenario: Branch without a PR
- **WHEN** `gh pr view feat/add-login` exits 1 with stderr `no pull requests found for branch "feat/add-login"`
- **THEN** `pr` is null with evidence `gh pr view feat/add-login: no pull request`, `ci` is null, and `gh pr checks` was not invoked

#### Scenario: Not authenticated
- **WHEN** katipon has no cache file and `gh pr view` exits 4 with stderr `To get started with GitHub CLI, please run:  gh auth login` and a second line
- **THEN** `pr` and `ci` are `unobserved: gh: To get started with GitHub CLI, please run:  gh auth login`

#### Scenario: Rate limited
- **WHEN** katipon has no cache file and `gh pr view` exits 1 with stderr `GraphQL: API rate limit exceeded for user ID 1.`
- **THEN** `pr` is `unobserved: gh: GraphQL: API rate limit exceeded for user ID 1.` and the exit code of `dial sync --remote` is 0

### Requirement: A completed fetch writes the cache
After a fetch in which every command returned a result (no PR counts as a result), `dial sync` SHALL write `$DIAL_HOME/cache/remote/<repo>.json` atomically as `{ dial_schema: "dial.cache/1", fetchedAt, host, branch, pr, checks }`, where `pr` is the read PR fields or null and `checks` is a list of `{ name, bucket }`. Under `--dry-run` the cache SHALL not be written. The cache SHALL hold no token, header or environment value.

#### Scenario: Cache after a fetch
- **WHEN** `DIAL_NOW=2026-11-10T08:00:00Z dial sync katipon --remote` reads PR 38 open and one passing check `unit`
- **THEN** `$DIAL_HOME/cache/remote/katipon.json` has `dial_schema` `dial.cache/1`, `fetchedAt` `2026-11-10T08:00:00.000Z`, `host` `github`, `branch` `feat/add-login`, `pr.number` 38 and `checks` `[{"name":"unit","bucket":"pass"}]`

#### Scenario: GitLab cache entry for the pipeline
- **WHEN** a GitLab fetch reads a pipeline with status `failed`
- **THEN** the cache's `checks` is `[{"name":"pipeline","bucket":"fail"}]`

#### Scenario: Dry run writes no cache
- **WHEN** `dial sync katipon --remote --dry-run` runs with no cache file
- **THEN** `$DIAL_HOME/cache/remote/katipon.json` does not exist afterwards

### Requirement: Without a fetch the facts come from the cache, dated
Without a fetch, `pr` and `ci` SHALL be read from the cache, with the evidence a fetch would have written followed by ` as of <fetchedAt>`. A missing cache SHALL give `unobserved: no remote cache, run dial sync --remote`; a cache whose `dial_schema` is not `dial.cache/1` `unobserved: cache/remote/<repo>.json schema <x> not understood`; a cache for another branch or host `unobserved: remote cache is for <host> branch <branch>`.

#### Scenario: Cached PR in an offline sync
- **WHEN** katipon's cache has `fetchedAt` `2026-11-10T08:00:00.000Z`, branch `feat/add-login` and PR 38 open, and `dial sync katipon` runs on `feat/add-login`
- **THEN** `pr` is 38 open with evidence `gh pr view 38: OPEN as of 2026-11-10T08:00:00.000Z`

#### Scenario: No cache yet
- **WHEN** `dial next` runs and katipon has no cache file
- **THEN** katipon's `pr` and `ci` are `unobserved: no remote cache, run dial sync --remote`

#### Scenario: Branch changed since the fetch
- **WHEN** the cache names branch `feat/add-login` and the repository is now on `main`
- **THEN** `pr` and `ci` are `unobserved: remote cache is for github branch feat/add-login`

#### Scenario: Unknown cache schema
- **WHEN** the cache file holds `"dial_schema": "dial.cache/9"`
- **THEN** `pr` and `ci` are `unobserved: cache/remote/katipon.json schema dial.cache/9 not understood`

### Requirement: A failed fetch keeps the previous cache
When any command of a fetch is unobserved, the cache file SHALL be left byte for byte as it was. `pr` and `ci` SHALL then come from that cache with ` as of <fetchedAt>` evidence, and a `remote` fact SHALL carry `unobserved: <bin>: <first stderr line>`; with no previous cache, `pr` and `ci` SHALL carry that unobserved reason themselves.

#### Scenario: Offline remote sync keeps the last-seen state
- **WHEN** katipon's cache holds PR 38 fetched at `2026-11-10T08:00:00.000Z` and `dial sync katipon --remote` runs while `gh pr view` exits 1 with stderr `error connecting to api.github.com`
- **THEN** the cache file is unchanged, `pr` is 38 open with evidence `gh pr view 38: OPEN as of 2026-11-10T08:00:00.000Z`, and `remote` is `unobserved: gh: error connecting to api.github.com`

#### Scenario: Checks fail after the PR read
- **WHEN** `gh pr view` succeeds and `gh pr checks` times out
- **THEN** the cache file is unchanged and `ci` comes from the previous cache, or is `unobserved: gh: timed out after 10s` when there is none
