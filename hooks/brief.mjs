#!/usr/bin/env node
/** SessionStart hook: `dial brief <repo> --hook [--session <id>]`, its envelope relayed verbatim. */
import { finish, runHook } from './common.mjs'

runHook('brief', {
  timeoutMs: 8_000,
  plan: ({ payload, entry }) => ({
    args: ['brief', entry.name, '--hook', ...(typeof payload.session_id === 'string' && payload.session_id ? ['--session', payload.session_id] : [])],
    relay: true,
  }),
})
finish()
