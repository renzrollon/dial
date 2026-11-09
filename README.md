# Dial

## Purpose

Dial registers each of your repositories against exactly one Obsidian vault and
keeps the work/personal boundary sound: a Dial note must live in the vault its
repository is registered to. It owns one file, the registry, and audits the
vaults it points at. It writes no notes itself in this version.

## Install

Node >= 22, no runtime dependencies.

```sh
git clone <this repo> && cd dial
npm i -g .
dial doctor
```

`dial doctor` is the first thing to run. It exits 1 when any check fails.

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
help                         print the usage text (also --help after any command)
```

`dial --version` is the same as `dial version`. `register` takes a path to a
git work tree and prints the repo name (the directory's basename). `unregister`
takes the stored path, the expanded path, or the name, and prints the name.
Unknown options and value flags with no value are refused. Failures print one
`dial: <reason>` line on stderr and exit 1; `--help` exits 0.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DIAL_HOME` | `~/.config/dial` | Dial's state directory. `~` is expanded; blank means the default. |

## Home layout

```
$DIAL_HOME/
  registry.json   the registry; absent until the first register
  logs/           created with the home; unused in this version
```

The home is created by `register` and `unregister` only, never by a read
command. A missing registry is the empty registry.

## Registry

`registry.json` is written atomically, with a fixed key order and repos sorted
by name.

```json
{
  "dial_schema": "dial.registry/1",
  "vaults": { "personal": "/absolute/path/to/personal-vault" },
  "repos": [{ "path": "~/IdeaProjects/dial", "vault": "personal", "host": "github" }],
  "limits": {}
}
```

- `vaults` maps a vault name to its directory. Dial never creates a vault: add
  it here by hand before registering a repo against it.
- `repos` holds one entry per repo: `path` (a leading home directory is stored
  as `~`), `vault` (a key of `vaults`) and `host` (`github` or `gitlab`).
- A repo belongs to exactly one vault, and repo names must be unique.
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

An unknown cap name or a non-positive-integer value is refused, naming the key
and the file.

## Doctor

`dial doctor` runs six checks in order and prints `DIAL OK` or `DIAL BLOCKED`
with counts. Each check is `ok`, `warn`, `FAIL` or `skip`; evidence and a fix
are shown for warnings and failures.

1. `node`: Node is at least 22.
2. `home`: the home is writable, or can be created on first register.
3. `registry`: the registry parses and validates.
4. `obsidian-cli`: `obsidian` is on `PATH`; absent is a skip, not a failure.
5. `boundary`: no note carrying `dial_schema` in a vault's `Projects/` or
   `Changes/` folder belongs to a repo registered to a different vault. Skipped
   when the registry did not load.
6. `permissions`: `Bash(dial:*)` is allowed in a Claude Code settings file; a
   warning with a paste-ready snippet when it is not:

   ```
   Add to ~/.claude/settings.json → permissions.allow:
   "Bash(dial:*)"
   ```

Exit code is 1 only when a check fails; warnings and skips exit 0. `--json`
prints the full report.

## Non-goals

- Dial does not create vaults or write notes in this version.
- Dial does not talk to GitHub or GitLab; `host` is recorded, not called.
- Dial does not move a repo between vaults. Unregister and register again.
- Dial has no runtime dependencies and no daemon.
