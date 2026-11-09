# doctor Specification

## Purpose
The precondition report for a Dial installation: which checks `dial doctor` runs, what each check record carries, how the report renders as text and JSON, when the exit code is 1, and the two checks that guard the work/personal boundary and the Claude Code permission rule.

## Requirements

### Requirement: Every check is a record with a status, detail and evidence
Each check SHALL produce a record with `id`, `status` (one of `ok`, `warn`, `fail`, `skip`), a one-line `detail`, an `evidence` array of strings, and an optional `fix` string. A check that throws SHALL be reported as `fail` with the detail `check could not run: <message>`, and doctor SHALL still report every other check.

#### Scenario: Record shape in JSON
- **WHEN** `dial doctor --json` is run
- **THEN** every element of `checks` has `id`, `status`, `detail` and `evidence`, and `status` is one of the four values

#### Scenario: A throwing check does not stop the report
- **WHEN** one check throws
- **THEN** its record has status `fail` and a detail starting `check could not run:`, and the remaining checks still appear

### Requirement: The report has a header and exits 1 only on a failing check
The text report SHALL begin with `DIAL OK — <n> passed` when no check failed, or `DIAL BLOCKED — <n> failing check(s)` otherwise, appending `, <n> warning(s)` when any check warned, then a line `  home: <path>`. `<n> passed` SHALL equal `counts.ok`; a `skip` does not count. The exit code SHALL be 1 when any check is `fail` and 0 otherwise. JSON SHALL carry `ok`, `home`, `counts`, `checks`, `failures` and `warnings`.

#### Scenario: All green
- **WHEN** doctor runs `node`, `home`, `registry`, `obsidian-cli`, `boundary` and `permissions`, `obsidian-cli` is `skip`, the other five are `ok`, and none warns or fails
- **THEN** the first line is `DIAL OK — 5 passed`, `counts.ok` is 5, and the exit code is 0

#### Scenario: Warnings only
- **WHEN** one check warns and none fails
- **THEN** the first line ends with `, 1 warning(s)` and the exit code is 0

#### Scenario: One failure
- **WHEN** one check fails
- **THEN** the first line is `DIAL BLOCKED — 1 failing check(s)`, `failures` in the JSON holds that id, and the exit code is 1

### Requirement: Rows render with four-character marks and indented evidence and fix
Each check SHALL render as `  [<mark>] <id>: <detail>` where the mark is `ok  `, `warn`, `FAIL` or `skip`. For `warn` and `fail`, each evidence line SHALL follow indented by nine spaces, then `      fix: <first line>` when a fix exists, with further fix lines indented by eleven spaces. `ok` and `skip` rows SHALL be one line.

#### Scenario: Failing row with evidence and a multi-line fix
- **WHEN** a failing check has two evidence strings and a two-line fix
- **THEN** the output has the row, two lines starting with nine spaces, a `      fix:` line, and one line starting with eleven spaces, in that order

#### Scenario: Passing row is one line
- **WHEN** a check passes with evidence attached
- **THEN** only the `  [ok  ] <id>: <detail>` line is printed for it

### Requirement: The preconditions checked are node, home, registry and the Obsidian CLI
Doctor SHALL run `node` (fail below major version 22), `home` (probe without creating the home), `registry` (ok when the file is absent, fail when it is invalid or a vault path is not a directory, warn when a repo path is missing or not a git work tree) and `obsidian-cli` (ok when `obsidian` is on PATH, otherwise skip). The `obsidian-cli` skip detail says direct file writes are the primary path.

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
- **THEN** the `obsidian-cli` check is `skip` and the exit code is unaffected

### Requirement: The boundary audit fails when a vault note names a repo registered to another vault
Doctor SHALL read `Projects/*.md` and `Changes/*.md` in every registered vault and SHALL NOT write. A Dial note has frontmatter `dial_schema`. Its repo is frontmatter `repo`, else the filename stem before the first `--` under `Changes/`. A repo registered to another vault SHALL fail the check, naming the file and both vaults. A registry file that fails to load SHALL skip the check with detail `registry not loaded`; a missing file is an empty load.

#### Scenario: Vaults without Dial notes
- **WHEN** no registered vault has `Projects/` or `Changes/`, or they hold no Dial notes
- **THEN** the `boundary` check is `ok` with the detail `no dial notes` and one evidence line per vault

#### Scenario: Deliberate mis-registration
- **WHEN** `Changes/katipon--uat-readiness.md` in the personal vault has `dial_schema` and `repo: katipon`, and `katipon` is registered to `work`
- **THEN** the `boundary` check is `fail`, its detail names that file path, `personal` and `work`, and the exit code is 1

#### Scenario: Hand-written note is ignored
- **WHEN** `Projects/Holiday.md` in a vault has frontmatter without `dial_schema`
- **THEN** it does not affect the `boundary` check

#### Scenario: Repo taken from the filename
- **WHEN** a Dial note `Changes/specflow--clear-findings.md` has `dial_schema` but no `repo` key
- **THEN** its repo is `specflow` for the audit

#### Scenario: Doctor never writes to a vault
- **WHEN** `dial doctor` runs against vaults with notes
- **THEN** every file under every vault is byte-identical afterwards and no file was created

#### Scenario: Registry failed to load
- **WHEN** the registry file exists but is not valid JSON
- **THEN** the `boundary` check is `skip` with the detail `registry not loaded`

### Requirement: The permissions check decides whether the dial allow rule is covered
Doctor SHALL read `permissions.allow`, `deny` and `ask` from the managed, user, project and local Claude Code settings. Project and local are `.claude/settings.json` and `.claude/settings.local.json` under the current working directory. The check SHALL NOT read the registry. Covered `Bash(dial:*)` is `ok`; uncovered, denied or unreadable is `warn`. Evidence lists each file read as `<scope>: <path>`.

#### Scenario: Rule present in user settings
- **WHEN** the user settings file allows `Bash(dial:*)`
- **THEN** the `permissions` check is `ok`

#### Scenario: Local settings under the working directory
- **WHEN** doctor is run from a directory whose `.claude/settings.local.json` allows `Bash(dial:*)` and no other settings file covers the rule
- **THEN** the `permissions` check is `ok` and its evidence includes `local: <cwd>/.claude/settings.local.json`

#### Scenario: Broad rule covers it
- **WHEN** a settings file allows `Bash` or `Bash(*)`
- **THEN** the `permissions` check is `ok`

#### Scenario: Narrower rule does not cover it
- **WHEN** the only matching rule is `Bash(dial doctor:*)`
- **THEN** the `permissions` check is `warn` and the fix snippet contains the line `"Bash(dial:*)"`

#### Scenario: Unreadable settings file
- **WHEN** a settings file exists but is not valid JSON
- **THEN** the `permissions` check is `warn`, its evidence names that file, and doctor does not crash

### Requirement: An uncovered rule comes with a paste-ready snippet
When `Bash(dial:*)` is not covered, the `permissions` check's fix SHALL be `Add to ~/.claude/settings.json → permissions.allow:` followed by one double-quoted rule per line, comma-separated with no trailing comma.

#### Scenario: Snippet format
- **WHEN** the rule is not covered
- **THEN** the fix's first line is `Add to ~/.claude/settings.json → permissions.allow:` and its last line is `"Bash(dial:*)"` with no trailing comma
