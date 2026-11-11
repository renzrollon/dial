# Dial

## Purpose

Dial keeps a ledger of every repository's changes in Obsidian, one vault per
repository, with the work/personal boundary kept sound: a Dial note must live
in the vault its repository is registered to. It reads what is already on disk
(git, OpenSpec, Interlock's ship state, Escapement's queue, Claude Code
sessions, a cached forge reply), derives one state per change, and writes
metadata-only notes into the registered vault. `docs/how-dial-works.md` tells
the pipeline end to end.

## Install

Node >= 22, no runtime dependencies. For the full setup, including Obsidian,
the registry, per-repo registration and Claude Code, see
[Setup on your machine](#setup-on-your-machine).

```sh
git clone https://github.com/renzrollon/dial.git && cd dial
npm i -g .
dial doctor
```

## Setup on your machine

### The quick way: two scripts

Two interactive scripts do the steps below for you. They ask one question at a
time, show a `[default]` you can accept with Enter, and ask before they change
anything:

```sh
node ~/IdeaProjects/dial/scripts/setup.mjs              # once per machine
node ~/IdeaProjects/dial/scripts/add-repo.mjs [<path>]  # once per repo; the path defaults to the repo you are in
```

`setup.mjs` checks Node and git, offers `npm i -g .`, asks for your vaults
(name and folder) and optional `roots`, writes `registry.json`, runs
`dial vault init` and appends the AGENTS.md section to each vault, installs
the Claude Code plugin, adds `Bash(dial:*)` and the sandbox write paths to
`~/.claude/settings.json` (after a timestamped backup), and offers the
LaunchAgent. Then it registers repos in a loop and ends with `dial doctor`.
You can run it again safely: it skips what is already in place.

`add-repo.mjs` asks for the path, the vault (it picks the vault itself when the
repo is under a `roots` entry or only one vault exists) and the host (guessed
from `origin`). It runs `dial register`, offers a `--dry-run` preview, then
syncs, optionally with `--remote`.

If input ends before the last question (for example, piped answers), a script
stops. It does not take defaults for the questions left.

Creating the vault in Obsidian and turning on **Bases** (step 2a and 2b) stay
manual. The sections below describe each step in full if you want to do it by
hand.

### By hand

Setup has four parts, done once, in this order:

1. [Install the `dial` CLI](#1-install-the-cli).
2. [Prepare each Obsidian vault](#2-prepare-each-obsidian-vault).
3. [Register each repository](#3-register-each-repository).
4. [Connect Claude Code](#4-connect-claude-code).

The other steps are optional:
[background sync](#5-optional-background-sync),
[session narration with a local model](#6-optional-session-narration) and
[PR and CI state](#7-optional-pr-and-ci-state). At the end,
[check the setup](#8-check-the-setup).

### Prerequisites

| Need | Why | Check |
| --- | --- | --- |
| macOS | the LaunchAgent; everything else is plain Node | |
| Node >= 22 | the CLI and the hooks | `node --version` |
| git | the main source of facts | `git --version` |
| Obsidian >= 1.9 with the **Bases** core plugin | shows `Dial.base` | Settings → Core plugins → Bases |
| Claude Code | optional: the brief, record and handoff hooks | `claude --version` |
| `gh` / `glab`, logged in | optional: PR and CI state under `--remote` | `gh auth status` |
| OpenSpec, Interlock, Escapement | optional: Dial reads their files when present, and a missing one is reported as `unobserved` | |
| An OpenAI-compatible local model | optional: `dial narrate` and the auto-narrate on `SessionEnd` | |

Dial has no runtime dependencies, so there is no `npm install` step for its
code.

### 1. Install the CLI

```sh
git clone https://github.com/renzrollon/dial.git ~/IdeaProjects/dial
cd ~/IdeaProjects/dial
npm i -g .          # links the checkout, so a `git pull` updates `dial`
dial version
dial doctor         # at this point: home and registry say "first register" / "no registry yet"
```

The skills call `dial` by name, so it must be on `PATH` (`doctor` checks this
under `on-path`).

**mise, nvm or asdf users:** `npm i -g` installs into the *current* Node's
global directory. After you switch or upgrade Node, `dial` is no longer on
`PATH`. Run `npm i -g .` again, then `dial agent install` again if you use the
LaunchAgent, because its plist records the absolute paths of `node` and
`dial`.

### 2. Prepare each Obsidian vault

Use one vault per boundary, for example `personal` and `work`. Dial never
creates a vault directory and never moves a repo between vaults, so choose the
split before you register anything.

**a. Create the vault in Obsidian.** Choose *Open another vault → Create new
vault*, or *Open folder as vault* on an existing folder. Rules for where a
vault can live:

- Do not put one vault inside another (`doctor` warns under `vault-nesting`).
- Do not put a vault inside a git repository that Dial tracks.
- If you sync the vault (iCloud, Obsidian Sync, git), that is fine: Dial writes
  plain files atomically.

**b. Turn on the Obsidian features Dial uses.** Set these in Obsidian →
Settings:

| Setting | Value | Needed? |
| --- | --- | --- |
| Core plugins → **Bases** | on | yes, for `Dial.base` |
| Core plugins → **Daily notes** → New file location | `Daily` | recommended: Dial appends to `Daily/YYYY-MM-DD.md` |
| Core plugins → **Daily notes** → Template file location | `Templates/Daily` | recommended: your daily notes then carry the `## Log` heading Dial appends under |
| Core plugins → **Templates** → Template folder location | `Templates` | optional |
| Files & links → Detect all file extensions | off (default) | `Dial.base` is still shown, because Bases owns `.base` |

The `Needs me` view in `Dial.base` is a `kanban` view. If your Obsidian build
does not have a kanban view for Bases, the view is shown as unsupported. In
that case, install a community plugin that adds one, or use the other three
views (`In flight`, `Stale` and `By repo`), which are plain
tables.

The `obsidian` command-line tool is optional. Dial writes files directly, and
`doctor` reports `skip` when the tool is absent.

**c. Declare the vault in the registry.** No command adds a vault. You edit
`$DIAL_HOME/registry.json` by hand once (default `~/.config/dial/registry.json`).
If the file does not exist yet, create it:

```sh
mkdir -p ~/.config/dial
cat > ~/.config/dial/registry.json <<'JSON'
{
  "dial_schema": "dial.registry/1",
  "vaults": {
    "personal": "/Users/you/Obsidian/personal",
    "work": "/Users/you/Obsidian/work"
  },
  "repos": [],
  "limits": {}
}
JSON
```

If the file already exists, add your vault under `"vaults"` and leave the rest
as it is. A vault path can be absolute or start with `~/`. Use the folder that
contains `.obsidian/`.

To keep a whole directory on one side of the boundary, add `roots`. After that,
`register` refuses a repo under that directory if it names any other vault:

```json
  "roots": { "~/VSCodeProjects": "work", "~/IdeaProjects": "personal" }
```

**d. Scaffold the vault.**

```sh
dial vault init personal     # creates Projects/, Changes/, Templates/, Dial.base, Dial Queries.md, Templates/Daily.md
```

`vault init` is idempotent, so you can re-run it. `--force` rewrites a shipped
file that you changed. It never touches `.obsidian/` or `AGENTS.md`.

**e. Add the AGENTS.md section** (once per vault, by hand; Dial never edits
`AGENTS.md`). This tells an agent working in the vault which sections are
generated:

```sh
cat ~/IdeaProjects/dial/templates/AGENTS-dial-section.md >> /Users/you/Obsidian/personal/AGENTS.md
```

Repeat c to e for every vault.

### 3. Register each repository

For each repo you want in the ledger (or run `scripts/add-repo.mjs` in the
repo, which asks for these values):

```sh
dial register ~/IdeaProjects/my-repo --vault personal --host github   # or --host gitlab
dial sync my-repo --dry-run    # shows the notes it would write; writes nothing
dial sync my-repo              # writes Projects/my-repo.md, Changes/my-repo--*.md, Dial Summary.md
```


You don't need to change or commit anything in the repo. Dial only reads it:

| If the repo has... | Dial reads... |
| --- | --- |
| a git work tree (required) | branch, dirty, stash, ahead/behind, worktrees, last commit |
| `openspec/changes/` | one change note per active change, with task counts |
| `.claude/ship/` (Interlock) | ship state, settle findings, merge verdict |
| an Escapement queue entry | queued / checkpoint state |
| Claude Code sessions for that path | last-session time (only file timestamps; transcripts are not read) |

A repo with none of these optional sources still gets a repo note with its git
state.

The repo name is the directory's basename, and names must be unique. To move a
repo to another vault, run `dial unregister my-repo`, then `dial register ...
--vault other`. The notes already in the old vault stay there, because Dial
never deletes.

Useful afterwards:

```sh
dial repos              # what is registered
dial sync --all         # every repo
dial next               # what needs you, across repos
dial brief my-repo      # the short orientation for one repo
```

### 4. Connect Claude Code

The Claude Code setup applies to every repo at once: the plugin, the
permission rule and the sandbox paths are all user-scoped. The hooks do
nothing in a repo that is not registered (they cost one registry read).

**a. Install the plugin** (inside Claude Code):

```
/plugin marketplace add renzrollon/dial
/plugin install dial@dial
```

To try your local checkout instead of the published plugin, start a session
with `claude --plugin-dir ~/IdeaProjects/dial`. To pick up a new version later,
run `/plugin marketplace update dial`. Restart Claude Code after installing.

**b. Allow the `dial` command.** Add the rule to `~/.claude/settings.json` so
that `/dial:handoff` and `/dial:next` don't prompt:

```json
{
  "permissions": {
    "allow": ["Bash(dial:*)"]
  }
}
```

Merge it into your existing `permissions.allow` array, and keep the JSON valid
(a comma after each array or value that is followed by another key). If the
file is invalid JSON, Claude Code cannot apply any of it, and `dial doctor`
shows `user: ... (unreadable: ...)` under `permissions`.

**c. Let sandboxed commands write to the vault and the Dial home.** Skip this
if you don't run Claude Code with the sandbox. Hooks run outside the sandbox,
but the skills run `dial handoff` and `dial sync` through Bash, inside it. Add
every vault and the Dial home to `~/.claude/settings.json`:

```json
{
  "sandbox": {
    "filesystem": {
      "allowWrite": [
        "~/.config/dial",
        "~/Obsidian/personal",
        "~/Obsidian/work"
      ]
    }
  }
}
```

**d. Check it works.** Start a new session in a registered repo. The first
turn should carry a `dial brief`. Run `/dial:next` to see the drafted actions,
and `/dial:handoff` before you stop. When the session ends, the `SessionEnd`
hook syncs, and if no handoff was written it narrates (step 6).

### 5. Optional: background sync

```sh
dial agent install    # LaunchAgent: `dial sync --all --due-remote` at login and every syncIntervalMinutes (15)
dial agent status     # running / loaded-not-running / not-loaded / paths-missing / not-installed
```

Its logs are in `~/.config/dial/logs/agent.{out,err}.log`. Run `dial agent
install` again after any change to Node or to the location of `dial`. If you
want immediate updates instead of polling, keep `dial watch` running in a
terminal. It syncs a repo as soon as its `.claude/ship/` or
`openspec/changes/` changes.

### 6. Optional: session narration

`dial narrate` (and `dial record` when no handoff was written) asks a local
OpenAI-compatible model for five lines about the session. Dial picks the
endpoint in this order:

1. The `mtplx` provider (or whichever provider `narrate.provider` names) in
   pi's `~/.pi/agent/models.json`: its `baseUrl`, its `apiKey` and its first
   model.
2. Overridden key by key by the registry's `narrate` block:

   ```json
   "narrate": { "url": "http://127.0.0.1:8000/v1", "model": "qwen3.6", "apiKeyEnv": "MY_LOCAL_KEY" }
   ```

3. If the primary call fails, the fallback: `narrate.fallbackUrl` and
   `narrate.fallbackModel`, by default `http://127.0.0.1:11434/v1` (Ollama)
   and `qwen3.6`.

`apiKeyEnv` names an environment variable. Never put the key itself in the
registry. Check the setup without calling the model:

```sh
dial narrate my-repo --transcript ~/.claude/projects/<slug>/<session>.jsonl --dry-run
```

If no model is running, narration fails quietly and the session ends as
normal.

### 7. Optional: PR and CI state

```sh
gh auth login          # GitHub repos
glab auth login        # GitLab repos
dial sync my-repo --remote
```

Without `--remote` or `--due-remote`, Dial makes no network calls. PR and CI
fields show the cached reply, or `unobserved` when there is none. The
LaunchAgent uses `--due-remote`, so it refreshes at most every
`remoteIntervalMinutes` (30).

### 8. Check the setup

```sh
dial doctor
```

A complete setup prints `DIAL OK`. Every row is `ok`, except `launch-agent`,
which is `skip` if you didn't install it, and `narrate-endpoint`, which is
`skip` if no model is configured. Then open `Dial.base` and `Dial Summary.md`
in Obsidian.

| Doctor row | Fix |
| --- | --- |
| `registry` FAIL | the JSON in `registry.json` is invalid, or a vault path is not a directory: fix the file, or create the folder in Obsidian |
| `boundary` FAIL | a Dial note is in the wrong vault, or a repo contradicts `roots`: move the note to its repo's vault, or fix the registry |
| `permissions` warn, `unreadable` | a settings file is invalid JSON: fix the file it names (often a missing comma) |
| `permissions` warn, not allowed | step 4b |
| `vault-scaffold` warn | `dial vault init <name>` |
| `vault-nesting` warn | move one vault out of the other |
| `on-path` warn | `npm i -g .` in the checkout (again after a Node switch) |
| `launch-agent` `paths-missing` | `dial agent install` again |

### Updating and removing

- Update: `git pull` in the checkout (the global link follows it), then
  `/plugin marketplace update dial` in Claude Code.
- Remove: `dial agent uninstall`, `/plugin uninstall dial@dial`, `npm rm -g
  dial`. Then delete `~/.config/dial` if you want. The vault notes are yours;
  Dial does not remove them.

### First run on a new machine, in one block

```sh
git clone https://github.com/renzrollon/dial.git ~/IdeaProjects/dial && cd ~/IdeaProjects/dial && npm i -g .
# create the vault in Obsidian, enable Bases, then add it under "vaults" in ~/.config/dial/registry.json
dial vault init personal
cat templates/AGENTS-dial-section.md >> ~/Obsidian/personal/AGENTS.md
dial register ~/IdeaProjects/dial --vault personal --host github
dial sync dial
dial agent install
# in ~/.claude/settings.json: permissions.allow += "Bash(dial:*)"; sandbox.filesystem.allowWrite += vault and ~/.config/dial
# in Claude Code: /plugin marketplace add renzrollon/dial, then /plugin install dial@dial
dial doctor
```

## Commands

```
dial <command> [options]

  version                      print the version (--json)
  limits                       print the published caps (--json)
  doctor                       check preconditions, the vault boundary and the permission rule (--json)
  register <path> --vault <name> --host github|gitlab
                               register a git work tree against exactly one vault
  unregister <path-or-name>    remove a registered repo
  repos                        list registered repos (--json)
  vault init <name> [--force]  scaffold a registered vault's folders and templates (--json)
  sync [<repo>] [--all] [--remote] [--due-remote] [--dry-run]
                               collect, derive and write the notes of one repo or every repo (--json)
  next [--vault <name>]        every item that needs you, across repos, offline (--json)
  brief [<repo>] [--hook] [--session <id>]
                               the short orientation for one repo, offline (--json)
  handoff <repo> [<change>] (--stdin | --text <t>) [--source <label>] [--next <text>]...
                               prepend a dated narrative entry to a note (--json)
  narrate <repo> [<change>] --transcript <path> [--turns <n>] [--dry-run], or narrate --eval <dir>
                               ask a local model for the five narrative lines (--json)
  record --event SessionEnd|PreCompact
                               the hook side: sync, then narrate when no handoff was written (--json)
  drop <repo> <change>         mark a change note dropped (--json)
  agent install|uninstall|status
                               the background sync LaunchAgent (status: --json)
  watch                        sync a repo whenever its ship or OpenSpec state moves
  report                       what the ledger shows over time (--json)
  review --week                write the weekly review of stale items into each vault (--json)
  help                         print this text (also --help after any command)

```

`dial --version` is the same as `dial version`. Failures print one
`dial: <reason>` line on stderr and exit 1; `--help` exits 0. Unknown options
and value flags with no value are refused. Only the commands marked `--json`
accept it, and then print one two-space-indented JSON document.

- `register` takes a path to a git work tree and prints the repo name (the
  directory's basename). `unregister` takes the stored path, the expanded
  path, or the name. A repo is registered against exactly one vault.
- `vault init <name>` creates `Projects/`, `Changes/` and `Templates/` and
  copies `Dial.base`, `Dial Queries.md` and the templates when absent, one
  `created`, `unchanged` or `rewritten` line per path. `--force` rewrites a
  copied file whose bytes differ. It never touches `.obsidian/` or `AGENTS.md`.
- `sync <repo>` or `sync --all` collects, derives and writes. `--dry-run`
  prints every planned write and writes nothing. `--remote` fetches the PR and
  checks with `gh` or `glab`; `--due-remote` does so only for a repo whose
  cached reply is older than `remoteIntervalMinutes`. Without either flag no
  network command runs. A repo argument may be a name or a path inside the repo.
- `next [--vault <name>]` lists every item that needs you, offline, in state
  priority order, capped at `nextRows`.
- `brief [<repo>]` prints at most `briefLines` lines of orientation for one
  repo; `--hook` wraps it in the Claude Code SessionStart envelope and prints
  nothing for an unregistered repo; `--session <id>` names the session. `--hook`
  and `--json` cannot be combined.
- `handoff <repo> [<change>]` prepends a dated narrative entry to a note, from
  `--stdin` or `--text`, labelled by `--source`, and appends each `--next` as a
  `- [ ]` line.
- `narrate <repo> [<change>] --transcript <path>` asks a local model for five
  labelled lines (`Done:`, `Decided:`, `Next:`, `Blocked:`, `Open:`) from the
  last `--turns` turns and writes them as a narrative entry; `--dry-run` prints
  the prompt, the endpoints and the turns and calls nothing. `narrate --eval
  <dir>` runs the quality set under `<dir>/items/`.
- `record --event SessionEnd|PreCompact` is the hook side: sync, then narrate
  when no handoff was written. It exits 0 on every path.
- `drop <repo> <change>` marks a change note `dropped: YYYY-MM-DD`.
- `report` prints the indicators read from the vault notes, the sync log and
  the daily log, each with its denominator or `unobserved: <reason>`; it writes
  nothing, not even the home.
- `review --week` writes `Inbox/Dial Review YYYY-MM-DD.md` into each vault that
  holds Dial notes, asking archive, drop or re-spec of every stale item. A
  review that already exists for the day is left byte for byte. `dial review`
  alone is refused with `dial: review needs --week`.
- `watch` polls each repo's `.claude/ship/` and `openspec/changes/` newest
  mtime every `watchPollSeconds` and syncs a repo whose mtime moved, printing
  `HH:mm synced <repo> (needs me <n>)`. The first poll only records mtimes.
  It runs until SIGINT, then exits 0. It takes no `--json`.

### Notes, anatomy

A change note is `Changes/<repo>--<change>.md`; a repo note is
`Projects/<repo>.md`. Names are slugs: each of `: / \ ? * " < > | # ^ [ ]`
becomes `-`.

A change note is, in order:

1. frontmatter: `title, type, repo, change, scope, state, needs_me, stale,
   branch, pr, pr_state, ci, merge_verdict, tasks_done, tasks_total,
   last_commit, last_session, last_activity, created, updated, status, tags,
   aliases, dial_schema` (plus `dropped` and `archived` when set). A value Dial
   could not observe is written `unobserved`, never guessed.
2. `## Next`: human-owned checkboxes.
3. `## Narrative`: human-owned entries headed `### YYYY-MM-DD HH:mm · <source>`,
   newest first.
4. any other `##` section a human added, kept in place.
5. `## State  <!-- dial:generated, do not edit -->`: a `fact | value |
   evidence` table rebuilt on every sync.

A repo note adds generated `## Changes`, `## Drift` (counts) and `## Recent
narrative`. Each vault also holds `Dial Summary.md` (needs-me bullets),
`Dial.base` (four views grouped by state priority), `Dial Queries.md`, and
`Daily/YYYY-MM-DD.md` where Dial appends `- HH:mm dial ...` lines at the end of
`## Log`. `updated` changes only when the file's bytes do, so a sync with
nothing new writes nothing.

### The rules Dial keeps

- Metadata only. Notes hold states, counts, names and short evidence strings,
  never a diff, a file body or a secret.
- Never delete. Dial never deletes a note. An archived change's note moves to
  `Archive/Changes/` with `status: archived` and `archived: YYYY-MM-DD` after
  `archivedKeepDays`; a dropped one carries `dropped: YYYY-MM-DD`.
- Every vault write goes through one check that the repo's registered vault is
  the target. A write outside it, or for a repo registered against a directory
  root, is refused.
- Human-owned sections and unknown frontmatter keys survive every render.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DIAL_HOME` | `~/.config/dial` | Dial's state directory. `~` is expanded; blank means the default. |
| `DIAL_NOW` | the system clock | ISO-8601 clock override with `Z` or a `+HH:mm` offset; anything else is refused. Only commands that read the clock check it. |
| `DIAL_LAUNCHCTL_BIN` | `/bin/launchctl` | The `launchctl` the `agent` command and `doctor` run. |
| `ESCAPEMENT_HOME` | `~/.escapement` | Where the Escapement queue is read from. |
| `ESCAPEMENT_CHECKPOINT_URL` | unset | Appended to checkpoint evidence. |

Local dates and times follow the process time zone (`TZ`).

## Home layout

```
$DIAL_HOME/
  registry.json       the registry; absent until the first write
  cache/remote/       <repo>.json, the last PR and CI reply per repo
  logs/               sync.jsonl, one line per synced repo; agent.out.log and agent.err.log
  eval/               items/, outputs/, labels.jsonl: the narrate quality set, made by hand
```

The home is created by a writing command (`register`, `unregister`, `sync`,
`handoff`, `agent install`, `watch`) and never by a read command. A missing
registry is the empty registry. A home that cannot be written is refused with
`dial: dial home is not writable: <path> (<OS code>)` before any vault file is
touched.

## Registry

`registry.json` is written atomically, with a fixed key order and repos sorted
by name.

```json
{
  "dial_schema": "dial.registry/1",
  "vaults": { "personal": "/absolute/path/to/personal-vault", "work": "/absolute/path/to/work-vault" },
  "repos": [{ "path": "~/IdeaProjects/dial", "vault": "personal", "host": "github" }],
  "roots": { "~/VSCodeProjects": "work" },
  "narrate": { "provider": "mtplx", "url": "http://127.0.0.1:8000/v1", "model": "qwen3.6" },
  "limits": {}
}
```

- `vaults` maps a vault name to its directory. Dial never creates a vault
  directory: add it here by hand, then `dial vault init <name>`.
- `repos` holds one entry per repo: `path` (a leading home directory is stored
  as `~`), `vault` (a key of `vaults`) and `host` (`github` or `gitlab`).
- A repo belongs to exactly one vault, and repo names must be unique.
- `roots` (optional) maps a directory to a vault. `register` refuses a repo
  under a root whose vault differs from `--vault`, and `doctor`'s `boundary`
  check fails on an entry that contradicts its root.
- `narrate` (optional) has the keys `provider`, `url`, `model`, `apiKeyEnv`,
  `fallbackUrl` and `fallbackModel`. By default the endpoint comes from pi's
  `~/.pi/agent/models.json` (provider `mtplx`); `apiKeyEnv` names an
  environment variable holding the key, never the key itself.
- `limits` may override a published cap by name with a positive integer.

`register` checks, in order: the host, that the vault exists, that the repo is
not registered to another vault, then that the path is a directory holding a
`.git` entry. Registering an already-registered repo to the same vault updates
its host.

## Published caps

`dial limits` prints the effective caps, defaults overridden by the registry's
`limits` block.

| Cap | Value | Meaning |
| --- | --- | --- |
| `staleDays` | 14 | days without activity before a change is stale |
| `archivedKeepDays` | 30 | days an archived change stays on the board |
| `briefLines` | 40 | maximum lines in a brief |
| `subprocessTimeoutSeconds` | 10 | seconds before a git, gh, glab or interlock call is abandoned |
| `remoteIntervalMinutes` | 30 | minutes a cached forge reply stays fresh |
| `syncIntervalMinutes` | 15 | minutes between background syncs |
| `narrateTurns` | 20 | most recent conversation turns sent to the local model |
| `narrateTimeoutSeconds` | 30 | seconds before a local model call is abandoned |
| `nextRows` | 50 | maximum rows dial next prints |
| `watchPollSeconds` | 30 | seconds between watch polls |

An unknown cap name or a non-positive-integer value is refused, naming the key
and the file.

## Claude Code plugin

```
/plugin marketplace add renzrollon/dial
/plugin install dial@dial
```

The plugin registers four hooks and two skills. Every hook reads its payload
from stdin leniently, resolves the repo from it, costs one registry read for an
unregistered repo, runs the plugin's own CLI, and never blocks a session.

| Event | Hook | Effect |
| --- | --- | --- |
| `SessionStart` | `hooks/brief.mjs` | injects `dial brief --hook` |
| `SessionEnd`, `PreCompact` | `hooks/record.mjs` | `dial record --event ...`: sync, then narrate when no handoff was written |
| `PostToolUse` (Bash) | `hooks/sync-on-event.mjs` | syncs after an Interlock or OpenSpec close event |

Skills: `/dial:handoff [<repo>] [<change>]` writes five lines of the session
into the note through `dial handoff`; `/dial:next [--vault <name>]` shows
`dial next` as drafted actions.

Sandbox note for the skills: `dial handoff` and `dial sync` write into the
vault and the Dial home, so in a sandboxed Claude Code session both the vault
directory and `$DIAL_HOME` must be writable from the sandbox. When a `dial`
command fails with a permission error, report the failure and the command; do
not retry it another way.

## The LaunchAgent

`dial agent install` writes `~/Library/LaunchAgents/com.dial.sync.plist` and
bootstraps it: it runs `dial sync --all --due-remote` at load and every
`syncIntervalMinutes`, with only `DIAL_HOME` and `PATH` in its environment and
its output under `$DIAL_HOME/logs/`. `dial agent uninstall` boots it out and
removes the plist, leaving the logs. `dial agent status` reports one of
`running` (exit 0), `loaded-not-running`, `not-loaded`, `paths-missing` or
`not-installed` (exit 1) with a fix. The agent commands are macOS only.

## The AGENTS.md section

`dial vault init` ends by printing `append <path of AGENTS-dial-section.md> to
<vault>/AGENTS.md by hand`. Dial never edits `AGENTS.md`. The section
(`templates/AGENTS-dial-section.md`) tells an agent working in the vault which
sections are human-owned, which are generated, that Dial's slug filenames must
not be renamed, and the never-delete and metadata-only rules.

## Doctor

`dial doctor` runs twelve checks in order and prints `DIAL OK` or `DIAL BLOCKED`
with counts. Each check is `ok`, `warn`, `FAIL` or `skip`; evidence and a fix
are shown for warnings and failures. A `skip` does not count as passed.

1. `node`: Node is at least 22.
2. `home`: the home is writable, or can be created on first write.
3. `registry`: the registry parses and validates; a vault that is not a
   directory fails, a repo path that moved warns.
4. `obsidian-cli`: `obsidian` is on `PATH`; absent is a skip, not a failure.
5. `boundary`: no Dial note sits in a vault other than its repo's registered
   one, and no registry entry lies under another vault's `roots` entry. Skipped
   when the registry did not load.
6. `permissions`: `Bash(dial:*)` is allowed in a Claude Code settings file; a
   warning with a paste-ready snippet when it is not:

   ```
   Add to ~/.claude/settings.json → permissions.allow:
   "Bash(dial:*)"
   ```

The last six never fail:

7. `vault-scaffold`: every vault has `Projects/`, `Changes/` and `Dial.base`;
   warns with `dial vault init <name>` otherwise.
8. `vault-nesting`: warns when one registered vault lies inside another.
9. `narrate-endpoint`: the resolved endpoint and model, read from files with no
   network call and no key printed; skip when none is configured.
10. `launch-agent`: the LaunchAgent status; skip when not installed.
11. `on-path`: warns with `npm i -g .` when `dial` is not on `PATH`.
12. `fields`: always ok; its `--json` evidence lists every frontmatter key Dial
    writes, so you can see exactly what leaves a repository.

Exit code is 1 only when a check fails; warnings and skips exit 0. `--json`
prints the full report.

## Non-goals

- Dial does not create a vault directory; it scaffolds one you declared.
- Dial calls GitHub or GitLab only under `--remote` or `--due-remote`.
- Dial does not move a repo between vaults. Unregister and register again.
- Dial never deletes a note and never writes a diff, a file body or a secret.
- Dial has no runtime dependencies; the only background process is the optional
  LaunchAgent.
