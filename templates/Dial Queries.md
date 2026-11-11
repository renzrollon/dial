---
title: Dial Queries
type: resource
status: active
tags: [dial]
aliases: []
---

# Dial Queries

Worked prompts for an agent (pi, or a Claude session) reading the Dial notes in this vault. Each one reads frontmatter and the human-owned sections only; none asks for a diff or a file body, because Dial never writes one.

## What needs me today

> Read `Dial Summary.md`. For each bullet, open the linked note and give me one line: the change, its `state`, and the suggested action from the `state` row of its `## State` table. Oldest `last_activity` first.

## What was I doing on a repo

> Open `Projects/<repo>.md`. Summarise `## Recent narrative` in three sentences, then list the unticked boxes under `## Next` of that note and of every `Changes/<repo>--*.md` note it links.

## What is stale and why

> List every note in `Changes/` with `stale: true`. For each, say which activity source is newest (the `last activity` row of `## State`) and whether archive, drop or re-spec fits better, judging from `## Narrative`.

## What is in flight

> List every note in `Changes/` whose `state` is `shipping` or `queued`, with its `repo`, `branch` and `last_activity`. Say which have not moved since yesterday.

## What did I ship this week

> Read the `## Log` sections of this week's `Daily/*.md` notes. List each `dial ·` line whose transition ends in `pr-open`, `shipped`, `archive-pending` or `archived`, grouped by repo.

## What is blocked on a decision

> List every note in `Changes/` whose `state` is `checkpoint` or `halted`, with the evidence of its `state` row and the newest `## Narrative` entry's `Blocked:` line when there is one.

## Rules for the agent

- Read; do not edit `## State`, `## Changes`, `## Drift` or `## Recent narrative` — Dial regenerates them.
- To add a next step or a narrative entry, run `dial handoff`, or edit `## Next` / `## Narrative` by hand.
- Never delete a Dial note; `dial drop <repo> <change>` takes a change off the board.
