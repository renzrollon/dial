# Design

## Context

See `proposal.md` for the motivation. This change is written on top of `add-voice-ui`, which is specced and not yet built. Section and file references to that change are to its `design.md`, `tasks.md` and delta specs. The constraints that shape the approach:

- Everything `add-voice-ui` fixed still holds: zero dependencies, only `bin/dial.mjs` touches the process, a failure is one `dial: <reason>` line, every applied cap is published, the page renders text only, and the listener's logic is testable without a socket.
- The voice session reads untrusted text (pull request titles, note lines) and can run only `dial` commands under `dontAsk` (`add-voice-ui` design §4). It must not gain the power to act.
- Claude Code 2.1.326 has background sessions: `claude --bg`, `claude agents --json`, `claude logs`, `claude stop`, `claude attach`. The feature is a research preview. `claude agents --json` is documented as the supported way to read session state from outside Claude Code.
- A background session is the owner's own session: their plugins, hooks, settings and permission mode apply, and Dial's hooks run in it as in any session in a registered repo (`hooks/hooks.json`; `lib/record.mjs:154-196`).
- None of the `claude --bg` behaviour was observed during the spec: no session was started. What is read from documentation is listed under Risks and checked by manual probes before implementation (`tasks.md` H0).

## Goals / Non-Goals

**Goals:**

- The owner can go from "what is next" to a running session by voice, and see what each session is doing.
- No session starts unless the owner saw or heard the exact repo and prompt and confirmed.
- The voice session keeps exactly the power it had: it reads and it drafts.
- Dial keeps no state of its own about sessions. Claude Code is the record.
- Every rule with a pass/fail core is a pure function tested without a process.

**Non-Goals:**

- A terminal in the page, or a live stream of a session's output.
- Answering a session's permission prompt or question from the page.
- Choosing how a session runs (permission mode, model, worktree isolation).
- Follow-up messages to a running session.

## Decisions

### 1. A second change on top of add-voice-ui (D1, D28)

`add-voice-ui` rests on probes nobody has run yet: the `claude -p` handshake, resume, and on-device recognition (its `tasks.md` H0.2 to H0.4). If recognition does not work on this machine, the orchestrator is moot. So the base ships first and this change follows.

- OpenSpec validates a `MODIFIED` delta against a spec that is not living yet, with a note that archive needs the base archived first. So this change can be reviewed now and archived after `add-voice-ui`.
- Extending `add-voice-ui` in place was rejected: one gate and one ship run over about twice the size, with the unproven base and the new parts landing together.
- This change is the answer to D7 of `add-voice-ui` (D28): a spoken command may start an action, through a proposal Dial reads back and the owner confirms. `add-voice-ui` itself stays read-only.

Cost of layering: two requirements of `add-voice-ui` are removed and added back under names that do not say "five", and several tests pinned by that change are pinned again (see `tasks.md`, known pins).

### 2. A session is a Claude Code background session (D2, D6, D10, D20)

`claude --bg --name <name> <prompt>`, run in the repo's registered path with the environment of `dial voice`.

- Why not a second `claude -p` child: it would die with `dial voice`, nobody could answer its permission prompts, and the permission protocol for a host that is not the SDK is undocumented.
- Why not Terminal or iTerm through `osascript`: it needs the Automation grant and gives Dial nothing to read back.
- Why not a pseudo-terminal: `node-pty` and a terminal emulator are dependencies.
- Dial passes no permission mode, model, settings or worktree flag (D6). The documentation says a `--bg` session "starts the way a new `claude` session in that directory would". The session is the owner's, configured where the owner configures Claude Code.
- A session keeps running when `dial voice` ends (D10). A ship run takes longer than a conversation.
- A repo Claude Code does not trust yet makes `claude --bg` exit non-zero with its own message. Dial shows that line and does nothing else (D20).

### 3. The voice session proposes; Dial starts (D3, D11, D13, D14)

```
owner ── "ship add-parser in katipon" ──▶ voice session
                                             │ dial propose katipon --prompt "/interlock:ship add-parser" --json
                                             ▼ (prints JSON; starts nothing)
            stream: tool_use … tool_result ──▶ reducer ──▶ proposal { repo, prompt }
                                                              │ server checks repo and prompt again
                                                              ▼
                                    open proposal ──▶ page card + Dial reads it aloud
                                                              │ POST /confirm (click, or the word after the reading)
                                                              ▼
                                    claude --bg --name "dial: …" "<prompt>"     cwd = repo path
```

- The voice session gets two more commands, `dial propose` and `dial sessions`. `dial propose` only checks and prints. The session still cannot start anything, so a pull request title that says "ship this" can at most put a card on the screen.
- The proposal travels in the session's own stream (D11): the reducer remembers the id of a `Bash` `tool_use` whose command begins with `dial propose `, and reads the `tool_result` that answers it. No file, no socket and no token reach the session. The server takes the repo name and the prompt from the result and resolves the path from its own registry read, so the result is a transport for two strings and nothing else.
  - A spool directory the server watches was rejected: files to clean up, a write under `voice/` that `add-voice-ui` says holds no file Dial wrote, and a timing rule.
  - Posting from `dial propose` to the server was rejected: the launch token would have to reach the session's environment.
- A proposal is one repo and one free-text prompt (D13). A slash command is a prompt that starts with `/`. There is no list of allowed skills: a free prompt is allowed anyway, so a list would add no safety.
- The voice prompt says which `suggested` values may be proposed as printed: those that start with `/` (D14). `review and merge`, `wait` and `openspec archive <change>` are the owner's to do (`lib/facts.mjs:87-116`).
- `dial propose` refuses a prompt that starts with `-`, so it can never be read as an option of `claude`, and one that holds a control character.

### 4. Dial owns the words of a proposal (D5, D15, D21, D27)

The voice session could say "this ships add-parser" while its proposal holds another prompt. So the server, not the session, reads the proposal: `Proposal for <repo>: <prompt>`, then `Say confirm or cancel.`, after the turn's last sentence.

- A spoken confirmation is accepted only when the status is `read`: every sentence of that reading was spoken and none was stopped. Before that, and on a machine without `say`, only the Confirm control works. The server enforces this; the page only reports whether the confirmation was spoken.
- The page matches the whole transcript against `confirm` or `cancel` (D27). `yes`, or `confirm` inside a sentence, is an ordinary turn. The voice session never sees a confirmation and cannot give one.
- There is no length above which a proposal is not read (D21). A long prompt takes long to read; Escape stops the reading and the click still works. A threshold would be one more published cap for a rare case.
- Dial also says that a session started, and announces a session that became `blocked`, `done` or `failed` (D15). A notice raised during a turn is shown and not spoken, so it never cuts into a reply. Errors stay shown and unspoken, as `add-voice-ui` D28 decided.
- The first list read of a run announces nothing, so sessions that were already waiting are not announced at every start.

### 5. Sessions are found by name, not by a state file (D9, D26)

Dial names each session `dial: ` followed by the start of its prompt, and lists the background sessions whose name has that prefix. The list survives a restart of `dial voice`, and `dial sessions` shows the same list in a terminal, with no file under the home.

- Listing every session in a registered repo was rejected: this machine has seven stale `blocked` sessions Dial did not start, and they would be announced as needing the owner.
- The output of `claude --bg` is not parsed for the id (D26). The exit code says whether it started, and the list read that follows shows the session. The documentation shows the `backgrounded · <id>` line and promises nothing about it.
- A session's `repo` is the registered repo whose path equals or contains its `cwd`, the longest match. A session that moved into a worktree under the repo still shows its repo.
- `state` and `waitingFor` are passed through as text. An unknown value is shown as it is.

### 6. Reading the list (D12, D17)

While a page is connected, the server runs `claude agents --json --all` every `voiceSessionPollSeconds`, and at once after a start or a stop. It never runs two reads at a time, and it reads nothing when no page is connected. The whole list is sent when it differs from the one last sent.

- A failed read keeps the last list and is reported once, until a read succeeds again.
- Bounds: `voiceSessions` sessions in `working` or `blocked` at once, and one per repo (D12). Vault writes have no lock (`lib/vault.mjs:244-285`), and two sessions editing one checkout would collide when the owner's Claude Code does not isolate them.
- Five new caps (D17). `voiceSessionPollSeconds` also reaches the page, inside the `sessions` event (D25), so `hello` is unchanged.

### 7. The screen as text, and a real terminal one click away (D8, D18, D23, D24)

`claude logs <id>` prints a snapshot of the session's screen. The server removes terminal escape sequences and control characters, redacts each line, keeps the last `voiceLogLines`, and answers the asking page. The page shows the lines as text and asks again every `pollSeconds` while the log is open.

- The screen never reaches the voice session, an event or `say` (D23). It can hold anything the owner's terminal shows.
- A permission prompt is answered in a terminal (D18). The Terminal control writes a two-line `.command` file and runs `open` on it, which starts the terminal application with `claude attach <id>`. No Automation grant is needed. The page always shows the command too.
- The file goes to the temporary directory, not the home (D24): `add-voice-ui` says Dial writes no file into `voice/`. It holds the absolute path of `claude`, because a terminal started this way may not have the owner's interactive `PATH`.
- Relaying prompts into the page was rejected for this change: it needs hooks injected into the owner's session through `--settings`.

### 8. One cap bounds every short claude call (D22)

`claude --bg`, `claude agents`, `claude logs` and `claude stop` are bounded by `subprocessTimeoutSeconds`, whose description gains `claude session`. A sixth new cap for the same kind of bound was rejected. The voice session's own process is bounded by `voiceTurnSeconds`, as before.

### 9. What a session leaves in the vault (D19)

Nothing new. A started session runs Dial's hooks like any session in that repo: the brief at start, a sync after a close event, and `dial record` at the end. Its narrative entry is not marked as started by voice. An origin marker would need a new environment variable read by the hooks.

### 10. Not in this change (D16)

A follow-up message to a session. `claude --resume <id> --bg` starts a copy when the session is still running, and the only documented in-place reply is the agent view's own input.

### 11. Modules and seams

| Module | Holds | Pure |
|---|---|---|
| `lib/propose.mjs` | the prompt check, the proposal check, the session name, the text form | yes |
| `lib/voice/sessions.mjs` | the list mapping, the announcements, the screen cleaning, the attach script, the reasons; and the manager that runs the four `claude` calls | functions yes; manager takes `spawn`, `timers`, `writeFile` |
| `lib/voice/proposals.mjs` | the one open proposal and its statuses | yes, takes `timers` |
| `lib/spawn.mjs` | adds `runChild`, a bounded one-shot run on `spawnChild` | no |
| `lib/voice/engine.mjs` | seven commands; the reducer pairs `dial propose` with its result | reducer yes |
| `lib/voice/speech.mjs` | `say` takes a completion callback | takes `spawn` |
| `lib/voice/guard.mjs` | five more routes | yes |
| `lib/voice/server.mjs` | joins proposals, sessions and the speaker; five routes; three events | takes its parts |
| `lib/voice/page-logic.mjs`, `page.js`, `page.html`, `page.css` | the card, the list, the log panel, the confirm words | `page-logic.mjs` takes `get` and `timers` |
| `lib/voice/prompt.md` | the two new commands and the proposing rules | — |

`bin/dial.mjs` gains two usage entries, two option-table entries, the `propose` and `sessions` cases, and passes the registry reader, the path of `claude`, the temporary directory and a file writer into `createVoice`.

#### Interfaces

The failing tests are written before the modules, so the exports are fixed here. A module may hold more; these names and shapes are what the tests import. Names from `add-voice-ui` design §13 keep their meaning unless a line here changes them.

```js
// lib/propose.mjs — pure
export const SESSION_PREFIX = 'dial: '
export const SESSION_NAME_CHARS = 60
export function checkPrompt(text, { maxChars })     // → { ok: true, prompt } | { ok: false, reason }
export function checkProposal(registry, { repo, prompt, cwd }, { maxChars })
//   → { ok: true, proposal: { repo, prompt }, path } | { ok: false, reason }
//   repo is matched by name, then, when cwd is given, as a path equal to or inside a registered repo
export function sessionName(prompt)                 // → 'dial: ' + the prompt on one line, cut to 60 characters
export function formatProposal({ repo, prompt })    // → the two text lines, with a trailing newline

// lib/spawn.mjs — adds
export function runChild(spawn, file, args, { cwd, env, timeoutMs, timers })
//   → { done: Promise<{ ok, code, signal, stdout, stderr, missing, timedOut, error }>, kill() }
//   done never rejects. ok is true only for exit code 0. stdout is the lines joined by '\n'.
//   After timeoutMs the child is killed (SIGTERM, then SIGKILL after the kill grace) and timedOut is true.

// lib/voice/sessions.mjs
export const LOG_LINE_CHARS = 400
export function parseAgents(stdout)                      // pure → { ok: true, entries } | { ok: false, reason }
export function listSessions(entries, { repos, rows })   // pure → session[]   repos: [{ name, path }]
//   session: { id, repo, cwd, state, waitingFor, startedAt, prompt, sessionId }
export function countRunning(sessions)                   // pure → sessions whose state is working or blocked
export function runningIn(sessions, repo)                // pure → boolean
export function announcements(before, after)             // pure → string[]; before is null for the first list
export function screenLines(text, { lines })             // pure → string[]
export function attachScript(claudePath, id)             // pure → the two lines, with a trailing newline
export function formatSessions(sessions)                 // pure → the text of dial sessions, with a trailing newline
export function callReason(what, result, seconds)        // pure → 'claude <what> failed (exit 1): …' and its siblings
export function createSessions({ spawn, timers, env, limits, repos, claudePath, platform, tmpdir, writeFile, on })
//   → { watch(on: boolean), read() → Promise<void>, start({ repo, path, prompt }) → Promise<{ ok: true } | { ok: false, reason }>,
//       log(id) → Promise<{ status, body }>, stop(id) → Promise<{ status, body }>, attach(id) → Promise<{ status, body }>,
//       list, shutdown() → Promise<void> }
//   repos() → [{ name, path }]   asked at every read, so a registry change is seen
//   on(event): { type: 'sessions', sessions } | { type: 'notice', text } | { type: 'error', message }

// lib/voice/proposals.mjs — state only
export function createProposals({ timers, seconds, newId, on })
//   → { offer({ repo, prompt }) → proposal, markRead(id) → boolean,
//       check(id, { spoken }) → { ok: true, proposal } | { ok: false, reason },
//       begin(id), settle(id, status, reason), cancel(id) → { ok: true } | { ok: false, reason }, open, clear() }
//   proposal: { id, repo, prompt, status, reason? }   status: pending | read | starting | started | failed | cancelled | expired | replaced
//   on(proposal)   once for every status change

// lib/voice/engine.mjs — changes
export const ALLOWED_TOOLS                               // the seven entries, one string
//   createReducer: feed() also returns { type: 'proposal', repo, prompt } and { type: 'proposal-unread' }
//   createEngine: on() also receives those two

// lib/voice/speech.mjs — changes
//   say(text, done?)   done(spoken) is called once: true when that sentence's say process exited 0 and was not stopped;
//                      false when it was stopped, failed, was dropped from the queue, or speech is off

// lib/voice/guard.mjs — changes
//   checkRequest routes also: log (GET, token in t), confirm, cancel, stop, attach (POST, checked as turn is)

// lib/voice/server.mjs — changes
//   createVoice also takes { registry, claudePath, tmpdir, writeFile }   registry() → the registry as it is now, or null

// lib/voice/page-logic.mjs — changes
export function createController({ Recognition, post, get, view, timers })
//   also → { confirm(), cancel(), stopSession(id), attach(id), openLog(id), closeLog() }
//   get(path) → Promise<{ status, body }>
//   view also: { proposal(proposal | null, reason), sessions(list), log(id, lines, reason) }
```

How the server joins the parts: an engine `proposal` goes through `checkProposal` with the registry read at that moment, then `proposals.offer`. When the engine reports `end` with `stopped` false and a proposal is `pending`, the server sends the `notice`, cuts the reading with the segmenter, and passes each sentence and then `Say confirm or cancel.` to the speaker with a callback; `markRead` is called when every callback reported true. `POST /confirm` runs `proposals.check`, then the two bounds against `sessions.list`, then `begin` and `sessions.start`, and settles the proposal with the result. A `notice` from the sessions manager is sent to the pages and, when `engine.busy` is false, to the speaker.

### 12. Testing

- The pure functions are tested directly: the prompt and proposal checks, the session name, the list mapping, the announcements, the screen cleaning, the attach script, and the reducer's pairing.
- The proposals state and the sessions manager run against `fakeTimers` and `fakeSpawn` from `add-voice-ui`'s `test/helpers.mjs`. The manager's `writeFile` is a recording fake.
- The server's new routes and events run against the same fake request and response objects as `add-voice-ui`'s server tests.
- `dial propose` and `dial sessions` are tested through the real binary, `dial sessions` with a fake `claude` on `PATH`.
- The real `claude --bg`, `claude agents --json`, `claude logs` and the Terminal control are manual steps (`tasks.md` H0 and H1).

### 13. Compound notes (D29)

`interlock note match` returned two notes for the files `tasks.md` names.

- N5 (`bin/dial.mjs`: a command exited 1 with nothing on stderr). Honoured: every refusal of `dial propose` and `dial sessions` in the `voice-sessions` delta names its one `dial: <reason>` line, and neither command is a report that exits 1 without one. A refused route of `dial voice` is an HTTP reply, not an exit.
- N3 (`lib/agent.mjs`: `agent status` for a healthy interval agent). Does not apply (D29): `tasks.md` names `lib/agent.mjs` only as a reader of `LIMITS`, and no task edits it.

## Risks / Trade-offs

- [`claude --bg` may refuse to start when a program spawns it with pipes and no terminal] → H0 probes exactly that before implementation. If it refuses, the change stops for a spec edit.
- [A positional `/interlock:ship <change>` prompt may not expand the plugin skill under `--bg`; it is documented for `-p` and for the agent view's input] → same probe, with a harmless skill.
- [`claude logs` may print a screen drawn with cursor movement, which stripping escape sequences would jumble] → H0 looks at its raw output. The page always shows the `claude attach` command, and the Terminal control does not depend on the log.
- [`claude agents --json` is a research-preview interface and may change] → Dial reads seven fields, passes `state` and `waitingFor` through as text, and reports an unreadable list once instead of failing.
- [The `tool_result` shape is read from documentation] → the probe file of `add-voice-ui` H0.2 already holds one; H0 checks it. A result that cannot be read gives an `error` event, never a silent miss.
- [A started session has the owner's full Claude Code permissions in that repo, and may run without prompts when their mode is `auto`] → the confirmation is the gate, the card and the reading show the exact prompt, and D4 asks whether every start stays confirmed.
- [A background session isolates its edits in a worktree by default and ends in a pushed branch and a draft pull request] → Dial passes nothing; D7 asks the owner which behaviour they want. H0 observes where a started `/interlock:spec` writes.
- [Another voice in the room can say `confirm`] → accepted for a single-owner tool; the reading must have finished, and Mute turns recognition off.
- [The reading goes through the spoken form, which says `link` for a web address and drops markdown marks] → the card shows the prompt as written.
- [Two sessions in one repo could be confirmed within one poll interval] → the list is read at once after a start, which narrows the window to the start itself.
- [The attach file stays in the temporary directory] → it is two lines, mode 0700, and is overwritten for the same id.
- [This change cannot be archived before `add-voice-ui`] → stated in `tasks.md`; `openspec validate` prints the note.

## Migration Plan

1. Ship and archive `add-voice-ui`.
2. Run the H0 probes of this change.
3. Ship this change. No data migrates and nothing is removed from the product. Rolling back is reverting the commit: sessions already started are ordinary Claude Code background sessions and stay manageable with `claude agents`.

## Open Questions

- D4: must every start be confirmed, or may some start on the assistant's reading of the owner's words alone? The specs assume every start is confirmed. A yes to unconfirmed starts would be a later change; nothing here changes either way.
- D7: should a started session work in the repo's own checkout or in an isolated worktree? The specs assume Dial passes nothing and the owner's Claude Code setting decides. Passing a setting would add one argument to the start and one scenario.
