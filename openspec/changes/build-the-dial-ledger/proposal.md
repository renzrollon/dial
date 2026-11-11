# Proposal

## Why

The first change (`scaffold-cli-and-registry`, archived 2026-11-10) gave Dial a shell, a registry and a doctor, but Dial still reads nothing from a repository and writes nothing into a vault. Everything the epic (`~/IdeaProjects/app-ideas/dial-context-ledger-epic-2026-11-09.md`) promises — one offline read of every change that needs a human, the brief injected when Claude Code opens a repo, the narrative captured when you leave, the kanban on the phone — is still missing, and the remaining stories (0.3–0.6, 1.1–1.10, 2.1–2.3, 3.1–3.5, 4.1–4.6, 5.1–5.3, 6.1–6.4, 7.1, 7.2, 7.4, 7.5) are one pipeline: collect → derive → render → write → surface → hook. The owner has asked for them as one change, grouped into dependency-ordered tasks, rather than an epic of separate changes, so that the whole pipeline is designed against one vocabulary of facts, states and note shapes and no seam is specced twice.

## What Changes

- **Local collectors** under `lib/sources/`: git, OpenSpec, Interlock, Escapement, Checkpoint and Claude Code sessions, each returning facts that carry their evidence or the value `unobserved` with a reason; no network, every subprocess optional.
- **Remote collectors**: GitHub via `gh` and GitLab via `glab`, run only under `--remote`, chosen by the registry's `host`, cached under the Dial home with a timestamp so an offline sync still shows the last-seen state as `as of <time>`.
- **The state machine** (`lib/derive.mjs`): one state per change from the epic's priority table, first match wins, evidence string per fact, the `stale` overlay, `needs_me`, the suggested command, and a repo-level item for a branch no change covers.
- **The renderer** (`lib/render.mjs`): change notes, repo notes, the daily log line, the `Dial Summary.md` note and the templates, with the two human-owned sections `## Next` and `## Narrative` preserved byte for byte and the generated sections rebuilt every time; metadata only, never a diff, file contents or a secret.
- **The vault writer** (`lib/vault.mjs`) and the commands `dial vault init <name>`, `dial sync [repo|--all] [--remote] [--dry-run]`, `dial drop <repo> <change>`: atomic writes, byte-identical re-syncs, the boundary check against the registry on every write, archived notes moved to `Archive/Changes/` after `archivedKeepDays`, and nothing ever deleted.
- **`dial next`** and **`dial brief <repo> [--hook]`**: the cross-repo needs-me list and the ≤ `briefLines` brief, both offline, both with `--json`.
- **`dial handoff`**, **`dial narrate`** and **`dial record`**: the narrative written by a session, by the local model over a transcript tail, or triggered by a hook event; every entry dated and labelled with its source.
- **The Claude Code plugin** in this repository: `.claude-plugin/plugin.json`, `hooks/hooks.json` (SessionStart → brief, SessionEnd and PreCompact → record, PostToolUse → sync on Interlock events), the `/dial:handoff` and `/dial:next` skills, a marketplace manifest; every hook exits 0 on every path.
- **`dial agent install|uninstall|status`** (a macOS LaunchAgent in Escapement's shape) and **`dial watch`** (a polling tick).
- **`dial report`** and **`dial review --week`**: states with denominators, idle medians, the needs-me count over time, the 0.5 baseline beside the current week, the narrative source split and the narrative quality score from a labelled set.
- **Modified behaviour of what exists**: usage lists every new command and environment variable; `dial limits` publishes the new caps; the registry accepts an optional `narrate` block and an optional `roots` map that `register`, the vault-write boundary and doctor's `boundary` check enforce (D18); the home gains `cache/`; `dial doctor` gains checks for the vault scaffold, the narrate endpoint, the LaunchAgent and the list of fields that leave a repo.
- **Human and manual steps** from the epic (enable the Obsidian CLI, the nested work vault, the baseline week, the work-data policy, the `AGENTS.md` section, installing the plugin and the agent, the phone check, pi and Claudian, the retro) are listed in `tasks.md` as `- [human]` and `- [manual]` lines, grouped before and after the implementation sections, so no agent is ever handed one.
- **Tests and docs**: a fixture per source and per state, the idempotence, preservation and rebuild tests, the boundary test, the secrets grep; `README.md` grows the new sections and `docs/how-dial-works.md` tells the long story.

Nothing is removed. One behaviour changes meaning: `limits` no longer promises that only three caps exist (the living spec's "No other cap SHALL exist in this change" was scoped to the first change).

## Capabilities

### New Capabilities

- `local-sources`: the facts Dial derives offline from git, OpenSpec, Interlock, Escapement, Checkpoint and Claude Code sessions, the evidence each carries, and the `unobserved` discipline when a source is absent.
- `remote-sources`: the facts Dial fetches from GitHub and GitLab under `--remote`, which CLI each host uses, the cache under the home, and how a failed fetch degrades.
- `state-model`: the state machine — the state enum, first-match priority, evidence, `stale`, `needs_me`, the suggested action, and the repo-level item.
- `note-rendering`: the content of every file Dial writes into a vault — change note, repo note, daily log line, `Dial Summary.md`, `Dial.base`, the templates — the preserved sections, and the metadata-only rule.
- `vault-writes`: when and how Dial writes into a vault — `vault init`, `sync` with `--dry-run`, the boundary check, atomic and idempotent writes, the daily log append, archiving, `drop`, and the never-delete rule.
- `next-and-brief`: `dial next` and `dial brief`, their ordering, their line caps, their JSON, and the SessionStart hook envelope.
- `handoff-and-narrative`: `dial handoff`, `dial narrate` and `dial record` — the five-line narrative shape, the dated and labelled entry, the transcript tail, the local model call and its fallback, the quality-set evaluation.
- `claude-plugin`: the plugin manifest, the hooks and their non-blocking contract, the two skills, and installation through the marketplace.
- `launch-agent`: `dial agent install|uninstall|status` and `dial watch`.
- `report`: `dial report` and `dial review --week` — the indicators, their denominators, and `unobserved` when a number cannot be computed.

### Modified Capabilities

- `cli-shell`: usage must name every new command (`vault`, `sync`, `next`, `brief`, `handoff`, `narrate`, `record`, `drop`, `agent`, `watch`, `report`, `review`) and every environment variable the binary reads; `--json` extends to the new read commands.
- `dial-home`: the home gains `cache/remote/` for remote results and uses `logs/` for the agent and the sync log; `sync` and `agent install` join `register` and `unregister` as the commands that create the home.
- `registry`: an optional `narrate` block (endpoint, model, fallback) is accepted and validated; an optional `roots` map (directory → vault) makes `register` refuse a path under another vault's directory (D18); the schema marker stays `dial.registry/1`.
- `limits`: new caps are published (`subprocessTimeoutSeconds`, `remoteIntervalMinutes`, `syncIntervalMinutes`, `narrateTurns`, `narrateTimeoutSeconds`, `nextRows`, `watchPollSeconds`) and the "no other cap" requirement is replaced by "every cap is published".
- `doctor`: new checks `vault-scaffold`, `vault-nesting`, `narrate-endpoint`, `launch-agent`, `on-path` and `fields`, none of which can fail; the `permissions` check's required rule set is unchanged and stays `warn`; the header count rule is unchanged.

## Impact

- **New files**: `lib/sources/{git,openspec,interlock,escapement,sessions,github,gitlab}.mjs` (the OpenSpec collector also reads `checkpoint.json`), `lib/{facts,subprocess,cache,remote,collect,derive,note,render,vault,sync,next,brief,transcript,handoff,narrate,record,agent,watch,report}.mjs`, `bin/dial.mjs` dispatch for the new commands, `hooks/hooks.json`, `hooks/{brief,record,sync-on-event}.mjs`, `skills/handoff/SKILL.md`, `skills/next/SKILL.md`, `.claude-plugin/{plugin.json,marketplace.json}`, `templates/{Dial Change.md,Dial.base,Dial Queries.md,AGENTS-dial-section.md,Daily.md}`, `docs/how-dial-works.md`, tests and fixtures for every source and state.
- **Modified files**: `bin/dial.mjs`, `lib/{limits,registry,home,doctor}.mjs`, `README.md`, `package.json` (`files` gains `hooks/`, `skills/`, `templates/`, `.claude-plugin/`).
- **Writes outside the repository at runtime**: notes, `Dial.base`, templates and daily-log lines inside the registered vaults (only under `Projects/`, `Changes/`, `Archive/Changes/`, `Daily/`, `Templates/`, `Inbox/` for the weekly review, and the vault root for `Dial.base`, `Dial Summary.md` and `Dial Queries.md`; never `.obsidian/`); `$DIAL_HOME/cache/remote/<repo>.json`, `$DIAL_HOME/logs/sync.jsonl` and `$DIAL_HOME/logs/agent.{out,err}.log`; `~/Library/LaunchAgents/com.dial.sync.plist` on `agent install`.
- **Subprocesses**: `git`, `gh`, `glab`, `interlock`, `launchctl` and `obsidian`, each optional and each absence a single `unobserved` value. One HTTP call per `narrate` to a local OpenAI-compatible endpoint. No npm dependency.
- **Reads outside the repository**: `~/.claude/projects/<slug>/*.jsonl` (mtime, and the text of the last turns only for `narrate`), `~/.escapement/{queue,journal}`, `~/.pi/agent/models.json` (the local model endpoint; the key is used for the call and never copied), the Claude Code settings files doctor already reads.
- **Existing tests**: assertions pinning that usage lists exactly seven commands, that `limits` prints exactly three caps, and that doctor runs exactly six checks are updated in the tasks that change those meanings (named in `tasks.md`).
- **Out of scope**: no change to Interlock, Escapement or Checkpoint themselves (the `Result:` marker for manual test plans is an Interlock change, epic D6).
