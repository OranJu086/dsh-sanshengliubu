/**
 * 配置 Schema：让宿主把插件配置投影成可编辑表单。
 *
 * The Harness `settings` service projects a plugin's `Config` schema into a
 * form keyed by the profile entry id, and writes edits back into the profile
 * patch. That is the native "turn it on with one click" surface: no bespoke
 * client panel is needed, and the value survives a restart because it lands in
 * `cordis.patch.yml`.
 *
 * The module is loaded through a guarded dynamic import so a profile that
 * cannot resolve `@deepseek-ai/schemastery` still starts the plugin: the
 * runtime configuration validator in `config.js` remains authoritative.
 * @module sansheng-lib/schema
 */

/** Version of the form contract; bump when a field changes meaning. */
export const CONFIG_VERSION = 1

/** Human text shown in the generated settings form. */
const DESCRIPTION = {
  enable: '总开关。关闭后不注册任何工具，也不会创建子 Agent。',
  requireApproval: '调用前审批。开启后每次创建子 Agent 之前都会弹出宿主审批，不会静默消耗 Token。',
  complexityThreshold: '复杂度评分达到该值判为 L2（完整三省流程）。',
  l1Threshold: '复杂度评分达到该值判为 L1（少量委派 + 规则检查）。',
  complexityKeywords: '额外「复杂主题」关键词，命中即直接判为复杂任务。',
  maxSubagents: '同时运行的最大子 Agent 数。',
  maxRetries: '单个子任务失败后的重试次数。',
  maxReviewRounds: '质量审核不通过后的返工轮数上限。',
  taskBudget: '单次工作流的 Token 预算。',
  taskBudgetUsd: '单次工作流的成本预算（美元，0 = 不限制，仅对已定价模型生效）。',
  timeLimit: '单次工作流的时间上限（秒，0 = 不限制）。',
  parallelExecution: '允许无依赖的子任务并行执行。',
  independentReview: '启用独立质量审核（对照用户原始要求验收）。',
  requirePlanReview: 'L2 任务由门下省做模型级计划审核。',
  auditLog: '记录工作流审计日志到插件状态目录。',
  autoEscalation: '预留：允许按难度升级到更强模型（当前未实现）。',
  subagentProvider: '使用的 ctx.subagents 后端名称（默认 spawn）。',
  maxDepth: '子 Agent 的委派深度上限；1 表示子 Agent 只能自己干活。',
  stateDir: '状态目录，留空使用 $DSH_HOME/sansheng-liubu。',
  historyLimit: '保留的历史工作流条数。',
  reviewLevels: '需要独立质量审核的任务等级。',
  plannerAgent: '中书省规划子 Agent 的路由；留空继承父 Agent。',
  executorAgent: '执行子 Agent 的路由；留空继承父 Agent。',
  reviewerAgent: '审核子 Agent 的路由；留空继承父 Agent。'
}

/**
 * Build the Config schema.
 * @returns the schemastery schema, or undefined when the library is missing.
 */
export async function buildConfigSchema() {
  let z
  try {
    z = (await import('@deepseek-ai/schemastery')).default
  } catch {
    return undefined
  }
  if (typeof z?.object !== 'function') return undefined

  const flag = (name, value) => z.boolean().default(value).description(DESCRIPTION[name])
  // Every field is optional: an empty object means "inherit the parent agent".
  const routeShape = (schema) => ({
    provider: schema.string().description('LLM provider id'),
    model: schema.string().description('模型 id'),
    reasoningEffort: schema.string().description('推理强度（可选）'),
    agentPreset: schema.string().description('Agent preset id（可选）')
  })

  return z.object({
    enable: flag('enable', true),
    requireApproval: flag('requireApproval', true),
    complexityThreshold: z
      .number()
      .min(1)
      .max(100)
      .default(3)
      .description(DESCRIPTION.complexityThreshold),
    l1Threshold: z.number().min(0).max(100).default(1).description(DESCRIPTION.l1Threshold),
    complexityKeywords: z
      .array(z.string())
      .default([])
      .description(DESCRIPTION.complexityKeywords),
    maxSubagents: z.number().min(1).max(16).default(4).description(DESCRIPTION.maxSubagents),
    maxRetries: z.number().min(0).max(5).default(1).description(DESCRIPTION.maxRetries),
    maxReviewRounds: z.number().min(0).max(5).default(2).description(DESCRIPTION.maxReviewRounds),
    taskBudget: z.number().min(0).default(400000).description(DESCRIPTION.taskBudget),
    taskBudgetUsd: z.number().min(0).default(0).description(DESCRIPTION.taskBudgetUsd),
    timeLimit: z.number().min(0).max(86400).default(1800).description(DESCRIPTION.timeLimit),
    parallelExecution: flag('parallelExecution', true),
    independentReview: flag('independentReview', true),
    requirePlanReview: flag('requirePlanReview', true),
    auditLog: flag('auditLog', true),
    autoEscalation: flag('autoEscalation', false),
    subagentProvider: z.string().default('spawn').description(DESCRIPTION.subagentProvider),
    maxDepth: z.number().min(0).max(3).default(1).description(DESCRIPTION.maxDepth),
    stateDir: z.string().default('').description(DESCRIPTION.stateDir),
    historyLimit: z.number().min(10).max(2000).default(100).description(DESCRIPTION.historyLimit),
    reviewLevels: z
      .array(z.union(['L0', 'L1', 'L2']))
      .default(['L1', 'L2'])
      .description(DESCRIPTION.reviewLevels),
    plannerAgent: z.object(routeShape(z)).description(DESCRIPTION.plannerAgent),
    executorAgent: z.object(routeShape(z)).description(DESCRIPTION.executorAgent),
    reviewerAgent: z.object(routeShape(z)).description(DESCRIPTION.reviewerAgent)
  })
}
