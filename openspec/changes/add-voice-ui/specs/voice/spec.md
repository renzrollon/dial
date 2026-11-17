# Spec Delta

## Purpose

The `dial voice` command: a loopback page the owner opens, leaves open and closes, that takes spoken or typed turns, shows and speaks the replies, and keeps both the listener and the owner's speech on this machine.

## ADDED Requirements

### Requirement: voice runs in the foreground until it is closed
`dial voice` SHALL run in the foreground and end when it is interrupted (SIGINT or SIGTERM), when a quit request is accepted, or when no page has been connected for `voiceCloseSeconds` after at least one page had connected. Before the first page connects it SHALL wait without a time limit. On the way out it SHALL send every connected page a `bye` event, stop any speech, end the voice session's process and close the listener. It SHALL exit 0, or 1 when the session was refused.

#### Scenario: An interrupt ends the command
- **WHEN** `dial voice` receives SIGINT while a page is connected and a sentence is being spoken
- **THEN** the page receives `bye`, the `say` process and the session's process are ended, the listener is closed, and the exit code is 0

#### Scenario: Closing the last window ends the command
- **WHEN** the only connected page disconnects and no page connects during the next `voiceCloseSeconds` (10 by default)
- **THEN** the command exits 0

#### Scenario: A reload does not end the command
- **WHEN** the only connected page disconnects and a page connects 2 seconds later
- **THEN** the command keeps running and the close timer is cleared

#### Scenario: The close time is read from the registry
- **WHEN** the registry's `limits` holds `voiceCloseSeconds: 3` and the only connected page disconnects
- **THEN** the command is still running 2 seconds later and exits 0 3 seconds after the disconnect

#### Scenario: No page has connected yet
- **WHEN** `dial voice --no-open` has been running for longer than `voiceCloseSeconds` and no page has ever connected
- **THEN** the command is still running

#### Scenario: A quit request ends the command
- **WHEN** `POST /quit` passes the request check
- **THEN** the reply is 200 with `{ "ok": true }`, and after it is sent the command exits 0

### Requirement: voice takes five options and checks them before it starts anything
`dial voice` SHALL accept `--port <n>` (default 3425), `--model <name>` (default `sonnet`), `--say-voice <name>`, `--lang <tag>` (default `en-US`) and `--no-open`, and no positional argument. A value that fails its check SHALL be refused with one reason line and exit 1 before the home is created, a port is bound or a process is started.

#### Scenario: A port out of range
- **WHEN** `dial voice --port 80`, `dial voice --port 70000` or `dial voice --port abc` is run
- **THEN** stderr is `dial: --port must be a number from 1024 to 65535: <value>` and the exit code is 1

#### Scenario: A language that is not a tag
- **WHEN** `dial voice --lang "en US"` is run
- **THEN** stderr is `dial: --lang is not a language tag: en US` and the exit code is 1; `en`, `en-US` and `zh-Hant-TW` are accepted

#### Scenario: A model or voice name that could be read as an option
- **WHEN** `dial voice --model=-p` or `dial voice --say-voice=-o` is run
- **THEN** stderr is `dial: --model is not a model name: -p` or `dial: --say-voice is not a voice name: -o`, and the exit code is 1

#### Scenario: A name made of spaces
- **WHEN** `dial voice --model " "` is run
- **THEN** the exit code is 1 and stderr starts with `dial: --model is not a model name: `; `dial voice --model=` is refused by the option parser with `dial: --model needs a value`

#### Scenario: JSON output and positionals are refused
- **WHEN** `dial voice --json` or `dial voice katipon` is run
- **THEN** the first exits 1 with `dial: unknown option: --json` and the second exits 1 with `dial: unexpected argument: katipon`

### Requirement: voice needs claude and dial on PATH
After the options are checked, `dial voice` SHALL look in the directories of `PATH` for an executable file named `claude` and one named `dial`, which the session runs. When `claude` is missing it SHALL exit 1 with `dial: claude is not on PATH`; when only `dial` is missing, with `dial: dial is not on PATH`. Neither refusal creates the home, binds a port or starts a process.

#### Scenario: claude is missing
- **WHEN** `dial voice` is run with a `PATH` that holds no executable `claude`, and the home does not exist
- **THEN** stderr is exactly `dial: claude is not on PATH`, the exit code is 1, and the home still does not exist

#### Scenario: dial is missing
- **WHEN** `node bin/dial.mjs voice` is run with a `PATH` that holds an executable `claude` and no executable `dial`
- **THEN** stderr is exactly `dial: dial is not on PATH`, the exit code is 1, and `claude` is not started

#### Scenario: A file that cannot be executed does not count
- **WHEN** the only `claude` on `PATH` is a file without the execute bit
- **THEN** the command exits 1 with `dial: claude is not on PATH`

### Requirement: The listener binds loopback on one port
`dial voice` SHALL listen on the address `127.0.0.1` only, on the port `--port` names. A port already in use SHALL be refused with `dial: port <n> is in use; another dial voice may be running`. Any other failure to listen SHALL be refused with `dial: cannot listen on 127.0.0.1:<n> (<code>: <message>)`. Both exit 1 with no process started and no window opened.

#### Scenario: The port is taken
- **WHEN** `dial voice` is run while something already listens on 127.0.0.1:3425
- **THEN** stderr is `dial: port 3425 is in use; another dial voice may be running`, the exit code is 1, and no `claude` process was started

#### Scenario: Listening is not permitted
- **WHEN** the operating system refuses the bind with `EPERM`
- **THEN** stderr is `dial: cannot listen on 127.0.0.1:3425 (EPERM: <message>)` and the exit code is 1

#### Scenario: Only loopback
- **WHEN** `dial voice` starts listening
- **THEN** the listen call names the host `127.0.0.1` and no other address

### Requirement: voice prints its address and opens one window
After it listens, `dial voice` SHALL print one stdout line `dial voice: http://127.0.0.1:<port>/?t=<token>`, the token being 32 lowercase hexadecimal characters made new for every launch. On macOS without `--no-open` it SHALL then run `open -na "Google Chrome" --args --app=<that address>`. With `--no-open`, or on another platform, it SHALL run no opener. A failed opener SHALL be one stderr warning and SHALL NOT end the command.

#### Scenario: The address line
- **WHEN** `dial voice --port 4000 --no-open` starts
- **THEN** stdout is one line matching `^dial voice: http://127\.0\.0\.1:4000/\?t=[0-9a-f]{32}$`, and two launches print different tokens

#### Scenario: The window is opened on macOS
- **WHEN** `dial voice` starts on macOS
- **THEN** `open` is run once with the arguments `-na`, `Google Chrome`, `--args` and `--app=http://127.0.0.1:3425/?t=<token>`

#### Scenario: The opener fails
- **WHEN** `open` exits non-zero because Chrome is not installed
- **THEN** stderr gains the line `dial: could not open Chrome (<first line open wrote to stderr>); open the address above in Chrome`, and the command keeps running

#### Scenario: No opener on request or off macOS
- **WHEN** `dial voice --no-open` starts, or `dial voice` starts on Linux
- **THEN** `open` is not run

### Requirement: Every request is checked before it is served
Every request SHALL carry the `Host` header `127.0.0.1:<port>`. `GET /events` SHALL carry the launch token in the `t` query parameter. Every `POST` SHALL carry the token in the `X-Dial-Token` header, the `Origin` header `http://127.0.0.1:<port>`, and a `Content-Type` of `application/json`. A request that fails a check SHALL be answered 403 (415 for the content type) with `{ "ok": false, "reason": <text> }`, and SHALL reach neither the session nor the speaker.

#### Scenario: Another site posts a turn
- **WHEN** `POST /turn` arrives with the `Origin` header `https://example.com`
- **THEN** the reply is 403, no `user` event is sent, and nothing is written to the session

#### Scenario: A request without the token
- **WHEN** `GET /events` arrives with no `t` parameter, or `POST /turn` arrives with no `X-Dial-Token` header or a wrong one
- **THEN** the reply is 403 with the reason `missing or wrong token`

#### Scenario: A rebound host name
- **WHEN** a request arrives with the `Host` header `evil.example:3425` or `localhost:3425`
- **THEN** the reply is 403 with the reason `wrong host`

#### Scenario: A form post
- **WHEN** `POST /turn` arrives with the right token and origin and the `Content-Type` `text/plain`
- **THEN** the reply is 415

#### Scenario: Unknown path or method
- **WHEN** `GET /admin` or `PUT /turn` arrives
- **THEN** the first is answered 404 and the second 405, each with an `{ "ok": false, "reason": … }` body

### Requirement: The page is served from the package under a strict policy
`GET /` SHALL return the page, and `GET /page.js`, `GET /page-logic.mjs` and `GET /page.css` its two scripts and its style, each from the files Dial ships. Each reply SHALL carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'`. The page SHALL load nothing from another origin.

#### Scenario: The page and its headers
- **WHEN** `GET /?t=<token>` arrives with the right `Host`
- **THEN** the reply is 200 with `Content-Type: text/html; charset=utf-8` and the four headers above

#### Scenario: The assets are in the package
- **WHEN** `npm pack --dry-run` lists the package
- **THEN** the list holds `lib/voice/page.html`, `lib/voice/page.js`, `lib/voice/page-logic.mjs`, `lib/voice/page.css` and `lib/voice/prompt.md`

#### Scenario: Nothing from another origin
- **WHEN** the shipped page, scripts and style are read
- **THEN** none of them holds an `http://` or `https://` address, the page holds no inline script or style, and its script and style references are `/page.js` and `/page.css`

### Requirement: A turn is text posted by a page
`POST /turn` SHALL take a JSON object `{ "text": <string> }`. The text SHALL be trimmed. An accepted turn SHALL be answered 202 with `{ "ok": true }`, sent to every connected page as a `user` event carrying the text, and written to the session. A body that is not such an object SHALL be answered 400, a text that is empty after trimming 400 with the reason `empty turn`, and a text longer than `voiceTurnChars` characters 413 with the reason `turn longer than <n> characters`.

#### Scenario: An accepted turn
- **WHEN** `POST /turn` carries `{ "text": "  can I merge katipon?  " }` while the state is `idle`
- **THEN** the reply is 202, every page receives `user` with the text `can I merge katipon?`, and the session receives that text as one turn

#### Scenario: A blank turn
- **WHEN** `POST /turn` carries `{ "text": "   " }`
- **THEN** the reply is 400 with the reason `empty turn` and no `user` event is sent

#### Scenario: A turn that is too long
- **WHEN** `POST /turn` carries a text of 2001 characters and `voiceTurnChars` is 2000
- **THEN** the reply is 413 with the reason `turn longer than 2000 characters`

#### Scenario: The turn length is read from the registry
- **WHEN** the registry's `limits` holds `voiceTurnChars: 500`
- **THEN** a text of 500 characters is answered 202, and one of 501 characters 413 with the reason `turn longer than 500 characters`

#### Scenario: A body that is not a turn
- **WHEN** `POST /turn` carries `[]`, `{ "text": 5 }`, or bytes that are not JSON
- **THEN** the reply is 400 and nothing is written to the session

### Requirement: One turn runs at a time
A turn SHALL be accepted only while no turn is running and the session was not refused. While a turn is running, `POST /turn` SHALL be answered 409 with the reason `a turn is running`; after the session was refused, 409 with `the session was refused`. A turn that arrives while sentences of a finished turn are still being spoken SHALL stop that speech and be accepted.

#### Scenario: A second turn during the first
- **WHEN** `POST /turn` arrives while the state is `thinking`
- **THEN** the reply is 409 with the reason `a turn is running`, and the running turn is not disturbed

#### Scenario: A turn over the end of a spoken reply
- **WHEN** the session has ended its turn, two sentences are still waiting to be spoken, and `POST /turn` arrives
- **THEN** the running `say` process is ended, the waiting sentences are discarded, and the new turn is accepted with 202

#### Scenario: A turn after the session was refused
- **WHEN** `POST /turn` arrives while the state is `refused`
- **THEN** the reply is 409 with the reason `the session was refused`, and no `user` event is sent

### Requirement: Pages follow the conversation through one event stream
`GET /events` SHALL answer with `Content-Type: text/event-stream` and send each event as an `event:` line naming it and a `data:` line holding one JSON object. The events SHALL be `hello`, `state`, `user`, `sentence`, `tool`, `error` and `bye`. Every connected page SHALL receive every event sent after it connected. A comment line SHALL be sent to every connected page every 15 seconds.

#### Scenario: Two pages see the same reply
- **WHEN** two pages are connected and the session replies with one sentence
- **THEN** both receive the same `sentence` event

#### Scenario: The form of an event
- **WHEN** the sentence `Two are open.` is sent
- **THEN** the stream carries the line `event: sentence`, the line `data: {"text":"Two are open."}` and a blank line

#### Scenario: The stream is kept open
- **WHEN** 15 seconds pass with no event
- **THEN** every connected page is sent one line starting with `:`

### Requirement: A page that connects is told the settings and the state
A page that connects to `GET /events` SHALL first receive `hello` with `lang`, `model` and `speech` (true when replies will be spoken), and then `state` with the current state. It SHALL receive no event that was sent before it connected.

#### Scenario: The first two events
- **WHEN** a page connects to `dial voice --lang en-GB --model opus` on a machine with `say`
- **THEN** its first event is `hello` with `{ "lang": "en-GB", "model": "opus", "speech": true }` and its second is `state`

#### Scenario: A page that connects late
- **WHEN** a page connects while the state is `speaking`
- **THEN** it receives `hello`, then `state` with `{ "state": "speaking" }`, and then only events sent after it connected

### Requirement: The state follows the session, the turn and the speech
The state SHALL be `refused` once the session was refused, `speaking` while a sentence is spoken or waits to be spoken, `thinking` while a turn runs and no sentence is spoken or waits, and `idle` otherwise. Each change SHALL be sent as one `state` event `{ "state": <name> }`, which for `refused` also carries `"reason"`. No `state` event SHALL repeat the one before it, and an accepted turn SHALL always be followed by one that is not `idle`.

#### Scenario: The payloads
- **WHEN** the state becomes `thinking`, and later the session is refused with the reason `it has MCP servers: github`
- **THEN** the events carry exactly `{ "state": "thinking" }` and `{ "state": "refused", "reason": "it has MCP servers: github" }`

#### Scenario: A spoken reply
- **WHEN** a turn is accepted, the session replies with two sentences and ends the turn, and `say` speaks both
- **THEN** the pages receive the states `thinking`, `speaking` and `idle` in that order, `idle` only after the second `say` process has exited

#### Scenario: A reply that is only shown
- **WHEN** `say` is not on PATH and a turn is accepted and ends
- **THEN** the pages receive `thinking` and then `idle`, and never `speaking`

#### Scenario: A command between two sentences
- **WHEN** the session says one sentence, runs a command for 5 seconds, then says another
- **THEN** the state is `speaking` while the first sentence is spoken, `thinking` until the second arrives, and `speaking` again

### Requirement: A reply is cut into sentences as it arrives
Reply text SHALL be cut into sentences in order, each trimmed and none empty. A sentence SHALL end at a run of `.`, `!` or `?`, with any closing quote or bracket after it, when whitespace follows; and at a line break. A `.` with nothing but digits before it in its sentence (a list number) SHALL NOT end the sentence. Text after the last boundary SHALL wait for more text and SHALL be emitted when the text block or the turn ends.

#### Scenario: Two sentences in one piece of text
- **WHEN** the text `You have two open pull requests. Number 41 can merge.` arrives and the turn ends
- **THEN** the sentences are `You have two open pull requests.` and `Number 41 can merge.`

#### Scenario: A sentence is emitted before the reply is complete
- **WHEN** the text `Number 41 can merge. Number 38` has arrived and the turn has not ended
- **THEN** `Number 41 can merge.` has been emitted and `Number 38` has not

#### Scenario: A full stop inside a number
- **WHEN** the text arrives as the two pieces `Dial is at 0.` and `2.0 today. Done.`
- **THEN** the sentences are `Dial is at 0.2.0 today.` and, when the turn ends, `Done.`

#### Scenario: Closing marks stay with their sentence
- **WHEN** the text `It says "wait." Then (maybe?) it merges.` arrives and the turn ends
- **THEN** the sentences are `It says "wait."` and `Then (maybe?) it merges.`

#### Scenario: Line breaks and blank lines
- **WHEN** the text `First line\n\nSecond line` arrives and the turn ends
- **THEN** the sentences are `First line` and `Second line`

#### Scenario: A list number stays with its line
- **WHEN** the text `1. review and merge\n2. archive the change` arrives and the turn ends
- **THEN** the sentences are `1. review and merge` and `2. archive the change`

#### Scenario: Several marks end one sentence
- **WHEN** the text `Really?! Yes... it merged.` arrives and the turn ends
- **THEN** the sentences are `Really?!`, `Yes...` and `it merged.`

#### Scenario: The end of a text block
- **WHEN** the session writes the text `Let me check` and then runs a command
- **THEN** `Let me check` is emitted when the text block ends, before the command's result

#### Scenario: Nothing is lost or reordered
- **WHEN** any reply with no run over 300 characters is cut
- **THEN** the sentences joined by single spaces equal the reply with every run of whitespace replaced by one space and the ends trimmed

### Requirement: A long run without a sentence end is cut at 300 characters
Text that reaches 300 characters with no sentence end SHALL be cut at its last whitespace, or at 300 characters when it holds none, and the cut part SHALL be emitted as a sentence without waiting for more text.

#### Scenario: A long run without a boundary
- **WHEN** 700 characters of words separated by single spaces arrive with no `.`, `!`, `?` or line break
- **THEN** every emitted sentence is at most 300 characters, each cut falls on a space, and no word is split

#### Scenario: One unbroken token
- **WHEN** 650 characters arrive with no whitespace at all
- **THEN** two sentences of 300 characters are emitted at once, and the last 50 characters wait for the end of the turn

### Requirement: A sentence is shown as written and spoken in a plain form
Each sentence SHALL be sent to the pages as written, in a `sentence` event `{ "text": <sentence> }`. Its spoken form SHALL drop `*`, `` ` `` and `~`, turn `_` into a space, drop a leading `#`, `>`, `-`, `+` or `<digits>.` mark with the space after it, replace a link `[label](address)` by its label and a bare `http://` or `https://` address by the word `link`, and collapse whitespace. A sentence whose spoken form holds no letter and no digit SHALL be shown and not spoken.

#### Scenario: Emphasis and code marks
- **WHEN** the sentence is ``**Number 41** is `ready`, needs_me is false.``
- **THEN** the `sentence` event carries it unchanged and the spoken form is `Number 41 is ready, needs me is false.`

#### Scenario: A link and a bare address
- **WHEN** the sentence is `See [the pull request](https://github.com/x/y/pull/41) or https://example.com/a.`
- **THEN** the spoken form is `See the pull request or link`

#### Scenario: A list line
- **WHEN** the sentences are `- review and merge` and `2. archive the change`
- **THEN** the spoken forms are `review and merge` and `archive the change`

#### Scenario: Nothing to say
- **WHEN** the sentence is `---` or three backticks
- **THEN** it is sent as a `sentence` event and no `say` process is started for it

### Requirement: Sentences are spoken by say, one at a time and in order
When an executable `say` is on `PATH`, each spoken form SHALL be written to the standard input of one `say` process, started with the arguments `-v <name>` when `--say-voice` was given and with no argument otherwise. The next sentence SHALL start when the process before it has exited. Stopping speech SHALL end the running process and discard every sentence waiting.

#### Scenario: Sentences in order
- **WHEN** three sentences are emitted while the first is still being spoken
- **THEN** three `say` processes run one after another, each receiving one sentence on its standard input, in the order emitted

#### Scenario: A named voice
- **WHEN** `dial voice --say-voice "Zoe (Premium)"` speaks a sentence
- **THEN** `say` is started with exactly the arguments `-v` and `Zoe (Premium)`

#### Scenario: Text is never an argument
- **WHEN** the spoken form is `-v Bad News is the title.`
- **THEN** `say` is started with no argument that holds that text, and receives it on standard input

#### Scenario: Stopping discards what waits
- **WHEN** speech is stopped while the first of three sentences is being spoken
- **THEN** the running `say` process is ended and no process is started for the other two

### Requirement: Without say, or after say fails, replies are only shown
When no executable `say` is on `PATH`, `hello` SHALL carry `speech: false` and no sentence SHALL be spoken. When a `say` process that was not stopped exits non-zero, the server SHALL send one `error` event carrying the first line that process wrote to stderr, and SHALL speak nothing for the rest of the run. Sentences SHALL be shown in both cases.

#### Scenario: A machine without say
- **WHEN** `dial voice` runs with a `PATH` that holds no `say`
- **THEN** `hello` carries `speech: false`, every sentence is sent as a `sentence` event, and no process is started to speak

#### Scenario: An unknown voice
- **WHEN** `say -v Nobody` exits 1 after writing ``Voice `Nobody' not found.`` to stderr
- **THEN** the pages receive one `error` event with that line as its `message`, and the later sentences of the run are shown and not spoken

#### Scenario: A stopped sentence is not a failure
- **WHEN** speech is stopped and the ended `say` process reports a signal or a non-zero exit
- **THEN** no `error` event is sent and the next reply is spoken

### Requirement: An interrupt stops speech and an unfinished turn
`POST /interrupt` SHALL stop speech and discard reply text not yet emitted as a sentence. When a turn is running it SHALL end that turn, after which no sentence of it is shown or spoken. The reply SHALL be 200 with `{ "ok": true }`, and the state afterwards SHALL be `idle` unless it is `refused`. The server SHALL NOT read the body of `POST /interrupt` or `POST /quit`; the page sends `{}`.

#### Scenario: The body is not read
- **WHEN** `POST /interrupt` or `POST /quit` passes the request check with the body `{}`, with no body, or with bytes that are not JSON
- **THEN** each is answered as the requirement says, and none is answered 400

#### Scenario: An interrupt after the turn has ended
- **WHEN** `POST /interrupt` arrives while the last sentences of a finished turn are being spoken
- **THEN** speech stops, the state becomes `idle`, and the session's process is left running

#### Scenario: An interrupt during a turn
- **WHEN** `POST /interrupt` arrives while the session is still writing its reply
- **THEN** speech stops, the turn is ended, text the session writes afterwards reaches no page, and the state becomes `idle`

#### Scenario: An interrupt with nothing to stop
- **WHEN** `POST /interrupt` arrives while the state is `idle`
- **THEN** the reply is 200 and no event is sent

### Requirement: The page shows every string as text
The page SHALL put every string it receives in a `user`, `sentence`, `tool` or `error` event, and every reason, into the document as text and never as markup. Its scripts SHALL NOT use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `eval`.

#### Scenario: A title that looks like markup
- **WHEN** a `sentence` event carries `<img src=x onerror=alert(1)> is the title.`
- **THEN** the page shows those characters and creates no element from them

#### Scenario: The scripts hold no markup sink
- **WHEN** the shipped `page.js` and `page-logic.mjs` are read
- **THEN** neither holds `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `eval(`

### Requirement: Speech is recognized on the device or not at all
The page SHALL set `processLocally` to true on every recognizer it creates and never to false. When the owner clicks Start it SHALL ask `SpeechRecognition.available` for the `hello` language with `processLocally: true`: on `available` it listens; on `downloadable` or `downloading` it calls `install` with the same options and listens when that resolves true. Otherwise the status line SHALL say `Typed turns only` and the notice `on-device speech recognition is not offered for <lang>`.

#### Scenario: The language pack is installed
- **WHEN** `available` resolves `available`
- **THEN** the page starts recognition with `processLocally` true, `interimResults` true and `lang` set to the `hello` language

#### Scenario: The language pack can be downloaded
- **WHEN** `available` resolves `downloadable` and `install` resolves true
- **THEN** the page starts recognition; when `install` resolves false or rejects, the page says on-device recognition is not offered and does not listen

#### Scenario: A browser without on-device recognition
- **WHEN** the browser has no `SpeechRecognition`, or it has no `available` function, or `available` resolves `unavailable`
- **THEN** the status line says `Typed turns only`, the notice says `on-device speech recognition is not offered for en-US`, no recognizer is created, and typed turns are still posted

#### Scenario: The scripts never ask for a server recognizer
- **WHEN** the shipped `page.js` and `page-logic.mjs` are read
- **THEN** every `processLocally` they hold is set to `true`, and neither holds `webkitSpeechRecognition`

### Requirement: A microphone that cannot be used leaves typed turns
When the recognizer reports an `error` other than `no-speech` or `aborted`, the page SHALL stop listening, set the status line to `Typed turns only`, and show a notice ending with the code in brackets: `the microphone was not allowed` for `not-allowed` and `service-not-allowed`, `no microphone could be used` for `audio-capture`, and `speech recognition failed` otherwise. Nothing SHALL be retried until Start is clicked again. `no-speech` and `aborted` are ends with no result.

#### Scenario: The owner does not allow the microphone
- **WHEN** the owner clicks Start, then Don't Allow, and the recognizer reports the error `not-allowed` and ends
- **THEN** the status line says `Typed turns only`, the notice says `the microphone was not allowed (not-allowed)`, recognition is not started again, and `available` is not called again

#### Scenario: No microphone
- **WHEN** the recognizer reports the error `audio-capture`
- **THEN** the notice says `no microphone could be used (audio-capture)` and recognition is not started again

#### Scenario: Silence is not a failure
- **WHEN** the recognizer reports the error `no-speech` and ends while the state is `idle` and listening is not muted
- **THEN** no notice is shown and recognition is started again

#### Scenario: Another code
- **WHEN** the recognizer reports the error `language-not-supported`
- **THEN** the notice says `speech recognition failed (language-not-supported)` and recognition is not started again

#### Scenario: Typing still works
- **WHEN** recognition was stopped by `not-allowed` and the owner types `what needs me` and presses Enter
- **THEN** the page posts that text to `/turn`

#### Scenario: Start again
- **WHEN** recognition was stopped by `not-allowed` and the owner clicks Start again
- **THEN** the page calls `available` once more and follows "Speech is recognized on the device or not at all"

### Requirement: The page listens only while Dial is idle
After the owner has clicked Start, the page SHALL run recognition only while the state is `idle`, listening is not muted, the event stream is connected, and no turn it posted is in flight. It SHALL post each final transcript that is not blank as a turn, and SHALL start recognition again when it ends while every condition still holds. When the state leaves `idle`, or the owner mutes, the page SHALL stop recognition and discard a transcript that is not final.

#### Scenario: A spoken turn
- **WHEN** the state is `idle`, listening is on, and recognition returns the final transcript `what needs me`
- **THEN** the page stops recognition and posts `{ "text": "what needs me" }` to `/turn` with the token header

#### Scenario: Dial does not hear itself
- **WHEN** the state becomes `thinking` or `speaking`
- **THEN** recognition is stopped, and it starts again only when the state is `idle`

#### Scenario: Silence ends recognition
- **WHEN** recognition ends with no result while the state is `idle` and listening is not muted
- **THEN** the page starts recognition again

#### Scenario: Mute
- **WHEN** the owner mutes while recognition is running
- **THEN** recognition stops and does not start again until the owner unmutes

#### Scenario: Before the first click
- **WHEN** the page has loaded and the owner has not clicked Start
- **THEN** no recognizer has been created and no microphone prompt has appeared

### Requirement: A posted turn holds the microphone
A turn the page posts SHALL be in flight from the moment it is posted until the post is answered with a status other than 202 or fails, or, after a 202, until the page has received a `state` event other than `idle` since it posted. Posting SHALL stop recognition at once, and the page SHALL post no other turn while one is in flight.

#### Scenario: Posting takes the microphone
- **WHEN** the page has posted a turn, the post has been answered 202, and the next event received is still the earlier `state` `idle`, or recognition ends
- **THEN** recognition is not started again and no second turn is posted until a `state` event of `thinking`, `speaking` or `refused` has arrived

#### Scenario: A refused post gives the microphone back
- **WHEN** the page posts a turn and the post is answered 409, 400 or 413, or fails with no answer, while the state is `idle` and listening is not muted
- **THEN** the page starts recognition again

### Requirement: Interim speech is shown while the owner speaks
The page SHALL show the latest transcript that is not final as interim text while recognition runs. It SHALL clear the interim text when the final transcript is posted, when the state leaves `idle`, and when the owner mutes. Interim text SHALL never be posted.

#### Scenario: Words appear as they are heard
- **WHEN** recognition returns the non-final transcripts `what` and then `what needs`
- **THEN** the interim text is `what` and then `what needs`, and nothing is posted

#### Scenario: The final transcript replaces it
- **WHEN** recognition returns the final transcript `what needs me` after the interim `what needs`
- **THEN** the interim text is cleared and `what needs me` is posted

#### Scenario: Interim speech is dropped
- **WHEN** the interim text is `what needs` and the state becomes `speaking`, or the owner mutes
- **THEN** the interim text is cleared and nothing is posted

### Requirement: The status line says what Dial is doing
The page SHALL have one status line holding exactly one text, the first that applies: `Closed` (after `bye`, or a stream that could not be reconnected), `Refused: <reason>`, `Thinking: running <command>` (state `thinking` after a `tool` event of the running turn, naming the last command), `Thinking` (state `thinking`, or a turn in flight), `Speaking`, `Typed turns only` (recognition not offered or stopped by an error), `Not started` (before Start), `Muted`, and `Listening`.

#### Scenario: The texts of one sitting
- **WHEN** the page loads, the owner clicks Start, mutes, unmutes, asks a question, the session runs `dial sync katipon --remote --json` and answers aloud, and the owner then clicks Quit
- **THEN** the status line says `Not started`, `Listening`, `Muted`, `Listening`, `Thinking`, `Thinking: running dial sync katipon --remote --json`, `Speaking`, `Listening` and `Closed`, in that order

#### Scenario: A refused session
- **WHEN** a `state` event `{ "state": "refused", "reason": "it has tools other than Bash: Read" }` arrives
- **THEN** the status line says `Refused: it has tools other than Bash: Read`

### Requirement: An error stays on the page until the next turn
The page SHALL show the message of the latest `error` event, and the reason of the latest post answered with a status other than 2xx, on an error line beside the status line, and SHALL keep it there until a later turn is answered 202. A newer error SHALL replace an older one. Errors SHALL NOT be spoken.

#### Scenario: An error stays until the next turn
- **WHEN** an `error` event `the turn was stopped after 120 seconds` arrives, the state becomes `idle`, and 60 seconds pass
- **THEN** the error line still says `the turn was stopped after 120 seconds`, and it is cleared when the next turn is answered 202

#### Scenario: A new error replaces the old
- **WHEN** an `error` event arrives while the error line shows an earlier one
- **THEN** the error line shows only the newer message

### Requirement: The page can be used from the keyboard and a screen reader
The page's controls SHALL be `button` elements with visible names, its text field SHALL have a `label`, its status line SHALL carry `role="status"` and its error line `role="alert"`, and the Mute control SHALL carry `aria-pressed` matching the mute. Escape SHALL be handled by one `keydown` listener on the document, so that it works while the text field has focus. When the state becomes `refused`, focus SHALL move to the status line.

#### Scenario: The markup
- **WHEN** the shipped `page.html` is read
- **THEN** it holds `button` elements with the ids `start`, `mute`, `stop` and `quit` reading `Start`, `Mute`, `Stop` and `Quit`, an `input` with the id `turn` and a `label` reading `Ask Dial`, `role="status"` on the element `status`, `role="alert"` on the element `error`, an element `transcript`, and `aria-pressed="false"` on `mute`

#### Scenario: Mute is marked
- **WHEN** the owner clicks Mute and then clicks it again
- **THEN** `aria-pressed` on `mute` is `true` and then `false`

#### Scenario: Escape from the text field
- **WHEN** the text field has focus, holds `what ne`, and the owner presses Escape while the state is `speaking`
- **THEN** the page posts `/interrupt` and the field still holds `what ne`

#### Scenario: Focus on a refusal
- **WHEN** the state becomes `refused`
- **THEN** focus moves to the status line

### Requirement: The transcript tells who said what
Every `user`, `sentence`, `tool` and `error` event SHALL become one transcript line of that kind, carrying the class `line-<kind>` and the visible label `You`, `Dial`, `Ran` or `Error` before its text, so that the kinds differ in words and not only in colour. Under its title the page SHALL say what Dial voice is for, and the empty transcript SHALL suggest a first question.

#### Scenario: Four kinds of line
- **WHEN** the events `user` `what needs me`, `tool` `dial next --json`, `sentence` `Two things need you.` and `error` `the turn failed: error_during_execution` arrive
- **THEN** the transcript holds four lines, labelled `You`, `Ran`, `Dial` and `Error`, with the classes `line-user`, `line-tool`, `line-sentence` and `line-error`

#### Scenario: The empty transcript
- **WHEN** the page has loaded and no line has arrived
- **THEN** the page shows `Ask Dial aloud while you work: it checks your repos and answers in a sentence.` under its title, and the transcript shows `Ask what needs you, or whether a pull request can merge. Try: "what needs me?"`, which is gone once the first line arrives

### Requirement: The page offers typed turns, stop and quit
The page SHALL offer a text field that posts its content as a turn when the owner presses Enter, a Stop control and the Escape key that post `/interrupt` with the body `{}`, and a Quit control that posts `/quit` with the body `{}`. A turn answered 202 SHALL clear the field. A turn answered with any other status SHALL keep the text in the field and put the answer's reason on the error line. When the page receives `bye` it SHALL stop recognition, show `Closed`, and post nothing further.

#### Scenario: A typed turn
- **WHEN** the owner types `what needs me` and presses Enter while the state is `idle`
- **THEN** the page posts that text to `/turn` and clears the field when the answer is 202

#### Scenario: Escape stops Dial
- **WHEN** the owner presses Escape while the state is `speaking`
- **THEN** the page posts `{}` to `/interrupt`

#### Scenario: A refused turn is shown
- **WHEN** `/turn` answers 409 with the reason `a turn is running`, 400 with `empty turn`, or 413 with `turn longer than 2000 characters`
- **THEN** the error line shows that reason and the typed text stays in the field

#### Scenario: Quit
- **WHEN** the owner clicks Quit
- **THEN** the page posts `{}` to `/quit`, and on the `bye` that follows it shows `Closed` and stops recognition

#### Scenario: The server is gone
- **WHEN** the page receives `bye`
- **THEN** it stops recognition, shows `Closed`, and posts nothing further

### Requirement: The page reconnects to a lost event stream
When the event stream fails, the page SHALL stop recognition and open the stream again 500 milliseconds later and, while each new stream fails before it delivers `hello`, 1000 and then 2000 milliseconds after that failure. A stream that delivers `hello` SHALL reset the count, show the notice `Reconnected; anything said while the page was away is not shown`, and be followed by its `state`. No missed event is asked for. After the third retry fails, the page SHALL show `Closed` and post nothing.

#### Scenario: A dropped stream comes back
- **WHEN** the stream fails while the state is `speaking`, and the stream opened 500 milliseconds later delivers `hello` and `state` `idle`
- **THEN** the notice says `Reconnected; anything said while the page was away is not shown`, no sentence sent while the page was away is shown, and the page listens again

#### Scenario: The server is gone for good
- **WHEN** the stream fails and the streams opened 500, 1000 and 2000 milliseconds after each failure fail before `hello`
- **THEN** the status line says `Closed`, no fourth stream is opened, and recognition is not running

#### Scenario: The server keeps a reconnecting page
- **WHEN** a page's stream drops and the page connects again within `voiceCloseSeconds`
- **THEN** the command keeps running, and the page's first two events are `hello` and `state` with the current state
