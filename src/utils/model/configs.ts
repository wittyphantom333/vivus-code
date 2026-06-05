import type { ModelName } from './model'
import type { APIProvider } from './providers'

export type ModelConfig = Record<APIProvider, ModelName>

// @[MODEL LAUNCH]: Add a new VIVUS_*_CONFIG constant here. Double check the correct model strings
// here since the pattern may change.

export const VIVUS_3_7_SONNET_CONFIG = {
  firstParty: 'claude-3-7-sonnet-20250219',
  bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  vertex: 'claude-3-7-sonnet@20250219',
  foundry: 'claude-3-7-sonnet',
} as const satisfies ModelConfig

export const VIVUS_3_5_V2_SONNET_CONFIG = {
  firstParty: 'claude-3-5-sonnet-20241022',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  vertex: 'claude-3-5-sonnet-v2@20241022',
  foundry: 'claude-3-5-sonnet',
} as const satisfies ModelConfig

export const VIVUS_3_5_HAIKU_CONFIG = {
  firstParty: 'claude-3-5-haiku-20241022',
  bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
  vertex: 'claude-3-5-haiku@20241022',
  foundry: 'claude-3-5-haiku',
} as const satisfies ModelConfig

export const VIVUS_HAIKU_4_5_CONFIG = {
  firstParty: 'vivus-haiku-4-5-20251001',
  bedrock: 'us.anthropic.vivus-haiku-4-5-20251001-v1:0',
  vertex: 'vivus-haiku-4-5@20251001',
  foundry: 'vivus-haiku-4-5',
} as const satisfies ModelConfig

export const VIVUS_SONNET_4_CONFIG = {
  firstParty: 'vivus-sonnet-4-20250514',
  bedrock: 'us.anthropic.vivus-sonnet-4-20250514-v1:0',
  vertex: 'vivus-sonnet-4@20250514',
  foundry: 'vivus-sonnet-4',
} as const satisfies ModelConfig

export const VIVUS_SONNET_4_5_CONFIG = {
  firstParty: 'vivus-sonnet-4-5-20250929',
  bedrock: 'us.anthropic.vivus-sonnet-4-5-20250929-v1:0',
  vertex: 'vivus-sonnet-4-5@20250929',
  foundry: 'vivus-sonnet-4-5',
} as const satisfies ModelConfig

export const VIVUS_OPUS_4_CONFIG = {
  firstParty: 'vivus-opus-4-20250514',
  bedrock: 'us.anthropic.vivus-opus-4-20250514-v1:0',
  vertex: 'vivus-opus-4@20250514',
  foundry: 'vivus-opus-4',
} as const satisfies ModelConfig

export const VIVUS_OPUS_4_1_CONFIG = {
  firstParty: 'vivus-opus-4-1-20250805',
  bedrock: 'us.anthropic.vivus-opus-4-1-20250805-v1:0',
  vertex: 'vivus-opus-4-1@20250805',
  foundry: 'vivus-opus-4-1',
} as const satisfies ModelConfig

export const VIVUS_OPUS_4_5_CONFIG = {
  firstParty: 'vivus-opus-4-5-20251101',
  bedrock: 'us.anthropic.vivus-opus-4-5-20251101-v1:0',
  vertex: 'vivus-opus-4-5@20251101',
  foundry: 'vivus-opus-4-5',
} as const satisfies ModelConfig

export const VIVUS_OPUS_4_6_CONFIG = {
  firstParty: 'vivus-opus-4-6',
  bedrock: 'us.anthropic.vivus-opus-4-6-v1',
  vertex: 'vivus-opus-4-6',
  foundry: 'vivus-opus-4-6',
} as const satisfies ModelConfig

export const VIVUS_SONNET_4_6_CONFIG = {
  firstParty: 'vivus-sonnet-4-6',
  bedrock: 'us.anthropic.vivus-sonnet-4-6',
  vertex: 'vivus-sonnet-4-6',
  foundry: 'vivus-sonnet-4-6',
} as const satisfies ModelConfig

// @[MODEL LAUNCH]: Register the new config here.
export const ALL_MODEL_CONFIGS = {
  haiku35: VIVUS_3_5_HAIKU_CONFIG,
  haiku45: VIVUS_HAIKU_4_5_CONFIG,
  sonnet35: VIVUS_3_5_V2_SONNET_CONFIG,
  sonnet37: VIVUS_3_7_SONNET_CONFIG,
  sonnet40: VIVUS_SONNET_4_CONFIG,
  sonnet45: VIVUS_SONNET_4_5_CONFIG,
  sonnet46: VIVUS_SONNET_4_6_CONFIG,
  opus40: VIVUS_OPUS_4_CONFIG,
  opus41: VIVUS_OPUS_4_1_CONFIG,
  opus45: VIVUS_OPUS_4_5_CONFIG,
  opus46: VIVUS_OPUS_4_6_CONFIG,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** Union of all canonical first-party model IDs, e.g. 'vivus-opus-4-6' | 'vivus-sonnet-4-5-20250929' | … */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  c => c.firstParty,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, cfg]) => [cfg.firstParty, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>
