import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  RECORD_TYPE,
  SOURCE_KIND,
  countLeads,
  createRecall,
  isPersonMessage,
  isSubagent,
  metaOf,
  parseReply,
  promptOf,
  recallArgs,
  runCommand,
  summaryOf,
} from '../src/recall.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-rummage.mjs', import.meta.url))

const text = (t) => [{ type: 'text', text: t }]
const web = (id, t) => ({ id, role: 'user', content: text(t), source: { kind: 'user', rpcId: `rpc-${id}` } })
const telegram = (id, t) => ({ id, role: 'user', content: text(t), source: { kind: 'user', rpcId: `telegram:1:${id}`, principal: { kind: 'telegram-user', channel: 'telegram', id: '1' } } })

const settings = (over = {}) => ({ enabled: true, command: FAKE, sources: [], maxItems: 4, maxChars: 1500, timeoutMs: 3000, ...over })

function harness(over = {}, deps = {}) {
  const warnings = []
  const records = []
  const deferred = []
  let config = settings(over)
  const recall = createRecall({
    config: () => config,
    createUserMessage: (input) => ({ id: `notice-${Math.random()}`, role: 'user', ...input }),
    appendRecord: (session, type, data) => records.push({ session, type, data }),
    warn: (line) => warnings.push(line),
    defer: (fn) => deferred.push(fn),
    ...deps,
  })
  const step = (messages, extra = {}) =>
    recall.preStep({ agent: { id: 'session-abc' }, messages, turn: 1, step: 1, signal: new AbortController().signal, ...extra }, async () => ({ kind: 'enter', messages }))
  return { recall, step, warnings, records, deferred, setConfig: (c) => (config = settings(c)) }
}

test('a person message is a client prompt: rpcId or principal, kind user', () => {
  assert.equal(isPersonMessage(web('a', 'hi')), true)
  assert.equal(isPersonMessage(telegram('a', 'hi')), true)
  assert.equal(isPersonMessage({ role: 'user', content: text('x'), source: { kind: 'user', principal: { kind: 'oidc-user' } } }), true)
  // a plain user message: a person in a top-level session (ACP), the parent's brief in a subagent's
  const plain = { role: 'user', content: text('do this'), source: { kind: 'user' } }
  assert.equal(isPersonMessage(plain), true)
  assert.equal(isPersonMessage(plain, { subagent: true }), false)
  assert.equal(isPersonMessage(web('a', 'typed into a child session'), { subagent: true }), true)
  assert.equal(isSubagent({ session: { header: { delegationDepth: 1, parentSession: 'p' } } }), true)
  assert.equal(isSubagent({ session: { header: { delegationDepth: 0 } } }), false)
  assert.equal(isSubagent({ id: 'x' }), false)
  // the Telegram bot's claim marker
  assert.equal(isPersonMessage({ role: 'user', content: text('x'), source: { kind: 'user', rpcId: 'telegram-claim:1' } }), false)
  for (const kind of ['schedule', 'agent-message', 'subagent-settled', 'tool-jobs', 'tool', 'telegram-sender', 'oidc-sender', SOURCE_KIND]) {
    assert.equal(isPersonMessage({ role: 'user', content: text('x'), source: { kind, rpcId: 'r', principal: { kind: 'cron-job' } } }), false, kind)
  }
  assert.equal(isPersonMessage({ role: 'assistant', content: text('x'), source: { kind: 'user', rpcId: 'r' } }), false)
})

test('the prompt is the text blocks without a bridge sender line', () => {
  assert.equal(promptOf(web('a', '漏水传感器到了没有')), '漏水传感器到了没有')
  assert.equal(promptOf({ content: text('[Telegram message from Ana (@x, user id 1)]\n你好呀 there') }), '你好呀 there')
  assert.equal(promptOf({ content: [{ type: 'image' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(promptOf({ content: text('[not a sender line] keep') }), '[not a sender line] keep')
})

test('arguments carry sources and budgets', () => {
  assert.deepEqual(recallArgs(settings({ sources: ['vault', 'dsh'], maxItems: 3, maxChars: 900 })), ['recall', '--hook', '-s', 'vault', '-s', 'dsh', '--max-items', '3', '--max-chars', '900'])
})

test('hook replies parse into context, empty or error', () => {
  assert.deepEqual(parseReply(''), { kind: 'empty' })
  assert.deepEqual(parseReply('{"hookSpecificOutput":{"additionalContext":"  x  "}}\n'), { kind: 'context', text: 'x' })
  assert.deepEqual(parseReply('{"hookSpecificOutput":{"additionalContext":""}}'), { kind: 'empty' })
  assert.equal(parseReply('oops').kind, 'error')
  assert.equal(parseReply('{"other":1}').kind, 'error')
})

test('leads are counted and summarised', () => {
  assert.equal(countLeads('head\n- #ab · x\n  snip\n- #cd · y\nnot - #ef'), 2)
  assert.equal(summaryOf(3, 180.4), 'rummage recall · 3 leads · 180 ms')
  assert.equal(summaryOf(1, 9), 'rummage recall · 1 lead · 9 ms')
  assert.equal(summaryOf(0, 9), 'rummage recall · 9 ms')
})

test('leads go right after the person message, with the session id and settings passed on', async () => {
  const { step } = harness({ sources: ['vault'], maxItems: 2 })
  const before = { id: 'notice', role: 'user', content: text('[sender]'), source: { kind: 'telegram-sender', form: 'notice', summary: 's' } }
  const prompt = telegram('m1', '[Telegram message from Ana (@x, user id 1)]\nwhere is the leak sensor')
  const after = { id: 'time', role: 'user', content: text('time'), source: { kind: 'time-context' } }
  const decision = await step([before, prompt, after])
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(decision.messages.map((m) => m.id).filter((id) => !id.startsWith('notice-')), ['notice', 'm1', 'time'])
  const added = decision.messages[2]
  assert.equal(added.role, 'user')
  assert.equal(added.source.kind, SOURCE_KIND)
  assert.equal(added.source.form, 'notice')
  assert.equal(added.source.leads, 2)
  assert.equal(added.source.messageId, 'm1')
  assert.match(added.source.summary, /^rummage recall · 2 leads · \d+ ms$/)
  const block = added.content[0].text
  assert.match(block, /prompt=where is the leak sensor/)
  assert.match(block, /dsh:session-abc#3/)
  assert.match(block, /args=recall --hook -s vault --max-items 2 --max-chars 1500/)
})

test('steps without a person message pass through untouched and run nothing', async () => {
  let ran = 0
  const { step } = harness({}, { run: async () => (ran++, { stdout: '', stderr: '', code: 0, timedOut: false, aborted: false }) })
  for (const messages of [
    [{ id: 'j', role: 'user', content: text('scheduled'), source: { kind: 'schedule', principal: { kind: 'cron-job' } } }],
    [{ id: 'r', role: 'user', content: text('child report'), source: { kind: 'agent-message', form: 'relay' } }],
    [],
  ]) {
    const decision = await step(messages)
    assert.equal(decision.messages, messages)
  }
  const brief = [{ id: 'b', role: 'user', content: text('subagent brief'), source: { kind: 'user' } }]
  const child = { id: 'child', session: { header: { id: 'child', delegationDepth: 1, parentSession: 'session-abc' } } }
  assert.equal((await step(brief, { agent: child })).messages, brief)
  assert.equal(ran, 0)
})

test('a rejected step, a disabled plugin or an empty prompt add nothing', async () => {
  const { recall, setConfig, step } = harness()
  const rejected = await recall.preStep({ agent: { id: 's' }, messages: [web('a', 'x')] }, async () => ({ kind: 'reject' }))
  assert.deepEqual(rejected, { kind: 'reject' })
  setConfig({ enabled: false })
  const messages = [web('b', 'hello there')]
  assert.equal((await step(messages)).messages, messages)
  setConfig({})
  const blank = [{ id: 'c', role: 'user', content: [{ type: 'image' }], source: { kind: 'user', rpcId: 'r' } }]
  assert.equal((await step(blank)).messages, blank)
})

test('the same message is recalled once even if its step is entered again', async () => {
  let ran = 0
  const reply = JSON.stringify({ hookSpecificOutput: { additionalContext: '- #a · x' } })
  const { step } = harness({}, { run: async () => (ran++, { stdout: reply, stderr: '', code: 0, timedOut: false, aborted: false }) })
  const messages = [web('same', 'question')]
  assert.equal((await step(messages)).messages.length, 2)
  assert.equal((await step(messages)).messages.length, 1)
  assert.equal(ran, 1)
})

test('several person messages in one step get one recall over all their words', async () => {
  const seen = []
  const reply = JSON.stringify({ hookSpecificOutput: { additionalContext: '- #a · x' } })
  const { step } = harness({}, { run: async (_c, _a, { input }) => (seen.push(JSON.parse(input)), { stdout: reply, stderr: '', code: 0, timedOut: false, aborted: false }) })
  const decision = await step([web('a', 'first'), web('b', 'second')])
  assert.deepEqual(seen, [{ hook_event_name: 'UserPromptSubmit', prompt: 'first\n\nsecond', session_id: 'session-abc', harness: 'dsh' }])
  assert.deepEqual(decision.messages.map((m) => m.id.startsWith('notice-') ? 'N' : m.id), ['a', 'b', 'N'])
})

test('a timeout adds nothing, logs once per outage and records the skip after the message', async () => {
  const { step, recall, warnings, records, deferred } = harness({ timeoutMs: 300 })
  const messages = [web('t1', 'this is slow')]
  const started = Date.now()
  const decision = await step(messages)
  assert.ok(Date.now() - started < 3000, 'the step did not wait for the slow command')
  assert.equal(decision.messages, messages)
  await step([web('t2', 'slow again')])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /timeout/)
  // the record waits for the person's message to be in the log
  assert.equal(records.length, 0)
  const session = { id: 'session-abc' }
  recall.onSessionEvent(session, { type: 'user/message', data: { id: 't1' } })
  assert.equal(records.length, 0, 'not appended inside the event delivery')
  deferred.splice(0).forEach((fn) => fn())
  assert.equal(records.length, 1)
  assert.equal(records[0].session, session)
  assert.equal(records[0].type, RECORD_TYPE)
  assert.equal(records[0].data.reason, 'timeout')
  assert.equal(records[0].data.messageId, 't1')
  assert.equal(records[0].data.turn, 1)
  // a working recall ends the outage; the next failure logs again
  await step([web('ok', 'fine now')])
  await step([web('t3', 'slow once more')])
  assert.equal(warnings.length, 2)
})

test('errors and no match are skipped quietly or logged, never added', async () => {
  const { step, recall, warnings, records, deferred } = harness()
  for (const [id, words] of [['c', 'crash'], ['g', 'garbage']]) {
    const messages = [web(id, words)]
    assert.equal((await step(messages)).messages, messages)
  }
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /exit 2: boom/)
  const quiet = [web('n', 'nothing here')]
  assert.equal((await step(quiet)).messages, quiet)
  for (const id of ['c', 'g', 'n']) recall.onSessionEvent({}, { type: 'user/message', data: { id } })
  deferred.splice(0).forEach((fn) => fn())
  assert.deepEqual(records.map((r) => r.data.reason), ['error', 'error', 'no-match'])
  assert.equal(recall.pendingCount, 0)
})

test('a missing command is an error, logged once', async () => {
  const { step, warnings } = harness({ command: '/nonexistent/rummage' })
  const messages = [web('x', 'hello world')]
  assert.equal((await step(messages)).messages, messages)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ENOENT/)
})

test('an aborted step kills the command and records nothing', async () => {
  const { recall, records, deferred, warnings } = harness({ timeoutMs: 10000 })
  const controller = new AbortController()
  const messages = [web('ab', 'slow please')]
  setTimeout(() => controller.abort(), 100)
  const started = Date.now()
  const decision = await recall.preStep({ agent: { id: 's' }, messages, signal: controller.signal }, async () => ({ kind: 'enter', messages }))
  assert.ok(Date.now() - started < 3000)
  assert.equal(decision.messages, messages)
  recall.onSessionEvent({}, { type: 'user/message', data: { id: 'ab' } })
  deferred.splice(0).forEach((fn) => fn())
  assert.equal(records.length, 0)
  assert.equal(warnings.length, 0)
})

test('runCommand passes stdin and reports exit codes', async () => {
  const ok = await runCommand(FAKE, ['recall', '--hook'], { input: '{"prompt":"hi","session_id":"s"}', timeoutMs: 5000 })
  assert.equal(ok.code, 0)
  assert.equal(parseReply(ok.stdout).kind, 'context')
  const bad = await runCommand(FAKE, [], { input: '{"prompt":"crash"}', timeoutMs: 5000 })
  assert.equal(bad.code, 2)
  assert.equal(bad.stderr.trim(), 'boom')
})

test('the hook input carries the session cwd and the harness; rummage metadata is kept even without leads', async () => {
  const seen = []
  const metas = []
  const replies = [
    { hookSpecificOutput: { additionalContext: '- #a · x' }, rummage: { scope: 'proj', index: { state: 'building', line: 'indexing 3/10', file: '/p' } } },
    { rummage: { scope: 'proj', paused: 'memory paused until 16:30' } },
    { hookSpecificOutput: { additionalContext: '' }, rummage: { scope: 'proj', index: { state: 'complete', line: '' } } },
  ]
  const { step, recall, records, deferred } = harness({}, {
    cwdOf: (agent) => `/work/${agent.id}`,
    onMeta: (...args) => metas.push(args),
    run: async (_c, _a, { input }) => (seen.push(JSON.parse(input)), { stdout: JSON.stringify(replies[seen.length - 1]), stderr: '', code: 0, timedOut: false, aborted: false }),
  })
  const first = await step([web('m1', 'one')])
  assert.equal(seen[0].cwd, '/work/session-abc')
  assert.equal(seen[0].harness, 'dsh')
  assert.deepEqual(first.messages[1].source.rummage, replies[0].rummage)
  await step([web('m2', 'two')])
  await step([web('m3', 'three')])
  assert.deepEqual(metas.map((m) => m[0]), ['session-abc', 'session-abc', 'session-abc'])
  assert.equal(metas[1][1], '/work/session-abc')
  for (const id of ['m2', 'm3']) recall.onSessionEvent({}, { type: 'user/message', data: { id } })
  deferred.splice(0).forEach((fn) => fn())
  assert.deepEqual(records.map((r) => [r.data.reason, r.data.rummage]), [['no-match', replies[1].rummage], ['no-match', replies[2].rummage]])
})

test('a cwd lookup that throws or finds nothing leaves cwd out', async () => {
  const seen = []
  const run = async (_c, _a, { input }) => (seen.push(JSON.parse(input)), { stdout: '', stderr: '', code: 0, timedOut: false, aborted: false })
  await harness({}, { run, cwdOf: () => { throw new Error('gone') } }).step([web('a', 'x')])
  await harness({}, { run, cwdOf: () => undefined }).step([web('b', 'y')])
  assert.deepEqual(seen.map((s) => 'cwd' in s), [false, false])
})

test('metadata is size-capped to scope and status', () => {
  assert.equal(metaOf(null), undefined)
  assert.equal(metaOf([]), undefined)
  assert.equal(metaOf({}), undefined)
  assert.deepEqual(metaOf({ scope: 's', index: { state: 'complete' } }), { scope: 's', index: { state: 'complete' } })
  assert.deepEqual(metaOf({ scope: 's', status: 'x', blob: 'y'.repeat(5000) }), { scope: 's', status: 'x' })
  assert.deepEqual(parseReply('{"rummage":{"scope":"s"}}'), { kind: 'empty', meta: { scope: 's' } })
})
