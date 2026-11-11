# Spec Delta

## Purpose

How a change's narrative gets written: `dial handoff` records five lines a session or a person wrote, `dial narrate` asks a local model to write them from a transcript tail, and `dial record` runs sync and narrate from a Claude Code hook event, every entry dated and labelled with its source.

## ADDED Requirements

### Requirement: Handoff prepends a dated, labelled entry to the narrative
`dial handoff <repo> [<change>]` SHALL insert one entry at the top of `## Narrative` in `Changes/<repo>--<change>.md`, or in `Projects/<repo>.md` when no change is given: the heading `### YYYY-MM-DD HH:mm · <source>` in local time (`DIAL_NOW` overrides the clock), the text with trailing whitespace trimmed, then one empty line. `<source>` SHALL be `--source` or the default `dial handoff`. Older entries SHALL stay byte for byte below it. The text SHALL NOT be able to change the note's structure: outside a fenced block, a body line starting `## ` or a dated `### YYYY-MM-DD HH:mm · ` heading SHALL be written one level down (`### `, `#### `), and an unclosed fence SHALL be closed at the end of the entry, so the next sync keeps the whole entry inside `## Narrative`. The same applies to an entry `narrate` writes.

#### Scenario: A body with a section heading survives the next sync
- **WHEN** `dial handoff katipon add-login --stdin` is given `Done: x` then `## State` then `Next: y`, and `dial sync katipon` runs afterwards
- **THEN** the entry is written with the line `### State` and, after the sync, `## Narrative` still holds `Done: x`, `### State` and `Next: y`

#### Scenario: Entry on a change note
- **WHEN** `DIAL_NOW=2026-11-10T14:05:00Z dial handoff katipon add-login --text "Done: wired the form"` is run and `Changes/katipon--add-login.md` exists
- **THEN** the first line under `## Narrative` is `### 2026-11-10 14:05 · dial handoff`, the next line is `Done: wired the form`, and the exit code is 0

#### Scenario: Entry on the repo note
- **WHEN** `dial handoff katipon --text "Done: tidied" --source "/dial:handoff (claude)"` is run
- **THEN** the entry `### <date> <time> · /dial:handoff (claude)` is inserted under `## Narrative` of `Projects/katipon.md` and no change note is written

#### Scenario: Twice gives two entries, newest first
- **WHEN** handoff is run at 14:05 and again at 14:20 on the same note
- **THEN** `## Narrative` holds the 14:20 entry above the 14:05 entry, and the 14:05 entry's bytes are unchanged

#### Scenario: Unknown repo
- **WHEN** `dial handoff nothing-here --text x` is run and no registered repo has that name
- **THEN** stderr is `dial: no registered repo matches nothing-here`, the exit code is 1, and no vault file changed

### Requirement: Handoff takes its text from exactly one of --stdin or --text
Handoff SHALL read the entry body from all of stdin under `--stdin`, or from the value of `--text`. Neither or both SHALL be refused with `dial: handoff needs exactly one of --stdin or --text`; a body that is empty after trimming SHALL be refused with `dial: handoff text is empty`. Both refusals exit 1 and write nothing.

#### Scenario: Body from stdin
- **WHEN** five lines `Done: a`, `Decided: b`, `Next: c`, `Blocked: none`, `Open: none` are piped to `dial handoff katipon add-login --stdin`
- **THEN** the entry body is exactly those five lines in that order

#### Scenario: Neither flag
- **WHEN** `dial handoff katipon add-login` is run
- **THEN** stderr is `dial: handoff needs exactly one of --stdin or --text` and the exit code is 1

#### Scenario: Both flags
- **WHEN** `dial handoff katipon --stdin --text x` is run
- **THEN** stderr is `dial: handoff needs exactly one of --stdin or --text` and the exit code is 1

#### Scenario: Empty body
- **WHEN** only whitespace is piped to `dial handoff katipon --stdin`
- **THEN** stderr is `dial: handoff text is empty`, the exit code is 1, and no vault file changed

### Requirement: Handoff appends next steps and the daily handoff line
Each `--next <text>` SHALL be appended, in the order given, as `- [ ] <text>` at the end of the note's `## Next` section; existing `## Next` lines SHALL stay byte for byte. Handoff SHALL append one line under `## Log` of `Daily/YYYY-MM-DD.md`: `- HH:mm dial · <repo>/<change>: handoff (<source>) [[<repo>--<change>]]`, or `- HH:mm dial · <repo>: handoff (<source>) [[<repo>]]` for the repo note.

#### Scenario: Two next steps
- **WHEN** `dial handoff katipon add-login --text x --next "run the plan" --next "open the PR"` is run and `## Next` holds `- [x] write tests`
- **THEN** `## Next` reads `- [x] write tests`, `- [ ] run the plan`, `- [ ] open the PR`, in that order

#### Scenario: Daily line for a change handoff
- **WHEN** `DIAL_NOW=2026-11-10T14:05:00Z dial handoff katipon add-login --text x --source "/dial:handoff (claude)"` is run
- **THEN** the last line under `## Log` of `Daily/2026-11-10.md` is `- 14:05 dial · katipon/add-login: handoff (/dial:handoff (claude)) [[katipon--add-login]]`

#### Scenario: Daily line for a repo handoff
- **WHEN** `DIAL_NOW=2026-11-10T09:30:00Z dial handoff katipon --text x` is run
- **THEN** the last line under `## Log` of `Daily/2026-11-10.md` is `- 09:30 dial · katipon: handoff (dial handoff) [[katipon]]`

### Requirement: Handoff leaves the frontmatter alone and prints the wikilink
Handoff SHALL NOT change any frontmatter line of the target note (the next `sync` bumps `updated`). On success stdout SHALL be the note's wikilink, `[[<repo>--<change>]]` or `[[<repo>]]`, followed by one newline, and the exit code 0. With `--json` stdout SHALL be an object with `note` (the vault-relative path), `wikilink`, `heading` and `nextAdded` (the count of `--next` items).

#### Scenario: Frontmatter untouched
- **WHEN** handoff is run on a note whose frontmatter holds `updated: 2026-11-09` and `source: hand-written`
- **THEN** the frontmatter block is byte for byte what it was

#### Scenario: Wikilink on stdout
- **WHEN** `dial handoff katipon add-login --text x` succeeds
- **THEN** stdout is exactly `[[katipon--add-login]]` and one newline

#### Scenario: JSON result
- **WHEN** `dial handoff katipon add-login --text x --next y --json` succeeds
- **THEN** stdout is a JSON object with `note` `Changes/katipon--add-login.md`, `wikilink` `[[katipon--add-login]]`, a `heading` starting `### ` and `nextAdded` 1

### Requirement: Handoff creates a missing note from the template and refuses an unknown change
When the target note does not exist, handoff SHALL first create it from the vault's `Templates/Dial Change.md`, or from Dial's packaged skeleton when that file is absent, then add the entry. A change that has no note and no directory under the repo's `openspec/changes/` (active or archived) SHALL be refused with `dial: <repo> has no change <change>`, exit 1. Every write SHALL go only into the repo's registered vault.

#### Scenario: Missing change note
- **WHEN** `openspec/changes/add-login/` exists in the repo and `Changes/katipon--add-login.md` does not
- **THEN** after handoff the note exists with `## Next` and `## Narrative` sections, and the entry is the first one under `## Narrative`

#### Scenario: Missing repo note
- **WHEN** `dial handoff katipon --text x` is run and `Projects/katipon.md` does not exist
- **THEN** the note is created from the template first and the entry is under its `## Narrative`

#### Scenario: Typo in the change name
- **WHEN** `dial handoff katipon add-logn --text x` is run and neither a note nor a change directory named `add-logn` exists
- **THEN** stderr is `dial: katipon has no change add-logn`, the exit code is 1, and no file was created

### Requirement: Narrate reads only the text turns of the transcript tail
`dial narrate <repo> [<change>] --transcript <path>` SHALL keep transcript lines whose top-level `type` is `user` or `assistant`, drop lines with `isMeta` or `isSidechain` true, take user text from string content or `text` blocks, take assistant `text` blocks grouped by `message.id`, never include `tool_result`, `tool_use` or `thinking` content, and use the last `narrateTurns` turns, or `--turns <n>` when given.

#### Scenario: Tool and thinking content is excluded
- **WHEN** the transcript holds an assistant message with a `thinking` block, a `tool_use` block and a `text` block, and a user line whose content is a `tool_result`
- **THEN** the turns sent to the model contain the `text` block and nothing from the other three

#### Scenario: Meta and sidechain lines are excluded
- **WHEN** a user line has `isMeta: true` and an assistant line has `isSidechain: true`
- **THEN** neither line's text appears in the turns

#### Scenario: Turn cap
- **WHEN** the transcript holds 50 text turns, `narrateTurns` is 20 and `--turns` is not given
- **THEN** exactly the last 20 turns are used; with `--turns 5` exactly the last 5

#### Scenario: Missing transcript
- **WHEN** `--transcript /nope.jsonl` names no file
- **THEN** no model call is made, nothing is written, stdout is `unobserved: no transcript at /nope.jsonl`, and the exit code is 0

#### Scenario: No text turns
- **WHEN** the transcript exists but holds no user or assistant text
- **THEN** no model call is made, stdout is `unobserved: transcript has no text turns`, and the exit code is 0

### Requirement: Narrate resolves a local endpoint from pi, the registry and the fallback
The primary endpoint SHALL come from `~/.pi/agent/models.json`: the provider named by registry `narrate.provider` (default `mtplx`), its `baseUrl`, `apiKey` and first model id. Registry `narrate.url`, `narrate.model` and `narrate.apiKeyEnv` (the name of an environment variable holding the key) SHALL override those values. The fallback SHALL be `narrate.fallbackUrl` (default `http://127.0.0.1:11434/v1`) with `narrate.fallbackModel` (default `qwen3.6`) and no key.

#### Scenario: pi's provider is the primary
- **WHEN** `models.json` holds provider `mtplx` with `baseUrl http://127.0.0.1:8000/v1` and model `mtplx-qwen38-27b-optimized-speed`, and the registry has no `narrate` block
- **THEN** the first call goes to `http://127.0.0.1:8000/v1/chat/completions` with model `mtplx-qwen38-27b-optimized-speed`

#### Scenario: Registry overrides pi
- **WHEN** the registry has `narrate.model` `qwen-next` and `narrate.apiKeyEnv` `NARRATE_KEY`
- **THEN** the call uses model `qwen-next` and sends the value of `NARRATE_KEY` as the bearer key

#### Scenario: Nothing configured
- **WHEN** `~/.pi/agent/models.json` is absent and the registry has no `narrate` block
- **THEN** the only call goes to `http://127.0.0.1:11434/v1/chat/completions` with model `qwen3.6` and no `Authorization` header

#### Scenario: A non-local endpoint is never called
- **WHEN** the resolved URL's host is not `127.0.0.1`, `localhost` or `::1`
- **THEN** that endpoint is not called and counts as a failed attempt with the reason `<url> is not a local endpoint`

#### Scenario: A redirect from a local endpoint is never followed
- **WHEN** the local endpoint answers the POST with a `307` or `308` redirect to another host
- **THEN** the call is made with `redirect: 'manual'`, the redirect target is not called, and the attempt fails with the reason `<url> redirected`

### Requirement: Narrate makes one call and at most one fallback call
Narrate SHALL make exactly one `POST <baseUrl>/chat/completions` to the primary endpoint, each call bounded by `narrateTimeoutSeconds`. When it is unreachable, times out, answers non-2xx or gives an unusable reply, narrate SHALL make at most one call to the fallback endpoint and no further call. No cloud endpoint SHALL ever be called.

#### Scenario: Primary answers
- **WHEN** the primary endpoint returns a usable reply
- **THEN** exactly one HTTP request was made

#### Scenario: Primary down, fallback answers
- **WHEN** the primary endpoint refuses the connection and the fallback returns a usable reply
- **THEN** exactly two HTTP requests were made, the second to the fallback URL

#### Scenario: Timeout
- **WHEN** `narrateTimeoutSeconds` is 30 and the primary endpoint does not answer within 30 seconds
- **THEN** the request is aborted and the fallback is called once

### Requirement: A usable reply holds five labelled lines and becomes a narrative entry
A reply SHALL be usable when its `choices[0].message.content`, with any `<think>…</think>` block removed, holds a line starting `Done:`, `Decided:`, `Next:`, `Blocked:` and `Open:` each. Narrate SHALL then add a handoff entry to the target note whose body is those five lines in that order, with the source `local model (<model id>)`, the daily handoff line, and stdout the wikilink.

#### Scenario: Entry from the model
- **WHEN** the model `qwen3.6` replies with the five labelled lines for `dial narrate katipon add-login --transcript t.jsonl`
- **THEN** `Changes/katipon--add-login.md` gains an entry headed `### <date> <time> · local model (qwen3.6)` whose body is the five lines, and stdout is `[[katipon--add-login]]`

#### Scenario: Thinking block is ignored
- **WHEN** the reply content is a `<think>` block followed by the five labelled lines
- **THEN** the entry body is the five lines and holds nothing from the `<think>` block

#### Scenario: A missing label is malformed
- **WHEN** the reply holds `Done:`, `Decided:`, `Next:` and `Blocked:` but no `Open:` line
- **THEN** the reply is unusable and the fallback is called once

### Requirement: A failed narration writes nothing and exits 0
When no attempt yields a usable reply, narrate SHALL write no vault file, append no daily line, print one stdout line `unobserved: <reason>` naming the last attempt's failure (`<url> unreachable`, `<url> timed out after <n>s`, `<url> redirected`, `<url> HTTP <status>`, `<url> reply missing <label>`, `<url> is not a local endpoint`), and exit 0. With `--json` stdout SHALL be an object with `written: false` and `unobserved`.

#### Scenario: Both endpoints down
- **WHEN** the primary and the fallback `http://127.0.0.1:11434/v1` both refuse the connection
- **THEN** stdout is `unobserved: http://127.0.0.1:11434/v1 unreachable`, no vault file changed, and the exit code is 0

#### Scenario: Malformed JSON
- **WHEN** both endpoints answer 200 with a body that is not JSON
- **THEN** nothing is written, stdout starts `unobserved: `, and the exit code is 0

#### Scenario: JSON form
- **WHEN** the same failure happens under `--json`
- **THEN** stdout is a JSON object with `written` false and `unobserved` holding the reason

### Requirement: Dry run prints the prompt and the turns and calls nothing
Under `--dry-run` narrate SHALL print the fixed prompt, the resolved endpoint URLs and model ids, and the selected turns each prefixed `user: ` or `assistant: `, make no HTTP request, write nothing, and exit 0.

#### Scenario: No request, no write
- **WHEN** `dial narrate katipon add-login --transcript t.jsonl --dry-run` is run
- **THEN** stdout holds the prompt and lines starting `user: ` and `assistant: `, no HTTP request was made, no vault file changed, and the exit code is 0

### Requirement: The API key never leaves the call
The resolved API key SHALL be sent only as the `Authorization: Bearer <key>` header of a request to the primary endpoint. It SHALL NOT appear on stdout or stderr (including `--dry-run` and `--json`), in any vault file, in any file under the Dial home, or in an `unobserved` reason.

#### Scenario: Key absent from every output
- **WHEN** `models.json` holds the key `sk-local-123` and narrate runs once with a usable reply, once failing, and once with `--dry-run`
- **THEN** the string `sk-local-123` appears in no stdout, no stderr, no vault file and no file under the Dial home

#### Scenario: Fallback gets no key
- **WHEN** the primary fails and the fallback is called
- **THEN** the fallback request carries no `Authorization` header

### Requirement: Eval runs the labelled set and prints the score
`dial narrate --eval <dir>` SHALL need no `<repo>` or `--transcript`, narrate each `<dir>/items/<id>.jsonl` as a transcript, write the five lines or the `unobserved: <reason>` line to `<dir>/outputs/<id>.md`, and write no vault file. With `<dir>/labels.jsonl` (`{ id, nextCorrect, nothingInvented }`) it SHALL print `nextCorrect: <k> of <n>` and `nothingInvented: <k> of <n>`; without it, `unobserved: no labels`. It exits 0.

#### Scenario: Scored set
- **WHEN** `<dir>/items/` holds 20 items and `labels.jsonl` holds 20 rows, 14 with `nextCorrect: true` and 18 with `nothingInvented: true`
- **THEN** `<dir>/outputs/` holds 20 `.md` files and stdout includes `nextCorrect: 14 of 20` and `nothingInvented: 18 of 20`

#### Scenario: No labels yet
- **WHEN** `<dir>/labels.jsonl` does not exist
- **THEN** the outputs are written, stdout includes `unobserved: no labels`, and the exit code is 0

#### Scenario: Missing items directory
- **WHEN** `<dir>/items/` does not exist
- **THEN** stderr is `dial: <dir>/items is not a directory` and the exit code is 1

### Requirement: Record syncs and narrates from a hook payload and always exits 0
`dial record --event SessionEnd|PreCompact` SHALL read the payload (`cwd`, `session_id`, `transcript_path`) from stdin. A `cwd` not inside a registered repo SHALL exit 0 with no output and no write. Otherwise it SHALL sync the repo, then narrate the attributed note, using `transcript_path` or `~/.claude/projects/<slug>/<session_id>.jsonl`, unless its newest narrative entry already covers the transcript: an entry narrate wrote (source `local model (<model>)`) covers the turns up to the end of its heading's minute, so record narrates when the transcript's last text turn that is not a compaction summary is later than that; any other entry (a handoff) covers the session when it is not older than the transcript's first `timestamp`. A PreCompact narration therefore leaves the turns after compaction to SessionEnd, and a resumed session's later turns are narrated at its next end. Every path exits 0; a failure is one stderr line.

#### Scenario: Unregistered cwd
- **WHEN** the payload's `cwd` is `/tmp/scratch` and no registered repo holds it
- **THEN** stdout and stderr are empty, no file was written, the Dial home was not created, and the exit code is 0

#### Scenario: Session already handed off
- **WHEN** the attributed note's newest entry is `### 2026-11-10 16:40 · /dial:handoff (claude)` and the transcript's first `timestamp` is `2026-11-10T14:00:00.000Z`
- **THEN** the repo is synced, no model call is made, and the exit code is 0

#### Scenario: Session with no handoff
- **WHEN** the newest entry is dated 2026-11-09 and the transcript starts on 2026-11-10
- **THEN** the repo is synced, then narrate runs over that transcript, and the exit code is 0

#### Scenario: SessionEnd after a PreCompact narration
- **WHEN** the newest entry is `### 2026-11-10 15:00 · local model (qwen3.6)`, written at PreCompact, the transcript's first `timestamp` is `2026-11-10T14:00:00.000Z` and its last text turn is at `2026-11-10T15:30:00.000Z`
- **THEN** SessionEnd syncs the repo, then narrate runs over that transcript

#### Scenario: Nothing new since the last narration
- **WHEN** the newest entry is `### 2026-11-10 15:00 · local model (qwen3.6)` and the transcript's last text turn is at `2026-11-10T15:00:20.000Z`
- **THEN** the repo is synced and no model call is made

#### Scenario: A resumed session
- **WHEN** a session narrated at its first SessionEnd is resumed, so its transcript still starts at the original first `timestamp`, and new turns follow the narrated entry
- **THEN** its next SessionEnd narrates again

#### Scenario: Missing transcript path
- **WHEN** the payload has `session_id` `abc` and no `transcript_path`
- **THEN** the transcript read is `~/.claude/projects/<slug>/abc.jsonl`

#### Scenario: Failure is one line and exit 0
- **WHEN** the sync fails because the repo's vault path does not exist
- **THEN** stderr is exactly one line starting `dial: `, narrate is not run, and the exit code is 0

#### Scenario: Bad event name
- **WHEN** `dial record --event Stop` is run
- **THEN** stderr is `dial: record needs --event SessionEnd or PreCompact` and the exit code is 0

### Requirement: Record finishes within the hook timeout
Record SHALL take a deadline of 55 seconds from its start, inside the hook's 60-second timeout. Each model call's timeout SHALL be the smaller of `narrateTimeoutSeconds` and the time left before the deadline minus 2 seconds; a call with less than 5 seconds left SHALL NOT be made and SHALL count as a failed attempt with the reason `no time left before the hook deadline`. The deadline SHALL bound the sync too: each subprocess the sync runs SHALL be killed after the smaller of `subprocessTimeoutSeconds` and the time left before the deadline minus 2 seconds, and one that would start with no time left SHALL NOT start and SHALL count as timed out. Record SHALL take the attribution from the sync's own derived view and re-read only the notes, never collecting the repo a second time.

#### Scenario: A slow primary leaves no time for the fallback
- **WHEN** the sync takes 10 seconds, `narrateTimeoutSeconds` is 30, and the primary endpoint never answers
- **THEN** the primary call is aborted after 30 seconds, the fallback call is bounded by the 13 seconds left before the deadline, and record exits 0 within 55 seconds of its start

#### Scenario: Slow git cannot outlast the deadline
- **WHEN** every `git` call hangs
- **THEN** the sync's git calls are killed by the deadline, record runs no further git call after the sync, and record returns within 55 seconds of its start

#### Scenario: No time left at all
- **WHEN** the sync takes 52 seconds
- **THEN** no model call is made, nothing is written, stderr is empty, and the exit code is 0
