/**
 * bun:bundle shim — replaces Bun's compile-time feature flag system.
 *
 * In the original Vivus build:
 *   import { feature } from 'bun:bundle'
 *   if (feature('COORDINATOR_MODE')) { ... }
 *
 * Bun's bundler constant-folds these at compile time and dead-code-eliminates
 * the gated branches. Since we're building outside Anthropic's build system,
 * we replace this with a simple runtime lookup.
 *
 * Enable features below as needed — everything defaults to false (external build).
 */

const FEATURES: Record<string, boolean> = {
  // ---- Features we WANT enabled for Vivus ----
  CONTEXT_COLLAPSE: true,        // Better context management
  CACHED_MICROCOMPACT: true,     // Compaction with prompt caching
  HISTORY_SNIP: true,            // History snippet module
  TOKEN_BUDGET: true,            // Token budget tracking
  TRANSCRIPT_CLASSIFIER: true,   // Auto-mode permission classifier
  BASH_CLASSIFIER: true,         // Bash command risk classification
  VERIFICATION_AGENT: true,      // Agent verification logic
  TEMPLATES: true,               // Template-based generation
  EXTRACT_MEMORIES: true,        // Memory extraction
  REACTIVE_COMPACT: true,        // Compact rendering
  CONNECTOR_TEXT: true,           // Connector text blocks
  EXPERIMENTAL_SKILL_SEARCH: true,
  WEB_BROWSER_TOOL: false,       // Needs Bun WebView API
  NEW_INIT: true,

  // ---- Disabled: Anthropic-internal or needs infra ----
  COORDINATOR_MODE: false,       // Enable later when stable
  KAIROS: false,                 // Always-on assistant — needs backend
  KAIROS_CHANNELS: false,
  KAIROS_BRIEF: false,
  KAIROS_PUSH_NOTIFICATION: false,
  KAIROS_GITHUB_WEBHOOKS: false,
  PROACTIVE: false,
  BUDDY: false,                  // Tamagotchi — fun but not priority
  VOICE_MODE: false,             // Needs audio stack
  BRIDGE_MODE: false,            // Needs vivus.ai integration
  DIRECT_CONNECT: false,
  SSH_REMOTE: false,
  BG_SESSIONS: false,
  AGENT_TRIGGERS: false,
  AGENT_TRIGGERS_REMOTE: false,
  AGENT_MEMORY_SNAPSHOT: false,
  MONITOR_TOOL: false,
  CHICAGO_MCP: false,            // Computer use — needs @ant package
  DAEMON: false,
  UDS_INBOX: false,
  WORKFLOW_SCRIPTS: false,
  FORK_SUBAGENT: false,
  TEAMMEM: false,
  TREE_SITTER_BASH_SHADOW: false,
  DOWNLOAD_USER_SETTINGS: false,
  UPLOAD_USER_SETTINGS: false,
  NATIVE_CLIENT_ATTESTATION: false,
  BYOC_ENVIRONMENT_RUNNER: false,
  SELF_HOSTED_RUNNER: false,
  LODESTONE: false,
  CCR_MIRROR: false,
  COMMIT_ATTRIBUTION: false,
  ANTI_DISTILLATION_CC: false,
  ABLATION_BASELINE: false,
  DUMP_SYSTEM_PROMPT: false,
  HARD_FAIL: false,
  BREAK_CACHE_COMMAND: false,
  PROMPT_CACHE_BREAK_DETECTION: false,
  MEMORY_SHAPE_TELEMETRY: false,
  COWORKER_TYPE_TELEMETRY: false,
}

export function feature(name: string): boolean {
  return FEATURES[name] ?? false
}
