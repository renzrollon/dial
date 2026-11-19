import test from 'node:test'
import assert from 'node:assert/strict'
import { DESCRIPTIONS, LIMITS, effectiveLimits, formatLimits } from '../lib/limits.mjs'

const REG = '/tmp/home/registry.json'

// Pins specs/limits/spec.md, "Every cap is published with a default and a description"
// (add-dial-ask delta): thirteen caps in this order with these defaults.
const TEN = {
  staleDays: 14,
  archivedKeepDays: 30,
  briefLines: 40,
  subprocessTimeoutSeconds: 10,
  remoteIntervalMinutes: 30,
  syncIntervalMinutes: 15,
  narrateTurns: 20,
  narrateTimeoutSeconds: 30,
  nextRows: 50,
  watchPollSeconds: 30
}
const NEW_CAPS = { remotePullRequests: 20, contextNarrative: 5, contextLines: 200 }
const THIRTEEN = { ...TEN, ...NEW_CAPS }
const VOICE_CAPS = { voiceTurnSeconds: 120, voiceCloseSeconds: 10, voiceTurnChars: 2000 }
// Pins specs/limits/spec.md, "Every cap is published with a default and a description"
// (add-voice-ui delta): sixteen caps, the three voice caps last.
const SIXTEEN = { ...THIRTEEN, ...VOICE_CAPS }
const SESSION_CAPS = { voiceSessions: 3, voiceSessionPollSeconds: 5, voiceSessionRows: 12, voiceLogLines: 200, voiceProposalSeconds: 120 }
// Pins specs/limits/spec.md, "Every cap is published with a default and a description"
// (add-voice-orchestrator delta): twenty-one caps, the five session caps last.
const TWENTY_ONE = { ...SIXTEEN, ...SESSION_CAPS }
// Pins specs/limits/spec.md, "Every cap is published with a default and a description"
// (add-voice-stage-and-capture delta): twenty-two caps, captureChars last.
const TWENTY_TWO = { ...TWENTY_ONE, captureChars: 2000 }

// Re-pinned for add-voice-stage-and-capture, limits: "Every cap is published with a default and a description" (twenty-one became twenty-two, captureChars last).
test('twenty-two caps are published with the stated defaults in the published order, frozen (limits: Every cap is published with a default and a description)', () => {
  assert.deepEqual({ ...LIMITS }, TWENTY_TWO)
  assert.deepEqual(Object.keys(LIMITS), Object.keys(TWENTY_TWO))
  assert.ok(Object.isFrozen(LIMITS))
  assert.ok(Object.isFrozen(DESCRIPTIONS))
})

// Re-pinned for add-voice-stage-and-capture, limits: "Every cap has a description" (each of the twenty-two lines).
test('every cap has a one-line lowercase description and no other cap exists', () => {
  assert.deepEqual(Object.keys(DESCRIPTIONS), Object.keys(LIMITS))
  assert.equal(Object.keys(LIMITS).length, 22)
  for (const [name, text] of Object.entries(DESCRIPTIONS)) {
    assert.equal(typeof text, 'string', name)
    assert.match(text, /^[a-z]/, name)
    assert.ok(!text.includes('\n'), name)
  }
})

// Re-pinned for add-voice-stage-and-capture, limits: "Defaults with no registry" (twenty-two caps).
test('effectiveLimits with no overrides returns the defaults', () => {
  for (const overrides of [undefined, null, {}]) {
    const out = effectiveLimits(overrides, REG)
    assert.equal(out.ok, true)
    assert.deepEqual({ ...out.limits }, TWENTY_TWO)
  }
})

// Re-pinned for add-voice-stage-and-capture, limits: "Override is reflected" (the other twenty-one keep their defaults).
test('an override replaces only the key it names, the other twenty-one keep their defaults (limits: Override is reflected)', () => {
  const out = effectiveLimits({ staleDays: 7 }, REG)
  assert.equal(out.ok, true)
  assert.deepEqual({ ...out.limits }, { ...TWENTY_TWO, staleDays: 7 })
  assert.equal(LIMITS.staleDays, 14)
})

// Re-pinned for add-voice-stage-and-capture, limits: "The registry overrides a cap" (the other caps are now twenty-one).
test('the seven new caps can be overridden and a bad value for one is refused naming it (limits: The registry overrides a cap)', () => {
  const out = effectiveLimits({ nextRows: 10, syncIntervalMinutes: 5 }, REG)
  assert.equal(out.ok, true)
  assert.deepEqual({ ...out.limits }, { ...TWENTY_TWO, nextRows: 10, syncIntervalMinutes: 5 })
  const bad = effectiveLimits({ watchPollSeconds: -30 }, REG)
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /watchPollSeconds/)
  assert.match(bad.reason, /positive integer/)
})

test('an unknown cap key is refused, quoted as written, naming the file', () => {
  const out = effectiveLimits({ coffeeBreaks: 3 }, REG)
  assert.equal(out.ok, false)
  assert.equal(out.reason, `registry limits: unknown cap coffeeBreaks in ${REG}`)
})

test('a non-positive or non-integer value is refused naming the key and requiring a positive integer', () => {
  for (const bad of [0, -1, 1.5, '40', null, NaN, true]) {
    const out = effectiveLimits({ briefLines: bad }, REG)
    assert.equal(out.ok, false, String(bad))
    assert.match(out.reason, /briefLines/, String(bad))
    assert.match(out.reason, /positive integer/, String(bad))
    assert.ok(out.reason.includes(REG), String(bad))
  }
})

// Re-pinned for add-voice-stage-and-capture, limits: "Every cap has a description" (twenty-two lines).
test('formatLimits prints one aligned line per cap with a trailing newline', () => {
  const text = formatLimits(LIMITS)
  assert.ok(text.endsWith('\n'))
  const lines = text.slice(0, -1).split('\n')
  assert.equal(lines.length, 22)
  const width = Math.max(...Object.keys(LIMITS).map(n => n.length))
  Object.keys(LIMITS).forEach((name, i) => {
    assert.match(lines[i], /^\S+\s+=\s+\d+  \S/)
    assert.equal(lines[i], `${name.padEnd(width)} = ${String(LIMITS[name]).padStart(9)}  ${DESCRIPTIONS[name]}`)
  })
})

test('formatLimits prints the values it is given', () => {
  const text = formatLimits({ ...TWENTY_TWO, staleDays: 7 })
  assert.match(text.split('\n')[0], /^staleDays\s+=\s+7  \S/)
})

// limits: "The new caps say what they bound" (add-dial-ask delta).
// Re-pinned for add-voice-ui: the context caps are no longer last, the voice caps follow them.
test('the three context caps follow the first ten, with their defaults and the descriptions the spec words', () => {
  assert.deepEqual(Object.keys(LIMITS).slice(10, 13), ['remotePullRequests', 'contextNarrative', 'contextLines'])
  assert.equal(LIMITS.remotePullRequests, 20)
  assert.equal(LIMITS.contextNarrative, 5)
  assert.equal(LIMITS.contextLines, 200)
  assert.equal(DESCRIPTIONS.remotePullRequests, 'open pull requests kept per repo by a remote sync')
  assert.equal(DESCRIPTIONS.contextNarrative, 'narrative entries dial context prints')
  assert.equal(DESCRIPTIONS.contextLines, 'maximum lines dial context prints as text')
})

test('formatLimits ends the three new lines with their descriptions', () => {
  const lines = formatLimits(LIMITS).slice(0, -1).split('\n')
  assert.ok(lines[10].startsWith('remotePullRequests') && lines[10].endsWith('open pull requests kept per repo by a remote sync'))
  assert.ok(lines[11].startsWith('contextNarrative') && lines[11].endsWith('narrative entries dial context prints'))
  assert.ok(lines[12].startsWith('contextLines') && lines[12].endsWith('maximum lines dial context prints as text'))
})

// Re-pinned for add-voice-stage-and-capture, limits: "The registry overrides a cap" (scenario "Override of a context cap": twenty-two caps in all).
test('the context caps can be overridden and every other cap keeps its default (limits: Override of a context cap)', () => {
  const out = effectiveLimits({ remotePullRequests: 5, contextLines: 80 }, REG)
  assert.equal(out.ok, true)
  assert.deepEqual({ ...out.limits }, { ...TWENTY_TWO, remotePullRequests: 5, contextLines: 80 })
  assert.deepEqual(Object.keys(out.limits), Object.keys(TWENTY_TWO))
  const bad = effectiveLimits({ contextNarrative: 0 }, REG)
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /contextNarrative/)
  assert.match(bad.reason, /positive integer/)
})

// limits: "The voice caps say what they bound" (add-voice-ui delta).
// Re-pinned for add-voice-orchestrator: the voice caps are no longer last, the five session caps follow them.
test('the three voice caps follow the context caps, with their defaults and the descriptions the spec words', () => {
  assert.deepEqual(Object.keys(LIMITS).slice(13, 16), ['voiceTurnSeconds', 'voiceCloseSeconds', 'voiceTurnChars'])
  assert.equal(LIMITS.voiceTurnSeconds, 120)
  assert.equal(LIMITS.voiceCloseSeconds, 10)
  assert.equal(LIMITS.voiceTurnChars, 2000)
  assert.equal(DESCRIPTIONS.voiceTurnSeconds, 'seconds before a voice turn is stopped')
  assert.equal(DESCRIPTIONS.voiceCloseSeconds, 'seconds dial voice stays up after its last window closes')
  assert.equal(DESCRIPTIONS.voiceTurnChars, 'maximum characters in one voice turn')
})

test('formatLimits ends the three voice lines with their descriptions', () => {
  const lines = formatLimits(LIMITS).slice(0, -1).split('\n')
  assert.ok(lines[13].startsWith('voiceTurnSeconds') && lines[13].endsWith('seconds before a voice turn is stopped'))
  assert.ok(lines[14].startsWith('voiceCloseSeconds') && lines[14].endsWith('seconds dial voice stays up after its last window closes'))
  assert.ok(lines[15].startsWith('voiceTurnChars') && lines[15].endsWith('maximum characters in one voice turn'))
})

// limits: "Caps are available as JSON" (add-voice-orchestrator delta): keys in the published order.
// Re-pinned for add-voice-stage-and-capture: twenty-one keys became twenty-two.
test('the JSON form of the caps has the twenty-two keys in the published order', () => {
  const json = JSON.stringify(LIMITS)
  assert.equal(json, JSON.stringify(TWENTY_TWO))
  assert.deepEqual(Object.keys(JSON.parse(json)), [
    'staleDays', 'archivedKeepDays', 'briefLines', 'subprocessTimeoutSeconds', 'remoteIntervalMinutes', 'syncIntervalMinutes',
    'narrateTurns', 'narrateTimeoutSeconds', 'nextRows', 'watchPollSeconds', 'remotePullRequests', 'contextNarrative',
    'contextLines', 'voiceTurnSeconds', 'voiceCloseSeconds', 'voiceTurnChars', 'voiceSessions', 'voiceSessionPollSeconds',
    'voiceSessionRows', 'voiceLogLines', 'voiceProposalSeconds', 'captureChars'
  ])
})

// limits: "Override of a voice cap".
// Re-pinned for add-voice-stage-and-capture, limits: "The registry overrides a cap" (every other cap is one of twenty-two).
test('the voice caps can be overridden and every other cap keeps its default', () => {
  const out = effectiveLimits({ voiceTurnSeconds: 30, voiceTurnChars: 500 }, REG)
  assert.equal(out.ok, true)
  assert.deepEqual({ ...out.limits }, { ...TWENTY_TWO, voiceTurnSeconds: 30, voiceTurnChars: 500 })
  assert.deepEqual(Object.keys(out.limits), Object.keys(TWENTY_TWO))
})

// limits: "Voice cap with a bad value".
test('a voice cap of zero is refused naming it and requiring a positive integer', () => {
  const out = effectiveLimits({ voiceCloseSeconds: 0 }, REG)
  assert.equal(out.ok, false)
  assert.match(out.reason, /voiceCloseSeconds/)
  assert.match(out.reason, /positive integer/)
  assert.ok(out.reason.includes(REG))
})

// limits: "The session caps say what they bound" (add-voice-orchestrator delta).
// Re-pinned for add-voice-stage-and-capture: the session caps are no longer last, captureChars follows them.
test('the five session caps follow the voice caps, with their defaults and the descriptions the spec words', () => {
  assert.deepEqual(Object.keys(LIMITS).slice(16, 21), ['voiceSessions', 'voiceSessionPollSeconds', 'voiceSessionRows', 'voiceLogLines', 'voiceProposalSeconds'])
  assert.deepEqual(Object.fromEntries(Object.entries(LIMITS).slice(16, 21)), SESSION_CAPS)
  assert.equal(DESCRIPTIONS.voiceSessions, 'sessions dial voice may have running at once')
  assert.equal(DESCRIPTIONS.voiceSessionPollSeconds, 'seconds between reads of the session list')
  assert.equal(DESCRIPTIONS.voiceSessionRows, 'maximum sessions listed')
  assert.equal(DESCRIPTIONS.voiceLogLines, "maximum lines of a session's screen shown")
  assert.equal(DESCRIPTIONS.voiceProposalSeconds, 'seconds before an unconfirmed proposal expires')
})

test('formatLimits ends the five session lines with their descriptions', () => {
  const lines = formatLimits(LIMITS).slice(0, -1).split('\n')
  assert.ok(lines[16].startsWith('voiceSessions ') && lines[16].endsWith('sessions dial voice may have running at once'))
  assert.ok(lines[17].startsWith('voiceSessionPollSeconds') && lines[17].endsWith('seconds between reads of the session list'))
  assert.ok(lines[18].startsWith('voiceSessionRows') && lines[18].endsWith('maximum sessions listed'))
  assert.ok(lines[19].startsWith('voiceLogLines') && lines[19].endsWith("maximum lines of a session's screen shown"))
  assert.ok(lines[20].startsWith('voiceProposalSeconds') && lines[20].endsWith('seconds before an unconfirmed proposal expires'))
})

// limits: "The subprocess cap names the claude session calls".
test('the subprocess cap description names the claude session calls', () => {
  assert.equal(DESCRIPTIONS.subprocessTimeoutSeconds, 'seconds before a git, gh, glab, interlock or claude session call is abandoned')
  const line = formatLimits(LIMITS).split('\n')[3]
  assert.ok(line.startsWith('subprocessTimeoutSeconds') && line.endsWith('seconds before a git, gh, glab, interlock or claude session call is abandoned'))
})

// limits: "Override of a session cap".
test('the session caps can be overridden and every other cap keeps its default', () => {
  const out = effectiveLimits({ voiceSessions: 1, voiceLogLines: 50 }, REG)
  assert.equal(out.ok, true)
  assert.deepEqual({ ...out.limits }, { ...TWENTY_TWO, voiceSessions: 1, voiceLogLines: 50 })
  assert.deepEqual(Object.keys(out.limits), Object.keys(TWENTY_TWO))
})

// limits: "Session cap with a bad value".
test('a session cap of zero is refused naming it and requiring a positive integer', () => {
  const out = effectiveLimits({ voiceSessionPollSeconds: 0 }, REG)
  assert.equal(out.ok, false)
  assert.match(out.reason, /voiceSessionPollSeconds/)
  assert.match(out.reason, /positive integer/)
  assert.ok(out.reason.includes(REG))
})

// limits: "The capture cap says what it bounds" (add-voice-stage-and-capture delta).
test('the capture cap is the last of the twenty-two, with its default and the description the spec words', () => {
  assert.equal(Object.keys(LIMITS).at(-1), 'captureChars')
  assert.equal(LIMITS.captureChars, 2000)
  assert.equal(DESCRIPTIONS.captureChars, 'maximum characters in a captured note')
  const lines = formatLimits(LIMITS).slice(0, -1).split('\n')
  assert.ok(lines[21].startsWith('captureChars') && lines[21].endsWith('maximum characters in a captured note'))
})

// limits: "Override of the capture cap".
test('the capture cap can be overridden and every other cap keeps its default', () => {
  const out = effectiveLimits({ captureChars: 100 }, REG)
  assert.equal(out.ok, true)
  assert.deepEqual({ ...out.limits }, { ...TWENTY_TWO, captureChars: 100 })
  assert.deepEqual(Object.keys(out.limits), Object.keys(TWENTY_TWO))
})

// limits: "Capture cap with a bad value" (the registry side; the dial capture side is in test/cli.test.mjs).
test('a capture cap of zero is refused naming it and requiring a positive integer', () => {
  const out = effectiveLimits({ captureChars: 0 }, REG)
  assert.equal(out.ok, false)
  assert.match(out.reason, /captureChars/)
  assert.match(out.reason, /positive integer/)
  assert.ok(out.reason.includes(REG))
})
