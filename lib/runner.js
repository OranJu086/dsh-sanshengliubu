/**
 * 尚书省 · 工作流编排.
 *
 * Sequence: 中书省 (plan) → 门下省 (review) → 尚书省 (schedule) → 六部 (capability
 * slices applied per subtask) → 独立质量审核 → 返工 → 交付.
 *
 * The runner is deliberately conservative about model calls:
 * - L0 never starts a child;
 * - L1 reviews with rules, and delegates only one or two tasks;
 * - L2 pays for a planner and a plan reviewer, because it is the only grade
 *   where the plan itself is expensive to get wrong.
 * @module sansheng-lib/runner
 */
import { createBudget } from './budget.js'
import { classifyTask, needsReview } from './classify.js'
import { computeLayers, nextBatch, normalizePlan } from './plan.js'
import {
  executorPrompt,
  fixPrompt,
  planReviewPrompt,
  planRevisionPrompt,
  plannerPrompt,
  qualityReviewPrompt,
  reviewCriteriaFor
} from './prompts.js'
import { newId, nowIso, parseJsonLoose, truncate } from './util.js'

/** Largest plan the workflow will accept, independent of concurrency. */
const MAX_PLAN_TASKS = 12

/** Plan-revision ceiling; a plan that cannot pass in two edits is rejected. */
const MAX_PLAN_REVISIONS = 2

/** Create a fresh workflow record. */
function createRecord(request) {
  return {
    taskId: newId('ss'),
    goal: '',
    task: request.task,
    taskChars: typeof request.task === 'string' ? request.task.length : 0,
    requirements: request.requirements ?? '',
    level: request.level,
    levelReason: '',
    complexity: undefined,
    status: 'running',
    startedAt: nowIso(),
    endedAt: undefined,
    elapsedMs: 0,
    departments: {
      zhongshu: 'pending',
      menxia: 'pending',
      shangshu: 'pending',
      liubu: 'pending',
      review: 'pending'
    },
    plan: undefined,
    planReview: undefined,
    quality: undefined,
    reviewVerdict: undefined,
    reworkRounds: 0,
    retries: 0,
    subtasks: [],
    totals: undefined,
    warnings: [],
    error: undefined,
    finalText: ''
  }
}

/** Classify a reviewer/planner verdict from loose model output. */
function readVerdict(raw, allowed, fallback) {
  const candidate = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  return allowed.includes(candidate) ? candidate : fallback
}

/** Normalize review issues into a compact, serializable list. */
function normalizeIssues(raw) {
  if (!Array.isArray(raw)) return []
  const issues = []
  for (const item of raw.slice(0, 20)) {
    if (typeof item === 'string') {
      issues.push({ severity: 'medium', problem: item, fix: '' })
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    issues.push({
      target: typeof item.target === 'string' ? item.target : undefined,
      severity: ['high', 'medium', 'low'].includes(item.severity) ? item.severity : 'medium',
      problem: typeof item.problem === 'string' ? item.problem : String(item.issue ?? ''),
      fix: typeof item.fix === 'string' ? item.fix : String(item.suggestion ?? '')
    })
  }
  return issues.filter((issue) => issue.problem.length > 0)
}

/**
 * Run one workflow.
 * @param options - the composed runtime and the request.
 */
export async function runWorkflow(options) {
  const { config, store, logger, request, signal } = options
  const parent = request.parent
  const record = createRecord({
    task: request.task,
    requirements: request.requirements,
    level: request.level
  })
  store.begin(record)

  const budget = createBudget({
    maxTokens: request.maxTokens ?? config.taskBudget,
    maxUsd: request.maxUsd ?? config.taskBudgetUsd,
    timeLimitMs: (request.timeLimitSeconds ?? config.timeLimit) * 1000,
    prices: config.modelPrices
  })
  const bridge = options.createBridge(budget)
  record.budget = budget.snapshot()

  const progress = (stage, detail = {}) => {
    store.record('progress', { taskId: record.taskId, stage, ...detail })
  }
  const setDepartment = (name, state) => {
    record.departments[name] = state
    progress('department', { department: name, state })
  }

  // Counts real activations, independent of how many subtasks a plan has.
  let subagentCalls = 0
  const runAgent = (request) => {
    subagentCalls += 1
    return bridge.run(request)
  }

  try {
    // ---- 中书省: grade -------------------------------------------------
    const forced = ['L0', 'L1', 'L2'].includes(request.level) ? request.level : 'auto'
    let level = forced
    if (forced === 'auto') {
      const complexity = classifyTask(request.task, {
        complexityThreshold: config.complexityThreshold,
        l1Threshold: config.l1Threshold,
        complexityKeywords: config.complexityKeywords
      })
      level = complexity.level
      record.complexity = complexity
      record.levelReason = complexity.signals.join('；') || '无显著复杂度信号'
    } else {
      record.levelReason = `调用方指定 ${forced}`
    }
    record.level = level

    if (level === 'L0') {
      record.status = 'direct'
      record.goal = truncate(request.task, 200)
      record.finalText = ''
      setDepartment('zhongshu', 'done')
      setDepartment('menxia', 'skipped')
      setDepartment('shangshu', 'skipped')
      setDepartment('liubu', 'skipped')
      setDepartment('review', 'skipped')
      record.endedAt = nowIso()
      record.elapsedMs = Date.now() - new Date(record.startedAt).getTime()
      record.totals = { ...budget.snapshot(), subagentCalls }
      await store.finish(record)
      return record
    }

    setDepartment('zhongshu', 'running')

    // ---- 中书省: plan --------------------------------------------------
    let plan = undefined
    if (Array.isArray(request.subtasks) && request.subtasks.length > 0) {
      const normalized = normalizePlan({ goal: request.task, subtasks: request.subtasks }, { maxTasks: MAX_PLAN_TASKS })
      if (!normalized.ok) {
        record.warnings.push(...normalized.issues)
        record.warnings.push('调用方提供的子任务无效，改为由中书省规划')
      } else {
        plan = normalized.plan
        record.warnings.push(...normalized.warnings)
        progress('plan/caller-provided', { tasks: plan.subtasks.length })
      }
    }

    if (plan === undefined && level === 'L1') {
      // L1: the calling agent already decided the work is small; one focused
      // delegation is enough and no planner model call is spent.
      const normalized = normalizePlan(
        {
          goal: request.task,
          subtasks: [
            {
              id: 't1',
              title: '执行任务',
              prompt: request.task,
              dependsOn: [],
              acceptance: request.requirements.length > 0 ? request.requirements : '完整完成用户要求的内容',
              kind: 'other'
            }
          ]
        },
        { maxTasks: 1 }
      )
      plan = normalized.plan
      progress('plan/direct-delegation', { tasks: 1 })
    }

    if (plan === undefined) {
      const planner = await runAgent({
        role: 'planner',
        parent,
        signal,
        label: '中书省·规划',
        prompt: plannerPrompt({
          task: request.task,
          requirements: request.requirements,
          maxTasks: Math.min(MAX_PLAN_TASKS, Math.max(2, config.maxSubagents + 2))
        })
      })
      store.recordAgentOutcome('planner', {
        ok: planner.ok,
        tokens: planner.tokens,
        ms: planner.ms,
        route: config.plannerAgent?.model
      })
      if (!planner.ok && planner.text.length === 0) {
        record.status = 'failed'
        record.error = `中书省规划失败：${planner.error ?? '无输出'}`
        setDepartment('zhongshu', 'failed')
        await store.finish(record)
        return record
      }
      const parsed = parseJsonLoose(planner.text)
      const normalized = normalizePlan(parsed, { maxTasks: MAX_PLAN_TASKS })
      if (!normalized.ok) {
        record.warnings.push(...normalized.issues)
        record.status = 'failed'
        record.error = `中书省输出无法解析为有效计划：${normalized.issues.join('；')}`
        setDepartment('zhongshu', 'failed')
        record.planText = truncate(planner.text, 2000)
        await store.finish(record)
        return record
      }
      plan = normalized.plan
      record.warnings.push(...normalized.warnings)
    }

    record.plan = plan
    record.goal = plan.goal.length > 0 ? plan.goal : truncate(request.task, 200)
    setDepartment('zhongshu', 'done')
    progress('plan/ready', { tasks: plan.subtasks.length, layers: plan.layers })

    // ---- 门下省: plan review -------------------------------------------
    const modelPlanReview =
      config.requirePlanReview && level === 'L2' && plan.subtasks.length > 1 && !request.skipReview
    if (level === 'L2' && config.requirePlanReview && !modelPlanReview) {
      record.warnings.push('计划仅含一个子任务，门下省采用规则审核，未调用模型')
    }

    if (modelPlanReview) {
      setDepartment('menxia', 'running')
      let revisions = 0
      let approved = false
      let rejected = false
      for (;;) {
        const reviewer = await runAgent({
          role: 'reviewer',
          parent,
          signal,
          label: '门下省·计划审核',
          prompt: planReviewPrompt({ task: request.task, requirements: request.requirements, plan })
        })
        store.recordAgentOutcome('reviewer', {
          ok: reviewer.ok,
          tokens: reviewer.tokens,
          ms: reviewer.ms,
          route: config.reviewerAgent?.model
        })
        const parsed = parseJsonLoose(reviewer.text)
        const verdict = readVerdict(parsed?.verdict, ['APPROVED', 'REVISION_REQUIRED', 'REJECTED'], 'REVISION_REQUIRED')
        const issues = normalizeIssues(parsed?.issues)
        record.planReview = {
          verdict,
          issues,
          reason: typeof parsed?.reason === 'string' ? parsed.reason : '',
          rounds: revisions + 1
        }
        progress('plan/review', { verdict, issues: issues.length })
        if (verdict === 'APPROVED') {
          approved = true
          break
        }
        if (verdict === 'REJECTED') {
          rejected = true
          break
        }
        if (revisions >= MAX_PLAN_REVISIONS - 1) break
        revisions += 1
        const revised = await runAgent({
          role: 'planner',
          parent,
          signal,
          label: '中书省·计划修订',
          prompt: planRevisionPrompt({ task: request.task, requirements: request.requirements, plan, issues })
        })
        store.recordAgentOutcome('planner', {
          ok: revised.ok,
          tokens: revised.tokens,
          ms: revised.ms,
          route: config.plannerAgent?.model
        })
        const next = normalizePlan(parseJsonLoose(revised.text), { maxTasks: MAX_PLAN_TASKS })
        if (!next.ok) break
        plan = next.plan
        record.plan = plan
      }
      if (rejected) {
        record.status = 'rejected'
        record.error = `门下省拒绝执行：${record.planReview?.reason ?? '未说明原因'}`
        setDepartment('menxia', 'rejected')
        await store.finish(record)
        return record
      }
      if (!approved) {
        record.warnings.push('计划审核未通过且修订轮数用尽，按现有计划继续执行并记录风险')
      }
      setDepartment('menxia', approved ? 'approved' : 'approved-with-risk')
    } else {
      setDepartment('menxia', 'rule-approved')
      record.planReview = { verdict: 'APPROVED', issues: [], reason: '规则审核（未调用模型）', rounds: 0 }
    }

    // ---- 尚书省: schedule ----------------------------------------------
    setDepartment('shangshu', 'running')
    setDepartment('liubu', 'running')
    const subtasks = plan.subtasks.map((subtask) => ({
      ...subtask,
      status: 'pending',
      attempts: 0,
      childId: undefined,
      output: '',
      error: undefined,
      tokens: 0,
      toolCalls: 0,
      ms: 0
    }))
    record.subtasks = subtasks

    const byId = new Map(subtasks.map((subtask) => [subtask.id, subtask]))
    const completed = new Set()
    const failed = new Set()
    const concurrency = config.parallelExecution ? Math.max(1, config.maxSubagents) : 1

    /** Build the upstream context for one subtask (dependency outputs only). */
    const upstreamFor = (subtask) => {
      const parts = []
      for (const dependency of subtask.dependsOn) {
        const source = byId.get(dependency)
        if (source === undefined || source.output.length === 0) continue
        parts.push(`【${source.id} ${source.title}】\n${truncate(source.output, 3000)}`)
      }
      return parts.join('\n\n')
    }

    const runSubtask = async (subtask) => {
      while (subtask.attempts <= config.maxRetries) {
        if (signal.aborted) {
          subtask.status = 'skipped'
          subtask.error = '工作流被取消'
          return
        }
        const exhaustion = budget.exhausted()
        if (exhaustion.length > 0) {
          subtask.status = 'skipped'
          subtask.error = `预算/时间受限：${exhaustion.join('；')}`
          record.warnings.push(subtask.error)
          return
        }
        subtask.attempts += 1
        subtask.status = 'running'
        progress('subtask/start', { id: subtask.id, attempt: subtask.attempts })
        const prompt = subtask.attempts === 1
          ? executorPrompt({
              taskGoal: record.goal,
              subtask,
              requirements: request.requirements,
              upstream: upstreamFor(subtask)
            })
          : [
              `上一次尝试失败或被判定不合格：${subtask.error ?? '未知原因'}`,
              '请修正后重新完成该子任务。',
              '',
              executorPrompt({
                taskGoal: record.goal,
                subtask,
                requirements: request.requirements,
                upstream: upstreamFor(subtask)
              })
            ].join('\n')

        const result = await runAgent({
          role: 'executor',
          parent,
          signal,
          label: `尚书省·${subtask.title}`,
          prompt,
          onSpawn: (childId) => {
            subtask.childId = childId
            progress('subtask/spawned', { id: subtask.id, childId })
          }
        })
        subtask.tokens += result.tokens
        subtask.toolCalls += result.toolCalls
        subtask.ms += result.ms
        store.recordAgentOutcome('executor', {
          ok: result.ok,
          tokens: result.tokens,
          ms: result.ms,
          route: config.executorAgent?.model
        })

        if (result.ok && result.text.trim().length > 0) {
          subtask.output = result.text
          subtask.status = 'done'
          subtask.error = undefined
          completed.add(subtask.id)
          progress('subtask/done', { id: subtask.id, tokens: subtask.tokens })
          return
        }
        subtask.error = result.error ?? '子任务没有产出可用内容'
        record.retries += 1
        progress('subtask/failed', { id: subtask.id, attempt: subtask.attempts, error: subtask.error })
        if (subtask.attempts > config.maxRetries) break
      }
      subtask.status = 'failed'
      failed.add(subtask.id)
      record.warnings.push(`子任务 ${subtask.id} 失败：${subtask.error}`)
    }

    const running = new Map()
    // Defence in depth: the dependency scheduler must terminate even if a
    // future status transition is wrong. Each subtask may legitimately run at
    // most 1 + maxRetries times, so anything beyond that is a defect.
    const scheduleCap = subtasks.length * (config.maxRetries + 1) + 4
    let scheduled = 0
    for (;;) {
      if (signal.aborted) break
      if (scheduled >= scheduleCap) {
        record.warnings.push(`调度达到安全上限 ${scheduleCap} 次，已停止派发剩余子任务`)
        break
      }
      const exhaustion = budget.exhausted()
      if (exhaustion.length > 0) {
        record.warnings.push(`停止新增任务：${exhaustion.join('；')}`)
        break
      }
      const batch = nextBatch(subtasks, completed, new Set(running.keys()), concurrency)
      if (batch.length === 0) {
        if (running.size === 0) break
        await Promise.race([...running.values()])
        continue
      }
      for (const id of batch) {
        scheduled += 1
        const subtask = byId.get(id)
        const task = runSubtask(subtask)
          .catch((error) => {
            subtask.status = 'failed'
            subtask.error = error instanceof Error ? error.message : String(error)
            failed.add(id)
          })
          .finally(() => running.delete(id))
        running.set(id, task)
      }
      await Promise.race([...running.values()])
    }
    if (running.size > 0) await Promise.allSettled([...running.values()])

    // Anything still pending either lost a dependency or ran out of budget.
    for (const subtask of subtasks) {
      if (subtask.status === 'pending') {
        const blockedBy = subtask.dependsOn.filter((dependency) => failed.has(dependency) || byId.get(dependency)?.status !== 'done')
        subtask.status = blockedBy.length > 0 ? 'blocked' : 'skipped'
        if (blockedBy.length > 0) subtask.error = `依赖未完成：${blockedBy.join(', ')}`
      }
    }

    const done = subtasks.filter((subtask) => subtask.status === 'done')
    setDepartment('shangshu', done.length === subtasks.length ? 'done' : 'partial')
    setDepartment('liubu', 'done')
    progress('execution/done', { done: done.length, total: subtasks.length })

    // ---- 独立质量审核 ---------------------------------------------------
    let quality
    const reviewExpected = config.independentReview && !request.skipReview && needsReview(level, config.reviewLevels) && done.length > 0
    if (reviewExpected) {
      setDepartment('review', 'running')
      const criteria = [
        '任务完整性：用户明确要求的内容是否全部交付',
        '事实准确性与逻辑正确性',
        '输出格式与用户要求一致（含语言）',
        '工程可运行性（涉及代码时：是否可运行、测试是否真实执行）',
        '文件与交付物完整性',
        ...done.map((subtask) => `子任务 ${subtask.id}（${subtask.title}）：${subtask.acceptance || '按描述完成'}`),
        ...done.map((subtask) => reviewCriteriaFor(subtask.kind))
      ]

      let round = 0
      let deliverables = done.map((subtask) => ({
        id: subtask.id,
        title: subtask.title,
        acceptance: subtask.acceptance,
        output: subtask.output
      }))

      for (;;) {
        const reviewer = await runAgent({
          role: 'reviewer',
          parent,
          signal,
          label: '独立质量审核',
          prompt: qualityReviewPrompt({
            task: request.task,
            requirements: request.requirements,
            criteria,
            deliverables
          })
        })
        store.recordAgentOutcome('reviewer', {
          ok: reviewer.ok,
          tokens: reviewer.tokens,
          ms: reviewer.ms,
          route: config.reviewerAgent?.model
        })
        const parsed = parseJsonLoose(reviewer.text)
        const verdict = readVerdict(parsed?.verdict, ['PASS', 'FAIL'], 'FAIL')
        quality = {
          verdict,
          score: Number.isFinite(parsed?.score) ? parsed.score : undefined,
          issues: normalizeIssues(parsed?.issues),
          missing: Array.isArray(parsed?.missing) ? parsed.missing.slice(0, 20).map(String) : [],
          reason: typeof parsed?.reason === 'string' ? parsed.reason : '',
          rounds: round + 1
        }
        record.quality = quality
        record.reviewVerdict = verdict
        progress('review', { verdict, issues: quality.issues.length, round: round + 1 })
        if (verdict === 'PASS') break
        if (round >= config.maxReviewRounds) break
        if (budget.exhausted().length > 0) break
        round += 1
        record.reworkRounds = round
        const fixer = await runAgent({
          role: 'executor',
          parent,
          signal,
          label: `返工·第${round}轮`,
          prompt: fixPrompt({
            task: request.task,
            requirements: request.requirements,
            deliverables,
            issues: quality.issues.length > 0
              ? quality.issues
              : [{ severity: 'high', problem: quality.reason || '未通过验收', fix: '按用户要求补齐缺失内容' }]
          })
        })
        store.recordAgentOutcome('executor', {
          ok: fixer.ok,
          tokens: fixer.tokens,
          ms: fixer.ms,
          route: config.executorAgent?.model
        })
        if (!fixer.ok || fixer.text.trim().length === 0) {
          record.warnings.push(`第 ${round} 轮返工未产出内容：${fixer.error ?? '空输出'}`)
          break
        }
        deliverables = [{
          id: 'rework',
          title: `返工结果（第 ${round} 轮）`,
          acceptance: '修复审核指出的全部问题',
          output: fixer.text
        }]
        record.deliverablesOverride = deliverables
      }
      setDepartment('review', quality.verdict === 'PASS' ? 'passed' : 'failed-review')
    } else {
      setDepartment('review', 'skipped')
    }

    // ---- 汇总 ----------------------------------------------------------
    const reviewFailed = quality !== undefined && quality.verdict === 'FAIL'
    record.status = reviewFailed
      ? 'needs-attention'
      : done.length === subtasks.length
        ? 'delivered'
        : done.length > 0
          ? 'partial'
          : 'failed'
    if (record.status === 'failed' && record.error === undefined) {
      record.error = '所有子任务均未完成'
    }
    record.endedAt = nowIso()
    record.elapsedMs = Date.now() - new Date(record.startedAt).getTime()
    record.totals = {
      ...budget.snapshot(),
      subagentCalls,
      toolCalls: subtasks.reduce((sum, subtask) => sum + subtask.toolCalls, 0)
    }
    record.budgetWarnings = budget.warnings()
    record.warnings.push(...record.budgetWarnings)
    await store.finish(record)
    return record
  } catch (error) {
    record.status = 'failed'
    record.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    record.endedAt = nowIso()
    record.elapsedMs = Date.now() - new Date(record.startedAt).getTime()
    record.totals = { ...budget.snapshot(), subagentCalls }
    store.record('workflow/error', { taskId: record.taskId, error: record.error })
    logger?.warn?.(`[sansheng] workflow ${record.taskId} failed: ${record.error}`)
    try {
      await store.finish(record)
    } catch {
      // The original failure is the interesting one.
    }
    return record
  }
}
