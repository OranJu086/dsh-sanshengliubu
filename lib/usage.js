/**
 * 户部 · 真实用量采集.
 *
 * Counting is read back from the child Session's own log through
 * `ctx.sessionQuery.readSession()` — the same `assistant/message` usage events
 * the Harness records for the conversation UI. Nothing is estimated: a child
 * whose log cannot be read reports `measured: false` and contributes zero.
 * @module sansheng-lib/usage
 */

/**
 * Sum usage and tool calls from a session event log.
 * @param events - raw session events (`assistant/message`, `tool/call`).
 * @returns totals plus the number of model responses counted.
 */
export function sumSessionUsage(events) {
  const totals = { inputTokens: 0, outputTokens: 0, calls: 0, responses: 0 }
  if (!Array.isArray(events)) return totals
  for (const event of events) {
    if (event?.type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage === undefined || usage === null) continue
      totals.inputTokens += Number(usage.inputTokens) || 0
      totals.outputTokens += Number(usage.outputTokens) || 0
      totals.responses += 1
    } else if (event?.type === 'tool/call') {
      totals.calls += 1
    }
  }
  return totals
}

/**
 * Read one child Session's usage from its durable log.
 * @param sessionQuery - `ctx.sessionQuery`, when the profile composes it.
 * @param childId - the child Session id.
 * @returns measured totals, or zeros with `measured: false`.
 */
export async function readChildUsage(sessionQuery, childId) {
  if (sessionQuery === undefined || sessionQuery === null || typeof childId !== 'string') {
    return { inputTokens: 0, outputTokens: 0, calls: 0, responses: 0, measured: false }
  }
  try {
    const snapshot = await sessionQuery.readSession(childId)
    return { ...sumSessionUsage(snapshot?.events), measured: true }
  } catch {
    return { inputTokens: 0, outputTokens: 0, calls: 0, responses: 0, measured: false }
  }
}
