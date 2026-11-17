# Proposal

## Why

The `dial voice` page that `add-voice-ui` and `add-voice-orchestrator` specify is a plain transcript with controls. It is meant to be left open all day, and the owner wants to read Dial's state at a glance from across the room: a full-screen clockwork whose every moving part means something. The owner also wants the assistant to be a second brain, and today it cannot take a note: it answers only from Dial's own ledger.

The owner asked for both in one change. It is built on `add-voice-ui` and then `add-voice-orchestrator`, and ships after both are implemented and archived.

## What Changes

**The clockwork stage**

- **The page gains a mechanism drawn on a canvas.** A balance and escape wheel, a going train, a mainspring barrel, a hand, a power-reserve arc and a ring of twelve sub-dials. It is hand-written Canvas 2D with no dependency and no change to the page's security policy.
- **Each part shows one thing.** The balance swings while Dial can hear the owner. The barrel winds as the owner speaks. The train runs while Dial thinks or speaks. The hand sweeps with each spoken sentence. Each sub-dial is one session. The reserve arc drains while a proposal waits.
- **The gears are real gears.** Tooth flanks are involutes of the base circle, meshing wheels turn in ratio with a tooth in a gap, and the escape wheel advances half a tooth for each beat. Tests check this, not the eye.
- **It draws only as often as its motion needs.** One frame a second at rest, up to 30 a second while Dial works, none while the window is hidden. With `prefers-reduced-motion` nothing animates.
- **Everything the mechanism shows is also text.** The canvas holds no text and is hidden from assistive technology. Every control is a native button or field with a visible focus mark.
- **The window goes full screen** on the click that starts listening, with a control to leave and enter it. Leaving full screen stops Dial, as Escape does, and so does a click on the mechanism.
- **Three more scripts are served** (`/gears.mjs`, `/scene.mjs`, `/stage.mjs`), and the checks that the page's scripts hold no markup sink and no server recognizer cover every served script.
- **An open proposal says how long it has left**: its event gains `seconds` and `secondsLeft`, which the reserve arc shows.
- **Colours, type and spacing live in one stylesheet** as custom properties. The scripts hold no colour. The owner's pick from the Claude Design output (D8) changes that stylesheet and nothing else.

**Spoken capture**

- **A new command, `dial capture --vault <name> (--stdin | --text <t>) [--dry-run] [--json]`,** writes one new note under `Inbox/` of a registered vault. The text is cleaned, redacted and bounded by a new cap. The note's name is its first line and the local date and time. A name that exists is refused: capture never overwrites, appends or deletes.
- **The voice session may run it.** Its command list grows from seven to eight. The voice prompt says to capture only when the owner asks in that turn, to ask which vault when the owner did not say, and to read back what was written.
- **One new published cap**: `captureChars` 2000.
- **Lists and statements are updated**: the usage text, the README and `docs/how-dial-works.md`.

Nothing is removed from the product. One requirement of `add-voice-orchestrator` is replaced under a new name because one of its scenarios is titled "Seven commands".

With this change the voice session can, for the first time, put words of its own choosing into a vault: one bounded note per command, into an inbox. Until now its only write was `dial sync`, which writes what Dial derives from facts, and `add-voice-orchestrator` said the session only reads and drafts. D17 asks the owner whether a capture may be written without a confirmation step.

Out of scope:

- Answering from notes Dial did not write, and registering the vaults that hold them (D13).
- Adding human-written sections or Daily log lines to `dial context` (D14).
- A confirmation card for a capture (D17 asks).
- WebGL, 3D, lighting, sound, and a live audio level from the microphone.
- Choosing the final palette, type and layout. That is the owner's pick from the Claude Design output (D8).
- Editing, moving or listing captured notes, and an Obsidian template for them.

## Capabilities

### New Capabilities

- `voice-stage`: the clockwork interface of the `dial voice` page — the gear geometry and motion, what each part of the movement shows, how often it draws, reduced motion, the rule that everything shown is also text, full screen, and where its colours come from.
- `capture`: the `dial capture` command — what it takes, the note it writes under `Inbox/`, how the text is cleaned, redacted and bounded, and what it refuses.

### Modified Capabilities

- `voice`: the page is served three more scripts; the checks for markup sinks and for a server recognizer cover every served script.
- `voice-engine`: the session may run eight `dial` commands; the voice prompt names `dial capture` and says when and how to capture.
- `voice-sessions`: the event of an open proposal carries `seconds` and `secondsLeft`.
- `cli-shell`: usage lists twenty-four commands, `capture` after `handoff`; `capture`, `propose` and `sessions` are named among the commands that accept `--json`.
- `limits`: twenty-two published caps instead of twenty-one.

## Impact

- Code: new `lib/voice/gears.mjs`, `lib/voice/scene.mjs`, `lib/voice/stage.mjs` and `lib/capture.mjs`. Changed: `bin/dial.mjs` (usage, option table, the `capture` command), `lib/limits.mjs` (one cap), `lib/voice/page-logic.mjs`, `lib/voice/page.js`, `lib/voice/page.html`, `lib/voice/page.css`, `lib/voice/guard.mjs` (three routes), `lib/voice/server.mjs` (three static files, the proposal event), `lib/voice/proposals.mjs` (the time left), `lib/voice/engine.mjs` (the command list) and `lib/voice/prompt.md`.
- Tests: new `test/voice-gears.test.mjs`, `test/voice-scene.test.mjs`, `test/voice-stage.test.mjs` and `test/capture.test.mjs`; `test/helpers.mjs`, `test/voice-page.test.mjs`, `test/voice-guard.test.mjs`, `test/voice-server.test.mjs`, `test/voice-proposals.test.mjs`, `test/voice-engine.test.mjs`, `test/cli.test.mjs`, `test/limits.test.mjs` and `test/plugin.test.mjs` change. Pins of the command count, the cap count, the eight-command list, the route list and the pack list change.
- Docs: `README.md`, `docs/how-dial-works.md`.
- Runtime: the Fullscreen API and Canvas 2D of the Chrome window `dial voice` already opens. No new dependency, environment variable, hook, header or port.
- Vault: `dial capture` writes new notes under `Inbox/`, a folder already inside the write boundary. A spoken note reaches Claude as every voice turn does, before it is written.
- Not verified by the test suite: how the mechanism looks, whether the Escape key event reaches a page in full screen, and whether the on-device recognizer fires its speech events. They are manual steps in `tasks.md`.
