# Proposal

## Why

After `dial register` and the first `dial sync`, `Projects/<repo>.md` holds git and change state only. Nothing on the page says what the project is or which capabilities it has, so in Obsidian it works as a status board and not as a second-brain entry. The setup guide (README "Setup on your machine", `scripts/setup.mjs`, `scripts/add-repo.mjs`) has no step that bootstraps this context when Dial starts on a new project.

## What Changes

- **The OpenSpec source reads the living specs.** It walks `openspec/specs/` recursively, skipping dot-directories and not entering symlinked directories. For each `spec.md` in a directory under that root it reports the capability's path relative to `openspec/specs/` and the count of its requirements. It reads nothing else from those files. A specs path that exists but cannot be listed is `unobserved`, not an empty index.
- **The repo note gains a generated `## Specs` section**, between `## Changes` and `## Drift`: a `| capability | requirements |` table sorted by name. `dial sync` rebuilds it like the other generated sections, so the index is written by the first sync after `register` and stays current afterwards. No new command, flag, cap or frontmatter key.
- **`dial doctor`'s `fields` evidence names the new section**, so the disclosure of what leaves a repository stays complete.
- **The bootstrap step in the setup guide.** After the first sync, `scripts/add-repo.mjs` asks for one line about the project and records it on the repo page with the existing `dial handoff <repo> --text … --source bootstrap`. The README documents the same step by hand in "Register each repository" and in the one-block first run. This needs no change to the CLI.
- **Prose that lists the generated sections or the sources is updated**: `templates/AGENTS-dial-section.md`, `templates/Dial Queries.md`, `docs/how-dial-works.md` and the README.

Nothing is removed. One existing behaviour changes: the first sync after this change rewrites every existing repo note once, because the note gains a section. A human-written `## Specs` section in a repo note would be replaced by the generated one.

Out of scope: copying any prose from a repository into the vault (a spec's `## Purpose` line, a README paragraph), which the metadata-only rule forbids today (decision D8 asks the owner); a note per capability; a `dial bootstrap` command; a `/dial:bootstrap` skill.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-sources`: new requirements — the OpenSpec source walks `openspec/specs/` recursively and reports each living spec's path and requirement count, omits paths that are not capabilities, and reports an unreadable path as `unobserved` rather than a partial index.
- `note-rendering`: the repo-note requirement gains the generated `## Specs` section and its place in the order; a new requirement defines what the section holds.
- `doctor`: the `fields` check's body-sections evidence line names `## Specs`.

## Impact

- Code: `lib/sources/openspec.mjs` (the new reader), `lib/collect.mjs` and `lib/facts.mjs` (the fact shape), `lib/render.mjs` (the section), `lib/doctor.mjs` (the evidence line).
- Tests: `test/sources-openspec.test.mjs`, `test/render.test.mjs`, `test/sync.test.mjs`, `test/doctor.test.mjs`, `test/secrets.test.mjs`, `test/add-repo.test.mjs`. Existing pins of the repo note's section list and of the `fields` evidence change.
- Setup: `scripts/add-repo.mjs` (one more question; `scripts/setup.mjs` inherits it).
- Docs and templates: `README.md`, `docs/how-dial-works.md`, `templates/AGENTS-dial-section.md`, `templates/Dial Queries.md`. A vault that already has the AGENTS section appended keeps the old text until its owner updates it by hand.
- No new dependency, command, environment variable, cap or network call. The registry and the Dial home are untouched.
