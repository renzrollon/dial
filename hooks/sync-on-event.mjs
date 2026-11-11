#!/usr/bin/env node
/** PostToolUse (Bash) hook: `dial sync <repo>` after an Interlock close or OpenSpec archive command. */
import { finish, runHook } from './common.mjs'

const CLOSE_COMMAND = /^\s*(interlock run close|interlock settle\b|openspec archive\b)/

runHook('sync-on-event', {
  timeoutMs: 28_000,
  gate: payload => typeof payload.tool_input?.command === 'string' && CLOSE_COMMAND.test(payload.tool_input.command),
  plan: ({ entry }) => ({ args: ['sync', entry.name] }),
})
finish()
