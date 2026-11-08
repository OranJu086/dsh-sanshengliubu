/**
 * 工具面：模型真正调用的三个入口。
 *
 * `sansheng_run` is the workflow itself; `sansheng_status` reads workflow state
 * and history; `sansheng_config` reads and adjusts runtime overrides. The
 * parameter schemas are written as plain JSON Schema because this bundle has
 * no dependency on the Harness tool-definition helper package.
 * @module sansheng-lib/tools
 */
import { clampInt, clampNumber, isRecord, truncate } from './util.js'
import { buildSummary, buildValue, renderStatusRecord } from './render.js'
import { normalizeConfig } from './config.js'
import { runWorkflow } from './runner.js'

/** Shared text renderer: every tool emits one markdown block. */
const textRender = (pickText) => (args, value) => [{ type: 'text', text: String(pickText(value) ?? '') }]

/** Parameter schema for one optional subtask. */
const SUBTASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '子任务标识，省略时自动生成 t1…' },
    title: { type: 'string', description: '短标题' },
    prompt: { type: 'string', description: '交给执行 Agent 的自包含指令' },
    dependsOn: {
      type: 'array',
      items: { type: 'string' },
      description: '必须先完成的子任务 id 列表'
    },
    acceptance: { type: 'string', description: '可独立检查的验收标准' },
    kind: { type: 'string', enum: ['code', 'doc', 'research', 'data', 'other'] }
  },
  required: ['prompt']
}

/**
 * Build the three tool definitions.
 * @param deps - runtime dependencies.
 */
function defineTools(deps) {
  const { store, logger } = deps

  const runTool = {
    name: 'sansheng_run',
    description:
      '三省六部工作流：对复杂任务做规划(中书省)、计划审核(门下省)、依赖调度(尚书省)、原生 Subagent 并行执行、独立质量审核与返工，最后返回交付汇总。' +
      '适用于需要多步骤、多文件、研究或独立验收的任务。' +
      '简单任务（L0）由本工具判定后要求主 Agent 直接完成，不会创建任何子 Agent；' +
      '中等任务（L1）最多委派少量子任务并用规则检查；复杂任务（L2）才启用完整三省流程。' +
      '调用前请把用户原始要求完整传入 task，交付格式/语言传入 requirements。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: {
          type: 'string',
          description: '用户的原始任务要求（尽量原文，包含目标、约束与已给上下文）'
        },
        requirements: {
          type: 'string',
          description: '交付格式、语言、文件路径、验收偏好等约束；没有则省略'
        },
        level: {
          type: 'string',
          enum: ['auto', 'L0', 'L1', 'L2'],
          description: '任务分级。auto=按复杂度自动判定（默认）；也可强制指定以跳过或扩大流程'
        },
        subtasks: {
          type: 'array',
          items: SUBTASK_SCHEMA,
          description: '你自己已经规划好的子任务。提供后跳过中书省规划，仍会经过门下省审核'
        },
        skip_review: {
          type: 'boolean',
          description: '跳过计划审核与独立质量审核（用户明确要求快速执行时使用；不影响安全与权限规则）'
        },
        max_subagents: {
          type: 'number',
          description: '本次允许的最大并行子 Agent 数量（不超过插件配置上限）'
        },
        max_tokens: {
          type: 'number',
          description: '本次任务的 Token 预算上限'
        },
        time_limit: {
          type: 'number',
          description: '本次任务的时间上限（秒）'
        }
      },
      required: ['task']
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          taskId: { type: 'string' },
          level: { type: 'string' },
          status: { type: 'string' },
          summary: { type: 'string' },
          departments: { type: 'object' },
          elapsedMs: { type: 'number' },
          totals: { type: 'object' },
          reviewVerdict: { type: 'string' },
          reworkRounds: { type: 'number' },
          retries: { type: 'number' },
          warnings: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' }
        },
        required: ['ok', 'taskId', 'level', 'status', 'summary']
      },
      render: textRender((value) => value.summary)
    },
    isConcurrencySafe: () => false,
    presentCall(args) {
      const level = typeof args.level === 'string' ? args.level : 'auto'
      return {
        card: 'generic',
        title: `三省六部 · ${level === 'auto' ? '自动分级' : level} 调度`,
        kind: 'other',
        content: [{ type: 'text', text: truncate(String(args.task ?? ''), 300) }]
      }
    },
    presentResult(_args, value) {
      return {
        card: 'generic',
        title: `三省六部 · ${value.status}`,
        content: [{ type: 'text', text: String(value.summary ?? '') }]
      }
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('sansheng_run 需要调用方 Agent（exec.agent 为空）')
      const task = typeof args?.task === 'string' ? args.task.trim() : ''
      if (task.length === 0) throw new Error('task 不能为空：请传入用户的原始任务要求')

      const effective = deps.effectiveConfig()
      if (!effective.config.enable) {
        throw new Error('三省六部插件当前已关闭（config.enable=false），请在插件配置中开启')
      }
      const runConfig = { ...effective.config }
      if (Number.isFinite(args.max_subagents)) {
        runConfig.maxSubagents = clampInt(
          args.max_subagents,
          1,
          effective.config.maxSubagents,
          effective.config.maxSubagents
        )
      }

      const record = await runWorkflow({
        config: runConfig,
        store,
        logger,
        signal: exec.signal,
        request: {
          task,
          requirements: typeof args.requirements === 'string' ? args.requirements : '',
          level: ['auto', 'L0', 'L1', 'L2'].includes(args.level) ? args.level : 'auto',
          subtasks: Array.isArray(args.subtasks) ? args.subtasks : undefined,
          skipReview: args.skip_review === true,
          parent: agent,
          cwd: undefined,
          maxTokens: Number.isFinite(args.max_tokens) ? clampInt(args.max_tokens, 0, 100_000_000, undefined) : undefined,
          timeLimitSeconds: Number.isFinite(args.time_limit) ? clampNumber(args.time_limit, 0, 86_400, undefined) : undefined
        },
        createBridge: (budget) => deps.createBridge({ budget, config: runConfig })
      })
      return buildValue(record)
    }
  }

  const statusTool = {
    name: 'sansheng_status',
    description:
      '查询三省六部工作流状态：不传 task_id 时列出正在运行与最近完成的工作流；传 task_id 时返回该次工作流的部门进度、子任务、预算与审核结果。用于用户询问「现在进行到哪一步」「刚才那个任务结果如何」或需要审计时。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: '工作流 id（形如 ss-xxx），省略则列出最近记录' },
        limit: { type: 'number', description: '返回的历史条数，默认 5' },
        include_agents: { type: 'boolean', description: '附带吏部记录的各角色成功率与平均用量' }
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          active: { type: 'number' },
          history: { type: 'number' }
        },
        required: ['text']
      },
      render: textRender((value) => value.text)
    },
    isConcurrencySafe: () => true,
    presentCall() {
      return { card: 'generic', title: '三省六部 · 状态查询', kind: 'read' }
    },
    async execute(args) {
      const limit = Number.isFinite(args?.limit) ? clampInt(args.limit, 1, 50, 5) : 5
      const taskId = typeof args?.task_id === 'string' ? args.task_id.trim() : ''
      const lines = []

      if (taskId.length > 0) {
        const active = store.get(taskId)
        if (active !== undefined) {
          lines.push(renderStatusRecord(active))
        } else {
          const found = store.recent(200).find((entry) => entry.taskId === taskId)
          if (found === undefined) {
            return { text: `未找到工作流 ${taskId}。可用 sansheng_status 不带参数查看最近记录。`, active: 0, history: 0 }
          }
          lines.push(renderStatusRecord(found))
        }
      } else {
        const activeRuns = store.listActive()
        lines.push(`## 三省六部状态`)
        lines.push('')
        if (activeRuns.length === 0) {
          lines.push('当前没有正在运行的工作流。')
        } else {
          lines.push(`运行中：${activeRuns.length} 个`)
          for (const record of activeRuns) lines.push(renderStatusRecord(record))
        }
        const recent = store.recent(limit)
        if (recent.length > 0) {
          lines.push('')
          lines.push(`### 最近完成（${recent.length}）`)
          for (const record of recent) lines.push(`- ${renderStatusRecord(record).split('\n')[0]}`)
        } else {
          lines.push('')
          lines.push('暂无历史记录。')
        }
      }

      if (args?.include_agents === true) {
        const stats = store.agentStats()
        lines.push('')
        lines.push('### 吏部 · 角色统计')
        if (stats.length === 0) lines.push('暂无数据。')
        for (const entry of stats) {
          lines.push(
            `- ${entry.role} (${entry.route}) 运行 ${entry.runs} 次，成功率 ${entry.successRate ?? '—'}，平均 ${entry.avgTokens ?? '—'} Token`
          )
        }
      }
      return { text: lines.join('\n'), active: store.listActive().length, history: store.recent(limit).length }
    }
  }

  const configTool = {
    name: 'sansheng_config',
    description:
      '读取或调整三省六部的运行期配置。show 返回生效配置与警告；set 覆盖部分字段（例如 taskBudget、maxSubagents、independentReview、parallelExecution），立即生效并持久化到插件状态目录；reset 清除运行期覆盖，回到插件行配置。预算、并行、审核开关都可以由用户通过它调整。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['show', 'set', 'reset'], description: '操作类型，默认 show' },
        values: {
          type: 'object',
          description: 'set 时要覆盖的配置字段（与插件 config 同名），例如 {"taskBudget":100000,"maxSubagents":2}'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          config: { type: 'object' }
        },
        required: ['text']
      },
      render: textRender((value) => value.text)
    },
    isConcurrencySafe: () => false,
    presentCall() {
      return { card: 'generic', title: '三省六部 · 配置', kind: 'other' }
    },
    async execute(args) {
      const action = ['show', 'set', 'reset'].includes(args?.action) ? args.action : 'show'
      if (action === 'reset') {
        await store.setOverrides({})
        deps.reload()
      }
      if (action === 'set') {
        if (!isRecord(args?.values)) throw new Error('set 需要 values 对象')
        const merged = { ...deps.overrides(), ...args.values }
        const check = normalizeConfig({ ...deps.rowConfig(), ...merged })
        if (check.warnings.some((warning) => warning.startsWith('未知配置项'))) {
          const unknown = check.warnings.filter((warning) => warning.startsWith('未知配置项'))
          throw new Error(`存在未知配置项：${unknown.join('；')}`)
        }
        await store.setOverrides(merged)
        deps.reload()
      }
      const effective = deps.effectiveConfig()
      const text = [
        '## 三省六部 · 生效配置',
        '',
        '```json',
        JSON.stringify(effective.config, null, 2),
        '```',
        '',
        `状态目录：${store.dir}`,
        effective.warnings.length > 0 ? `配置警告：\n- ${effective.warnings.join('\n- ')}` : '配置警告：无'
      ].join('\n')
      return { text, config: effective.config }
    }
  }

  return [runTool, statusTool, configTool]
}

/**
 * Register every tool inside the plugin's own effect.
 * @param deps - runtime dependencies.
 * @returns the disposers.
 */
export function registerTools(deps) {
  const disposers = []
  for (const definition of defineTools(deps)) {
    disposers.push(deps.ctx.effect(() => deps.ctx.tools.register(definition)))
  }
  return disposers
}

/** Re-export the summary builder for the system-prompt guidance text. */
export { buildSummary }
