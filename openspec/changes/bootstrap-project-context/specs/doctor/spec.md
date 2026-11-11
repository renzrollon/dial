# Spec Delta

## MODIFIED Requirements

### Requirement: The fields check lists every frontmatter key Dial writes
The `fields` check SHALL always be `ok` with the detail `frontmatter keys dial writes into a vault (listed in --json evidence)` and one evidence line per note kind, `<kind>: <key>, <key>, …`, naming every frontmatter key Dial writes into that kind of note (the change and repo lines built from the renderers' own key lists, so they cannot drift from what is written), then one line naming the generated body sections and what they carry, so an owner can see exactly what leaves a repository. It SHALL read no repository and no vault.

#### Scenario: Evidence names every key
- **WHEN** `dial doctor --json` is run
- **THEN** the `fields` check is `ok` and its evidence is exactly the six lines `change note: title, type, repo, change, scope, state, needs_me, stale, branch, pr, pr_state, ci, merge_verdict, tasks_done, tasks_total, last_commit, last_session, last_activity, created, updated, status, tags, aliases, dial_schema, dropped, archived`, `repo note: title, type, repo, scope, state, needs_me, stale, branch, dirty, stash, ahead, behind, worktrees, last_commit, last_session, last_activity, active_changes, created, updated, status, tags, aliases, dial_schema, archived`, `summary note: type, tags, dial_schema`, `daily note: type, updated`, `review note: title, created, updated, type, status, tags, dial_schema` and `body sections: ## State (fact, value, evidence: repository-relative file paths, commands run, PR and pipeline URLs, check names, run ids), ## Changes, ## Specs (capability names, requirement counts), ## Drift (counts), ## Recent narrative (narrative text), daily log lines`

#### Scenario: Fields never warns
- **WHEN** no registry file exists and no vault is registered
- **THEN** the `fields` check is still `ok` with the same six evidence lines
