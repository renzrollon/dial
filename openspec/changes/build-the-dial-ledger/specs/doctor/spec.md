# Spec Delta

## MODIFIED Requirements

### Requirement: The report has a header and exits 1 only on a failing check
The text report SHALL begin with `DIAL OK — <n> passed` when no check failed, or `DIAL BLOCKED — <n> failing check(s)` otherwise, appending `, <n> warning(s)` when any check warned, then a line `  home: <path>`. `<n> passed` SHALL equal `counts.ok`; a `skip` does not count. The exit code SHALL be 1 when any check is `fail` and 0 otherwise. JSON SHALL carry `ok`, `home`, `counts`, `checks`, `failures` and `warnings`.

#### Scenario: All green
- **WHEN** doctor runs its twelve checks on a machine where `obsidian` is not on PATH (`obsidian-cli` is `skip`), every registered vault is scaffolded and none is nested, a narrate endpoint resolves, the LaunchAgent is `running`, `dial` is on PATH and `Bash(dial:*)` is allowed, so the other eleven checks are `ok` and none warns or fails
- **THEN** the first line is `DIAL OK — 11 passed`, `counts.ok` is 11, and the exit code is 0

#### Scenario: Warnings only
- **WHEN** one check warns and none fails
- **THEN** the first line ends with `, 1 warning(s)` and the exit code is 0

#### Scenario: One failure
- **WHEN** one check fails
- **THEN** the first line is `DIAL BLOCKED — 1 failing check(s)`, `failures` in the JSON holds that id, and the exit code is 1

#### Scenario: Skips do not count as passed
- **WHEN** the environment of the all-green scenario has, in addition, no narrate endpoint configured and no LaunchAgent installed, so `obsidian-cli`, `narrate-endpoint` and `launch-agent` are `skip`
- **THEN** the first line is `DIAL OK — 9 passed`, `counts.skip` is 3, and the exit code is 0

#### Scenario: New checks never block
- **WHEN** no vault is scaffolded, two vaults are nested, the LaunchAgent is `paths-missing`, `dial` is not on PATH, `obsidian-cli` and `narrate-endpoint` are `skip`, and `node`, `home`, `registry`, `boundary`, `permissions` and `fields` are `ok`
- **THEN** the first line is `DIAL OK — 6 passed, 4 warning(s)` and the exit code is 0

### Requirement: The preconditions checked are node, home, registry and the Obsidian CLI
Doctor SHALL run, in order, `node`, `home`, `registry`, `obsidian-cli`, `boundary`, `permissions`, `vault-scaffold`, `vault-nesting`, `narrate-endpoint`, `launch-agent`, `on-path` and `fields`. `node` fails below major 22; `home` probes without creating it; `registry` is ok when the file is absent, fail when it is invalid or a vault is not a directory, warn when a repo path is missing or not a work tree; `obsidian-cli` is ok when `obsidian` is on PATH, else skip. The last six SHALL NOT fail.

#### Scenario: No registry yet
- **WHEN** no registry file exists
- **THEN** the `registry` check is `ok` with the detail `no registry yet` and the file path as evidence

#### Scenario: Vault path missing
- **WHEN** a registered vault's path does not exist
- **THEN** the `registry` check is `fail`, names the vault and its path, and the exit code is 1

#### Scenario: Repo path moved
- **WHEN** a registered repo's path no longer exists
- **THEN** the `registry` check is `warn` naming that path, and the exit code is 0 if nothing else fails

#### Scenario: Obsidian CLI absent
- **WHEN** no `obsidian` executable is on PATH
- **THEN** the `obsidian-cli` check is `skip`, its detail says direct file writes are the primary path, and the exit code is unaffected

#### Scenario: Checks appear in order
- **WHEN** `dial doctor --json` is run
- **THEN** the `id`s of `checks` are exactly `node`, `home`, `registry`, `obsidian-cli`, `boundary`, `permissions`, `vault-scaffold`, `vault-nesting`, `narrate-endpoint`, `launch-agent`, `on-path`, `fields`, in that order, and the text rows follow the same order

#### Scenario: Later checks survive a registry that does not load
- **WHEN** the registry file exists but is not valid JSON
- **THEN** `registry` is `fail`, `vault-scaffold` and `vault-nesting` are `skip` with the detail `registry not loaded`, and none of the six later checks is `fail`

## ADDED Requirements

### Requirement: The vault-scaffold check warns on a vault without the Dial layout
The `vault-scaffold` check SHALL be `ok` when every registered vault has `Projects/`, `Changes/` and `Dial.base` at its root, and SHALL otherwise be `warn`, with one evidence line per incomplete vault naming the vault and its missing entries and one fix line per incomplete vault `dial vault init <name>`. With no vaults registered it SHALL be `ok`; when the registry does not load, `skip` with the detail `registry not loaded`. It SHALL NOT write into any vault.

#### Scenario: Scaffolded vaults
- **WHEN** every registered vault has `Projects/`, `Changes/` and `Dial.base`
- **THEN** the `vault-scaffold` check is `ok`

#### Scenario: Vault missing Dial.base
- **WHEN** the `personal` vault has `Projects/` and `Changes/` but no `Dial.base`
- **THEN** the `vault-scaffold` check is `warn`, its evidence includes `personal: missing Dial.base`, its fix is `dial vault init personal`, and the exit code is 0 if nothing else fails

#### Scenario: Fresh vault
- **WHEN** the `work` vault has none of the three entries
- **THEN** the evidence includes `work: missing Projects/, Changes/, Dial.base` and the vault is byte-identical afterwards

### Requirement: The vault-nesting check warns when one registered vault lies inside another
The `vault-nesting` check SHALL compare the resolved absolute paths of every pair of registered vaults, segment by segment, and SHALL be `warn` when one path is equal to or lies inside another, with a detail naming both vaults and evidence giving both paths. Otherwise it SHALL be `ok` with the detail `no nested vaults`, or `skip` with `registry not loaded` when the registry does not load.

#### Scenario: The work/work case
- **WHEN** vault `work` is `~/Documents/Obsidian Vault/work` and vault `work-inner` is `~/Documents/Obsidian Vault/work/work`
- **THEN** the `vault-nesting` check is `warn`, its detail is `vault work-inner lies inside vault work`, its evidence holds both absolute paths, and the exit code is 0 if nothing else fails

#### Scenario: Shared prefix is not nesting
- **WHEN** vault `work` is `/v/work` and vault `work2` is `/v/work2`
- **THEN** the `vault-nesting` check is `ok` with the detail `no nested vaults`

### Requirement: The narrate-endpoint check reports the resolved endpoint without a network call
The `narrate-endpoint` check SHALL resolve the narrate endpoint the way `dial narrate` does, from `~/.pi/agent/models.json` and the registry's `narrate` block, without contacting it. When a URL and a model resolve it SHALL be `ok` with the detail `<url> (<model>)` and evidence naming where each came from; otherwise `skip` with the detail `no narrate endpoint configured`. The built-in fallback alone SHALL NOT count, and no API key value SHALL be printed.

#### Scenario: Endpoint from pi's models file
- **WHEN** `~/.pi/agent/models.json` holds provider `mtplx` with `baseUrl` `http://127.0.0.1:8000/v1`, `apiKey` `sk-local-123` and the first model `mtplx-qwen38-27b-optimized-speed`, and the registry has no `narrate` block
- **THEN** the `narrate-endpoint` check is `ok` with the detail `http://127.0.0.1:8000/v1 (mtplx-qwen38-27b-optimized-speed)`, and neither the text nor the JSON report contains `sk-local-123`

#### Scenario: Registry override wins
- **WHEN** the models file resolves as above and the registry's `narrate` holds `url` `http://127.0.0.1:9000/v1` and `model` `qwen3.6`
- **THEN** the detail is `http://127.0.0.1:9000/v1 (qwen3.6)`

#### Scenario: Nothing configured
- **WHEN** there is no `~/.pi/agent/models.json` and the registry has no `narrate` block
- **THEN** the `narrate-endpoint` check is `skip` with the detail `no narrate endpoint configured`

#### Scenario: Unreachable endpoint is still ok
- **WHEN** the endpoint resolves but nothing listens at its URL
- **THEN** the check is `ok` and doctor opens no network connection

### Requirement: The launch-agent check reports the LaunchAgent status
The `launch-agent` check SHALL read the status `dial agent status` reports for `com.dial.sync`, using `DIAL_LAUNCHCTL_BIN` when set: `running` is `ok`, `not-installed` is `skip`, and `loaded-not-running`, `not-loaded` and `paths-missing` are `warn` with the status as the detail and the same fix `dial agent status` prints for that outcome. It SHALL NOT install, load or kick the agent.

#### Scenario: Agent running
- **WHEN** the plist exists and `launchctl print` reports `state = running` with a pid
- **THEN** the `launch-agent` check is `ok`

#### Scenario: Agent never installed
- **WHEN** `$HOME/Library/LaunchAgents/com.dial.sync.plist` does not exist
- **THEN** the `launch-agent` check is `skip` and the exit code is unaffected

#### Scenario: Agent loaded but not running
- **WHEN** the plist exists and `launchctl print` reports a state other than running and no pid
- **THEN** the check is `warn` with the detail `loaded-not-running` and the fix `launchctl kickstart -k gui/<uid>/com.dial.sync`

#### Scenario: Node binary moved
- **WHEN** the plist's Node path no longer exists
- **THEN** the check is `warn` with the detail `paths-missing` and the fix `dial agent install`

### Requirement: The on-path check warns when dial is not on PATH
The `on-path` check SHALL be `ok` with the resolved path as evidence when an executable named `dial` is found in a `PATH` directory, and SHALL otherwise be `warn` with the detail `dial is not on PATH` and the fix `npm i -g .`, because the skills call `dial` by name.

#### Scenario: Installed globally
- **WHEN** `PATH` holds a directory with an executable `dial`
- **THEN** the `on-path` check is `ok` and its evidence is that file's path

#### Scenario: Not installed
- **WHEN** no `PATH` directory holds an executable `dial`
- **THEN** the `on-path` check is `warn`, its fix is `npm i -g .`, and the exit code is 0 if nothing else fails

### Requirement: The fields check lists every frontmatter key Dial writes
The `fields` check SHALL always be `ok` with the detail `frontmatter keys dial writes into a vault (listed in --json evidence)` and one evidence line per note kind, `<kind>: <key>, <key>, …`, naming every frontmatter key Dial writes into that kind of note, then one line naming the generated body sections and what they carry, so an owner can see exactly what leaves a repository. It SHALL read no repository and no vault.

#### Scenario: Evidence names every key
- **WHEN** `dial doctor --json` is run
- **THEN** the `fields` check is `ok` and its evidence is exactly the six lines `change note: title, type, repo, change, scope, state, needs_me, stale, branch, pr, pr_state, ci, merge_verdict, tasks_done, tasks_total, last_commit, last_session, last_activity, created, updated, status, tags, aliases, dial_schema, dropped, archived`, `repo note: title, type, repo, scope, state, needs_me, stale, branch, dirty, stash, ahead, behind, worktrees, last_commit, last_session, last_activity, active_changes, created, updated, status, tags, aliases, dial_schema`, `summary note: type, tags, dial_schema`, `daily note: type, updated`, `review note: title, created, updated, type, status, tags, dial_schema` and `body sections: ## State (fact, value, evidence: repository-relative file paths, commands run, PR and pipeline URLs, check names, run ids), ## Changes, ## Drift (counts), ## Recent narrative (narrative text), daily log lines`

#### Scenario: Fields never warns
- **WHEN** no registry file exists and no vault is registered
- **THEN** the `fields` check is still `ok` with the same six evidence lines

### Requirement: The boundary audit fails when a registered repo lies under another vault's root
Besides the note audit, the `boundary` check SHALL fail for each registry entry whose path's root vault (registry `roots`) differs from its registered vault, naming the entry path, the root and both vaults, with the fix `dial unregister <repo>, then dial register <path> --vault <root vault> --host <host>`. A registry without `roots` adds nothing to the check.

#### Scenario: Entry contradicts its root
- **WHEN** `~/VSCodeProjects/agentbase` is registered to `personal` and `roots` is `{ "~/VSCodeProjects": "work" }`
- **THEN** the `boundary` check is `fail`, its detail names `~/VSCodeProjects/agentbase`, `~/VSCodeProjects`, `personal` and `work`, and the exit code is 1

#### Scenario: Entries agree with their roots
- **WHEN** every entry under `~/VSCodeProjects` is registered to `work` and `roots` is `{ "~/VSCodeProjects": "work" }`
- **THEN** the root audit adds no failure to the `boundary` check
