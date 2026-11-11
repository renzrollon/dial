#!/usr/bin/env node
/** SessionEnd and PreCompact hook: `dial record --event <E>` with the payload unchanged on stdin. */
import { finish, runHook } from './common.mjs'

const at = process.argv.indexOf('--event')
const event = at === -1 ? process.argv.find(a => a.startsWith('--event='))?.slice(8) : process.argv[at + 1]

runHook('record', {
  timeoutMs: 58_000,
  plan: () => {
    if (event !== 'SessionEnd' && event !== 'PreCompact') throw new Error('record needs --event SessionEnd or PreCompact')
    return { args: ['record', '--event', event], stdin: 'payload' }
  },
})
finish()
