# Spec Delta

## Purpose

How Dial keeps the vault current without a session open: `dial agent install|uninstall|status` manages a macOS LaunchAgent that runs `dial sync --all --due-remote` on an interval, and `dial watch` is a foreground polling tick that syncs a repo when its Interlock or OpenSpec state moves.

## ADDED Requirements

### Requirement: The agent subcommand is dispatched and refused like vault
`dial agent` SHALL accept exactly the subcommands `install`, `uninstall` and `status`. With no subcommand it SHALL refuse with `dial: agent needs one of install, uninstall, status`; with any other it SHALL refuse with `dial: unknown agent subcommand: <x>`. Both refusals exit 1. On a platform other than darwin every subcommand SHALL refuse with `dial: agent <subcommand> is macOS only` and exit 1 without touching any file.

#### Scenario: No subcommand
- **WHEN** `dial agent` is run
- **THEN** stderr is `dial: agent needs one of install, uninstall, status` and the exit code is 1

#### Scenario: Unknown subcommand
- **WHEN** `dial agent restart` is run
- **THEN** stderr is `dial: unknown agent subcommand: restart` and the exit code is 1

#### Scenario: Off macOS
- **WHEN** `dial agent install` is run on linux
- **THEN** stderr is `dial: agent install is macOS only`, the exit code is 1, and no plist, home or log directory was created

### Requirement: The plist runs sync on the configured interval
The plist SHALL be `$HOME/Library/LaunchAgents/com.dial.sync.plist` with `Label` `com.dial.sync`, `ProgramArguments` `/bin/sh`, `-c`, `exec '<node path>' '<dial.mjs path>' sync --all --due-remote`, `StartInterval` `syncIntervalMinutes` × 60, `RunAtLoad` true, `EnvironmentVariables` holding only `DIAL_HOME` (the resolved home) and the installing shell's `PATH`, and `StandardOutPath`/`StandardErrorPath` `$DIAL_HOME/logs/agent.out.log` and `agent.err.log`. Every value SHALL be XML-escaped.

#### Scenario: Default interval
- **WHEN** `dial agent install` is run with `syncIntervalMinutes` 15
- **THEN** the plist has `Label` `com.dial.sync`, `StartInterval` 900, `RunAtLoad` true, and its third program argument ends with `sync --all --due-remote`

#### Scenario: Registry override
- **WHEN** the registry sets `limits.syncIntervalMinutes` to 5
- **THEN** `StartInterval` is 300

#### Scenario: Only two environment variables
- **WHEN** the installing shell has `DIAL_HOME=/Users/caro/.config/dial`, `PATH=/opt/homebrew/bin:/usr/bin` and `GH_TOKEN=x`
- **THEN** `EnvironmentVariables` has exactly the keys `DIAL_HOME` and `PATH` with those values, and the plist does not contain `GH_TOKEN`

#### Scenario: XML escaping
- **WHEN** `PATH` contains `/a&b<c`
- **THEN** the plist holds `/a&amp;b&lt;c` and parses as a valid property list

#### Scenario: Log paths
- **WHEN** `DIAL_HOME` is `/Users/caro/.config/dial`
- **THEN** `StandardOutPath` is `/Users/caro/.config/dial/logs/agent.out.log` and `StandardErrorPath` is `/Users/caro/.config/dial/logs/agent.err.log`

### Requirement: Install prepares the home, writes the plist and bootstraps it
`dial agent install` SHALL create the Dial home and its `logs/` directory when absent, write the plist, run `launchctl bootout gui/<uid>/com.dial.sync` ignoring its result, then `launchctl bootstrap gui/<uid> <plist path>`. On success it SHALL print `installed com.dial.sync` and `  plist: <plist path>` and exit 0.

#### Scenario: Fresh install
- **WHEN** `dial agent install` is run with a fake launchctl that exits 0 and no Dial home exists
- **THEN** the home and `<home>/logs/` exist, the plist exists, the fake launchctl received `bootout gui/<uid>/com.dial.sync` then `bootstrap gui/<uid> <plist path>` in that order, and the exit code is 0

#### Scenario: Reinstall over a loaded agent
- **WHEN** the agent is already loaded and `dial agent install` is run again
- **THEN** the plist is rewritten, bootout runs before bootstrap, and the exit code is 0

### Requirement: A failed bootstrap leaves no plist behind
When `launchctl bootstrap` exits non-zero, install SHALL remove the plist it wrote and refuse with `dial: launchctl bootstrap failed: <first stderr line>`, exit 1.

#### Scenario: Bootstrap refused
- **WHEN** the fake launchctl exits 5 on `bootstrap` with stderr `Bootstrap failed: 5: Input/output error`
- **THEN** stderr is `dial: launchctl bootstrap failed: Bootstrap failed: 5: Input/output error`, the plist does not exist, and the exit code is 1

### Requirement: Uninstall boots the agent out and removes the plist
`dial agent uninstall` SHALL run `launchctl bootout gui/<uid>/com.dial.sync`, treating exit 3 or 113 as not loaded, remove the plist when present, leave the logs alone, and exit 0. It SHALL print `uninstalled <plist path>` when the plist existed or the agent was loaded, and `not installed` otherwise. Any other bootout failure SHALL refuse with `dial: launchctl bootout failed: <first stderr line>`.

#### Scenario: Installed agent
- **WHEN** the plist exists and bootout exits 0
- **THEN** the plist is gone, `<home>/logs/` is untouched, stdout is `uninstalled <plist path>`, and the exit code is 0

#### Scenario: Not loaded but plist present
- **WHEN** bootout exits 113 and the plist exists
- **THEN** the plist is removed and the exit code is 0

#### Scenario: Nothing installed
- **WHEN** bootout exits 3 and no plist exists
- **THEN** stdout is `not installed` and the exit code is 0

### Requirement: Status reports what launchd says
`dial agent status` SHALL report `not-installed` (exit 1, fix `dial agent install`) when the plist is absent; `paths-missing` (exit 1, fix `dial agent install`) when a path recorded in the plist no longer exists; otherwise from `launchctl print gui/<uid>/com.dial.sync` (`state =`, `pid =`, `last exit code =`): `running` with the pid (exit 0); `idle` when the state is not running and the last exit code is `0` or `(never exited)`, which is the healthy state of the interval job between runs (exit 0, no fix); `loaded-not-running` when the state is not running and the last exit code is non-zero or not reported (exit 1, fix `launchctl kickstart -k gui/<uid>/com.dial.sync`); or `not-loaded` when print fails (exit 1, fix `dial agent install`).

#### Scenario: Running
- **WHEN** the plist exists and the fake launchctl prints `state = running` and `pid = 4242`
- **THEN** stdout starts `agent: running (pid 4242)` and the exit code is 0

#### Scenario: Idle between intervals
- **WHEN** launchctl prints `state = not running`, no pid and `last exit code = 0`
- **THEN** the outcome is `idle`, stdout starts `agent: idle`, no fix is printed, and the exit code is 0

#### Scenario: Loaded, not running
- **WHEN** launchctl prints `state = not running`, no pid and no `last exit code = 0` line
- **THEN** the outcome is `loaded-not-running`, stdout includes `fix: launchctl kickstart -k gui/<uid>/com.dial.sync`, and the exit code is 1

#### Scenario: Not loaded
- **WHEN** the plist exists and `launchctl print` exits 113
- **THEN** the outcome is `not-loaded`, stdout includes `fix: dial agent install`, and the exit code is 1

#### Scenario: Node moved
- **WHEN** the node binary path recorded in the plist no longer exists
- **THEN** the outcome is `paths-missing`, stdout names the missing path and includes `fix: dial agent install`, and the exit code is 1

#### Scenario: Not installed
- **WHEN** no plist exists
- **THEN** the outcome is `not-installed`, stdout includes `fix: dial agent install`, and the exit code is 1

#### Scenario: JSON form
- **WHEN** `dial agent status --json` is run on a running agent
- **THEN** stdout is a JSON object with `outcome` `running`, `label` `com.dial.sync`, `plistPath` and `pid`, and the exit code is 0

### Requirement: The launchctl path is overridable for tests
Every agent subcommand SHALL run the binary named by `DIAL_LAUNCHCTL_BIN` when it is set and non-blank, and `/bin/launchctl` otherwise.

#### Scenario: Fake launchctl
- **WHEN** `DIAL_LAUNCHCTL_BIN` names a script that records its arguments
- **THEN** `dial agent status` runs that script with `print gui/<uid>/com.dial.sync` and `/bin/launchctl` is not run

### Requirement: Watch polls state directories and syncs a repo whose state moved
`dial watch` SHALL, every `watchPollSeconds`, read the newest mtime under `.claude/ship/` and `openspec/changes/` of each registered repo and sync each repo whose newest mtime differs from the previous poll; the first poll only records the mtimes. A repo with neither directory SHALL never be synced by watch. It SHALL use no `fswatch` or other external watcher.

#### Scenario: A ship run completes
- **WHEN** `dial watch` is running and a file under `katipon/.claude/ship/` is modified
- **THEN** within one `watchPollSeconds` interval `katipon` is synced and no other repo is

#### Scenario: Nothing moved
- **WHEN** no file under either directory of any repo changes between two polls
- **THEN** no sync runs

#### Scenario: First poll
- **WHEN** `dial watch` starts
- **THEN** the first poll records every repo's newest mtime and syncs nothing

#### Scenario: The registry is read again every poll
- **WHEN** `dial unregister katipon` runs while `dial watch` is running and a file under `katipon/.claude/ship/` is then modified
- **THEN** watch syncs nothing for katipon and writes nothing into its old vault, a repo registered meanwhile is watched from the next poll, and a poll whose registry cannot be read writes one `dial: <reason>` stderr line and syncs nothing

### Requirement: Watch prints one line per sync and runs until interrupted
Watch SHALL print one stdout line per sync it runs, `HH:mm synced <repo> (needs me <n>)`, keep polling when one sync fails (writing one stderr line `dial: <repo>: <reason>`), and exit 0 on SIGINT.

#### Scenario: Sync line
- **WHEN** watch syncs `katipon` at 14:05 and the sync leaves 2 needs-me items
- **THEN** stdout gains exactly the line `14:05 synced katipon (needs me 2)`

#### Scenario: A failing repo does not stop the watch
- **WHEN** one repo's sync fails because its vault path does not exist
- **THEN** stderr gains one line starting `dial: ` naming that repo and the next poll still runs

#### Scenario: SIGINT
- **WHEN** SIGINT is sent to a running `dial watch`
- **THEN** the process exits 0
