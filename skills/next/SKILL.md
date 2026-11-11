---
name: next
description: List what needs you across your registered repos, each as a drafted action you can approve.
argument-hint: "[--vault <name>]"
allowed-tools: Bash(dial next:*)
---

# /dial:next

Run `dial next --json` (add `--vault <name>` when the user named a vault) and read the rows it prints.

For each row show its `repo`, `change`, `state`, `idleDays` and `evidence`, and under it the row's `suggested` field as a drafted action: the command or request that would move it forward. Order is as printed.

Do not run any `suggested` action unasked. Offer them, and run one only when the user picks it. When `dial next --json` prints an empty list, say nothing needs attention. When it fails, report the error and the command.
