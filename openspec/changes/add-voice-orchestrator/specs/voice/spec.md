# Spec Delta

## MODIFIED Requirements

### Requirement: Pages follow the conversation through one event stream
`GET /events` SHALL answer with `Content-Type: text/event-stream` and send each event as an `event:` line naming it and a `data:` line holding one JSON object. The events SHALL be `hello`, `state`, `user`, `sentence`, `tool`, `error`, `proposal`, `sessions`, `notice` and `bye`. Every connected page SHALL receive every event sent after it connected. A comment line SHALL be sent to every connected page every 15 seconds.

#### Scenario: Two pages see the same reply
- **WHEN** two pages are connected and the session replies with one sentence
- **THEN** both receive the same `sentence` event

#### Scenario: The form of an event
- **WHEN** the sentence `Two are open.` is sent
- **THEN** the stream carries the line `event: sentence`, the line `data: {"text":"Two are open."}` and a blank line

#### Scenario: The stream is kept open
- **WHEN** 15 seconds pass with no event
- **THEN** every connected page is sent one line starting with `:`

#### Scenario: Two pages see the same proposal and the same list
- **WHEN** two pages are connected, a proposal becomes open and the session list changes
- **THEN** both receive the same `proposal` event and the same `sessions` event

### Requirement: The page listens only while Dial is idle
After the owner has started listening with a click, the page SHALL run recognition only while the state is `idle` and listening is not muted. It SHALL post each final transcript that is not blank as a turn, with one exception: while the open proposal has the status `read`, a transcript that is the one word `confirm` or `cancel`, after trimming, lowercasing and dropping one final `.`, `!` or `?`, SHALL be posted to `/confirm` with `"spoken": true` or to `/cancel`, and not as a turn. The page SHALL start recognition again when it ends while both conditions still hold. When the state leaves `idle`, or the owner mutes, the page SHALL stop recognition and discard a transcript that is not final.

#### Scenario: A spoken turn
- **WHEN** the state is `idle`, listening is on, and recognition returns the final transcript `what needs me`
- **THEN** the page posts `{ "text": "what needs me" }` to `/turn` with the token header

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
- **WHEN** the page has loaded and the owner has not clicked the control that starts listening
- **THEN** no recognizer has been created and no microphone prompt has appeared

#### Scenario: Confirm after the reading
- **WHEN** the open proposal `ab12cd34` has the status `read` and recognition returns the final transcript `Confirm.`
- **THEN** the page posts `{ "id": "ab12cd34", "spoken": true }` to `/confirm` and posts nothing to `/turn`

#### Scenario: Cancel after the reading
- **WHEN** the open proposal `ab12cd34` has the status `read` and recognition returns the final transcript `cancel`
- **THEN** the page posts `{ "id": "ab12cd34" }` to `/cancel` and posts nothing to `/turn`

#### Scenario: Confirm before the reading is a turn
- **WHEN** the open proposal has the status `pending`, or no proposal is open, and recognition returns the final transcript `confirm`
- **THEN** the page posts `{ "text": "confirm" }` to `/turn` and nothing to `/confirm`

#### Scenario: Confirm inside a sentence is a turn
- **WHEN** the open proposal has the status `read` and recognition returns `can you confirm that`, `yes` or `confirm it`
- **THEN** the page posts the transcript to `/turn` and nothing to `/confirm`

#### Scenario: A typed word is a turn
- **WHEN** the open proposal has the status `read` and the owner types `confirm` and presses Enter
- **THEN** the page posts `{ "text": "confirm" }` to `/turn`
