/**
 * Curated friendly labels and short descriptions for models served by the
 * Vivus proxy (Ollama-compatible /api/tags). Keeps the /model picker readable
 * by hiding raw Ollama identifiers like "minimax-m3:cloud" or
 * "qwen3-coder-next:480b-cloud" in favor of a human-friendly name and a
 * one-line description.
 *
 * Lookups are keyed by the model's base name (everything before the first ':'),
 * lower-cased. The trailing ':NNb', ':cloud', ':latest' tag is stripped before
 * lookup; if the tag carries a parameter size, it is appended to the
 * description.
 */

export type ProxyModelLabel = {
  label: string
  description: string
}

const PROXY_MODEL_LABELS: Record<string, ProxyModelLabel> = {
  // === Recommended default ===
  'minimax-m3': {
    label: 'MiniMax M3',
    description: 'Balanced default · strong general reasoning, long context',
  },

  // === Qwen family ===
  'qwen3-coder-next': {
    label: 'Qwen3 Coder Next',
    description: 'Latest coding model · best for code tasks',
  },
  'qwen3-coder': {
    label: 'Qwen3 Coder',
    description: 'Coding-focused MoE',
  },
  'qwen3-vl': {
    label: 'Qwen3 VL',
    description: 'Vision-capable · multimodal input',
  },
  qwen3: {
    label: 'Qwen3',
    description: 'General-purpose Alibaba Qwen',
  },
  'qwen3.6': {
    label: 'Qwen 3.6',
    description: 'Latest Qwen · improved reasoning',
  },

  // === DeepSeek family ===
  'deepseek-v4-flash': {
    label: 'DeepSeek V4 Flash',
    description: 'Fast responses · low latency',
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek V4 Pro',
    description: 'Advanced reasoning · deep analysis',
  },
  'deepseek-v3.1': {
    label: 'DeepSeek V3.1',
    description: 'Strong reasoning · MoE',
  },

  // === GLM ===
  'glm-5.1': {
    label: 'GLM 5.1',
    description: 'General-purpose · long context',
  },

  // === Kimi ===
  'kimi-k2.6': {
    label: 'Kimi K2.6',
    description: 'Deep reasoning · trillion-parameter scale',
  },

  // === GPT-OSS ===
  'gpt-oss': {
    label: 'GPT-OSS',
    description: 'Open-weight GPT-style model',
  },

  // === Google / IBM / NVIDIA ===
  gemma4: {
    label: 'Gemma 4',
    description: 'Google Gemma · compact and capable',
  },
  'granite4.1': {
    label: 'Granite 4.1',
    description: 'IBM Granite · enterprise coder',
  },
  nemotron3: {
    label: 'Nemotron 3',
    description: 'NVIDIA Nemotron · multimodal',
  },
}

function stripTag(name: string): string {
  const i = name.indexOf(':')
  return i === -1 ? name : name.slice(0, i)
}

function titleCaseFromName(stripped: string): string {
  return stripped
    .split(/[-_/]/)
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}

function extractSizeFromTag(name: string): string | null {
  const i = name.indexOf(':')
  if (i === -1) return null
  const tag = name.slice(i + 1)
  // Matches '14b', '32b', '120b', '480b-cloud', '671b-cloud', '7B', '1.5B', etc.
  const m = tag.match(/^(\d+(?:\.\d+)?)b\b/i)
  return m ? `${m[1]}B` : null
}

/**
 * Return a friendly label/description for an Ollama-style model name.
 * Uses the curated map when possible; otherwise derives a presentable label
 * from the bare model name and falls back to the supplied family/size.
 */
export function lookupProxyModelLabel(
  name: string,
  fallback?: { family?: string | null; parameterSize?: string | null },
): ProxyModelLabel {
  const base = stripTag(name).toLowerCase()
  const sizeFromTag = extractSizeFromTag(name)
  const entry = PROXY_MODEL_LABELS[base]
  if (entry) {
    return {
      label: entry.label + (sizeFromTag ? ` (${sizeFromTag})` : ''),
      description: entry.description,
    }
  }
  const label = titleCaseFromName(stripTag(name))
  const size = sizeFromTag ?? fallback?.parameterSize?.replace(/\s+/g, '') ?? null
  const descParts: string[] = []
  if (fallback?.family) descParts.push(fallback.family)
  if (size) descParts.push(size)
  return {
    label: label + (sizeFromTag ? ` (${sizeFromTag})` : ''),
    description: descParts.length > 0 ? descParts.join(' · ') : 'Custom model',
  }
}

/**
 * Heuristic: a model name looks like a proxy/Ollama identifier when it
 * contains a colon-tagged suffix (e.g. ":cloud", ":latest", ":14b") OR is
 * registered in the curated label map. Used by renderModelName so the
 * "Default (recommended)" line and other UI surfaces show friendly names
 * instead of raw Ollama identifiers.
 */
export function isProxyModelName(name: string): boolean {
  if (!name) return false
  if (name.includes(':')) return true
  return PROXY_MODEL_LABELS[name.toLowerCase()] !== undefined
}
