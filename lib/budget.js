/**
 * 户部 · 预算与用量 (pure).
 *
 * Token counts come from real `assistant/message` usage events; cost is only
 * computed for routes the user priced in `modelPrices`. An unpriced route is
 * reported as unpriced instead of being assigned a guessed price.
 * @module sansheng-lib/budget
 */

/**
 * Look up a configured price.
 * @param prices - normalized `modelPrices`.
 * @param provider - provider id.
 * @param model - model id.
 * @returns `{ input, output }` USD per million tokens, or undefined.
 */
export function resolvePrice(prices, provider, model) {
  if (!prices || typeof prices !== 'object') return undefined
  const exact = `${provider}/${model}`
  if (prices[exact] !== undefined) return prices[exact]
  if (prices[provider] !== undefined) return prices[provider]
  return undefined
}

/**
 * Create one workflow budget.
 * @param options - ceilings and the price table.
 */
export function createBudget(options = {}) {
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 0
  const maxUsd = Number.isFinite(options.maxUsd) ? options.maxUsd : 0
  const timeLimitMs = Number.isFinite(options.timeLimitMs) ? options.timeLimitMs : 0
  const prices = options.prices ?? {}
  const startedAt = Number.isFinite(options.startedAt) ? options.startedAt : Date.now()
  /** Wall-clock ceiling shared by the workflow timer. */
  const deadline = timeLimitMs > 0 ? startedAt + timeLimitMs : undefined

  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    unpricedTokens: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    byRoute: {}
  }

  const exhausted = () => {
    const reasons = []
    if (maxTokens > 0 && usage.inputTokens + usage.outputTokens >= maxTokens) {
      reasons.push(`Token 预算已用尽 (${usage.inputTokens + usage.outputTokens}/${maxTokens})`)
    }
    if (maxUsd > 0 && usage.costUsd >= maxUsd) {
      reasons.push(`成本预算已用尽 ($${usage.costUsd.toFixed(4)}/$${maxUsd})`)
    }
    if (deadline !== undefined && Date.now() >= deadline) {
      reasons.push(`时间上限已到 (${Math.round(timeLimitMs / 1000)}s)`)
    }
    return reasons
  }

  return {
    /** Absolute deadline, or undefined when no time limit is configured. */
    deadline,
    /** Record one model response's usage. */
    addUsage(entry = {}) {
      const input = Math.max(0, Number(entry.inputTokens) || 0)
      const output = Math.max(0, Number(entry.outputTokens) || 0)
      const provider = typeof entry.provider === 'string' ? entry.provider : ''
      const model = typeof entry.model === 'string' ? entry.model : ''
      usage.inputTokens += input
      usage.outputTokens += output
      const key = provider.length > 0 ? `${provider}/${model}` : model || 'unknown'
      const bucket = usage.byRoute[key] ?? { inputTokens: 0, outputTokens: 0, calls: 0 }
      bucket.inputTokens += input
      bucket.outputTokens += output
      bucket.calls += 1
      usage.byRoute[key] = bucket

      const price = resolvePrice(prices, provider, model)
      if (price === undefined) {
        usage.unpricedTokens += input + output
        usage.unpricedCalls += 1
      } else {
        const cost = (input / 1_000_000) * price.input + (output / 1_000_000) * price.output
        usage.costUsd += cost
        usage.pricedCalls += 1
      }
    },
    /** Total tokens consumed so far. */
    totalTokens() {
      return usage.inputTokens + usage.outputTokens
    },
    /** Remaining token allowance, or undefined when unbounded. */
    remainingTokens() {
      if (maxTokens <= 0) return undefined
      return Math.max(0, maxTokens - (usage.inputTokens + usage.outputTokens))
    },
    /** Non-empty list of exhausted ceilings. */
    exhausted,
    /** Whether any ceiling is reached. */
    isExhausted() {
      return exhausted().length > 0
    },
    /** Whether spending is close enough to warn the caller (80% by default). */
    warnings(ratio = 0.8) {
      const messages = []
      const tokens = usage.inputTokens + usage.outputTokens
      if (maxTokens > 0 && tokens >= maxTokens * ratio && tokens < maxTokens) {
        messages.push(`Token 用量已达预算的 ${Math.round((tokens / maxTokens) * 100)}%`)
      }
      if (maxUsd > 0 && usage.costUsd >= maxUsd * ratio && usage.costUsd < maxUsd) {
        messages.push(`成本已达预算的 ${Math.round((usage.costUsd / maxUsd) * 100)}%`)
      }
      if (usage.unpricedTokens > 0 && maxUsd > 0) {
        messages.push(`有 ${usage.unpricedTokens} Token 未配置价格，成本上限只统计已定价模型`)
      }
      return messages
    },
    /** Immutable-ish snapshot for the report and the audit log. */
    snapshot() {
      return {
        maxTokens,
        maxUsd,
        timeLimitMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
        costUsd: Number(usage.costUsd.toFixed(6)),
        unpricedTokens: usage.unpricedTokens,
        pricedCalls: usage.pricedCalls,
        unpricedCalls: usage.unpricedCalls,
        byRoute: { ...usage.byRoute }
      }
    }
  }
}
