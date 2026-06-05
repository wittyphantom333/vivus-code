import { createHash } from 'crypto'

/**
 * Tracks repeated identical tool calls and provides escalating feedback
 * to nudge the model away from loops. Weak models ignore system prompt
 * instructions like "don't retry blindly" — this enforces it at the
 * tool execution layer.
 *
 * Escalation levels:
 *  1st repeat: warning appended to tool result
 *  2nd repeat: strong warning, suggests alternatives
 *  3rd+ repeat: execution blocked, forced to change approach
 */

const WARN_THRESHOLD = 2 // 2nd identical call gets a warning
const BLOCK_THRESHOLD = 4 // 4th identical call is blocked

type TrackedCall = {
  hash: string
  count: number
}

// Per-session ring buffer of recent tool call signatures.
// Keyed by hash → count. Reset when a *different* tool call succeeds.
let recentCalls: Map<string, number> = new Map()
let lastHash: string | null = null

function hashToolCall(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const payload = toolName + '\0' + JSON.stringify(input)
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

export type RepetitionVerdict =
  | { action: 'allow' }
  | { action: 'warn'; message: string; count: number }
  | { action: 'block'; message: string; count: number }

export function checkRepetition(
  toolName: string,
  input: Record<string, unknown>,
): RepetitionVerdict {
  const hash = hashToolCall(toolName, input)

  // Different call from last — reset the consecutive counter for the old one
  if (lastHash !== null && hash !== lastHash) {
    recentCalls.delete(lastHash)
  }
  lastHash = hash

  const count = (recentCalls.get(hash) ?? 0) + 1
  recentCalls.set(hash, count)

  if (count >= BLOCK_THRESHOLD) {
    return {
      action: 'block',
      count,
      message:
        `[BLOCKED: You have attempted this exact "${toolName}" call ${count} times with the same result. ` +
        `Execution refused. You MUST try a completely different approach, use a different tool, ` +
        `or ask the user for help with ask_user/AskHuman.]`,
    }
  }

  if (count >= WARN_THRESHOLD) {
    return {
      action: 'warn',
      count,
      message:
        `[WARNING: This is attempt #${count} of the exact same "${toolName}" call. ` +
        `The previous ${count - 1} attempt(s) produced the same error. ` +
        `Do NOT retry — try a different approach or ask the user for guidance.]`,
    }
  }

  return { action: 'allow' }
}

/**
 * Call after a successful (non-error) tool result to clear tracking.
 * A successful result means the model is making progress, not looping.
 */
export function clearRepetitionOnSuccess(
  toolName: string,
  input: Record<string, unknown>,
): void {
  const hash = hashToolCall(toolName, input)
  recentCalls.delete(hash)
  if (lastHash === hash) {
    lastHash = null
  }
}

/** Reset all tracking (e.g., on new user message / new turn from user). */
export function resetRepetitionTracker(): void {
  recentCalls.clear()
  lastHash = null
}
