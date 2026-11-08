/**
 * 尚书省 · 状态与工作流档案 (plugin-owned state, never session events).
 *
 * The session log belongs to the Harness; a plugin may not append new event
 * types to it. Workflow state therefore lives in a small directory the plugin
 * owns: `state.json` (recent runs), `audit.jsonl` (append-only audit trail) and
 * `agents.json` (吏部 capability statistics). Every write is best-effort: a
 * read-only or full disk degrades observability, never the workflow.
 * @module sansheng-lib/state
 */
import { mkdirSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { nowIso } from './util.js'

/** Create the plugin state directory eagerly so first writes cannot race. */
export function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** Read a JSON file, returning the fallback on any failure. */
async function readJson(file, fallback) {
  try {
    const text = await readFile(file, 'utf8')
    if (text.trim().length === 0) return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** Write JSON atomically (temp file + rename). */
async function writeJson(file, value) {
  try {
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
    return true
  } catch {
    return false
  }
}

/**
 * One workflow's publicly visible record. Large model output is kept only in
 * the audit trail, never in the history index.
 * @param record - the live record.
 */
function compactRecord(record) {
  return {
    taskId: record.taskId,
    goal: record.goal,
    level: record.level,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    elapsedMs: record.elapsedMs,
    departments: record.departments,
    totals: record.totals,
    reviewVerdict: record.reviewVerdict,
    reworkRounds: record.reworkRounds,
    retries: record.retries,
    subtasks: Array.isArray(record.subtasks)
      ? record.subtasks.map((subtask) => ({
          id: subtask.id,
          title: subtask.title,
          status: subtask.status,
          attempts: subtask.attempts,
          childId: subtask.childId,
          tokens: subtask.tokens,
          error: subtask.error
        }))
      : [],
    warnings: Array.isArray(record.warnings) ? record.warnings.slice(-40) : [],
    error: record.error
  }
}

/**
 * Create the workflow store.
 * @param options - storage options.
 * @param options.dir - state directory.
 * @param options.audit - whether to append the audit trail.
 * @param options.historyLimit - how many finished runs to retain.
 * @param options.logger - optional logger with `warn`.
 */
export function createStore(options = {}) {
  const dir = options.dir
  const audit = options.audit !== false
  const historyLimit = Number.isFinite(options.historyLimit) ? options.historyLimit : 100
  const logger = options.logger
  const stateFile = join(dir, 'state.json')
  const auditFile = join(dir, 'audit.jsonl')
  const agentsFile = join(dir, 'agents.json')
  const overridesFile = join(dir, 'overrides.json')

  const active = new Map()
  let history = []
  let agents = {}
  let overrides = {}
  let loaded = false
  let pendingState = Promise.resolve()

  const warn = (message) => {
    try {
      logger?.warn?.(`[sansheng] ${message}`)
    } catch {
      // Logging must never fail a workflow.
    }
  }

  const persistState = () => {
    pendingState = pendingState
      .then(() => writeJson(stateFile, { version: 1, updatedAt: nowIso(), history }))
      .catch(() => {})
    return pendingState
  }

  return {
    dir,
    /** Load persisted state once. */
    async init() {
      if (loaded) return
      loaded = true
      ensureDir(dir)
      const state = await readJson(stateFile, undefined)
      if (Array.isArray(state?.history)) history = state.history.slice(-historyLimit)
      const agentState = await readJson(agentsFile, undefined)
      if (agentState && typeof agentState === 'object') agents = agentState
      const overrideState = await readJson(overridesFile, undefined)
      if (overrideState && typeof overrideState === 'object') overrides = overrideState
    },
    /** Register a live workflow and return its mutable record. */
    begin(record) {
      active.set(record.taskId, record)
      this.record('workflow/start', {
        taskId: record.taskId,
        goal: record.goal,
        level: record.level,
        taskChars: record.taskChars
      })
      return record
    },
    /** Read a live workflow. */
    get(taskId) {
      return active.get(taskId)
    },
    /** Mutate a live workflow record. */
    update(taskId, patch) {
      const record = active.get(taskId)
      if (record === undefined) return undefined
      Object.assign(record, patch)
      return record
    },
    /** List live workflows. */
    listActive() {
      return [...active.values()]
    },
    /** Move a workflow into history and persist it. */
    async finish(record) {
      active.delete(record.taskId)
      const compact = compactRecord(record)
      history.push(compact)
      if (history.length > historyLimit) history = history.slice(-historyLimit)
      await persistState()
      this.record('workflow/end', compact)
      return compact
    },
    /** Append one audit line. */
    record(type, payload) {
      if (!audit) return
      const line = JSON.stringify({ at: nowIso(), type, ...payload })
      appendFile(auditFile, `${line}\n`, 'utf8').catch((error) => {
        warn(`audit write failed: ${error.message}`)
      })
    },
    /** Recent finished runs, newest first. */
    recent(limit = 10) {
      return [...history].reverse().slice(0, Math.max(1, limit))
    },
    /** Record one role outcome for 吏部 statistics. */
    recordAgentOutcome(role, outcome = {}) {
      const key = `${role}:${outcome.route ?? 'inherit'}`
      const entry = agents[key] ?? {
        role,
        route: outcome.route ?? 'inherit',
        runs: 0,
        successes: 0,
        failures: 0,
        totalTokens: 0,
        totalMs: 0
      }
      entry.runs += 1
      if (outcome.ok === true) entry.successes += 1
      else entry.failures += 1
      entry.totalTokens += Number(outcome.tokens) || 0
      entry.totalMs += Number(outcome.ms) || 0
      entry.lastAt = nowIso()
      agents[key] = entry
      writeJson(agentsFile, agents).catch(() => {})
    },
    /** Agent statistics for the status view. */
    agentStats() {
      return Object.values(agents).map((entry) => ({
        ...entry,
        successRate: entry.runs > 0 ? Number((entry.successes / entry.runs).toFixed(3)) : null,
        avgTokens: entry.runs > 0 ? Math.round(entry.totalTokens / entry.runs) : null
      }))
    },
    /** Runtime configuration overrides (tools can change them without a restart). */
    getOverrides() {
      return { ...overrides }
    },
    /** Persist runtime overrides. */
    async setOverrides(patch) {
      overrides = { ...patch }
      await writeJson(overridesFile, overrides)
      return overrides
    }
  }
}
