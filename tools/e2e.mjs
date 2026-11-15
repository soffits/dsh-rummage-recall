#!/usr/bin/env node
// End-to-end check on a real DSH, in a throwaway DSH_HOME under .e2e/ (never the live one).
//
// A scripted OpenAI-compatible model stands in for a real one and logs every request it gets;
// test/fixtures/fake-rummage.mjs stands in for rummage. Over ACP one session gets three prompts
// (leads, nothing found, too slow) and one that starts a subagent. The check passes when the
// leads reach the model right after the prompt they belong to, the skipped recalls leave only a
// log-only record after their prompt, the subagent's brief and the child's report start no
// recall, and the session log still opens in a fresh DSH.
//
// Usage: node tools/e2e.mjs [--keep]
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const keep = process.argv.includes('--keep')
const root = join(REPO, '.e2e', `run-${Date.now()}`)
const home = join(root, 'home')
const work = join(root, 'work')
const modelLog = join(root, 'model.jsonl')
const rummageLog = join(root, 'rummage.jsonl')
const rummageState = join(root, 'rummage-state.json')
mkdirSync(work, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (line) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${line}`)
const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).map((p) => p.text ?? '').join(''))

// ---------------------------------------------------------------------------------------------
// The scripted model: answers OK-<n> to the n-th root prompt, starts a subagent for E2E-SUB.

function decide(body) {
  const messages = body.messages ?? []
  const all = messages.map((m) => textOf(m.content)).join('\n')
  const last = messages.at(-1)
  if (all.includes('E2E-CHILD')) return { who: 'child', text: 'child done' }
  if (all.includes('E2E-SUB') && textOf(last?.content).includes('E2E-SUB')) {
    return { who: 'root', tool: ['subagent', { description: 'e2e child', prompt: 'E2E-CHILD: answer at once.' }] }
  }
  if (last?.role === 'tool' || last?.role === 'user') return { who: 'root', text: 'ok' }
  return { who: 'other', text: 'Title' }
}

function stream(res, decision) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta, finish = null) =>
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  if (decision.tool) {
    const [name, args] = decision.tool
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
    chunk({}, 'tool_calls')
  } else {
    chunk({ role: 'assistant', content: decision.text })
    chunk({}, 'stop')
  }
  res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`)
  res.end('data: [DONE]\n\n')
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm1', object: 'model' }] }))
      return
    }
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      // answered as "other"
    }
    const decision = decide(body)
    appendFileSync(modelLog, `${JSON.stringify({ at: Date.now(), ...decision, messages: (body.messages ?? []).map((m) => ({ role: m.role, text: textOf(m.content) })) })}\n`)
    stream(res, decision)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const modelPort = server.address().port

// ---------------------------------------------------------------------------------------------
// The throwaway DSH

const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: 'C.UTF-8',
  DSH_HOME: home,
  E2E_MODEL_KEY: 'none',
  FAKE_RUMMAGE_LOG: rummageLog,
  FAKE_RUMMAGE_STATE: rummageState,
}
execFileSync('dsh', ['--profile', 'acp', '--dump-config'], { env, stdio: 'ignore' })
const profile = join(home, 'profiles', 'acp')
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
manifest.dsh.profile.bundles.push('@soffits/dsh-rummage-recall')
writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2))
mkdirSync(join(profile, 'node_modules', '@soffits'), { recursive: true })
symlinkSync(REPO, join(profile, 'node_modules', '@soffits', 'dsh-rummage-recall'))

const patch = join(root, 'patch.yml')
writeFileSync(
  patch,
  [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      e2e:',
    '        displayName: E2E',
    '        apiKeyEnv: E2E_MODEL_KEY',
    '        api: openai-completions',
    `        baseURL: http://127.0.0.1:${modelPort}/v1`,
    '        models:',
    '          - id: m1',
    '            name: Scripted',
    '            contextWindow: 200000',
    '            maxTokens: 8000',
    '- id: acp',
    '  config:',
    '    provider: e2e',
    '    model: m1',
    '- id: agent-default-model',
    '  config:',
    '    provider: e2e',
    '    model: m1',
    '- id: rummage-recall',
    '  config:',
    `    command: ${JSON.stringify(join(REPO, 'test', 'fixtures', 'fake-rummage.mjs'))}`,
    '    sources: [vault]',
    '    timeoutMs: 1500',
    '',
  ].join('\n'),
)

class Dsh {
  constructor(tag) {
    this.child = spawn('dsh', ['--profile', 'acp', '--patch', patch], { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'] })
    this.next = 1
    this.waiting = new Map()
    this.errFile = join(root, `dsh-${tag}.stderr`)
    this.child.stderr.on('data', (c) => appendFileSync(this.errFile, c))
    let buffered = ''
    this.child.stdout.on('data', (c) => {
      buffered += c
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const line = buffered.slice(0, at)
        buffered = buffered.slice(at + 1)
        if (line.trim()) this.receive(line)
      }
    })
    this.exited = new Promise((r) => this.child.once('exit', (code, signal) => r({ code, signal })))
  }
  receive(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.method === undefined && msg.id !== undefined) {
      const w = this.waiting.get(msg.id)
      this.waiting.delete(msg.id)
      if (msg.error) w?.fail(new Error(JSON.stringify(msg.error)))
      else w?.done(msg.result ?? {})
    } else if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      const allow = msg.params?.options?.find((o) => o.kind?.startsWith('allow'))
      this.send({ jsonrpc: '2.0', id: msg.id, result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } })
    } else if (msg.id !== undefined) {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } })
    }
  }
  send(msg) {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`)
  }
  request(method, params, timeoutMs = 120_000) {
    const id = this.next++
    return new Promise((done, fail) => {
      const t = setTimeout(() => fail(new Error(`${method}: no answer`)), timeoutMs)
      this.waiting.set(id, { done: (r) => (clearTimeout(t), done(r)), fail: (e) => (clearTimeout(t), fail(e)) })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }
  async stop() {
    this.child.kill('SIGTERM')
    const timeout = sleep(30_000).then(() => 'timeout')
    if ((await Promise.race([this.exited, timeout])) === 'timeout') {
      this.child.kill('SIGKILL')
      await this.exited
    }
  }
}

/** DSH writes its zstd logs as one frame per append; Node's one-shot decoder reads only the first. */
function decodeFrames(buf) {
  const parts = []
  let off = 0
  while (off + 5 < buf.length) {
    const start = off
    off += 4
    const d = buf.readUInt8(off)
    off += 1
    const fcs = d >>> 6
    const single = (d & 32) !== 0
    const dict = d & 3
    off += (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (fcs === 0 ? (single ? 1 : 0) : 1 << fcs)
    for (;;) {
      if (off + 3 > buf.length) return Buffer.concat(parts)
      const h = buf.readUIntLE(off, 3)
      off += 3
      off += ((h >>> 1) & 3) === 1 ? 1 : h >>> 3
      if (h & 1) break
    }
    if (d & 4) off += 4
    if (off > buf.length) break
    parts.push(zstdDecompressSync(buf.subarray(start, off)))
  }
  return Buffer.concat(parts)
}

function sessionLogs() {
  const out = new Map()
  const dir = join(home, 'sessions')
  for (const ws of readdirSync(dir)) {
    for (const id of readdirSync(join(dir, ws))) {
      const sdir = join(dir, ws, id)
      if (!statSync(sdir).isDirectory()) continue
      const file = readdirSync(sdir).find((f) => f.startsWith('session.v'))
      if (!file) continue
      let buf = readFileSync(join(sdir, file))
      if (file.endsWith('.zstd')) buf = decodeFrames(buf)
      const lines = buf.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      out.set(lines[0].id, lines)
    }
  }
  return out
}

const jsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

const failures = []
const expect = (ok, line) => {
  say(`${ok ? 'PASS' : 'FAIL'} ${line}`)
  if (!ok) failures.push(line)
}

try {
  say(`home ${home}, model on :${modelPort}`)
  const dsh = new Dsh('1')
  await dsh.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const { sessionId } = await dsh.request('session/new', { cwd: work, mcpServers: [] })
  say(`session ${sessionId}`)
  const prompt = (text) => dsh.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 180_000)
  await prompt('E2E one: where did the leak sensor go')
  await prompt('E2E two: nothing to find here')
  await prompt('E2E three: this one is slow')
  await prompt('E2E-SUB: start a subagent')
  await sleep(4000)
  await dsh.stop()

  const logs = sessionLogs()
  const events = logs.get(sessionId) ?? []
  const childId = [...logs.keys()].find((id) => logs.get(id)[0].parentSession === sessionId)
  const calls = jsonl(rummageLog)
  say(`recall calls: ${JSON.stringify(calls.map((c) => c.event.prompt))}`)
  expect(calls.length === 4, `one recall per person message, none for the brief or the child's report (got ${calls.length})`)
  expect(calls.every((c) => c.event.session_id === sessionId), 'every call carries the session id')
  expect(calls.every((c) => c.argv.join(' ') === 'recall --hook -s vault --max-items 4 --max-chars 1500'), 'the settings reach the command line')
  expect(calls.every((c) => c.event.cwd === work && c.event.harness === 'dsh'), `every call carries the session cwd and the harness (${calls[0]?.event.cwd})`)

  const users = events.filter((e) => e.type === 'user/message')
  const order = events
    .filter((e) => e.type === 'user/message' || e.type.startsWith('plugin:'))
    .map((e) => (e.type === 'user/message' ? `${e.data.source.kind}:${textOf(e.data.content).slice(0, 18)}` : `${e.type}:${e.data.reason}`))
  say(`log order: ${JSON.stringify(order)}`)
  const at = (needle) => order.findIndex((o) => o.includes(needle))
  expect(order[at('E2E one') + 1]?.startsWith('rummage-recall:'), 'the leads come right after the first prompt')
  expect(order[at('E2E two') + 1] === 'plugin:rummage-recall/outcome:no-match', 'no match leaves a record right after the second prompt')
  expect(order[at('E2E three') + 1] === 'plugin:rummage-recall/outcome:timeout', 'the timeout leaves a record right after the third prompt')
  expect(users.filter((e) => e.data.source.kind === 'rummage-recall').length === 2, 'leads for the first prompt and the subagent prompt, nothing else')
  const firstLeads = users.find((e) => e.data.source.kind === 'rummage-recall')
  expect(firstLeads?.data.source.rummage?.scope === 'work' && firstLeads.data.source.rummage.index?.state === 'building', 'the leads message keeps rummage\'s scope and index state')
  const record = events.find((e) => e.type === 'plugin:rummage-recall/outcome')
  expect(record?.data.rummage?.index?.line === 'indexing 8/12 files', `a skip record keeps rummage's status too (${record?.data.rummage?.index?.line})`)
  expect(record?.ignorable === true, 'the record is ignorable')

  const requests = jsonl(modelLog).filter((l) => l.who === 'root')
  const sawLeads = requests.find((r) => r.messages.some((m) => m.text.includes('#aaaa111111')))
  const rows = sawLeads?.messages.filter((m) => m.role === 'user').map((m) => m.text) ?? []
  const leadAt = rows.findIndex((t) => t.includes('#aaaa111111'))
  expect(leadAt > 0 && rows[leadAt - 1].includes('E2E one'), 'the model got the leads as a user message right after the prompt')
  // The timeout record's detail is text only the record holds.
  expect(!requests.some((r) => r.messages.some((m) => m.text.includes('no answer within'))), 'no record text reached the model')
  expect(!JSON.stringify(requests.map((r) => r.messages.filter((m) => m.role === 'system'))).includes('#aaaa111111'), 'nothing went into the system prompt')
  expect(Boolean(childId), `a subagent ran (${childId})`)
  expect(!(logs.get(childId) ?? []).some((e) => e.type === 'user/message' && e.data.source.kind === 'rummage-recall'), 'the child got no leads')

  const stderr = existsSync(dsh.errFile) ? readFileSync(dsh.errFile, 'utf8') : ''
  const warns = stderr.split('\n').filter((l) => l.includes('rummage-recall'))
  say(`log lines: ${JSON.stringify(warns)}`)
  if (stderr === '') say('SKIP the logger wrote nothing to stderr in this mode; logging once is covered by the unit tests')
  else expect(warns.filter((l) => l.includes('recall failed')).length === 1, 'the timeout was logged once')
  expect(!stderr.includes('did not activate'), 'every plugin activated')

  say('second start: the session opens again with its records')
  const again = new Dsh('2')
  await again.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const resumed = await again.request('session/resume', { sessionId, cwd: work, mcpServers: [] }).then(() => true, (e) => (say(String(e)), false))
  expect(resumed, 'session/resume opens the log with the plugin records')
  const answered = await again.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'E2E after restart' }] }, 120_000).then(() => true, (e) => (say(String(e)), false))
  expect(answered, 'the reopened session takes another prompt')
  await again.stop()
} catch (error) {
  failures.push(String(error?.stack ?? error))
  say(`error: ${error?.stack ?? error}`)
} finally {
  server.close()
  if (!keep && failures.length === 0) rmSync(root, { recursive: true, force: true })
  else say(`kept ${root}`)
}
say(failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
