# Design

## Context

See `proposal.md` for the motivation. The constraints that shape the approach:

- Dial is a zero-dependency Node 22 CLI. Only `bin/dial.mjs` touches the process; `lib/` returns data or `{ ok: false, reason }`; a failure is one `dial: <reason>` line and exit 1.
- The one way Dial runs a program today is synchronous (`lib/subprocess.mjs`). A conversation needs a child that stays alive and takes input.
- Every applied cap is published (`openspec/specs/limits/spec.md`).
- The only long-running command today is `dial watch`: foreground, ended by SIGINT (`bin/dial.mjs:381-411`).
- Answers about a repo already come from `dial sync` and `dial context` through the `/dial:ask` skill (`skills/ask/SKILL.md`). The voice session reuses those commands. It does not reuse the skill, because it loads no plugin.
- Loopback binds are refused with `EPERM` inside the Claude Code sandbox, so the listener's logic must be testable without a socket.
- Several behaviours of the installed `claude` (2.1.326) are read from its `--help` and not yet observed in a live run. They are listed under Risks, checked by a manual probe before implementation (`tasks.md` H0), and guarded at run time.

## Goals / Non-Goals

**Goals:**

- One command that opens a window, converses by voice or typing, and ends when the window closes.
- First spoken words while the reply is still being written.
- The session can do less than the owner's own Claude Code session, never more.
- The owner's speech audio stays on the machine.
- Every rule with a pass/fail core (sentence cutting, event handling, request guard, state) is a pure function or a handler tested without a socket, a browser or a real `claude`.

**Non-Goals:**

- Acting on a spoken yes (D7). The follow-up change `add-voice-orchestrator` adds it.
- A daemon, an installed app, a tray icon.
- Echo cancellation or talking over Dial.
- Memory across launches (D14). Each `dial voice` starts a new conversation with a new `--session-id`; Quit, a closed window or a dead `dial voice` ends it for good. `--resume` is used only inside one run.
- Verifying in the suite that the real `claude` and the real recognizer behave as documented. Those are manual steps.

## Decisions

### 1. One foreground command serving a loopback page (D1, D9, D10)

`dial voice` serves a page with `node:http` and opens it with `open -na "Google Chrome" --args --app=<url>`. The owner gets a window with no browser chrome that can be opened, left open and closed. Closing it ends the command `voiceCloseSeconds` later, which also covers a reload.

- Why not Electron, Tauri or a native app: each adds a runtime dependency or a build chain to a package that has neither (`README.md:15`).
- Why not a LaunchAgent or a detached server: Dial's only background process is the sync agent (`README.md:704-705`), and a server that outlives its window needs a stop command, a pid file and a stale-token story.
- The port is fixed at 3425 so the browser's microphone grant, which is keyed by origin, survives restarts. `--port` overrides it. A registry block was rejected: the registry spec enumerates and validates every optional block (`openspec/specs/registry/spec.md:9`), which would add a sixth capability for five flags.
- Transport is server-sent events one way and `POST` the other. No WebSocket: Node has no server-side WebSocket without a dependency.

```
 owner ── speech ──▶ Chrome app window ── POST /turn ──▶ dial voice ── stdin line ──▶ claude -p
   ▲                 (on-device STT)                     (node:http)                  (five dial commands)
   │                        ▲                                │  ▲                          │
   └──── say ◀── sentences ─┼────── SSE /events ◀────────────┘  └──── stream-json ◀────────┘
```

### 2. The engine is one long-lived `claude -p` child (D2, D3, D14)

One `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` process per conversation. A turn is one JSON line on its stdin; the reply arrives as events on its stdout.

- Why not one `claude -p` per turn: every turn would pay the start-up cost, and resuming on every turn is slower than keeping the process.
- Why not the Messages API directly: it needs an API key, an HTTP client for tool use, and a second copy of the `/dial:ask` rules. The owner's Claude Code login already works.
- This is the first time Dial itself starts a model session (D3). `dial narrate` keeps its loopback-only rule; the two are separate commands with separate specs.
- Conversations are saved as ordinary Claude Code sessions under the voice directory (D14). Resuming after a stop needs them.

### 3. Isolation is two flags plus a strict MCP flag (D6, D22)

`--safe-mode` disables CLAUDE.md, skills, plugins, hooks and MCP servers, but its help text says permissions "work normally", so the owner's own allow rules would still widen what the session may run. `--restricted` ignores user, project and local settings files. Both are passed, with `--strict-mcp-config`. `--bare` was rejected: it reads no keychain or OAuth login, so it would need an API key.

The working directory is `<home>/voice`, outside every registered repo, so Dial's own hooks would do nothing there even if they loaded (`hooks/common.mjs:43-47`).

### 4. Five commands, enforced by Claude Code (D8, D25, D30)

`--tools Bash`, `--permission-mode dontAsk`, and one `--allowedTools` argument naming `dial next`, `dial context`, `dial brief`, `dial sync` and `dial repos`. `dontAsk` denies anything not allowed without asking, which suits a session nobody can answer prompts for.

- The rule syntax is the `Bash(dial sync:*)` form the shipped skills already use and the owner already runs (`skills/ask/SKILL.md:5`), passed as one comma-separated argument so a variadic option cannot swallow what follows (D25).
- `dial handoff` is left out: a handoff written by a session that did no work in the repo would put a false entry in the narrative (D8).
- Dial does not vet each command itself (D30). A `tool_use` event arrives when the command is already running or denied, so a check there could not prevent anything. Dial checks what the session reports at start (Decision 6) and shows every command on the page.

### 5. The session runs `dial` from PATH, in the server's environment (D19, D24)

The child inherits the environment of `dial voice`, so `DIAL_HOME`, `DIAL_NOW`, `PATH` and the Claude login reach it, and its `dial` commands read the same home as the server. With no plugin loaded, `dial` must be on PATH; `dial voice` checks for both `claude` and `dial` before it creates or binds anything, with the scan doctor already uses (`lib/doctor.mjs:375-387`). A shim directory that pins the server's own binary was rejected as a file write and a spec surface for a development-only case.

The PATH scan is a new exported helper in `lib/spawn.mjs`. Doctor's two inline scans are left as they are; folding them in is a separate tidy-up.

### 6. The start report is checked, fail closed, and nothing waits for it (D21, D23, D26)

The session's first event (`system`/`init`) lists its tools, MCP servers and permission mode. `dial voice` requires `tools` to be exactly `["Bash"]`, `mcp_servers` to be empty and `permissionMode` to be `dontAsk`. A missing field refuses.

- `plugins` and `skills` are not checked (D21). `--safe-mode` keeps built-in plugins, so the report may list some, and with `Bash` as the only tool no skill can be invoked. The three checked fields are the ones that decide what the session can do.
- There is no `starting` state (D23). Whether `claude` writes its start report before it has read a first turn is not confirmed. So a turn is accepted and written at once, and the check runs whenever the report arrives. The report always comes before any reply or tool use; an answer before it is itself a refusal.
- A refused session is not retried (D26). The command keeps serving so the window can show the reason, writes the one `dial: voice session refused: <reason>` line, and exits 1 when it ends. That keeps the cli-shell rule of one failure line. A `claude` that exits before its report (not logged in, an unknown flag, started inside another Claude Code session) is refused with its own first stderr line as the reason.

### 7. A turn, an interrupt and a restart (D12, D27)

A pure reducer turns each stdout line into effects: reply text, a flush at the end of a text block, a command, the end of the turn. Unknown lines are skipped and never throw.

```
state      = refused                     once refused
           | speaking                    a sentence is being spoken or waits
           | thinking                    a turn runs and nothing is spoken or waits
           | idle                        otherwise
```

- Interrupt uses only documented behaviour (D12): stop `say`; when the turn is unfinished, end the process and resume the conversation with `--resume <session id>`. The in-band control message is undocumented and has open bugs (claude-code issues 98713 and 94741).
- After Dial ends the process itself, it starts the next one at once, once the old one has exited, so the next turn finds a warm session. After the process ends on its own, nothing is started until the next turn, which bounds a crash loop by the owner's turns (D27).
- A resume that fails falls back once to a new conversation and says so. A second failure refuses.
- `voiceTurnSeconds` stops a hung turn the same way an interrupt does.
- Every process Dial starts leads its own process group (`detached: true` with piped stdio), so a `dial sync` the session is running belongs to the session's group (D33). Ending a process sends SIGTERM to the group, then SIGKILL to the group 2 seconds later if a member is still alive, and the command waits for it. When the session's process exits by itself, what remains of its group is ended the same way. An interrupted `dial sync` may stop between two writes; each vault, cache and registry write is a temp file renamed into place (`lib/vault.mjs:260-280`, `lib/cache.mjs:55-59`, `lib/registry.mjs:298-301`), so an interrupted one leaves the file as it was or as written, at worst with a hidden `.tmp` file beside it.
- Because the children are in their own groups, a Ctrl-C in the terminal reaches only `dial voice`, which ends them through `shutdown`. A `dial voice` that is itself sent SIGKILL leaves them running; that is accepted.

### 8. Sentences out: segmenter and `say` (D5, D28)

The segmenter is a pure function over the text stream: it emits a sentence as soon as a terminator is followed by whitespace, so speech starts while the reply is still arriving. It has no abbreviation list; a wrong cut costs one short pause, a missed cut costs seconds of silence. A `.` at the end of the buffer waits, which is what keeps `0.2.0` whole across two deltas.

Each sentence goes to the page as written and to `say` in a plain form (markdown marks, list marks and addresses removed). `say` reads the text from stdin, so no reply text is ever an argument. One `say` process per sentence gives a clean stop: end the process, drop the queue. In-page speech synthesis was rejected: it needs a user gesture per page load and its queue cannot be stopped reliably from the server's view of the turn.

Errors are shown and not spoken (D28): a failed `say` could not speak its own error, and one rule is simpler than two.

### 9. Speech in: on the device, hands-free, no talk-over (D4, D13, D16, D18)

The page uses `SpeechRecognition` with `processLocally = true` only and never falls back to a server recognizer, in line with the rule that transcript text leaves the machine only for a loopback model (`openspec/specs/handoff-and-narrative/spec.md:142`); here the turn text goes to Claude as a typed prompt would, and the audio goes nowhere. Where on-device recognition is not offered the page says so and takes typed turns.

After one click, the page listens whenever the state is `idle` and listening is not muted, and posts each final transcript as a turn (D18). There is no wake word and no push-to-talk. Recognition stops while Dial thinks or speaks, because `say` has no echo reference and the recognizer would hear it (D13). Escape or Stop interrupts. The language is `en-US` unless `--lang` says otherwise (D16).

- **A posted turn holds the microphone (D36).** The state leaves `idle` only when the `thinking` event of an accepted turn arrives, and that can come after the `202`. So posting a turn stops recognition at once and marks the turn in flight; the page listens again only after a `state` other than `idle` has arrived since the post, or at once when the post is refused or fails. The status line says `Thinking` during the flight, so the owner sees the turn was taken.
- **A microphone that cannot be used (D34).** The recognizer's `error` codes `no-speech` and `aborted` are ordinary ends. Every other code (`not-allowed` after Don't Allow, `audio-capture` with no microphone, and the rest) stops listening, shows the reason with the code, and leaves typed turns. Nothing is retried until the owner clicks Start again, so a denial cannot loop the prompt.
- **Interim speech.** Recognition runs with `interimResults`, and the latest partial transcript is shown while the owner speaks, so the window is not blank during a long question. It is never posted, and it is cleared on the final transcript, on leaving `idle`, and on mute.
- **What the page says (D32).** One status line holds one of nine texts: `Not started`, `Listening`, `Muted`, `Typed turns only`, `Thinking`, `Thinking: running <command>`, `Speaking`, `Refused: <reason>` and `Closed`. These are the words `add-voice-stage-and-capture` already uses, plus the running command, which is what a hands-free owner needs while a sync takes time. The latest error stays on an error line until the next accepted turn, because a hands-free owner may look up only after it happened. Errors stay unspoken (D28). The transcript labels each line `You`, `Dial`, `Ran` or `Error`, and the empty transcript suggests a first question.
- **Keyboard and screen reader (D37).** Real `button` elements with visible names, a labelled text field, `role="status"` on the status line and `role="alert"` on the error line, one `keydown` listener on the document so Escape works with the field focused, and focus moved to the status line when the session is refused. The ids are the ones `add-voice-stage-and-capture` names.
- **A lost event stream (D35).** The page retries 500, 1000 and 2000 milliseconds after each failure, three times in all, within the default 10-second close window. A stream that delivers `hello` is reconnected: the page takes the state that follows and says that anything said while it was away is not shown. Nothing is replayed; the server keeps no history. After three failures the page shows `Closed`. With `voiceCloseSeconds` below 4, a lost stream can outlast the command; that is the owner's choice.

### 10. The request guard (D29)

The listener binds `127.0.0.1` only. Every request must carry the exact `Host`; the event stream and every `POST` must carry the per-launch token; every `POST` must also carry the page's `Origin` and a JSON content type, which a cross-site form cannot send without a preflight. The token is compared in constant time. Static files need only the `Host` check (D29): they hold no state, and the page reads the token from its own address.

The page renders every string with `textContent`, and a `Content-Security-Policy` of `default-src 'none'` with `'self'` for script, style and connect removes inline script as a fallback. A pull request title is untrusted text; it can be read aloud, never executed.

### 11. Caps and constants (D17)

Three bounds are things an owner may want to change, so they are published caps: `voiceTurnSeconds` 120, `voiceCloseSeconds` 10, `voiceTurnChars` 2000. Three are format constants and stay in code, like the margins in `lib/record.mjs:33-34`: the 300-character forced cut, the 15-second keepalive and the 2-second kill grace.

### 12. The model and the release surface (D11, D15)

`--model` defaults to `sonnet`: a conversation wants a fast reply more than the owner's session default. There is no doctor check and no version bump; `dial voice` refuses in one line when `claude` or `dial` is missing, as `add-dial-ask` left its release to the owner.

### 13. Modules and seams

| Module | Holds | Pure |
|---|---|---|
| `lib/spawn.mjs` | async child runner (lines out, write, kill with grace, exit result, never throws); `findOnPath` | no |
| `lib/voice/segment.mjs` | sentence segmenter, `speakable` | yes |
| `lib/voice/engine.mjs` | `engineArgs`, `checkStart`, the event reducer, the session manager | reducer and args yes; manager takes `spawn` |
| `lib/voice/guard.mjs` | request check, token | yes |
| `lib/voice/speech.mjs` | the `say` queue | takes `spawn` |
| `lib/voice/server.mjs` | routes, event stream, state, close timer, start and shutdown | takes `listen`, `spawn`, timers, `signal` |
| `lib/voice/page.html`, `page.js`, `page-logic.mjs`, `page.css` | the page; `page-logic.mjs` holds the listening loop with no DOM access | `page-logic.mjs` takes the recognizer class, `post`, `connect` and timers |
| `lib/voice/prompt.md` | the voice prompt | — |

`bin/dial.mjs` gains the usage line, the option table entry, `runVoice`, and three injectables on `main` (`spawn`, `listen`, `platform`) beside the existing `signal`. Start order: check options → find `claude` and `dial` → load the registry's caps → ensure the home and `voice/` → listen → print the address → start the session → open the window.

The assets live under `lib/voice/`, so `package.json` `files` is unchanged.

#### Interfaces

The failing tests are written before the modules, possibly by another agent, so the exports are fixed here. A module may hold more; these names and shapes are what the tests import.

```js
// lib/spawn.mjs — never throws
export const KILL_GRACE_MS = 2000
export function spawnChild(file, args, { cwd, env, onLine, onExit, killGraceMs = KILL_GRACE_MS })
//   → { pid, write(text) → boolean, end(), kill() }
//   The child leads its own process group (detached: true, stdio piped).
//   onLine(line)   each stdout line without its newline, in order; a last line with no newline arrives before onExit
//   onExit({ code, signal, stderr, error })   exactly once, when the child has exited; after kill(), not before its
//                  group is empty or was sent SIGKILL. stderr: what the child wrote there, last 64 KiB.
//                  error: null, or { code, message } when it could not be started (then code and signal are null)
//   write(text)    to stdin; returns false and writes nothing after exit, end() or kill()
//   end()          closes stdin and leaves the process running (say speaks once its input ends)
//   kill()         closes stdin, SIGTERM to the group, then SIGKILL to the group after killGraceMs if a member is
//                  alive; after the child exited by itself it still ends what remains of the group; safe to call twice
export function findOnPath(env, name)   // → absolute path of an executable file, or null

// lib/voice/segment.mjs — pure
export const MAX_SENTENCE_CHARS = 300
export function createSegmenter()       // → { push(text) → string[], flush() → string[], reset() }
export function speakable(sentence)     // → string, '' when there is nothing to say

// lib/voice/guard.mjs — pure
export function newToken()              // → 32 lowercase hex characters
export function checkRequest({ method, url, headers }, { port, token })
//   → { ok: true, route } with route one of page, script, logic, style, events, turn, interrupt, quit
//   → { ok: false, status, reason }   checked in this order: Host (403), path (404), method (405),
//                                      token (403), Origin (403), content type (415)

// lib/voice/engine.mjs
export const ALLOWED_TOOLS              // the one --allowedTools argument
export function engineArgs({ model, prompt, sessionId, resume = false })   // → string[]
export function checkStart(event)       // → { ok: true } | { ok: false, reason }
export function createReducer()         // → { feed(line) → effect[], newTurn() }   pure, never throws
//   effect: { type: 'start', event } | { type: 'text', text } | { type: 'flush' } | { type: 'tool', command }
//         | { type: 'done' } | { type: 'failed', reason }
export function createEngine({ spawn, cwd, env, model, prompt, turnMs, uuid, timers, on })
//   → { start(), turn(text) → { ok: true } | { ok: false, reason }, stop() → boolean,
//       shutdown() → Promise<void>, busy, refused }
//   on(event): { type: 'text', text } | { type: 'flush' } | { type: 'tool', command } | { type: 'error', message }
//            | { type: 'end', stopped }      once per turn: stopped false after a result, true when the turn was cut
//            | { type: 'refused', reason }   once

// lib/voice/speech.mjs
export function createSpeaker({ spawn, voice, enabled, on })
//   → { say(text), stop(), shutdown() → Promise<void>, busy }
//   on(event): { type: 'busy', busy } on each change | { type: 'error', message } once, after which say() does nothing

// lib/voice/server.mjs
export function createVoice({ port, token, lang, model, sayVoice, limits, cwd, env, prompt, assets,
                              spawn, timers, uuid, platform, noOpen, warn })
//   → { handle(req, res), start(), shutdown() → Promise<number>, done }   done: Promise<number>, the exit code
export function listenLoopback(handler, { port })
//   → Promise<{ ok: true, close() → Promise<void> } | { ok: false, code, message }>   binds 127.0.0.1 only

// lib/voice/page-logic.mjs — no DOM, no network
export function checkRecognition(Recognition, lang)   // → Promise<'ready' | 'unavailable'>
export function createController({ Recognition, post, connect, timers, view })
//   → { open(), onEvent(name, data), start() → Promise<void>, mute(on), submit(text) → Promise<void>,
//       stop(), quit() → Promise<void>, key(name) }
//   open()   connects the event stream; start() is the Start click
//   connect({ onEvent, onError }) → { close() }   page.js wraps EventSource('/events?t=…'); a test passes a fake
//   post(path, body) → Promise<{ status, body }>, rejecting when there is no answer; stop() and quit() send {}
//   view: { status(text), error(text), line(kind, text), notice(text), interim(text), clearInput(), focusStatus(), closed() }
//   kind is user | sentence | tool | error; error('') clears the error line and interim('') the interim text.
//   The controller sets the recognizer's onresult, onend and onerror properties, so a test passes a plain class.
```

`timers` is `{ setTimeout, clearTimeout, setInterval, clearInterval }` and defaults to the globals. `uuid` defaults to `crypto.randomUUID`. `req` is any readable stream with `method`, `url` and `headers`; `res` needs `writeHead`, `write`, `end` and a `close` event, so a test passes plain objects.

How the server joins the parts: an engine `text` goes through the segmenter; each sentence is sent as a `sentence` event and its `speakable` form, when not empty, goes to the speaker. `flush` flushes the segmenter. `end` with `stopped` false flushes; with `stopped` true it resets the segmenter and stops the speaker. The state is computed from `engine.refused`, `speaker.busy` and `engine.busy` after every event and sent when it changed. A `POST /turn` body is read up to 4 × `voiceTurnChars` + 1024 bytes; a longer one is answered 413 with the same reason as a turn that is too long.

### 14. Testing (D20)

- Pure modules are tested directly. The session manager, the speaker and the server run against a scripted fake `spawn` and fake timers; the server's handler runs against fake request and response objects.
- `page-logic.mjs` is imported by the test with a fake recognizer class, a fake `connect` and fake timers. `page.js` and `page.html` are checked as text for the markup sinks, the remote addresses, the `processLocally` rule, the control ids and roles, and the document-level `keydown` listener.
- The prompt is checked as text in its own file, `test/voice-prompt.test.mjs`, which imports no page module, so the prompt task can pass before the page exists.
- CLI tests run the real binary with fake `claude`, `dial`, `say` and `open` scripts on PATH. The two that need a real socket (port in use, one end-to-end turn) skip when the bind is refused with `EPERM`, and a manual step runs the suite once outside the sandbox.
- The real `claude` handshake and the real recognizer are manual steps (`tasks.md` H0 and H1).

### 15. Compound notes (D31)

`interlock note match` returned two notes for the files `tasks.md` names.

- N5 (`bin/dial.mjs`: a command exited 1 with nothing on stderr). Honoured: `dial voice` exits 1 only after it wrote exactly one `dial: ` failure line, either a start refusal or `dial: voice session refused: <reason>` (Decision 6). The Chrome warning is named in the `cli-shell` delta as not being that line, and its scenarios cover the warning alone (exit 0) and the warning beside a refusal (two lines, exit 1).
- N3 (`lib/agent.mjs`: `agent status` for a healthy interval agent). Does not apply (D31): `tasks.md` names `lib/agent.mjs` only as a reader of `LIMITS`, and no task edits it.

N11 (`lib/remote.mjs`) did not match by file, but its rule is the reason the voice prompt runs `dial sync <repo> --remote --json` and reports an unobserved `remote` fact as a failed refresh.

## Risks / Trade-offs

- [The start report's shape, the effect of `--safe-mode` with `--restricted` on the login, the rule syntax, and whether `--verbose` is still required are read from `--help`, not observed] → H0 runs one probe command before implementation and compares its output with the delta specs; a mismatch stops the change for a spec edit. At run time the check fails closed with the reason on the page.
- [`tools` may list a companion of `Bash` in some `claude` version, so every start would be refused] → same probe; the refusal names the extra tool, so the cause is one line away.
- [A pull request title or note line tries to instruct the session] → the session can run five Dial commands and nothing else, the prompt carries the data rule, and replies are rendered as text. The residual risk is a misleading spoken sentence.
- [Dial trusts Claude Code's permission rules to hold the five-command line, as `/dial:ask` does] → H0 asks the session to run a command outside the list and confirms it is denied.
- [`dial` on PATH may be another version than the running server] → accepted; doctor's `on-path` check already reports the path.
- [`dial voice` started from inside a Claude Code session may be refused by `claude` as a nested session] → the refusal carries `claude`'s own line; run it from a terminal.
- [Start-up and per-turn latency are unmeasured] → the session starts before the window opens, speech starts at the first sentence, and `--model` picks a faster model.
- [On-device recognition needs Chrome 139 or later and a language pack; other browsers have none] → typed turns always work, and the page says why it is not listening.
- [`say` and `open` exist only on macOS] → elsewhere replies are text and the address is printed.
- [The token is in the page address, so it is visible in the process list and the browser history] → it is new for every launch, useless after the command ends, and the listener is loopback only.
- [A turn's text goes to Claude through the owner's login and counts against their plan] → stated in the README; the audio does not leave the machine.
- [Session files accumulate under `~/.claude/projects/` for the voice directory] → accepted (D14); they are ordinary Claude Code sessions.
- [A command the session runs may start its own process group, which a group signal does not reach] → `dial` commands do not; accepted (D33).
- [The status words and control ids are also specified by `add-voice-stage-and-capture`] → this change takes the same words and ids, and adds `Thinking: running <command>`; that change compares its blocks with the living specs before it starts (its H0.2) and takes the ninth text in then.

## Open Questions

- None. D7 (may a spoken yes let the session run a `suggested` action) was answered on 2026-11-17: yes, in the follow-up change `add-voice-orchestrator`, which adds commands to the list. Nothing in this change changes.
