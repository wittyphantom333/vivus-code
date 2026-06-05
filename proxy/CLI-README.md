# Vivus CLI — Local AI Coding Agent

A terminal-based AI coding assistant powered by Ollama models through a remote proxy. Works on **Linux** and **macOS**.

## Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────┐
│  Vivus CLI      │  HTTPS  │  Translation     │  HTTP   │  Ollama │
│  (your machine) │ ──────► │  Proxy           │ ──────► │  (GPU)  │
│  Node.js        │         │  (your URL)      │         │  Models │
└─────────────────┘         └──────────────────┘         └─────────┘
```

The CLI runs locally on your machine. It sends requests to the proxy URL you configure via `VIVUS_PROXY_URL`, which translates them and forwards to Ollama running on the GPU server. No local GPU or Ollama install needed.

## Quick Start

### 1. Extract

```bash
tar xzf vivus-agent-1.0.0-linux-x86_64.tar.gz
cd vivus
```

### 2. Install

```bash
./install.sh
```

This will:
- Verify Node.js 20+ is installed
- Install npm dependencies
- Offer to symlink `vivus` to `/usr/local/bin/`

If you don't have Node.js 20+:
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Or via nvm (no sudo)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20
```

### 3. Run

```bash
vivus
```

Or if not symlinked:
```bash
./vivus
```

## Configuration

All config is via environment variables. Set them in your shell profile (`~/.bashrc`, `~/.zshrc`) for persistence.

| Variable | Default | Description |
|----------|---------|-------------|
| `VIVUS_PROXY_URL` | (required) | Base URL of the inference proxy the CLI talks to |
| `VIVUS_API_KEY`   | (required if proxy enforces auth) | Bearer token sent to the proxy |
| `VIVUS_MODEL`     | `qwen3.6:latest` | Model to use (see available models below) |
| `VIVUS_TELEMETRY` | `1` | Set to `0` to disable all anonymous telemetry |

### Example

```bash
export VIVUS_PROXY_URL="http://your-proxy-host:4089"
export VIVUS_API_KEY="sk-your-key-here"
export VIVUS_MODEL="qwen3-coder-next"
vivus
```

## Available Models

The CLI auto-syncs available models from the proxy on startup. You can also switch models with `/model` inside the CLI.

Current models on the server:

| Model | Size | Best For |
|-------|------|----------|
| `qwen3-coder-next` | ~30B | Coding tasks (default) |
| `qwen3-coder:30b` | 30B | Coding tasks (older version) |
| `qwen3-vl:30b` | 30B | Vision — auto-selected when you paste images |
| `qwen3:32b` | 32B | General purpose |
| `qwen3:8b` | 8B | Fast, lightweight tasks |
| `qwen3.6` | ~32B | General purpose, vision-capable |

## Usage

### Basic

Just type your request:
```
❯ create a Python script that reads a CSV and outputs a summary
```

### Working with files

The CLI can read, edit, and create files in your current directory:
```
❯ read main.py and fix the bug on line 42
```

### Images

Paste or attach an image and the proxy automatically routes to a vision-capable model:
```
❯ what errors do you see in this screenshot [paste image]
```

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Ctrl+C` | Cancel current operation |
| `Ctrl+D` | Exit |
| `Ctrl+O` | Expand/collapse file contents |
| `/model` | Switch model |
| `/help` | Show help |

## Permissions

The CLI runs with `--permission-mode acceptEdits` by default, which means:
- **File reads**: Always allowed
- **File edits**: Auto-accepted (prints what changed)
- **Bash commands**: Asks for confirmation before running
- **File creation**: Auto-accepted

## Troubleshooting

### "Connection refused" or timeout
The proxy at `$VIVUS_PROXY_URL` may be down or unreachable. Check:
```bash
curl -sf "$VIVUS_PROXY_URL/health" | python3 -m json.tool
```

### "Invalid API key"
Set your API key:
```bash
export VIVUS_API_KEY="sk-your-key-here"
```

### Slow responses
Normal response time is 15-90 seconds depending on the request complexity. The model runs on CPU-offloaded hardware. Long responses (large file edits) may take up to 5 minutes.

### Model not found
The model list syncs on startup. If a model was recently added, restart the CLI. You can also check available models:
```bash
curl -sf "$VIVUS_PROXY_URL/v1/models" | python3 -m json.tool
```

### Paste issues over SSH

**Text not pasting as a block**: Your local terminal may not be sending bracketed paste sequences over SSH. Ensure your terminal has bracketed paste enabled:
- **iTerm2**: Preferences → Profiles → Terminal → check "Enable paste bracketing"
- **Windows Terminal / macOS Terminal.app**: Usually enabled by default
- **tmux**: Add `set -g set-clipboard on` to `~/.tmux.conf`
- **Screen**: May strip escape sequences — try tmux instead

**Images don't paste over SSH**: Expected. Remote processes can't access your local clipboard. Instead, copy the image file to the remote machine and reference it by path:
```bash
# Copy image to remote
scp screenshot.png remote-host:~/

# Then in vivus, just ask it to read the file:
❯ look at screenshot.png and tell me what's wrong
```
The CLI auto-detects image files (png, jpg, gif, webp) and sends them as vision input.

### Node.js version too old
```bash
node -v  # must be v20+
```

## File Structure

```
vivus/
├── vivus           # Launcher script — run this
├── install.sh      # One-time setup
├── package.json    # npm dependencies
├── dist/
│   └── main.js     # Bundled CLI (17MB)
└── proxy/
    ├── server.mjs   # Translation proxy (reference, not used in remote mode)
    └── agents.json  # Agent definitions
```

## Updating

To update the CLI, download a new tarball and extract over the existing directory:
```bash
tar xzf vivus-agent-1.0.1-linux-x86_64.tar.gz
cd vivus
npm install --omit=dev
```

## Building from Source

To build the distributable tarball yourself from the source repo:

```bash
cd ts/
./package.sh          # both linux-x86_64 + darwin-arm64
./package.sh linux    # linux only
./package.sh macos    # macOS only
```

This requires **Node.js 20+** and **Bun** (for bundling). It will:
1. Build `dist/main.js` if it doesn't exist (via `bun run build.ts`)
2. Assemble the launcher, install script, and stripped `package.json`
3. Output `vivus-agent-<version>-<platform>.tar.gz` (~4MB each)

The CLI is pure Node.js — tarballs are platform-named but identical in content. Works on any machine with Node.js 20+.

## Self-Hosting the Proxy

To run your own proxy + Ollama:

1. Install Ollama and pull models on your GPU server
2. Deploy the proxy: copy `proxy/server.mjs` to the server, run with Node.js
3. Point the CLI at your proxy:
   ```bash
   export VIVUS_PROXY_URL="http://your-server:4089"
   vivus
   ```

See `proxy/deploy.sh` in the source repo for full server setup automation.
