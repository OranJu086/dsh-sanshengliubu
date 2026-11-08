/**
 * Plugin configuration: defaults, normalization and validation.
 *
 * The row `config` in `cordis.patch.yml` is the only supported source. This
 * module never guesses a model or an agent preset: an omitted route inherits
 * the parent agent, and an unknown key is reported instead of silently kept.
 * @module sansheng-lib/config
 */
import { clampInt, clampNumber, isRecord, stringList } from './util.js'

/** Recognized keys; anything else is reported as a warning. */
export const KNOWN_KEYS = new Set([
  'enable',
  'requireApproval',
  'complexityThreshold',
  'l1Threshold',
  'complexityKeywords',
  'maxSubagents',
  'maxRetries',
  'maxReviewRounds',
  'taskBudget',
  'taskBudgetUsd',
  'modelPrices',
  'timeLimit',
  'parallelExecution',
  'independentReview',
  'reviewLevels',
  'requirePlanReview',
  'auditLog',
  'autoEscalation',
  'plannerAgent',
  'executorAgent',
  'reviewerAgent',
  'subagentProvider',
  'maxDepth',
  'stateDir',
  'historyLimit'
])

/** Default configuration, matching the shipped `cordis.patch.yml` block. */
export const DEFAULT_CONFIG = Object.freeze({
  enable: true,
  requireApproval: true,
  complexityThreshold: 3,
  l1Threshold: 1,
  complexityKeywords: [],
  maxSubagents: 4,
  maxRetries: 1,
  maxReviewRounds: 2,
  taskBudget: 400000,
  taskBudgetUsd: 0,
  modelPrices: {},
  timeLimit: 1800,
  parallelExecution: true,
  independentReview: true,
  reviewLevels: ['L1', 'L2'],
  requirePlanReview: true,
  auditLog: true,
  autoEscalation: false,
  plannerAgent: {},
  executorAgent: {},
  reviewerAgent: {},
  subagentProvider: 'spawn',
  maxDepth: 1,
  stateDir: '',
  historyLimit: 100
})

/**
 * Normalize one role route. Only explicitly configured fields survive, so an
 * empty object means "inherit the parent agent".
 * @param raw - the configured value.
 * @param label - role name for warnings.
 * @param warnings - sink for diagnostics.
 */
function normalizeRoute(raw, label, warnings) {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) {
    warnings.push(`${label} 必须是对象 { provider, model, reasoningEffort, agentPreset }，已忽略`)
    return {}
  }
  const route = {}
  for (const key of ['provider', 'model', 'reasoningEffort', 'agentPreset']) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.trim().length === 0) {
      warnings.push(`${label}.${key} 必须是非空字符串，已忽略`)
      continue
    }
    route[key] = value.trim()
  }
  if ((route.provider === undefined) !== (route.model === undefined)) {
    warnings.push(`${label} 的 provider 与 model 必须同时提供，已全部忽略`)
    return {}
  }
  return route
}

/**
 * Normalize the price table. Prices are USD per one million tokens.
 * @param raw - configured map keyed by `provider/model` or `provider`.
 */
function normalizePrices(raw, warnings) {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) {
    warnings.push('modelPrices 必须是对象，已忽略')
    return {}
  }
  const prices = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      warnings.push(`modelPrices["${key}"] 必须是 { input, output }，已忽略`)
      continue
    }
    const input = Number(value.input ?? value.inputPerMTok ?? NaN)
    const output = Number(value.output ?? value.outputPerMTok ?? NaN)
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
      warnings.push(`modelPrices["${key}"] 需要非负的 input/output 数值，已忽略`)
      continue
    }
    prices[key] = { input, output }
  }
  return prices
}

/**
 * Normalize raw row config into the effective configuration.
 * @param raw - the row `config` value (may be undefined).
 * @param options - environment facts.
 * @param options.dshHome - `$DSH_HOME`, used to resolve the default state dir.
 * @returns effective configuration plus diagnostics.
 */
export function normalizeConfig(raw, options = {}) {
  const warnings = []
  const source = isRecord(raw) ? raw : {}
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    warnings.push('插件 config 必须是对象，已回退到默认配置')
  }

  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`未知配置项 "${key}" 已被忽略`)
  }

  const config = {
    enable: source.enable === undefined ? DEFAULT_CONFIG.enable : source.enable === true,
    requireApproval:
      source.requireApproval === undefined
        ? DEFAULT_CONFIG.requireApproval
        : source.requireApproval === true,
    complexityThreshold: clampNumber(
      source.complexityThreshold,
      1,
      100,
      DEFAULT_CONFIG.complexityThreshold
    ),
    l1Threshold: clampNumber(source.l1Threshold, 0, 100, DEFAULT_CONFIG.l1Threshold),
    complexityKeywords: stringList(source.complexityKeywords),
    maxSubagents: clampInt(source.maxSubagents, 1, 16, DEFAULT_CONFIG.maxSubagents),
    maxRetries: clampInt(source.maxRetries, 0, 5, DEFAULT_CONFIG.maxRetries),
    maxReviewRounds: clampInt(source.maxReviewRounds, 0, 5, DEFAULT_CONFIG.maxReviewRounds),
    taskBudget: clampInt(source.taskBudget, 0, 100_000_000, DEFAULT_CONFIG.taskBudget),
    taskBudgetUsd: clampNumber(source.taskBudgetUsd, 0, 1_000_000, DEFAULT_CONFIG.taskBudgetUsd),
    modelPrices: normalizePrices(source.modelPrices, warnings),
    timeLimit: clampInt(source.timeLimit, 0, 86_400, DEFAULT_CONFIG.timeLimit),
    parallelExecution: source.parallelExecution === undefined
      ? DEFAULT_CONFIG.parallelExecution
      : source.parallelExecution === true,
    independentReview: source.independentReview === undefined
      ? DEFAULT_CONFIG.independentReview
      : source.independentReview === true,
    reviewLevels: source.reviewLevels === undefined
      ? [...DEFAULT_CONFIG.reviewLevels]
      : stringList(source.reviewLevels).filter((level) => ['L0', 'L1', 'L2'].includes(level)),
    requirePlanReview: source.requirePlanReview === undefined
      ? DEFAULT_CONFIG.requirePlanReview
      : source.requirePlanReview === true,
    auditLog: source.auditLog === undefined ? DEFAULT_CONFIG.auditLog : source.auditLog === true,
    autoEscalation: source.autoEscalation === true,
    plannerAgent: normalizeRoute(source.plannerAgent, 'plannerAgent', warnings),
    executorAgent: normalizeRoute(source.executorAgent, 'executorAgent', warnings),
    reviewerAgent: normalizeRoute(source.reviewerAgent, 'reviewerAgent', warnings),
    subagentProvider: typeof source.subagentProvider === 'string' && source.subagentProvider.trim()
      ? source.subagentProvider.trim()
      : DEFAULT_CONFIG.subagentProvider,
    maxDepth: clampInt(source.maxDepth, 0, 3, DEFAULT_CONFIG.maxDepth),
    stateDir: typeof source.stateDir === 'string' ? source.stateDir.trim() : '',
    historyLimit: clampInt(source.historyLimit, 10, 2000, DEFAULT_CONFIG.historyLimit)
  }

  if (config.l1Threshold > config.complexityThreshold) {
    warnings.push(
      `l1Threshold(${config.l1Threshold}) 大于 complexityThreshold(${config.complexityThreshold})，L1 将不可达`
    )
  }
  if (config.timeLimit === 0 && config.taskBudget === 0 && config.taskBudgetUsd === 0) {
    warnings.push('未设置任何预算或时间上限：工作流只能依靠用户中断来停止')
  }

  return { config, warnings }
}

/**
 * Resolve the effective state directory.
 * @param config - normalized configuration.
 * @param dshHome - `$DSH_HOME`, if the Host exposes it.
 */
export function resolveStateDir(config, dshHome) {
  if (config.stateDir.length > 0) return config.stateDir
  const base = typeof dshHome === 'string' && dshHome.length > 0 ? dshHome : '~/.dsh'
  return `${base.replace(/\/+$/, '')}/sansheng-liubu`
}
