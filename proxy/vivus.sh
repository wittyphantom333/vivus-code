#!/usr/bin/env bash
set -euo pipefail

# Resolve symlinks so DIR always points to the real proxy directory,
# even when invoked via /usr/local/bin/vivus symlink.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$(cd "$(dirname "$SOURCE")" && pwd)"

# Always connect to the remote proxy — local proxy mode is no longer supported.
PROXY_BASE_URL="${VIVUS_PROXY_URL:-https://proxy.vivus.ai}"

# Block Anthropic phone-home traffic (telemetry, bootstrap, grove, etc.)
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export VIVUS_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_TELEMETRY=1
export DISABLE_AUTOUPDATER=1
export DISABLE_FEEDBACK_COMMAND=1
export DISABLE_INSTALLATION_CHECKS=1
export DO_NOT_TRACK=1

# Force full boxed welcome layout (otherwise condensed logo shows when no release notes)
export VIVUS_CODE_FORCE_FULL_LOGO=1

# Sync available models from the remote proxy into the CLI's model picker.
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

# API key is required — get one at https://agent.vivus.ai
if [ -z "${VIVUS_API_KEY:-}" ]; then
  echo "ERROR: VIVUS_API_KEY is not set."
  echo "Get an API key at https://agent.vivus.ai then add to your shell profile:"
  echo "  export VIVUS_API_KEY=\"sk-vivus-...\""
  exit 1
fi

# Run Vivus pointed at the remote proxy
AGENTS_FILE="$DIR/agents.json"
ANTHROPIC_API_KEY="${VIVUS_API_KEY}" \
ANTHROPIC_BASE_URL="${PROXY_BASE_URL}" \
ANTHROPIC_MODEL="${VIVUS_MODEL:-qwen3.6:latest}" \
VIVUS_CODE_SIMPLE=0 \
USE_BUILTIN_RIPGREP=0 \
NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192" \
node "$DIR/../dist/main.js" \
  --bare \
  --permission-mode "acceptEdits" \
  --agents "$(cat "$AGENTS_FILE")" \
  "$@"
