# Spec Delta

## Purpose

The caps Dial publishes — how long before a change is stale, how long archived notes stay on the board, how long a brief may be — with their defaults, how the registry overrides them, and how `dial limits` prints them so every cap is visible in one place.

## ADDED Requirements

### Requirement: Three caps are published with defaults and descriptions
The published caps SHALL be `staleDays` (default 14), `archivedKeepDays` (default 30) and `briefLines` (default 40), each with a one-line lowercase description. No other cap SHALL exist in this change.

#### Scenario: Defaults with no registry
- **WHEN** `dial limits` is run with no registry file
- **THEN** it prints exactly three caps with the values 14, 30 and 40, and exits 0

### Requirement: Caps print one aligned line each
`dial limits` SHALL print one line per cap in the form `<name padded to the longest name> = <value right-aligned in 9 characters>  <description>`, followed by a trailing newline, and exit 0.

#### Scenario: Line format
- **WHEN** `dial limits` is run
- **THEN** every stdout line matches `^\S+\s+=\s+\d+  \S` and the output ends with a newline

### Requirement: Caps are available as JSON
`dial limits --json` SHALL print a JSON object whose keys are the cap names and whose values are the effective integers.

#### Scenario: JSON caps
- **WHEN** `dial limits --json` is run with defaults
- **THEN** stdout parses to `{ "staleDays": 14, "archivedKeepDays": 30, "briefLines": 40 }`

### Requirement: The registry overrides a cap
A `limits` object in the registry SHALL override the default for each key it names. Each key SHALL be a published cap name and each value a positive integer; anything else SHALL be refused on load with a reason naming the key and the file.

#### Scenario: Override is reflected
- **WHEN** the registry's `limits` holds `staleDays: 7`
- **THEN** `dial limits` prints 7 for `staleDays` and the defaults for the other two

#### Scenario: Unknown cap key
- **WHEN** the registry's `limits` holds `coffeeBreaks: 3`
- **THEN** `dial limits` exits 1 with `dial: registry limits: unknown cap coffeeBreaks in <path>`

#### Scenario: Non-positive or non-integer value
- **WHEN** the registry's `limits` holds `briefLines: 0` or `briefLines: "40"`
- **THEN** `dial limits` exits 1 with a reason naming `briefLines` and requiring a positive integer
