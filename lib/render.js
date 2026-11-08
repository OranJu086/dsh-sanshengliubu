/**
 * 礼部 · 交付呈现.
 *
 * One record becomes two artifacts: a compact JSON value (the tool's declared
 * output contract) and the markdown the calling model reads. Both are derived
 * from the same record, so the report can never claim more than the run did.
 * @module sansheng-lib/render
 */
import { formatDuration, formatTokens, truncate } from './util.js'

const STATUS_ICON = {
  done: '✅',
  delivered: '✅',
  'needs-attention': '⚠️',
  partial: '⚠️',
  failed: '❌',
  rejected: '⛔',
  blocked: '🚫',
  skipped: '⏭',
  running: '🔄',
  pending: '·',
  direct: '↩️'
}

const LEVEL_LABEL = {
  L0: 'L0 简单（主 Agent 直接完成）',
  L1: 'L1 中等（主 Agent 规划，少量委派）',
  L2: 'L2 复杂（三省完整流程）'
}

const DEPARTMENT_LABEL = {
  zhongshu: '中书省·规划',
  menxia: '门下省·审核',
  shangshu: '尚书省·调度',
  liubu: '六部·执行',
  review: '独立质量审核'
}

/** Render one department state as a short badge. */
function departmentLine(departments) {
  return Object.entries(departments ?? {})
    .map(([key, state]) => `${DEPARTMENT_LABEL[key] ?? key}=${state}`)
    .join(' · ')
}

/** Render the totals line. */
function totalsLine(totals) {
  if (totals === undefined) return '未统计'
  const tokens = formatTokens(totals.totalTokens ?? 0)
  const budget = totals.maxTokens > 0 ? `/${formatTokens(totals.maxTokens)}` : ''
  const cost = totals.costUsd > 0 ? `，成本 $${totals.costUsd.toFixed(4)}` : ''
  const unpriced = totals.unpricedTokens > 0 ? `，其中 ${formatTokens(totals.unpricedTokens)} Token 未配置价格` : ''
  return `${tokens}${budget} Token${cost}${unpriced}，子 Agent 调用 ${totals.subagentCalls ?? 0} 次`
}

/**
 * Build the model-facing markdown report.
 * @param record - the finished or live workflow record.
 * @param options - rendering options.
 */
export function buildSummary(record, options = {}) {
  const outputLimit = Number.isFinite(options.outputLimit) ? options.outputLimit : 6000
  const lines = []
  lines.push(`## 三省六部 · ${record.taskId}`)
  lines.push('')
  lines.push(`**目标**：${truncate(record.goal || record.task, 300)}`)
  lines.push(`**分级**：${LEVEL_LABEL[record.level] ?? record.level}${record.levelReason ? `（${record.levelReason}）` : ''}`)
  lines.push(`**状态**：${STATUS_ICON[record.status] ?? ''} ${record.status}`)

  if (record.status === 'direct') {
    lines.push('')
    lines.push('该任务被判定为 L0：不需要拆解，也不启动任何子 Agent。请由主 Agent 直接完成，不要再调用本工具。')
    lines.push('')
    lines.push(`**耗时**：${formatDuration(record.elapsedMs ?? 0)} · **用量**：${totalsLine(record.totals)}`)
    return lines.join('\n')
  }

  lines.push(`**部门**：${departmentLine(record.departments)}`)
  lines.push(`**耗时**：${formatDuration(record.elapsedMs ?? 0)} · **用量**：${totalsLine(record.totals)}`)
  if (record.error !== undefined) lines.push(`**失败原因**：${record.error}`)

  if (record.plan?.subtasks?.length > 0) {
    lines.push('')
    lines.push('### 计划与执行')
    for (const subtask of record.subtasks ?? record.plan.subtasks) {
      const icon = STATUS_ICON[subtask.status] ?? '·'
      const depends = subtask.dependsOn?.length > 0 ? ` ⟵ ${subtask.dependsOn.join(',')}` : ''
      const attempts = subtask.attempts > 1 ? `（尝试 ${subtask.attempts} 次）` : ''
      const tokens = subtask.tokens > 0 ? ` · ${formatTokens(subtask.tokens)} Token` : ''
      lines.push(`- ${icon} **${subtask.id}** ${subtask.title}${depends}${attempts}${tokens}`)
      if (subtask.acceptance) lines.push(`  验收：${truncate(subtask.acceptance, 200)}`)
      if (subtask.error) lines.push(`  问题：${truncate(subtask.error, 300)}`)
    }
  }

  if (record.planReview !== undefined) {
    lines.push('')
    lines.push(`### 门下省审核：${record.planReview.verdict}`)
    if (record.planReview.reason) lines.push(`结论：${record.planReview.reason}`)
    for (const issue of record.planReview.issues ?? []) {
      lines.push(`- [${issue.severity}] ${truncate(issue.problem, 240)}${issue.fix ? ` → ${truncate(issue.fix, 240)}` : ''}`)
    }
  }

  if (record.quality !== undefined) {
    lines.push('')
    lines.push(`### 独立质量审核：${record.quality.verdict}${record.quality.rounds > 1 ? `（第 ${record.quality.rounds} 轮）` : ''}`)
    if (record.quality.reason) lines.push(`结论：${record.quality.reason}`)
    if (record.quality.score !== undefined) lines.push(`评分：${record.quality.score}`)
    for (const missing of record.quality.missing ?? []) lines.push(`- 缺失：${truncate(missing, 240)}`)
    for (const issue of record.quality.issues ?? []) {
      lines.push(`- [${issue.severity}]${issue.target ? ` ${issue.target}` : ''} ${truncate(issue.problem, 240)}${issue.fix ? ` → ${truncate(issue.fix, 240)}` : ''}`)
    }
    if (record.reworkRounds > 0) lines.push(`返工轮次：${record.reworkRounds}`)
  }

  const deliverables = record.deliverablesOverride
    ?? (record.subtasks ?? []).filter((subtask) => subtask.status === 'done' && subtask.output?.length > 0)
  if (deliverables.length > 0) {
    lines.push('')
    lines.push('### 交付内容')
    for (const item of deliverables) {
      lines.push(`#### ${item.id} · ${item.title}`)
      lines.push(truncate(item.output, outputLimit))
      lines.push('')
    }
  }

  if (record.warnings?.length > 0) {
    lines.push('')
    lines.push('### 风险与提示')
    for (const warning of record.warnings.slice(0, 12)) lines.push(`- ${truncate(warning, 300)}`)
  }

  lines.push('')
  lines.push('### 交付说明')
  if (record.status === 'delivered') {
    lines.push('全部子任务完成且通过独立审核。请把「交付内容」整理后直接回复用户，不要复述调度过程。')
  } else if (record.status === 'needs-attention') {
    lines.push('交付未通过独立审核或仅部分完成。请如实向用户说明缺口与已尝试的返工轮次，不要把未验证的内容说成已完成。')
  } else if (record.status === 'partial') {
    lines.push('部分子任务未完成。请向用户说明完成范围、失败原因与剩余工作。')
  } else if (record.status === 'rejected') {
    lines.push('门下省拒绝了该计划。请向用户说明拒绝原因，并在调整目标或范围后重新发起。')
  } else {
    lines.push('工作流未产出可用交付物。请向用户说明失败原因，不要编造结果。')
  }
  return lines.join('\n')
}

/**
 * Build the declared JSON output of `sansheng_run`.
 * @param record - the workflow record.
 */
export function buildValue(record) {
  return {
    ok: record.status === 'delivered' || record.status === 'direct',
    taskId: record.taskId,
    level: record.level,
    status: record.status,
    summary: buildSummary(record),
    departments: record.departments,
    elapsedMs: record.elapsedMs ?? 0,
    totals: record.totals ?? {},
    reviewVerdict: record.reviewVerdict ?? '',
    reworkRounds: record.reworkRounds ?? 0,
    retries: record.retries ?? 0,
    warnings: (record.warnings ?? []).slice(0, 20),
    error: record.error ?? ''
  }
}

/**
 * Build the `sansheng_status` view for one record.
 * @param record - live or historical record.
 */
export function renderStatusRecord(record) {
  const lines = []
  lines.push(`${STATUS_ICON[record.status] ?? '·'} ${record.taskId} · ${record.level} · ${record.status}`)
  lines.push(`目标：${truncate(record.goal || record.task || '', 160)}`)
  if (record.startedAt) lines.push(`开始：${record.startedAt}${record.endedAt ? `，结束：${record.endedAt}` : ''}`)
  if (record.departments) lines.push(`部门：${departmentLine(record.departments)}`)
  if (record.totals) lines.push(`用量：${totalsLine(record.totals)}`)
  if (record.reviewVerdict) lines.push(`审核：${record.reviewVerdict}（返工 ${record.reworkRounds ?? 0} 轮）`)
  for (const subtask of record.subtasks ?? []) {
    lines.push(`  ${STATUS_ICON[subtask.status] ?? '·'} ${subtask.id} ${subtask.title}${subtask.error ? ` — ${truncate(subtask.error, 120)}` : ''}`)
  }
  if (record.error) lines.push(`错误：${record.error}`)
  return lines.join('\n')
}
