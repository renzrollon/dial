# Spec Delta

## ADDED Requirements

### Requirement: The Specs section indexes the living specs
`## Specs` in a repo note SHALL hold a table with the header `| capability | requirements |` and one row `| <name> | <count> |` per living spec the OpenSpec source reports, in the order reported. With no living spec it SHALL hold `No living specs.`; with the fact unobserved, `unobserved: <reason>`. A name SHALL pass the redaction of every string Dial authors and SHALL NOT be a wikilink. The section SHALL carry nothing else from a spec file.

#### Scenario: Index lists every capability
- **WHEN** the living specs are `doctor` with 14 requirements and `registry` with 15
- **THEN** `## Specs` holds exactly the lines `| capability | requirements |`, `| --- | --- |`, `| doctor | 14 |` and `| registry | 15 |`

#### Scenario: A nested name is plain text
- **WHEN** the living specs are `ui` with 2 requirements and `ui/button` with 3
- **THEN** `## Specs` holds `| ui | 2 |` and `| ui/button | 3 |`, and neither name is a wikilink

#### Scenario: No living specs
- **WHEN** the OpenSpec source reports no living spec
- **THEN** `## Specs` holds `No living specs.`

#### Scenario: Specs are unobserved without an openspec directory
- **WHEN** the repository has no `openspec/` directory
- **THEN** `## Specs` holds `unobserved: no openspec dir`

#### Scenario: A second sync writes nothing
- **WHEN** the living specs include `registry` with 3 requirements, and `dial sync katipon` runs twice with nothing under `openspec/specs/` changed between the runs
- **THEN** `## Specs` holds `| registry | 3 |` and the second run writes no file

#### Scenario: A new requirement is a real change
- **WHEN** `openspec/specs/registry/spec.md` gains a line starting `### Requirement:` between two syncs on different days
- **THEN** `Projects/katipon.md` is rewritten with the new count and `updated` set to the second day

#### Scenario: A secret-shaped name never reaches the vault
- **WHEN** a directory under `openspec/specs/` is named `ghp_abc123` and holds a `spec.md`
- **THEN** its row shows `[redacted]` in place of the name, and the name appears in no vault file

#### Scenario: A hand-written Specs section is replaced
- **WHEN** `Projects/katipon.md` holds a human-written `## Specs` section and `dial sync katipon` runs
- **THEN** the note holds exactly one `## Specs` section, the generated one, between `## Changes` and `## Drift`

## MODIFIED Requirements

### Requirement: A repo note has generated Changes, Drift, Recent narrative and State sections
`Projects/<repo>.md` SHALL carry the keys `title, type, repo, scope, state, needs_me, stale, branch, dirty, stash, ahead, behind, worktrees, last_commit, last_session, last_activity, active_changes, created, updated, status, tags, aliases, dial_schema` in that order, with `title` the repo name, `type: repo`, `dial_schema: dial.repo/1`, then `## Next`, `## Narrative`, and the generated `## Changes`, `## Specs`, `## Drift`, `## Recent narrative`, `## State`, in that order after every human-added section, under the same preservation rule as a change note.

#### Scenario: Changes table links every item
- **WHEN** repo `katipon` has the items `add-login` (`pr-open`, needs me, last activity 2026-11-08T21:00:00.000Z) and `fix-cache` (`shipping`, last activity 2026-11-10T08:00:00.000Z), with `TZ=UTC`
- **THEN** `## Changes` holds a table with the header `| change | state | needs_me | last activity |` and the rows `| [[katipon--add-login]] | pr-open | true | 2026-11-08 |` and `| [[katipon--fix-cache]] | shipping | false | 2026-11-10 |`, ordered by the state priority list, and an item with no observed activity shows `—`

#### Scenario: Repo-level state
- **WHEN** the repo has no `openspec/` directory and no PR
- **THEN** the repo note has `state: idle` and `needs_me: false`

#### Scenario: Drift is unobserved without interlock
- **WHEN** `interlock` is not on PATH during `dial sync`
- **THEN** `## Drift` holds `unobserved: interlock: not on PATH`

#### Scenario: Drift counts
- **WHEN** the drift fact holds two unarchived changes, `broken` 1 and `aging` 3
- **THEN** `## Drift` holds exactly the lines `- unarchived: 2`, `- broken: 1`, `- aging: 3`

#### Scenario: Drift with no graph
- **WHEN** the drift fact holds no unarchived change and `broken` and `aging` are `unobserved: interlock drift: no graph has been built — run /interlock:bootstrap once`
- **THEN** `## Drift` holds `- unarchived: 0`, `- broken: unobserved: interlock drift: no graph has been built — run /interlock:bootstrap once` and the same reason for `- aging:`

#### Scenario: Recent narrative holds three entries
- **WHEN** the repo's change notes hold five narrative entries in total
- **THEN** `## Recent narrative` holds the three newest, newest first, each heading followed by ` · [[<repo>--<change>]]` and then its body as written

#### Scenario: Sections keep one order
- **WHEN** a repo note that also holds a human-added `## Links` section is rendered
- **THEN** its `## ` headings are, in order, `Next`, `Narrative`, `Links`, `Changes`, `Specs`, `Drift`, `Recent narrative` and `State`
