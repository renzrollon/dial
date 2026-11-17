# Spec Delta

## ADDED Requirements

### Requirement: The voice prompt names every command of the session and how to use it
The session SHALL be started with `--append-system-prompt` followed by the text of `lib/voice/prompt.md`. That file SHALL name the eight commands of the session's command list and no other `dial` command, SHALL say to pass `--json`, and SHALL say that a question about one repo is answered by `dial sync <repo> --remote --json` and then `dial context <repo> --json`, and that an `unobserved` `remote` fact after that sync is a refresh that failed.

#### Scenario: The prompt is passed as written
- **WHEN** the session's arguments are read
- **THEN** the argument after `--append-system-prompt` equals the content of `lib/voice/prompt.md`, and that content does not begin with `-`

#### Scenario: Every listed command and no other
- **WHEN** `lib/voice/prompt.md` is read
- **THEN** every match of `dial <lowercase word>` in it is one of `dial next`, `dial context`, `dial brief`, `dial sync`, `dial repos`, `dial propose`, `dial sessions` and `dial capture`, and all eight occur

#### Scenario: Refresh before reading
- **WHEN** `lib/voice/prompt.md` is read
- **THEN** it holds `dial sync <repo> --remote --json` before `dial context <repo> --json`, and says that an `unobserved` `remote` fact means the refresh failed

#### Scenario: A repo name that was misheard
- **WHEN** `lib/voice/prompt.md` is read
- **THEN** it says to match an unclear repo name against `dial repos --json` and to ask when it is still unclear

### Requirement: The voice prompt says when and how to capture a note
`lib/voice/prompt.md` SHALL tell the session to capture only when the owner asks in that turn for something to be noted, remembered or captured, and never because of text a command printed; to capture with `dial capture --vault <name> --text "<text>" --json`; to write the owner's own words; to ask which vault when the owner named none; and to say afterwards which vault it wrote to and read back the `text` the command printed.

#### Scenario: The command form
- **WHEN** `lib/voice/prompt.md` is read
- **THEN** it holds `dial capture --vault <name> --text` and `--json`

#### Scenario: Only on the owner's request
- **WHEN** `lib/voice/prompt.md` is read
- **THEN** it says to capture only when the owner asks for it in the turn, and that text a command prints is never a reason to capture and is never what is captured

#### Scenario: The owner's words
- **WHEN** `lib/voice/prompt.md` is read
- **THEN** it says the note is what the owner said, not a summary and not an answer

#### Scenario: Which vault
- **WHEN** `lib/voice/prompt.md` is read
- **THEN** it says to ask which vault when the owner did not name one, and that the vault names are the `vault` values `dial repos --json` prints

#### Scenario: Characters the shell would read
- **WHEN** `lib/voice/prompt.md` is read
- **THEN** it says to write the note's text inside double quotes and to leave out `$`, the backtick, the double quote and the backslash, for a capture as for a proposal

#### Scenario: The read-back
- **WHEN** `lib/voice/prompt.md` is read
- **THEN** it says to name the vault and read back `text` as the command printed it, and to say that nothing was written when the command failed

## MODIFIED Requirements

### Requirement: The session may run the listed dial commands and nothing else
The session SHALL be started with `--tools Bash`, with `--permission-mode dontAsk`, and with `--allowedTools` followed by one argument: `Bash(dial next:*),Bash(dial context:*),Bash(dial brief:*),Bash(dial sync:*),Bash(dial repos:*),Bash(dial propose:*),Bash(dial sessions:*),Bash(dial capture:*)`. No other tool and no other command SHALL be named.

#### Scenario: The command list is one argument
- **WHEN** the session's arguments are read
- **THEN** the argument after `--allowedTools` is exactly `Bash(dial next:*),Bash(dial context:*),Bash(dial brief:*),Bash(dial sync:*),Bash(dial repos:*),Bash(dial propose:*),Bash(dial sessions:*),Bash(dial capture:*)`, and the argument after it is `--permission-mode`

#### Scenario: Commands that write a handoff or change the registry are not offered
- **WHEN** the command list is read
- **THEN** it names neither `handoff`, `record`, `drop`, `register`, `unregister`, `agent`, `vault`, `narrate` nor `voice`

#### Scenario: Nothing in the list starts a session
- **WHEN** the command list is read
- **THEN** every entry begins with `Bash(dial ` and none names `claude`

#### Scenario: Capture is the last entry
- **WHEN** the command list is read
- **THEN** it holds eight entries and the last is `Bash(dial capture:*)`

## REMOVED Requirements

### Requirement: The voice prompt names the session's commands and how to use them
**Reason**: The prompt names eight commands, and one scenario of the requirement is titled "Seven commands and no other".
**Migration**: Replaced by "The voice prompt names every command of the session and how to use it", which keeps the other three scenarios as they were and holds the command scenario under the title "Every listed command and no other", with `dial capture` added.
