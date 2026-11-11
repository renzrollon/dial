---
name: handoff
description: Write a five-line handoff of this session into the repo's Dial vault note, so the next session starts from it.
argument-hint: "[<repo>] [<change>]"
allowed-tools: Bash(dial handoff:*), Bash(dial sync:*)
---

# /dial:handoff

Record what this session did so the next one, here or on another machine, starts from it. The repo is `$1`, or the repository this session is working in when none is given; the change is `$2`, or none for a handoff on the repo itself.

1. Write five lines from your own context of this session, each starting with its label and nothing invented:

   ```
   Done: <what was finished, in one line>
   Decided: <what was decided and why, or "none">
   Next: <the first thing to do next>
   Blocked: <what is blocked and on whom, or "none">
   Open: <questions still open, or "none">
   ```

2. Pipe them to dial, with one `--next "<step>"` for each concrete next step (repeat the flag):

   ```
   dial handoff <repo> [<change>] --stdin --source "/dial:handoff (claude)" --next "<step>" <<'EOF'
   Done: ...
   Decided: ...
   Next: ...
   Blocked: ...
   Open: ...
   EOF
   ```

3. Run `dial sync <repo>` so the note and the Dial home reflect it.

4. End your reply with the wikilink `dial handoff` printed, and nothing after it.

## Sandbox

`dial handoff` and `dial sync` write into the repo's vault and into the Dial home (`~/.config/dial`, or `$DIAL_HOME`). In a sandboxed Claude Code session both directories must be writable from the sandbox. When a `dial` command fails with a permission error, report the failure and the command that failed; do not retry it another way, and do not write the note by hand.
