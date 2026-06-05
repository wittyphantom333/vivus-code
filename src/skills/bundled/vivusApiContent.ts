// Content for the vivus-api bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import csharpVivusApi from './vivus-api/csharp/vivus-api.md'
import curlExamples from './vivus-api/curl/examples.md'
import goVivusApi from './vivus-api/go/vivus-api.md'
import javaVivusApi from './vivus-api/java/vivus-api.md'
import phpVivusApi from './vivus-api/php/vivus-api.md'
import pythonAgentSdkPatterns from './vivus-api/python/agent-sdk/patterns.md'
import pythonAgentSdkReadme from './vivus-api/python/agent-sdk/README.md'
import pythonVivusApiBatches from './vivus-api/python/vivus-api/batches.md'
import pythonVivusApiFilesApi from './vivus-api/python/vivus-api/files-api.md'
import pythonVivusApiReadme from './vivus-api/python/vivus-api/README.md'
import pythonVivusApiStreaming from './vivus-api/python/vivus-api/streaming.md'
import pythonVivusApiToolUse from './vivus-api/python/vivus-api/tool-use.md'
import rubyVivusApi from './vivus-api/ruby/vivus-api.md'
import skillPrompt from './vivus-api/SKILL.md'
import sharedErrorCodes from './vivus-api/shared/error-codes.md'
import sharedLiveSources from './vivus-api/shared/live-sources.md'
import sharedModels from './vivus-api/shared/models.md'
import sharedPromptCaching from './vivus-api/shared/prompt-caching.md'
import sharedToolUseConcepts from './vivus-api/shared/tool-use-concepts.md'
import typescriptAgentSdkPatterns from './vivus-api/typescript/agent-sdk/patterns.md'
import typescriptAgentSdkReadme from './vivus-api/typescript/agent-sdk/README.md'
import typescriptVivusApiBatches from './vivus-api/typescript/vivus-api/batches.md'
import typescriptVivusApiFilesApi from './vivus-api/typescript/vivus-api/files-api.md'
import typescriptVivusApiReadme from './vivus-api/typescript/vivus-api/README.md'
import typescriptVivusApiStreaming from './vivus-api/typescript/vivus-api/streaming.md'
import typescriptVivusApiToolUse from './vivus-api/typescript/vivus-api/tool-use.md'

// @[MODEL LAUNCH]: Update the model IDs/names below. These are substituted into {{VAR}}
// placeholders in the .md files at runtime before the skill prompt is sent.
// After updating these constants, manually update the two files that still hardcode models:
//   - vivus-api/SKILL.md (Current Models pricing table)
//   - vivus-api/shared/models.md (full model catalog with legacy versions and alias mappings)
export const SKILL_MODEL_VARS = {
  OPUS_ID: 'vivus-opus-4-6',
  OPUS_NAME: 'Vivus Opus 4.6',
  SONNET_ID: 'vivus-sonnet-4-6',
  SONNET_NAME: 'Vivus Sonnet 4.6',
  HAIKU_ID: 'vivus-haiku-4-5',
  HAIKU_NAME: 'Vivus Haiku 4.5',
  // Previous Sonnet ID — used in "do not append date suffixes" example in SKILL.md.
  PREV_SONNET_ID: 'vivus-sonnet-4-5',
} satisfies Record<string, string>

export const SKILL_PROMPT: string = skillPrompt

export const SKILL_FILES: Record<string, string> = {
  'csharp/vivus-api.md': csharpVivusApi,
  'curl/examples.md': curlExamples,
  'go/vivus-api.md': goVivusApi,
  'java/vivus-api.md': javaVivusApi,
  'php/vivus-api.md': phpVivusApi,
  'python/agent-sdk/README.md': pythonAgentSdkReadme,
  'python/agent-sdk/patterns.md': pythonAgentSdkPatterns,
  'python/vivus-api/README.md': pythonVivusApiReadme,
  'python/vivus-api/batches.md': pythonVivusApiBatches,
  'python/vivus-api/files-api.md': pythonVivusApiFilesApi,
  'python/vivus-api/streaming.md': pythonVivusApiStreaming,
  'python/vivus-api/tool-use.md': pythonVivusApiToolUse,
  'ruby/vivus-api.md': rubyVivusApi,
  'shared/error-codes.md': sharedErrorCodes,
  'shared/live-sources.md': sharedLiveSources,
  'shared/models.md': sharedModels,
  'shared/prompt-caching.md': sharedPromptCaching,
  'shared/tool-use-concepts.md': sharedToolUseConcepts,
  'typescript/agent-sdk/README.md': typescriptAgentSdkReadme,
  'typescript/agent-sdk/patterns.md': typescriptAgentSdkPatterns,
  'typescript/vivus-api/README.md': typescriptVivusApiReadme,
  'typescript/vivus-api/batches.md': typescriptVivusApiBatches,
  'typescript/vivus-api/files-api.md': typescriptVivusApiFilesApi,
  'typescript/vivus-api/streaming.md': typescriptVivusApiStreaming,
  'typescript/vivus-api/tool-use.md': typescriptVivusApiToolUse,
}
