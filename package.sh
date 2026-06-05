#!/usr/bin/env bash
set -euo pipefail

# Package Vivus CLI into distributable tarballs.
# The CLI is pure Node.js — tarballs for all platforms are built from one source.
#
# Usage: ./package.sh            # builds linux-x86_64 + darwin-arm64
#        ./package.sh linux      # builds linux-x86_64 only
#        ./package.sh macos      # builds darwin-arm64 only
#
# Output: vivus-agent-<version>-<platform>.tar.gz
#
# Prerequisites: Node.js 20+, bun (for building)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Single source of truth: package.json. Bump it (npm version patch / minor /
# major) to cut a release; this script and ts/build.ts both read from it.
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || \
           python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
if [[ -z "$VERSION" ]]; then
  echo "package.sh: could not read version from package.json" >&2
  exit 1
fi

# Platform targets (content is identical — pure Node.js)
ALL_PLATFORMS=("linux-x86_64" "darwin-arm64")

case "${1:-all}" in
  linux)  PLATFORMS=("linux-x86_64") ;;
  macos)  PLATFORMS=("darwin-arm64") ;;
  all)    PLATFORMS=("${ALL_PLATFORMS[@]}") ;;
  *)      echo "Usage: $0 [linux|macos|all]"; exit 1 ;;
esac

PKG_DIR="$(mktemp -d)/vivus"

echo "==> Packaging Vivus CLI v${VERSION} for: ${PLATFORMS[*]}"

# --- Build the CLI bundle ---
if [ ! -f dist/main.js ]; then
  echo "==> Building CLI..."
  bun run build.ts
fi

echo "==> Assembling package in ${PKG_DIR}"
mkdir -p "${PKG_DIR}/dist" "${PKG_DIR}/proxy"

# Core files
cp dist/main.js "${PKG_DIR}/dist/"
cp proxy/server.mjs "${PKG_DIR}/proxy/"
cp proxy/agents.json "${PKG_DIR}/proxy/"

# --- Launcher script (self-contained, VIVUS_REMOTE=1 by default) ---
cat > "${PKG_DIR}/vivus" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

# Resolve real directory (works through symlinks)
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$(cd "$(dirname "$SOURCE")" && pwd)"

# Remote proxy — no local Ollama needed
PROXY_BASE_URL="${VIVUS_PROXY_URL:-https://proxy.vivus.ai}"

# Block Anthropic phone-home traffic
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export VIVUS_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_TELEMETRY=1
export DISABLE_AUTOUPDATER=1
export DISABLE_FEEDBACK_COMMAND=1
export DISABLE_INSTALLATION_CHECKS=1
export DO_NOT_TRACK=1
export VIVUS_CODE_FORCE_FULL_LOGO=1

# Sync models from remote proxy into the CLI's model picker
_sync_models() {
  local models_json
  models_json=$(curl -sf --max-time 3 "${PROXY_BASE_URL}/v1/models" 2>/dev/null) || return 0
  python3 -c "
import json, sys, os
data = json.loads(sys.argv[1])
models = data.get('data', [])
if not models:
    sys.exit(0)
config_path = os.path.expanduser('~/.vivus.json')
try:
    with open(config_path) as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}
config['additionalModelOptionsCache'] = [
    {
        'value': m['id'].replace(':latest',''),
        'label': m.get('display_name', m['id']) + ' (' + m.get('size_gb','?') + 'GB)',
        'description': m['id']
    }
    for m in models
]
with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)
" "$models_json" 2>/dev/null
}
_sync_models &

# API key — must be set by the user (get one at https://agent.vivus.ai)
if [ -z "${VIVUS_API_KEY:-}" ]; then
  echo "ERROR: VIVUS_API_KEY is not set."
  echo "Get an API key at https://agent.vivus.ai and then run:"
  echo "  export VIVUS_API_KEY=\"sk-vivus-your-key-here\""
  exit 1
fi

ANTHROPIC_API_KEY="${VIVUS_API_KEY}" \
ANTHROPIC_BASE_URL="${PROXY_BASE_URL}" \
ANTHROPIC_MODEL="${VIVUS_MODEL:-qwen3.6:latest}" \
node "${DIR}/dist/main.js" \
  --bare \
  --permission-mode "acceptEdits" \
  --agents "$(cat "${DIR}/proxy/agents.json")" \
  "$@"
LAUNCHER
chmod +x "${PKG_DIR}/vivus"

# --- Install script ---
cat > "${PKG_DIR}/install.sh" <<'INSTALL'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Installing Vivus CLI"

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js 20+ is required. Install from https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -v | grep -oE '[0-9]+' | head -1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node.js 20+ required (found $(node -v))"
  exit 1
fi
echo "    Node.js $(node -v) ✓"

# Install node_modules
echo "==> Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3

# Symlink to PATH
LINK_TARGET="/usr/local/bin/vivus"
if [ -w "/usr/local/bin" ] || [ "$(id -u)" -eq 0 ]; then
  ln -sf "${SCRIPT_DIR}/vivus" "$LINK_TARGET"
  echo "==> Installed: vivus → ${LINK_TARGET}"
else
  echo ""
  echo "To add vivus to your PATH, run:"
  echo "  sudo ln -sf '${SCRIPT_DIR}/vivus' /usr/local/bin/vivus"
  echo "Or add this to your shell profile:"
  echo "  export PATH=\"${SCRIPT_DIR}:\$PATH\""
fi

echo ""
echo "==> Done! Run 'vivus' to start."
echo "    Set VIVUS_API_KEY for authentication."
echo "    Set VIVUS_MODEL to choose a model (default: qwen3.6:latest)"
INSTALL
chmod +x "${PKG_DIR}/install.sh"

# --- package.json for npm install (prod deps only) ---
# Copy package.json but strip devDependencies and build scripts
python3 -c "
import json
with open('package.json') as f:
    d = json.load(f)
d.pop('devDependencies', None)
d.pop('scripts', None)
d['name'] = 'vivus-agent'
d['version'] = '${VERSION}'
with open('${PKG_DIR}/package.json', 'w') as f:
    json.dump(d, f, indent=2)
"

# Copy lockfile for reproducible installs
if [ -f bun.lockb ]; then
  cp bun.lockb "${PKG_DIR}/"
fi
if [ -f package-lock.json ]; then
  cp package-lock.json "${PKG_DIR}/"
fi

# --- README ---
cp "${SCRIPT_DIR}/proxy/CLI-README.md" "${PKG_DIR}/README.md"

# --- Build tarballs ---
echo ""
for PLATFORM in "${PLATFORMS[@]}"; do
  PKG_NAME="vivus-agent-${VERSION}-${PLATFORM}"
  TARBALL="${SCRIPT_DIR}/${PKG_NAME}.tar.gz"
  echo "==> Creating ${PKG_NAME}.tar.gz..."
  tar -C "$(dirname "${PKG_DIR}")" -czf "$TARBALL" vivus
  SIZE=$(du -h "$TARBALL" | cut -f1)
  echo "    ${TARBALL} (${SIZE})"
done

echo ""
echo "==> Packages ready:"
for PLATFORM in "${PLATFORMS[@]}"; do
  PKG_NAME="vivus-agent-${VERSION}-${PLATFORM}"
  echo "    ${PKG_NAME}.tar.gz"
done
echo ""
echo "    Extract:  tar xzf vivus-agent-${VERSION}-<platform>.tar.gz"
echo "    Install:  cd vivus && ./install.sh"
echo "    Run:      ./vivus"

# Cleanup
rm -rf "$(dirname "${PKG_DIR}")"
