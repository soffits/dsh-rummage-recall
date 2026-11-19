#!/usr/bin/env node
// Stands in for rummage. `recall --hook` behaves by the words in the prompt:
//   "slow"  sleeps 5 s, "crash" exits 2, "garbage" prints non-JSON, "nothing" finds nothing,
//   anything else answers with two leads that echo the prompt, the session id and the arguments.
// With FAKE_RUMMAGE_STATE set to a file, replies also carry a `rummage` status object: the scope is
// the cwd's base name, the index is "building" for the first three recalls and then "complete",
// and `status --line --json`, `pause` and `resume` read and change that file.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const argv = process.argv.slice(2)
const stateFile = process.env.FAKE_RUMMAGE_STATE

function loadState() {
  return stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { recalls: 0, paused: '' }
}
function saveState(state) {
  if (stateFile) writeFileSync(stateFile, JSON.stringify(state))
}
function indexOf(state) {
  const done = Math.min(state.recalls * 4, 12)
  const complete = done >= 12
  return {
    state: state.paused ? 'paused' : complete ? 'complete' : 'building',
    line: complete ? '' : `indexing ${done}/12 files`,
    note: complete ? '' : 'Memory of this project is still being built; recall may miss recent files.',
    items: { done, total: 12 },
    vectors: null,
    eta_seconds: complete ? 0 : 30,
    paused: state.paused,
    error: '',
    updated: new Date().toISOString(),
    file: stateFile,
  }
}

if (argv[0] === 'status') {
  process.stdout.write(`${JSON.stringify(indexOf(loadState()))}\n`)
  process.exit(0)
}
if (argv[0] === 'pause' || argv[0] === 'resume') {
  const state = loadState()
  state.paused = argv[0] === 'pause' ? 'memory paused until 16:30' : ''
  saveState(state)
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason: argv[0] === 'pause' ? 'rummage: recall paused until 16:30' : 'rummage: resumed (1 pause ended)' })}\n`)
  process.exit(0)
}

let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', async () => {
  const event = JSON.parse(raw || '{}')
  const prompt = String(event.prompt ?? '')
  if (process.env.FAKE_RUMMAGE_LOG) appendFileSync(process.env.FAKE_RUMMAGE_LOG, `${JSON.stringify({ event, argv })}\n`)
  let meta
  if (stateFile) {
    const state = loadState()
    state.recalls += 1
    saveState(state)
    meta = { scope: event.cwd ? basename(event.cwd) : 'all', index: indexOf(state), ...(state.paused ? { paused: state.paused } : {}) }
  }
  const reply = (additionalContext) =>
    process.stdout.write(`${JSON.stringify({
      ...(additionalContext === undefined ? {} : { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }),
      ...(meta === undefined ? {} : { rummage: meta }),
    })}\n`)
  if (prompt.includes('slow')) await new Promise((r) => setTimeout(r, 5000))
  if (prompt.includes('crash')) {
    process.stderr.write('boom\n')
    process.exit(2)
  }
  if (prompt.includes('garbage')) return void process.stdout.write('not json\n')
  if (prompt.includes('nothing')) return meta === undefined ? undefined : reply(undefined)
  reply([
    'Cues from the user\'s own files, found by rummage; they say where to look, not what is true.',
    `- #aaaa111111 · vault · notes/a.md:1-4 · 2026-11-15 · "A" · prompt=${prompt}${event.images ? ` images=${event.images.join(',')}` : ''}`,
    '  snippet',
    `- #bbbb222222 · dsh · dsh:${event.session_id}#3 · 2026-11-15 · "B" · args=${argv.join(' ')}`,
  ].join('\n'))
})
