/**
 * 尚书省 · 原生 Subagent 调度桥 (吏部 capacity routing lives here too).
 *
 * Every child is a real `ctx.subagents` activation with `delivery: 'caller'`,
 * which is the documented way for a workflow to await a child result without a
 * parent completion notice. No shell command, tool call, or permission is
 * re-implemented here: a child inherits the parent's sandbox, approval policy
 * and permission roots from the Harness.
 * @module sansheng-lib/agents
 */
import { readChildUsage } from './usage.js'
import { blocksToText } from './util.js'

/** Turn a thrown activation failure into a stable, readable reason. */
function describeFailure(error) {
  if (error === undefined || error === null) return '未知错误'
  const code = typeof error.code === 'string' ? error.code : undefined
  const message = typeof error.message === 'string' ? error.message : String(error)
  return code === undefined ? message : `${code}: ${message}`
}

/**
 * Create the subagent bridge.
 * @param options - live runtime facts.
 * @param options.subagents - `ctx.subagents`.
 * @param options.sessionQuery - `ctx.sessionQuery`, used for real usage reads.
 * @param options.config - normalized configuration.
 * @param options.budget - workflow budget.
 * @param options.logger - plugin logger.
 */
export function createAgentBridge(options) {
  const { subagents, sessionQuery, config, budget, logger } = options

  /**
   * Run one child to completion and return its text result.
   * @param request - role, prompt and caller facts.
   */
  async function run(request) {
    const role = request.role
    const route = config[`${role}Agent`] ?? {}
    const provider = config.subagentProvider
    const label = request.label ?? role
    const startedAt = Date.now()

    const providerInstance = subagents.getProvider(provider)
    if (providerInstance === undefined) {
      return {
        ok: false,
        role,
        childId: undefined,
        text: '',
        error: `子 Agent 后端 "${provider}" 未注册（可用: ${subagents.list().join(', ') || '无'}）`,
        reason: 'PROVIDER_UNAVAILABLE',
        tokens: 0,
        ms: 0,
        toolCalls: 0,
        measured: false
      }
    }

    const agentOptions = route.provider !== undefined && route.model !== undefined
      ? {
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort })
        }
      : undefined

    const activationRequest = {
      prompt: [{ type: 'text', text: request.prompt }],
      parent: request.parent,
      maxDepth: config.maxDepth,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(route.agentPreset === undefined ? {} : { agentPreset: route.agentPreset })
    }

    let activation
    try {
      activation = await subagents.startActivation({
        provider,
        label,
        request: activationRequest,
        signal: request.signal,
        delivery: 'caller'
      })
    } catch (error) {
      const reason = describeFailure(error)
      logger?.warn?.(`[sansheng] ${role} activation rejected: ${reason}`)
      return {
        ok: false,
        role,
        childId: undefined,
        text: '',
        error: `无法启动子 Agent：${reason}`,
        reason: 'ACTIVATION_REJECTED',
        tokens: 0,
        ms: Date.now() - startedAt,
        toolCalls: 0,
        measured: false
      }
    }

    if (request.onSpawn !== undefined) {
      try {
        request.onSpawn(activation.childId)
      } catch {
        // Progress reporting must never break the run.
      }
    }

    let result
    try {
      result = await activation.result
    } catch (error) {
      const reason = describeFailure(error)
      return {
        ok: false,
        role,
        childId: activation.childId,
        text: '',
        error: `子 Agent 执行失败：${reason}`,
        reason: 'EXECUTION_FAILED',
        tokens: 0,
        ms: Date.now() - startedAt,
        toolCalls: 0,
        measured: false
      }
    }

    // Read the child's own log before releasing residency; the durable record
    // survives either way, but the live copy avoids a persistence round trip.
    const usage = await readChildUsage(sessionQuery, activation.childId)
    const tokens = usage.inputTokens + usage.outputTokens
    if (tokens > 0) {
      budget.addUsage({
        provider: route.provider ?? 'inherit',
        model: route.model ?? 'inherit',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens
      })
    }

    try {
      await activation.dispose()
    } catch {
      // Settled activations tolerate a repeated dispose; a failure here cannot
      // change the delivered result.
    }

    const text = blocksToText(result?.output)
    const stopReason = result?.stopReason
    const ok = stopReason === 'completed' || (stopReason === undefined && text.length > 0)
    if (!ok) {
      logger?.warn?.(`[sansheng] ${role} stopped: ${String(stopReason)}`)
    }
    return {
      ok,
      role,
      childId: activation.childId,
      text,
      structured: result?.structured,
      diagnostic: result?.diagnostic,
      stopReason,
      error: ok ? undefined : `子 Agent 未正常完成（stopReason=${String(stopReason)}）`,
      reason: ok ? undefined : 'INCOMPLETE',
      tokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ms: Date.now() - startedAt,
      toolCalls: usage.calls,
      measured: usage.measured
    }
  }

  return { run }
}
