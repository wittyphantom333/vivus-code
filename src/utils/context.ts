// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isEnvTruthy } from './envUtils'
import { getModelCapability } from './model/modelCapabilities'

// Model context window size — matches NUM_CTX sent to Ollama by the proxy.
// Override at runtime with VIVUS_CODE_MAX_CONTEXT_TOKENS env var.
export const MODEL_CONTEXT_WINDOW_DEFAULT = 262_144

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// vivus.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.VIVUS_CODE_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// @[MODEL LAUNCH]: Update this pattern if the new model supports 1M context
export function modelSupports1M(_model: string): boolean {
  return false
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // Allow override via environment variable.
  // This takes precedence over all other context window resolution.
  if (process.env.VIVUS_CODE_MAX_CONTEXT_TOKENS) {
    const override = parseInt(process.env.VIVUS_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // Check model capabilities registry (populated from proxy /api/show)
  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 4_096) {
    return cap.max_input_tokens
  }

  // Default — matches NUM_CTX configured in the Ollama proxy
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

export function getSonnet1mExpTreatmentEnabled(_model: string): boolean {
  return false
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 * For Ollama/local models, output is only bounded by context window.
 * Known model families get tuned defaults; unknown models get generous limits.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  const m = (model || '').toLowerCase()

  // Qwen models — generous output, context is the real limit
  if (m.includes('qwen')) {
    return { default: 32_000, upperLimit: 64_000 }
  }

  // DeepSeek models
  if (m.includes('deepseek')) {
    return { default: 32_000, upperLimit: 64_000 }
  }

  // Llama models
  if (m.includes('llama')) {
    return { default: 16_000, upperLimit: 32_000 }
  }

  // Mistral/Mixtral models
  if (m.includes('mistral') || m.includes('mixtral')) {
    return { default: 16_000, upperLimit: 32_000 }
  }

  // Gemma models
  if (m.includes('gemma')) {
    return { default: 8_192, upperLimit: 16_000 }
  }

  // Phi models
  if (m.includes('phi')) {
    return { default: 16_000, upperLimit: 32_000 }
  }

  // Claude models (if still routed through for any reason)
  if (m.includes('opus') || m.includes('sonnet') || m.includes('claude')) {
    return { default: 32_000, upperLimit: 64_000 }
  }

  // Check model capabilities registry as fallback
  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    return {
      default: Math.min(cap.max_tokens, MAX_OUTPUT_TOKENS_DEFAULT),
      upperLimit: cap.max_tokens,
    }
  }

  // Unknown model — use reasonable defaults
  return { default: MAX_OUTPUT_TOKENS_DEFAULT, upperLimit: MAX_OUTPUT_TOKENS_UPPER_LIMIT }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
