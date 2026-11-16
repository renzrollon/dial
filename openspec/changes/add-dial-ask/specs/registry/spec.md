# Spec Delta

## MODIFIED Requirements

### Requirement: A repo argument or a working directory resolves to at most one registered repo
`sync <repo>`, `brief`, `context`, `handoff`, `narrate`, `drop`, `record` and the four hook scripts SHALL resolve a repo through one rule. An argument equal to a registered repo's name SHALL resolve to that repo. Otherwise the argument SHALL be read as a path (`~` expanded, made absolute), and it SHALL resolve to the registered repo whose path equals it or contains it segment by segment. When more than one registered path contains it, the longest SHALL win.

#### Scenario: A sibling with a shared prefix does not match
- **WHEN** katipon is registered at `/Users/caro/IdeaProjects/katipon` and the argument is `/Users/caro/IdeaProjects/katipon-old`
- **THEN** no repo is resolved

#### Scenario: context resolves a subdirectory to its repo
- **WHEN** katipon is registered at `/Users/caro/IdeaProjects/katipon` and `dial context /Users/caro/IdeaProjects/katipon/lib --json` is run
- **THEN** the document's `repo` is `katipon`
