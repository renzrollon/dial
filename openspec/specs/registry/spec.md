# registry Specification

## Purpose
The one maintained artefact in Dial: the file that maps each registered repository to exactly one Obsidian vault and one forge host, and the rules that keep that mapping sound so work and personal state can never mix.

## Requirements

### Requirement: The registry file has a versioned shape
The registry SHALL live at `<home>/registry.json` and be a JSON object with `dial_schema` equal to `dial.registry/1`, `vaults` (vault name to absolute directory path), `repos` (an array of objects with `path`, `vault` and `host`), an optional `limits` object, an optional `roots` object (directory path, `~` allowed, to a vault name), and an optional `narrate` object (keys `provider`, `url`, `model`, `apiKeyEnv`, `fallbackUrl`, `fallbackModel`). A file whose `dial_schema` is missing or unrecognised SHALL be refused with a reason naming the file and the value found.

#### Scenario: Well-formed file loads
- **WHEN** the registry file holds the schema marker, two vaults and one repo
- **THEN** every command that reads it succeeds and `dial repos` lists that repo

#### Scenario: Wrong schema marker
- **WHEN** the file's `dial_schema` is `dial.registry/0`
- **THEN** reading commands exit 1 with a reason naming the file path and `dial.registry/0`

#### Scenario: File is not JSON
- **WHEN** the file cannot be parsed as JSON
- **THEN** reading commands exit 1 with `dial: registry is not valid json: <path> (<parser message>)`

#### Scenario: File with a narrate block loads under the same marker
- **WHEN** the file's `dial_schema` is `dial.registry/1` and it holds `"narrate": { "provider": "mtplx", "url": "http://127.0.0.1:8000/v1", "model": "mtplx-qwen38-27b-optimized-speed", "apiKeyEnv": "MTPLX_API_KEY", "fallbackUrl": "http://127.0.0.1:11434/v1", "fallbackModel": "qwen3.6" }`
- **THEN** every command that reads it succeeds

#### Scenario: File with a roots map loads under the same marker
- **WHEN** the file's `dial_schema` is `dial.registry/1`, `vaults` holds `personal` and `work`, and it holds `"roots": { "~/VSCodeProjects": "work" }`
- **THEN** every command that reads it succeeds and `dial repos` prints the same bytes as without `roots`

#### Scenario: A write keeps the roots map
- **WHEN** the file holds a `roots` map and `dial register` adds a repo
- **THEN** the rewritten file holds the same `roots` object with the same keys and values

#### Scenario: A write keeps the narrate block
- **WHEN** the file holds a `narrate` block and `dial register` adds a repo
- **THEN** the rewritten file holds the same `narrate` object with the same keys and values, and `dial_schema` is still `dial.registry/1`

### Requirement: A missing registry is an empty registry
When no registry file exists, reading commands SHALL behave as if the registry held no vaults, no repos and default limits, and SHALL NOT create the file.

#### Scenario: Repos before anything is registered
- **WHEN** `dial repos` is run with no registry file
- **THEN** stdout is `no repos registered`, the exit code is 0, and no file was created

#### Scenario: Repos as JSON before anything is registered
- **WHEN** `dial repos --json` is run with no registry file
- **THEN** stdout is an empty JSON array and the exit code is 0

### Requirement: Entries are validated on every load
Each repo entry SHALL name a `vault` that exists under `vaults` and a `host` that is `github` or `gitlab`. Two entries SHALL NOT share a path, and two entries SHALL NOT share a repo name. Repo names SHALL be compared as the note filenames use them, after the sanitising that replaces `: / \ ? * " < > | # ^ [ ]` with `-`, because notes and the remote cache are keyed by that form. A violation SHALL be refused on load with a reason naming the offending entry, and `dial register` SHALL refuse a path whose sanitised name is already registered under another path.

#### Scenario: Entry names an unknown vault
- **WHEN** an entry's `vault` is `clients` and `vaults` has no `clients` key
- **THEN** reading commands exit 1 with a reason naming the repo path and `clients`

#### Scenario: Entry has an unknown host
- **WHEN** an entry's `host` is `bitbucket`
- **THEN** reading commands exit 1 with a reason naming the repo path and listing `github` and `gitlab` as the allowed values

#### Scenario: Two entries share a name
- **WHEN** two entries' paths both end in `/katipon`
- **THEN** reading commands exit 1 with a reason naming both paths

#### Scenario: Two names that sanitise alike
- **WHEN** one entry's path ends in `/a#b` and another's in `/a-b`
- **THEN** reading commands exit 1 with `two repos are named a-b` and both paths, and `dial register <dir>/a-b` beside a registered `<dir>/a#b` is refused with the registry unchanged

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

### Requirement: The narrate block is validated on every load
When present, `narrate` SHALL be a JSON object, else every reading command exits 1 with `dial: registry narrate must be an object`. Each key SHALL be one of the six published keys, else `dial: unknown narrate key: <k>`; each value SHALL be a string, else `dial: narrate <k> must be a string`. `url` and `fallbackUrl` SHALL start with `http://` or `https://`, else `dial: narrate url must start with http:// or https://: <value>`. `apiKeyEnv` names a variable; the registry never holds a key.

#### Scenario: Narrate is not an object
- **WHEN** the registry's `narrate` is `"http://127.0.0.1:8000/v1"`, `null` or an array
- **THEN** `dial repos` exits 1 with stderr exactly `dial: registry narrate must be an object`

#### Scenario: Unknown key inside narrate
- **WHEN** the registry's `narrate` holds `"temperature": "0.2"`
- **THEN** `dial repos` exits 1 with stderr exactly `dial: unknown narrate key: temperature`

#### Scenario: URL without a scheme
- **WHEN** the registry's `narrate.url` is `127.0.0.1:8000/v1`
- **THEN** `dial repos` exits 1 with stderr exactly `dial: narrate url must start with http:// or https://: 127.0.0.1:8000/v1`

#### Scenario: Fallback URL without a scheme
- **WHEN** the registry's `narrate.fallbackUrl` is `ftp://127.0.0.1:11434/v1`
- **THEN** `dial repos` exits 1 with stderr exactly `dial: narrate url must start with http:// or https://: ftp://127.0.0.1:11434/v1`

#### Scenario: Non-string value
- **WHEN** the registry's `narrate.model` is `27`
- **THEN** `dial repos` exits 1 with stderr exactly `dial: narrate model must be a string`

#### Scenario: Empty narrate block
- **WHEN** the registry's `narrate` is `{}`
- **THEN** every command that reads the registry succeeds

### Requirement: The narrate block does not change the repository listing
`dial repos` and `dial repos --json` SHALL print the same bytes whether or not the registry holds a valid `narrate` block, and SHALL NOT print any `narrate` value.

#### Scenario: Listing with and without narrate
- **WHEN** `dial repos` and `dial repos --json` are run against a registry, then against the same registry with a valid `narrate` block added
- **THEN** each command's stdout is byte-identical across the two runs and the exit code is 0 both times

### Requirement: A repo argument or a working directory resolves to at most one registered repo
`sync <repo>`, `brief`, `handoff`, `narrate`, `drop`, `record` and the four hook scripts SHALL resolve a repo through one rule. An argument equal to a registered repo's name SHALL resolve to that repo. Otherwise the argument SHALL be read as a path (`~` expanded, made absolute), and it SHALL resolve to the registered repo whose path equals it or contains it segment by segment. When more than one registered path contains it, the longest SHALL win.

#### Scenario: A sibling with a shared prefix does not match
- **WHEN** katipon is registered at `/Users/caro/IdeaProjects/katipon` and the argument is `/Users/caro/IdeaProjects/katipon-old`
- **THEN** no repo is resolved

### Requirement: Repo paths are compared through their real paths
Repo resolution SHALL compare the argument and every registered path through their real paths (symlinks resolved), and also lexically, so a symlinked registration matches a physical working directory and a path that no longer exists still matches its stored form.

#### Scenario: Physical working directory of a symlinked registration
- **WHEN** katipon is registered at `/Users/caro/code/katipon`, a symlink to `/Users/caro/IdeaProjects/katipon`, and a hook payload's `cwd` is `/Users/caro/IdeaProjects/katipon/lib`
- **THEN** the hook acts on `katipon`

#### Scenario: A temp-directory repository on macOS
- **WHEN** a repository is registered at `$TMPDIR/r` with `$TMPDIR` under `/var/folders/…`, and a process started in it reports `process.cwd()` as `/private/var/folders/…/r`
- **THEN** that directory resolves to the repository

#### Scenario: A registered path that no longer exists
- **WHEN** katipon's registered directory was deleted and `dial sync katipon` is run
- **THEN** the name still resolves to katipon; the lookup never fails because a directory is gone, and the sources report what they cannot read

### Requirement: The roots map is validated on every load
When present, `roots` SHALL be a JSON object, else every reading command exits 1 with `dial: registry roots must be an object of directory to vault name: <file>`. Each value SHALL be a string naming a vault in `vaults`, else `dial: registry root <dir>: vault <json value> is not in vaults (<file>)`. A repo entry that lies under a root of another vault SHALL NOT fail the load, so `dial unregister` can still repair it; the vault-write boundary and doctor's `boundary` check report it instead.

#### Scenario: Roots is not an object
- **WHEN** the registry's `roots` is `["~/VSCodeProjects"]`
- **THEN** `dial repos` exits 1 with stderr `dial: registry roots must be an object of directory to vault name: <file>`

#### Scenario: Root names an unknown vault
- **WHEN** the registry's `roots` is `{ "~/VSCodeProjects": "clients" }` and `vaults` has no `clients` key
- **THEN** `dial repos` exits 1 with stderr `dial: registry root ~/VSCodeProjects: vault "clients" is not in vaults (<file>)`

#### Scenario: An entry contradicting its root still loads
- **WHEN** `~/VSCodeProjects/agentbase` is registered to `personal` and `roots` is `{ "~/VSCodeProjects": "work" }`
- **THEN** `dial repos` exits 0 and `dial unregister agentbase` succeeds

### Requirement: A path's root vault comes from the longest containing root
A path's root vault SHALL be the vault of the longest `roots` key that equals or contains the path segment by segment, compared through real and lexical paths by the repo-resolution rule; a path under no root has none.

#### Scenario: Nested roots
- **WHEN** `roots` is `{ "~/VSCodeProjects": "work", "~/VSCodeProjects/oss": "personal" }`
- **THEN** `~/VSCodeProjects/oss/tool` has root vault `personal` and `~/VSCodeProjects/agentbase` has root vault `work`

### Requirement: A path under a declared root is registered only to that root's vault
`dial register <path> --vault <v>` SHALL be refused when the path's root vault exists and differs from `<v>`, with stderr `dial: <path, home collapsed to ~> is under <root>, which belongs to vault <rv>; a repo belongs to exactly one vault`, exit 1, and the registry file byte-identical to before. The refusal SHALL NOT depend on whether the path exists.

#### Scenario: A work path given the personal vault is refused
- **WHEN** `roots` is `{ "~/VSCodeProjects": "work" }`, `~/VSCodeProjects/agentbase` is not registered, and `dial register ~/VSCodeProjects/agentbase --vault personal --host gitlab` is run
- **THEN** stderr is `dial: ~/VSCodeProjects/agentbase is under ~/VSCodeProjects, which belongs to vault work; a repo belongs to exactly one vault`, the exit code is 1, and the registry file is byte-identical to before

#### Scenario: The same path given its root's vault is accepted
- **WHEN** the same command is run with `--vault work`
- **THEN** stdout is `agentbase` and the exit code is 0

#### Scenario: The longest root wins
- **WHEN** `roots` is `{ "~/VSCodeProjects": "work", "~/VSCodeProjects/oss": "personal" }` and `dial register ~/VSCodeProjects/oss/katipon-fork --vault personal --host github` is run
- **THEN** the registration succeeds

#### Scenario: A sibling sharing a prefix is under no root
- **WHEN** `roots` is `{ "~/VSCodeProjects": "work" }` and `dial register ~/VSCodeProjects-old/tool --vault personal --host github` is run
- **THEN** no root refusal is made

#### Scenario: No roots declared
- **WHEN** the registry has no `roots` and a path under `~/VSCodeProjects` is registered with `--vault personal`
- **THEN** the registration succeeds, as before this change
