import { readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import isEqual from 'lodash-es/isEqual.js'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { z } from 'zod/v4'
import { OAUTH_BETA_HEADER } from '../../constants/oauth'
import { getAnthropicClient } from '../../services/api/client'
import { isVivusAISubscriber } from '../auth'
import { logForDebugging } from '../debug'
import { getVivusConfigHomeDir, isEnvTruthy } from '../envUtils'
import { safeParseJSON } from '../json'
import { lazySchema } from '../lazySchema'
import { isEssentialTrafficOnly } from '../privacyLevel'
import { jsonStringify } from '../slowOperations'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers'

// .strip() — don't persist internal-only fields (mycro_deployments etc.) to disk
const ModelCapabilitySchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      max_input_tokens: z.number().optional(),
      max_tokens: z.number().optional(),
    })
    .strip(),
)

const CacheFileSchema = lazySchema(() =>
  z.object({
    models: z.array(ModelCapabilitySchema()),
    timestamp: z.number(),
  }),
)

export type ModelCapability = z.infer<ReturnType<typeof ModelCapabilitySchema>>

function getCacheDir(): string {
  return join(getVivusConfigHomeDir(), 'cache')
}

function getCachePath(): string {
  return join(getCacheDir(), 'model-capabilities.json')
}

function isModelCapabilitiesEligible(): boolean {
  if (process.env.USER_TYPE !== 'ant') return false
  if (getAPIProvider() !== 'firstParty') return false
  if (!isFirstPartyAnthropicBaseUrl()) return false
  return true
}

// True when we should fetch model metadata from the configured base URL's
// /v1/models endpoint (Vivus proxy / OpenAI-compatible servers). Capability
// loading is otherwise restricted to first-party Anthropic — but for any
// custom base URL, the proxy is the source of truth for context windows and
// max output tokens, so we always try to refresh from it.
function isProxyCapabilitiesEligible(): boolean {
  if (isEnvTruthy(process.env.VIVUS_CODE_DISABLE_PROXY_CAPABILITIES)) return false
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return false
  if (isFirstPartyAnthropicBaseUrl()) return false
  try {
    new URL(baseUrl)
    return true
  } catch {
    return false
  }
}

// Longest-id-first so substring match prefers most specific; secondary key for stable isEqual
function sortForMatching(models: ModelCapability[]): ModelCapability[] {
  return [...models].sort(
    (a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id),
  )
}

// Keyed on cache path so tests that set VIVUS_CONFIG_DIR get a fresh read
const loadCache = memoize(
  (path: string): ModelCapability[] | null => {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- memoized; called from sync getContextWindowForModel
      const raw = readFileSync(path, 'utf-8')
      const parsed = CacheFileSchema().safeParse(safeParseJSON(raw, false))
      return parsed.success ? parsed.data.models : null
    } catch {
      return null
    }
  },
  path => path,
)

export function getModelCapability(model: string): ModelCapability | undefined {
  // Eligibility is gated at write time (refreshModelCapabilities); at read
  // time we just trust whatever's in the cache. This lets the proxy populate
  // capabilities for non-firstParty base URLs.
  const cached = loadCache(getCachePath())
  if (!cached || cached.length === 0) return undefined
  const m = model.toLowerCase()
  const exact = cached.find(c => c.id.toLowerCase() === m)
  if (exact) return exact
  return cached.find(c => m.includes(c.id.toLowerCase()))
}

export async function refreshModelCapabilities(): Promise<void> {
  if (isEssentialTrafficOnly()) return
  if (isModelCapabilitiesEligible()) {
    await refreshFromAnthropic()
    return
  }
  if (isProxyCapabilitiesEligible()) {
    await refreshFromProxy()
  }
}

async function refreshFromAnthropic(): Promise<void> {
  try {
    const anthropic = await getAnthropicClient({ maxRetries: 1 })
    const betas = isVivusAISubscriber() ? [OAUTH_BETA_HEADER] : undefined
    const parsed: ModelCapability[] = []
    for await (const entry of anthropic.models.list({ betas })) {
      const result = ModelCapabilitySchema().safeParse(entry)
      if (result.success) parsed.push(result.data)
    }
    if (parsed.length === 0) return
    await writeCache(parsed)
  } catch (error) {
    logForDebugging(
      `[modelCapabilities] anthropic fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }
}

// Vivus proxy /v1/models returns OpenAI-style entries with our extension:
// { id, object, owned_by, max_input_tokens?, ... }
async function refreshFromProxy(): Promise<void> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/v1/models'
    const apiKey = process.env.ANTHROPIC_API_KEY || ''
    const resp = await fetch(url, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) {
      logForDebugging(
        `[modelCapabilities] proxy /v1/models returned ${resp.status}`,
      )
      return
    }
    const body = (await resp.json()) as { data?: unknown[] }
    if (!Array.isArray(body.data)) return
    const parsed: ModelCapability[] = []
    for (const entry of body.data) {
      const result = ModelCapabilitySchema().safeParse(entry)
      if (result.success) parsed.push(result.data)
    }
    if (parsed.length === 0) return
    await writeCache(parsed)
  } catch (error) {
    logForDebugging(
      `[modelCapabilities] proxy fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }
}

async function writeCache(parsed: ModelCapability[]): Promise<void> {
  const path = getCachePath()
  const models = sortForMatching(parsed)
  if (isEqual(loadCache(path), models)) {
    logForDebugging('[modelCapabilities] cache unchanged, skipping write')
    return
  }
  await mkdir(getCacheDir(), { recursive: true })
  await writeFile(path, jsonStringify({ models, timestamp: Date.now() }), {
    encoding: 'utf-8',
    mode: 0o600,
  })
  loadCache.cache.delete(path)
  logForDebugging(`[modelCapabilities] cached ${models.length} models`)
}
