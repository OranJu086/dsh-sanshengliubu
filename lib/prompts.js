/**
 * 三省六部 · prompt 构造 (pure strings).
 *
 * A `spawn` child is a fresh agent with zero parent context, so every prompt
 * below is self-contained: goal, constraints, inputs, acceptance criteria and
 * the exact output contract. Subtask prompts stay focused — the whole task
 * statement is not copied into every child, only the slice it needs.
 * @module sansheng-lib/prompts
 */
import { truncate } from './util.js'

/** The line that keeps a child from delegating further. */
const NO_DELEGATION =
  '你是被派出的执行 Agent，委派深度已到上限：不要调用 subagent / workflow 派生子 Agent，直接自己完成。'

/** The shared output contract for every worker child. */
const DELIVERY_RULES = [
  '遵守宿主的工作目录、沙箱与权限规则；需要审批的操作若被拒绝，不要重试，改为在结果中说明限制。',
  '不要伪造执行结果：没有运行过的测试、没有读到的文件都不要声称完成。',
  '最终回复只写交付内容与必要说明，不要复述本提示。'
]

/** Render the user's delivery constraints, if any. */
function requirementBlock(requirements) {
  if (typeof requirements !== 'string' || requirements.trim().length === 0) return '（用户未额外指定格式与语言）'
  return requirements.trim()
}

/**
 * 中书省 planner prompt: produce a strict JSON plan.
 * @param input - task facts.
 */
export function plannerPrompt(input) {
  const maxTasks = input.maxTasks ?? 6
  return [
    '你是「中书省」，负责把一个复杂任务拆解为可执行、可验收、带依赖关系的子任务计划。',
    NO_DELEGATION,
    '',
    '## 用户任务',
    input.task,
    '',
    '## 交付要求',
    requirementBlock(input.requirements),
    '',
    '## 拆解原则',
    '1. 每个子任务必须自包含：明确输入、要产出的内容、以及验收标准（验收标准要能被独立检查）。',
    '2. 只有真正互不依赖的子任务才可以并行；有先后关系的必须写入 dependsOn。',
    '3. 子任务数量控制在 2 到 ' + maxTasks + ' 个之间，宁可少而实，不要为凑数拆分同一份工作。',
    '4. 不要安排「再总结一次」「再检查一遍」这类空转任务；汇总由调度方完成。',
    '5. 若任务本身只需一次动作即可完成，就只给 1 个子任务。',
    '',
    '## 输出格式',
    '只输出一个 JSON 对象，不要代码块之外的解释：',
    '{',
    '  "goal": "一句话总体目标",',
    '  "subtasks": [',
    '    {',
    '      "id": "t1",',
    '      "title": "短标题",',
    '      "prompt": "交给执行 Agent 的完整指令（自包含，含输入与要求）",',
    '      "dependsOn": [],',
    '      "acceptance": "可被独立检查的验收标准",',
    '      "kind": "code|doc|research|data|other"',
    '    }',
    '  ],',
    '  "risks": ["主要风险或不确定点"],',
    '  "budgetNote": "对工作量与成本的粗略判断（可选）"',
    '}'
  ].join('\n')
}

/**
 * 门下省 plan review prompt.
 * @param input - task and plan to review.
 */
export function planReviewPrompt(input) {
  return [
    '你是「门下省」，独立审查中书省提交的任务计划。你只做审查，不执行任务。',
    NO_DELEGATION,
    '',
    '## 用户原始任务',
    input.task,
    '',
    '## 交付要求',
    requirementBlock(input.requirements),
    '',
    '## 待审计划',
    JSON.stringify(input.plan, null, 2),
    '',
    '## 审查清单',
    '1. 覆盖度：用户要求是否都有子任务承接？有没有整段要求被漏掉？',
    '2. 拆分合理性：子任务是否自包含、粒度是否恰当、有没有重复或空转？',
    '3. 依赖关系：dependsOn 是否真实、是否漏掉必要先后关系、是否存在本可并行的错误串行？',
    '4. 验收标准：acceptance 是否可以独立检查，而不是「看起来不错」？',
    '5. 风险：是否遗漏明显的技术或合规风险？',
    '6. 预算：子任务总量是否明显超出任务价值？',
    '',
    '## 判定标准',
    '- APPROVED：可直接执行，最多允许无关紧要的措辞问题。',
    '- REVISION_REQUIRED：有具体、可执行的修改点，改完就能通过。',
    '- REJECTED：方向性错误，或涉及无法在宿主权限内完成的动作。',
    '',
    '只输出一个 JSON 对象：',
    '{',
    '  "verdict": "APPROVED|REVISION_REQUIRED|REJECTED",',
    '  "issues": [{"severity": "high|medium|low", "problem": "问题", "fix": "具体修改建议"}],',
    '  "reason": "一句话结论"',
    '}'
  ].join('\n')
}

/**
 * Plan repair prompt: make the planner revise its own plan.
 * @param input - task, plan and review issues.
 */
export function planRevisionPrompt(input) {
  return [
    '你是「中书省」。门下省退回了你的计划，请按审查意见修改后重新输出完整计划。',
    NO_DELEGATION,
    '',
    '## 用户任务',
    input.task,
    '',
    '## 交付要求',
    requirementBlock(input.requirements),
    '',
    '## 你的上一版计划',
    JSON.stringify(input.plan, null, 2),
    '',
    '## 审查意见',
    JSON.stringify(input.issues, null, 2),
    '',
    '只输出修改后的完整 JSON 计划（goal / subtasks / risks），格式与上一版一致，不要解释。'
  ].join('\n')
}

/**
 * 尚书省 worker prompt for one subtask.
 * @param input - the slice of context this child needs.
 */
export function executorPrompt(input) {
  const lines = [
    `你是「尚书省」派出的执行 Agent，负责子任务 ${input.subtask.id}：${input.subtask.title}。`,
    NO_DELEGATION,
    '',
    '## 总体目标（仅作背景，不要越界去做别的子任务）',
    truncate(input.taskGoal, 1200),
    '',
    '## 你的子任务',
    input.subtask.prompt,
    '',
    '## 验收标准',
    input.subtask.acceptance.length > 0 ? input.subtask.acceptance : '（未单独给出，按子任务描述完成）',
    '',
    '## 用户交付要求',
    requirementBlock(input.requirements)
  ]
  if (typeof input.upstream === 'string' && input.upstream.length > 0) {
    lines.push('', '## 上游子任务的产出（可直接使用，不要重复读取相同内容）', truncate(input.upstream, 6000))
  }
  lines.push('', '## 交付规则', ...DELIVERY_RULES.map((rule) => `- ${rule}`))
  lines.push('', '完成后用简洁的结构化文字回复：做了什么、产物在哪、如何验证、还有什么限制。')
  return lines.join('\n')
}

/** Review emphasis per subtask kind. */
export function reviewCriteriaFor(kind) {
  switch (kind) {
    case 'code':
      return '优先检查代码是否可运行、测试是否真实执行、是否覆盖用户要求的功能点、有无未处理的错误路径。'
    case 'doc':
      return '优先检查内容完整性、结构与层次、格式与语言是否符合用户要求、有无空洞结论。'
    case 'research':
      return '优先检查证据与来源、结论是否由证据支撑、有无臆测或过时信息。'
    case 'data':
      return '优先检查计算过程、数据依据、口径一致性、结论与数字是否自洽。'
    default:
      return '优先检查是否对照用户原始要求完成、结论是否有依据、格式是否符合要求。'
  }
}

/**
 * 独立质量审核 prompt.
 * @param input - original task, deliverables and per-item acceptance criteria.
 */
export function qualityReviewPrompt(input) {
  return [
    '你是「独立质量审核」，对照用户最初的任务要求验收交付物。',
    NO_DELEGATION,
    '',
    '## 用户原始任务（审核基准）',
    input.task,
    '',
    '## 用户交付要求',
    requirementBlock(input.requirements),
    '',
    '## 验收标准',
    ...input.criteria.map((criterion) => `- ${criterion}`),
    '',
    '## 待验收交付物',
    ...input.deliverables.map(
      (item) => `### 子任务 ${item.id}：${item.title}\n验收标准：${item.acceptance || '（无）'}\n交付内容：\n${truncate(item.output, 4000)}`
    ),
    '',
    '## 审核要求',
    '- 以用户原始任务为准，不以执行 Agent「声称完成」为准。',
    '- 逐条核对验收标准；不通过的条目必须指出具体缺口与可执行的修复方向，不要只给「需要改进」。',
    '- 无法验证的内容（例如声称运行过测试但没有输出）按未完成处理，并在 issues 中说明。',
    '',
    '只输出一个 JSON 对象：',
    '{',
    '  "verdict": "PASS|FAIL",',
    '  "score": 0,',
    '  "issues": [{"target": "子任务 id 或 global", "severity": "high|medium|low", "problem": "问题", "fix": "修复方向"}],',
    '  "missing": ["用户要求但未交付的内容"],',
    '  "reason": "一句话结论"',
    '}'
  ].join('\n')
}

/**
 * Rework prompt for a fixer child.
 * @param input - task, failed deliverables and review issues.
 */
export function fixPrompt(input) {
  return [
    '你是「尚书省」派出的返工 Agent。上一轮交付未通过独立审核，请只修复审核指出的问题，不要重做已完成的部分。',
    NO_DELEGATION,
    '',
    '## 用户原始任务',
    input.task,
    '',
    '## 用户交付要求',
    requirementBlock(input.requirements),
    '',
    '## 上一轮交付内容',
    ...input.deliverables.map((item) => `### 子任务 ${item.id}：${item.title}\n${truncate(item.output, 4000)}`),
    '',
    '## 审核指出的问题',
    JSON.stringify(input.issues, null, 2),
    '',
    '## 要求',
    '- 逐条修复上述问题；无法修复的必须明确说明原因，不要假装已解决。',
    '- 保持已有正确内容不变，输出修复后的完整交付内容。'
  ].join('\n')
}
