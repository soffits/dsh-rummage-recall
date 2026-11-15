import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { RECORD_TYPE, SOURCE_KIND } from '../src/recall.js'

/** A React stand-in: elements are plain objects, function components run on render, state is local. */
function fakeReact() {
  const states = []
  let cursor = 0
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const at = cursor++
      if (!(at in states)) states[at] = initial
      return [states[at], (next) => (states[at] = typeof next === 'function' ? next(states[at]) : next)]
    },
    reset: () => (cursor = 0),
  }
}

async function loadClient(React) {
  let entry
  globalThis.window = { __ModuleLoader__: { load: (module) => (entry = module) } }
  try {
    new Function(await readFile(new URL('../client.js', import.meta.url), 'utf8'))()
  } finally {
    delete globalThis.window
  }
  return { id: entry.id, mod: entry.factory((name) => (name === 'react' ? React : undefined)) }
}

/** Render an element tree, running function components. */
function render(node, React) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((n) => render(n, React))
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }), React)
  return { ...node, children: node.children.map((c) => render(c, React)) }
}

const texts = (node) => (node === null || node === undefined ? [] : typeof node !== 'object' ? [String(node)] : Array.isArray(node) ? node.flatMap(texts) : node.children.flatMap(texts))
const find = (node, pred) => {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, pred)
      if (hit) return hit
    }
    return undefined
  }
  return pred(node) ? node : find(node.children, pred)
}

const t = (key) => ({ title: 'rummage recall', leads: '{n} leads', lead: '1 lead', noMatch: 'no plausible match', timeout: 'skipped: timeout', error: 'skipped: error', injected: 'Added to the message' })[key]

const leadEvent = {
  type: 'user/message',
  seq: 12,
  time: 1,
  surfaceOp: 'append',
  data: {
    id: 'n1',
    role: 'user',
    content: [{ type: 'text', text: 'Recalled…\n- #a · x\n- #b · y\n- #c · z' }],
    source: { kind: SOURCE_KIND, form: 'notice', summary: 'rummage recall · 3 leads · 180 ms', leads: 3, durationMs: 180 },
  },
}
const recordEvent = (data) => ({ type: RECORD_TYPE, seq: 20, time: 2, ignorable: true, data })

test('client registers under the package name', async () => {
  const { id } = await loadClient(fakeReact())
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(id, pkg.name)
})

test('the definition claims the leads message and the skip record, nothing else', async () => {
  const { mod } = await loadClient(fakeReact())
  const { match } = mod.definition
  assert.deepEqual(match['user/message'](leadEvent), { id: 'n1', role: 'start', exclusive: true })
  assert.deepEqual(match[RECORD_TYPE](recordEvent({ reason: 'timeout', durationMs: 3000 })), { id: `${RECORD_TYPE}:20`, role: 'start', exclusive: true })
  assert.equal(match['user/message']({ ...leadEvent, surfaceOp: undefined }), null, 'a compaction replacement copy is not drawn')
  assert.equal(match['user/message']({ ...leadEvent, data: { ...leadEvent.data, source: { kind: 'user', rpcId: 'r' } } }), null)
  assert.equal(match['user/message']({ type: 'assistant/message', data: {} }), null)
})

test('a node sits in the process disclosure and carries the row data', async () => {
  const { mod } = await loadClient(fakeReact())
  const state = mod.definition.start({}, { event: leadEvent })
  const node = mod.definition.buildViewNode({ key: 'k', id: 'n1', state, start: { location: { kind: 'step', turn: 1, step: 1 } } })
  assert.equal(node.kind, SOURCE_KIND)
  assert.equal(node.target, 'chat')
  assert.equal(node.anchorSeq, 12)
  assert.equal(node.visibility, 'visible')
  assert.equal(node.groupTree, 'process')
  assert.deepEqual(node.data, { seq: 12, time: 1, outcome: 'leads', leads: 3, durationMs: 180, text: leadEvent.data.content[0].text })
  assert.equal(mod.definition.buildViewNode({ key: 'k', id: 'x', state: undefined }), null)
})

test('summaries for leads, no match, timeout and error', async () => {
  const { mod } = await loadClient(fakeReact())
  const read = (event) => mod.rowSummary(mod.readEvent(event), t)
  assert.equal(read(leadEvent), '3 leads · 180 ms')
  assert.equal(read({ ...leadEvent, data: { ...leadEvent.data, source: { ...leadEvent.data.source, leads: 1 } } }), '1 lead · 180 ms')
  assert.equal(read(recordEvent({ reason: 'no-match', durationMs: 420 })), 'no plausible match · 420 ms')
  assert.equal(read(recordEvent({ reason: 'timeout', durationMs: 3000 })), 'skipped: timeout · 3000 ms')
  assert.equal(read(recordEvent({ reason: 'error', durationMs: 12, detail: 'exit 1' })), 'skipped: error · 12 ms')
})

test('the row is collapsed by default and expands to the exact added text', async () => {
  const React = fakeReact()
  const { mod } = await loadClient(React)
  const data = mod.readEvent(leadEvent)
  React.reset()
  const closed = render(React.createElement(mod.RecallRow, { node: { data }, t }), React)
  assert.deepEqual(texts(closed).filter((s) => s.trim()), ['rummage recall', '3 leads · 180 ms'])
  const row = find(closed, (n) => n.props?.role === 'button')
  assert.equal(row.props['aria-expanded'], false)
  row.props.onClick()
  React.reset()
  const opened = render(React.createElement(mod.RecallRow, { node: { data }, t }), React)
  const pre = find(opened, (n) => n.type === 'pre')
  assert.equal(texts(pre).join(''), leadEvent.data.content[0].text)
})

test('a no-match row has nothing to expand', async () => {
  const React = fakeReact()
  const { mod } = await loadClient(React)
  React.reset()
  const out = render(React.createElement(mod.RecallRow, { node: { data: mod.readEvent(recordEvent({ reason: 'no-match', durationMs: 5 })) }, t }), React)
  assert.equal(find(out, (n) => n.props?.role === 'button'), undefined)
  assert.equal(find(out, (n) => n.type === 'pre'), undefined)
})

test('apply registers the definition, the row view and both dictionaries', async () => {
  const { mod } = await loadClient(fakeReact())
  const calls = { definitions: [], slots: [], dictionaries: [] }
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: (ns, lang, dict) => (calls.dictionaries.push([ns, lang, Object.keys(dict).length]), () => {}) },
    inject: (_deps, fn) => fn({ uiConversation: { events: { register: (d) => calls.definitions.push(d.kind) } } }),
    slots: { inject: (_name, fn) => fn(), register: (options, view) => calls.slots.push([options.name, options.key, view.name]) },
  }
  mod.apply(ctx)
  assert.deepEqual(calls.definitions, [SOURCE_KIND])
  assert.deepEqual(calls.slots, [['conversation.chat.node', SOURCE_KIND, 'RecallRow']])
  assert.deepEqual(calls.dictionaries.map((d) => d.slice(0, 2)), [['rummage-recall', 'en'], ['rummage-recall', 'zh']])
  assert.deepEqual(Object.keys(mod.en).sort(), Object.keys(mod.zh).sort())
})
