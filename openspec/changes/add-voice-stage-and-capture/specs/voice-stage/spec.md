# Spec Delta

## Purpose

The clockwork interface of the `dial voice` page: a mechanism drawn on a canvas whose parts show whether Dial can hear the owner, what it is doing, each session it started and how long a proposal has left. It covers how the gears are shaped and move, how often the mechanism draws, and the rule that everything it shows is also text.

## ADDED Requirements

### Requirement: A gear's teeth are involutes of its base circle
A gear of `z` teeth and module `m` SHALL have the pitch radius `m·z/2`, the base radius `pitch radius × cos 20°`, the tip radius `pitch radius + m` and the root radius `pitch radius − 1.25·m`. Each tooth flank SHALL follow the involute of the base circle up to the tip circle, and SHALL be a radial line where it lies below the base circle. A tooth SHALL be half a pitch wide at the pitch circle.

#### Scenario: The four radii
- **WHEN** a gear has 40 teeth and the module 2
- **THEN** its pitch radius is 40, its base radius is 37.5877 to four decimal places, its tip radius is 42 and its root radius is 37.5

#### Scenario: A flank is an involute
- **WHEN** any point of a flank that lies above the base circle is taken, at the radius `r`
- **THEN** its angle from the point where that flank leaves the base circle is `tan a − a` with `a = acos(base radius / r)`, within 0.000000001 radian

#### Scenario: Half a pitch at the pitch circle
- **WHEN** the two flanks of one tooth cross the pitch circle
- **THEN** the angle between the two crossings is `180/z` degrees

#### Scenario: Every tooth is the same
- **WHEN** the outline of a gear of `z` teeth is turned by `360/z` degrees
- **THEN** it lies on itself

#### Scenario: A small pinion
- **WHEN** a gear has 8 teeth, so that its root circle lies inside its base circle
- **THEN** each flank is a radial line from the root circle to the base circle and an involute above it, and no point of the outline lies inside the root circle or outside the tip circle

#### Scenario: The outline does not cross itself
- **WHEN** the points of an outline are read in order
- **THEN** their angle around the centre never decreases, and the last point joins the first

### Requirement: Meshing wheels turn in ratio with a tooth in a gap
The going train SHALL be four wheels, each driving the next. Two wheels that mesh SHALL have the same module and centres one pitch radius plus the other apart. The driven wheel SHALL turn the other way, by the driver's angle times the driver's teeth over its own, and SHALL stand so that where the driver has a tooth centred on the line between the two centres, the driven wheel has a gap centred on it.

#### Scenario: Ratio and direction
- **WHEN** a wheel of 60 teeth drives a wheel of 20 teeth and turns by 10 degrees
- **THEN** the driven wheel turns by 30 degrees the other way

#### Scenario: A tooth meets a gap
- **WHEN** the driver stands with a tooth centred on the line between the centres, the line pointing at 0, 37 or 180 degrees
- **THEN** the driven wheel has a gap centred on that line, and still has one after the driver has turned by one whole pitch

#### Scenario: Every pair of the train sits at its centre distance
- **WHEN** the four wheels of the train are laid out
- **THEN** the centres of each meshing pair are apart by the sum of their pitch radii, within 0.000000001 of a unit, and two wheels that do not mesh are farther apart than the sum of their tip radii

#### Scenario: The train follows its first wheel
- **WHEN** the first wheel of the train stands at any angle
- **THEN** the angle of each later wheel follows from the wheel that drives it by this rule

### Requirement: The escape wheel advances half a tooth for each beat
The escape wheel of `z` teeth SHALL stand still between beats and advance `180/z` degrees at each beat. The balance SHALL change side at each beat and stand at plus or minus its amplitude between beats, and the lever SHALL stand on the balance's side. A beat SHALL last one second.

#### Scenario: Two beats pass one tooth
- **WHEN** two beats have passed on an escape wheel of 15 teeth
- **THEN** the wheel has advanced 24 degrees

#### Scenario: Still between beats
- **WHEN** the mechanism is read 0.2 seconds and 0.9 seconds after the same beat
- **THEN** the escape wheel, the lever and the balance stand at the same angles both times

#### Scenario: The balance changes side
- **WHEN** three beats follow one another
- **THEN** the balance stands at plus its amplitude, minus its amplitude and plus its amplitude, and the lever is on the same side each time

### Requirement: The balance beats while Dial can hear the owner
The balance, the lever and the escape wheel SHALL beat while the page's recognition is running, and SHALL stand still at every other time: before the first click, while listening is muted, where on-device recognition is not offered, while Dial thinks or speaks, after the session was refused and after Dial has closed.

#### Scenario: Listening
- **WHEN** the state is `idle`, listening was started and is not muted, and recognition is running
- **THEN** the escape wheel advances at each beat and the balance changes side

#### Scenario: Muted
- **WHEN** the owner mutes
- **THEN** the balance, the lever and the escape wheel stand still from that moment

#### Scenario: Dial is speaking
- **WHEN** the state becomes `speaking` and recognition is stopped
- **THEN** the balance stands still until recognition runs again

#### Scenario: Typed turns only
- **WHEN** on-device recognition is not offered
- **THEN** the balance never moves

### Requirement: The barrel winds as the owner speaks
The barrel SHALL advance one notch of 15 degrees for every three words of the transcript being heard, counting each utterance from its start, and SHALL never turn back.

#### Scenario: Seven words
- **WHEN** the transcript being heard grows to seven words
- **THEN** the barrel has advanced two notches, 30 degrees

#### Scenario: A second utterance
- **WHEN** an utterance of seven words has ended and a new one reaches four words
- **THEN** the barrel has advanced three notches in all

#### Scenario: A revised transcript does not unwind
- **WHEN** the transcript being heard goes from seven words to five
- **THEN** the barrel stays where it was

### Requirement: The train runs while Dial thinks or speaks
The four wheels of the going train SHALL turn while the state is `thinking` or `speaking`, the first at a fixed rate and each later one as its mesh gives, and SHALL stand still in every other state.

#### Scenario: Thinking
- **WHEN** the state has been `thinking` for two seconds, and then for four
- **THEN** the first wheel has turned twice as far after four seconds as after two, and every other wheel stands in mesh with the one that drives it

#### Scenario: Speaking
- **WHEN** the state goes from `thinking` to `speaking`
- **THEN** the train keeps turning at the same rate

#### Scenario: Idle
- **WHEN** the state is `idle`, `refused` or closed
- **THEN** no wheel of the train turns

### Requirement: The hand counts the sentences of a reply
The hand SHALL advance one mark of 6 degrees for each sentence of a reply, and SHALL return to its top mark when the next turn begins. After the session was refused, and after Dial has closed, the hand SHALL stand at its top mark.

#### Scenario: Three sentences
- **WHEN** three `sentence` events have arrived since the turn began
- **THEN** the hand stands 18 degrees past its top mark

#### Scenario: The next turn
- **WHEN** a `user` event arrives
- **THEN** the hand stands at its top mark

#### Scenario: Parked
- **WHEN** the state is `refused`, or the page has received `bye`
- **THEN** the hand stands at its top mark and the balance stands still

### Requirement: Each session has one sub-dial
The ring SHALL hold twelve sub-dials, one for each of the first twelve sessions of the session list in the order of the list. The hand of a `working` session SHALL step once a second. The hand of a `blocked`, `done` or `failed` session SHALL rest at a mark fixed for that state, the three marks differing, and a `blocked` one SHALL carry the accent tone. A session in any other state SHALL have a sub-dial with no hand.

#### Scenario: Four sessions
- **WHEN** the list holds two `working` sessions, one `blocked` and one `done`, in that order
- **THEN** the first four sub-dials show them in that order and the other eight are empty

#### Scenario: Working
- **WHEN** a session is `working`
- **THEN** its hand stands at a different angle one second later

#### Scenario: Blocked needs the owner
- **WHEN** a session is `blocked`
- **THEN** its hand rests at the blocked mark at any time, and its sub-dial carries the accent tone

#### Scenario: Done and failed rest apart
- **WHEN** one session is `done` and another is `failed`
- **THEN** their hands rest at two different marks, and each mark is the same for every session in that state

#### Scenario: A state the stage does not know
- **WHEN** a session's state is `stopped`, `unknown` or `paused`
- **THEN** its sub-dial is shown with no hand

#### Scenario: More sessions than sub-dials
- **WHEN** the list holds fifteen sessions
- **THEN** the twelve sub-dials show the first twelve

### Requirement: The reserve drains while a proposal waits
While a proposal is open, the reserve arc SHALL show the share of its time that is left: the `secondsLeft` its event carried less the whole seconds since that event arrived, over its `seconds`, never below zero. With no open proposal the arc SHALL be empty.

#### Scenario: A new proposal
- **WHEN** a `proposal` event arrives with the status `pending`, `seconds` 120 and `secondsLeft` 120
- **THEN** the arc is full, and 30 seconds later it shows three quarters

#### Scenario: A page that connected late
- **WHEN** the first `proposal` event a page receives carries `seconds` 120 and `secondsLeft` 20
- **THEN** the arc shows one sixth

#### Scenario: The proposal closes
- **WHEN** a `proposal` event carries the status `started`, `failed`, `cancelled`, `expired` or `replaced`
- **THEN** the arc is empty

#### Scenario: Time runs out before the event
- **WHEN** more seconds have passed than the event's `secondsLeft`
- **THEN** the arc is empty and never negative

### Requirement: A part that stops keeps its place
When the balance or the train stops, each of its parts SHALL stay at the angle it had. When it runs again it SHALL go on from that angle.

#### Scenario: The escape wheel after a pause
- **WHEN** recognition stops 5.5 seconds after it started and runs again a minute later
- **THEN** at that moment the escape wheel stands where it stood when recognition stopped

#### Scenario: The train after a pause
- **WHEN** the state leaves `thinking` and becomes `thinking` again 30 seconds later
- **THEN** every wheel of the train goes on from the angle it had

### Requirement: The stage is told what happens and nothing that was said
The page SHALL tell the stage only: the name of the state, whether recognition is running, whether speech is being heard, the number of words in the transcript being heard, that a sentence arrived, that a turn began, the states of the listed sessions in list order, the `seconds` and `secondsLeft` of an open proposal, and that Dial has closed. What the stage draws SHALL hold no string taken from an event.

#### Scenario: A sentence
- **WHEN** a `sentence` event carries `Number 41 can merge.`
- **THEN** the stage is told that a sentence arrived, and nothing it is told holds that text

#### Scenario: The transcript being heard
- **WHEN** the transcript being heard is `what needs me today`
- **THEN** the stage is told the number 4 and not the words

#### Scenario: Sessions
- **WHEN** a `sessions` event holds a `working` session in `katipon` with the prompt `/interlock:ship add-parser` and a `blocked` one
- **THEN** the stage is told the two states in that order, and neither the repo, the prompt nor an id

#### Scenario: A refusal
- **WHEN** a `state` event carries `refused` and a reason
- **THEN** the stage is told the state `refused` and not the reason

#### Scenario: A state name that looks like markup
- **WHEN** a session's state is `<img src=x>`
- **THEN** nothing the stage draws holds those characters, and its sub-dial has no hand

#### Scenario: A restart after silence is not news
- **WHEN** recognition ends with no result and is started again at once
- **THEN** the stage is not told that recognition stopped

### Requirement: The stage draws only as often as its motion needs
The stage SHALL draw at most 30 frames a second while the train runs. While the train stands and a stepped part is live — the balance, the hand of a `working` session or the reserve arc — it SHALL draw one frame a second. Otherwise it SHALL draw one frame for each change and none on a timer. While the document is hidden it SHALL draw nothing.

#### Scenario: Idle and listening
- **WHEN** the state is `idle` and recognition runs for ten seconds with no other change
- **THEN** ten or eleven frames are drawn

#### Scenario: Thinking
- **WHEN** the state is `thinking` for one second
- **THEN** at most 30 frames are drawn

#### Scenario: Nothing is live
- **WHEN** listening is muted, no session is `working` and no proposal is open
- **THEN** no frame is drawn until something changes, and no timer and no frame request is pending

#### Scenario: A working session while muted
- **WHEN** listening is muted and one session is `working`
- **THEN** one frame a second is drawn

#### Scenario: A hidden window
- **WHEN** the document becomes hidden while the train runs
- **THEN** no frame is drawn and nothing is pending, and one frame is drawn at once when the document is shown again

#### Scenario: Several changes at once
- **WHEN** three changes arrive before the next frame
- **THEN** one frame is drawn for them

### Requirement: Reduced motion stops all animation
While `prefers-reduced-motion: reduce` matches, the stage SHALL draw one frame for each change and none on a timer, and every part SHALL stand where what it shows puts it and not where the time does. The stage SHALL follow the setting when it changes.

#### Scenario: The same picture at any time
- **WHEN** reduced motion is on and nothing changes
- **THEN** what the stage draws is the same at any two times

#### Scenario: The state still shows
- **WHEN** reduced motion is on, recognition is running, the state becomes `thinking` and one session is `working`
- **THEN** the balance carries the live tone while recognition runs, the train carries it while Dial thinks, and the session's hand rests at a mark fixed for `working` that differs from the marks of `blocked`, `done` and `failed`

#### Scenario: The setting turns on
- **WHEN** reduced motion turns on while the train runs
- **THEN** one frame is drawn and nothing further is pending until something changes

#### Scenario: The setting turns off
- **WHEN** reduced motion turns off while the state is `thinking`
- **THEN** the train runs again

### Requirement: The mechanism holds no text and the page says the state in words
The mechanism SHALL be drawn with no text, on a canvas hidden from assistive technology. The page SHALL say in a status line, as text, `Not started`, `Listening`, `Muted`, `Typed turns only`, `Thinking`, `Speaking`, `Refused: <reason>` or `Closed`, and SHALL mark the Mute control as pressed while listening is muted.

#### Scenario: No text is drawn
- **WHEN** every script the page is served is read
- **THEN** none of them holds `fillText` or `strokeText`

#### Scenario: The canvas is not read out
- **WHEN** the shipped page is read
- **THEN** its canvas element carries `aria-hidden="true"` and holds no text, and its status line carries `role="status"`

#### Scenario: The words for each state
- **WHEN** the page has not been started; then recognition runs; then the owner mutes; then the state is `thinking`; then `speaking`; then `refused` with the reason `it has tools other than Bash: Read`; then the page receives `bye`
- **THEN** the status line says `Not started`, `Listening`, `Muted`, `Thinking`, `Speaking`, `Refused: it has tools other than Bash: Read` and `Closed`, in that order

#### Scenario: Recognition is not offered
- **WHEN** on-device recognition is not offered and the state is `idle`
- **THEN** the status line says `Typed turns only`

#### Scenario: Mute is marked
- **WHEN** the owner mutes and then unmutes
- **THEN** the Mute control carries `aria-pressed` `true` and then `false`

### Requirement: Every control works from the keyboard
Every control of the page — Start, Mute, Stop, Quit, Full screen, the text field, and the controls of a proposal, a session and a log — SHALL be a native button or input, reached with the Tab key in the order of the document, with a visible mark while it has the focus. A click on the mechanism SHALL be a shortcut for Stop and SHALL NOT be the only way to stop.

#### Scenario: Native controls
- **WHEN** the shipped page and its scripts are read
- **THEN** in the page's markup Start, Mute, Stop, Quit and Full screen are `button` elements and the text field is an `input`; the markup holds no positive `tabindex`, no `role="button"` and no `onclick` attribute; and the scripts set no `tabIndex`, no `role` and no `onclick`

#### Scenario: The focus mark
- **WHEN** the shipped style is read
- **THEN** it holds a `:focus-visible` rule, and holds neither `outline: none` nor `outline: 0`

#### Scenario: Stop without a pointer
- **WHEN** the owner moves to the Stop control with Tab and presses Enter
- **THEN** the page posts `/interrupt`

### Requirement: The window goes full screen on the starting click
On the click that starts listening, the page SHALL ask the browser to show the whole document in full screen. A Full screen control SHALL leave full screen and enter it again. A request the browser refuses SHALL be ignored: the page SHALL go on working in its window. `dial voice` SHALL open its window with the same arguments as before.

#### Scenario: The starting click
- **WHEN** the owner clicks the control that starts listening
- **THEN** the page asks for full screen once and starts listening

#### Scenario: The browser refuses
- **WHEN** the request for full screen is refused
- **THEN** listening starts all the same, and the page shows no error

#### Scenario: The Full screen control
- **WHEN** the owner uses the Full screen control while in full screen, and again afterwards
- **THEN** the page leaves full screen the first time and asks for it the second

#### Scenario: The window is opened as before
- **WHEN** `dial voice` starts on macOS
- **THEN** `open` is run with `-na`, `Google Chrome`, `--args` and `--app=<address>`, and with no argument that asks for full screen or a kiosk

### Requirement: Leaving full screen stops Dial, and so does a click on the mechanism
When the document leaves full screen and the page's own Full screen control did not ask for it, the page SHALL post `/interrupt`. Pressing Escape in full screen SHALL post `/interrupt` once, whether or not the key reaches the page. A click on the mechanism SHALL post `/interrupt` and SHALL NOT leave full screen.

#### Scenario: Escape reaches the page
- **WHEN** the page is in full screen, the Escape key event arrives, and the document then leaves full screen
- **THEN** the page has posted `/interrupt` exactly once

#### Scenario: Escape does not reach the page
- **WHEN** the page is in full screen and the document leaves full screen with no key event
- **THEN** the page posts `/interrupt` once

#### Scenario: The page's own control
- **WHEN** the owner leaves full screen with the Full screen control
- **THEN** the page posts nothing

#### Scenario: A click on the mechanism
- **WHEN** the owner clicks the mechanism while Dial is speaking in full screen
- **THEN** the page posts `/interrupt` and stays in full screen

### Requirement: Colours and type come from one stylesheet
Every colour and font of the page and of the mechanism SHALL be a custom property declared in `page.css`. The page and its scripts SHALL hold no colour value, and the mechanism SHALL take its tones from those properties. The style SHALL name system fonts only. Every text colour SHALL have a contrast of at least 4.5 to 1 against the ground colour.

#### Scenario: No colour outside the stylesheet
- **WHEN** the shipped page and every script it is served are read
- **THEN** none holds a `#` colour, `rgb(`, `hsl(` or a `style` attribute

#### Scenario: The tones of the mechanism
- **WHEN** the shipped style is read
- **THEN** it declares `--ground`, `--text`, `--stage-live`, `--stage-rest`, `--stage-accent`, `--stage-ok` and `--stage-fail`

#### Scenario: System fonts only
- **WHEN** the shipped style is read
- **THEN** it holds neither `@font-face`, `@import` nor `url(`

#### Scenario: Readable text
- **WHEN** the custom properties of the shipped style are read
- **THEN** every property whose name starts with `--text` has a contrast of at least 4.5 to 1 against `--ground`
