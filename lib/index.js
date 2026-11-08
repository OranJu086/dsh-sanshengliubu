/**
 * 三省六部制 · DeepSeek Harness Host 插件入口.
 *
 * A dependency-free bundle: the only imports are Node built-ins and this
 * package's own modules. Every registration is created inside a Cordis effect,
 * so unloading the plugin (or disabling it in the composition) removes the
 * tools and the prompt section without touching Harness core.
 * @module dsh-sanshengliubu
 */
import { createAgentBridge } from './agents.js'
import { normalizeConfig, resolveStateDir } from './config.js'
import { createStore } from './state.js'
import { registerTools } from './tools.js'
import { isRecord, truncate } from './util.js'
import { homedir } from 'node:os'
import { buildConfigSchema } from './schema.js'

export const name = 'sansheng-liubu'

/**
 * Projected into the Host settings page as an editable form keyed by the
 * profile entry id. Flipping `enable` there re-applies this plugin.
 */
export const Config = await buildConfigSchema()

/** Hard dependencies: without a tool registry there is nothing to expose. */
export const inject = ['tools', 'subagents']

/** Prompt section name, also the id used for shadow/duplicate diagnostics. */
const SECTION_NAME = 'plugin:sansheng-liubu'

/** Guidance text. Kept short because it is paid for on every request. */
const GUIDANCE = [
  '复杂任务（多步骤、多文件、研究、需要独立验收）先用 `sansheng_run`：它会拆解、审核、依赖调度、并行执行并做独立质量审核。',
  '简单任务直接自己完成，不要为了走流程而调用它；它判定为 L0 时也只返回「请直接执行」。',
  '`sansheng_status` 可查询工作流进度与历史，`sansheng_config` 可读取或调整预算、并行与审核开关。'
].join('\n')

/** Resolve the prompt placement, falling back to a late slot. */
function sectionOrder(systemPrompt) {
  try {
    const order = systemPrompt.getSectionOrder('TOOL_SUBAGENT')
    if (Number.isFinite(order)) return order + 0.5
  } catch {
    // Fall through: the fallback keeps the plugin working on a Harness that
    // renamed its prompt section orders.
  }
  return 900
}

/**
 * Activate the plugin.
 * @param ctx - the owning Cordis context.
 * @param config - the row `config` from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const logger = ctx.logger
  const rowConfig = isRecord(config) ? config : {}
  // Files outside the workspace are only ever written under the plugin's own
  // state directory, and the default lives in the Harness home.
  const dshHome =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : `${homedir()}/.dsh`
  const initial = normalizeConfig(rowConfig, { dshHome })

  // `enable: false` must never be a one-way door: the tools stay registered so
  // the settings form and `sansheng_config` can turn the workflow back on, and
  // only the run entry point refuses. The prompt hint and the approval gate are
  // skipped, so a disabled plugin costs no prompt space and asks nothing.
  const disabled = !initial.config.enable
  if (disabled) {
    logger.info('[sansheng] disabled by config; tools stay registered but `sansheng_run` refuses until re-enabled')
  }
  for (const warning of initial.warnings) logger.warn(`[sansheng] config: ${warning}`)

  const stateDir = resolveStateDir(initial.config, dshHome)
  const store = createStore({
    dir: stateDir,
    audit: initial.config.auditLog,
    historyLimit: initial.config.historyLimit,
    logger
  })
  let overrides = {}

  const effectiveConfig = () => normalizeConfig({ ...rowConfig, ...overrides }, { dshHome })
  const reload = () => {
    overrides = store.getOverrides()
  }

  store
    .init()
    .then(() => {
      reload()
      logger.info(`[sansheng] state ready at ${stateDir}`)
    })
    .catch((error) => {
      logger.warn(`[sansheng] state directory unavailable (${stateDir}): ${String(error)}`)
    })

  // Approval gate: when `requireApproval` is on (the default), a run that may
  // create subagents asks the Host first. The listener runs the rest of the
  // waterfall and only upgrades an already-allowed decision, so it can never
  // override another plugin's deny/cancel.
  if (!disabled) ctx.effect(() =>
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (exec?.name !== 'sansheng_run') return decision
      if (decision.kind !== 'allow') return decision
      if (!effectiveConfig().config.requireApproval) return decision
      if (ctx.get('approval') === undefined) return decision
      const args = exec.arguments
      if (args !== null && typeof args === 'object' && args.level === 'L0') return decision
      const task = args !== null && typeof args === 'object' && typeof args.task === 'string'
        ? truncate(args.task, 120)
        : '（未提供任务描述）'
      // Observable proof that the gate ran: the audit trail records every ask,
      // including the ones an auto-answerer approves without a human click.
      store.record('approval/ask', { tool: 'sansheng_run', task })
      return {
        kind: 'ask',
        reason: '三省六部将创建子 Agent 并消耗 Token，是否继续？',
        displayReason: `任务：${task}`
      }
    })
  )

  // One short discovery hint; tool descriptions alone are easy to overlook.
  if (!disabled) try {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: sectionOrder(ctx.systemPrompt),
        text: (assemblyContext) =>
          assemblyContext?.agent === undefined ? '' : GUIDANCE
      })
    )
  } catch (error) {
    logger.warn(`[sansheng] prompt section unavailable: ${String(error)}`)
  }

  // Tools are registered inside their own effects; Cordis disposes them with
  // this plugin's context, so no extra teardown hook is needed here.
  registerTools({
    ctx,
    store,
    logger,
    effectiveConfig,
    reload,
    rowConfig: () => rowConfig,
    overrides: () => overrides,
    createBridge: ({ budget, config: runConfig }) =>
      createAgentBridge({
        subagents: ctx.subagents,
        sessionQuery: ctx.get('sessionQuery'),
        config: runConfig,
        budget,
        logger
      })
  })

  logger.info(
    `[sansheng] enabled · tools: sansheng_run, sansheng_status, sansheng_config · budget ${initial.config.taskBudget} tokens · max ${initial.config.maxSubagents} subagents · state ${stateDir}`
  )
}
