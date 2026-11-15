/**
 * What rummage last said about each session's memory (scope, index progress,
 * a pause), for the Web badge, and the commands that pause and resume it.
 *
 * Every recall reply carries a `rummage` object; the newest one per session
 * is kept. Between prompts the badge asks the host for it, and the host
 * refreshes lazily: it stats the index's progress file at most every couple
 * of seconds and runs `rummage status --line --json` only when that file
 * changed or the last answer is getting old. Nothing runs while no page asks,
 * and nothing here opens rummage's index itself.
 */

import { statSync } from 'node:fs'
import { metaOf, runCommand } from './recall.js'

/** How often the progress file may be stat'ed for one session. */
export const STAT_EVERY_MS = 2_000
/** Longest a not-finished status is reused without asking rummage again. */
export const BUSY_REFRESH_MS = 30_000
/** Longest a finished status is reused (a pause set elsewhere shows up within this). */
export const IDLE_REFRESH_MS = 120_000
/** Most sessions remembered. */
export const MAX_SESSIONS = 256

/** The index part of a `rummage` object, whichever shape it came in. */
export function indexOf(meta) {
  const index = meta?.index
  return typeof index === 'object' && index !== null && !Array.isArray(index) ? index : undefined
}

/** The pause line, from the object itself or its index. */
export function pausedOf(meta) {
  if (typeof meta?.paused === 'string' && meta.paused !== '') return meta.paused
  const paused = indexOf(meta)?.paused
  return typeof paused === 'string' && paused !== '' ? paused : ''
}

/** Whether rummage still has work to report: building, paused, stopped, failed, or memory paused. */
export function isBusy(meta) {
  const state = indexOf(meta)?.state
  return pausedOf(meta) !== '' || (typeof state === 'string' && state !== 'complete')
}

/**
 * Read `rummage status --line --json`: the same object a recall reply carries
 * as `rummage`, or just its `index` part.
 * @param {string} stdout
 */
export function parseStatus(stdout) {
  let value
  try {
    value = JSON.parse(stdout.trim())
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  return metaOf(typeof value.state === 'string' ? { index: value } : value)
}

/**
 * @param {object} deps
 * @param {() => { command: string }} deps.config
 * @param {(sessionId: string) => string | undefined} deps.cwdOf - a live session's directory.
 * @param {typeof runCommand} [deps.run]
 * @param {(path: string) => { mtimeMs: number } | undefined} [deps.stat]
 * @param {() => number} [deps.now]
 * @param {number} [deps.timeoutMs]
 */
export function createStatus({ config, cwdOf, run = runCommand, stat = safeStat, now = Date.now, timeoutMs = 5_000 }) {
  /** sessionId -> { meta, cwd, statAt, mtimeMs, askedAt, pending } */
  const sessions = new Map()

  function entryFor(sessionId) {
    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      entry = { meta: undefined, cwd: undefined, statAt: 0, mtimeMs: undefined, askedAt: 0, pending: undefined }
      sessions.set(sessionId, entry)
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
    }
    return entry
  }

  /** A recall reply's `rummage` object, newest wins. */
  function remember(sessionId, cwd, meta) {
    if (typeof sessionId !== 'string' || sessionId === '' || meta === undefined) return
    const entry = entryFor(sessionId)
    entry.meta = meta
    if (typeof cwd === 'string' && cwd !== '') entry.cwd = cwd
    entry.askedAt = now()
    entry.mtimeMs = fileTime(meta)
  }

  function fileTime(meta) {
    const file = indexOf(meta)?.file
    return typeof file === 'string' && file !== '' ? stat(file)?.mtimeMs : undefined
  }

  async function ask(sessionId, entry) {
    const cwd = entry.cwd ?? cwdOf(sessionId)
    if (typeof cwd === 'string' && cwd !== '') entry.cwd = cwd
    entry.askedAt = now()
    const result = await run(config().command, ['status', '--line', '--json', '--session', sessionId], {
      input: '',
      timeoutMs,
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    })
    if (result.code !== 0 || result.timedOut || result.error !== undefined) return
    const meta = parseStatus(result.stdout)
    if (meta === undefined) return
    entry.meta = meta
    entry.mtimeMs = fileTime(meta)
  }

  /**
   * The newest `rummage` object for a session, refreshed when it may be stale.
   * @param {string} sessionId
   * @returns {Promise<object | null>}
   */
  async function read(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const entry = entryFor(sessionId)
    const at = now()
    let due = entry.meta === undefined
      ? at - entry.askedAt >= BUSY_REFRESH_MS || entry.askedAt === 0
      : at - entry.askedAt >= (isBusy(entry.meta) ? BUSY_REFRESH_MS : IDLE_REFRESH_MS)
    const file = indexOf(entry.meta)?.file
    if (!due && typeof file === 'string' && file !== '' && at - entry.statAt >= STAT_EVERY_MS) {
      entry.statAt = at
      const mtimeMs = stat(file)?.mtimeMs
      if (mtimeMs !== entry.mtimeMs) due = true
    }
    if (due) {
      entry.pending ??= ask(sessionId, entry).finally(() => {
        entry.pending = undefined
      })
      await entry.pending
    }
    return entry.meta ?? null
  }

  /**
   * `/rummage-pause [what] [for]` and `/rummage-resume`: rummage's own verbs
   * for this session, answered with its one-line result.
   */
  async function command(verb, sessionId, rawInput) {
    const words = String(rawInput ?? '').trim().split(/\s+/u).filter(Boolean)
    const entry = entryFor(sessionId)
    const cwd = entry.cwd ?? cwdOf(sessionId)
    const result = await run(config().command, [verb, ...words, '--session', sessionId], {
      input: '',
      timeoutMs,
      ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    })
    const line = (result.stdout.trim() || result.stderr.trim()).split('\n')[0] ?? ''
    // The next badge poll asks rummage again, so the pause shows at once.
    entry.askedAt = 0
    if (result.code === 0 && !result.timedOut && result.error === undefined) return { kind: 'success', text: line || `rummage ${verb}: done` }
    const why = result.timedOut ? 'no answer in time' : result.error !== undefined ? result.error.message : line || `exit ${result.code}`
    return { kind: 'error', text: `rummage ${verb}: ${why}` }
  }

  return { remember, read, command, get size() { return sessions.size } }
}

function safeStat(path) {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}
