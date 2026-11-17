# Spec Delta

## ADDED Requirements

### Requirement: An open proposal's event says how long it has left
Every `proposal` event whose status is `pending` or `read` SHALL carry `seconds`, the value of `voiceProposalSeconds`, and `secondsLeft`, the whole seconds until the proposal expires at the moment the event is sent, rounded up. A `proposal` event with any other status SHALL carry neither.

#### Scenario: A new proposal
- **WHEN** a proposal becomes open and `voiceProposalSeconds` is 120
- **THEN** its `proposal` event carries `"status": "pending"`, `"seconds": 120` and `"secondsLeft": 120`

#### Scenario: Read aloud later
- **WHEN** a proposal became open 90 seconds ago and its status becomes `read`
- **THEN** the `proposal` event for `read` carries `"seconds": 120` and `"secondsLeft": 30`

#### Scenario: A page that connects late
- **WHEN** a page connects 100 seconds after the proposal became open
- **THEN** the `proposal` event it is sent carries `"secondsLeft": 20`

#### Scenario: Part of a second
- **WHEN** a `proposal` event for an open proposal is sent 99.5 seconds after it became open
- **THEN** it carries `"secondsLeft": 21`

#### Scenario: A proposal that closed
- **WHEN** a `proposal` event carries the status `starting`, `started`, `failed`, `cancelled`, `expired` or `replaced`
- **THEN** it holds neither `seconds` nor `secondsLeft`
