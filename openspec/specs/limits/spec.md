# limits Specification

## Purpose
The caps Dial publishes — how long before a change is stale, how long archived notes stay on the board, how long a brief may be — with their defaults, how the registry overrides them, and how `dial limits` prints them so every cap is visible in one place.

## Requirements

### Requirement: Every cap is published with a default and a description
Every cap Dial applies SHALL be published, each with a default and a one-line lowercase description. The published caps SHALL be, in this order: `staleDays` 14, `archivedKeepDays` 30, `briefLines` 40, `subprocessTimeoutSeconds` 10, `remoteIntervalMinutes` 30, `syncIntervalMinutes` 15, `narrateTurns` 20, `narrateTimeoutSeconds` 30, `nextRows` 50 and `watchPollSeconds` 30. A cap that is applied SHALL NOT be missing from `dial limits`.

#### Scenario: Defaults with no registry
- **WHEN** `dial limits` is run with no registry file
- **THEN** it prints exactly ten lines, naming `staleDays`, `archivedKeepDays`, `briefLines`, `subprocessTimeoutSeconds`, `remoteIntervalMinutes`, `syncIntervalMinutes`, `narrateTurns`, `narrateTimeoutSeconds`, `nextRows` and `watchPollSeconds` in that order with the values 14, 30, 40, 10, 30, 15, 20, 30, 50 and 30, and exits 0

#### Scenario: Every cap has a description
- **WHEN** `dial limits` is run
- **THEN** each of the ten lines ends with a non-empty lowercase description after the value

### Requirement: Caps print one aligned line each
`dial limits` SHALL print one line per cap in the form `<name padded to the longest name> = <value right-aligned in 9 characters>  <description>`, followed by a trailing newline, and exit 0.

#### Scenario: Line format
- **WHEN** `dial limits` is run
- **THEN** every stdout line matches `^\S+\s+=\s+\d+  \S` and the output ends with a newline

### Requirement: Caps are available as JSON
`dial limits --json` SHALL print a JSON object whose keys are the cap names, in the published order, and whose values are the effective integers.

#### Scenario: JSON caps
- **WHEN** `dial limits --json` is run with defaults
- **THEN** stdout parses to `{ "staleDays": 14, "archivedKeepDays": 30, "briefLines": 40, "subprocessTimeoutSeconds": 10, "remoteIntervalMinutes": 30, "syncIntervalMinutes": 15, "narrateTurns": 20, "narrateTimeoutSeconds": 30, "nextRows": 50, "watchPollSeconds": 30 }` with the keys in that order

### Requirement: The registry overrides a cap
A `limits` object in the registry SHALL override the default for each key it names. Each key SHALL be a published cap name and each value a positive integer; anything else SHALL be refused on load with a reason naming the key and the file.

#### Scenario: Override is reflected
- **WHEN** the registry's `limits` holds `staleDays: 7`
- **THEN** `dial limits` prints 7 for `staleDays` and the defaults for the other nine

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
