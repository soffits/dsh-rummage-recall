import assert from 'node:assert/strict'
import test from 'node:test'
import { BUSY_REFRESH_MS, IDLE_REFRESH_MS, STAT_EVERY_MS, createStatus, isBusy, parseStatus, pausedOf } from '../src/status.js'
import { createRoutes } from '../src/routes.js'

function fixture({ initial = { index: { state: 'building', line: 'indexing 1/10', file: '/idx/progress.json' } } } = {}) {
  let clock = 1_000_000
  let mtime = 1
  const calls = []
  let reply = initial
  const run = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd })
    if (args[0] === 'status') return { stdout: JSON.stringify(reply), stderr: '', code: 0, timedOut: false, aborted: false }
    if (args[0] === 'pause') return { stdout: 'memory paused until 16:30\n', stderr: '', code: 0, timedOut: false, aborted: false }
    return { stdout: '', stderr: 'nope', code: 3, timedOut: false, aborted: false }
  }
  const status = createStatus({
    config: () => ({ command: 'rummage' }),
    cwdOf: (id) => `/work/${id}`,
    run,
    stat: () => ({ mtimeMs: mtime }),
    now: () => clock,
  })
  return {
    status,
    calls,
    tick: (ms) => (clock += ms),
    touch: () => (mtime += 1),
    reply: (next) => (reply = next),
  }
}

test('status helpers read both shapes and the pause', () => {
  assert.deepEqual(parseStatus('{"state":"building","line":"x"}'), { index: { state: 'building', line: 'x' } })
  assert.deepEqual(parseStatus('{"scope":"s","index":{"state":"complete"}}'), { scope: 's', index: { state: 'complete' } })
  assert.equal(parseStatus('nope'), undefined)
  assert.equal(pausedOf({ paused: 'until 5' }), 'until 5')
  assert.equal(pausedOf({ index: { paused: 'until 6' } }), 'until 6')
  assert.equal(isBusy({ index: { state: 'complete' } }), false)
  assert.equal(isBusy({ index: { state: 'complete' }, paused: 'until 5' }), true)
  assert.equal(isBusy({ index: { state: 'error' } }), true)
})

test('a session with no recall yet asks rummage once, in its directory', async () => {
  const f = fixture()
  const meta = await f.status.read('s1')
  assert.equal(meta.index.state, 'building')
  assert.deepEqual(f.calls, [{ command: 'rummage', args: ['status', '--line', '--json', '--session', 's1'], cwd: '/work/s1' }])
  await f.status.read('s1')
  assert.equal(f.calls.length, 1, 'answered from memory right after')
})

test('while building, the progress file decides when to ask again', async () => {
  const f = fixture()
  f.status.remember('s1', '/repo', { index: { state: 'building', line: 'indexing 1/10', file: '/idx/progress.json' } })
  await f.status.read('s1')
  assert.equal(f.calls.length, 0, 'a fresh reply needs no status run')
  f.tick(STAT_EVERY_MS)
  await f.status.read('s1')
  assert.equal(f.calls.length, 0, 'file unchanged')
  f.touch()
  f.tick(STAT_EVERY_MS - 1)
  await f.status.read('s1')
  assert.equal(f.calls.length, 0, 'not stat-ed again so soon')
  f.tick(1)
  f.reply({ index: { state: 'building', line: 'indexing 5/10', file: '/idx/progress.json' } })
  const meta = await f.status.read('s1')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].cwd, '/repo')
  assert.equal(meta.index.line, 'indexing 5/10')
  f.tick(BUSY_REFRESH_MS)
  await f.status.read('s1')
  assert.equal(f.calls.length, 2, 'asked again when the answer got old')
})

test('once complete, rummage is asked only rarely', async () => {
  const f = fixture({ initial: { index: { state: 'complete', line: '', file: '/idx/progress.json' } } })
  f.status.remember('s1', '/repo', { index: { state: 'complete', line: '', file: '/idx/progress.json' } })
  f.tick(BUSY_REFRESH_MS)
  await f.status.read('s1')
  assert.equal(f.calls.length, 0)
  f.tick(IDLE_REFRESH_MS)
  await f.status.read('s1')
  assert.equal(f.calls.length, 1)
})

test('pause and resume run rummage for this session and refresh the badge', async () => {
  const f = fixture()
  f.status.remember('s1', '/repo', { index: { state: 'complete', line: '', file: '/idx/progress.json' } })
  const paused = await f.status.command('pause', 's1', ' recall 2h ')
  assert.deepEqual(paused, { kind: 'success', text: 'memory paused until 16:30' })
  assert.deepEqual(f.calls[0], { command: 'rummage', args: ['pause', 'recall', '2h', '--session', 's1'], cwd: '/repo' })
  f.reply({ paused: 'memory paused until 16:30', index: { state: 'complete', line: '' } })
  const meta = await f.status.read('s1')
  assert.equal(f.calls.length, 2, 'the next read asks again')
  assert.equal(pausedOf(meta), 'memory paused until 16:30')
  const failed = await f.status.command('resume', 's1', '')
  assert.deepEqual(failed, { kind: 'error', text: 'rummage resume: nope' })
})

test('the status route validates the session id and answers JSON', async () => {
  const [route] = createRoutes({ read: async (id) => ({ scope: id }) })
  assert.equal(route.path, '/api/dsh-rummage-recall/status')
  const ok = await route.fetch(new Request('http://x/api', { method: 'POST', body: JSON.stringify({ sessionId: 'session-1' }) }))
  assert.deepEqual(await ok.json(), { ok: true, value: { rummage: { scope: 'session-1' } } })
  const bad = await route.fetch(new Request('http://x/api', { method: 'POST', body: JSON.stringify({ sessionId: '../etc' }) }))
  assert.equal(bad.status, 400)
  const junk = await route.fetch(new Request('http://x/api', { method: 'POST', body: '{' }))
  assert.equal(junk.status, 400)
})
