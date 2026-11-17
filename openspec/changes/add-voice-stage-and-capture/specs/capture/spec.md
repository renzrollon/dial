# Spec Delta

## Purpose

The `dial capture` command: it takes a piece of text, typed or spoken through `dial voice`, and writes it as one new note under `Inbox/` of a registered vault. It covers what the command takes, the note it writes, how the text is cleaned, redacted and bounded, and what it refuses.

## ADDED Requirements

### Requirement: capture writes one new note into a vault's Inbox
`dial capture --vault <name>` with either `--text <t>` or `--stdin` SHALL write one new file `Inbox/<title> <YYYY-MM-DD HHmm>.md` into the vault the registry names `<name>`, the date and time being local, print `created <absolute path>` and exit 0. It SHALL create `Inbox/` when the vault has none.

#### Scenario: A note from --text
- **WHEN** `DIAL_NOW=2026-11-17T09:05:00Z dial capture --vault personal --text "Buy oat milk"` is run and `personal` is a registered vault
- **THEN** the file `Inbox/Buy oat milk 2026-11-17 0905.md` exists in that vault, stdout is `created <vault>/Inbox/Buy oat milk 2026-11-17 0905.md`, and the exit code is 0

#### Scenario: A note from stdin
- **WHEN** `dial capture --vault personal --stdin` reads the two lines `Call the dentist` and `before Friday`
- **THEN** the note is named after `Call the dentist` and its text holds both lines

#### Scenario: Local time follows TZ
- **WHEN** `TZ=Asia/Manila DIAL_NOW=2026-11-17T09:05:00Z dial capture --vault personal --text "Buy oat milk"` is run
- **THEN** the file is `Inbox/Buy oat milk 2026-11-17 1705.md`

#### Scenario: A vault without an Inbox
- **WHEN** the vault `personal` exists and holds no `Inbox/` folder
- **THEN** the folder is created and the note is written into it

### Requirement: capture prints what it wrote as JSON on request
With `--json`, `dial capture` SHALL print one object holding `vault`, `path` (absolute), `note` (the path inside the vault), `wikilink` (`[[<file name without .md>]]`), `title`, `text` (the text as written) and `written` (true, or false for a dry run), and no other key.

#### Scenario: The JSON form
- **WHEN** `DIAL_NOW=2026-11-17T09:05:00Z dial capture --vault personal --text "Buy oat milk" --json` is run
- **THEN** stdout parses to an object with `"vault": "personal"`, `"note": "Inbox/Buy oat milk 2026-11-17 0905.md"`, `"wikilink": "[[Buy oat milk 2026-11-17 0905]]"`, `"title": "Buy oat milk"`, `"text": "Buy oat milk"`, `"written": true` and an absolute `path`, and no other key

#### Scenario: The text is what was written
- **WHEN** the text given holds a token that is redacted
- **THEN** `text` in the JSON holds `[redacted]` in its place, as the note does

### Requirement: A captured note holds frontmatter and the text
The note SHALL be a frontmatter block with the keys `title`, `created` (the local date), `type: note`, `status: inbox`, `tags: [capture]` and `dial_schema: dial.capture/1`, in that order, then one blank line, then the text, then one line feed. The title SHALL be written under the quoting rule Dial uses for every frontmatter value.

#### Scenario: The bytes of a note
- **WHEN** `DIAL_NOW=2026-11-17T09:05:00Z dial capture --vault personal --text "Buy oat milk"` is run
- **THEN** the file holds exactly `---`, `title: Buy oat milk`, `created: 2026-11-17`, `type: note`, `status: inbox`, `tags: [capture]`, `dial_schema: dial.capture/1`, `---`, an empty line and `Buy oat milk`, each on its own line, and ends with one line feed

#### Scenario: A title YAML would misread
- **WHEN** the text is `no`, `2026` or `- call Ana`
- **THEN** the title is written in double quotes, and reading the note's frontmatter gives back the title as that string

#### Scenario: Text that looks like frontmatter
- **WHEN** the text is the three lines `---`, `status: done` and `---`
- **THEN** the note's own frontmatter is unchanged, its `status` is `inbox`, and the three lines are in the text below it

### Requirement: The text is cleaned and redacted before it is written
Before anything else is done with it, the text SHALL have every `\r\n` and lone `\r` made a line feed, every control character other than a line feed and a tab removed, and its ends trimmed. Every secret-looking string SHALL then be replaced by `[redacted]`, under the rule Dial applies to every string it authors into a vault. The title and the file name SHALL be made from the redacted text.

#### Scenario: Line endings and control characters
- **WHEN** the text is `  first\r\nsecond\u001b[1m\u0000  `
- **THEN** the text written is `first`, a line feed and `second[1m`

#### Scenario: A token in the text
- **WHEN** the text is `rotate the key ghp_0123456789abcdefghijABCDEFGHIJ012345 today`
- **THEN** the note's text is `rotate the key [redacted] today`

#### Scenario: A secret never reaches the file name
- **WHEN** the first line of the text is `export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ012345`
- **THEN** neither the file name, the title nor the text holds that token

### Requirement: The title is the note's first line, made safe for a file name
The title SHALL be the first line of the text that is not blank, with each of the characters `: / \ ? * " < > | # ^ [ ]` replaced by a space, every run of whitespace made one space, a leading `.` and trailing `.` and spaces dropped, and cut to 60 characters: at the last space at or before the sixtieth character when there is one, else at the sixtieth, and never inside a surrogate pair. When nothing is left the title SHALL be `Note`.

#### Scenario: Characters a file name cannot hold
- **WHEN** the first line is `Fix: parser/lexer [urgent]?`
- **THEN** the title is `Fix parser lexer urgent`

#### Scenario: A long first line
- **WHEN** the first line holds 90 characters of words separated by single spaces
- **THEN** the title is at most 60 characters, ends at the end of a word, and is the start of that line

#### Scenario: One unbroken run
- **WHEN** the first line is 80 letters with no space
- **THEN** the title is its first 60 letters

#### Scenario: Nothing left
- **WHEN** the first line is `...`, `###` or `[[ ]]`
- **THEN** the title is `Note`

#### Scenario: A blank first line
- **WHEN** the text is an empty line, then `Second line`
- **THEN** the title is `Second line`

#### Scenario: An emoji at the cut
- **WHEN** the sixtieth and sixty-first code units of the first line are the two halves of one emoji, with no space before them
- **THEN** the title holds no lone half of a pair

### Requirement: capture refuses what it cannot write
`dial capture` SHALL exit 1 with one reason line, having written nothing, when `--vault` is missing; when not exactly one of `--text` and `--stdin` is given; when the cleaned text is empty or longer than `captureChars` characters; when the registry names no such vault; when the vault's directory does not exist; and when a note of that name exists. These SHALL be checked in that order.

#### Scenario: No vault named
- **WHEN** `dial capture --text "x"` is run
- **THEN** stderr is `dial: capture needs --vault <name>` and the exit code is 1

#### Scenario: Neither or both sources
- **WHEN** `dial capture --vault personal` or `dial capture --vault personal --text x --stdin` is run
- **THEN** stderr is `dial: capture needs exactly one of --stdin or --text`

#### Scenario: Empty text
- **WHEN** the text is `"   "`, or stdin is empty
- **THEN** stderr is `dial: capture text is empty`

#### Scenario: Text that is too long
- **WHEN** the cleaned text holds 2001 characters and `captureChars` is 2000
- **THEN** stderr is `dial: note longer than 2000 characters`; a text of exactly 2000 characters is written

#### Scenario: A vault the registry does not name
- **WHEN** `dial capture --vault nowhere --text x` is run and the registry names the vaults `personal` and `work`
- **THEN** stderr is `dial: no vault named nowhere in the registry; vaults: personal, work`; with no vault in the registry it is `dial: no vault named nowhere in the registry`

#### Scenario: A vault whose directory is gone
- **WHEN** the vault `personal` points at `/Users/caro/Documents/gone`, which does not exist
- **THEN** stderr is `dial: vault personal does not exist: /Users/caro/Documents/gone`, and the directory is not created

#### Scenario: A positional argument
- **WHEN** `dial capture note --vault personal --text x` is run
- **THEN** stderr is `dial: unexpected argument: note` and the exit code is 1

#### Scenario: The cap is read from the registry
- **WHEN** the registry's `limits` holds `captureChars: 100` and the text holds 101 characters
- **THEN** stderr is `dial: note longer than 100 characters`

### Requirement: capture never overwrites, appends or deletes
A note whose name exists SHALL be refused with `dial: <note> already exists in vault <name>`, and the existing file SHALL keep its bytes. A capture SHALL change no file of the vault other than the one it creates, SHALL write only under `Inbox/` of a vault the registry names, and SHALL write through a hidden temporary file that is renamed into place.

#### Scenario: The same words in the same minute
- **WHEN** `dial capture --vault personal --text "Buy oat milk"` is run twice within one minute
- **THEN** the second exits 1 with `dial: Inbox/Buy oat milk 2026-11-17 0905.md already exists in vault personal`, and the first note is byte-identical

#### Scenario: A note that appears during the write
- **WHEN** another writer creates the same file after capture has checked the name and before it renames its temporary file
- **THEN** the other writer's bytes are kept, capture exits 1 with the `already exists` reason, and no `.*.tmp` file remains in `Inbox/`

#### Scenario: Nothing else changes
- **WHEN** a capture succeeds in a vault that holds project, change and daily notes
- **THEN** the vault holds exactly one more file, every other file is byte-identical, and no file under `Daily/` or `.obsidian/` was created or changed

#### Scenario: An Inbox that leads out of the vault
- **WHEN** `Inbox` in the vault is a symbolic link to a directory outside the vault
- **THEN** the capture is refused with a reason starting `dial: refusing to write into ` and nothing is written there

### Requirement: A dry run prints the plan and writes nothing
With `--dry-run`, `dial capture` SHALL print `create <absolute path>` in place of `created <absolute path>`, SHALL report `"written": false` with `--json`, and SHALL write nothing, not even `Inbox/`. Every refusal SHALL apply as without it.

#### Scenario: A planned note
- **WHEN** `dial capture --vault personal --text "Buy oat milk" --dry-run` is run in a vault with no `Inbox/`
- **THEN** stdout is `create <vault>/Inbox/Buy oat milk 2026-11-17 0905.md`, the exit code is 0, and the vault holds no `Inbox/` afterwards

#### Scenario: A dry run of a name that exists
- **WHEN** the note already exists and the same capture is run with `--dry-run`
- **THEN** the exit code is 1 with the `already exists` reason

### Requirement: capture creates no home and runs no program
`dial capture` SHALL NOT create the Dial home, SHALL run no other program, and SHALL reach no network. It reads the registry and writes the one note.

#### Scenario: The home is not created
- **WHEN** `dial capture --vault personal --text x` is run and the home does not exist
- **THEN** the exit code is 1 with `dial: no vault named personal in the registry`, and the home still does not exist

#### Scenario: No program is run
- **WHEN** a capture succeeds with recording `git`, `gh`, `claude` and `open` programs on `PATH`
- **THEN** none of them was run
