#!/usr/bin/env bun
/**
 * Vivus build script — bundles the TypeScript source into a single cli.js.
 *
 * Uses Bun's bundler with module aliases to replace:
 *   - bun:bundle → our feature-flag shim
 *   - bun:ffi   → our FFI stub
 *
 * Usage: bun run build.ts
 */

import { $ } from 'bun'
import path from 'path'

const ROOT = import.meta.dir

// Single source of truth: the semver lives in package.json. We append a
// build-identifier suffix (short git SHA, with -dirty if there are uncommitted
// changes) so every commit produces a unique runtime version even when the
// semver itself isn't bumped — `vivus --version` always tells you exactly
// which build you're running. Bump package.json.version manually for real
// releases (major/minor/patch); the suffix updates automatically per commit.
const pkg = JSON.parse(await Bun.file(path.join(ROOT, 'package.json')).text()) as { version: string }
const SEMVER = pkg.version
let buildSuffix = ''
try {
  const sha = (await $`git rev-parse --short HEAD`.cwd(ROOT).quiet().text()).trim()
  // `git status --porcelain` is empty iff working tree clean
  const dirty = (await $`git status --porcelain`.cwd(ROOT).quiet().text()).trim().length > 0
  if (sha) buildSuffix = `+${sha}${dirty ? '-dirty' : ''}`
} catch {
  // Not a git checkout (or git missing) — ship without suffix
}
const VIVUS_VERSION = `${SEMVER}${buildSuffix}`
console.log(`Building Vivus CLI v${VIVUS_VERSION}`)

const result = await Bun.build({
  entrypoints: ['./src/main.tsx'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  minify: false,  // Keep readable for now — enable later
  sourcemap: 'none',
  define: {
    'MACRO.VERSION': JSON.stringify(VIVUS_VERSION),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify('https://github.com/wittyphantom333/vivus-code/issues'),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify('file an issue at https://github.com/wittyphantom333/vivus-code/issues'),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(''),
    'MACRO.PACKAGE_URL': JSON.stringify(''),
    'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
  },
  // Replace bun:* imports with our shims
  external: [
    // Node builtins that shouldn't be bundled
    'crypto', 'fs', 'fs/promises', 'path', 'os', 'events', 'util',
    'buffer', 'child_process', 'http', 'https', 'stream', 'net',
    'tty', 'assert', 'readline', 'zlib', 'dns', 'tls', 'url',
    'async_hooks', 'perf_hooks', 'v8', 'process', 'node:net',
    'node:child_process', 'node:fs', 'node:fs/promises', 'node:path',
    'node:os', 'node:events', 'node:util', 'node:buffer', 'node:http',
    'node:https', 'node:stream', 'node:tty', 'node:assert',
    'node:readline', 'node:zlib', 'node:dns', 'node:tls', 'node:url',
    'node:async_hooks', 'node:perf_hooks', 'node:v8', 'node:process',
    'node:crypto',
    // Optional cloud providers (dynamically imported, never needed for proxy)
    '@anthropic-ai/bedrock-sdk',
    '@anthropic-ai/vertex-sdk',
    '@anthropic-ai/foundry-sdk',
    '@anthropic-ai/mcpb',
    '@aws-sdk/client-sts',
    '@aws-sdk/client-bedrock',
    '@aws-sdk/client-bedrock-runtime',
    '@azure/identity',
    'google-auth-library',
    // OpenTelemetry exporters (dynamically imported based on config)
    '@opentelemetry/exporter-logs-otlp-grpc',
    '@opentelemetry/exporter-logs-otlp-http',
    '@opentelemetry/exporter-logs-otlp-proto',
    '@opentelemetry/exporter-metrics-otlp-grpc',
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/exporter-metrics-otlp-proto',
    '@opentelemetry/exporter-trace-otlp-grpc',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-trace-otlp-proto',
    '@opentelemetry/exporter-prometheus',
    // Native addons (CJS require, can't be bundled)
    'modifiers-napi',
    'fflate',
    // sharp is a native module (libvips bindings, platform-specific .node files).
    // Wrapped in dynamic import in src/tools/FileReadTool/imageProcessor.ts and
    // gated behind a fallback path — image features degrade gracefully if the
    // user's platform lacks a prebuilt binary. Declared in optionalDependencies.
    'sharp',
  ],
  plugins: [
    {
      name: 'vivus-shims',
      setup(build) {
        // Redirect bun:bundle → our feature flag shim
        build.onResolve({ filter: /^bun:bundle$/ }, () => ({
          path: path.resolve(ROOT, 'src/shims/bun-bundle.ts'),
        }))
        // Redirect bun:ffi → our FFI stub
        build.onResolve({ filter: /^bun:ffi$/ }, () => ({
          path: path.resolve(ROOT, 'src/shims/bun-ffi.ts'),
        }))
        // Stub out internal Anthropic packages with empty modules
        // These are @ant/* packages not available on npm
        build.onResolve({ filter: /^@ant\// }, (args) => ({
          path: args.path,
          namespace: 'ant-stub',
        }))
        build.onLoad({ filter: /.*/, namespace: 'ant-stub' }, () => ({
          contents: `
            export default null;
            export const __stub = true;
            export const API_RESIZE_PARAMS = {};
            export const BROWSER_TOOLS = [];
            export const DEFAULT_GRANT_FLAGS = {};
            export const bindSessionContext = () => null;
            export const buildComputerUseTools = () => [];
            export const createVivusForChromeMcpServer = () => null;
            export const createClaudeForChromeMcpServer = () => null;
            export const getSentinelCategory = () => null;
            export const targetImageSize = () => ({});
            export const loadComputerUseInput = () => null;
          `,
          loader: 'ts',
        }))
        // Stub color-diff-napi (native addon with ESM static import)
        build.onResolve({ filter: /^color-diff-napi$/ }, (args) => ({
          path: args.path,
          namespace: 'native-stub',
        }))
        build.onLoad({ filter: /.*/, namespace: 'native-stub' }, () => ({
          contents: `export const ColorDiff = null; export const ColorFile = null; export const getSyntaxTheme = () => null; export default null;`,
          loader: 'ts',
        }))
      },
    },
  ],
})

if (!result.success) {
  console.error('Build failed:')
  for (const msg of result.logs) {
    console.error(` ${msg}`)
  }
  process.exit(1)
}

console.log(`Build succeeded: ${result.outputs.length} files`)
for (const output of result.outputs) {
  console.log(`  ${output.path} (${(output.size / 1024).toFixed(0)}KB)`)
}

// Add shebang, version header, and main() invocation
const distPath = './dist/main.js'
const content = await Bun.file(distPath).text()
const header = `#!/usr/bin/env node
// Vivus CLI — local AI coding agent
// Built from source at ${new Date().toISOString()}
`
// The bundled module exports main() but doesn't call it — add self-invocation
const footer = `\n// Auto-invoke main\nmain();\n`
await Bun.write(distPath, header + content + footer)
await $`chmod +x ${distPath}`
console.log('Done.')
