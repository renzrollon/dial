# Spec Delta

## MODIFIED Requirements

### Requirement: Every cap is published with a default and a description
Every cap Dial applies SHALL be published, each with a default and a one-line lowercase description. The published caps SHALL be, in this order: `staleDays` 14, `archivedKeepDays` 30, `briefLines` 40, `subprocessTimeoutSeconds` 10, `remoteIntervalMinutes` 30, `syncIntervalMinutes` 15, `narrateTurns` 20, `narrateTimeoutSeconds` 30, `nextRows` 50, `watchPollSeconds` 30, `remotePullRequests` 20, `contextNarrative` 5, `contextLines` 200, `voiceTurnSeconds` 120, `voiceCloseSeconds` 10 and `voiceTurnChars` 2000. A cap that is applied SHALL NOT be missing from `dial limits`.

#### Scenario: Defaults with no registry
- **WHEN** `dial limits` is run with no registry file
- **THEN** it prints exactly sixteen lines, naming `staleDays`, `archivedKeepDays`, `briefLines`, `subprocessTimeoutSeconds`, `remoteIntervalMinutes`, `syncIntervalMinutes`, `narrateTurns`, `narrateTimeoutSeconds`, `nextRows`, `watchPollSeconds`, `remotePullRequests`, `contextNarrative`, `contextLines`, `voiceTurnSeconds`, `voiceCloseSeconds` and `voiceTurnChars` in that order with the values 14, 30, 40, 10, 30, 15, 20, 30, 50, 30, 20, 5, 200, 120, 10 and 2000, and exits 0

#### Scenario: Every cap has a description
- **WHEN** `dial limits` is run
- **THEN** each of the sixteen lines ends with a non-empty lowercase description after the value

#### Scenario: The new caps say what they bound
- **WHEN** `dial limits` is run
- **THEN** the `remotePullRequests` line ends with `open pull requests kept per repo by a remote sync`, the `contextNarrative` line with `narrative entries dial context prints` and the `contextLines` line with `maximum lines dial context prints as text`

#### Scenario: The voice caps say what they bound
- **WHEN** `dial limits` is run
- **THEN** the `voiceTurnSeconds` line ends with `seconds before a voice turn is stopped`, the `voiceCloseSeconds` line with `seconds dial voice stays up after its last window closes` and the `voiceTurnChars` line with `maximum characters in one voice turn`

### Requirement: Caps are available as JSON
`dial limits --json` SHALL print a JSON object whose keys are the cap names, in the published order, and whose values are the effective integers.

#### Scenario: JSON caps
- **WHEN** `dial limits --json` is run with defaults
- **THEN** stdout parses to `{ "staleDays": 14, "archivedKeepDays": 30, "briefLines": 40, "subprocessTimeoutSeconds": 10, "remoteIntervalMinutes": 30, "syncIntervalMinutes": 15, "narrateTurns": 20, "narrateTimeoutSeconds": 30, "nextRows": 50, "watchPollSeconds": 30, "remotePullRequests": 20, "contextNarrative": 5, "contextLines": 200, "voiceTurnSeconds": 120, "voiceCloseSeconds": 10, "voiceTurnChars": 2000 }` with the keys in that order

### Requirement: The registry overrides a cap
A `limits` object in the registry SHALL override the default for each key it names. Each key SHALL be a published cap name and each value a positive integer; anything else SHALL be refused on load with a reason naming the key and the file.

#### Scenario: Override is reflected
- **WHEN** the registry's `limits` holds `staleDays: 7`
- **THEN** `dial limits` prints 7 for `staleDays` and the defaults for the other fifteen

#### Scenario: Unknown cap key
- **WHEN** the registry's `limits` holds `coffeeBreaks: 3`
- **THEN** `dial limits` exits 1 with `dial: registry limits: unknown cap coffeeBreaks in <path>`

#### Scenario: Non-positive or non-integer value
- **WHEN** the registry's `limits` holds `briefLines: 0` or `briefLines: "40"`
- **THEN** `dial limits` exits 1 with a reason naming `briefLines` and requiring a positive integer

#### Scenario: Override of a new cap
- **WHEN** the registry's `limits` holds `nextRows: 10` and `syncIntervalMinutes: 5`
- **THEN** `dial limits --json` has `nextRows` 10 and `syncIntervalMinutes` 5, every other cap at its default, and the exit code is 0

#### Scenario: New cap with a bad value
- **WHEN** the registry's `limits` holds `watchPollSeconds: -30`
- **THEN** `dial limits` exits 1 with a reason naming `watchPollSeconds` and requiring a positive integer

#### Scenario: Override of a context cap
- **WHEN** the registry's `limits` holds `remotePullRequests: 5` and `contextLines: 80`
- **THEN** `dial limits --json` has `remotePullRequests` 5 and `contextLines` 80, every other cap at its default, and the exit code is 0

#### Scenario: Override of a voice cap
- **WHEN** the registry's `limits` holds `voiceTurnSeconds: 30` and `voiceTurnChars: 500`
- **THEN** `dial limits --json` has `voiceTurnSeconds` 30 and `voiceTurnChars` 500, every other cap at its default, and the exit code is 0

#### Scenario: Voice cap with a bad value
- **WHEN** the registry's `limits` holds `voiceCloseSeconds: 0`
- **THEN** `dial limits` exits 1 with a reason naming `voiceCloseSeconds` and requiring a positive integer, and `dial voice` exits 1 with the same reason before it listens
