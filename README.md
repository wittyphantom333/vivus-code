# vivus-agent

> Local-first AI coding agent for the terminal.

`vivus` is a single-binary CLI that drops an AI pair-programmer into your terminal. It edits files, runs commands, reads diffs, and reasons about your codebase, while keeping you in the loop with explicit tool-call approvals.

The published bundle is **fully self-contained** — `npm install -g vivus-agent` pulls a single ~19 MB JavaScript file. No transitive dependency tree, no native build step, no post-install scripts.

---

## Install

```bash
npm install -g vivus-agent
```

Requires **Node.js ≥ 20**. Then start it from any project directory:

```bash
vivus
```

---

## Configuration

`vivus` talks to a model backend through a proxy you control. **No backend URL is hardcoded as a default in this README** — you point the CLI at whatever endpoint you trust (a local Ollama via a small adapter, a self-hosted proxy, or a managed one).

| Env var | Purpose |
|---|---|
| `VIVUS_PROXY_URL` | Base URL of the inference proxy the CLI talks to. **Required.** |
| `VIVUS_API_KEY`   | Bearer token sent to the proxy. Required if your proxy enforces auth. |
| `VIVUS_TELEMETRY` | Set to `0` to disable all anonymous telemetry. |
| `VIVUS_LOG_LEVEL` | `error` / `warn` / `info` / `debug`. Default `info`. |

Example:

```bash
export VIVUS_PROXY_URL="http://localhost:4089"
export VIVUS_API_KEY="sk-..."
export VIVUS_TELEMETRY=0
vivus
```

You can also persist settings per project in `.vivus.json` at the repo root, or machine-locally in `.vivus/settings.local.json` (which should be `.gitignore`d).

---

## Trust boundary

Be aware of what `vivus` talks to and with what credentials:

- The CLI **only** sends traffic to the URL in `VIVUS_PROXY_URL`. There is no fallback host.
- The CLI never uploads source files unless you explicitly run a tool that does so (e.g. asking the agent to attach a file).
- Tool execution (shell, file writes, network calls) goes through an approval prompt unless you have opted into auto-approval for that tool in `.vivus.json`.
- Telemetry, when enabled, sends anonymous usage counters only — never file contents, prompts, or completions. Set `VIVUS_TELEMETRY=0` to turn it off entirely.

If you self-host the proxy, treat `VIVUS_API_KEY` like any other production credential.

---

## Verify what you installed

The version string includes the exact git commit it was built from:

```bash
$ vivus --version
1.0.1+a1b2c3d (Vivus)
```

A `-dirty` suffix means the build had uncommitted changes — published releases will never carry that suffix.

---

## License

[MIT](./LICENSE) © Witt
