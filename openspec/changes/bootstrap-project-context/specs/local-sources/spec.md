# Spec Delta

## ADDED Requirements

### Requirement: OpenSpec reports the living specs
With an `openspec/` directory present, the OpenSpec source SHALL walk `openspec/specs/` recursively and report one entry per living spec: the directory's path relative to `openspec/specs/`, segments joined by `/`, and the count of lines starting with `### Requirement:`, ordered by that path in code-unit order. A directory that holds a `spec.md` SHALL still be walked. The source SHALL report nothing else from a spec file.

#### Scenario: Capabilities and requirement counts
- **WHEN** `openspec/specs/` holds `registry/spec.md` with three lines starting `### Requirement:` and `doctor/spec.md` with two
- **THEN** the living specs are `doctor` with 2 requirements and `registry` with 3, in that order, with evidence `openspec/specs/: 2 living`

#### Scenario: A nested capability is named by its path
- **WHEN** `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`, `openspec/specs/ui/spec.md` has two, and `openspec/specs/ui/button/spec.md` has three
- **THEN** the living specs are `doctor` with 1, `ui` with 2 and `ui/button` with 3, in that order, with evidence `openspec/specs/: 3 living`

#### Scenario: Only the name and the count are reported
- **WHEN** `openspec/specs/registry/spec.md` holds a `## Purpose` paragraph, one `### Requirement:` line and two `#### Scenario:` blocks
- **THEN** the entry for `registry` holds its name and the count 1 and nothing else

#### Scenario: A symlinked spec file is read
- **WHEN** `openspec/specs/registry/spec.md` is a symlink to a file inside the repository with two lines starting `### Requirement:`
- **THEN** `registry` is a living spec with 2 requirements

### Requirement: The specs walk ignores what is not a capability
The walk SHALL NOT enter a dot-directory or a symlinked directory. A `spec.md` directly in `openspec/specs/` SHALL NOT be a living spec. A directory named `spec.md` SHALL be entered and SHALL NOT be read as a file. A `spec.md` symlink SHALL be read only when it resolves to a file inside the repository. A dangling link, or one that resolves to a directory, SHALL be skipped and SHALL NOT unobserve the fact. A directory with no `spec.md` SHALL NOT be an entry.

#### Scenario: A directory without a spec file is ignored
- **WHEN** `openspec/specs/drafts/` holds `notes.md` and no `spec.md`, and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs are `doctor` with 1, and `drafts` is not a living spec

#### Scenario: A dot-directory is not walked
- **WHEN** `openspec/specs/.drafts/spec.md` has four lines starting `### Requirement:`, `openspec/specs/.drafts/secret/spec.md` has two, and `openspec/specs/doctor/spec.md` has one
- **THEN** the living specs are `doctor` with 1, with evidence `openspec/specs/: 1 living`

#### Scenario: A spec file directly in the specs directory is not a capability
- **WHEN** `openspec/specs/spec.md` has four lines starting `### Requirement:` and `openspec/specs/doctor/spec.md` has one
- **THEN** the living specs are `doctor` with 1, and no entry has an empty path

#### Scenario: A symlinked directory is not entered
- **WHEN** `openspec/specs/linked` is a symlink to a directory whose `spec.md` has two lines starting `### Requirement:`, and `openspec/specs/doctor/spec.md` has one
- **THEN** the living specs are `doctor` with 1, with evidence `openspec/specs/: 1 living`

#### Scenario: A spec symlink to a directory is skipped
- **WHEN** `openspec/specs/registry/spec.md` is a symlink to a directory, and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs are `doctor` with 1, observed, with evidence `openspec/specs/: 1 living`

#### Scenario: A dangling spec symlink is skipped
- **WHEN** `openspec/specs/registry/spec.md` is a symlink to a missing path, and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs are `doctor` with 1, observed, with evidence `openspec/specs/: 1 living`

#### Scenario: A directory named spec.md is walked, not read
- **WHEN** `openspec/specs/registry/spec.md` is a directory that holds no `spec.md`, and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs are `doctor` with 1, the fact is observed, and the reason is not `EISDIR`

### Requirement: An empty specs tree is observed
A present `openspec/specs` with no living spec SHALL be an observed empty list with evidence `openspec/specs/: 0 living`. When `openspec/specs` is absent the fact SHALL be an observed empty list with evidence `openspec/specs/: absent`.

#### Scenario: A specs directory with no living spec
- **WHEN** `openspec/specs/` exists and holds `drafts/notes.md` and no `spec.md`
- **THEN** the living specs are an empty list with evidence `openspec/specs/: 0 living`

#### Scenario: No specs directory
- **WHEN** the repository has an `openspec/` directory and no `openspec/specs`
- **THEN** the living specs are an empty list with evidence `openspec/specs/: absent`

### Requirement: An unreadable specs path is unobserved
When `openspec/specs` exists but cannot be listed, when a directory the walk reaches cannot be listed, when a `spec.md` file cannot be read, or when a `spec.md` symlink resolves outside the repository, the whole specs fact SHALL be `unobserved`, naming that path and the reason. A partial list SHALL NOT be reported. The other OpenSpec facts SHALL still be reported. With no `openspec/` directory the fact SHALL be `unobserved: no openspec dir`.

#### Scenario: The specs path exists but cannot be listed
- **WHEN** `openspec/specs` is a file and `openspec/changes/add-login/` exists
- **THEN** the living specs fact is `unobserved: openspec/specs/: ENOTDIR`, the active changes are still reported, and `dial sync katipon` exits 0

#### Scenario: A directory the walk cannot list
- **WHEN** listing `openspec/specs/ui/button` fails with EACCES and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs fact is `unobserved: openspec/specs/ui/button: EACCES`, `doctor` is not reported as a living spec, the other OpenSpec facts are still reported, and `dial sync katipon` exits 0

#### Scenario: A spec file that cannot be read
- **WHEN** `openspec/specs/registry/spec.md` cannot be read (`EACCES`) and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs fact is `unobserved: openspec/specs/registry/spec.md: EACCES`, `doctor` is not reported as a living spec, the other OpenSpec facts are still reported, and `dial sync katipon` exits 0

#### Scenario: A spec symlink that leaves the repository is unobserved
- **WHEN** `openspec/specs/registry/spec.md` is a symlink to a file outside the repository, and `openspec/specs/doctor/spec.md` has one line starting `### Requirement:`
- **THEN** the living specs fact is `unobserved: openspec/specs/registry/spec.md: outside the repository`, and `doctor` is not reported as a living spec

#### Scenario: No openspec directory
- **WHEN** the registered repository has no `openspec/` directory
- **THEN** the living specs fact is `unobserved: no openspec dir`
