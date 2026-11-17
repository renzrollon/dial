# Design

## Context

See `proposal.md` for the motivation. This change is written on top of `add-voice-ui` and `add-voice-orchestrator`, which are specced and not yet built. References to "the base" are to those two changes' `design.md`, `tasks.md` and delta specs. The constraints that shape the approach:

- Everything the base fixed still holds: zero dependencies, only `bin/dial.mjs` touches the process, a failure is one `dial: <reason>` line, every applied cap is published, the page renders text only, and logic is testable without a socket or a browser.
- The page's policy is `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'` (`add-voice-ui` `specs/voice/spec.md:128`). It allows no inline script or style, no remote font, no image and no worker.
- `page-logic.mjs` has no DOM access and drives a `view` object (`add-voice-ui` design §13). `add-voice-orchestrator` added `view.proposal`, `view.sessions` and `view.log`.
- Every vault write goes through `applyWrites`: a boundary check against the registry, an atomic write through a hidden temp file, and no delete (`lib/vault.mjs:160-195, 248-286`). `Inbox/` is already inside the boundary (`lib/vault.mjs:34`), and `dial review --week` already creates Inbox notes without rewriting one (`lib/report.mjs:319-320`).
- The voice session runs under `dontAsk` with a fixed command list and reads untrusted text (pull request titles, note lines).
- The owner's visual pick from the Claude Design output has not been made (D8). The design prompt is `.claude/handoff/design-prompt-voice-stage.md`.

## Goals / Non-Goals

**Goals:**

- A mechanism in which every moving part shows one fact, and no part moves for decoration.
- Gear geometry and motion that a Node test checks, so a mis-phased train is a failing test and not a judgement by eye.
- A window that can stay open all day: one frame a second at rest, none while hidden.
- Nothing the mechanism shows is missing for someone who cannot see it or does not want motion.
- A spoken note lands in the vault through the same boundary and write rules as every other vault write.
- The owner's visual pick changes one stylesheet and no script.

**Non-Goals:**

- A renderer other than Canvas 2D. A WebGL painter can replace the Canvas one later behind the same list of parts.
- Mechanical truth across the whole movement (see Decision 4).
- Reading or searching notes. Capture only writes.
- A confirmation card for a capture (D17 asks the owner).

## Decisions

### 1. One change on top of two (D15, D16)

The owner asked for the stage and the capture as one change (D15). It is built on `add-voice-orchestrator` as well as `add-voice-ui` (D16): the sub-dials and the reserve arc draw that change's `sessions` and `proposal` events, and `dial capture` is the eighth entry of the command list it grew to seven.

- OpenSpec validates a `MODIFIED` delta against a spec that is not living yet and notes that archive needs the base first. So this change can be reviewed now and archived third.
- The two halves share only lists: the command list, the voice prompt, the cap list, the usage text and the README. No task of one half needs a module of the other.

### 2. Canvas 2D for the mechanism, the DOM for every word (D1, D2, D34)

The mechanism is hand-written Canvas 2D (D1): no dependency, no policy change, and its geometry lives in pure modules. Claude Design supplies layout, type, colour tokens, one board per state and a motion table; its export is reference, not shipped code (D2).

The canvas draws no text at all (D34). Hour marks are ticks, and every name, state and reason is a DOM node next to it. That makes the base rule "every string is shown as text" hold for the stage without a second rule for canvas text, and lets a text check (`fillText`, `strokeText` absent from every script) stand in for a review.

- SVG with CSS animation was rejected: a stepped escapement and data-driven meshing need script anyway.
- Vendored Three.js was rejected: about 814 KB, a licence notice, and text that trips the address and markup-sink checks.

### 3. Three pure layers and a thin glue (D3, D32)

```
page-logic.mjs (controller, no DOM)
      │ view.stage(change)        one small fact per call, never text that was said
      ▼
stage.mjs  createStage            holds the model, decides when a frame is due
      │ scene(model, now)         pure: model and time → a list of parts
      ▼
scene.mjs ── gears.mjs            pure: involute outlines, mesh phase, escapement beat
      │ parts
      ▼
stage.mjs  paint(ctx, parts)      Canvas 2D calls only
```

- The controller, not `page.js`, turns events into stage facts (D32). It already knows when recognition runs and what each event means, and it is the module a Node test imports. `page.js` passes `view.stage` straight to `createStage().tell`.
- The stage is told counts and names, never content: the word count of the transcript, not the words; the states of the sessions, not their repos or prompts (D3). So no string a pull request title can reach is ever in the model.
- `createStage` takes `raf`, `cancelRaf`, `timers`, `now` and `draw` as arguments, so its frame budget is tested with fakes. `paint` takes a context object, so a recording fake checks that it never draws text and balances `save` and `restore`.
- The controller also gains the status words (`statusText`) and full screen through an injected `screen` object, for the same reason: they are rules with a pass/fail core.
- Each of the three new scripts is its own shipped file and static route, with the same four headers as the others, and the text checks for markup sinks and for a server recognizer read every served script (D5). There is no bundler: the package has no build step. `page.js` imports `./stage.mjs`, which imports `./scene.mjs`, which imports `./gears.mjs`; `script-src 'self'` allows module imports from the same origin.

### 4. What each part shows (D27, D28, D29, D30, D31)

| Part | Shows | Motion |
|---|---|---|
| Balance, lever, escape wheel | Dial can hear the owner now | one beat a second |
| Barrel | the owner is speaking | one notch per three words |
| Going train (four wheels) | Dial is thinking or speaking | continuous, in mesh |
| Hand | sentences of the reply so far | one mark per sentence |
| Sub-dial (twelve) | one session | `working` steps each second; `blocked`, `done`, `failed` rest at fixed marks |
| Reserve arc | time left on an open proposal | drains by the second |

- **The balance beats exactly while the recognizer runs (D28).** It stands still while Dial thinks or speaks, because recognition is stopped then (`add-voice-ui` "Dial does not hear itself"). A moving balance means "speak, I hear you" and is also the page's microphone indicator. The design prompt's table left the balance unspecified during thinking; a balance that kept swinging then would say Dial hears the owner when it does not.
- **The escape wheel advances half a tooth per beat (D27).** The explore brief said `360/z` per beat. In a lever escapement one tooth passes for two beats, so the step is `180/z`.
- **The three groups are not geared to each other (D29).** In a watch the train drives the escape wheel. Here the train means "working" and the escapement means "listening", and those are never both true, so gearing them would make one part lie. Within the train the gears are true: involute flanks, one module, centre distances and phases checked by test.
- **Working sub-dial hands share one seconds position (D30).** A hand's angle comes from the clock, not from how long that session has worked, so the stage keeps no per-session memory and needs no session id. There are twelve sub-dials, the default of `voiceSessionRows`; a longer list fills the first twelve and the text list shows the rest.
- **The hand steps and does not sweep (D31).** A sweep needs an animation with its own timing; a step is one frame. The hand returns to its top mark when the next turn begins, so it reads as "how far into this reply".
- **A part that stops keeps its place.** The model keeps, for the balance and for the train, the time it has run so far and when it last started. The angle is a function of that sum, so a pause never makes a wheel jump.

### 5. Frames (D6, D36)

`cadence(model)` gives `run`, `tick` or `still`.

- `run` (the train turns): a frame request after each frame, drawing when 33 ms have passed since the last draw.
- `tick` (a stepped part is live): one timeout to the next whole beat. No animation loop runs.
- `still`: nothing pending. A change asks for one frame, and changes before that frame share it.
- Hidden: everything pending is cancelled. Reduced motion is `still` in every state, and `scene` then ignores the time.

The beat, the frame interval, the twelve sub-dials and the 60-character title are format constants in code, as the base kept its 300-character cut and 15-second keepalive (D36). The one new cap is `captureChars`.

The canvas backing size follows the element's size times the device pixel ratio, capped at 2, and is set in `page.js` on a resize. It is glue and has no requirement.

### 6. Full screen and Escape (D4, D7, D37)

The page asks for full screen with the Fullscreen API on the click that starts listening (D4). The request is made first in `start()`, before the recognition check is awaited, because the browser grants it only while the click is fresh. A refusal is ignored.

Chrome may consume Escape to leave full screen without sending the key event to the page. So the rule is tied to leaving full screen, not to the key (D7): when the document leaves full screen and the page's own control did not ask for it, the page posts `/interrupt`. When the key event does arrive in full screen, the controller notes it and does not post a second time for the exit that follows (D37). Either way Escape is one interrupt. An interrupt with nothing to stop is already a no-op on the server.

### 7. Time left on a proposal (D33)

The reserve arc needs the time left, and a page that connects late must not show a full arc. So the `proposal` event of an open proposal carries `seconds` and `secondsLeft`, computed by the server when the event is sent. `createProposals` gains a `now` argument for that; the expiry itself stays on the injected timers. This follows `pollSeconds` in the `sessions` event (`add-voice-orchestrator` D25): a number the page needs travels in the event that uses it, and `hello` is unchanged.

- Starting the arc when the page first sees the proposal was rejected: after a reload it would show full with 20 seconds left.

### 8. Colours, type and the pending pick (D8, D35)

Every colour and font is a custom property in `page.css`. `page.js` reads the stage's tones (`--ground`, `--stage-live`, `--stage-rest`, `--stage-accent`, `--stage-ok`, `--stage-fail`) from the computed style and hands them to `paint`. No script holds a colour (D35).

Until the owner picks a direction (D8), `page.css` holds the reference palette of the design prompt: ground `#141416`, text `#EDE9E3`, brass `#C9A961` for live parts, oxblood `#8B2635` for the accent. The specs pin no colour value, only that text colours reach a contrast of 4.5 to 1 against the ground. So the owner's pick is an edit of one file with no spec change.

### 9. Keyboard and focus (D40)

`page.html` is one file for the whole page, so the rule covers every control, the proposal and session controls of `add-voice-orchestrator` included: native buttons and inputs, document tab order, a `:focus-visible` mark. The artifact gate of that change warned that it had no such requirement. The canvas is a pointer shortcut for Stop and is hidden from assistive technology.

### 10. Capture is a vault write like any other (D9, D10, D11, D12, D25)

`dial capture` builds one write, `{ path: 'Inbox/<name>.md', render: existing => existing ?? bytes }`, and passes it to `planWrites` and `applyWrites` with `{ registry, vault }`. An existing file plans as `unchanged`, which capture turns into its `already exists` refusal. A file that appears between the plan and the rename is re-read by `applyWrites` and kept, and capture refuses the same way (D11).

- The Daily log was rejected as the target: it is Dial's own event trail (D9). `dial handoff` was rejected: it needs a repo and writes a narrative entry.
- `--vault` is required (D12). The registry has no default vault, and a wrong guess would put a work note in the personal vault.
- The `vault-writes` spec is not changed (D25). The explore brief listed it as modified. Capture adds no rule to the write boundary: it uses the no-repo branch `dial review --week` already uses, and the `capture` capability restates the rules that apply, as the `report` spec does for the review note.
- `applyWrites` would create a missing vault directory on the way to `Inbox/`, so capture checks that the vault's directory exists first, with the words `dial vault init` uses.

### 11. The note (D18, D19, D20, D21, D22, D23, D24)

- **Cleaning before redaction, and both before the title (D22, D10).** Line endings become `\n` and control characters other than `\n` and tab are dropped. They are dropped and not refused, unlike in `dial propose`: a prompt becomes a program argument, a note is file content. `redact` then runs on the text, and the title is cut from the redacted text, so a secret on the first line cannot reach a file name.
- **Title and file name (D19).** The first non-blank line, with the characters Dial already forbids in a note name (`lib/facts.mjs:121`) made spaces, cut to 60 characters at a word. The file is `Inbox/<title> <YYYY-MM-DD HHmm>.md` in local time. `localTime` gives `HH:mm`; the colon cannot be in a file name, so it is left out.
- **Frontmatter (D20).** `title`, `created`, `type: note`, `status: inbox`, `tags: [capture]`, `dial_schema: dial.capture/1`, written with `writeFrontmatter`. It follows the review note (`lib/render.mjs:436-439`), without `updated`, because Dial never writes the note again.
- **Too long is refused (D21).** A cut note would lose the end of a thought without saying so. The cap is `captureChars`, 2000, the size of a voice turn.
- **What it prints (D18).** `created <path>`, or with `--json` the vault, the paths, the wikilink, the title and the text as written. The voice session reads `text` back, so the owner hears what is in the file and not what the session meant to write.
- **No home, no daily line, no program (D23).** Like `dial handoff`, capture reads the registry and writes its note. It is not in the list of commands that create the home.
- **An unknown vault names the known ones (D24).** `no vault named <x> in the registry; vaults: personal, work`. A misheard vault name is the likely voice failure, and the session can correct itself from one line. The prompt points at the `vault` values of `dial repos --json` for the names.

### 12. Capture in the voice session (D17, D26)

`Bash(dial capture:*)` joins the command list, and the prompt says to capture only on the owner's request in that turn, to write the owner's words, to ask for the vault, and to read back `text`.

This is the session's first write of words it chooses. Its other writing command is `dial sync`, which writes only what Dial derives. What bounds a capture: one new file per command, under `Inbox/` of a registered vault, at most `captureChars` characters, redacted, never over an existing note; no Dial command reads `Inbox/`; and the page shows the command as a `tool` line. D17 asks the owner whether that is enough or a capture needs a confirmation step like a session start.

The reducer does not pair a capture with its result, and there is no capture event (D26). The session's spoken read-back and the `tool` line are the record on the page. Pairing would add a second kind of card for something that is already written.

### 13. Lists that are restated (D38, D39)

- **`Read commands offer JSON output` names `capture`, `propose` and `sessions` (D38).** `add-voice-orchestrator` added two commands that take `--json` and left that requirement's list as it was, which says every other command refuses the flag. This change has to touch the list for `capture`, and it archives last, so it writes the list that is true then.
- **One requirement is removed and added back (D39).** "The voice prompt names the session's commands and how to use them" holds a scenario titled "Seven commands and no other". A `MODIFIED` block must keep every scenario title, so the requirement comes back as "The voice prompt names every command of the session and how to use it", with the scenario titled "Every listed command and no other".

### 14. Modules and seams

| Module | Holds | Pure |
|---|---|---|
| `lib/voice/gears.mjs` | gear radii, involute outline, mesh phase, escapement step | yes |
| `lib/voice/scene.mjs` | the movement's layout, the model and its reducer, the cadence, the list of parts | yes |
| `lib/voice/stage.mjs` | the frame scheduler; the Canvas 2D painter | scheduler takes `raf`, `timers`, `now`; painter takes `ctx` |
| `lib/voice/page-logic.mjs` | stage facts, status words, full screen, the Escape rule | takes `screen` |
| `lib/voice/page.js`, `page.html`, `page.css` | the canvas, the status line, the Full screen control, the tokens | — |
| `lib/voice/guard.mjs`, `server.mjs` | three static routes and files | — |
| `lib/voice/proposals.mjs` | `seconds` and `secondsLeft` on an open proposal | takes `now` |
| `lib/voice/engine.mjs`, `prompt.md` | eight commands; the capture rules | — |
| `lib/capture.mjs` | cleaning, the title, the file name, the note's bytes, the write | functions yes; `capture` writes through `lib/vault.mjs` |
| `lib/limits.mjs` | `captureChars` | — |

`bin/dial.mjs` gains the `capture` usage lines, its option-table entry and its case. `runVoice` is unchanged: the server's loader reads the three new files beside the others.

#### Interfaces

The failing tests are written before the modules, so the exports are fixed here. A module may hold more; these names and shapes are what the tests import. Names from the base keep their meaning unless a line here changes them. **Every angle in code is in radians; the specs speak in degrees.**

```js
// lib/voice/gears.mjs — pure
export const PRESSURE_ANGLE            // 20 degrees, in radians
export function gear(teeth, module)    // → { teeth, module, pitch, base, tip, root, pitchAngle }   four radii; pitchAngle = 2π / teeth
export function involute(a)            // → tan(a) − a
export function halfTooth(g, r)        // → half the angle a tooth spans at the radius r: π / (2·teeth) at the pitch radius,
//                                          wider below it along the involute, and the same below the base radius as at it
export function outline(g, { steps = 6 } = {})
//   → { points: [x, y][], flanks: [{ tooth, side, from, to }] }
//   points run counter-clockwise from the middle of the gap before tooth 0, whose centre lies on the +x axis; the last point joins the first
//   flanks: side is 'rising' or 'falling'; points[from] … points[to] are that flank, in the order of points; each flank has at least `steps` points above the base circle
//   a flank point at the radius r lies halfTooth(g, r) before the tooth's centre ('rising') or after it ('falling')
export function meshAngle(driver, driven, driverAngle, lineAngle)   // → the driven wheel's angle
//   lineAngle: the direction from the driver's centre to the driven wheel's centre
//   = lineAngle + π − driven.pitchAngle / 2 − (driverAngle − lineAngle) · driver.teeth / driven.teeth
export function escapeAngle(teeth, beats)   // → beats · π / teeth
export function balanceSide(beats)          // → 1 for an even count, −1 for an odd one

// lib/voice/scene.mjs — pure; lengths in scene units, the movement fits a box 1000 wide and 1000 high
export const BEAT_MS = 1000
export const WORDS_PER_NOTCH = 3
export const NOTCH                           // 15 degrees
export const MARK                            // 6 degrees
export const SUB_DIALS = 12
export const TRAIN_RATE                      // radians per second of the first train wheel
export const SUB_MARKS                       // { working, blocked, done, failed } → four different angles
export const MOVEMENT
//   { module, train: [{ id, teeth, x, y }]          four wheels, 'train-1' … 'train-4', each driving the next
//     escape: { teeth: 15, x, y, r }, lever: { x, y }, balance: { x, y, r, amplitude },
//     barrel: { teeth, x, y }, hand: { x, y, r }, reserve: { x, y, r }, subs: [{ x, y, r }] }   twelve subs
export function restModel()                  // → the model of a page that was not started
export function reduce(model, change, atMs)  // → a new model; the given one is left as it is; an unknown change returns it unchanged
//   change holds one key: { state } | { listening } | { heard } | { words } | { sentence: true } | { turn: true }
//                       | { sessions: string[] } | { proposal: { seconds, secondsLeft } | null } | { closed: true } | { reduced }
export function cadence(model)               // → 'run' | 'tick' | 'still'
export function scene(model, atMs)           // → part[]
//   part: { id, kind, x, y, r, angle, tone, teeth?, module?, share? }
//   id:   'barrel', 'train-1' … 'train-4', 'escape', 'lever', 'balance', 'hand', 'reserve',
//         'sub-0' … 'sub-11', and 'sub-<n>-hand' for a sub-dial that has a hand
//   kind: 'gear' | 'escape' | 'lever' | 'balance' | 'hand' | 'arc' | 'dial'
//   tone: 'live' | 'rest' | 'accent' | 'ok' | 'fail'
//   share: on 'reserve' only, 0 to 1
//   A part holds numbers and these fixed strings only.

// lib/voice/stage.mjs
export const FRAME_MS = 33
export function createStage({ draw, raf, cancelRaf, timers, now })
//   → { tell(change), hidden(on), stop(), model }
//   tell(change)   model = reduce(model, change, now()), then one frame is asked for and the cadence is followed
//   draw(parts)    called once per frame with scene(model, now())
//   raf(fn) → handle and cancelRaf(handle): the browser's requestAnimationFrame pair
//   hidden(true) cancels what is pending; hidden(false) asks for one frame; stop() cancels everything for good
export function paint(ctx, parts, { width, height, tones })
//   draws the parts on a 2D canvas context, scaled to fit width × height; tones: { ground, live, rest, accent, ok, fail } → colour strings
//   uses path, fill, stroke, transform, save and restore calls only; never fillText or strokeText

// lib/voice/page-logic.mjs — changes
export function countWords(text)             // → the number of whitespace-separated words; 0 for a blank text
export function statusText({ started, offered, muted, listening, state, reason, closed })   // → one of the eight status lines
export function createController({ Recognition, post, get, view, timers, screen })
//   also → { fullScreen(), leftFullScreen() }
//   screen: { enter() → Promise<void>, leave() → Promise<void>, active() → boolean }
//   view also: { stage(change), status(text), muted(on) }
//   The controller also sets the recognizer's onspeechstart and onspeechend properties.
//   start() calls screen.enter() before it awaits anything, and ignores a rejection. Without a screen nothing asks for full screen.

// lib/voice/page.html — ids the tests and page.js rely on
//   canvas `stage` (aria-hidden="true"), status line `status` (role="status"), buttons `start`, `mute`, `stop`, `quit`, `fullscreen`, input `turn`

// lib/voice/proposals.mjs — changes
export function createProposals({ timers, seconds, newId, on, now })
//   now() → milliseconds, Date.now when not given
//   A proposal whose status is pending or read also holds seconds and secondsLeft; `open` computes secondsLeft when it is read.

// lib/voice/guard.mjs — changes
//   checkRequest routes also: gears, scene, stage (GET; the Host check only, as for the other static files)

// test/helpers.mjs — changes
//   fakeTimers() → { timers, advance(ms), now() }   now() is the fake time in milliseconds, 0 at the start

// lib/capture.mjs
export const TITLE_CHARS = 60
export function cleanText(text)              // pure → line endings as \n, control characters other than \n and \t dropped, ends trimmed
export function noteTitle(text)              // pure → the title of a cleaned, redacted text
export function noteFile(title, at)          // pure → 'Inbox/<title> <YYYY-MM-DD HHmm>.md' in local time; at is a Date
export function renderCapture({ title, text, created })   // pure → the note's bytes
export function capture({ registry, vault, text, now, maxChars, dryRun = false, warn, beforeRename })
//   → { ok: true, vault, path, note, wikilink, title, text, written } | { ok: false, reason }
//   reason has no `dial: ` prefix. Checks, in order: empty text, length, the vault's name, the vault's directory, the note's name.
//   The text is cleaned and redacted once, here; the length is counted on the cleaned text, and the title, the file name,
//   the note and the returned `text` all come from the redacted text.
//   beforeRename is passed to applyWrites, where a test lets another writer land.
```

How the page joins the parts: `page.js` makes the canvas context, reads the tones, and creates the stage with `draw = parts => paint(ctx, parts, …)`. Its `view.stage` is `stage.tell`. It calls `stage.hidden(document.hidden)` on `visibilitychange`, `stage.tell({ reduced: query.matches })` at load and on the media query's `change` event, `controller.leftFullScreen()` on `fullscreenchange` when no element is in full screen, and `controller.stop()` on a click on the canvas.

### 15. Testing

- `gears.mjs` and `scene.mjs` are tested directly. Geometry is checked by property (the involute relation between flank points, the tooth width at the pitch circle, a tooth in a gap on the line of centres), not against stored coordinates.
- `createStage` runs against `fakeTimers`, a fake `raf` and a counting `draw`. `paint` runs against a recording context that throws on `fillText` and `strokeText`.
- The controller's new behaviour (stage facts, status words, full screen, Escape) runs against the fake recognizer and a recording `view` and `screen`.
- `page.html`, `page.css` and the scripts are checked as text: no text drawing, no colour outside the stylesheet, native controls, the focus mark, the tones, system fonts, and the contrast computed from the custom properties.
- `lib/capture.mjs` is tested directly and through the real binary against a temp vault and registry.
- How the mechanism looks, and the two browser behaviours under Risks, are manual steps (`tasks.md` H0 and H1).

### 16. Compound notes (D41)

`interlock note match` returned two notes for the files `tasks.md` names.

- N5 (`bin/dial.mjs`: a command exited 1 with nothing on stderr). Honoured: every refusal of `dial capture` in the `capture` delta names its one `dial: <reason>` line, and capture is not a report that exits 1 without one.
- N3 (`lib/agent.mjs`: `agent status` for a healthy interval agent). Does not apply (D41): `tasks.md` names `lib/agent.mjs` only as a reader of `LIMITS`, and no task edits it.

## Risks / Trade-offs

- [The base is unbuilt, so file names, exports and test files this change edits may move] → H0.2 confirms both base changes are archived and compares this change's `MODIFIED` and `REMOVED` blocks and its Interfaces with what was built.
- [Flat Canvas 2D may not look better than the owner's 3D portfolio] → the look comes from the Claude Design boards and one stylesheet; the list of parts lets a WebGL painter replace `paint` later with no change to the scene.
- [Chrome may not deliver Escape to a page in full screen] → the interrupt is tied to leaving full screen; H0.4 observes which case holds.
- [The on-device recognizer may not fire `speechstart` and `speechend`] → the barrel winds from the word count of interim results, which the base already receives; only the barrel's tone depends on those events. H0.5 observes them.
- [A request for full screen is granted only while the click is fresh] → `start()` asks for it before it awaits the recognition check.
- [A window left open all day draws every second] → one Canvas 2D frame a second, none while hidden, none under reduced motion; H1.3 reads the CPU share.
- [Text a command printed tells the session to capture] → the prompt forbids it; a capture is one bounded, redacted new note in an inbox no command reads, shown on the page as a command; D17 asks whether a confirmation is wanted.
- [A capture can put text about a work repo into the personal vault] → the vault is named in every capture and never guessed; D17.
- [A misheard note is written as heard] → the session reads back the text as written; the note is a plain file.
- [Redaction catches secret shapes, not personal prose] → stated in the README.
- [The same first line twice in one minute is refused] → the session says nothing was written.
- [`secondsLeft` reads the wall clock] → a clock change distorts the arc only; the expiry stays on its timer.
- [Three stacked changes restate the same `limits` and `cli-shell` requirements] → they archive in order; H0.2 compares the blocks with the living specs first.
- [`voiceSessionRows` raised above twelve] → the first twelve have sub-dials; the text list shows all.

## Migration Plan

1. Ship and archive `add-voice-ui`, then `add-voice-orchestrator`.
2. Run the H0 steps of this change.
3. Ship this change. No data migrates and nothing is removed. Rolling back is reverting the commit; notes already captured are ordinary files and stay.

## Open Questions

- D8: which visual direction the stage follows. The specs assume the reference palette in one stylesheet; the pick changes that file only.
- D13: whether notes Dial did not write may be sent to Claude to answer a question. The specs assume no; a yes is a later change.
- D14: whether `dial context` should print human-written sections and Daily log lines. The specs assume no.
- D17: whether a capture may be written without a confirmation step. The specs assume yes. A no would add a card and a confirm route for captures and change the `capture` and `voice-engine` deltas.
