/**
 * The adapter between a DSH step and `rummage recall --hook`.
 *
 * Everything that decides what is recalled lives in rummage; this module only
 * picks the messages a person wrote, hands their text to the command in the
 * prompt-hook shape (`{prompt, session_id}` on stdin, the hook's JSON reply on
 * stdout) and turns the reply into one context message placed right after the
 * person's message. Nothing here imports DSH, so the tests run it with fakes.
 */

import { spawn } from 'node:child_process'

/** Source kind of the context message this plugin adds. */
export const SOURCE_KIND = 'rummage-recall'
/** Plugin record left in the session log when nothing was added (display only). */
export const RECORD_TYPE = 'plugin:rummage-recall/outcome'
/** Hook event name rummage's `--hook` mode speaks (Claude Code's and Codex's prompt hook). */
export const HOOK_EVENT = 'UserPromptSubmit'
/** Harness name sent in the hook input, so rummage knows whose sessions the project's chats are. */
export const HARNESS = 'dsh'
/** Most characters of rummage's reply metadata kept on a message or record. */
export const MAX_META_CHARS = 2000
/** Most message ids remembered, both for "already recalled" and for pending records. */
export const MAX_REMEMBERED = 1024
/** Most bytes read from the command's stdout or stderr. */
export const MAX_OUTPUT_BYTES = 256 * 1024

/**
 * Whether a message is one a person wrote. A client prompting on someone's
 * behalf (the Web UI, a chat bridge) leaves a request id or a sender
 * principal on it. In a top-level session a plain `user` message is a person
 * too (an editor over ACP sends neither field); in a subagent's session the
 * same shape is the parent's brief. A scheduled job's prompt, another agent's
 * message, a tool result and every plugin notice have another source kind.
 * @param {any} message - a user-role message entering a step.
 * @param {{ subagent?: boolean }} [where] - whether the session is a subagent's.
 * @returns {boolean}
 */
export function isPersonMessage(message, { subagent = false } = {}) {
  const source = message?.source
  if (message?.role !== 'user' || source?.kind !== 'user') return false
  if (typeof source.rpcId === 'string') return !source.rpcId.startsWith('telegram-claim:')
  if (typeof source.principal === 'object' && source.principal !== null) return true
  return !subagent
}

/**
 * Whether an agent runs a subagent's session (it has a parent).
 * @param {any} agent - the pre-step payload's agent.
 * @returns {boolean}
 */
export function isSubagent(agent) {
  const header = agent?.session?.header
  return (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) || typeof header?.parentSession === 'string'
}

/** A sender line some chat bridges put above the person's words. */
const SENDER_LINE = /^\[[^\]\n]* message from [^\n]*\]\s*\n/u

/**
 * The words of a person's message, without a bridge's sender line.
 * @param {any} message
 * @returns {string}
 */
export function promptOf(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  return text.replace(SENDER_LINE, '').trim()
}

/**
 * The command line for one recall.
 * @param {{ sources: string[], maxItems: number, maxChars: number }} config
 * @returns {string[]} arguments after the command.
 */
export function recallArgs(config) {
  const args = ['recall', '--hook']
  for (const source of config.sources ?? []) args.push('-s', source)
  args.push('--max-items', String(config.maxItems), '--max-chars', String(config.maxChars))
  return args
}

/**
 * What rummage says about the recall besides the leads (`rummage` next to
 * `hookSpecificOutput`): the scope it searched, index progress, a pause, and
 * whatever detail it adds. Kept as JSON, size-capped.
 * @param {unknown} value
 * @returns {{ scope?: string, status?: string, [key: string]: unknown } | undefined}
 */
export function metaOf(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fits = (object) => {
    try {
      const json = JSON.stringify(object)
      return json !== undefined && json.length <= MAX_META_CHARS
    } catch {
      return false
    }
  }
  if (Object.keys(value).length === 0) return undefined
  if (fits(value)) return JSON.parse(JSON.stringify(value))
  // Too big: keep what the row and badge show (scope, index, pause, status); drop the rest, project detail first.
  const short = {}
  for (const key of ['scope', 'index', 'paused', 'status']) if (value[key] !== undefined) short[key] = value[key]
  if (fits(short)) return JSON.parse(JSON.stringify(short))
  const name = typeof value.scope === 'string' ? value.scope : value.scope?.name
  const tiny = {}
  if (typeof name === 'string') tiny.scope = name.slice(0, 200)
  if (typeof value.status === 'string') tiny.status = value.status.slice(0, 200)
  return Object.keys(tiny).length > 0 ? tiny : undefined
}

/**
 * Read the hook's reply.
 * @param {string} stdout
 * @returns {{ kind: 'empty', meta?: object } | { kind: 'context', text: string, meta?: object } | { kind: 'error', reason: string }}
 */
export function parseReply(stdout) {
  const raw = stdout.trim()
  if (raw === '') return { kind: 'empty' }
  let reply
  try {
    reply = JSON.parse(raw)
  } catch {
    return { kind: 'error', reason: `not JSON: ${raw.slice(0, 120)}` }
  }
  const meta = metaOf(reply?.rummage)
  const withMeta = meta === undefined ? {} : { meta }
  const output = reply?.hookSpecificOutput
  if (output === undefined && meta !== undefined) return { kind: 'empty', ...withMeta }
  const text = output?.additionalContext
  if (typeof text !== 'string') return { kind: 'error', reason: 'no hookSpecificOutput.additionalContext in the reply' }
  return text.trim() === '' ? { kind: 'empty', ...withMeta } : { kind: 'context', text: text.trim(), ...withMeta }
}

/**
 * How many leads a recall block holds: rummage starts each with `- #<id>`.
 * @param {string} text
 * @returns {number}
 */
export function countLeads(text) {
  return (text.match(/^- #\S+/gmu) ?? []).length
}

/**
 * One-line account of the recall, the notice's summary.
 * @param {number} leads
 * @param {number} durationMs
 */
export function summaryOf(leads, durationMs) {
  const parts = ['rummage recall']
  if (leads > 0) parts.push(`${leads} ${leads === 1 ? 'lead' : 'leads'}`)
  parts.push(`${Math.round(durationMs)} ms`)
  return parts.join(' · ')
}

/**
 * Run a command with `input` on stdin, killed after `timeoutMs` or when
 * `signal` aborts.
 * @param {string} command
 * @param {string[]} args
 * @param {{ input: string, timeoutMs: number, signal?: AbortSignal, cwd?: string }} options
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null, timedOut: boolean, aborted: boolean, error?: Error }>}
 */
export function runCommand(command, args, { input, timeoutMs, signal, cwd }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(cwd === undefined ? {} : { cwd }) })
    } catch (error) {
      resolve({ stdout: '', stderr: '', code: null, timedOut: false, aborted: false, error })
      return
    }
    const out = []
    const err = []
    let outBytes = 0
    let errBytes = 0
    let timedOut = false
    let aborted = false
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const kill = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    const onAbort = () => {
      aborted = true
      kill()
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => {
      if (outBytes < MAX_OUTPUT_BYTES) out.push(chunk)
      outBytes += chunk.length
    })
    child.stderr.on('data', (chunk) => {
      if (errBytes < MAX_OUTPUT_BYTES) err.push(chunk)
      errBytes += chunk.length
    })
    child.on('error', (error) => finish({ stdout: '', stderr: '', code: null, timedOut, aborted, error }))
    child.on('close', (code) =>
      finish({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code,
        timedOut,
        aborted,
      }),
    )
    child.stdin.on('error', () => {
      // the command may exit without reading stdin
    })
    child.stdin.end(input)
  })
}

/** Keep a Map or Set at most `limit` entries, dropping the oldest. */
function bound(collection, limit) {
  while (collection.size > limit) {
    const oldest = collection.keys().next().value
    collection.delete(oldest)
  }
}

/**
 * The `agent/pre-step` listener and its `session/event` companion.
 *
 * @param {object} deps
 * @param {() => { enabled: boolean, command: string, sources: string[], maxItems: number, maxChars: number, timeoutMs: number }} deps.config
 * @param {(input: { content: object[], source: object }) => object} deps.createUserMessage - DSH's message factory.
 * @param {(session: object, type: string, data: object) => void} deps.appendRecord - DSH's appendPluginRecord.
 * @param {(line: string) => void} deps.warn - logger.
 * @param {(agent: object) => string | undefined} [deps.cwdOf] - the session's current working directory.
 * @param {(sessionId: string, cwd: string | undefined, meta: object) => void} [deps.onMeta] - rummage's status object from each reply.
 * @param {typeof runCommand} [deps.run]
 * @param {() => number} [deps.now] - milliseconds, for durations.
 * @param {(fn: () => void) => void} [deps.defer] - runs `fn` after the current session event is delivered.
 */
export function createRecall({ config, createUserMessage, appendRecord, warn, cwdOf = () => undefined, onMeta = () => {}, run = runCommand, now = () => performance.now(), defer = setImmediate }) {
  /** Ids of person messages already handled, so a re-entered step does not recall twice. */
  const handled = new Set()
  /** Outcomes to record once the person's message is in the log: message id -> record data. */
  const pending = new Map()
  /** Set while recall keeps failing, so one outage logs one line. */
  let failing = false

  /**
   * Recall for one prompt.
   * @returns {Promise<{ kind: 'context', text: string, leads: number, durationMs: number, meta?: object }
   *   | { kind: 'skipped', reason: 'no-match' | 'timeout' | 'error', durationMs: number, detail?: string, meta?: object }
   *   | { kind: 'aborted' }>}
   */
  async function recall(prompt, sessionId, cwd, signal) {
    const settings = config()
    const input = JSON.stringify({
      hook_event_name: HOOK_EVENT,
      prompt,
      session_id: sessionId,
      ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
      harness: HARNESS,
    })
    const started = now()
    const result = await run(settings.command, recallArgs(settings), { input, timeoutMs: settings.timeoutMs, signal })
    const durationMs = Math.max(0, now() - started)
    if (result.aborted) return { kind: 'aborted' }
    let failure
    if (result.timedOut) failure = { reason: 'timeout', detail: `no answer within ${settings.timeoutMs} ms` }
    else if (result.error !== undefined) failure = { reason: 'error', detail: `${settings.command}: ${result.error.message}` }
    else if (result.code !== 0) failure = { reason: 'error', detail: `exit ${result.code}: ${result.stderr.trim().slice(0, 300)}` }
    let reply
    if (failure === undefined) {
      reply = parseReply(result.stdout)
      if (reply.kind === 'error') failure = { reason: 'error', detail: reply.reason }
    }
    if (failure !== undefined) {
      if (!failing) warn(`rummage-recall: recall failed (${failure.reason}): ${failure.detail}; adding nothing until it works again`)
      failing = true
      return { kind: 'skipped', reason: failure.reason, durationMs, detail: failure.detail }
    }
    failing = false
    const meta = reply.meta === undefined ? {} : { meta: reply.meta }
    if (reply.kind === 'empty') return { kind: 'skipped', reason: 'no-match', durationMs, ...meta }
    return { kind: 'context', text: reply.text, leads: countLeads(reply.text), durationMs, ...meta }
  }

  /** `agent/pre-step`: recall for the person's words in this step and add the leads after them. */
  async function preStep(payload, next) {
    const decision = await next()
    const settings = config()
    if (!settings.enabled || decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    if (payload?.signal?.aborted) return decision
    const where = { subagent: isSubagent(payload?.agent) }
    const people = decision.messages.filter((message) => isPersonMessage(message, where) && !handled.has(message.id))
    if (people.length === 0) return decision
    for (const message of people) handled.add(message.id)
    bound(handled, MAX_REMEMBERED)
    const prompt = people.map(promptOf).filter((text) => text !== '').join('\n\n')
    if (prompt === '') return decision
    const last = people.at(-1)
    const sessionId = String(payload?.agent?.id ?? payload?.agent?.session?.id ?? '')
    let cwd
    try {
      cwd = cwdOf(payload?.agent)
    } catch {
      cwd = undefined
    }
    const outcome = await recall(prompt, sessionId, cwd, payload?.signal)
    if (outcome.kind === 'aborted') return decision
    if (outcome.meta !== undefined) onMeta(sessionId, cwd, outcome.meta)
    if (outcome.kind === 'skipped') {
      pending.set(last.id, {
        reason: outcome.reason,
        durationMs: Math.round(outcome.durationMs),
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        ...(outcome.meta === undefined ? {} : { rummage: outcome.meta }),
        messageId: last.id,
        ...(typeof payload?.turn === 'number' ? { turn: payload.turn } : {}),
      })
      bound(pending, MAX_REMEMBERED)
      return decision
    }
    const notice = createUserMessage({
      content: [{ type: 'text', text: outcome.text }],
      source: {
        kind: SOURCE_KIND,
        form: 'notice',
        summary: summaryOf(outcome.leads, outcome.durationMs),
        leads: outcome.leads,
        durationMs: Math.round(outcome.durationMs),
        ...(outcome.meta === undefined ? {} : { rummage: outcome.meta }),
        messageId: last.id,
      },
    })
    const at = decision.messages.lastIndexOf(last)
    return { ...decision, messages: [...decision.messages.slice(0, at + 1), notice, ...decision.messages.slice(at + 1)] }
  }

  /** `session/event`: once a person's message with a skipped recall is in the log, record the outcome after it. */
  function onSessionEvent(session, event) {
    if (event?.type !== 'user/message' || pending.size === 0) return
    const id = event.data?.id
    const data = pending.get(id)
    if (data === undefined) return
    pending.delete(id)
    // Not inside this event's delivery: the session refuses an append there.
    defer(() => {
      try {
        appendRecord(session, RECORD_TYPE, data)
      } catch (error) {
        warn(`rummage-recall: could not record a skipped recall: ${error?.message ?? error}`)
      }
    })
  }

  return { preStep, onSessionEvent, recall, get pendingCount() { return pending.size } }
}
