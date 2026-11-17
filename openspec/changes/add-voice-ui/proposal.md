# Proposal

## Why

Dial's commands and vault writes work, but every question still has to be typed into a Claude Code session. The owner wants to open a window, leave it open, ask aloud whether a pull request can merge or what needs them, hear the answer, and close the window like an app.

## What Changes

- **A new foreground command, `dial voice`.** It serves one page on `127.0.0.1`, opens it as a chromeless Chrome window, and runs until the window is closed, a Quit request arrives, or the process is interrupted. A second `dial voice` on the same port is refused.
- **A Claude Code session answers each turn.** `dial voice` starts one long-lived `claude -p` child that reads turns and writes its reply as a stream. The child runs in `<home>/voice`, loads none of the owner's hooks, plugins, skills, MCP servers, settings files or CLAUDE.md, and may run five `dial` commands and nothing else: `next`, `context`, `brief`, `sync` and `repos`. The server checks the tools, MCP servers and permission mode the session reports when it starts, and refuses to converse when they differ from what it asked for.
- **Replies are spoken sentence by sentence.** The reply stream is cut into sentences as it arrives. Each sentence is shown on the page and spoken by macOS `say`. Where `say` is absent, replies are text only.
- **The owner's speech is recognized on the device.** The page uses the browser's on-device speech recognition and never a server recognizer. Where on-device recognition is not offered, the page says so and takes typed turns. Typed turns always work.
- **The listener refuses other pages.** It binds loopback only and requires a per-launch token, a matching `Host` and, for writes, a matching `Origin`. Reply text is rendered as text, never as markup.
- **Three new published caps**: `voiceTurnSeconds` 120, `voiceCloseSeconds` 10 and `voiceTurnChars` 2000.
- **A new async child-process runner** beside the synchronous one, for a child that stays alive and takes input.
- **Lists that name every command or cap are updated**: the usage text, the README and `docs/how-dial-works.md`. The README's statements that Dial makes no network call without `--remote` and has no model session are amended to name `dial voice`.

Nothing is removed and no existing command changes behaviour. This is the first time Dial itself starts a Claude session; `dial narrate` keeps its loopback-only rule.

Out of scope:

- Running a `suggested` action on a spoken yes. The session reads, refreshes and offers drafts (D7). The follow-up change `add-voice-orchestrator` adds spoken commands.
- A background service, a LaunchAgent for the server, or an installed Dock app.
- Talking over Dial while it speaks. Recognition pauses during speech; a key or a click interrupts.
- Memory across launches. Each `dial voice` starts a new conversation; resume is used only within one run.
- A registry block for voice settings. Options are command-line flags.
- In-page speech synthesis, a wake word, and languages chosen per turn.
- A doctor check, a new plugin skill and a version bump.

## Capabilities

### New Capabilities

- `voice`: the `dial voice` command — its options, its loopback listener and request guard, the page and its events, how a reply is cut into sentences and spoken, on-device recognition, and when the command ends.
- `voice-engine`: the Claude Code session behind a voice conversation — how it is started and isolated, the commands it may run, the prompt it carries, how its event stream becomes reply text, and how a turn is bounded, interrupted and resumed.

### Modified Capabilities

- `cli-shell`: usage lists twenty-one commands; the `voice` line names its options.
- `limits`: sixteen published caps instead of thirteen.
- `dial-home`: `voice` joins the commands that create the home and ensure it first; the home gains the `voice/` directory.

## Impact

- Code: `bin/dial.mjs` (usage, option table, dispatch, injectables), `lib/limits.mjs` (three caps). New: `lib/spawn.mjs` (async child runner), `lib/voice/segment.mjs`, `lib/voice/engine.mjs`, `lib/voice/guard.mjs`, `lib/voice/speech.mjs`, `lib/voice/server.mjs`, and the shipped assets `lib/voice/page.html`, `lib/voice/page.js`, `lib/voice/page-logic.mjs`, `lib/voice/page.css` and `lib/voice/prompt.md`.
- Tests: new `test/spawn.test.mjs`, `test/voice-segment.test.mjs`, `test/voice-guard.test.mjs`, `test/voice-engine.test.mjs`, `test/voice-session.test.mjs`, `test/voice-speech.test.mjs`, `test/voice-server.test.mjs`, `test/voice-page.test.mjs` and `test/voice-prompt.test.mjs`; `test/helpers.mjs`, `test/helpers.test.mjs`, `test/cli.test.mjs`, `test/limits.test.mjs` and `test/plugin.test.mjs` change. Existing pins of the command count and the cap count change.
- Docs: `README.md`, `docs/how-dial-works.md`.
- Runtime: needs `claude` and `dial` on PATH (the session runs `dial` from PATH) and, for voice input, a browser with on-device speech recognition (Chrome 139 or later). A voice turn sends its text to Claude through the owner's own Claude Code login, as a typed prompt does today. Speech audio is not sent to a speech service.
- No new dependency, environment variable, hook or vault write. `package.json` `files` is unchanged: the assets live under `lib/`.
- Not verified by the test suite: the real `claude` handshake and real speech recognition. Both are manual steps in `tasks.md`.
