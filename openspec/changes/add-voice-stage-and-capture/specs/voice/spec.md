# Spec Delta

## MODIFIED Requirements

### Requirement: The page is served from the package under a strict policy
`GET /` SHALL return the page, and `GET /page.js`, `GET /page-logic.mjs`, `GET /gears.mjs`, `GET /scene.mjs`, `GET /stage.mjs` and `GET /page.css` its five scripts and its style, each from the files Dial ships. Each reply SHALL carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'`. The page SHALL load nothing from another origin.

#### Scenario: The page and its headers
- **WHEN** `GET /?t=<token>` arrives with the right `Host`
- **THEN** the reply is 200 with `Content-Type: text/html; charset=utf-8` and the four headers above

#### Scenario: The assets are in the package
- **WHEN** `npm pack --dry-run` lists the package
- **THEN** the list holds `lib/voice/page.html`, `lib/voice/page.js`, `lib/voice/page-logic.mjs`, `lib/voice/gears.mjs`, `lib/voice/scene.mjs`, `lib/voice/stage.mjs`, `lib/voice/page.css` and `lib/voice/prompt.md`

#### Scenario: Nothing from another origin
- **WHEN** the shipped page, scripts and style are read
- **THEN** none of them holds an `http://` or `https://` address, the page holds no inline script or style, its script and style references are `/page.js` and `/page.css`, and every `import` in the five scripts names a file beside it as `./<name>.mjs`

#### Scenario: The scripts of the stage
- **WHEN** `GET /gears.mjs`, `GET /scene.mjs` or `GET /stage.mjs` arrives with the right `Host` and no token
- **THEN** the reply is 200 with `Content-Type: text/javascript; charset=utf-8`, the four headers above, and the bytes of the shipped file

### Requirement: The page shows every string as text
The page SHALL put every string it receives in a `user`, `sentence`, `tool` or `error` event into the document as text and never as markup. None of the scripts the page is served SHALL use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `eval`.

#### Scenario: A title that looks like markup
- **WHEN** a `sentence` event carries `<img src=x onerror=alert(1)> is the title.`
- **THEN** the page shows those characters and creates no element from them

#### Scenario: The scripts hold no markup sink
- **WHEN** the shipped `page.js`, `page-logic.mjs`, `gears.mjs`, `scene.mjs` and `stage.mjs` are read
- **THEN** none of them holds `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `eval(`

### Requirement: Speech is recognized on the device or not at all
The page SHALL set `processLocally` to true on every recognizer it creates and SHALL never set it to false. Before first use it SHALL ask `SpeechRecognition.available` for the `hello` language with `processLocally: true`: on `available` it listens; on `downloadable` or `downloading` it calls `SpeechRecognition.install` with the same options and listens when that resolves true. In every other case it SHALL say that on-device recognition is not offered and take typed turns only.

#### Scenario: The language pack is installed
- **WHEN** `available` resolves `available`
- **THEN** the page starts recognition with `processLocally` true and `lang` set to the `hello` language

#### Scenario: The language pack can be downloaded
- **WHEN** `available` resolves `downloadable` and `install` resolves true
- **THEN** the page starts recognition; when `install` resolves false or rejects, the page says on-device recognition is not offered and does not listen

#### Scenario: A browser without on-device recognition
- **WHEN** the browser has no `SpeechRecognition`, or it has no `available` function, or `available` resolves `unavailable`
- **THEN** the page says on-device recognition is not offered, never creates a recognizer, and still takes typed turns

#### Scenario: The scripts never ask for a server recognizer
- **WHEN** the shipped `page.js`, `page-logic.mjs`, `gears.mjs`, `scene.mjs` and `stage.mjs` are read
- **THEN** every `processLocally` they hold is set to `true`, and none of them holds `webkitSpeechRecognition`
