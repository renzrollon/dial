# Design

## Context

See `proposal.md` — Why. The ground was read on 2026-11-11 by three investigators; their conclusions are in `.claude/handoff/explore-bootstrap-project-context-20261111-210133.md`. What shapes the approach:

- **Nothing reads `openspec/specs/` today.** `collectOpenspec` (`lib/sources/openspec.mjs:22-58`) reads `openspec/changes/` only and returns `{ active, archived, changes }`; `lib/collect.mjs:24` holds the fallback copy of that shape, `lib/facts.mjs:16-51` the typedef.
- **The repo note has one renderer.** `renderRepoNote` (`lib/render.mjs:320-372`) hands `renderNote` a list of generated sections; a section is generated when its heading name is in `REPO_GENERATED` (`lib/render.mjs:281`). `renderNote` writes `Next`, `Narrative`, every other human section, then the generated list, and keeps the old bytes when a render with the prior `updated` equals the file (`lib/render.mjs:206-210`).
- **The metadata-only rule bounds the content.** A fact value is "a name, count, id, enum, timestamp or path, never file contents or a diff" (`openspec/specs/local-sources/spec.md:9`).
- **`dial sync` already runs right after `dial register`** in every setup path (README.md:198-200, `scripts/add-repo.mjs:76-80`), and `dial handoff <repo>` with no change already writes a person's text onto the repo note (`openspec/specs/handoff-and-narrative/spec.md:9`).

Constraints are unchanged: Node 22+, no dependencies, offline, every missing source is one `unobserved` value. The owner's constraint for this change: lean, just enough for a second brain.

## Goals / Non-Goals

**Goals:**
- The first sync of a newly registered repo puts a capability index on its page, and later syncs keep it current.
- The setup guide has a named bootstrap step that leaves one line about the project on the page.
- No new command, flag, cap, frontmatter key, dependency or rule.

**Non-Goals:**
- No prose copied from the repository (D8 is open for the owner).
- No note per capability, no wikilinks to specs, no graph view.
- No change to `derive`, the State table, `Dial Summary.md`, `dial next`, `dial brief` or `dial report`.
- No delta spec and no shared harness for `scripts/`. The bootstrap question is the one spawn test in `test/add-repo.test.mjs`.

## Decisions

### The index is a generated section that sync renders (D1)

`dial sync` renders the index on the repo note, like `## Changes`. Dry run, the boundary check, atomic writes and "a sync with nothing new writes nothing" all come from the existing write path. A `dial bootstrap` command was rejected: it would repeat sync, and it moves the pinned command count (`openspec/specs/cli-shell/spec.md:21`, `test/cli.test.mjs:17-22`). A seed-once section was rejected: it goes stale as specs are added.

### The fact: `openspec.specs` (D2, D7, D9, D16)

`collectOpenspec` gains one leaf, `specs`, read with `fs` only:

```
specs: fact([{ name, requirements }, …], 'openspec/specs/: <n> living')
     | fact([], 'openspec/specs/: 0 living')                      // specs/ exists and holds no living spec
     | fact([], 'openspec/specs/: absent')                       // openspec/ exists, specs does not
     | unobserved('no openspec dir')                             // same reason as its siblings
     | unobserved('openspec/specs/: <code>')                     // specs exists but cannot be listed
     | unobserved('openspec/specs/<relative>: <code>')           // a directory the walk reaches cannot be listed
     | unobserved('openspec/specs/<relative>/spec.md: <code>')
```

- The walk is recursive, the same shape as OpenSpec 1.15.0 `discoverSpecFiles`. It reads directory entries with `readdir` (a symlinked directory is not entered, because `Dirent.isDirectory()` is false for a symlink). A directory whose name starts with `.` is skipped and not entered. A `spec.md` directly in `openspec/specs/` is not an entry. A directory that holds a `spec.md` is still walked, so a parent and a child can both be entries. A directory named `spec.md` is entered, not read. A `spec.md` symlink is read when it resolves to a file inside the repository, and skipped when it is dangling or resolves to a directory. A symlink that resolves outside the repository makes the whole fact `unobserved: openspec/specs/<relative>/spec.md: outside the repository` and is not read.
- `name` is that directory's path relative to `openspec/specs/`, segments joined by `/` (`ui/button`). `requirements` is the number of lines that start with `### Requirement:`. Entries are sorted by name in code-unit order, the order `byName` uses (`lib/render.mjs:153`).
- The count is a plain line match and does not track code fences (D9). It equals `grep -c '^### Requirement:'`, which a person can check, and none of the 15 living specs in this repo holds a fenced block.
- A directory with no `spec.md` is not an entry, as an unrecognised archive entry is. A present `openspec/specs` that holds no living spec is an observed empty list with evidence `openspec/specs/: 0 living`. Absence of `openspec/specs` is an observed empty list with evidence `openspec/specs/: absent`. When `openspec/specs` exists but cannot be listed (`ENOTDIR` when it is a file, `EACCES`, or any other code), or a directory the walk reaches cannot be listed, the whole fact is `unobserved` and names that directory. A `spec.md` file that cannot be read makes the whole fact `unobserved` and names the file. A partial list would hide a capability (D7). The other OpenSpec facts stay as they are.
- The list is not capped (D2). `## Changes` is not capped either (`lib/render.mjs:283-291`), and a cap would be an eleventh published limit across the limits spec, the README and three tests.
- `failedOpenspec` in `lib/collect.mjs:24` and the `RepoFacts` typedef gain the leaf, so a throwing source still yields `specs: unobserved(<reason>)`.

Nothing but the name and the count leaves the file. `derive` does not read the leaf, and the State table gets no row for it (D14).

### The section: `## Specs` (D3, D4, D5, D11)

`renderRepoNote` adds one entry to its generated list and `'Specs'` to `REPO_GENERATED`:

```
## Changes
## Specs            <- new
## Drift
## Recent narrative
## State  <!-- dial:generated, do not edit -->
```

- Body: the table `| capability | requirements |`, one row per entry in the fact's order; `No living specs.` for an empty list; `unobserved: <reason>` for an unobserved fact. The shape copies `changesBody` and `driftBody`. A renderer called without the leaf writes `unobserved: no specs fact`, as `driftBody` does for a missing drift fact.
- The heading is bare, like `## Changes`, `## Drift` and `## Recent narrative`; it sits after `## Changes` because both list what the repo holds, and before `## Drift`, which reports on the same specs (D5).
- Names are plain text, not wikilinks: Dial writes no spec notes, so each link would be unresolved (D3).
- Every name goes through `cell(redact(name, keep))` with the existing `keep` list. Capability names are not added to `keep` (D11): `keep` exists so a note's name always matches its repo and change, and a spec name names no note. A name shaped like a token is therefore shown as `[redacted]`.
- No frontmatter key is added (D4). `REPO_KEYS`, its copy in `test/render.test.mjs:51-55` and the two key lines of doctor's `fields` evidence stay as they are.

### The modified requirement keeps its name (D10, D13)

`A repo note has generated Changes, Drift, Recent narrative and State sections` is modified under that name, although the note now has a fifth generated section. A rename needs a `RENAMED` block and changes nothing a user can observe. The same requirement text omits the `archived` key that `openspec/specs/doctor/spec.md:220` lists; that mismatch predates this change and is left alone (D13).

### Doctor's disclosure line

`FIELD_LINES` in `lib/doctor.mjs:389-397` writes the body-sections line by hand. It gains `## Specs (capability names, requirement counts)` after `## Changes`. The count of evidence lines stays six.

### The bootstrap step uses `dial handoff` (D6, D12)

After the first sync, the person records one line about the project:

```sh
dial handoff my-repo --text "What this project is, in one line." --source bootstrap
```

It lands under `## Narrative` of `Projects/my-repo.md` as `### YYYY-MM-DD HH:mm · bootstrap`, in the person's own words, so no rule changes. That same handoff also appends one daily line, `- HH:mm dial · my-repo: handoff (bootstrap) [[my-repo]]`, under `## Log` of `Daily/<date>.md`, and creates the daily note when it is absent (`openspec/specs/handoff-and-narrative/spec.md`, the requirement "Handoff appends next steps and the daily handoff line"). `scripts/add-repo.mjs` asks `One line about this project, for its vault page (Enter to skip)` after the sync that writes the notes has returned 0, and runs the command when the answer is not empty. It does not ask when the person declined the sync or the sync failed, because a handoff with no repo note on disk starts from the change-note skeleton (`lib/handoff.mjs:191`). The README shows the command in "Register each repository" and in the one-block first run.

The step has no delta spec (D12): the command it runs is already specified. The question itself is pinned by `test/add-repo.test.mjs`, which spawns the script against a scratch home. There is no shared test harness for `scripts/`. A `/dial:bootstrap` skill and a stable `## About` section were rejected as more than one line needs; a person can still add `## About` by hand, and it survives every render.

### The readers of the generated-section list

Adding a generated section changes a list that several files restate. Each gets a task:

| Reader | What changes |
| --- | --- |
| `lib/render.mjs:281, 364-369` | `REPO_GENERATED` and the generated list |
| `lib/doctor.mjs:396` | the body-sections evidence line |
| `templates/AGENTS-dial-section.md:8` | the generated sections an agent must not edit |
| `templates/Dial Queries.md:39` | the same list in the query notes |
| `docs/how-dial-works.md:15, 69` | the OpenSpec source row and the repo-note sentence |
| `README.md` | the per-repo source table, "Notes, anatomy", the setup steps |
| `test/render.test.mjs:359-360` | the pinned section list |
| `test/doctor.test.mjs:776` | the body-sections line, pinned by prefix today |

`lib/sync.mjs`, `lib/next.mjs`, `lib/brief.mjs` and `lib/report.mjs` read frontmatter only and need nothing.

### Compound note N6 is untouched (D15)

`docs/notes/compound.md` N6 matches this change through `lib/facts.mjs`: the note name `<repo>--<change>` can be read two ways. This change edits only the `RepoFacts` typedef in that file, adds no note name and writes only `Projects/<repo>.md`, so it neither fixes nor widens that ambiguity. The fix N6 describes stays its own change.

## Risks / Trade-offs

- [The index shows names and counts, not what a capability is for] → Capability names are chosen to describe themselves. D8 asks the owner whether a spec's purpose line may be copied; a yes is a follow-up edit to two more requirements.
- [A human-written `## Specs` section in an existing repo note is replaced] → Stated in the delta spec, the README and the AGENTS section. No repository is registered on this machine today.
- [Every existing repo note is rewritten once and its `updated` moves] → One time, on the first sync after the change; the second sync writes nothing.
- [The bootstrap line sinks under later narrative entries] → It stays in the note and in search. A stable section is a hand-written `## About`.
- [A bootstrap handoff typed inside a live Claude Code session counts as that session's handoff, so `SessionEnd` does not narrate on the repo note (`lib/record.mjs:128-135`)] → The setup script runs in a terminal, outside a session.
- [A `### Requirement:` line inside a fenced example is counted] → Accepted (D9); the count is an index figure, not a gate.
- [`dial watch` and the `PostToolUse` hook do not sync a freshly registered repo] → The setup guide and the script run the first sync themselves.

## Migration Plan

No data migration. After the change, the next `dial sync` adds `## Specs` to each repo note. A vault whose `AGENTS.md` already holds the Dial section keeps the old sentence until its owner replaces it with the new `templates/AGENTS-dial-section.md`; `dial vault init <name> --force` refreshes `Dial Queries.md`. Rollback is a revert: the next sync with the old code drops nothing, because the old renderer treats `## Specs` as a human section and keeps it as last written.
