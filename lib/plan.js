/**
 * 中书省 · 任务计划的数据结构与校验 (pure).
 *
 * A plan is a small DAG: every subtask names the subtasks it depends on, and
 * only tasks whose dependencies have completed may be scheduled. Nothing here
 * calls a model — the planner prompt lives in `prompts.js` and the model output
 * is normalized and validated before any agent is started.
 * @module sansheng-lib/plan
 */

const MAX_TITLE = 80

/** Coerce a value into a string list, accepting a single string. */
function asList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean)
  }
  return []
}

/**
 * Normalize one raw subtask.
 * @param raw - planner output for one subtask.
 * @param index - position, used for a fallback identifier.
 * @param issues - sink for diagnostics.
 */
function normalizeSubtask(raw, index, issues) {
  if (typeof raw === 'string') {
    return {
      id: `t${index + 1}`,
      title: raw.slice(0, MAX_TITLE),
      prompt: raw,
      dependsOn: [],
      acceptance: '',
      kind: 'other'
    }
  }
  if (typeof raw !== 'object' || raw === null) {
    issues.push(`第 ${index + 1} 个子任务不是对象，已丢弃`)
    return undefined
  }

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `t${index + 1}`
  const prompt = typeof raw.prompt === 'string' && raw.prompt.trim()
    ? raw.prompt.trim()
    : typeof raw.task === 'string' && raw.task.trim()
      ? raw.task.trim()
      : ''
  const title = typeof raw.title === 'string' && raw.title.trim()
    ? raw.title.trim().slice(0, MAX_TITLE)
    : prompt.slice(0, MAX_TITLE)
  const dependsOn = asList(raw.dependsOn ?? raw.depends_on ?? raw.depends ?? raw.dependencies)
  const acceptance = typeof raw.acceptance === 'string' && raw.acceptance.trim()
    ? raw.acceptance.trim()
    : typeof raw.acceptanceCriteria === 'string'
      ? raw.acceptanceCriteria.trim()
      : ''
  const kind = ['code', 'doc', 'research', 'data', 'other'].includes(raw.kind) ? raw.kind : 'other'

  if (prompt.length === 0) {
    issues.push(`子任务 ${id} 缺少 prompt，已丢弃`)
    return undefined
  }
  return { id, title, prompt, dependsOn, acceptance, kind }
}

/**
 * Normalize and validate a planner result.
 * @param raw - parsed planner output.
 * @param options - validation limits.
 * @param options.maxTasks - hard ceiling on subtask count.
 * @returns a normalized plan plus blocking issues.
 */
export function normalizePlan(raw, options = {}) {
  const issues = []
  const maxTasks = Number.isFinite(options.maxTasks) ? options.maxTasks : 12
  const source = typeof raw === 'object' && raw !== null ? raw : {}

  const list = Array.isArray(source.subtasks)
    ? source.subtasks
    : Array.isArray(source.tasks)
      ? source.tasks
      : Array.isArray(source.steps)
        ? source.steps
        : []

  if (list.length === 0) {
    return { ok: false, issues: ['计划中没有 subtasks'], plan: undefined, warnings: [] }
  }

  const warnings = []
  let subtasks = []
  for (const [index, item] of list.entries()) {
    const normalized = normalizeSubtask(item, index, issues)
    if (normalized !== undefined) subtasks.push(normalized)
  }

  if (subtasks.length > maxTasks) {
    warnings.push(`子任务数 ${subtasks.length} 超过上限 ${maxTasks}，已截断`)
    subtasks = subtasks.slice(0, maxTasks)
  }

  const ids = new Set()
  for (const subtask of subtasks) {
    if (ids.has(subtask.id)) {
      issues.push(`子任务 id 重复: ${subtask.id}`)
    }
    ids.add(subtask.id)
  }

  for (const subtask of subtasks) {
    const kept = []
    for (const dependency of subtask.dependsOn) {
      if (dependency === subtask.id) {
        issues.push(`子任务 ${subtask.id} 依赖自身`)
        continue
      }
      if (!ids.has(dependency)) {
        issues.push(`子任务 ${subtask.id} 依赖不存在的 ${dependency}`)
        continue
      }
      kept.push(dependency)
    }
    subtask.dependsOn = kept
  }

  const cycle = findCycle(subtasks)
  if (cycle !== undefined) issues.push(`依赖成环: ${cycle.join(' -> ')}`)

  const goal = typeof source.goal === 'string' && source.goal.trim()
    ? source.goal.trim()
    : typeof source.objective === 'string'
      ? source.objective.trim()
      : ''
  const risks = asList(source.risks)

  const layers = subtasks.length > 0 ? computeLayers(subtasks) : []
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    plan: {
      goal,
      risks,
      subtasks,
      layers,
      parallelizable: layers.some((layer) => layer.length > 1),
      estimatedTasks: subtasks.length
    }
  }
}

/**
 * Find a dependency cycle with a depth-first search.
 *
 * Recursion is bounded by the plan ceiling (a dozen subtasks), so the simple
 * three-colour DFS is both exact and cheap.
 * @param subtasks - normalized subtasks.
 * @returns the cycle path, or undefined when the graph is acyclic.
 */
export function findCycle(subtasks) {
  const byId = new Map(subtasks.map((subtask) => [subtask.id, subtask]))
  const color = new Map()
  const path = []

  const visit = (id) => {
    const mark = color.get(id)
    if (mark === 'done') return undefined
    if (mark === 'visiting') return [...path.slice(path.indexOf(id)), id]
    color.set(id, 'visiting')
    path.push(id)
    const subtask = byId.get(id)
    for (const dependency of subtask?.dependsOn ?? []) {
      const cycle = visit(dependency)
      if (cycle !== undefined) return cycle
    }
    path.pop()
    color.set(id, 'done')
    return undefined
  }

  for (const subtask of subtasks) {
    const cycle = visit(subtask.id)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

/**
 * Group subtasks into dependency layers. Tasks in one layer never depend on
 * each other, so a layer is exactly what may run in parallel.
 * @param subtasks - normalized subtasks.
 * @returns layers of subtask ids; a cyclic remainder is appended as one layer
 *   so the caller can still report it instead of hanging.
 */
export function computeLayers(subtasks) {
  const byId = new Map(subtasks.map((subtask) => [subtask.id, subtask]))
  const remaining = new Set(byId.keys())
  const completed = new Set()
  const layers = []

  while (remaining.size > 0) {
    const layer = []
    for (const id of remaining) {
      const subtask = byId.get(id)
      if (subtask.dependsOn.every((dependency) => completed.has(dependency))) layer.push(id)
    }
    if (layer.length === 0) {
      layers.push([...remaining])
      break
    }
    for (const id of layer) {
      remaining.delete(id)
      completed.add(id)
    }
    layers.push(layer)
  }
  return layers
}

/**
 * Choose the next schedulable batch, honouring both dependency order and the
 * configured concurrency ceiling.
 * @param subtasks - normalized subtasks.
 * @param completed - ids that already finished successfully.
 * @param active - ids currently running.
 * @param limit - maximum simultaneous children.
 * @returns ids that may start now.
 */
export function nextBatch(subtasks, completed, active, limit) {
  const slots = Math.max(0, limit - active.size)
  if (slots === 0) return []
  const batch = []
  for (const subtask of subtasks) {
    if (batch.length >= slots) break
    // A subtask is schedulable exactly once. Without this check a failed task
    // stays eligible and the scheduler re-dispatches it forever.
    if (subtask.status !== undefined && subtask.status !== 'pending') continue
    if (completed.has(subtask.id) || active.has(subtask.id)) continue
    if (!subtask.dependsOn.every((dependency) => completed.has(dependency))) continue
    batch.push(subtask.id)
  }
  return batch
}

/** Resolve a subtask by id. */
export function findSubtask(subtasks, id) {
  return subtasks.find((subtask) => subtask.id === id)
}
