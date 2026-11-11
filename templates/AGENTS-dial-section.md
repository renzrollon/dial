## Dial notes

Dial (`dial sync`) writes notes about code repositories into this vault. These rules extend the ones above for those notes only.

- **Types.** `type: change` (a note in `Changes/`) and `type: repo` (a note in `Projects/`) extend this vault's `type` enum. `Dial Summary.md` is `type: note`; the weekly review in `Inbox/` is `type: note`.
- **Filenames.** Dial names its notes as slugs, not Title Case: `Projects/<repo>.md` and `Changes/<repo>--<change>.md`, every character in `: / \ ? * " < > | # ^ [ ]` replaced by `-`. This is an exception to the Title Case filename rule; do not rename them, because Dial finds a note by its name.
- **Human-owned sections.** `## Next` (checkboxes) and `## Narrative` (entries headed `### YYYY-MM-DD HH:mm · <source>`, newest first) belong to the human. Dial copies them byte for byte and only ever prepends a narrative entry or appends a `- [ ]` line through `dial handoff`. Any other `##` section a human adds is kept too.
- **Generated sections.** `## State  <!-- dial:generated, do not edit -->` in a change note, and `## Changes`, `## Drift`, `## Recent narrative` and `## State` in a repo note, are rebuilt from the facts on every sync. Edits there are overwritten; do not edit them.
- **Frontmatter.** Dial rewrites the keys it owns (`title, type, repo, change, scope, state, needs_me, stale, branch, pr, pr_state, ci, merge_verdict, tasks_done, tasks_total, last_commit, last_session, last_activity, created, updated, status, tags, aliases, dial_schema`, and for a repo note `dirty, stash, ahead, behind, worktrees, active_changes`), writes `created` once, bumps `updated` only when the file changes, and keeps every other key as written. A value Dial could not observe is written `unobserved`, never guessed.
- **Never delete.** Dial never deletes a note. An archived change's note moves to `Archive/Changes/` with `status: archived` and `archived: YYYY-MM-DD`; a dropped one carries `dropped: YYYY-MM-DD`. Agents follow the same rule: move, never delete.
- **Daily log.** Dial appends `- HH:mm dial · …` lines at the end of `## Log` in `Daily/YYYY-MM-DD.md` and never rewrites earlier lines.
- **Metadata only.** Dial notes hold states, counts, names and short evidence strings, never a diff, a file body or a secret. Do not paste either into a Dial note.
