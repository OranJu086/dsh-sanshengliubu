/**
 * Pure helpers shared by the 三省六部 modules. No DeepSeek Harness import may
 * appear in this file so the whole module graph stays unit-testable with plain
 * Node (`node --test`).
 * @module sansheng-lib/util
 */

/** Mint a short, sortable, collision-resistant identifier. */
export function newId(prefix) {
  const time = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${time}-${rand}`
}

/** Current time as an ISO string. */
export function nowIso() {
  return new Date().toISOString()
}

/** Clamp a numeric option into a range, falling back when it is not a number. */
export function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Clamp an option into an integer range. */
export function clampInt(value, min, max, fallback) {
  return Math.trunc(clampNumber(value, min, max, fallback))
}

/** Read a nested value without throwing on a missing branch. */
export function pick(source, path) {
  let cursor = source
  for (const key of path.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined
    cursor = cursor[key]
  }
  return cursor
}

/** Collapse whitespace and cut a string to a maximum length. */
export function truncate(text, max = 4000) {
  const flat = typeof text === 'string' ? text : String(text ?? '')
  if (flat.length <= max) return flat
  return `${flat.slice(0, max)}\n…（已截断，原长 ${flat.length} 字符）`
}

/**
 * Extract the first complete JSON object or array from arbitrary model prose:
 * fenced code blocks, prose prefixes, and trailing commentary are tolerated.
 * @param text - raw model text.
 * @returns the parsed value, or undefined when no complete JSON value exists.
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') return undefined
  const candidates = []

  const fenced = [...text.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)]
  for (const match of fenced) candidates.push(match[1])

  candidates.push(text)

  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (trimmed.length === 0) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      // Fall through to brace scanning.
    }
    const scanned = scanBalanced(trimmed)
    if (scanned !== undefined) return scanned
  }
  return undefined
}

/**
 * Scan a string for the first balanced JSON object or array, ignoring braces
 * inside string literals.
 * @param text - text that may embed JSON.
 */
function scanBalanced(text) {
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start]
    if (open !== '{' && open !== '[') continue
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === open) depth += 1
      else if (char === close) {
        depth -= 1
        if (depth === 0) {
          const slice = text.slice(start, index + 1)
          try {
            return JSON.parse(slice)
          } catch {
            break
          }
        }
      }
    }
  }
  return undefined
}

/** Join the text blocks of a subagent result into one string. */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** Render milliseconds as a compact human duration. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms))
  if (total < 1000) return `${total}ms`
  const seconds = total / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m${String(rest).padStart(2, '0')}s`
}

/** Human-readable byte-free token count. */
export function formatTokens(tokens) {
  const value = Math.max(0, Math.round(tokens || 0))
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(1)}k`
}

/** Normalize a free-form list of strings, trimming and dropping empties. */
export function stringList(value) {
  if (!Array.isArray(value)) return []
  const output = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length > 0 && !output.includes(trimmed)) output.push(trimmed)
  }
  return output
}

/** Whether a value is a plain record (not an array, not null). */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Safe access to a possibly-undefined value with a fallback. */
export function or(value, fallback) {
  return value === undefined || value === null ? fallback : value
}
