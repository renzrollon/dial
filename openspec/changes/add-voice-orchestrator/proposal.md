# Proposal

## Why

`dial voice` (change `add-voice-ui`) answers what needs the owner, but it can only read. The owner wants to go on from the answer: say "ship that" or "spec this in katipon", have Dial start a Claude Code session in the right repo, and see each session's status and terminal output in the same window. This also answers the open question D7 of `add-voice-ui`: a spoken command may start an action, when Dial has read it back and the owner has confirmed it.

This change is built on `add-voice-ui` and ships after it. `add-voice-ui` must be implemented and archived first.

## What Changes

- **The voice session can propose a Claude Code session, and cannot start one.** A new command, `dial propose <repo> --prompt <text>`, checks the repo and the prompt and prints the proposal. It starts nothing and writes nothing. The voice session's command list grows from five to seven: `dial propose` and `dial sessions` join it.
- **Dial reads a proposal in its own words and waits for the owner.** The server shows the repo and the exact prompt on the page and reads them aloud itself. Nothing starts until the owner clicks Confirm, or says the one word `confirm` after the reading has finished. `cancel` and a Cancel control drop it. An unconfirmed proposal expires after `voiceProposalSeconds`.
- **A confirmed proposal starts a Claude Code background session.** Dial runs `claude --bg` in the repo's directory with the prompt and a name that starts with `dial: `. The session is the owner's own: their plugins, hooks, settings and permission mode apply, and it keeps running when the window closes. At most `voiceSessions` run at once, and one per repo.
- **The page lists the sessions Dial started and announces changes.** Dial reads `claude agents --json --all` every `voiceSessionPollSeconds` and sends the list to the page. A session that becomes `blocked`, `done` or `failed` is shown as a notice and spoken when Dial is idle.
- **The page shows a session's terminal output and can open it in Terminal.** A Log control shows the screen `claude logs <id>` prints, as plain text. A Terminal control opens `claude attach <id>` in a terminal window, which is where a permission prompt is answered. Stop runs `claude stop <id>`.
- **A new command, `dial sessions`,** lists the same sessions in a terminal and for the voice session.
- **Five new published caps**: `voiceSessions` 3, `voiceSessionPollSeconds` 5, `voiceSessionRows` 12, `voiceLogLines` 200 and `voiceProposalSeconds` 120. The description of `subprocessTimeoutSeconds` gains the `claude` session calls it now bounds.
- **Lists and statements are updated**: the usage text, the README and `docs/how-dial-works.md`. The README's statements that Dial only reads a repo and that its only background process is the LaunchAgent are amended.

Nothing is removed from the product. Two requirements of `add-voice-ui` are replaced under new names because their names said "five commands".

Out of scope:

- Starting a session without the owner's confirmation (open question D4).
- Choosing the permission mode, the model or the worktree isolation of a started session. Dial passes none of them (open question D7 covers isolation).
- Answering a permission prompt or a question of a session in the page. The owner attaches in Terminal.
- Sending a follow-up message to a running session.
- A terminal emulator in the page, and following a session's output live.
- Removing a session (`claude rm`), and sessions on another machine or in the cloud.
- The clockwork interface and spoken capture into the vault. Each has its own brief.

## Capabilities

### New Capabilities

- `voice-sessions`: the Claude Code sessions `dial voice` starts for the owner — the `dial propose` and `dial sessions` commands, how a proposal is shown, read aloud, confirmed, cancelled and expired, how a session is started and bounded, how the session list is read and announced, the log, stop and terminal controls, and what the page shows.

### Modified Capabilities

- `voice`: the event stream gains `proposal`, `sessions` and `notice`; while a proposal has been read aloud, the words `confirm` and `cancel` answer it and are not turns.
- `voice-engine`: the session may run seven `dial` commands; the result of `dial propose` becomes a proposal; the voice prompt says when to propose and never to claim that a session started.
- `cli-shell`: usage lists twenty-three commands; `propose` and `sessions` follow `voice`.
- `limits`: twenty-one published caps instead of sixteen.

## Impact

- Code: `bin/dial.mjs` (usage, option table, two commands, wiring into `runVoice`), `lib/limits.mjs` (five caps, one description), `lib/spawn.mjs` (a one-shot runner), `lib/voice/engine.mjs` (the command list, the reducer, the engine's events), `lib/voice/speech.mjs` (a per-sentence completion callback), `lib/voice/guard.mjs` (five routes), `lib/voice/server.mjs` (proposals, sessions, routes, events), `lib/voice/page-logic.mjs`, `lib/voice/page.js`, `lib/voice/page.html`, `lib/voice/page.css` and `lib/voice/prompt.md`. New: `lib/propose.mjs`, `lib/voice/sessions.mjs`, `lib/voice/proposals.mjs`.
- Tests: new `test/propose.test.mjs`, `test/voice-sessions.test.mjs` and `test/voice-proposals.test.mjs`; `test/spawn.test.mjs`, `test/voice-engine.test.mjs`, `test/voice-session.test.mjs`, `test/voice-speech.test.mjs`, `test/voice-guard.test.mjs`, `test/voice-server.test.mjs`, `test/voice-page.test.mjs`, `test/cli.test.mjs` and `test/limits.test.mjs` change. Pins of the command count, the cap count and the five-command list change.
- Docs: `README.md`, `docs/how-dial-works.md`.
- Runtime: needs Claude Code with background sessions (`claude --bg`, `claude agents --json`, `claude logs`, `claude stop`, `claude attach`; written against 2.1.326, where the feature is a research preview). A repo must already be trusted by Claude Code. The Terminal control works on macOS.
- A started session runs with the owner's full Claude Code permissions in that repo and counts against their plan.
- No new dependency, environment variable, hook or vault write. Dial's existing hooks run inside a started session as in any session, so the vault follows it.
- Not verified by the test suite: the real `claude --bg`, `claude agents --json` and `claude logs`. They are manual steps in `tasks.md`.
