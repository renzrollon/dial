# registry Specification

## Purpose
The one maintained artefact in Dial: the file that maps each registered repository to exactly one Obsidian vault and one forge host, and the rules that keep that mapping sound so work and personal state can never mix.

## Requirements

### Requirement: The registry file has a versioned shape
The registry SHALL live at `<home>/registry.json` and be a JSON object with `dial_schema` equal to `dial.registry/1`, `vaults` (an object of vault name to absolute directory path), `repos` (an array of objects with `path`, `vault` and `host`), and an optional `limits` object. A file whose `dial_schema` is missing or unrecognised SHALL be refused with a reason naming the file and the value found.

#### Scenario: Well-formed file loads
- **WHEN** the registry file holds the schema marker, two vaults and one repo
- **THEN** every command that reads it succeeds and `dial repos` lists that repo

#### Scenario: Wrong schema marker
- **WHEN** the file's `dial_schema` is `dial.registry/0`
- **THEN** reading commands exit 1 with a reason naming the file path and `dial.registry/0`

#### Scenario: File is not JSON
- **WHEN** the file cannot be parsed as JSON
- **THEN** reading commands exit 1 with `dial: registry is not valid json: <path> (<parser message>)`

### Requirement: A missing registry is an empty registry
When no registry file exists, reading commands SHALL behave as if the registry held no vaults, no repos and default limits, and SHALL NOT create the file.

#### Scenario: Repos before anything is registered
- **WHEN** `dial repos` is run with no registry file
- **THEN** stdout is `no repos registered`, the exit code is 0, and no file was created

#### Scenario: Repos as JSON before anything is registered
- **WHEN** `dial repos --json` is run with no registry file
- **THEN** stdout is an empty JSON array and the exit code is 0

### Requirement: Entries are validated on every load
Each repo entry SHALL name a `vault` that exists under `vaults` and a `host` that is `github` or `gitlab`. Two entries SHALL NOT share a path, and two entries SHALL NOT share a repo name. A violation SHALL be refused on load with a reason naming the offending entry.

#### Scenario: Entry names an unknown vault
- **WHEN** an entry's `vault` is `clients` and `vaults` has no `clients` key
- **THEN** reading commands exit 1 with a reason naming the repo path and `clients`

#### Scenario: Entry has an unknown host
- **WHEN** an entry's `host` is `bitbucket`
- **THEN** reading commands exit 1 with a reason naming the repo path and listing `github` and `gitlab` as the allowed values

#### Scenario: Two entries share a name
- **WHEN** two entries' paths both end in `/katipon`
- **THEN** reading commands exit 1 with a reason naming both paths

### Requirement: A repository is registered with its vault and host
`dial register <path> --vault <name> --host <github|gitlab>` SHALL add an entry for an existing directory that contains a `.git` entry, store its path with the user's home directory collapsed to `~`, print the repo name (the path's last segment) on stdout, and exit 0. Both options SHALL be required. The vault name SHALL exist in `vaults`.

#### Scenario: Successful registration
- **WHEN** `dial register ~/IdeaProjects/katipon --vault personal --host github` is run and `personal` is a known vault
- **THEN** stdout is `katipon`, the exit code is 0, and the registry holds one entry with path `~/IdeaProjects/katipon`, vault `personal`, host `github`

#### Scenario: Missing option
- **WHEN** `dial register <path> --vault personal` is run without `--host`
- **THEN** stderr is `dial: register needs --vault <name> and --host github|gitlab` and the exit code is 1

#### Scenario: Unknown vault name
- **WHEN** `--vault clients` is given and `vaults` has no `clients` key
- **THEN** stderr names `clients`, quotes the JSON line to add under `vaults` in the registry file, and the exit code is 1

#### Scenario: Invalid host value
- **WHEN** `--host bitbucket` is given
- **THEN** stderr is `dial: --host must be github or gitlab, not bitbucket` and the exit code is 1

#### Scenario: Path is not a git work tree
- **WHEN** the path exists but has no `.git` entry
- **THEN** stderr names the path and says it is not a git work tree, and the exit code is 1

#### Scenario: Linked worktree is accepted
- **WHEN** the path's `.git` is a file rather than a directory
- **THEN** registration succeeds

#### Scenario: Path does not exist
- **WHEN** the path does not exist
- **THEN** stderr names the path and the exit code is 1

### Requirement: A repository belongs to exactly one vault
Registering a path, or a path whose repo name is already registered, with a different vault SHALL be refused, and the registry SHALL be unchanged. Registering the same path with the same vault SHALL update that entry's host in place, leaving one entry.

#### Scenario: Re-registering to another vault is refused
- **WHEN** `~/VSCodeProjects/beta-rabbitdeploy` is registered to `work` and `dial register ~/VSCodeProjects/beta-rabbitdeploy --vault personal --host github` is run
- **THEN** stderr is `dial: beta-rabbitdeploy is registered to vault work (~/VSCodeProjects/beta-rabbitdeploy); a repo belongs to exactly one vault`, the exit code is 1, and the registry file is byte-identical to before

#### Scenario: Same name under another path and vault is refused
- **WHEN** `~/IdeaProjects/katipon` is registered to `personal` and `dial register ~/elsewhere/katipon --vault work --host gitlab` is run
- **THEN** stderr names `katipon` and the existing path, the exit code is 1, and the registry is unchanged

#### Scenario: Same path and vault updates the host
- **WHEN** a path registered to `personal` with host `github` is registered again to `personal` with host `gitlab`
- **THEN** the exit code is 0 and the registry holds exactly one entry for that path with host `gitlab`

### Requirement: A repository can be unregistered by path or by name
`dial unregister <path-or-name>` SHALL remove the entry whose stored path, expanded path, or repo name matches, print the removed repo name, and exit 0. With no match it SHALL exit 1 with `dial: no registered repo matches <argument>` and leave the file unchanged.

#### Scenario: Unregister by name
- **WHEN** `dial unregister katipon` is run and an entry for `~/IdeaProjects/katipon` exists
- **THEN** stdout is `katipon`, the exit code is 0, and the entry is gone

#### Scenario: Unregister by absolute path
- **WHEN** `dial unregister /Users/<user>/IdeaProjects/katipon` is run and the entry is stored as `~/IdeaProjects/katipon`
- **THEN** the entry is removed and the exit code is 0

#### Scenario: Nothing matches
- **WHEN** `dial unregister nothing-here` is run
- **THEN** stderr is `dial: no registered repo matches nothing-here`, the exit code is 1, and the registry file is byte-identical to before

### Requirement: Registered repositories are listed
`dial repos` SHALL print one line per entry, sorted by repo name, with the columns name, vault, host and absolute path aligned. `dial repos --json` SHALL print an array of objects with `name`, `path` (absolute, expanded), `vault` and `host`.

#### Scenario: Text listing
- **WHEN** two repos are registered
- **THEN** stdout has two lines, ordered by name, each containing the name, vault, host and the absolute path

#### Scenario: JSON listing
- **WHEN** `dial repos --json` is run with one repo stored as `~/IdeaProjects/katipon`
- **THEN** the array holds one object whose `path` is the absolute expanded path and whose `name` is `katipon`

### Requirement: The registry is written atomically and reproducibly
Every write SHALL go to a temporary file in the home directory and then be renamed over `registry.json`, so a failed write leaves the previous file intact. The file SHALL be two-space-indented JSON with a trailing newline, and writing an unchanged registry SHALL produce a byte-identical file.

#### Scenario: Round trip
- **WHEN** a repo is registered and the registry is loaded again
- **THEN** the loaded entry equals what was registered

#### Scenario: Unchanged write is byte-identical
- **WHEN** the registry is written twice without a change in between
- **THEN** the file bytes are identical after both writes

#### Scenario: No partial file on failure
- **WHEN** the temporary file cannot be written because the home is read-only
- **THEN** `registry.json` is byte-identical to its previous content
