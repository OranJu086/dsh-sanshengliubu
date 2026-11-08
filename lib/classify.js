/**
 * 中书省 · 复杂度判定 (pure rules, zero model calls).
 *
 * The grade decides whether the workflow spends any model call at all:
 * L0 answers with a directive, L1 allows one or two delegations, and only L2
 * runs the full three-department sequence.
 * @module sansheng-lib/classify
 */

/** Strong complexity signals: multi-step engineering or research work. */
const STRONG_SIGNALS = [
  '重构', '迁移', '架构', '端到端', '全流程', '多文件', '测试套件', '基准测试', '技术方案',
  'refactor', 'migrate', 'architecture', 'end-to-end', 'benchmark', 'test suite',
  'multi-file', 'pipeline', 'implement', '实现一个', '设计并实现', '完整实现'
]

/** Medium complexity signals: analysis and delivery work. */
const MEDIUM_SIGNALS = [
  '分析', '研究', '报告', '文档', '集成', '优化', '调试', '部署', '排查', '对比',
  'research', 'analyze', 'analysis', 'report', 'integration', 'optimize', 'debug',
  'deploy', 'investigate', 'compare', 'dashboard', 'visualization', '可视化'
]

/** Signals that usually mean "one agent can just do it". */
const SIMPLE_SIGNALS = ['解释', '什么', '为什么', '翻译', '格式化', '重命名', 'explain', 'what is', 'translate']

/** Count non-overlapping occurrences of one signal (case-insensitive). */
function countSignal(text, signal) {
  const needle = signal.toLowerCase()
  let index = 0
  let count = 0
  for (;;) {
    const found = text.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Grade a task from its own text.
 * @param task - the user task statement.
 * @param options - grading knobs.
 * @param options.complexityThreshold - score at or above which the task is L2.
 * @param options.l1Threshold - score at or above which the task is L1.
 * @param options.complexityKeywords - extra signals treated as strong.
 * @returns the grade, its score and the contributing signals.
 */
export function classifyTask(task, options = {}) {
  const text = typeof task === 'string' ? task : ''
  const lower = text.toLowerCase()
  const threshold = Number.isFinite(options.complexityThreshold) ? options.complexityThreshold : 3
  const l1Threshold = Number.isFinite(options.l1Threshold) ? options.l1Threshold : 1
  const extra = Array.isArray(options.complexityKeywords) ? options.complexityKeywords : []

  const signals = []
  let score = 0

  const chars = text.trim().length
  if (chars >= 400) {
    score += 1
    signals.push(`文本 ${chars} 字符`)
  }
  if (chars >= 1200) {
    score += 1
    signals.push('长任务描述')
  }

  const clauses = text.split(/[。；;！!？?\n]+/).filter((part) => part.trim().length > 0)
  if (clauses.length >= 4) {
    score += 1
    signals.push(`${clauses.length} 个句段`)
  }

  const strong = []
  for (const signal of STRONG_SIGNALS) {
    if (countSignal(lower, signal) > 0) strong.push(signal)
  }
  if (strong.length > 0) {
    score += 2
    signals.push(`复杂信号: ${strong.slice(0, 4).join(', ')}`)
  }

  // A user-declared topic is decisive: naming it in `complexityKeywords` is an
  // explicit statement that such work deserves the full workflow.
  const custom = extra.filter((keyword) => typeof keyword === 'string' && keyword.length > 0 && countSignal(lower, keyword) > 0)
  if (custom.length > 0) {
    score += 3
    signals.push(`自定义复杂主题: ${custom.slice(0, 4).join(', ')}`)
  }

  const medium = MEDIUM_SIGNALS.filter((signal) => countSignal(lower, signal) > 0)
  if (medium.length > 0) {
    score += medium.length >= 2 ? 2 : 1
    signals.push(`中等信号: ${medium.slice(0, 4).join(', ')}`)
  }

  const simple = SIMPLE_SIGNALS.filter((signal) => countSignal(lower, signal) > 0)
  const fileMentions = (text.match(/[\w./-]+\.(?:ts|tsx|js|jsx|json|md|py|c|cpp|rs|go|java|css|html|yml|yaml)\b/gi) || []).length
  if (fileMentions >= 3) {
    score += 1
    signals.push(`涉及 ${fileMentions} 个文件`)
  }
  if (simple.length > 0 && chars < 120) {
    score -= 1
    signals.push(`简单信号: ${simple[0]}`)
  }

  const bounded = Math.max(0, score)
  const level = bounded >= threshold ? 'L2' : bounded >= l1Threshold ? 'L1' : 'L0'
  return { level, score: bounded, signals, chars, clauses: clauses.length, fileMentions }
}

/**
 * Whether a grade is in the configured review set.
 * @param level - the task grade.
 * @param reviewLevels - configured grades requiring independent review.
 */
export function needsReview(level, reviewLevels) {
  return Array.isArray(reviewLevels) && reviewLevels.includes(level)
}
