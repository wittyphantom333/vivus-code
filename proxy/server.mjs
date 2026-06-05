#!/usr/bin/env node
// Anthropic Messages API → Ollama native API translation proxy.
// Bridges Vivus (which speaks Anthropic format) to Ollama's /api/chat endpoint.
// Uses the native endpoint because /v1/chat/completions silently ignores num_ctx,
// capping context to ~4096 tokens and breaking multi-round conversations.

import http from 'node:http'
import crypto from 'node:crypto'
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OLLAMA_BASE   = (process.env.OLLAMA_URL || 'https://llm.vivus.ai').replace(/\/v1\/chat\/completions$/, '')
const OLLAMA_URL    = `${OLLAMA_BASE}/api/chat`
const PORT          = parseInt(process.env.PROXY_PORT || '4089', 10)
const NUM_CTX       = parseInt(process.env.NUM_CTX || '131072', 10)
const DEBUG         = process.env.PROXY_DEBUG === '1'
const PORTAL_URL    = process.env.PORTAL_URL    || 'http://127.0.0.1:5050'

// Default model — used when the CLI sends an unrecognized Anthropic model name.
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-coder-next:latest'
const MODEL_MAP = { fast: OLLAMA_MODEL, default: OLLAMA_MODEL, strong: OLLAMA_MODEL }

// Cache of known Ollama models — populated on startup, refreshed periodically.
let knownOllamaModels = new Set()
// Cache model capabilities (vision, tools, etc.) from /api/show
const modelCapabilities = new Map()  // model name → Set of capabilities
// Cache per-model context length (from /api/show model_info.<arch>.context_length).
// Falls back to NUM_CTX when unknown.
const modelContextLength = new Map()  // model name → integer tokens
async function refreshModelList() {
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) })
    const tags = await resp.json()
    knownOllamaModels = new Set((tags.models || []).map(m => m.name))
    // Also add short names (without :latest)
    for (const m of tags.models || []) {
      if (m.name.endsWith(':latest')) knownOllamaModels.add(m.name.replace(':latest', ''))
    }
    // Fetch capabilities for all models and await them — must be ready
    // before the first request so vision detection works.
    await Promise.allSettled(
      (tags.models || []).map(m => fetchModelCapabilities(m.name))
    )
    const visionModels = [...modelCapabilities.entries()]
      .filter(([, caps]) => caps.has('vision')).map(([name]) => name)
    log(`known models: ${[...knownOllamaModels].join(', ')}`)
    if (visionModels.length) log(`vision-capable: ${visionModels.join(', ')}`)
    const ctxEntries = [...modelContextLength.entries()]
      .filter(([name]) => !name.endsWith(':latest'))
      .map(([name, n]) => `${name}=${n}`)
    if (ctxEntries.length) log(`context lengths: ${ctxEntries.join(', ')}`)
  } catch {}
}
async function fetchModelCapabilities(model) {
  if (modelCapabilities.has(model)) return modelCapabilities.get(model)
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    })
    const info = await resp.json()
    const caps = new Set(info.capabilities || [])
    modelCapabilities.set(model, caps)
    // Extract context length. Ollama nests it under model_info as
    // "<arch>.context_length" (e.g. "qwen3.context_length"). Scan all keys.
    const ctxLen = extractContextLength(info)
    if (ctxLen > 0) modelContextLength.set(model, ctxLen)
    // Also cache short name
    if (model.endsWith(':latest')) {
      const short = model.replace(':latest', '')
      modelCapabilities.set(short, caps)
      if (ctxLen > 0) modelContextLength.set(short, ctxLen)
    }
    return caps
  } catch {
    return new Set()
  }
}

function extractContextLength(info) {
  // Ollama /api/show returns model_info with keys like
  // "qwen3.context_length", "llama.context_length", etc.
  const mi = info?.model_info
  if (mi && typeof mi === 'object') {
    for (const [k, v] of Object.entries(mi)) {
      if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) {
        return v
      }
    }
  }
  // Some Ollama versions expose at top level
  if (typeof info?.context_length === 'number') return info.context_length
  return 0
}

function getModelContextLength(model) {
  if (!model) return NUM_CTX
  return modelContextLength.get(model)
    ?? modelContextLength.get(model.replace(':latest', ''))
    ?? NUM_CTX
}

// Track the last Ollama model actually used — when CC sends Anthropic model
// names (vivus-haiku-*, claude-3-*) for side tasks, we route to this instead
// of the static default. Prevents constant model swapping in Ollama.
// Persisted to disk so it survives proxy restarts (deploy, crash, etc.)
const LAST_MODEL_FILE = join(dirname(new URL(import.meta.url).pathname), '.last-model')
let lastUsedOllamaModel = (() => {
  try {
    const saved = readFileSync(LAST_MODEL_FILE, 'utf8').trim()
    if (saved) return saved
  } catch {}
  return OLLAMA_MODEL
})()

function routeModel(requestModel) {
  // If the CLI sent an actual Ollama model name, use it directly
  if (requestModel && knownOllamaModels.has(requestModel)) {
    lastUsedOllamaModel = requestModel
    try { writeFileSync(LAST_MODEL_FILE, requestModel) } catch {}
    return { ollamaModel: requestModel, tier: 'default' }
  }

  // Map Anthropic model names to the LAST USED Ollama model (not the static default).
  // CC sends these for side tasks (error summaries, tool result parsing, etc.)
  // Routing to the static default would unload the user's chosen model from Ollama.
  if (requestModel) {
    const lower = requestModel.toLowerCase()
    if (/haiku|sonnet|opus|claude|vivus-/.test(lower)) {
      debug(`Anthropic model name "${requestModel}" → ${lastUsedOllamaModel} (last used)`)
      return { ollamaModel: lastUsedOllamaModel, tier: 'default' }
    }
  }

  // Unknown model — use default
  return { ollamaModel: OLLAMA_MODEL, tier: 'default' }
}

function log(...args) { console.error('[proxy]', ...args) }
function debug(...args) { if (DEBUG) console.error('[proxy:debug]', ...args) }

// ---------------------------------------------------------------------------
// Portal integration — API key validation & metrics
// ---------------------------------------------------------------------------

async function validateApiKey(rawKey) {
  if (!PORTAL_URL) return { valid: true, user_id: 0, username: 'local' }  // no portal = allow all
  // Legacy bypass key — allows running without a portal-issued key
  if (rawKey === 'sk-vivus-proxy') return { valid: true, user_id: 0, username: 'local' }
  try {
    const resp = await fetch(`${PORTAL_URL}/api/v1/keys/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: rawKey }),
      signal: AbortSignal.timeout(3000),  // 3s timeout — don't hang if portal is down
    })
    const result = await resp.json()
    if (!result.valid) {
      const preview = rawKey ? `${rawKey.slice(0, 12)}...(len=${rawKey.length})` : '(empty)'
      log(`key validation REJECTED: ${preview} reason=${result.error || '?'}`)
    }
    return result
  } catch (err) {
    log('portal key-validation failed:', err.message)
    return { valid: false, error: 'API key validation unavailable' }
  }
}

function reportMetrics(rawKey, model, tier, startTime, tokens, extra = {}) {
  if (!PORTAL_URL) return
  const duration_ms = Date.now() - startTime
  const prompt_tokens     = tokens?.prompt_tokens     || 0
  const completion_tokens = tokens?.completion_tokens  || 0
  const total_tokens      = prompt_tokens + completion_tokens
  debug(`reporting metrics: model=${model} tier=${tier} prompt=${prompt_tokens} completion=${completion_tokens} total=${total_tokens} duration=${duration_ms}ms stop=${extra.stop_reason || '?'}`)
  // Fire-and-forget — don't block the response
  fetch(`${PORTAL_URL}/api/v1/metrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(3000),
    body: JSON.stringify({
      key: rawKey,
      model,
      tier,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      duration_ms,
      endpoint: '/v1/messages',
      // Extended metrics — portal can store what it wants, ignore the rest
      stop_reason: extra.stop_reason || null,        // 'end_turn', 'tool_use', 'max_tokens'
      tool_names: extra.tool_names || null,           // ['Read','Edit'] — tools the model called this turn
      tools_available: extra.tools_available || null,  // ['Bash','Edit','Read'] — tools offered
      tool_round: extra.tool_round || 0,              // how many tool results in conversation so far
      query_summary: extra.query_summary || null,     // first 100 chars of user's original query
      error: extra.error || null,                     // upstream error if any
      messages_sent: extra.messages_sent || 0,        // message count sent to Ollama
      prompt_budget_dropped: extra.prompt_budget_dropped || 0,  // messages dropped by budget trim
    }),
  }).catch(err => debug('metrics report failed:', err.message))
}

// ---------------------------------------------------------------------------
// Loop detection — catch read→fail→read→fail analysis loops
// ---------------------------------------------------------------------------
// Smaller models get stuck in loops: they read a file, fail to edit it,
// re-read it, try the same edit, fail again, etc. This detects that pattern
// from the Anthropic-format messages (before translation) and returns info
// for injecting a loop-breaking nudge.
function detectToolLoop(messages) {
  if (!messages?.length) return null

  // Only analyze the conversation since the most recent FRESH user message
  // (one that contains real text, not just tool_results). Fresh user input
  // resets the loop — without this, the circuit-breaker re-fires forever
  // because the historical loop pattern is still in the message array.
  let startIdx = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'user') continue
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
    const hasFreshText = blocks.some(b => {
      if (b.type === 'tool_result') return false
      const text = typeof b === 'string' ? b : (b.text || '')
      // Ignore system reminders / meta wrappers
      if (!text || text.startsWith('<system-reminder>')) return false
      return text.trim().length > 0
    })
    if (hasFreshText) { startIdx = i; break }
  }

  const calls = []
  const errorIds = new Set()

  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          let target = block.input?.file_path || block.input?.path
            || block.input?.command || ''
          // For Read/View/Cat, include line range to distinguish reads of different parts of same file.
          // Anthropic Read uses offset/limit; some variants use startLine/endLine or line_start/line_end.
          if (/^(Read|View|Cat|ReadFile)$/i.test(block.name)) {
            const offset = block.input?.offset ?? block.input?.startLine ?? block.input?.line_start
            const limit = block.input?.limit ?? block.input?.endLine ?? block.input?.line_end
            if (offset !== undefined || limit !== undefined) {
              target = `${target}:O${offset ?? '?'}-L${limit ?? '?'}`
            }
          }
          calls.push({ name: block.name, target, id: block.id })
        }
      }
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.is_error) {
          errorIds.add(block.tool_use_id)
        }
      }
    }
  }

  if (calls.length < 5) return null

  // Analyze the last 12 tool calls for clear pathological patterns.
  // Anthropic's Claude Code has no loop detector at all — we keep only
  // the most obvious bad patterns (same exact action repeated many times,
  // or repeated failed edits) and let the model self-correct otherwise.
  const recent = calls.slice(-12)
  const readCounts = {}
  let failedEdits = 0
  const failedTargets = []


  // For repeatedTargets, use the same key as callKeys (name:target) so chunked reads are not treated as repeats
  for (const c of recent) {
    const key = `${c.name}:${c.target}`
    if (/^(Read|ReadFile|View|Cat)$/i.test(c.name) && c.target) {
      readCounts[key] = (readCounts[key] || 0) + 1
    }
    if (/^(Edit|Write|Update|MultiEdit|Create)$/i.test(c.name) && errorIds.has(c.id)) {
      failedEdits++
      if (c.target) failedTargets.push(c.target)
    }
  }

  // Same tool+target (including line range) read 4+ times = clear loop
  const repeatedTargets = Object.entries(readCounts)
    .filter(([, v]) => v >= 4)
    .map(([k]) => k)

  // Same tool+target called 4+ times in last 12 = clear loop
  const callKeys = recent.map(c => `${c.name}:${c.target}`)
  const keyCounts = {}
  for (const k of callKeys) keyCounts[k] = (keyCounts[k] || 0) + 1
  const anyRepeated = Object.values(keyCounts).some(v => v >= 4)

  // STUCK: the LAST 4 tool calls have identical name and target (including line range/args).
  // True byte-identical repetition is always a stuck loop — no extra evidence needed.
  const last4 = recent.slice(-4)
  const stuck = last4.length === 4 && last4.every(c =>
    c.name === last4[0].name && c.target === last4[0].target && c.target !== ''
  )

  // SEQUENCE LOOP: Detect repeating patterns like A-B-C-A-B-C-A-B-C...
  // Require at least 2 repetitions of the same sequence to catch
  // obvious stuck patterns without flagging normal exploration.
  let sequenceLoop = false
  if (callKeys.length >= 6) {
    const last6 = callKeys.slice(-6)
    // Check for pattern of 2 repeated 3 times: A-B-A-B-A-B
    if (last6.length === 6 && last6[0] === last6[2] && last6[2] === last6[4] &&
        last6[1] === last6[3] && last6[3] === last6[5] && last6[0] !== last6[1]) {
      sequenceLoop = true
    }
    // Check for pattern of 3 repeated 2 times: A-B-C-A-B-C
    else if (last6.length === 6 && last6[0] === last6[3] && last6[1] === last6[4] && last6[2] === last6[5]) {
      sequenceLoop = true
    }
  }

  // Only fire on clear pathological patterns. Exploration is NORMAL.
  if (repeatedTargets.length > 0 || failedEdits >= 3 || anyRepeated || stuck || sequenceLoop) {
    return {
      repeatedTargets,
      failedEdits,
      failedTargets: [...new Set(failedTargets)],
      totalCalls: calls.length,
      anyRepeated,
      stuck,
      stuckCall: stuck ? `${last4[0].name}:${last4[0].target}` : null,
      sequenceLoop,
    }
  }

  return null
}

// Injected at the end of the system prompt when tools are available.
// Overcomes the tendency of smaller models to describe what they'd do
// rather than actually calling the provided functions.
// NOTE: This goes at the END only. Sandwich (start+end) made the model
// erratic — it rushed to act but hallucinated wrong tasks (PR creation,
// editing when not asked). End-only with clear, calm language works better.
const TOOL_USE_NUDGE = `
=== TOOL USAGE GUIDANCE ===
• When you need information or to make changes, call the appropriate tool. Brief commentary before a tool call is fine — long plans/narration are not.
• If a tool returns an error, empty output, or unexpected results: DO NOT retry the same call. Either try a different approach (different command, different file, different tool) or report what happened to the user.
• Calling the same tool with the same arguments more than twice in a row almost never helps — change something or stop.

=== FILE READING ===
• ALWAYS use the Read tool to read files. NEVER use Bash(cat), Bash(head), Bash(tail), or Bash(sed -n) to read file contents.
• Read can take line ranges — use that instead of cat | sed or head/tail.
• Only use Bash for commands that actually DO something (git, npm, build, test, grep across many files, etc.).

=== FILE CREATION ===
• Prefer Edit(file_path, old_string="", new_string="<content>") for new files. If it errors with "file exists", delete it first with Bash(rm) or use Edit on the existing file.
• Alternative: Bash(command="cat > file << 'EOF'\\n...\\nEOF") for heredoc writes.
• Never paste raw file content as a chat message — always use tools.
• After creating or editing a file, do not re-read it just to verify.

=== STAYING ON TASK ===
• Read the user's message carefully. Address their SPECIFIC request — not a general overview.
• If the user mentions specific files, read those first.
• For analysis tasks: read relevant files, then give findings with line numbers.
• For editing tasks: make the changes with tools directly.
• Never ask "What would you like help with?" or present a menu.
• When done: brief 1-2 sentence summary. No exhaustive recaps.
=== END GUIDANCE ===
`

// Simplify the system prompt for smaller models. The upstream system
// prompt is thousands of tokens of Anthropic-specific instructions that
// confuse smaller models. We strip it down to the essentials.
function simplifySystemPrompt(text) {
  if (!text) return text

  // Always simplify when the prompt contains Claude Code noise like
  // billing headers, "Vivus agent" identity, etc. These confuse smaller
  // models even when the prompt is short (like --bare mode).
  const hasCCNoise = /x-anthropic-billing|Vivus Agent SDK|Anthropic's.*CLI/i.test(text)
  if (!hasCCNoise && text.length < 2000) return text

  // Extract CWD. The CLI emits it in one of these forms in the env block:
  //   "Working directory: <path>"          (computeEnvInfo)
  //   "Primary working directory: <path>"  (computeSimpleEnvInfo)
  //   "Current working directory: <path>"  (some older paths)
  //   "CWD: <path>"                        (legacy)
  // If we can't find one, omit the line entirely — never fall back to the
  // proxy process's own cwd (that's the server, not the user's machine, and
  // it misleads the model into resolving paths against the wrong filesystem).
  const cwdMatch =
    text.match(/Primary working directory:\s*(.+)/) ||
    text.match(/Current working directory:\s*(.+)/) ||
    text.match(/Working directory:\s*(.+)/) ||
    text.match(/CWD:\s*(.+)/)
  const cwd = cwdMatch ? cwdMatch[1].trim() : ''

  // Extract git status snippet (useful context)
  const gitMatch = text.match(/gitStatus:.*?\n([\s\S]*?)(?:\n\n|\ngitBranch:)/)
  const gitSnippet = gitMatch ? gitMatch[1].trim().slice(0, 500) : ''

  // Extract git branch
  const branchMatch = text.match(/gitBranch:\s*(.+)/)
  const branch = branchMatch ? branchMatch[1].trim() : ''

  return `You are an expert coding agent running in a terminal. You take action immediately using tools.

${cwd ? `Current working directory: ${cwd}\n` : ''}Date: ${new Date().toISOString().slice(0, 10)}
${branch ? `Git branch: ${branch}` : ''}
${gitSnippet ? `\nRecent git status:\n${gitSnippet}` : ''}

You have access to tools to interact with the filesystem and run commands.
When the user gives you a task, immediately start executing it with tools. Do not describe what you plan to do.
For multi-step tasks, keep calling tools until the work is fully complete — don't stop early or ask for permission.
Never present a menu of options. Never ask "would you like me to...". Just do the work.

FILE READING RULES:
• ALWAYS use the Read tool to read files. NEVER use Bash(cat), Bash(head), Bash(tail), or Bash(sed -n) to view file contents.
• Read supports line ranges — use that instead of piping through sed or head/tail.
• Reserve Bash for commands that DO things: git, build, test, grep across directories, running scripts.

FILE CREATION RULES:
• To create a NEW file: Edit(file_path="path/to/file", old_string="", new_string="<full file content>")
• If Edit fails with 'Error editing file', the file already exists. Delete first: Bash(rm -f path/to/file), then Edit.
• Alternative: Bash(cat > file << 'EOF'\ncontent\nEOF)
• NEVER output raw file content as text — it will NOT create a file.
• After creating or editing, say "Done" briefly — do NOT re-read to verify.`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Extract the user's original query from the Anthropic message array.
// Claude Code sends user messages as arrays where the LAST text block is the
// actual query (earlier blocks are <system-reminder> injections).
function extractOriginalQuery(messages) {
  if (!messages?.length) return null
  const firstUser = messages.find(m => m.role === 'user')
  if (!firstUser) return null
  if (typeof firstUser.content === 'string') return firstUser.content.slice(0, 300)
  if (Array.isArray(firstUser.content)) {
    const textBlocks = firstUser.content.filter(b => b.type === 'text')
    if (textBlocks.length > 0) {
      const last = textBlocks[textBlocks.length - 1].text || ''
      // Skip if it looks like a system injection, not a real query
      if (last.startsWith('<system-reminder>')) return textBlocks.length > 1 ? textBlocks[textBlocks.length - 2].text?.slice(0, 300) : null
      return last.slice(0, 300)
    }
  }
  return null
}

// Extract the LATEST user query — the most recent user message that contains
// actual text (not just tool_result blocks). Used for task detection on
// follow-up messages so we don't confuse "check for security flaws" with the
// original /init prompt that started the conversation.
function extractLatestQuery(messages) {
  if (!messages?.length) return null
  // Walk backwards to find the last user message with text content
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content.slice(0, 300)
    if (Array.isArray(msg.content)) {
      const textBlocks = msg.content.filter(b => b.type === 'text')
      if (textBlocks.length > 0) {
        const last = textBlocks[textBlocks.length - 1].text || ''
        if (!last.startsWith('<system-reminder>')) return last.slice(0, 300)
        if (textBlocks.length > 1) return textBlocks[textBlocks.length - 2].text?.slice(0, 300)
      }
      // This user message only has tool_results, skip to the one before
      const hasOnlyToolResults = msg.content.every(b => b.type === 'tool_result' || b.type === 'text' && b.text?.startsWith('<system-reminder>'))
      if (hasOnlyToolResults) continue
    }
  }
  return null
}

// Build an action-aware progress summary from translated messages.
// Instead of just dumping raw tool output, this shows WHAT was done:
//   "✓ Bash: docker ps → 3 containers running"
//   "✓ Read: package.json → found Next.js 14"
//   "✗ Edit: client.lua → Error editing file"
function buildProgressSummary(messages) {
  const actions = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !msg.tool_calls) continue
    for (const tc of msg.tool_calls) {
      const name = tc.function?.name || '?'
      const args = typeof tc.function?.arguments === 'object'
        ? tc.function.arguments
        : (() => { try { return JSON.parse(tc.function?.arguments || '{}') } catch { return {} } })()
      const target = args.file_path || args.path || args.command?.slice(0, 50) || ''
      // Find the matching tool result
      const result = messages.find((m, j) => j > i && m.role === 'tool' && m.tool_call_id === tc.id)
      const content = (result?.content || '').replace(/^\[Tool Output\]\n/, '').trim()
      const isError = content.startsWith('Error:') || /error editing file/i.test(content)
      const brief = content.slice(0, 80).replace(/\n/g, ' ')
      const prefix = isError ? '✗' : '✓'
      actions.push(`${prefix} ${name}(${target}) → ${brief}`)
    }
  }
  return actions
}

function msgId()  { return 'msg_'   + crypto.randomUUID().replace(/-/g, '').slice(0, 24) }
function toolId() { return 'toolu_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24) }

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// Strip model chat-template control tokens that occasionally leak through
// Ollama into the user-visible text stream. Each pattern targets a known
// model family's special tokens; none of these sequences are expected to
// appear in legitimate assistant output.
//   - ]<]name[>[          MiniMax delimiter (e.g. ]<]minimax[>[)
//   - <|name|>            ChatML / Qwen / Llama-3 specials
//                         (im_start, im_end, eot_id, end_of_text,
//                          start_header_id, end_header_id, etc.)
// The pipe-bar variant uses U+007C which is rare enough in real prose
// (and unbalanced when stripped) that incidental matches are acceptable.
function stripModelControlTokens(s) {
  if (!s) return s
  return s
    .replace(/\]<\][A-Za-z0-9_]+\[>\[/g, '')
    .replace(/<\|[A-Za-z0-9_-]+\|>/g, '')
}

// ---------------------------------------------------------------------------
// Request translation  (Anthropic → OpenAI)
// ---------------------------------------------------------------------------

function translateSystem(system) {
  if (!system) return null
  let text
  if (typeof system === 'string') text = system
  else if (Array.isArray(system)) text = system.filter(b => b.type === 'text').map(b => b.text).join('\n')
  else text = String(system)
  // Prepend /no_think for qwen3 models — suppresses extended thinking at
  // the prompt level (in addition to think:false in the API request).
  // Without this, qwen3-coder spends minutes reasoning silently on errors.
  return '/no_think\n' + simplifySystemPrompt(text)
}

function translateMessages(messages, system, ollamaModel) {
  const out = []

  const sys = translateSystem(system)
  if (sys) out.push({ role: 'system', content: sys })

  // Check if model supports vision — cached from refreshModelList
  const caps = modelCapabilities.get(ollamaModel) || new Set()
  const hasVision = caps.has('vision')

  // Track Read targets to detect repeated *identical* reads during
  // translation. When the SAME exact range of a file is read 4+ times we
  // collapse the duplicate middle results — this breaks read loops at the
  // data level without confiscating content for legitimate re-reads with a
  // different offset/limit (e.g. after compaction, or when the user asks to
  // see content again).
  const readKey = (block) => {
    const path = block.input?.file_path || block.input?.path || ''
    if (!path) return ''
    const offset = block.input?.offset ?? block.input?.start_line ?? ''
    const limit  = block.input?.limit  ?? block.input?.end_line   ?? ''
    return `${path}\u0000${offset}\u0000${limit}`
  }
  const readKeyCounts = {}  // exact key → count
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && /^(Read|ReadFile|View|Cat)$/i.test(block.name)) {
          const key = readKey(block)
          if (key) readKeyCounts[key] = (readKeyCounts[key] || 0) + 1
        }
      }
    }
  }
  // Build a set of tool_use IDs whose result should be collapsed.
  // Only when an IDENTICAL read happened 4+ times: keep the first and last,
  // collapse the middle ones.
  const repeatedReadIds = new Set()
  const readKeySeen = {}
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && /^(Read|ReadFile|View|Cat)$/i.test(block.name)) {
          const key = readKey(block)
          if (key && (readKeyCounts[key] || 0) >= 4) {
            readKeySeen[key] = (readKeySeen[key] || 0) + 1
            if (readKeySeen[key] > 1 && readKeySeen[key] < readKeyCounts[key]) {
              repeatedReadIds.add(block.id)
            }
          }
        }
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        const toolResults = []
        const textParts   = []
        const imageParts  = []

        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            let content = ''
            if (typeof block.content === 'string') content = block.content
            else if (Array.isArray(block.content))
              content = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
            if (block.is_error) {
              content = `Error: ${content}`
              // Inject inline recovery hint for Edit errors — gives the model
              // immediate guidance instead of triggering minutes of reasoning.
              if (/error editing file|old_string.*not found|no match/i.test(content)) {
                content += '\n\n[QUICK FIX: The file already exists or old_string didn\'t match. Run Bash(command="rm -f <filepath>") to delete it, then re-create with Edit(file_path="...", old_string="", new_string="<content>"). Do NOT re-read the file. Act NOW.]'
              }
            }
            // Capybara-style fix: never pass empty tool results — models interpret
            // empty content as a turn boundary and prematurely stop generating.
            // Collapse the content of duplicate intermediate reads. The
            // first and most recent reads of this exact range remain intact,
            // so the model still has the file contents — this only trims the
            // redundant copies from history.
            if (repeatedReadIds.has(block.tool_use_id)) {
              content = '[duplicate read of the same range — content shown in another Read result in this conversation]'
            }
            // Detect upstream "file unchanged" cache hits — after context
            // compaction the model no longer has the content, so tell it
            // to re-read with a different offset to bust the cache.
            if (/file unchanged|unchanged since last read/i.test(content) && content.length < 200) {
              content += '\n\n[The file content was compacted from your conversation history. Re-read the file with a slightly different line range (e.g. offset by 1) to get the full content again.]'
            }
            toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content: content || 'Tool executed successfully.' })
          } else if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'image' && block.source?.type === 'base64') {
            if (hasVision) {
              // Ollama native API: images are raw base64 strings (no data URI prefix)
              imageParts.push(block.source.data)
            } else {
              textParts.push('[An image was attached but the current model does not support vision. Please describe the image in text, or switch to a vision-capable model.]')
            }
          } else if (block.type === 'text' && /^\[Image #\d+\]$/.test(block.text?.trim())) {
            // CC puts [Image #N] placeholder references in history after the
            // image data has been consumed. Replace with context note so the
            // coding model doesn't hallucinate about needing vision.
            if (!hasVision) {
              textParts.push('[An image was previously shared and analyzed by the vision model. Its description is in the conversation above. Work with that text description.]')
            } else {
              textParts.push(block.text)
            }
          }
          // skip cache_control, thinking, etc.
        }

        out.push(...toolResults)

        if (textParts.length > 0 || imageParts.length > 0) {
          const userMsg = { role: 'user', content: textParts.join('\n') || '' }
          // Ollama native /api/chat: images go as a separate 'images' array
          // of raw base64 strings on the message object
          if (imageParts.length > 0) {
            userMsg.images = imageParts
          }
          out.push(userMsg)
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'assistant', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        let text = ''
        const toolCalls = []
        for (const block of msg.content) {
          if (block.type === 'text')      text += block.text
          else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                // Native Ollama API expects arguments as object, not JSON string
                arguments: typeof block.input === 'string' ? JSON.parse(block.input) : (block.input || {}),
              },
            })
          }
          // skip thinking blocks
        }
        const a = { role: 'assistant', content: text || null }
        if (toolCalls.length) a.tool_calls = toolCalls
        out.push(a)
      }
    }
  }
  return out
}

function translateTools(tools) {
  if (!tools?.length) return undefined
  return tools.map(t => {
    // Slim down tool schemas — CC sends multi-paragraph descriptions and
    // deeply nested JSON schemas that balloon prompt tokens. The model only
    // needs: tool name, brief description, and parameter names with types.
    const schema = t.input_schema || { type: 'object', properties: {} }
    // Strip verbose property descriptions, keep only name + type
    const slimProps = {}
    if (schema.properties) {
      for (const [k, v] of Object.entries(schema.properties)) {
        slimProps[k] = { type: v.type || 'string' }
        // Keep enum values (important for constrained choices) but drop descriptions
        if (v.enum) slimProps[k].enum = v.enum
      }
    }
    // Truncate description to first sentence (max 120 chars)
    const desc = (t.description || '').split(/\. |\n/)[0].slice(0, 120)
    return {
      type: 'function',
      function: {
        name: t.name,
        description: desc,
        parameters: {
          type: 'object',
          properties: slimProps,
          required: schema.required,
        },
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Conversation compression for the write phase.
// ---------------------------------------------------------------------------
// When the model has read many files and is about to create/edit a file,
// the full conversation history makes the prompt too large (>8K tokens),
// causing slow prompt eval (80% CPU offload) that triggers 504 gateway
// timeout from the reverse proxy at llm.vivus.ai. This collapses all
// tool interactions into a single condensed context message, cutting
// prompt from ~15K tokens to ~4K tokens.
function compressConversation(messages, originalQuery) {
  const sysMsg = messages.find(m => m.role === 'system')
  const sysText = sysMsg?.content || ''

  // Collect key info from tool interactions
  const contextParts = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !msg.tool_calls) continue

    for (const tc of msg.tool_calls) {
      const name = tc.function?.name || ''
      const args = typeof tc.function?.arguments === 'string'
        ? (() => { try { return JSON.parse(tc.function.arguments) } catch { return {} } })()
        : (tc.function?.arguments || {})

      // Find the corresponding tool result
      const toolResult = messages.find((m, j) =>
        j > i && m.role === 'tool' && m.tool_call_id === tc.id
      )
      let result = toolResult?.content || ''
      result = result.replace(/^\[Tool Output\]\n/, '')

      if (/^Read$/i.test(name)) {
        const path = args.file_path || args.path || 'unknown'
        contextParts.push(`### ${path}\n${result.slice(0, 2000)}`)
      } else if (/^Bash$/i.test(name)) {
        const cmd = args.command || ''
        contextParts.push(`### \`${cmd}\`\n${result.slice(0, 1000)}`)
      } else if (/^Edit$/i.test(name)) {
        const path = args.file_path || args.path || 'unknown'
        contextParts.push(`[Created/edited: ${path}]`)
      }
    }
  }

  // Budget: ~10K chars for context (≈ 3K tokens) — keeps total prompt
  // under 5K tokens so eval completes in <50s on CPU-heavy offload.
  let context = ''
  const BUDGET = 10000
  for (const part of contextParts) {
    if (context.length + part.length > BUDGET) {
      const remaining = BUDGET - context.length
      if (remaining > 200) {
        context += '\n\n' + part.slice(0, remaining) + '\n...(truncated)'
      }
      break
    }
    context += (context ? '\n\n' : '') + part
  }

  return [
    { role: 'system', content: sysText },
    {
      role: 'user',
      content: `${originalQuery || 'Create the requested file.'}

Here is what I found in the codebase:

${context}

Now write the COMPLETE content of VIVUS.md below. Start immediately with the first line (# Project Name). Do NOT wrap in code fences. Do NOT say "here is the file" — just output the raw content.

Include ALL of these sections with real data from the context above:
## Verification / Development Commands (build, test, lint, run commands)
## Dependencies (libraries, env vars, config files)
## Project Structure (directory layout, entry points)
## Architecture (core components, data flow)
## Conventions & Patterns (coding patterns, naming conventions)
## Configuration (options, defaults, env-specific setup)
## Common Pitfalls (gotchas, known issues)

Be thorough. Use actual file paths, command names, and code patterns from the context.`
    }
  ]
}

function buildOllamaRequest(body, ollamaModel) {
  const meta = {}

  // Strip prior synthetic circuit-breaker messages from history. Without
  // this, the model sees its own previous "[vivus-stuck-marker] I keep
  // repeating..." reply and imitates the pattern on later turns even
  // when no loop is happening.
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.filter(m => {
      if (m.role !== 'assistant') return true
      const text = typeof m.content === 'string'
        ? m.content
        : (Array.isArray(m.content) ? m.content.map(b => b?.text || '').join('') : '')
      return !text.includes('[vivus-stuck-marker]')
    })
  }

  // Auto-route to a vision model ONLY when the current request contains
  // actual image data. The vision model describes what it sees in text,
  // which becomes part of the conversation history. Follow-up requests
  // go back to the coding model, which reads the vision model's description
  // from history. If another image appears later, we switch to vision again.
  const hasImages = (body.messages || []).some(m =>
    Array.isArray(m.content) && m.content.some(b => b.type === 'image')
  )
  if (hasImages) {
    const caps = modelCapabilities.get(ollamaModel) || new Set()
    if (!caps.has('vision')) {
      const visionModel = [...modelCapabilities.entries()]
        .find(([, c]) => c.has('vision'))
      if (visionModel) {
        log(`image detected, auto-routing ${ollamaModel} → ${visionModel[0]} (vision)`)
        ollamaModel = visionModel[0]
        meta.autoRoutedVision = true
      }
    }
  }

  const req = {
    model:    ollamaModel,
    messages: translateMessages(body.messages, body.system, ollamaModel),
    stream:   !!body.stream,
    // Disable thinking for thinking models (GLM-4.7-Flash, DeepSeek-R1, etc.)
    // Thinking tokens consume the num_predict budget — a 7-minute "crunch"
    // with no output means the model exhausted its budget on reasoning tokens
    // and had nothing left for the actual tool call / response.
    think:    false,
  }

  // Ollama native options — num_ctx is the TOTAL context window (prompt + generation).
  // The OpenAI-compat endpoint silently ignores this, which is why we use /api/chat.
  // Per-model context cap (from /api/show model_info.<arch>.context_length),
  // clamped to global NUM_CTX ceiling. Allows large-context models like
  // qwen3-coder-next (256K) to use their full window, while keeping smaller
  // models from over-allocating KV cache.
  // SSE keep-alive pings prevent gateway timeout during long prompt eval.
  const modelCtxCap = Math.min(getModelContextLength(req.model), NUM_CTX)
  const minPredict = 2048
  const maxPredict = modelCtxCap - 8192  // leave 8K tokens for prompt at minimum
  const requestedPredict = body.max_tokens || minPredict
  req.options = {
    num_ctx: modelCtxCap,
    num_predict: Math.min(Math.max(requestedPredict, minPredict), maxPredict),
  }

  if (body.temperature != null)      req.options.temperature = body.temperature
  if (body.top_p != null)            req.options.top_p       = body.top_p
  if (body.stop_sequences?.length)   req.options.stop        = body.stop_sequences

  const tools = translateTools(body.tools)
  if (tools) {
    req.tools = tools

    // Count tool results early — needed for dynamic caps below.
    // Claude Code batches multiple tool calls per round, so 27 tool results
    // might only be ~15 request-response cycles.
    const toolResultCount = req.messages.filter(m => m.role === 'tool').length

    // No artificial num_predict cap for tool calls. Edit calls writing full
    // files can need 10K+ tokens. The upstream max_tokens (clamped to
    // NUM_CTX - 8192 = 24576) is the natural limit. Dynamic num_ctx sizing
    // already prevents excess KV cache allocation.

    // Clamp temperature for tool-calling requests — smaller models need
    // lower temps for reliable agentic behavior (OmniCoder recommends 0.2-0.4).
    if (req.options.temperature == null || req.options.temperature > 0.2) {
      req.options.temperature = 0.2
    }
    // Append our behavioral nudge at the END of the system prompt.
    // End-only (not sandwich) — the sandwich approach made smaller models
    // erratic, hallucinating tasks like "creating a PR" from Claude Code's
    // prompt content. End-only lets the upstream prompt provide normal context,
    // then gently redirects behavior at the point of highest recency attention.

    {
      const sysIdx = req.messages.findIndex(m => m.role === 'system')
      if (sysIdx >= 0) {
        req.messages[sysIdx].content += '\n\n' + TOOL_USE_NUDGE
      } else {
        req.messages.unshift({ role: 'system', content: TOOL_USE_NUDGE.trim() })
      }

      // When user explicitly asks to fix/edit/change code, add a strong
      // tool-first nudge. Without this, smaller models describe the fix in
      // text instead of actually applying it with the Edit tool.
      const latestQ = extractLatestQuery(body.messages) || ''
      const isEditIntent = /\b(fix|edit|change|update|modify|patch|correct|refactor|implement|apply|rewrite)\b/i.test(latestQ)
        && /\.(lua|js|ts|py|rs|sh|json|toml|yaml|yml|cfg|conf|mjs|jsx|tsx|css|html|sql)\b/i.test(latestQ)
      if (isEditIntent && toolResultCount === 0) {
        const sysMsg = req.messages.find(m => m.role === 'system')
        if (sysMsg) {
          sysMsg.content += `\n\n=== EDIT MODE ===
The user wants you to EDIT a specific file. Do NOT describe the fix in text.
Step 1: Call Read(file_path="the file") to see the current code.
Step 2: Call Edit(file_path="the file", old_string="exact text to replace", new_string="fixed text") to apply the fix.
Do NOT output code blocks in text. Use the Edit tool to make the change directly.
=== END EDIT MODE ===`
          debug(`edit-intent detected: "${latestQ.slice(0, 60)}"`)
        }
      }

      // Detect /init or VIVUS.md creation tasks and inject a comprehensive template
      const originalQuery = extractOriginalQuery(body.messages)
      const isInitTask = /\b(init|VIVUS\.md|CLAUDE\.md|copilot-instructions|bootstrap.*workspace)\b/i.test(originalQuery || '')
        || req.messages.some(m => m.role === 'user' && typeof m.content === 'string' && /\binit\b|VIVUS\.md|create.*guide/i.test(m.content))
      if (isInitTask && toolResultCount === 0) {
        // First round of an init task — inject template requirements
        const templateNudge = `
When creating VIVUS.md (or similar project guide), include ALL of these sections with real data from the codebase — aim for 150+ lines:

## Verification / Development Commands
- How to build, test, lint, run the project (exact commands)
- How to start/stop/restart (for servers/services)
- Any console commands or debug tools

## Dependencies
- Required libraries, packages, or services
- Required environment variables or config files (with examples)

## Project Structure
- Directory layout with brief descriptions of each folder/file
- Entry points and initialization flow

## Architecture
- Core components and how they interact
- Data flow from input to output
- Key abstractions and patterns used

## Conventions & Patterns
- Coding patterns specific to this project (e.g., module loading, config structure)
- Naming conventions, file organization rules
- Error handling patterns

## Configuration
- All configurable options with their defaults
- Required vs optional settings
- Environment-specific setup (dev vs prod)

## Common Pitfalls
- Known issues, gotchas, or footguns
- Performance considerations
- Things that look wrong but are intentional

Be thorough and specific. Include actual file paths, config keys, command names, and code patterns from the files you read.`
        const sIdx = req.messages.findIndex(m => m.role === 'system')
        if (sIdx >= 0) {
          req.messages[sIdx].content += '\n\n' + templateNudge
        }
      }
    }

    // Trim tool results to keep prompt within num_ctx budget.
    // With num_ctx=131072, we have ~80K tokens for prompt after generation reserve.
    // Each char ≈ 0.3 tokens, so total tool content budget is ~50K chars.
    const toolMsgs = req.messages.filter(m => m.role === 'tool')
    const toolCount = toolMsgs.length
    const perToolLimit = toolCount > 0 ? Math.max(2000, Math.floor(50000 / toolCount)) : 6000
    for (const msg of req.messages) {
      if (msg.role === 'tool') {
        if (!msg.content) msg.content = 'Tool executed successfully.'
        if (msg.content.length > perToolLimit) {
          msg.content = msg.content.slice(0, perToolLimit) + '\n... (truncated)'
        }
        msg.content = '[Tool Output]\n' + msg.content
      }
    }

    // --- Truncate bloated assistant text responses ---
    // Cap pure-text assistant messages to save context, BUT preserve the
    // LAST assistant message in full — the user is responding to it and
    // the model needs to see what it just said. Without this, the model
    // contradicts itself ("files are incomplete" → "files are complete")
    // because it can't read its own previous analysis.
    const ASSISTANT_TEXT_CAP = 500
    const LAST_ASSISTANT_CAP = 2000  // generous cap for the most recent response
    const lastAssistantIdx = (() => {
      for (let i = req.messages.length - 1; i >= 0; i--) {
        if (req.messages[i].role === 'assistant') return i
      }
      return -1
    })()
    for (let i = 0; i < req.messages.length; i++) {
      const msg = req.messages[i]
      if (msg.role !== 'assistant' || msg.tool_calls || typeof msg.content !== 'string') continue
      const cap = (i === lastAssistantIdx) ? LAST_ASSISTANT_CAP : ASSISTANT_TEXT_CAP
      if (msg.content.length > cap) {
        msg.content = msg.content.slice(0, cap) + '\n...(truncated)'
        debug(`trimmed assistant text at idx ${i} to ${cap} chars${i === lastAssistantIdx ? ' (last)' : ''}`)
      }
    }

    // --- Loop detection (minimal) ---
    // We only nudge on clear pathological patterns: same file read 4+ times,
    // same exact tool+target 4+ times, or 3+ failed edits. Exploration of
    // many distinct files is normal and is NOT flagged.
    const loop = detectToolLoop(body.messages)
    if (loop) {
      // REMOVED verbose loop nudges - they were confusing the model
      // and making it forget its goals. Circuit-breaker handles true loops.

      // Strip duplicate read results to save context. Keep only the LAST
      // read result for each target; replace earlier ones with a stub.
      const seenReadTargets = new Map()
      for (let i = req.messages.length - 1; i >= 0; i--) {
        const m = req.messages[i]
        if (m.role === 'tool' && m.content && !m.content.startsWith('[Duplicate read')) {
          const tcId = m.tool_call_id
          for (let j = i - 1; j >= 0; j--) {
            const a = req.messages[j]
            if (a.role === 'assistant' && a.tool_calls) {
              const tc = a.tool_calls.find(c => c.id === tcId)
              if (tc) {
                const name = tc.function?.name || ''
                const args = tc.function?.arguments || {}
                if (/^(Read|ReadFile|View|Cat)$/i.test(name)) {
                  const target = args.file_path || args.path || ''
                  if (target) {
                    if (seenReadTargets.has(target) && seenReadTargets.get(target) !== i) {
                      m.content = `[Duplicate read of ${target} — see latest result below]`
                    }
                    if (!seenReadTargets.has(target)) seenReadTargets.set(target, i)
                  }
                }
                break
              }
            }
          }
        }
      }

      log(`possible loop: ${loop.failedEdits} failed edits, ${loop.repeatedTargets.length} repeated reads, ${loop.totalCalls} total calls${loop.stuck ? ` STUCK on ${loop.stuckCall}` : ''}${loop.sequenceLoop ? ' SEQUENCE_LOOP' : ''}`)

      // Hard circuit-breaker: fire on true stuck loops or repeating
      // action sequences that show the model is cycling without progress.
      if (loop.stuck || loop.sequenceLoop) {
        meta.circuitBreaker = true
        meta.loopTotalCalls = loop.totalCalls
        meta.stuckCall = loop.stuckCall
        meta.sequenceLoop = loop.sequenceLoop
      }
    }

    // --- Action-after-analysis detection ---
    // When the model produces text-only analysis and the user confirms with
    // "yes"/"fix it"/etc., the model tends to repeat the analysis because:
    //   1. Text-only assistant messages in history teach the text pattern
    //   2. Ollama native API (/api/chat) does NOT support tool_choice
    // Fix: strip text-only assistant messages from history (break the pattern),
    // preserve their content as findings, and restructure for action.
    const lastAssistant = [...req.messages].reverse().find(m => m.role === 'assistant')
    const lastUser = [...req.messages].reverse().find(m => m.role === 'user')
    let consecutiveTextAssistants = 0
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m = req.messages[i]
      if (m.role === 'assistant' && !m.tool_calls) consecutiveTextAssistants++
      else if (m.role === 'assistant' && m.tool_calls) break
    }
    if (lastAssistant && lastUser) {
      const aText = typeof lastAssistant.content === 'string' ? lastAssistant.content : ''
      const uText = typeof lastUser.content === 'string' ? lastUser.content : ''
      const isShortFollowUp = uText.length < 200
      const wasLongAnalysis = aText.length > 300 && !lastAssistant.tool_calls
      const isActionRequest = /\b(fix|change|update|edit|modify|remove|do it|go ahead|proceed|implement|apply|refactor|yes|ok|okay|sure|please|address|resolve|patch|correct|start|begin|make)\b/i.test(uText)
        || /^\d+$/.test(uText.trim())
      const needsActionMode = (wasLongAnalysis && isShortFollowUp && isActionRequest)
        || consecutiveTextAssistants >= 2
      if (needsActionMode) {
        // Collect findings from text-only assistant messages before removing them
        const analysisFindings = []
        for (const m of req.messages) {
          if (m.role === 'assistant' && !m.tool_calls && typeof m.content === 'string' && m.content.length > 50) {
            analysisFindings.push(m.content)
          }
        }
        const findingsSummary = analysisFindings.join('\n').slice(0, 1500)

        // REMOVE text-only assistant messages from history — they teach the
        // model to generate text instead of calling tools. Keep tool-calling
        // assistant messages (they demonstrate the desired pattern).
        req.messages = req.messages.filter(m => {
          if (m.role === 'assistant' && !m.tool_calls) return false
          return true
        })

        // Replace the user's short confirmation ("yes") with a specific action
        // instruction that includes the extracted findings for context.
        const userIdx = req.messages.findLastIndex(m => m.role === 'user')
        if (userIdx >= 0) {
          req.messages[userIdx].content = `The user confirmed: "${uText}"\n\nYour previous analysis found these issues:\n${findingsSummary}\n\nNow fix the issue. Use Read to see the file, then Edit to change it.`
        }

        // Inject action mode into system prompt
        const sysIdx = req.messages.findIndex(m => m.role === 'system')
        if (sysIdx >= 0) {
          req.messages[sysIdx].content += `

=== ACTION MODE ===
The user already saw your analysis and confirmed they want fixes applied.
Do NOT repeat your analysis. Do NOT generate another report.
IMMEDIATELY start fixing issues using tools:
1. Read the file that needs fixing
2. Edit it with the exact old_string and new_string
Start with the most critical fix. Use tools NOW.
=== END ACTION MODE ===`
        }

        debug(`action mode: stripped ${analysisFindings.length} text-only assistant msgs, ${consecutiveTextAssistants} consecutive, user="${uText.slice(0, 50)}"`)
      }
    }

    // HARD PROMPT BUDGET: After trimming tool content, check total prompt
    // size. If over budget, drop oldest messages from the middle to keep
    // system prompt, first user message, and recent rounds intact.
    // Drops both tool rounds (assistant+tool pairs) AND bloated assistant
    // text messages — previously only tool rounds were dropped, leaving
    // huge analysis blobs that dominated context and caused pattern repetition.
    //
    // CRITICAL FIX: When dropping tool results, extract a brief summary of
    // what was already discovered and inject it into the first user message.
    // Without this, the model loses ALL memory and repeats the same tool
    // calls every round (e.g., ls -la, find *.md, find *.ts over and over).
    // Dynamic prompt budget — at high rounds the model is in write-mode and
    // doesn't need extensive history. Tighter budget = fewer prompt tokens =
    // faster prompt eval + more KV headroom for generation.
    const MAX_PROMPT_CHARS = toolResultCount > 20 ? 80000
                           : toolResultCount > 12 ? 96000
                           : 112000  // ~56K tokens — fits in 128K ctx with room for generation

    // --- Compact stale first-user message ---
    // CC includes full conversation history. The first user message is often
    // a big /init prompt (~500+ chars) that stays even after the task changed.
    // The budget trimmer keeps system + first user, so this stale prompt
    // wastes context and confuses the model on follow-up questions.
    // Detect: first user msg is init-like AND there's a later user msg with
    // different text → compact the first user message to a short summary.
    const INIT_PATTERN = /\b(VIVUS\.md|CLAUDE\.md|copilot-instructions|analyze this codebase and create|Set up a minimal VIVUS\.md)\b/i
    const firstUserIdx = req.messages.findIndex(m => m.role === 'user')
    if (firstUserIdx >= 0) {
      const firstUserText = typeof req.messages[firstUserIdx].content === 'string'
        ? req.messages[firstUserIdx].content : ''
      const hasLaterUserText = req.messages.some((m, i) =>
        i > firstUserIdx && m.role === 'user' && typeof m.content === 'string' && m.content.length > 5
      )
      if (INIT_PATTERN.test(firstUserText) && hasLaterUserText) {
        req.messages[firstUserIdx].content = '[Previous task: created VIVUS.md — completed. See current task below.]'
        debug('compacted stale /init first-user message')
      }
    }

    // Save full messages BEFORE budget trim — compression needs the
    // original tool results that budget trim will drop.
    let fullMessagesBeforeBudget = null
    const estimateChars = () => {
      let total = req.tools ? JSON.stringify(req.tools).length : 0
      for (const m of req.messages) {
        if (typeof m.content === 'string') total += m.content.length
        else total += JSON.stringify(m.content || '').length
        if (m.tool_calls) total += JSON.stringify(m.tool_calls).length
        total += 50  // JSON structure overhead per message (role, braces, etc.)
      }
      total += 200  // top-level JSON: model, options, stream, keep_alive
      return total
    }

    let totalChars = estimateChars()
    if (totalChars > MAX_PROMPT_CHARS) {
      // Snapshot messages before trimming — compression will need the full tool results
      fullMessagesBeforeBudget = req.messages.map(m => ({ ...m }))

      // Calculate the irreducible floor: system prompt + tool schemas.
      // If this alone exceeds MAX_PROMPT_CHARS, we can never meet the budget
      // by dropping messages — just keep system + the latest user message.
      const sysIdx = req.messages.findIndex(m => m.role === 'system')
      const toolSchemaSize = req.tools ? JSON.stringify(req.tools).length : 0
      const sysSize = sysIdx >= 0 ? (req.messages[sysIdx].content?.length || 0) : 0
      const irreducibleFloor = toolSchemaSize + sysSize

      if (irreducibleFloor > MAX_PROMPT_CHARS) {
        // System + tools already exceed budget. Don't bother with incremental
        // trimming — it would strip everything and lose the user's question.
        // Keep: system + last assistant (so model sees what it said) + last user.
        const lastUserIdx = (() => {
          for (let i = req.messages.length - 1; i >= 0; i--) {
            if (req.messages[i].role === 'user') return i
          }
          return -1
        })()
        const lastAsstIdx = (() => {
          for (let i = req.messages.length - 1; i >= 0; i--) {
            if (req.messages[i].role === 'assistant') return i
          }
          return -1
        })()
        // Build action-aware progress summary before dropping messages
        const progressActions = buildProgressSummary(req.messages)

        // Build compact message set: system + last assistant + last user
        const kept = []
        if (sysIdx >= 0) kept.push(req.messages[sysIdx])
        // Include last assistant so model can see what it just said.
        // Cap it to 1500 chars to leave room for user + tools.
        if (lastAsstIdx >= 0 && lastAsstIdx !== sysIdx) {
          const lastAsst = { ...req.messages[lastAsstIdx] }
          if (typeof lastAsst.content === 'string' && lastAsst.content.length > 1500) {
            lastAsst.content = lastAsst.content.slice(0, 1500) + '\n...(truncated)'
          }
          kept.push(lastAsst)
        }
        if (lastUserIdx >= 0 && lastUserIdx !== sysIdx) {
          const lastUser = { ...req.messages[lastUserIdx] }
          // Ensure it's a string (not tool_result array)
          if (typeof lastUser.content !== 'string') {
            const texts = Array.isArray(lastUser.content)
              ? lastUser.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
              : ''
            lastUser.content = texts || 'Continue with the current task.'
          }
          // Inject progress summary so model knows what it already did
          if (progressActions.length > 0) {
            const summary = progressActions.slice(-12).join('\n')
            lastUser.content += `\n\n[PROGRESS — actions you already completed (do NOT repeat these):\n${summary}\n\nContinue from where you left off. Do NOT re-check docker/node/npm or re-read files you already read.]`
          }
          kept.push(lastUser)
        }

        const droppedCount = req.messages.length - kept.length
        req.messages = kept
        meta.promptBudgetDropped = droppedCount
        totalChars = estimateChars()
        debug(`prompt budget (irreducible floor ${irreducibleFloor} > ${MAX_PROMPT_CHARS}): kept system + last user, dropped ${droppedCount} msgs, now ${totalChars} chars`)
      } else {
        // Normal incremental trimming — budget is achievable by dropping middle messages.
        const firstUserIdx = req.messages.findIndex(m => m.role === 'user')
        const keepFromStart = Math.max(firstUserIdx + 1, 2)

        // Build action-aware progress summary BEFORE dropping messages
        const progressActions = buildProgressSummary(req.messages)

        let dropped = 0
        while (totalChars > MAX_PROMPT_CHARS) {
          // Protect last 3 messages — recalculate each iteration since array shrinks
          const protectFrom = Math.max(keepFromStart, req.messages.length - 3)

          let dropIdx = req.messages.findIndex((m, i) =>
            i >= keepFromStart && i < protectFrom && m.role === 'assistant' && m.tool_calls
          )
          if (dropIdx < 0) {
            dropIdx = req.messages.findIndex((m, i) =>
              i >= keepFromStart && i < protectFrom && m.role === 'assistant'
            )
          }
          if (dropIdx < 0) {
            dropIdx = req.messages.findIndex((m, i) =>
              i >= keepFromStart && i < protectFrom && m.role !== 'system'
            )
          }
          if (dropIdx < 0) break

          let endIdx = dropIdx + 1
          if (req.messages[dropIdx].role === 'assistant' && req.messages[dropIdx].tool_calls) {
            while (endIdx < req.messages.length && req.messages[endIdx].role === 'tool') endIdx++
          }
          const count = endIdx - dropIdx
          req.messages.splice(dropIdx, count)
          dropped += count
          totalChars = estimateChars()
        }
        if (dropped > 0) {
          debug(`prompt budget: dropped ${dropped} old messages, ${totalChars} chars (~${Math.round(totalChars * 0.5)} est tokens)`)
          meta.promptBudgetDropped = dropped
          if (progressActions.length > 0) {
            const summary = progressActions.slice(-12).join('\n')
            const fui = req.messages.findIndex(m => m.role === 'user')
            if (fui >= 0) {
              const existing = typeof req.messages[fui].content === 'string'
                ? req.messages[fui].content : ''
              req.messages[fui].content = existing
                + `\n\n[PROGRESS — actions you already completed (do NOT repeat these):\n${summary}\n\nContinue from where you left off. Do NOT re-check docker/node/npm or re-read files you already read. Create project files NOW.]`
              debug(`injected ${progressActions.length} action summaries into first user message`)
            }
          }
        }
      }
    }

    // Gentle nudge after first listing to read actual files
    if (toolResultCount > 0 && toolResultCount <= 2) {
      const lastToolIdx = req.messages.findLastIndex(m => m.role === 'tool')
      if (lastToolIdx >= 0) {
        const tc = req.messages[lastToolIdx].content || ''
        if (/\.(js|ts|py|rs|mjs|sh|json|toml|md)\b|\/$/.test(tc)) {
          req.messages[lastToolIdx].content += '\n\n[Now call Read on each relevant source file to examine the actual code.]'
        }
      }
    }

    // After many reads, nudge the model to stop reading and start writing
    if (toolResultCount >= 10 && toolResultCount < 30) {
      const lastToolIdx = req.messages.findLastIndex(m => m.role === 'tool')
      if (lastToolIdx >= 0) {
        req.messages[lastToolIdx].content += '\n\n[You have read enough files. If your task requires creating or editing a file, do it NOW using the Edit tool. Do not read any more files.]'
      }
    }

    // Conciseness nudge at high rounds — large file outputs are the primary
    // cause of slowdown (2500 tokens @ 10 tok/s = 250s). Tell the model to
    // write modular, minimal code to reduce generation time.
    if (toolResultCount >= 15) {
      const sIdx = req.messages.findIndex(m => m.role === 'system')
      if (sIdx >= 0) {
        req.messages[sIdx].content += '\n\n[PERFORMANCE: You are in a long session. Each token costs ~0.1s.'
          + ' Output ONLY tool calls — zero narration, zero planning text, zero explanation.'
          + ' Write CONCISE code — no comments, no boilerplate, no verbose JSX.'
          + ' Split large files into <80 lines each. Prefer short Bash commands over huge heredocs.]'
      }
    }

    // CONVERSATION COMPRESSION for write phase.
    // When the model has read files (3+ tool results) and the task
    // involves file creation, compress the entire conversation into a
    // condensed prompt. Previously required 8+ rounds, but the model
    // finds everything useful in 1-2 rounds for most projects — and
    // with aggressive budget trimming, waiting longer just means the
    // model loops repeating the same searches with no memory.
    // Compression cuts prompt to ~4K tokens → eval in ~40s → no timeout
    // AND leaves ~12K tokens for generation (the file content).
    //
    // CRITICAL: Use the ORIGINAL translated messages (before budget trim)
    // to build the compressed prompt. The budget trimmer may have already
    // dropped all tool results, leaving only system + first user message.
    // We saved the full message list earlier for exactly this purpose.
    if (toolResultCount >= 3) {
      // Use LATEST query, not first — after /init completes, the user may
      // ask something completely different ("check for security flaws").
      // Using the first query would still match /init and trigger proxy-write.
      const query = extractLatestQuery(body.messages)
      // Match /init prompt — CC sends the full init prompt text, not literal '/init'
      const isInitTask = /\b(VIVUS\.md|CLAUDE\.md|copilot-instructions|analyze this codebase and create|Set up a minimal VIVUS\.md)\b/i.test((query || '').trim())

      // Check if tool results have real content — don't compress if the model
      // hasn't actually read any files yet. Empty Bash outputs, short directory
      // listings, and "no output" results don't count as useful content.
      const toolMsgs = req.messages.filter(m => m.role === 'tool')
      const usefulContentChars = toolMsgs.reduce((sum, m) => {
        const c = (m.content || '').replace(/^\[Tool Output\]\n/, '').trim()
        // Skip empty/minimal results
        if (!c || c === 'Tool executed successfully.' || c.length < 50
            || /^\(Bash completed with no output\)$/i.test(c)) return sum
        return sum + c.length
      }, 0)
      const hasEnoughContent = usefulContentChars > 500  // need at least ~500 chars of real file content

      debug(`compression check: toolResultCount=${toolResultCount}, query="${(query||'').slice(0,50)}", isInit=${isInitTask}, usefulChars=${usefulContentChars}, fullMsgsSaved=${!!fullMessagesBeforeBudget}`)

      // Detect if /init already completed — VIVUS.md may exist on disk from
      // a prior proxy-write whose 504'd response CC never received. CC retries
      // with the same session, causing an infinite loop.
      let initAlreadyDone = false
      if (isInitTask) {
        // Primary check: VIVUS.md exists on disk in this project's CWD
        const sysContent = req.messages[0]?.content || ''
        const cwdM =
          sysContent.match(/Primary working directory:\s*(.+)/) ||
          sysContent.match(/Current working directory:\s*(.+)/) ||
          sysContent.match(/Working directory:\s*(.+)/) ||
          sysContent.match(/CWD:\s*(.+)/)
        const taskCwd = cwdM ? cwdM[1].trim() : null
        if (taskCwd && existsSync(join(taskCwd, 'VIVUS.md'))) {
          initAlreadyDone = true
          debug(`init already done: VIVUS.md exists on disk at ${taskCwd}`)
        }
        // Fallback: tool result or assistant text mentions it was created
        if (!initAlreadyDone) {
          initAlreadyDone = req.messages.some(m =>
            (m.role === 'tool' || m.role === 'assistant') &&
            /VIVUS\.md.{0,30}(updated|created|written|generated)|Created VIVUS\.md/i.test(
              typeof m.content === 'string' ? m.content : ''
            )
          )
        }
      }
      if (initAlreadyDone) {
        // Short-circuit: strip tools, emit a simple "Done" response
        delete req.tools
        delete req.tool_choice
        req.messages = [
          req.messages.find(m => m.role === 'system') || { role: 'system', content: '' },
          { role: 'user', content: 'VIVUS.md has already been created. Reply with only: "Done — VIVUS.md created."' },
        ]
        debug('init already completed (VIVUS.md exists in tool results), short-circuiting')
      } else if (isInitTask && hasEnoughContent) {
        // Use pre-budget-trim messages for compression so we capture all tool results
        const messagesForCompression = fullMessagesBeforeBudget || req.messages
        // Always compress for /init with 3+ tool results — the budget trim
        // already proved the prompt is too large, and the model loops without
        // compression. Skip the token count check that previously gatekept this.
        {
          const beforeCount = messagesForCompression.length
          req.messages = compressConversation(messagesForCompression, query)
          // Strip ALL tools — model can't reliably call Edit (keeps calling Read
          // even when only Edit is listed). Instead, the proxy will capture the
          // model's text output and write the file directly.
          delete req.tools
          delete req.tool_choice
          // Extract CWD from system prompt for proxy-side file writing
          const sysContent2 = req.messages[0]?.content || ''
          const cwdMatch =
            sysContent2.match(/Primary working directory:\s*(.+)/) ||
            sysContent2.match(/Current working directory:\s*(.+)/) ||
            sysContent2.match(/Working directory:\s*(.+)/) ||
            sysContent2.match(/CWD:\s*(.+)/)
          const cwd = cwdMatch ? cwdMatch[1].trim() : null
          meta.proxyWrite = {
            filename: 'VIVUS.md',
            cwd,
          }
          // Cap generation tokens for proxy-write — model only needs to
          // generate file content, not tool JSON. 2048 tokens ≈ 120-150 lines
          // of markdown, enough for a thorough VIVUS.md. At ~11 tok/s on
          // CPU-offloaded GLM, this keeps generation under ~200s.
          req.options.num_predict = 2048
          const afterTokens = req.messages.reduce((s, m) => {
            const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
            return s + Math.ceil(c.length * 0.3)
          }, 0)
          debug(`compressed for proxy-write: ${beforeCount} msgs → ${req.messages.length} msgs (~${afterTokens} est tokens), ${toolResultCount} tool results, cwd=${cwd}`)
        }
      } else if (isInitTask && !hasEnoughContent) {
        // /init task but no real file content found — directory is likely empty
        // or model only got empty Bash results. Inject a nudge so the model
        // doesn't hallucinate a project structure.
        const lastToolIdx = req.messages.findLastIndex(m => m.role === 'tool')
        if (lastToolIdx >= 0) {
          req.messages[lastToolIdx].content += '\n\n[WARNING: The directory appears to be empty or contains very few files. Do NOT invent or hallucinate files that do not exist. If there are no source files to analyze, create a minimal VIVUS.md that honestly states this is an empty/new project. Only describe files you have ACTUALLY read.]'
        }
        debug(`init task with insufficient content (${usefulContentChars} chars) — injected empty-project warning`)
      }
    }

    // Translate explicit tool_choice from upstream (Anthropic → OpenAI format)
    if (body.tool_choice) {
      const tc = body.tool_choice
      if (tc.type === 'auto')       req.tool_choice = 'auto'
      else if (tc.type === 'any')   req.tool_choice = 'required'
      else if (tc.type === 'tool')  req.tool_choice = { type: 'function', function: { name: tc.name } }
    }
  }

  req.keep_alive = -1

  // --- Dynamic num_ctx sizing ---
  // Ollama allocates KV cache for the full num_ctx. With a fixed ceiling,
  // early rounds (2K prompt + 4K predict) waste KV memory, and later rounds
  // suffer from the memory pressure of a huge pre-allocated cache on
  // CPU-offloaded models. Size num_ctx to what we actually need:
  //   estimated_prompt_tokens + num_predict + headroom_buffer
  // Floor at 8192, ceiling at the model's real context (already set above).
  // This can dramatically reduce prompt eval time and memory bandwidth
  // during generation.
  {
    const estTokens = req.messages.reduce((s, m) => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
      return s + Math.ceil(c.length * 0.35)
    }, 0)
    const toolSchemaTokens = req.tools ? Math.ceil(JSON.stringify(req.tools).length * 0.35) : 0
    const needed = estTokens + toolSchemaTokens + (req.options?.num_predict || 4096) + 2048
    const modelCeiling = Math.min(getModelContextLength(req.model), NUM_CTX)
    const dynamicCtx = Math.min(modelCeiling, Math.max(8192, needed))
    if (dynamicCtx < req.options.num_ctx) {
      debug(`dynamic num_ctx: ${req.options.num_ctx} → ${dynamicCtx} (est prompt ~${estTokens + toolSchemaTokens} tok, predict ${req.options.num_predict})`)
      req.options.num_ctx = dynamicCtx
    }
  }

  // When tools are stripped (max rounds), flag the response to suppress
  // any residual tool calls from the model (some models emit tool calls
  // from conversation history even without tools in the request).
  const toolMsgCount = req.messages.filter(m => m.role === 'tool').length
  meta.forceEndTurn = toolMsgCount >= 6 && !req.tools
  return { req, meta }
}

// ---------------------------------------------------------------------------
// Streaming response translation  (Ollama NDJSON → Anthropic SSE)
// ---------------------------------------------------------------------------

async function handleStreaming(upstream, res, requestModel, meta = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Hint to reverse proxies (nginx, Caddy) to not buffer SSE responses.
    // Without this, nginx accumulates ~4-8KB before forwarding, causing
    // the visible "chunky" output instead of word-by-word streaming.
    'X-Accel-Buffering': 'no',
  })
  // Flush headers immediately — ensures the SSE connection is established
  // before any data arrives. Node's http module may defer the write otherwise.
  res.flushHeaders()

  const id = msgId()

  // message_start
  res.write(sse('message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', content: [],
      model: requestModel,
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))

  let contentIndex    = 0
  let textBlockOpen   = false
  const tcStates      = new Map()
  let stopReason      = 'end_turn'
  let inputTokens     = 0
  let outputTokens    = 0
  const calledToolNames = []  // track which tools the model called this turn
  // For proxy-side file writing: buffer all text output
  let proxyWriteBuffer = meta.proxyWrite ? '' : null

  // --- Text delta batching ---
  // Ollama sends one NDJSON line per token (~10/s). Forwarding each as a
  // separate SSE event causes CC's ink-based terminal UI to re-render per
  // token, which produces rendering artifacts (glitched status line, partial
  // overwrites — e.g. "2m598s" instead of "2m 59.8s"). Batch text deltas
  // and flush every 150ms for smoother display.
  let textDeltaBuffer = ''
  let textFlushTimer = null
  const flushTextDelta = () => {
    textFlushTimer = null
    if (textDeltaBuffer && textBlockOpen && !res.writableEnded) {
      res.write(sse('content_block_delta', {
        type: 'content_block_delta', index: contentIndex,
        delta: { type: 'text_delta', text: textDeltaBuffer },
      }))
      textDeltaBuffer = ''
    }
  }

  const reader  = upstream.body.getReader()
  const dec     = new TextDecoder()
  let buf       = ''

  // Keep-alive: send SSE comments every 15s to prevent reverse proxies
  // (nginx) from killing the connection during Ollama's long prompt eval.
  // SSE comments (lines starting with ':') are ignored by EventSource clients.
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n')
    }
  }, 15_000)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })

      // Ollama native streams NDJSON: one JSON object per line
      const lines = buf.split('\n')
      buf = lines.pop()

      for (const line of lines) {
        if (!line.trim()) continue

        let chunk
        try { chunk = JSON.parse(line) } catch { continue }

        // Final chunk has done=true with usage stats
        if (chunk.done) {
          inputTokens  = chunk.prompt_eval_count || 0
          outputTokens = chunk.eval_count        || 0
          if (chunk.done_reason === 'length') stopReason = 'max_tokens'
          continue
        }

        const msg = chunk.message || {}

        // --- thinking tokens ---
        // We set think:false in the request, but some qwen3 models still
        // leak thinking tokens in the stream. Silently discard them —
        // forwarding them as Anthropic thinking blocks causes CC's status
        // line to show a glitched "thinking" indicator and corrupts the
        // terminal layout with double-parentheses.
        // (Previously we forwarded them as thinking blocks.)

        // --- content → Anthropic text block (or buffer for proxy-write) ---
        if (msg.content) {
          // Strip leaked chat-template control tokens (MiniMax delimiters,
          // ChatML/Qwen/Llama specials) before they reach the user. If the
          // whole chunk was nothing but control tokens, skip the rest of
          // the content branch — but still process tool_calls below.
          const cleanedContent = stripModelControlTokens(msg.content)
          if (cleanedContent) {
            if (proxyWriteBuffer != null) {
              // Proxy-write mode: buffer text silently, don't stream to CC yet.
              // We'll write the file and emit a synthetic Edit tool_use after.
              proxyWriteBuffer += cleanedContent
            } else {
              if (!textBlockOpen) {
                res.write(sse('content_block_start', {
                  type: 'content_block_start', index: contentIndex,
                  content_block: { type: 'text', text: '' },
                }))
                textBlockOpen = true
              }
              // Batch text deltas to reduce SSE event frequency.
              // Immediate flush on large chunks; buffered for small tokens.
              textDeltaBuffer += cleanedContent
              if (textDeltaBuffer.length > 400) {
                if (textFlushTimer) { clearTimeout(textFlushTimer); textFlushTimer = null }
                flushTextDelta()
              } else if (!textFlushTimer) {
                textFlushTimer = setTimeout(flushTextDelta, 150)
              }
            }
          }
        }

        // --- tool_calls (arrive as a single chunk in native API) ---
        // In proxyWrite mode, suppress ALL tool calls — we stripped tools but
        // Ollama doesn't enforce this. The model may still emit Read/Bash calls
        // from its training. We ignore them and only use the text output.
        if (msg.tool_calls && !meta.forceEndTurn && proxyWriteBuffer == null) {
          // Flush any buffered text before switching to tool call
          if (textFlushTimer) { clearTimeout(textFlushTimer); textFlushTimer = null }
          flushTextDelta()
          if (textBlockOpen) {
            res.write(sse('content_block_stop', { type: 'content_block_stop', index: contentIndex }))
            contentIndex++
            textBlockOpen = false
          }

          stopReason = 'tool_use'

          for (const tc of msg.tool_calls) {
            const tcId = tc.id || toolId()
            const name = tc.function?.name || ''
            calledToolNames.push(name)
            // Native API returns arguments as object, not string
            const args = typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments || {})

            res.write(sse('content_block_start', {
              type: 'content_block_start', index: contentIndex,
              content_block: { type: 'tool_use', id: tcId, name, input: {} },
            }))
            res.write(sse('content_block_delta', {
              type: 'content_block_delta', index: contentIndex,
              delta: { type: 'input_json_delta', partial_json: args },
            }))
            res.write(sse('content_block_stop', { type: 'content_block_stop', index: contentIndex }))
            contentIndex++
          }
        }
      }
    }
  } catch (err) {
    log('stream error:', err.message)
  } finally {
    clearInterval(keepAlive)
    if (textFlushTimer) { clearTimeout(textFlushTimer); textFlushTimer = null }
    flushTextDelta()
  }

  // Close open blocks

  // --- Proxy-side file writing ---
  // When proxyWrite is active, the model generated file content as text.
  // We write it to disk and emit a synthetic Edit tool_use so CC tracks it.
  if (proxyWriteBuffer != null && meta.proxyWrite) {
    // Clean up the content: strip code fences, leading preamble
    let fileContent = proxyWriteBuffer
      .replace(/^```(?:markdown|md)?\n?/gm, '')
      .replace(/^```\s*$/gm, '')
      .trim()

    // Remove any preamble before the first # heading
    const headingIdx = fileContent.indexOf('#')
    if (headingIdx > 0 && headingIdx < 200) {
      fileContent = fileContent.slice(headingIdx)
    }

    const { filename, cwd } = meta.proxyWrite
    const lines = fileContent.split('\n').length

    if (cwd && fileContent.length > 100) {
      const filePath = join(cwd, filename)
      try {
        writeFileSync(filePath, fileContent + '\n')
        log(`proxy-write: created ${filePath} (${lines} lines, ${fileContent.length} chars)`)

        // Emit text block confirming what was done. No synthetic tool_use —
        // the file is already on disk. CC sees end_turn and the task completes.
        res.write(sse('content_block_start', {
          type: 'content_block_start', index: contentIndex,
          content_block: { type: 'text', text: '' },
        }))
        res.write(sse('content_block_delta', {
          type: 'content_block_delta', index: contentIndex,
          delta: { type: 'text_delta', text: `Created ${filename} (${lines} lines) with project structure, commands, architecture, and conventions.` },
        }))
        res.write(sse('content_block_stop', { type: 'content_block_stop', index: contentIndex }))
        contentIndex++
      } catch (err) {
        log(`proxy-write failed: ${err.message}`)
        // Fall through to show text to user
        res.write(sse('content_block_start', {
          type: 'content_block_start', index: contentIndex,
          content_block: { type: 'text', text: '' },
        }))
        res.write(sse('content_block_delta', {
          type: 'content_block_delta', index: contentIndex,
          delta: { type: 'text_delta', text: fileContent },
        }))
        res.write(sse('content_block_stop', { type: 'content_block_stop', index: contentIndex }))
      }
    } else {
      // No CWD or content too short — emit as text
      log(`proxy-write skipped: cwd=${cwd}, content=${fileContent.length} chars`)
      res.write(sse('content_block_start', {
        type: 'content_block_start', index: contentIndex,
        content_block: { type: 'text', text: '' },
      }))
      res.write(sse('content_block_delta', {
        type: 'content_block_delta', index: contentIndex,
        delta: { type: 'text_delta', text: fileContent || '(no content generated)' },
      }))
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: contentIndex }))
    }
  } else if (textBlockOpen) {
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: contentIndex }))
  } else if (tcStates.size === 0 && contentIndex === 0) {
    // Ensure there's always at least one text block
    res.write(sse('content_block_start', {
      type: 'content_block_start', index: contentIndex,
      content_block: { type: 'text', text: '' },
    }))
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: contentIndex }))
  }

  res.write(sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  }))
  res.write(sse('message_stop', { type: 'message_stop' }))
  res.end()

  return { prompt_tokens: inputTokens, completion_tokens: outputTokens, stop_reason: stopReason, tool_names: calledToolNames }
}

// ---------------------------------------------------------------------------
// Non-streaming response translation  (Ollama JSON → Anthropic JSON)
// ---------------------------------------------------------------------------

async function handleNonStreaming(upstream, res, requestModel, meta = {}) {
  const text = await upstream.text()
  let oai
  try { oai = JSON.parse(text) } catch {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Bad upstream response' } }))
    return
  }

  const message = oai.message || {}
  const content = []

  // Map thinking → thinking block
  if (message.thinking) {
    content.push({ type: 'thinking', thinking: message.thinking })
  }

  // Map content → text block
  if (message.content) {
    content.push({ type: 'text', text: stripModelControlTokens(message.content) })
  }

  // If neither had content, add an empty text block
  if (content.length === 0 || !content.some(b => b.type === 'text')) {
    content.push({ type: 'text', text: '' })
  }

  if (message.tool_calls && !meta.forceEndTurn) {
    for (const tc of message.tool_calls) {
      // Native API returns arguments as object, not string
      const input = typeof tc.function?.arguments === 'string'
        ? (() => { try { return JSON.parse(tc.function.arguments) } catch { return {} } })()
        : tc.function?.arguments || {}
      content.push({ type: 'tool_use', id: tc.id || toolId(), name: tc.function.name, input })
    }
  }

  const hasTool = content.some(b => b.type === 'tool_use')
  const stop_reason = hasTool ? 'tool_use'
    : oai.done_reason === 'length' ? 'max_tokens'
    : 'end_turn'

  const anthropic = {
    id: msgId(), type: 'message', role: 'assistant', content,
    model: requestModel,
    stop_reason, stop_sequence: null,
    usage: {
      input_tokens:  oai.prompt_eval_count || 0,
      output_tokens: oai.eval_count        || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(anthropic))

  const toolNames = content.filter(b => b.type === 'tool_use').map(b => b.name)

  return {
    prompt_tokens:     oai.prompt_eval_count || 0,
    completion_tokens: oai.eval_count        || 0,
    stop_reason,
    tool_names: toolNames,
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleRequest(req, res) {
  // CORS (shouldn't be needed but just in case)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://localhost:${PORT}`)
  debug(req.method, url.pathname)

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, models: MODEL_MAP, upstream: OLLAMA_URL }))
    return
  }

  // Token counting endpoint — return dummy counts
  if (url.pathname === '/v1/messages/count_tokens' || url.pathname.endsWith('/count_tokens')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ input_tokens: 0 }))
    return
  }

  // Model listing — fetch real models from Ollama and present them
  if (url.pathname === '/v1/models' || url.pathname.endsWith('/models')) {
    try {
      const tagsResp = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) })
      const tags = await tagsResp.json()
      const models = (tags.models || []).map(m => {
        const ctxLen = getModelContextLength(m.name)
        return {
          id: m.name,
          object: 'model',
          created: Math.floor(new Date(m.modified_at || 0).getTime() / 1000),
          owned_by: 'ollama',
          // Real context window from /api/show (capped to NUM_CTX so the CLI
          // doesn't try to send more than the proxy will accept). Consumed by
          // CLI's modelCapabilities → getContextWindowForModel.
          max_input_tokens: Math.min(ctxLen, NUM_CTX),
          // Extra info for display
          display_name: m.name.replace(':latest', ''),
          size_gb: (m.size / 1e9).toFixed(1),
        }
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: models }))
    } catch (err) {
      log('model listing failed:', err.message)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: OLLAMA_MODEL, object: 'model', owned_by: 'ollama' }] }))
    }
    return
  }

  // Only handle POST /v1/messages
  if (req.method !== 'POST' || !url.pathname.endsWith('/messages')) {
    // Return a benign empty response for anything else
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // Extract and validate API key (sent by Claude Code as x-api-key header)
  const rawApiKey = req.headers['x-api-key'] || ''
  const keyInfo = await validateApiKey(rawApiKey)
  if (!keyInfo.valid) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: keyInfo.error || 'Invalid API key' } }))
    return
  }
  const startTime = Date.now()

  // Read body
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const rawBody = Buffer.concat(chunks).toString()

  let body
  try { body = JSON.parse(rawBody) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } }))
    return
  }

  const requestModel = body.model || 'unknown'
  const isStream = !!body.stream
  const { ollamaModel, tier } = routeModel(requestModel)

  log(`→ ${requestModel} → ${ollamaModel} [${tier}] | ${body.messages?.length || 0} msgs | tools=${body.tools?.length || 0} | stream=${isStream}`)

  // Short-circuit CC bootstrap/probe requests — these are lightweight
  // Anthropic model requests (vivus-haiku-*, 1 msg, 0 tools) that CC sends
  // on startup for capability probing. Sending them to Ollama would load
  // the default model, which gets unloaded immediately when the user's
  // chosen model arrives, causing a slow swap. Return a synthetic response.
  const isBootstrapProbe = !knownOllamaModels.has(requestModel)
    && (body.messages?.length || 0) <= 1
    && !body.tools?.length
  if (isBootstrapProbe) {
    log(`  bootstrap probe, returning synthetic response`)
    const id = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
    if (isStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: requestModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }))
      res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ready.' } }))
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
      res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }))
      res.write(sse('message_stop', { type: 'message_stop' }))
      res.end()
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Ready.' }], model: requestModel, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 1 } }))
    }
    return
  }
  if (DEBUG && body.tools?.length) {
    log('  tools:', body.tools.map(t => t.name).join(', '))
    for (const t of body.tools) {
      log(`  tool ${t.name}: params=${Object.keys(t.input_schema?.properties || {}).join(',')}`)
    }
  }
  // Log tool results from CC to see what's happening with permissions
  if (DEBUG && body.messages?.length) {
    for (const msg of body.messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === 'tool_use') {
            log(`  assistant called: ${b.name}(${JSON.stringify(b.input).slice(0, 200)})`)
          }
        }
      }
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === 'tool_result') {
            const content = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => x.text || '').join('') : ''
            log(`  tool_result [${b.is_error ? 'ERROR' : 'ok'}]: ${content.slice(0, 300)}`)
          }
        }
      }
    }
  }

  // Build and send Ollama native request
    const { req: ollamaReq, meta } = buildOllamaRequest(body, ollamaModel)

  // --- Hard circuit-breaker ---
  // Hard circuit-breaker: when the last 4 tool calls were byte-identical,
  // the model is stuck in a true infinite loop. Force end_turn so the
  // user can redirect. Only fires during automated tool rounds — fresh
  // user input always passes through.
  if (meta.circuitBreaker) {
    const lastUserMsg = [...(body.messages || [])].reverse().find(m => m.role === 'user')
    const isToolRound = lastUserMsg && Array.isArray(lastUserMsg.content) &&
      lastUserMsg.content.some(b => b.type === 'tool_result')
    if (isToolRound) {
      log(`circuit-breaker: ${meta.sequenceLoop ? 'SEQUENCE LOOP' : 'STUCK'} on ${meta.stuckCall || 'pattern'} (${meta.loopTotalCalls} total calls) — injecting corrective guidance and continuing`)

      // Build corrective guidance based on what kind of loop was detected.
      // Goal: give the model enough info to self-correct without forcing a hard stop.
      const stuckDesc = meta.stuckCall || 'the same call'
      const loopType = meta.sequenceLoop ? 'sequence of actions' : 'tool call'
      const correction = [
        '',
        '=== LOOP DETECTED — STOP AND RECONSIDER ===',
        `You have repeated the ${loopType} (${stuckDesc}) ${meta.loopTotalCalls || 'multiple'} times with no progress.`,
        'This approach is NOT working. You MUST try something fundamentally different on your next turn.',
        '',
        'Concrete recovery options (pick one):',
        '  1. STOP and ANALYZE: Briefly state in plain text what you were trying to find/do, why it failed, and what the actual evidence shows. Then announce your new plan.',
        '  2. CHANGE THE TOOL: If grep/Bash returns no matches, the term truly is not there. Use Glob to find candidate files, or Read the file directly to see its real contents.',
        '  3. CHANGE THE TARGET: The file/path you keep hitting may be wrong. List the parent directory or search the broader project for the right location.',
        '  4. ASK FOR HELP: If you genuinely cannot make progress, briefly summarize what you tried and ask the user to clarify the goal.',
        '',
        'DO NOT repeat the same call again. DO NOT make a near-identical variation (e.g. piping cat → grep instead of grep → file).',
        'If your next response contains the same call again, the user will see only this notice and lose trust.',
        '==============================================',
      ].join('\n')

      // Inject into the system prompt of the already-built Ollama request.
      const sysIdx = ollamaReq.messages.findIndex(m => m.role === 'system')
      if (sysIdx >= 0) {
        ollamaReq.messages[sysIdx].content += '\n\n' + correction
      } else {
        ollamaReq.messages.unshift({ role: 'system', content: correction })
      }

      // Also annotate the most recent tool result so the model sees the
      // notice exactly where it's deciding what to do next.
      for (let i = ollamaReq.messages.length - 1; i >= 0; i--) {
        const m = ollamaReq.messages[i]
        if (m.role === 'tool') {
          const orig = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
          m.content = `[!! LOOP DETECTED — see system notice. Repeated "${stuckDesc}" with no new info. CHANGE APPROACH. !!]\n\n${orig}`
          break
        }
      }

      // Bump temperature slightly and disable any cached behaviors so the
      // model is more likely to vary its next move.
      if (ollamaReq.options) {
        ollamaReq.options.temperature = Math.max(0.7, (ollamaReq.options.temperature ?? 0) + 0.2)
      }

      // Clear meta flag so we don't double-apply downstream
      meta.circuitBreaker = false
      meta.correctedLoop = true
      meta.stuckCallApplied = stuckDesc
    }
  }

  // Collect extra metrics data from the request
  const originalQuery = extractOriginalQuery(body.messages)
  const latestQuery = extractLatestQuery(body.messages)
  const toolRound = body.messages?.reduce((n, m) =>
    n + (m.role === 'user' && Array.isArray(m.content)
      ? m.content.filter(b => b.type === 'tool_result').length : 0), 0) || 0
  // For query_summary in metrics: use the latest real user text.
  // During tool rounds (no new user text), show what the model last called
  // instead of repeating the original "Hello" over and over.
  // query_summary for metrics:
  // Round 0 (first request): full original query text
  // Round 1+: "[round N] ToolName(target)" describing what the model is doing
  let querySummary
  if (toolRound === 0) {
    querySummary = latestQuery || originalQuery || ''
  } else {
    // Find the last assistant tool_use to describe what's happening
    const lastAssistant = [...(body.messages || [])].reverse().find(m =>
      m.role === 'assistant' && Array.isArray(m.content) &&
      m.content.some(b => b.type === 'tool_use')
    )
    if (lastAssistant) {
      const toolUses = lastAssistant.content.filter(b => b.type === 'tool_use')
      const toolDesc = toolUses.map(t => {
        const arg = t.input?.command?.slice(0, 60) || t.input?.file_path?.slice(0, 60) || t.input?.path?.slice(0, 60) || ''
        return arg ? `${t.name}(${arg})` : t.name
      }).join(', ')
      querySummary = `[round ${toolRound}] ${toolDesc}`
    } else {
      querySummary = `[round ${toolRound}] ${(latestQuery || originalQuery || '').slice(0, 80)}`
    }
  }
  querySummary = querySummary.slice(0, 500)
  debug(`query: "${querySummary}"`)
  const toolsAvailable = ollamaReq.tools?.map(t => t.function?.name).filter(Boolean) || []

  // Create an AbortController so we can cancel the Ollama request if
  // the client disconnects (Ctrl+C). Without this, Ollama keeps
  // generating tokens for a dead connection, wasting GPU/CPU time.
  const abortCtrl = new AbortController()
  let timeoutId = null

  try {
    const ollamaBody = JSON.stringify(ollamaReq)
    log(`ollama: ${ollamaBody.length} bytes, ${ollamaReq.messages?.length} msgs, tools=${ollamaReq.tools?.length || 0}, predict=${ollamaReq.options?.num_predict}`)

    timeoutId = setTimeout(() => abortCtrl.abort(), 600_000)  // 10 min hard timeout
    res.on('close', () => {
      if (!res.writableEnded) {
        log('client disconnected, aborting Ollama request')
        abortCtrl.abort()
      }
    })

    const upstream = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: ollamaBody,
      signal: abortCtrl.signal,
    })

    if (!upstream.ok) {
      const errText = await upstream.text()
      log(`upstream error ${upstream.status}:`, errText.slice(0, 500))
      // Report the error to metrics
      reportMetrics(rawApiKey, ollamaModel, tier, startTime, {}, {
        error: `upstream_${upstream.status}`,
        tool_round: toolRound,
        query_summary: querySummary || null,
        messages_sent: ollamaReq.messages?.length || 0,
        tools_available: toolsAvailable,
      })
      res.writeHead(upstream.status >= 500 ? 529 : upstream.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `Upstream error ${upstream.status}: ${errText.slice(0, 200)}` },
      }))
      return
    }

    let tokens
    if (isStream) {
      tokens = await handleStreaming(upstream, res, requestModel, meta)
    } else {
      tokens = await handleNonStreaming(upstream, res, requestModel, meta)
    }

    // Gather tool names from what the model called this turn
    const toolNames = tokens?.tool_names || []

    // Report usage metrics to portal
    reportMetrics(rawApiKey, ollamaModel, tier, startTime, tokens, {
      stop_reason: tokens?.stop_reason || null,
      tool_names: toolNames.length ? toolNames : null,
      tools_available: toolsAvailable,
      tool_round: toolRound,
      query_summary: querySummary || null,
      messages_sent: ollamaReq.messages?.length || 0,
      prompt_budget_dropped: meta.promptBudgetDropped || 0,
    })
    log(`← done`)
    clearTimeout(timeoutId)
  } catch (err) {
    clearTimeout(timeoutId)
    if (err.name === 'AbortError' && res.destroyed) {
      // Client disconnected — don't try to write a response
      log('request aborted (client disconnect)')
      return
    }
    log('fetch error:', err.message)
    reportMetrics(rawApiKey, ollamaModel, tier, startTime, {}, {
      error: err.message?.slice(0, 200),
      tool_round: toolRound,
      query_summary: querySummary || null,
      messages_sent: ollamaReq.messages?.length || 0,
    })
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }))
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const BIND_HOST = process.env.BIND_HOST || '0.0.0.0'

const server = http.createServer(handleRequest)

// Populate model list BEFORE accepting connections — prevents the first
// request from falling back to the default model because the cache is empty.
refreshModelList()
  .then(() => {
    log(`known models: ${[...knownOllamaModels].join(', ') || '(none)'}`)
  })
  .catch(e => log('model list fetch failed:', e.message))
  .finally(() => {
    server.listen(PORT, BIND_HOST, () => {
      log(`proxy listening on http://${BIND_HOST}:${PORT}`)
      debug(`  upstream: ${OLLAMA_URL}`)
      debug(`  default model: ${OLLAMA_MODEL}`)

      // Refresh model list every 5 minutes
      setInterval(refreshModelList, 5 * 60 * 1000)

      // No model preload — the user picks a model in the CLI picker,
      // and preloading the default would force Ollama to unload it when
      // a different model is selected, causing a slow swap on first use.
    })
  })
