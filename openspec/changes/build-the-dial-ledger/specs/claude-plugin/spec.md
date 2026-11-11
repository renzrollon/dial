# Spec Delta

## Purpose

The Claude Code plugin shipped in the Dial repository: its manifests and marketplace install, the four hooks and the contract that none of them ever blocks a session, and the `/dial:handoff` and `/dial:next` skills.

## ADDED Requirements

### Requirement: The plugin manifest names dial at the package version
The repository SHALL contain `.claude-plugin/plugin.json` with `name` `dial`, a `version` equal to the `version` in `package.json`, and `description`, `author` and `license` keys.

#### Scenario: Version in lockstep
- **WHEN** `package.json` has `version` `0.2.0`
- **THEN** `.claude-plugin/plugin.json` has `name` `dial` and `version` `0.2.0`

### Requirement: The plugin installs from its own marketplace manifest
The repository SHALL contain `.claude-plugin/marketplace.json` with `name` `dial`, an `owner`, and exactly one plugin named `dial` whose `source` is `{ "source": "github", "repo": "renzrollon/dial" }`, so that `/plugin marketplace add renzrollon/dial` then `/plugin install dial@dial` installs it.

#### Scenario: One plugin from GitHub
- **WHEN** `.claude-plugin/marketplace.json` is read
- **THEN** `name` is `dial`, `plugins` has one element with `name` `dial`, and its `source` is `{ "source": "github", "repo": "renzrollon/dial" }`

### Requirement: The hook table registers four events
`hooks/hooks.json` SHALL have the shape `{ "hooks": { <Event>: [ { "matcher"?, "hooks": [ { "type": "command", "command", "timeout" } ] } ] } }` with exactly SessionStart (no matcher, `node "${CLAUDE_PLUGIN_ROOT}/hooks/brief.mjs"`, timeout 10), SessionEnd (`node "${CLAUDE_PLUGIN_ROOT}/hooks/record.mjs" --event SessionEnd`, 60), PreCompact (`… --event PreCompact`, 60) and PostToolUse (matcher `Bash`, `node "${CLAUDE_PLUGIN_ROOT}/hooks/sync-on-event.mjs"`, 30).

#### Scenario: Exactly the four events
- **WHEN** `hooks/hooks.json` is parsed
- **THEN** the keys of `hooks` are exactly `SessionStart`, `SessionEnd`, `PreCompact` and `PostToolUse`

#### Scenario: Commands and timeouts
- **WHEN** each event's single command entry is read
- **THEN** SessionStart runs `node "${CLAUDE_PLUGIN_ROOT}/hooks/brief.mjs"` with timeout 10, SessionEnd runs `node "${CLAUDE_PLUGIN_ROOT}/hooks/record.mjs" --event SessionEnd` with timeout 60, PreCompact runs `node "${CLAUDE_PLUGIN_ROOT}/hooks/record.mjs" --event PreCompact` with timeout 60, and PostToolUse runs `node "${CLAUDE_PLUGIN_ROOT}/hooks/sync-on-event.mjs"` with timeout 30

#### Scenario: Only PostToolUse has a matcher
- **WHEN** the matchers are read
- **THEN** PostToolUse has `matcher` `Bash` and no other event has a matcher

### Requirement: Hooks read stdin leniently and resolve the repo from the payload
Every hook script SHALL read all of stdin and treat empty, malformed or TTY stdin as the payload `{}`. It SHALL resolve the repo from the payload's `cwd`, or from the process working directory when `cwd` is absent, by the registry's repo resolution rule, in-process (importing `lib/registry.mjs`) and before any subprocess starts.

#### Scenario: Empty stdin
- **WHEN** a hook script is run with empty stdin from a registered repo's directory
- **THEN** it uses that directory as the repo and exits 0

#### Scenario: Malformed stdin
- **WHEN** a hook script receives `{not json` on stdin
- **THEN** it treats the payload as `{}`, writes nothing to stdout, and exits 0

#### Scenario: Physical cwd of a symlinked registration
- **WHEN** a repo is registered at a path under a symlinked directory and the hook runs with empty stdin from the physical directory it points to
- **THEN** the hook acts on that repo

#### Scenario: Subdirectory of a repo
- **WHEN** the payload's `cwd` is `/Users/caro/IdeaProjects/katipon/lib` and `/Users/caro/IdeaProjects/katipon` is registered
- **THEN** the hook acts on the repo `katipon`

### Requirement: An unregistered repo costs one registry read
When the resolved directory is not inside any registered repo, or the registry file is absent, a hook script SHALL read at most the registry file, start no subprocess, write nothing anywhere, print nothing on stdout or stderr, and exit 0.

#### Scenario: Hook in an unregistered directory
- **WHEN** the SessionStart, SessionEnd, PreCompact or PostToolUse hook runs with `cwd` `/tmp/scratch`
- **THEN** no subprocess is started, stdout and stderr are empty, no file is created, and the exit code is 0

#### Scenario: No registry yet
- **WHEN** the registry file does not exist
- **THEN** the hook exits 0 with empty output and the Dial home is not created

### Requirement: Hooks run the plugin's own CLI
A hook script that acts SHALL run the CLI as `process.execPath` with `<plugin root>/bin/dial.mjs`, the plugin root derived from the script's own location, never `dial` from PATH.

#### Scenario: PATH without dial
- **WHEN** a registered repo's SessionStart hook runs with a PATH on which no `dial` resolves
- **THEN** the brief is still produced, by `<plugin root>/bin/dial.mjs`

### Requirement: Hooks never block a session
Every hook script SHALL wrap its work in one top-level guard, exit 0 on every path, write nothing to stdout except the SessionStart envelope, and on any failure (an exception, or the CLI exiting non-zero) write exactly one stderr line `dial <hook> hook error (ignored): <message>`, where `<hook>` is `brief`, `record` or `sync-on-event`.

#### Scenario: CLI fails under record
- **WHEN** the CLI run by the record hook exits 1 with the stderr line `dial: boom`
- **THEN** the record hook writes exactly one stderr line `dial record hook error (ignored): dial: boom` and exits 0

#### Scenario: Exception inside the hook
- **WHEN** the sync-on-event hook throws `boom`
- **THEN** stderr is the one line `dial sync-on-event hook error (ignored): boom`, stdout is empty, and the exit code is 0

#### Scenario: Non-SessionStart hooks are silent on stdout
- **WHEN** the SessionEnd, PreCompact or PostToolUse hook succeeds
- **THEN** its stdout is empty

### Requirement: SessionStart injects the brief
For a registered repo the SessionStart hook SHALL run `dial brief <repo> --hook --session <session_id>` (omitting `--session` when the payload has no `session_id`) for every `source`, and write that command's stdout, the `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}` envelope, verbatim to its own stdout. When the brief fails or prints no valid JSON the hook SHALL print nothing on stdout.

#### Scenario: Brief on startup
- **WHEN** the payload is `{"source":"startup","session_id":"s1","cwd":"/Users/caro/IdeaProjects/katipon"}` and `katipon` is registered
- **THEN** the CLI is run with `brief katipon --hook --session s1` and the hook's stdout is the envelope with `hookEventName` `SessionStart`

#### Scenario: Every source
- **WHEN** the payload `source` is `resume`, `clear`, `compact` or `fork`
- **THEN** the brief is injected the same way

#### Scenario: Brief fails
- **WHEN** the CLI exits 1
- **THEN** the hook's stdout is empty, stderr is one `dial brief hook error (ignored): …` line, and the exit code is 0

### Requirement: SessionEnd and PreCompact record the session
For a registered repo the SessionEnd and PreCompact hooks SHALL run `dial record --event SessionEnd` or `dial record --event PreCompact` respectively, passing the hook payload unchanged on the CLI's stdin.

#### Scenario: SessionEnd forwards the payload
- **WHEN** the SessionEnd hook receives `{"session_id":"s1","cwd":"/Users/caro/IdeaProjects/katipon","reason":"exit","transcript_path":"/t.jsonl"}`
- **THEN** the CLI runs `record --event SessionEnd` with that JSON on stdin and the hook exits 0

#### Scenario: PreCompact forwards the payload
- **WHEN** the PreCompact hook receives a payload with `trigger` `auto`
- **THEN** the CLI runs `record --event PreCompact` with that payload on stdin

### Requirement: PostToolUse syncs after Interlock and OpenSpec close events
The PostToolUse hook SHALL run `dial sync <repo>` only when `tool_input.command` matches `^\s*(interlock run close|interlock settle\b|openspec archive\b)`; any other payload SHALL exit 0 at once without starting a subprocess.

#### Scenario: Archive command
- **WHEN** `tool_input.command` is `  openspec archive add-login --yes` in a registered repo
- **THEN** the CLI runs `sync katipon` and the hook exits 0

#### Scenario: Settle command
- **WHEN** `tool_input.command` is `interlock settle --review`
- **THEN** the CLI runs `sync <repo>`

#### Scenario: Unrelated command
- **WHEN** `tool_input.command` is `git status`, `echo openspec archive x` or `openspec archived`
- **THEN** no subprocess is started and the exit code is 0

### Requirement: The handoff skill writes five lines through dial handoff
`skills/handoff/SKILL.md` SHALL have frontmatter `name`, `description`, `argument-hint` and `allowed-tools`, and SHALL tell the session to write `Done:`, `Decided:`, `Next:`, `Blocked:` and `Open:` from its own context, pipe them to `dial handoff <repo> [<change>] --stdin --source "/dial:handoff (claude)"` with one `--next` per next step, run `dial sync <repo>`, and end its reply with the printed wikilink.

#### Scenario: Skill text names the command and source
- **WHEN** `skills/handoff/SKILL.md` is read
- **THEN** it contains `dial handoff`, `--stdin`, `--source "/dial:handoff (claude)"`, `--next`, `dial sync`, and the five labels `Done:`, `Decided:`, `Next:`, `Blocked:`, `Open:`

#### Scenario: Frontmatter keys
- **WHEN** the skill's frontmatter is parsed
- **THEN** it has `name` `handoff` and the keys `description`, `argument-hint` and `allowed-tools`

### Requirement: The handoff skill states what a sandboxed session needs
Because `dial handoff` and `dial sync` write into the vault and the Dial home, `skills/handoff/SKILL.md` SHALL say that in a sandboxed Claude Code session those directories must be writable from the sandbox, and that when a `dial` command fails with a permission error the session SHALL report the failure and the command, not retry it another way.

#### Scenario: Skill text names the sandbox requirement
- **WHEN** `skills/handoff/SKILL.md` is read
- **THEN** it contains the word `sandbox`, names the vault and the Dial home as the directories to allow, and tells the session to report a permission failure

### Requirement: The next skill renders dial next as drafted actions
`skills/next/SKILL.md` SHALL have frontmatter `name`, `description`, `argument-hint` and `allowed-tools`, and SHALL tell the session to run `dial next --json` and render each row's `repo`, `change`, `state`, `idleDays` and `evidence` with its `suggested` command as a drafted action that the session does not run unasked.

#### Scenario: Skill text names the command
- **WHEN** `skills/next/SKILL.md` is read
- **THEN** it contains `dial next --json` and names the `suggested` field as the drafted action

### Requirement: Skills call dial on PATH and the package ships the plugin
The skills SHALL invoke `dial` from PATH, so the global install remains required. `package.json` `files` SHALL include `hooks/`, `skills/`, `templates/` and `.claude-plugin/` alongside `bin/`, `lib/` and `README.md`.

#### Scenario: Skills use the PATH binary
- **WHEN** both `SKILL.md` files are read
- **THEN** every command they give starts with `dial ` and none names `bin/dial.mjs` or `${CLAUDE_PLUGIN_ROOT}`

#### Scenario: Packed files
- **WHEN** `package.json` is read
- **THEN** `files` contains `hooks/`, `skills/`, `templates/` and `.claude-plugin/`
