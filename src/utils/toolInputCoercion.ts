/**
 * Coerce a tool input value into the shape the schema expects.
 *
 * Non-Anthropic models routed through the Vivus proxy frequently emit tool
 * arguments in shapes that Zod rejects on the strict path. The most common
 * failure modes seen in the wild:
 *
 *   1. The whole arg blob arrives as a JSON-encoded string instead of an
 *      object (Qwen, GLM, MiniMax tokenizers sometimes wrap function args in
 *      an extra layer of stringification).
 *   2. Arrays are emitted as objects with numeric string keys
 *      ({"0": {...}, "1": {...}} instead of [{...}, {...}]). This happens
 *      when the model copies a JSON-pretty representation of an array as a
 *      dict.
 *   3. Booleans arrive as the strings "true"/"false".
 *   4. Numbers arrive as numeric strings ("3" instead of 3).
 *
 * This helper does conservative, *lossless* normalisation only — it never
 * adds or drops keys, never invents data, and never throws. If a value
 * already looks valid we leave it alone. Anything we can't safely coerce is
 * passed through unchanged so the downstream Zod validator can produce a
 * useful error.
 */
function looksLikeNumericKeyedArray(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj)
  if (keys.length === 0) return false
  for (const k of keys) {
    if (!/^\d+$/.test(k)) return false
  }
  return true
}

function objectToArray(obj: Record<string, unknown>): unknown[] {
  return Object.keys(obj)
    .map(k => Number.parseInt(k, 10))
    .sort((a, b) => a - b)
    .map(i => obj[String(i)])
}

const MAX_COERCE_DEPTH = 12

function coerceValue(value: unknown, depth: number): unknown {
  if (depth > MAX_COERCE_DEPTH) return value
  if (value == null) return value

  // Step 1: JSON-encoded strings that look like objects/arrays/booleans.
  // Conservative: only try to parse when the trimmed string starts with one
  // of '{[ or is exactly "true"/"false"/"null". Avoids mangling regular text
  // params like file contents.
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (trimmed === 'null') return null
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(trimmed)
        return coerceValue(parsed, depth + 1)
      } catch {
        return value
      }
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map(v => coerceValue(v, depth + 1))
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // Numeric-keyed object → array. Only when ALL keys are integers (so we
    // don't accidentally convert legitimate dicts that happen to share a
    // single numeric key).
    if (looksLikeNumericKeyedArray(obj)) {
      return objectToArray(obj).map(v => coerceValue(v, depth + 1))
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = coerceValue(v, depth + 1)
    }
    return out
  }

  return value
}

export function coerceToolInput(
  input: unknown,
): { [key: string]: boolean | string | number } {
  const coerced = coerceValue(input, 0)
  if (coerced && typeof coerced === 'object' && !Array.isArray(coerced)) {
    return coerced as { [key: string]: boolean | string | number }
  }
  // Fall back to the original object shape so downstream validation can
  // produce its usual error rather than a silent rewrite.
  return (input ?? {}) as { [key: string]: boolean | string | number }
}
