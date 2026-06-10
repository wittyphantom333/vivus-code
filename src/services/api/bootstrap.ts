import axios from 'axios'
import isEqual from 'lodash-es/isEqual.js'
import {
  getAnthropicApiKey,
  getVivusAIOAuthTokens,
  hasProfileScope,
} from 'src/utils/auth'
import { z } from 'zod'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config'
import { logForDebugging } from '../../utils/debug'
import { withOAuth401Retry } from '../../utils/http'
import { lazySchema } from '../../utils/lazySchema'
import { logError } from '../../utils/log'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel'
import { getVivusCodeUserAgent } from '../../utils/userAgent'
import type { ModelOption } from '../../utils/model/modelOptions'
import { lookupProxyModelLabel } from '../../utils/model/proxyModelLabels'

const bootstrapResponseSchema = lazySchema(() =>
  z.object({
    client_data: z.record(z.unknown()).nullish(),
    additional_model_options: z
      .array(
        z
          .object({
            model: z.string(),
            name: z.string(),
            description: z.string(),
          })
          .transform(({ model, name, description }) => ({
            value: model,
            label: name,
            description,
          })),
      )
      .nullish(),
  }),
)

type BootstrapResponse = z.infer<ReturnType<typeof bootstrapResponseSchema>>

async function fetchBootstrapAPI(): Promise<BootstrapResponse | null> {
  if (isEssentialTrafficOnly()) {
    logForDebugging('[Bootstrap] Skipped: Nonessential traffic disabled')
    return null
  }

  if (getAPIProvider() !== 'firstParty') {
    logForDebugging('[Bootstrap] Skipped: 3P provider')
    return null
  }

  // OAuth preferred (requires user:profile scope — service-key OAuth tokens
  // lack it and would 403). Fall back to API key auth for console users.
  const apiKey = getAnthropicApiKey()
  const hasUsableOAuth =
    getVivusAIOAuthTokens()?.accessToken && hasProfileScope()
  if (!hasUsableOAuth && !apiKey) {
    logForDebugging('[Bootstrap] Skipped: no usable OAuth or API key')
    return null
  }

  const endpoint = `${getOauthConfig().BASE_API_URL}/api/vivus_cli/bootstrap`

  // withOAuth401Retry handles the refresh-and-retry. API key users fail
  // through on 401 (no refresh mechanism — no OAuth token to pass).
  try {
    return await withOAuth401Retry(async () => {
      // Re-read OAuth each call so the retry picks up the refreshed token.
      const token = getVivusAIOAuthTokens()?.accessToken
      let authHeaders: Record<string, string>
      if (token && hasProfileScope()) {
        authHeaders = {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        }
      } else if (apiKey) {
        authHeaders = { 'x-api-key': apiKey }
      } else {
        logForDebugging('[Bootstrap] No auth available on retry, aborting')
        return null
      }

      logForDebugging('[Bootstrap] Fetching')
      const response = await axios.get<unknown>(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getVivusCodeUserAgent(),
          ...authHeaders,
        },
        timeout: 5000,
      })
      const parsed = bootstrapResponseSchema().safeParse(response.data)
      if (!parsed.success) {
        logForDebugging(
          `[Bootstrap] Response failed validation: ${parsed.error.message}`,
        )
        return null
      }
      logForDebugging('[Bootstrap] Fetch ok')
      return parsed.data
    })
  } catch (error) {
    logForDebugging(
      `[Bootstrap] Fetch failed: ${axios.isAxiosError(error) ? (error.response?.status ?? error.code) : 'unknown'}`,
    )
    throw error
  }
}

// ---------------------------------------------------------------------------
// Proxy model discovery — when ANTHROPIC_BASE_URL points at a custom proxy
// (our translation proxy at `/v1/models`, or a raw Ollama host at
// `/api/tags`), fetch the live model list so the /model picker mirrors what
// the proxy actually serves.
// ---------------------------------------------------------------------------

function titleCaseModelName(name: string): string {
  const base = name.replace(/:latest$/, '')
  if (!base) return name
  // Split on common separators and capitalize each token; preserve digits/case
  // inside tokens (e.g. "qwen3-coder" → "Qwen3 Coder", "deepseek-r1" → "Deepseek R1").
  return base
    .split(/[-_/:]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

async function fetchProxyModelOptions(): Promise<ModelOption[] | null> {
  if (isFirstPartyAnthropicBaseUrl()) return null
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return null

  // Try `/v1/models` first — this is what our translation proxy exposes
  // (OpenAI-compatible list with `data: [{ id, display_name, size_gb, ... }]`).
  // Fall back to Ollama's native `/api/tags` (`{ models: [{ name, details }] }`)
  // for cases where ANTHROPIC_BASE_URL points directly at a raw Ollama host.
  // Without the `/v1/models` path, hitting `proxy.vivus.ai/api/tags` returns
  // 404 and the picker falls back to the hardcoded Anthropic model list.
  type DiscoveredModel = {
    name: string
    family?: string | null
    parameterSize?: string | null
  }

  const fetchFromV1Models = async (): Promise<DiscoveredModel[] | null> => {
    let url: string
    try {
      // `?refresh=1` tells our translation proxy to bypass its 5-minute
      // model-list cache and re-pull /api/tags from Ollama. Without this,
      // freshly-pulled Ollama models don't appear in the picker until the
      // proxy's next 5-min refresh tick — even after restarting the CLI.
      // Unknown query params are harmless on OpenAI-compatible servers.
      url = new URL('/v1/models?refresh=1', baseUrl).toString()
    } catch {
      return null
    }
    try {
      logForDebugging(`[Bootstrap] Probing proxy model list: ${url}`)
      const response = await axios.get<unknown>(url, { timeout: 5000 })
      const data = response.data as
        | { data?: Array<Record<string, unknown>> }
        | undefined
      const raw = Array.isArray(data?.data) ? data!.data : null
      if (!raw) return null
      return raw
        .map(m => {
          const id = typeof m.id === 'string' ? m.id : null
          if (!id) return null
          return { name: id } as DiscoveredModel
        })
        .filter((m): m is DiscoveredModel => m !== null)
    } catch (error) {
      logForDebugging(
        `[Bootstrap] Proxy /v1/models fetch failed: ${
          axios.isAxiosError(error)
            ? (error.response?.status ?? error.code)
            : 'unknown'
        }`,
      )
      return null
    }
  }

  const fetchFromApiTags = async (): Promise<DiscoveredModel[] | null> => {
    let url: string
    try {
      url = new URL('/api/tags', baseUrl).toString()
    } catch {
      return null
    }
    try {
      logForDebugging(`[Bootstrap] Probing proxy model list: ${url}`)
      const response = await axios.get<unknown>(url, { timeout: 5000 })
      const data = response.data as
        | { models?: Array<Record<string, unknown>> }
        | undefined
      const raw = Array.isArray(data?.models) ? data!.models : null
      if (!raw) return null
      return raw
        .map(m => {
          const name = typeof m.name === 'string' ? m.name : null
          if (!name) return null
          const details = (m.details ?? {}) as Record<string, unknown>
          return {
            name,
            family: typeof details.family === 'string' ? details.family : null,
            parameterSize:
              typeof details.parameter_size === 'string'
                ? details.parameter_size
                : null,
          } as DiscoveredModel
        })
        .filter((m): m is DiscoveredModel => m !== null)
    } catch (error) {
      logForDebugging(
        `[Bootstrap] Proxy /api/tags fetch failed: ${
          axios.isAxiosError(error)
            ? (error.response?.status ?? error.code)
            : 'unknown'
        }`,
      )
      return null
    }
  }

  const models =
    (await fetchFromV1Models()) ?? (await fetchFromApiTags()) ?? []

  if (models.length === 0) {
    logForDebugging('[Bootstrap] Proxy returned empty model list')
    return []
  }

  const options: ModelOption[] = []
  const seen = new Set<string>()
  for (const m of models) {
    if (seen.has(m.name)) continue
    seen.add(m.name)
    const { label, description } = lookupProxyModelLabel(m.name, {
      family: m.family ?? null,
      parameterSize: m.parameterSize ?? null,
    })
    options.push({
      value: m.name,
      label,
      description,
    })
  }
  logForDebugging(
    `[Bootstrap] Proxy model list: ${options.map(o => o.value).join(', ')}`,
  )
  return options
}

/**
 * Fetch bootstrap data from the API and persist to disk cache.
 */
export async function fetchBootstrapData(): Promise<void> {
  try {
    const [response, proxyModels] = await Promise.all([
      fetchBootstrapAPI().catch(() => null),
      fetchProxyModelOptions(),
    ])

    if (!response && !proxyModels) return

    const clientData = response?.client_data ?? null
    // Merge: API-provided extras first, then proxy-discovered models (deduped).
    const apiOptions = response?.additional_model_options ?? []
    const merged: ModelOption[] = [...apiOptions]
    if (proxyModels) {
      for (const opt of proxyModels) {
        if (!merged.some(existing => existing.value === opt.value)) {
          merged.push(opt)
        }
      }
    }

    // Only persist if data actually changed — avoids a config write on every startup.
    const config = getGlobalConfig()
    if (
      isEqual(config.clientDataCache, clientData) &&
      isEqual(config.additionalModelOptionsCache, merged)
    ) {
      logForDebugging('[Bootstrap] Cache unchanged, skipping write')
      return
    }

    logForDebugging('[Bootstrap] Cache updated, persisting to disk')
    saveGlobalConfig(current => ({
      ...current,
      clientDataCache: clientData,
      additionalModelOptionsCache: merged,
    }))
  } catch (error) {
    logError(error)
  }
}
