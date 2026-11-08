/**
 * Unit tests for the pure modules. Run with `node --test test/*.test.js`.
 *
 * These cover the parts a live session cannot cheaply exercise: task grading,
 * plan validation and dependency ordering, budget accounting, loose JSON
 * extraction, usage folding and report rendering.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createBudget, resolvePrice } from '../lib/budget.js'
import { classifyTask, needsReview } from '../lib/classify.js'
import { DEFAULT_CONFIG, normalizeConfig, resolveStateDir } from '../lib/config.js'
import { computeLayers, findCycle, nextBatch, normalizePlan } from '../lib/plan.js'
import { buildSummary, buildValue } from '../lib/render.js'
import { readChildUsage, sumSessionUsage } from '../lib/usage.js'
import { blocksToText, clampInt, formatDuration, parseJsonLoose, truncate } from '../lib/util.js'

describe('classify (中书省 分级)', () => {
  it('grades a short single ask as L0', () => {
    const result = classifyTask('把这段文字翻译成英文', {})
    assert.equal(result.level, 'L0')
  })

  it('grades a single analysis request as L1', () => {
    const result = classifyTask('分析这个日志文件里报错的原因', {})
    assert.equal(result.level, 'L1')
  })

  it('grades multi-step engineering work as L2', () => {
    const task =
      '重构整个数据导入模块：需要设计新的架构、迁移现有调用方、补充测试套件，并输出技术方案文档。' +
      '同时分析性能瓶颈，对比三种实现方式，最后给出报告。'
    const result = classifyTask(task, { complexityThreshold: 3, l1Threshold: 1 })
    assert.equal(result.level, 'L2')
    assert.ok(result.signals.length > 0)
  })

  it('honours configured extra keywords', () => {
    const result = classifyTask('帮我做一个知识图谱', { complexityKeywords: ['知识图谱'] })
    assert.equal(result.level, 'L2')
  })

  it('reports review membership from the configured levels', () => {
    assert.equal(needsReview('L2', ['L1', 'L2']), true)
    assert.equal(needsReview('L0', ['L1', 'L2']), false)
  })
})

describe('plan (中书省 计划与依赖)', () => {
  const valid = {
    goal: '交付一个 CLI',
    subtasks: [
      { id: 'a', title: '设计', prompt: '设计 CLI 接口', dependsOn: [] },
      { id: 'b', title: '实现', prompt: '实现 CLI', dependsOn: ['a'] },
      { id: 'c', title: '测试', prompt: '写测试', dependsOn: ['b'], acceptance: '测试通过' }
    ]
  }

  it('accepts a valid DAG and derives layers', () => {
    const { ok, plan } = normalizePlan(valid)
    assert.equal(ok, true)
    assert.deepEqual(plan.layers, [['a'], ['b'], ['c']])
    assert.equal(plan.parallelizable, false)
  })

  it('detects parallel branches', () => {
    const { plan } = normalizePlan({
      subtasks: [
        { id: 'a', prompt: 'A' },
        { id: 'b', prompt: 'B' },
        { id: 'c', prompt: 'C', dependsOn: ['a', 'b'] }
      ]
    })
    assert.deepEqual(plan.layers, [['a', 'b'], ['c']])
    assert.equal(plan.parallelizable, true)
  })

  it('rejects an unknown dependency', () => {
    const { ok, issues } = normalizePlan({ subtasks: [{ id: 'a', prompt: 'A', dependsOn: ['ghost'] }] })
    assert.equal(ok, false)
    assert.ok(issues.some((issue) => issue.includes('ghost')))
  })

  it('rejects a dependency cycle', () => {
    const { ok, issues } = normalizePlan({
      subtasks: [
        { id: 'a', prompt: 'A', dependsOn: ['b'] },
        { id: 'b', prompt: 'B', dependsOn: ['a'] }
      ]
    })
    assert.equal(ok, false)
    assert.ok(issues.some((issue) => issue.includes('成环')))
  })

  it('finds a cycle path', () => {
    const cycle = findCycle([
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] }
    ])
    assert.deepEqual(cycle, ['a', 'b', 'a'])
    assert.equal(findCycle([{ id: 'a', dependsOn: [] }]), undefined)
  })

  it('drops a subtask without a prompt but keeps the rest', () => {
    const { ok, plan } = normalizePlan({
      subtasks: [{ id: 'a', title: '无内容' }, { id: 'b', prompt: 'B' }]
    })
    assert.equal(ok, false)
    assert.equal(plan.subtasks.length, 1)
  })

  it('truncates beyond the task ceiling', () => {
    const subtasks = Array.from({ length: 20 }, (_, index) => ({ id: `t${index}`, prompt: `p${index}` }))
    const { plan, warnings } = normalizePlan({ subtasks }, { maxTasks: 5 })
    assert.equal(plan.subtasks.length, 5)
    assert.ok(warnings.some((warning) => warning.includes('截断')))
  })

  it('only schedules tasks whose dependencies completed', () => {
    const { plan } = normalizePlan(valid)
    const batch = nextBatch(plan.subtasks, new Set(), new Set(), 2)
    assert.deepEqual(batch, ['a'])
    const later = nextBatch(plan.subtasks, new Set(['a']), new Set(), 2)
    assert.deepEqual(later, ['b'])
    const full = nextBatch(plan.subtasks, new Set(['a']), new Set(['b']), 2)
    assert.deepEqual(full, [])
  })

  it('never re-dispatches a subtask that already left pending', () => {
    // Regression: a failed subtask that stays eligible makes the scheduler
    // re-dispatch it forever (this crashed the Host with an OOM abort).
    const subtasks = [
      { id: 'a', dependsOn: [], status: 'failed' },
      { id: 'b', dependsOn: [], status: 'done' },
      { id: 'c', dependsOn: [], status: 'running' },
      { id: 'd', dependsOn: [], status: 'blocked' },
      { id: 'e', dependsOn: [], status: 'pending' }
    ]
    assert.deepEqual(nextBatch(subtasks, new Set(['b']), new Set(), 4), ['e'])
  })

  it('groups an unresolvable graph instead of hanging', () => {
    const layers = computeLayers([
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] }
    ])
    assert.equal(layers.length, 1)
    assert.deepEqual(layers[0].sort(), ['a', 'b'])
  })
})

describe('budget (户部)', () => {
  it('accounts tokens and enforces the ceiling only when priced routes are known', () => {
    const budget = createBudget({
      maxTokens: 100,
      maxUsd: 1,
      timeLimitMs: 60_000,
      prices: { 'p/m': { input: 1, output: 2 } }
    })
    budget.addUsage({ provider: 'p', model: 'm', inputTokens: 40, outputTokens: 10 })
    assert.equal(budget.totalTokens(), 50)
    assert.equal(budget.remainingTokens(), 50)
    assert.equal(budget.isExhausted(), false)
    budget.addUsage({ provider: 'p', model: 'm', inputTokens: 40, outputTokens: 10 })
    assert.equal(budget.isExhausted(), true)
    assert.ok(budget.exhausted().some((reason) => reason.includes('Token')))
  })

  it('keeps unpriced usage out of the cost figure', () => {
    const budget = createBudget({ maxTokens: 0, maxUsd: 5, prices: {} })
    budget.addUsage({ provider: 'x', model: 'y', inputTokens: 1000, outputTokens: 1000 })
    assert.equal(budget.snapshot().costUsd, 0)
    assert.equal(budget.snapshot().unpricedTokens, 2000)
    assert.ok(budget.warnings().some((warning) => warning.includes('未配置价格')))
  })

  it('resolves exact routes before provider-wide prices', () => {
    const prices = { p: { input: 1, output: 1 }, 'p/m': { input: 9, output: 9 } }
    assert.deepEqual(resolvePrice(prices, 'p', 'm'), { input: 9, output: 9 })
    assert.deepEqual(resolvePrice(prices, 'p', 'other'), { input: 1, output: 1 })
    assert.equal(resolvePrice(prices, 'z', 'm'), undefined)
  })

  it('reports an elapsed time ceiling', () => {
    const budget = createBudget({ timeLimitMs: 1, startedAt: Date.now() - 10 })
    assert.ok(budget.exhausted().some((reason) => reason.includes('时间')))
  })
})

describe('config', () => {
  it('falls back to defaults and clamps numbers', () => {
    const { config } = normalizeConfig({ maxSubagents: 999, maxRetries: -3, taskBudget: 'x' })
    assert.equal(config.maxSubagents, 16)
    assert.equal(config.maxRetries, 0)
    assert.equal(config.taskBudget, DEFAULT_CONFIG.taskBudget)
  })

  it('warns on unknown keys instead of keeping them', () => {
    const { config, warnings } = normalizeConfig({ maxSubagent: 2 })
    assert.ok(warnings.some((warning) => warning.includes('maxSubagent')))
    assert.equal(config.maxSubagents, DEFAULT_CONFIG.maxSubagents)
  })

  it('requires provider and model together', () => {
    const { config, warnings } = normalizeConfig({ reviewerAgent: { provider: 'p' } })
    assert.deepEqual(config.reviewerAgent, {})
    assert.ok(warnings.some((warning) => warning.includes('同时提供')))
  })

  it('resolves the state directory from DSH_HOME', () => {
    assert.equal(resolveStateDir({ stateDir: '/tmp/x' }, '/home/u/.dsh'), '/tmp/x')
    assert.equal(resolveStateDir({ stateDir: '' }, '/home/u/.dsh'), '/home/u/.dsh/sansheng-liubu')
  })

  it('keeps enable false when explicitly disabled', () => {
    assert.equal(normalizeConfig({ enable: false }).config.enable, false)
  })
})

describe('util', () => {
  it('extracts JSON from fences and prose', () => {
    assert.deepEqual(parseJsonLoose('这里是计划：\n```json\n{"a":1}\n```\n完成'), { a: 1 })
    assert.deepEqual(parseJsonLoose('前言 {"a":{"b":[1,2]}} 后记'), { a: { b: [1, 2] } })
    assert.equal(parseJsonLoose('没有 JSON'), undefined)
    assert.deepEqual(parseJsonLoose('{"text":"含 } 花括号"}'), { text: '含 } 花括号' })
  })

  it('joins text blocks and ignores non-text blocks', () => {
    assert.equal(blocksToText([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'x' }, { type: 'text', text: 'b' }]), 'a\nb')
    assert.equal(blocksToText(undefined), '')
  })

  it('clamps integers and formats durations', () => {
    assert.equal(clampInt('7', 1, 5, 3), 5)
    assert.equal(clampInt(undefined, 1, 5, 3), 3)
    assert.equal(formatDuration(500), '500ms')
    assert.equal(formatDuration(1500), '1.5s')
    assert.equal(formatDuration(65_000), '1m05s')
  })

  it('truncates with a visible marker', () => {
    assert.ok(truncate('abcdef', 3).startsWith('abc'))
    assert.ok(truncate('abcdef', 3).includes('截断'))
  })
})

describe('usage (户部 真实用量)', () => {
  it('sums committed usage and tool calls from a child log', () => {
    const totals = sumSessionUsage([
      { type: 'turn/start', data: {} },
      { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5 } } },
      { type: 'tool/call', data: {} },
      { type: 'assistant/message', data: { usage: { inputTokens: 20, outputTokens: 7 } } },
      { type: 'assistant/message', data: {} }
    ])
    assert.deepEqual(totals, { inputTokens: 30, outputTokens: 12, calls: 1, responses: 2 })
  })

  it('degrades to zero instead of inventing values', () => {
    assert.deepEqual(sumSessionUsage(undefined), { inputTokens: 0, outputTokens: 0, calls: 0, responses: 0 })
  })
})

describe('render (礼部 交付)', () => {
  const record = {
    taskId: 'ss-1',
    level: 'L2',
    status: 'delivered',
    goal: '交付 CLI',
    task: '交付 CLI',
    levelReason: '复杂信号',
    departments: { zhongshu: 'done', menxia: 'approved', shangshu: 'done', liubu: 'done', review: 'passed' },
    subtasks: [
      { id: 'a', title: '设计', status: 'done', acceptance: '接口清单', output: '设计结果', attempts: 1, tokens: 12, dependsOn: [] }
    ],
    planReview: { verdict: 'APPROVED', issues: [], reason: '覆盖完整' },
    quality: { verdict: 'PASS', issues: [], missing: [], reason: '符合要求', rounds: 1 },
    reviewVerdict: 'PASS',
    reworkRounds: 0,
    retries: 0,
    elapsedMs: 1500,
    totals: { totalTokens: 12, maxTokens: 100, costUsd: 0, unpricedTokens: 12, subagentCalls: 2 },
    warnings: []
  }

  it('reports departments, review and deliverables', () => {
    const summary = buildSummary(record)
    assert.ok(summary.includes('门下省审核：APPROVED'))
    assert.ok(summary.includes('独立质量审核：PASS'))
    assert.ok(summary.includes('设计结果'))
    assert.ok(summary.includes('ss-1'))
  })

  it('builds a compact declared output', () => {
    const value = buildValue(record)
    assert.equal(value.ok, true)
    assert.equal(value.status, 'delivered')
    assert.equal(value.reviewVerdict, 'PASS')
    assert.ok(value.summary.length > 100)
  })

  it('explains an L0 decision without deliverables', () => {
    const summary = buildSummary({
      taskId: 'ss-2',
      level: 'L0',
      status: 'direct',
      goal: '翻译',
      task: '翻译',
      elapsedMs: 5,
      totals: { totalTokens: 0, maxTokens: 0, costUsd: 0, unpricedTokens: 0, subagentCalls: 0 }
    })
    assert.ok(summary.includes('L0'))
    assert.ok(summary.includes('不要'))
  })

  it('never claims success for a rejected plan', () => {
    const value = buildValue({
      ...record,
      status: 'rejected',
      error: '范围不可行',
      reviewVerdict: undefined
    })
    assert.equal(value.ok, false)
    assert.ok(value.summary.includes('门下省拒绝'))
  })
})
