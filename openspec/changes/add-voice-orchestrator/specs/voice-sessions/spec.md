# Spec Delta

## Purpose

The Claude Code sessions `dial voice` starts for the owner: how the assistant proposes one, how the owner confirms it, how it is started and bounded, and how its state, its screen and its controls reach the page.

## ADDED Requirements

### Requirement: propose checks a repo and a prompt and prints the proposal
`dial propose <repo> --prompt <text>` SHALL resolve `<repo>` by name or by path as `dial context` does, trim the prompt, and exit 0 after printing the proposal. With `--json` it SHALL print exactly `{ "proposal": { "repo": <name>, "prompt": <prompt> } }`. Without it SHALL print two lines: `proposal for <name>: ` followed by the prompt with every run of whitespace as one space, and `nothing is started until it is confirmed in the dial voice window`.

#### Scenario: The JSON form
- **WHEN** `dial propose katipon --prompt "  /interlock:ship add-parser  " --json` is run and `katipon` is registered
- **THEN** stdout parses to `{ "proposal": { "repo": "katipon", "prompt": "/interlock:ship add-parser" } }` with no other key, and the exit code is 0

#### Scenario: The text form
- **WHEN** `dial propose katipon --prompt "fix the parser\nand its test"` is run
- **THEN** stdout is the two lines `proposal for katipon: fix the parser and its test` and `nothing is started until it is confirmed in the dial voice window`

#### Scenario: A repo named by its path
- **WHEN** `dial propose ~/IdeaProjects/katipon/lib --prompt "run the tests" --json` is run and that directory is inside the registered repo `katipon`
- **THEN** the proposal's `repo` is `katipon`

### Requirement: propose refuses what cannot become a session
`dial propose` SHALL exit 1 with one reason line when the repo or the prompt is missing or the repo is not registered, and when the trimmed prompt is empty, is longer than `voiceTurnChars` characters, starts with `-`, or holds a control character other than a line feed or a tab.

#### Scenario: A missing argument
- **WHEN** `dial propose --prompt "x"` or `dial propose katipon` is run
- **THEN** stderr is `dial: propose needs <repo>` for the first and `dial: propose needs --prompt <text>` for the second, and the exit code is 1

#### Scenario: A repo that is not registered
- **WHEN** `dial propose nowhere --prompt "x"` is run
- **THEN** stderr is `dial: nowhere is not a registered repo` and the exit code is 1

#### Scenario: A prompt that is blank or too long
- **WHEN** the prompt is `"   "`, or holds 2001 characters while `voiceTurnChars` is 2000
- **THEN** stderr is `dial: prompt is empty` for the first and `dial: prompt longer than 2000 characters` for the second

#### Scenario: A prompt that could be read as an option
- **WHEN** `dial propose katipon --prompt=--dangerously-skip-permissions` is run
- **THEN** stderr is `dial: prompt cannot start with -` and the exit code is 1

#### Scenario: A control character
- **WHEN** the prompt holds an escape character (U+001B) or a carriage return
- **THEN** stderr is `dial: prompt holds a control character`; a prompt holding a line feed and a tab is accepted

### Requirement: propose starts nothing and writes nothing
`dial propose` SHALL run no program, write no file and not create the home. Its only effect is what it prints.

#### Scenario: No session is started
- **WHEN** `dial propose katipon --prompt "/interlock:ship add-parser"` succeeds with a recording `claude` on `PATH`
- **THEN** `claude` was not run and every file under the home and the vault is byte-identical to before

#### Scenario: The home is not created
- **WHEN** `dial propose katipon --prompt "x"` is run and the home does not exist
- **THEN** the exit code is 1 with `dial: katipon is not a registered repo`, and the home still does not exist

### Requirement: A proposal from the voice session becomes the one open proposal
When the voice session's stream yields a proposal, `dial voice` SHALL check its repo against the registry as it is at that moment and its prompt as `dial propose` does. One that passes SHALL become the open proposal with a new id of 8 lowercase hexadecimal characters and SHALL be sent as a `proposal` event `{ "id", "repo", "prompt", "status": "pending" }`. One that fails SHALL be sent as one `error` event `proposal refused: <reason>`. At most one proposal SHALL be open.

#### Scenario: A proposal is shown
- **WHEN** the stream yields the proposal `{ "repo": "katipon", "prompt": "/interlock:ship add-parser" }`
- **THEN** every page receives `proposal` with those two values, an 8-character id and the status `pending`

#### Scenario: The repo was unregistered meanwhile
- **WHEN** the stream yields a proposal for `katipon` after `katipon` was unregistered
- **THEN** the pages receive `error` with the message `proposal refused: katipon is not a registered repo`, and no proposal is open

#### Scenario: A newer proposal replaces the open one
- **WHEN** a second proposal arrives while the first is `pending`
- **THEN** the pages receive `proposal` for the first with the status `replaced`, then `proposal` for the second with the status `pending` and another id

### Requirement: Dial reads an open proposal aloud in its own words
When the turn in which a proposal arrived ends without being stopped, `dial voice` SHALL send the `notice` `Proposal for <repo>: <prompt>` and, when replies are spoken, SHALL speak it after that turn's last sentence, cut into sentences as a reply is, followed by `Say confirm or cancel.`. When every one of those sentences has been spoken and none was stopped, the proposal's status SHALL become `read` and its `proposal` event SHALL be sent again. In every other case the status stays `pending`.

#### Scenario: The reading follows the reply
- **WHEN** the session replies `I have drafted that.`, a proposal for `katipon` with the prompt `/interlock:ship add-parser` is open, and the turn ends
- **THEN** the pages receive `notice` with the text `Proposal for katipon: /interlock:ship add-parser`, `say` speaks the reply, then that text, then `Say confirm or cancel.`, and after the last `say` process has exited the pages receive `proposal` with the status `read`

#### Scenario: A prompt of several sentences
- **WHEN** the open proposal's prompt is `Fix the parser. Then run the tests.`
- **THEN** `say` speaks `Proposal for katipon: Fix the parser.`, `Then run the tests.` and `Say confirm or cancel.` in that order, and the status becomes `read` only after the third

#### Scenario: The words are Dial's, not the session's
- **WHEN** the session's reply says a proposal is for `dial` while the open proposal is for `katipon`
- **THEN** the reading names `katipon` and the prompt as the open proposal holds them

#### Scenario: Replies are not spoken
- **WHEN** `say` is not on `PATH`, or went quiet after a failure, and the turn ends with a proposal open
- **THEN** the `notice` is sent, no `say` process is started, and the status stays `pending`

#### Scenario: The reading is cut short
- **WHEN** `POST /interrupt` or a new turn arrives while the proposal is being read
- **THEN** speech stops and the status stays `pending`

#### Scenario: The turn was stopped
- **WHEN** the turn in which the proposal arrived is interrupted or stopped after `voiceTurnSeconds`
- **THEN** nothing is read aloud and the status stays `pending`

### Requirement: Confirm starts the open proposal
`POST /confirm` SHALL take `{ "id": <id>, "spoken": <boolean> }`. It SHALL be answered 409 with `no such proposal` when the id is not the open proposal's, and 409 with `the proposal was not read aloud; confirm it on screen` when `spoken` is true and the status is not `read`. Otherwise, when the session bounds allow it, the reply SHALL be 202 with `{ "ok": true }`, the status SHALL become `starting`, and the session SHALL be started. A body of another shape SHALL be answered 400.

#### Scenario: A click confirms a pending proposal
- **WHEN** `POST /confirm` carries the open proposal's id and `"spoken": false` while its status is `pending`
- **THEN** the reply is 202, the pages receive `proposal` with the status `starting`, and `claude` is started once

#### Scenario: A spoken confirmation before the reading
- **WHEN** `POST /confirm` carries `"spoken": true` while the status is `pending`
- **THEN** the reply is 409 with `the proposal was not read aloud; confirm it on screen`, and `claude` is not started

#### Scenario: A spoken confirmation after the reading
- **WHEN** `POST /confirm` carries `"spoken": true` while the status is `read`
- **THEN** the reply is 202 and the session is started

#### Scenario: A proposal that is not open
- **WHEN** `POST /confirm` carries an unknown id, or the id of a proposal that was cancelled, replaced, expired or already confirmed
- **THEN** the reply is 409 with `no such proposal` and `claude` is not started

#### Scenario: A second confirmation while the first is starting
- **WHEN** `POST /confirm` arrives twice for the same proposal before `claude --bg` has exited
- **THEN** the first is answered 202, the second 409 with `no such proposal`, and `claude` is started once

#### Scenario: A body that is not a confirmation
- **WHEN** `POST /confirm` carries `{ "id": 5 }`, `{ "id": "ab12cd34" }` with no `spoken`, or `[]`
- **THEN** the reply is 400 and nothing is started

### Requirement: Cancel and time close a proposal
`POST /cancel` with `{ "id": <id> }` SHALL set the open proposal's status to `cancelled` and be answered 200 with `{ "ok": true }`; another id SHALL be answered 409 with `no such proposal`. A proposal that is neither confirmed nor cancelled `voiceProposalSeconds` after it became open SHALL get the status `expired`. Every status change SHALL be sent as a `proposal` event. A proposal is open only while its status is `pending` or `read`.

#### Scenario: Cancel
- **WHEN** `POST /cancel` carries the open proposal's id
- **THEN** the reply is 200, the pages receive `proposal` with the status `cancelled`, and a later `POST /confirm` for it is answered 409

#### Scenario: A proposal expires
- **WHEN** a proposal has been open for 120 seconds and `voiceProposalSeconds` is 120
- **THEN** the pages receive `proposal` with the status `expired` and no proposal is open

#### Scenario: Reading does not extend the time
- **WHEN** a proposal became open 100 seconds ago and was read aloud 10 seconds ago
- **THEN** it expires 20 seconds later

#### Scenario: The cap is read from the registry
- **WHEN** the registry's `limits` holds `voiceProposalSeconds: 30`
- **THEN** a proposal expires 30 seconds after it became open

### Requirement: The number of running sessions is bounded
A confirmation SHALL be answered 409, and the proposal SHALL stay open, when the session list last read holds `voiceSessions` or more sessions whose state is `working` or `blocked`, with the reason `<n> sessions are already running`, or holds one such session in the proposal's repo, with the reason `a session is already running in <repo>`.

#### Scenario: The cap is reached
- **WHEN** three listed sessions are `working` or `blocked`, `voiceSessions` is 3, and a proposal for a fourth repo is confirmed
- **THEN** the reply is 409 with `3 sessions are already running`, the proposal keeps its status, and `claude` is not started

#### Scenario: One running session per repo
- **WHEN** a listed session in `katipon` is `blocked` and a proposal for `katipon` is confirmed
- **THEN** the reply is 409 with `a session is already running in katipon`

#### Scenario: Finished sessions do not count
- **WHEN** the only listed session in `katipon` is `done`, `failed` or `stopped`
- **THEN** a proposal for `katipon` can be confirmed

### Requirement: A confirmed proposal starts one claude background session
To start a session, `dial voice` SHALL run `claude` once with exactly the arguments `--bg`, `--name`, the session name and the prompt, in the repo's registered path, with the environment `dial voice` itself has. The session name SHALL be `dial: ` followed by the prompt with every run of whitespace as one space, cut to 60 characters. When that process exits 0 the proposal's status SHALL become `started`, the notice `Started in <repo>.` SHALL be raised, and the session list SHALL be read at once.

#### Scenario: The arguments
- **WHEN** the proposal for `katipon` with the prompt `/interlock:ship add-parser` is confirmed
- **THEN** `claude` is run in the registered path of `katipon` with the four arguments `--bg`, `--name`, `dial: /interlock:ship add-parser` and `/interlock:ship add-parser`, and nothing else

#### Scenario: A long prompt of several lines
- **WHEN** the prompt is 300 characters over three lines
- **THEN** the fourth argument is the prompt unchanged, and the name is `dial: ` followed by the first 60 characters of the prompt with its line breaks as single spaces

#### Scenario: Nothing of the owner's setup is overridden
- **WHEN** the arguments of a start are read
- **THEN** none of them is `--permission-mode`, `--dangerously-skip-permissions`, `--model`, `--settings`, `--worktree`, `--safe-mode`, `--restricted` or `-p`

#### Scenario: A session that started
- **WHEN** `claude --bg` exits 0
- **THEN** the pages receive `proposal` with the status `started` and a `notice` with the text `Started in katipon.`, and `claude agents --json --all` is run without waiting for the next interval

### Requirement: A start that fails is reported in claude's own words
When the `claude --bg` process exits non-zero, cannot be started, or has not exited after `subprocessTimeoutSeconds`, the proposal's status SHALL become `failed` and its `proposal` event SHALL carry a `reason` that names the exit code and the first non-blank line the process wrote, or the time waited, or why it could not be started. The reason SHALL be shown and not spoken, and the start SHALL NOT be tried again.

#### Scenario: A repo Claude Code does not trust
- **WHEN** `claude --bg` writes `Workspace not trusted. Run claude in /repos/katipon once and accept the trust prompt, then retry.` to stderr and exits 1
- **THEN** the pages receive `proposal` with the status `failed` and the reason `claude --bg failed (exit 1): Workspace not trusted. Run claude in /repos/katipon once and accept the trust prompt, then retry.`, and no `say` process is started for it

#### Scenario: The line is on stdout
- **WHEN** `claude --bg` exits 1 after writing nothing to stderr and `Workspace not trusted.` to stdout
- **THEN** the reason is `claude --bg failed (exit 1): Workspace not trusted.`; when it wrote nothing at all the reason is `claude --bg failed (exit 1)`

#### Scenario: claude cannot be started
- **WHEN** starting `claude` fails with `ENOENT`
- **THEN** the reason starts with `claude could not be started (ENOENT: `

#### Scenario: A start that hangs
- **WHEN** `claude --bg` has not exited after 10 seconds and `subprocessTimeoutSeconds` is 10
- **THEN** the process is ended and the reason is `claude --bg did not answer in 10 seconds`

#### Scenario: No second try
- **WHEN** a start failed
- **THEN** `claude --bg` is not run again until another proposal is confirmed

### Requirement: The session list holds the sessions Dial named
The session list SHALL be made from the JSON array `claude agents --json --all` prints: every entry whose `kind` is `background`, whose `id` is 1 to 64 characters of letters, digits, `_` and `-`, and whose `name` starts with `dial: `. A listed session SHALL carry `id`, `repo`, `cwd`, `state`, `waitingFor`, `startedAt`, `prompt` and `sessionId`. The list SHALL be ordered newest first and cut to `voiceSessionRows`.

#### Scenario: One listed session
- **WHEN** an entry is `{ "id": "c7b0ada6", "cwd": "/repos/katipon", "kind": "background", "startedAt": 1794900099451, "sessionId": "c7b0ada6-b039-4dca-8847-cfb263166f6b", "name": "dial: /interlock:ship add-parser", "state": "blocked", "waitingFor": "permission prompt" }` and `/repos/katipon` is the registered path of `katipon`
- **THEN** the listed session has the id `c7b0ada6`, the repo `katipon`, the state `blocked`, the `waitingFor` `permission prompt`, the `startedAt` `2026-11-17T07:21:39.451Z`, the prompt `/interlock:ship add-parser` and that `sessionId`

#### Scenario: A session working in a worktree of the repo
- **WHEN** an entry's `cwd` is `/repos/katipon/.claude/worktrees/add-parser`
- **THEN** its `repo` is `katipon`; an entry whose `cwd` is inside no registered repo has the `repo` null

#### Scenario: Sessions Dial did not name are left out
- **WHEN** the array holds a background session named `integration apps setup guide`, an entry with no `name`, and an entry whose `kind` is `interactive`
- **THEN** none of the three is listed

#### Scenario: Fields claude does not send
- **WHEN** an entry has no `state`, no `waitingFor`, no `sessionId` and a `startedAt` that is not a number
- **THEN** its `state` is `unknown`, and its `waitingFor`, `sessionId` and `startedAt` are null

#### Scenario: A state Dial does not know
- **WHEN** an entry's `state` is `paused`
- **THEN** the listed session's `state` is `paused`

#### Scenario: An id that is not safe to pass on
- **WHEN** an entry's `id` is `a b`, `../x` or an empty string
- **THEN** it is not listed

#### Scenario: Newest first, and capped
- **WHEN** fifteen sessions Dial named exist and `voiceSessionRows` is 12
- **THEN** the list holds the twelve with the latest `startedAt`, latest first, a null `startedAt` last

#### Scenario: A secret in a prompt
- **WHEN** an entry's name is `dial: deploy with token ghp_0123456789abcdefghijABCDEFGHIJ012345`
- **THEN** the listed `prompt` holds no `ghp_` token

### Requirement: The list is read while a page is connected and sent when it changes
While at least one page is connected, `dial voice` SHALL read the session list when the first page connects, then every `voiceSessionPollSeconds`, and at once after a start or a stop. It SHALL never run two reads at the same time. It SHALL send a `sessions` event `{ "sessions": <list>, "pollSeconds": <n> }` whenever a read gives a list that differs from the one last sent. With no page connected it SHALL not read.

#### Scenario: The first page
- **WHEN** the first page connects
- **THEN** `claude agents --json --all` is run once, and again 5 seconds later while the page stays connected and `voiceSessionPollSeconds` is 5

#### Scenario: Nothing changed
- **WHEN** two reads in a row give the same list
- **THEN** no `sessions` event is sent for the second

#### Scenario: A state changed
- **WHEN** a session's `state` goes from `working` to `done` between two reads
- **THEN** every page receives one `sessions` event holding the whole list and `"pollSeconds": 5`

#### Scenario: A read that is still running
- **WHEN** the interval comes round while the read before it has not returned
- **THEN** no second `claude agents` process is started

#### Scenario: No page is connected
- **WHEN** the last page has disconnected
- **THEN** `claude agents` is not run until a page connects again

#### Scenario: The voice session was refused
- **WHEN** the state is `refused` and a page is connected
- **THEN** the list is still read and sent, and the Log, Stop and Terminal routes still answer

### Requirement: A page that connects is sent the list and the open proposal
A page that connects SHALL receive, after `hello` and `state`, one `sessions` event with the list last read (an empty list when none was read yet), and then the `proposal` event of the open proposal when there is one.

#### Scenario: A late page
- **WHEN** a page connects while two sessions are listed and a proposal has the status `read`
- **THEN** its events are `hello`, `state`, `sessions` with the two sessions, and `proposal` with the status `read`, in that order

#### Scenario: Nothing was read yet
- **WHEN** the first page connects
- **THEN** its third event is `sessions` with an empty list, and a second `sessions` event follows when the first read finds sessions

### Requirement: A list that cannot be read is reported once
When `claude agents --json --all` exits non-zero, does not exit within `subprocessTimeoutSeconds`, cannot be started, or prints something that is not a JSON array, `dial voice` SHALL keep the list it has and send one `error` event `could not list sessions: <reason>`. It SHALL send no further such event until a read has succeeded again.

#### Scenario: The command fails
- **WHEN** `claude agents --json --all` writes `error: unknown option '--json'` to stderr and exits 1
- **THEN** the pages receive `error` with `could not list sessions: claude agents failed (exit 1): error: unknown option '--json'`, and the list is unchanged

#### Scenario: Output that is not a list
- **WHEN** it exits 0 after printing `{}` or text that is not JSON
- **THEN** the reason is `claude agents did not print a session list`

#### Scenario: The same failure again
- **WHEN** the next three reads fail the same way
- **THEN** no further `error` event is sent; after one read succeeds, the next failure is reported again

### Requirement: A session that needs the owner or has ended is announced
The first successful read of a run SHALL announce nothing. After every later successful read, `dial voice` SHALL raise one notice for each listed session whose state is `blocked`, `done` or `failed` and was not that state in the read before. The notice SHALL name the session's repo, or say `A Dial session` when it has none, and say that it needs the owner, has finished its turn, or failed.

#### Scenario: A permission prompt
- **WHEN** a session in `katipon` goes from `working` to `blocked` with the `waitingFor` `permission prompt`
- **THEN** the notice `The session in katipon needs you: permission prompt.` is raised once

#### Scenario: Blocked with no reason given
- **WHEN** a session in `katipon` becomes `blocked` and its `waitingFor` is null
- **THEN** the notice is `The session in katipon needs you.`

#### Scenario: A session with no repo
- **WHEN** a session whose `repo` is null becomes `done`
- **THEN** the notice is `A Dial session has finished its turn.`

#### Scenario: A finished turn
- **WHEN** a session in `dial` goes from `working` to `done`
- **THEN** the notice `The session in dial has finished its turn.` is raised

#### Scenario: Sessions that were already waiting
- **WHEN** `dial voice` starts while two sessions Dial named are `blocked`
- **THEN** the first read raises no notice, and the reads after it raise none while those states stay the same

#### Scenario: A session that fails before it was ever listed
- **WHEN** a session appears for the first time in a later read with the state `failed`
- **THEN** the notice `The session in <repo> failed.` is raised

#### Scenario: Working and stopped are not announced
- **WHEN** a session goes from `blocked` to `working`, or from `working` to `stopped`
- **THEN** no notice is raised

### Requirement: A notice is shown, and spoken only when no turn is running
A notice SHALL be sent to every page as a `notice` event `{ "text": <text> }`. A notice raised while no turn is running SHALL also be spoken as a sentence is, in order, when replies are spoken. A notice raised while a turn is running SHALL be shown and not spoken. The reading of a proposal is spoken as its own requirement says. An `error` event is never spoken.

#### Scenario: A notice while Dial is idle
- **WHEN** the notice `The session in dial has finished its turn.` is raised while the state is `idle`
- **THEN** the pages receive `notice` with that text, `say` speaks it, and the state is `speaking` and then `idle`

#### Scenario: A notice during a turn
- **WHEN** a notice is raised while the state is `thinking`
- **THEN** the pages receive the `notice` event and no `say` process is started for it

#### Scenario: A machine without say
- **WHEN** a notice is raised and `say` is not on `PATH`
- **THEN** the `notice` event is sent and the state does not change

### Requirement: The page can read a session's screen as text
`GET /log` SHALL carry the launch token in the `t` query parameter, as `GET /events` does, and a listed session's id in `id`. It SHALL run `claude logs <id>` and answer 200 with `{ "ok": true, "id": <id>, "lines": <list> }`, the lines being that output with terminal escape sequences and control characters removed, each line redacted and cut to 400 characters, trailing blank lines dropped, and only the last `voiceLogLines` kept. The lines SHALL be sent to no one but the asking page.

#### Scenario: Colour and cursor codes are removed
- **WHEN** `claude logs c7b0ada6` prints `\u001b[1m\u001b[32m● Running tests\u001b[0m\r\n\u001b]0;title\u0007  12 passed`
- **THEN** the reply's `lines` are `● Running tests` and `  12 passed`

#### Scenario: Only the last lines
- **WHEN** the output has 500 lines and `voiceLogLines` is 200
- **THEN** `lines` holds the last 200

#### Scenario: A secret on the screen
- **WHEN** a line of the output is `export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ012345`
- **THEN** no line of the reply holds that token

#### Scenario: A session that is not listed
- **WHEN** `GET /log` carries an `id` that is not in the list, or no `id`
- **THEN** the reply is 404 with `no such session` and `claude` is not run

#### Scenario: A request without the token
- **WHEN** `GET /log?id=c7b0ada6` arrives with no `t` parameter
- **THEN** the reply is 403 with `missing or wrong token`

#### Scenario: claude logs fails
- **WHEN** `claude logs c7b0ada6` writes `No such session` to stderr and exits 1
- **THEN** the reply is 502 with the reason `claude logs failed (exit 1): No such session`

#### Scenario: The screen stays out of the conversation
- **WHEN** a log was read
- **THEN** nothing of it is written to the voice session, sent in an event or passed to `say`

### Requirement: Stop ends a session through claude
`POST /stop` with `{ "id": <id> }` SHALL run `claude stop <id>` for a listed session and be answered 200 with `{ "ok": true }`, after which the session list SHALL be read at once. An id that is not listed SHALL be answered 409 with `no such session`. A `claude stop` that fails SHALL be answered 502 with `claude stop failed (exit <code>): <its first non-blank stderr line>`.

#### Scenario: A session is stopped
- **WHEN** `POST /stop` carries the id of a listed session
- **THEN** `claude` is run with the arguments `stop` and that id, the reply is 200, and `claude agents --json --all` is run without waiting for the next interval

#### Scenario: An id that is not listed
- **WHEN** `POST /stop` carries `{ "id": "ffffffff" }` and no such session is listed
- **THEN** the reply is 409 with `no such session` and `claude` is not run

#### Scenario: Stop fails
- **WHEN** `claude stop` writes `already stopped` to stderr and exits 1
- **THEN** the reply is 502 with `claude stop failed (exit 1): already stopped`

### Requirement: The Terminal control opens a session in a terminal window
`POST /attach` with `{ "id": <id> }` SHALL, on macOS and for a listed session, write the file `dial-attach-<id>.command` into the temporary directory with mode 0700, holding the two lines `#!/bin/sh` and `exec '<absolute path of claude>' attach <id>`, run `open` with that file, and answer 200. On another platform it SHALL answer 409 with `run this in a terminal: claude attach <id>`. An id that is not listed SHALL be answered 409 with `no such session`.

#### Scenario: The file and the opener
- **WHEN** `POST /attach` carries `c7b0ada6` on macOS and `claude` was found at `/opt/homebrew/bin/claude`
- **THEN** the file holds `#!/bin/sh` and `exec '/opt/homebrew/bin/claude' attach c7b0ada6`, its mode is 0700, and `open` is run once with the file's path as its only argument

#### Scenario: A path with a quote
- **WHEN** `claude` was found at `/Users/o'brien/bin/claude`
- **THEN** the second line is `exec '/Users/o'\''brien/bin/claude' attach c7b0ada6`

#### Scenario: Another platform
- **WHEN** `POST /attach` carries `c7b0ada6` on Linux
- **THEN** the reply is 409 with `run this in a terminal: claude attach c7b0ada6`, no file is written and no opener is run

#### Scenario: The opener fails
- **WHEN** `open` exits non-zero after writing a line to stderr
- **THEN** the reply is 502 with `could not open a terminal: <that line>`

### Requirement: Every claude call is bounded and started sessions are left running
Each `claude --bg`, `claude agents`, `claude logs` and `claude stop` process SHALL be ended when it has not exited after `subprocessTimeoutSeconds`, in the way the voice session's process is ended. When `dial voice` ends it SHALL end every such process still running, wait for it, stop reading the list and drop the open proposal. It SHALL NOT stop a session it started.

#### Scenario: A read that hangs
- **WHEN** `claude agents --json --all` has not exited after 10 seconds
- **THEN** it is sent SIGTERM, then SIGKILL 2 seconds later when it is still running, and the read counts as failed with `claude agents did not answer in 10 seconds`

#### Scenario: The command ends during a read
- **WHEN** `dial voice` is interrupted while a `claude agents` process is running
- **THEN** that process is ended and `dial voice` exits only after it has exited

#### Scenario: Sessions outlive the window
- **WHEN** `dial voice` ends while two sessions it started are `working`
- **THEN** `claude stop` is not run, and `claude agents --json --all` run afterwards still lists both

### Requirement: The page shows an open proposal with Confirm and Cancel
The page SHALL show the open proposal's repo and prompt with a Confirm control that posts `/confirm` with `"spoken": false` and a Cancel control that posts `/cancel`. It SHALL take the card away when the status becomes `started`, `cancelled`, `expired` or `replaced`, and SHALL show the reason when the status is `failed` or when `/confirm` is refused.

#### Scenario: Confirm by a click
- **WHEN** the owner clicks Confirm on a proposal with the id `ab12cd34`
- **THEN** the page posts `{ "id": "ab12cd34", "spoken": false }` to `/confirm` with the token header

#### Scenario: A refused confirmation
- **WHEN** `/confirm` answers 409 with `a session is already running in katipon`
- **THEN** the page shows that reason and keeps the card

#### Scenario: A start that failed
- **WHEN** a `proposal` event carries the status `failed` and a reason
- **THEN** the page shows the reason and offers no Confirm control for that proposal

#### Scenario: A proposal that closed
- **WHEN** a `proposal` event carries the status `expired`
- **THEN** the card is no longer shown

### Requirement: The page lists the sessions with their controls
For every session of the last `sessions` event the page SHALL show its repo, its state with `waitingFor` when there is one, its start time and its prompt, the command `claude attach <id>`, and three controls: Log, Stop, which posts `/stop`, and Terminal, which posts `/attach`. While a log is open the page SHALL ask `GET /log` for it again every `pollSeconds`, and SHALL stop asking when the log is closed or the session is no longer listed.

#### Scenario: A blocked session
- **WHEN** a `sessions` event holds a session in `katipon` with the state `blocked` and the `waitingFor` `permission prompt`
- **THEN** the page shows `katipon`, `blocked` and `permission prompt` for it, and the command `claude attach c7b0ada6`

#### Scenario: The log is refreshed while open
- **WHEN** the owner opens the log of a session and `pollSeconds` is 5
- **THEN** the page asks `GET /log` with the token and the id at once and every 5 seconds, and shows the lines it gets

#### Scenario: The log is closed
- **WHEN** the owner closes the log, or a `sessions` event no longer holds that session
- **THEN** the page stops asking for it

#### Scenario: A control is refused
- **WHEN** `/stop` or `/attach` answers 409 or 502 with a reason
- **THEN** the page shows the reason

### Requirement: The page shows session strings as text
The page SHALL put every string of a `proposal`, `sessions` or `notice` event and every line of a log into the document as text and never as markup, under the rule the `voice` capability sets for its other events.

#### Scenario: A prompt that looks like markup
- **WHEN** a `proposal` event carries the prompt `<img src=x onerror=alert(1)>`
- **THEN** the page shows those characters and creates no element from them

#### Scenario: A log line that looks like markup
- **WHEN** a log line is `<script>alert(1)</script>`
- **THEN** the page shows those characters as text

### Requirement: sessions lists Dial's sessions in a terminal
`dial sessions` SHALL run `claude agents --json --all` once, bounded by `subprocessTimeoutSeconds`, make the session list as `dial voice` does, and exit 0. Without `--json` it SHALL print one line per session — `<id>  <repo or ->  <state>`, ` (<waitingFor>)` when there is one, then `  <startedAt>  <prompt>` — or `no dial sessions` when the list is empty. With `--json` it SHALL print `{ "sessions": <list> }`. It SHALL NOT create the home.

#### Scenario: Two sessions as text
- **WHEN** `dial sessions` is run while a `blocked` session in `katipon` and a `done` session in `dial` are listed
- **THEN** stdout holds the two lines `c7b0ada6  katipon  blocked (permission prompt)  2026-11-17T07:21:39.451Z  /interlock:ship add-parser` and `0f3e9a11  dial  done  2026-11-17T06:02:10.000Z  /interlock:spec add voice capture`, the later-started one first

#### Scenario: The JSON form
- **WHEN** `dial sessions --json` is run
- **THEN** stdout parses to an object with the one key `sessions`, each element holding `id`, `repo`, `cwd`, `state`, `waitingFor`, `startedAt`, `prompt` and `sessionId`

#### Scenario: No sessions
- **WHEN** `claude agents --json --all` prints `[]`, or only sessions Dial did not name
- **THEN** stdout is `no dial sessions` and the exit code is 0; with `--json` it is `{ "sessions": [] }`

#### Scenario: claude is missing
- **WHEN** `dial sessions` is run with a `PATH` that holds no executable `claude`
- **THEN** stderr is `dial: claude is not on PATH` and the exit code is 1

#### Scenario: claude agents fails
- **WHEN** `claude agents --json --all` exits 1 after writing `error: unknown command 'agents'` to stderr
- **THEN** stderr is `dial: claude agents failed (exit 1): error: unknown command 'agents'` and the exit code is 1

#### Scenario: Output that is not a list
- **WHEN** `claude agents --json --all` exits 0 after printing text that is not a JSON array
- **THEN** stderr is `dial: claude agents did not print a session list` and the exit code is 1

#### Scenario: A positional is refused
- **WHEN** `dial sessions katipon` is run
- **THEN** stderr is `dial: unexpected argument: katipon` and the exit code is 1
