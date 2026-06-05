#!/usr/bin/env bash
set -euo pipefail

# deploy-cli.sh — Deploy the Vivus CLI to any Linux server over SSH.
#
# Usage:
#   ./deploy-cli.sh --host user@server [options]
#   ./deploy-cli.sh --config path/to/deploy.conf
#
# Options (override config file):
#   --host HOST              SSH target, e.g. user@1.2.3.4         (required)
#   --remote-dir PATH        Remote install dir (default: ~/vivus-cli)
#   --proxy-url URL          Proxy base URL  (default: https://proxy.vivus.ai)
#   --bin-name NAME          Launcher name   (default: vivus)
#   --symlink                sudo ln -sf to /usr/local/bin/<bin-name>
#   --with-node              Install Node 20 via nvm on remote if missing
#   --build                  Run `bun run build.ts` before deploy
#   --skip-launcher          Only sync dist/main.js (faster repeat deploys)
#   --ssh-opts "STR"         Extra ssh options, e.g. "-p 2222 -i ~/.ssh/id"
#   --dry-run                Print what would happen without doing it
#   -h, --help               Show this help
#
# Config file format (KEY=VALUE, shell-sourced):
#   HOST=user@server
#   REMOTE_DIR=/opt/vivus-cli
#   PROXY_URL=https://proxy.example.com
#   BIN_NAME=vivus
#   SYMLINK=true
#   SSH_OPTS="-p 2222"
#
# Example:
#   ./deploy-cli.sh --host root@45.59.162.173 --symlink
#   ./deploy-cli.sh --config customers/acme.conf --build

# -----------------------------------------------------------------------------
# Defaults
# -----------------------------------------------------------------------------
HOST=""
REMOTE_DIR="~/vivus-cli"
PROXY_URL="https://proxy.vivus.ai"
BIN_NAME="vivus"
SYMLINK=false
WITH_NODE=false
BUILD=false
SKIP_LAUNCHER=false
SSH_OPTS=""
DRY_RUN=false
CONFIG_FILE=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="${SCRIPT_DIR}/dist/main.js"
AGENTS="${SCRIPT_DIR}/proxy/agents.json"

# -----------------------------------------------------------------------------
# Parse args
# -----------------------------------------------------------------------------
print_help() { sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)          HOST="$2"; shift 2 ;;
    --remote-dir)    REMOTE_DIR="$2"; shift 2 ;;
    --proxy-url)     PROXY_URL="$2"; shift 2 ;;
    --bin-name)      BIN_NAME="$2"; shift 2 ;;
    --symlink)       SYMLINK=true; shift ;;
    --with-node)     WITH_NODE=true; shift ;;
    --build)         BUILD=true; shift ;;
    --skip-launcher) SKIP_LAUNCHER=true; shift ;;
    --ssh-opts)      SSH_OPTS="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=true; shift ;;
    --config)        CONFIG_FILE="$2"; shift 2 ;;
    -h|--help)       print_help ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Config file overlays defaults; CLI args take precedence by being applied
# AFTER (re-parsing). Simpler model: source config first, then re-apply CLI
# args. Since we already parsed CLI args above, source config only for keys
# the user didn't override.
if [[ -n "$CONFIG_FILE" ]]; then
  [[ -f "$CONFIG_FILE" ]] || { echo "config not found: $CONFIG_FILE" >&2; exit 1; }
  # shellcheck disable=SC1090
  # Track which were CLI-set so we don't clobber them
  CLI_HOST="$HOST"
  CLI_REMOTE_DIR_SET=false
  CLI_PROXY_URL_SET=false
  CLI_BIN_NAME_SET=false
  [[ "$REMOTE_DIR" != "~/vivus-cli" ]]            && CLI_REMOTE_DIR_SET=true
  [[ "$PROXY_URL" != "https://proxy.vivus.ai" ]]  && CLI_PROXY_URL_SET=true
  [[ "$BIN_NAME"  != "vivus" ]]                   && CLI_BIN_NAME_SET=true

  source "$CONFIG_FILE"

  [[ -n "$CLI_HOST" ]]            && HOST="$CLI_HOST"
  $CLI_REMOTE_DIR_SET             && REMOTE_DIR="$REMOTE_DIR"   # no-op; CLI value stays
  $CLI_PROXY_URL_SET              || PROXY_URL="${PROXY_URL}"
fi

# -----------------------------------------------------------------------------
# Validate
# -----------------------------------------------------------------------------
if [[ -z "$HOST" ]]; then
  echo "ERROR: --host required (or HOST= in config)" >&2
  exit 2
fi

if $BUILD; then
  echo "==> Building bundle"
  (cd "$SCRIPT_DIR" && bun run build.ts)
fi

if [[ ! -f "$DIST" ]]; then
  echo "ERROR: $DIST not found. Run with --build or run \`bun run build.ts\` first." >&2
  exit 1
fi
if [[ ! -f "$AGENTS" ]]; then
  echo "ERROR: $AGENTS not found." >&2
  exit 1
fi

SSH=(ssh)
SCP=(scp)
if [[ -n "$SSH_OPTS" ]]; then
  # shellcheck disable=SC2206
  EXTRA=( $SSH_OPTS )
  SSH+=( "${EXTRA[@]}" )
  SCP+=( "${EXTRA[@]}" )
fi

# -----------------------------------------------------------------------------
# Connection multiplexing — all ssh/scp calls share a single TCP connection.
# Without this we open 5+ separate SSH sessions and trip fail2ban / per-IP
# rate limits on hardened servers.
# -----------------------------------------------------------------------------
CTRL_SOCK="$(mktemp -u -t vivus-deploy-XXXXXX).sock"
MUX_OPTS=(
  -o "ControlMaster=auto"
  -o "ControlPath=$CTRL_SOCK"
  -o "ControlPersist=60"
)
SSH+=( "${MUX_OPTS[@]}" )
SCP+=( "${MUX_OPTS[@]}" )

cleanup_mux() {
  if [[ -S "$CTRL_SOCK" ]]; then
    ssh -o "ControlPath=$CTRL_SOCK" -O exit "$HOST" 2>/dev/null || true
    rm -f "$CTRL_SOCK"
  fi
  [[ -n "${TMP_LAUNCHER:-}" && -f "$TMP_LAUNCHER" ]] && rm -f "$TMP_LAUNCHER"
}
trap cleanup_mux EXIT INT TERM

run() {
  if $DRY_RUN; then echo "[dry-run]" "$@"; else "$@"; fi
}

# Resolve ~ on the remote by leaving it in the path passed to the shell.
REMOTE_DIST_DIR="${REMOTE_DIR}/dist"
REMOTE_BIN_DIR="${REMOTE_DIR}/bin"

echo "==> Target:     $HOST"
echo "    Remote dir: $REMOTE_DIR"
echo "    Proxy URL:  $PROXY_URL"
echo "    Bin name:   $BIN_NAME"
echo "    Symlink:    $SYMLINK"
$DRY_RUN && echo "    (dry-run)"
echo ""

# -----------------------------------------------------------------------------
# Preflight: check ssh + node on remote (optionally install node)
# -----------------------------------------------------------------------------
echo "==> SSH preflight"
if $WITH_NODE; then
  # Install Node 20 via nvm if `node` is not on PATH. nvm is per-user, no sudo.
  # The launcher uses #!/usr/bin/env bash + `node` from PATH, so we also drop
  # an nvm-sourcing shim into ~/.bashrc / ~/.profile if not already present.
  run "${SSH[@]}" "$HOST" bash -s <<'NODE_BOOT'
set -euo pipefail
# Source nvm if already installed
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true

if command -v node >/dev/null 2>&1; then
  echo "node already present: $(node --version)"
  exit 0
fi

echo "node not found — installing via nvm..."
if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl not available on remote; install curl first." >&2
  exit 1
fi
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 20 >/dev/null
nvm alias default 20 >/dev/null
echo "installed: $(node --version)"

# Ensure non-login shells also pick up nvm (so launcher invocations work)
for rc in "$HOME/.bashrc" "$HOME/.profile"; do
  if [ -f "$rc" ] && ! grep -q 'NVM_DIR' "$rc"; then
    {
      echo ''
      echo '# Added by vivus deploy-cli.sh'
      echo 'export NVM_DIR="$HOME/.nvm"'
      echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
    } >> "$rc"
  fi
done
NODE_BOOT
else
  run "${SSH[@]}" "$HOST" 'command -v node >/dev/null 2>&1 || { export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; }; command -v node >/dev/null || { echo "ERROR: node not installed on remote (use --with-node to auto-install)"; exit 1; }; node --version'
fi

# -----------------------------------------------------------------------------
# Create remote layout
# -----------------------------------------------------------------------------
echo "==> Creating remote directories"
run "${SSH[@]}" "$HOST" "mkdir -p $REMOTE_DIST_DIR $REMOTE_BIN_DIR"

# -----------------------------------------------------------------------------
# Sync bundle + agents.json
# -----------------------------------------------------------------------------
echo "==> Uploading dist/main.js ($(du -h "$DIST" | cut -f1))"
run "${SCP[@]}" -q "$DIST" "$HOST:$REMOTE_DIST_DIR/main.js"

if ! $SKIP_LAUNCHER; then
  echo "==> Uploading agents.json"
  run "${SCP[@]}" -q "$AGENTS" "$HOST:$REMOTE_BIN_DIR/agents.json"

  # ---------------------------------------------------------------------------
  # Render and upload launcher
  # ---------------------------------------------------------------------------
  echo "==> Rendering launcher → $REMOTE_BIN_DIR/$BIN_NAME"
  TMP_LAUNCHER="$(mktemp)"
  cat > "$TMP_LAUNCHER" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail

# Vivus CLI launcher (deployed by deploy-cli.sh)
SOURCE="\${BASH_SOURCE[0]}"
while [ -L "\$SOURCE" ]; do
  DIR="\$(cd "\$(dirname "\$SOURCE")" && pwd)"
  SOURCE="\$(readlink "\$SOURCE")"
  [[ "\$SOURCE" != /* ]] && SOURCE="\$DIR/\$SOURCE"
done
DIR="\$(cd "\$(dirname "\$SOURCE")" && pwd)"

# If node is provided via nvm, source it so non-interactive shells find node
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
  [ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi

PROXY_BASE_URL="\${VIVUS_PROXY_URL:-${PROXY_URL}}"

# Sync available models from the proxy into the CLI's model picker.
# Populates ~/.vivus.json additionalModelOptionsCache. Best-effort; failures
# (no curl, no python3, proxy down) are silent and don't block startup.
_sync_models() {
  command -v curl >/dev/null 2>&1 || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  local models_json
  models_json=\$(curl -sf --max-time 3 "\${PROXY_BASE_URL}/v1/models" 2>/dev/null) || return 0
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
        'description': m['id'],
    }
    for m in models
]
with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)
" "\$models_json" 2>/dev/null
}
_sync_models &

# Block Anthropic phone-home traffic
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export VIVUS_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_TELEMETRY=1
export DISABLE_AUTOUPDATER=1
export DISABLE_FEEDBACK_COMMAND=1
export DISABLE_INSTALLATION_CHECKS=1
export DO_NOT_TRACK=1
export VIVUS_CODE_FORCE_FULL_LOGO=1

if [ -z "\${VIVUS_API_KEY:-}" ]; then
  echo "ERROR: VIVUS_API_KEY is not set."
  echo "Add to your shell profile: export VIVUS_API_KEY=\"sk-vivus-...\""
  exit 1
fi

AGENTS_FILE="\$DIR/agents.json"

# Size the Node old-space heap from available system memory rather than a fixed
# 8GB cap. On a small VPS the fixed cap was bigger than the box could service,
# so long sessions were getting killed by the kernel OOM-reaper (the launcher
# saw "Killed" with no signal info). Target ~60% of total RAM, clamped to
# [1024, 8192] MB. NODE_OPTIONS from the environment still wins.
_pick_heap_mb() {
  local total_kb heap_mb
  total_kb=\$(awk '/^MemTotal:/ {print \$2}' /proc/meminfo 2>/dev/null) || true
  if [ -z "\$total_kb" ] || [ "\$total_kb" -le 0 ]; then echo 2048; return; fi
  heap_mb=\$(( total_kb * 6 / 10 / 1024 ))
  if [ "\$heap_mb" -lt 1024 ]; then heap_mb=1024; fi
  if [ "\$heap_mb" -gt 8192 ]; then heap_mb=8192; fi
  echo "\$heap_mb"
}
VIVUS_HEAP_MB="\${VIVUS_HEAP_MB:-\$(_pick_heap_mb)}"

# Model selection — never unconditionally set ANTHROPIC_MODEL: it overrides
# the user's /model choice (which is persisted in ~/.vivus/settings.json),
# so every launch would reset their selection on resume.
# Priority: explicit VIVUS_MODEL env var > settings.json > seeded default.
VIVUS_DEFAULT_MODEL="qwen3.6:latest"
if [ -n "\${VIVUS_MODEL:-}" ]; then
  # Caller explicitly asked for this model for this invocation only.
  export ANTHROPIC_MODEL="\$VIVUS_MODEL"
else
  # Seed settings.json once if it has no model — otherwise CLI default kicks
  # in and may pick something the proxy doesn't have. After this, the user's
  # /model choice persists across launches.
  _settings="\$HOME/.vivus/settings.json"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "\$_settings" "\$VIVUS_DEFAULT_MODEL" <<'PYSEED' 2>/dev/null || true
import json, os, sys
path, default_model = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(path), exist_ok=True)
try:
    with open(path) as f: cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    cfg = {}
if not cfg.get("model"):
    cfg["model"] = default_model
    with open(path, "w") as f: json.dump(cfg, f, indent=2)
PYSEED
  fi
  # Leave ANTHROPIC_MODEL unset so the CLI reads settings.json.
  unset ANTHROPIC_MODEL
fi

set +e
ANTHROPIC_API_KEY="\${VIVUS_API_KEY}" \\
ANTHROPIC_BASE_URL="\${PROXY_BASE_URL}" \\
VIVUS_CODE_SIMPLE=0 \\
USE_BUILTIN_RIPGREP=0 \\
NODE_OPTIONS="\${NODE_OPTIONS:-} --max-old-space-size=\${VIVUS_HEAP_MB}" \\
node "\$DIR/../dist/main.js" \\
  --bare \\
  --permission-mode "acceptEdits" \\
  --agents "\$(cat "\$AGENTS_FILE")" \\
  "\$@"
status=\$?
set -e

# Postmortem: 137 == SIGKILL (kernel OOM or external killer), 134 == SIGABRT
# (V8 heap OOM / native abort), 139 == SIGSEGV. Surface a hint so users know
# what to look at — bash's bare "Killed" line is unactionable on its own.
if [ "\$status" -ge 128 ]; then
  sig=\$((status - 128))
  echo "" >&2
  case "\$sig" in
    9)  echo "vivus: process killed by SIGKILL (137). Likely causes: kernel OOM-killer, systemd-oomd, earlyoom, or a container/cgroup memory limit. Check: dmesg -T | tail; journalctl -k --since '1 hour ago' | grep -i oom; systemctl status systemd-oomd. Heap was capped at \${VIVUS_HEAP_MB} MB (override with VIVUS_HEAP_MB env)." >&2 ;;
    6)  echo "vivus: V8 aborted (134) — usually JS heap out of memory at \${VIVUS_HEAP_MB} MB. Raise with: VIVUS_HEAP_MB=12288 vivus  (or set globally)." >&2 ;;
    11) echo "vivus: segfault (139). Capture: node --report-on-fatalerror --report-directory=/tmp ... ; share the report-*.json." >&2 ;;
    15) echo "vivus: terminated by SIGTERM (143)." >&2 ;;
    1)  echo "vivus: SIGHUP (129) — controlling terminal closed?" >&2 ;;
    2)  : ;; # Ctrl-C, no-op
    *)  echo "vivus: terminated by signal \$sig (exit \$status)." >&2 ;;
  esac
fi
exit "\$status"
LAUNCHER

  run "${SCP[@]}" -q "$TMP_LAUNCHER" "$HOST:$REMOTE_BIN_DIR/$BIN_NAME"
  run "${SSH[@]}" "$HOST" "chmod +x $REMOTE_BIN_DIR/$BIN_NAME"
fi

# -----------------------------------------------------------------------------
# Optional /usr/local/bin symlink (needs sudo)
# -----------------------------------------------------------------------------
if $SYMLINK; then
  echo "==> Creating /usr/local/bin/$BIN_NAME (sudo)"
  # Expand REMOTE_BIN_DIR on remote so ~ resolves correctly
  run "${SSH[@]}" "$HOST" "sudo ln -sfn \$(eval echo $REMOTE_BIN_DIR)/$BIN_NAME /usr/local/bin/$BIN_NAME && ls -la /usr/local/bin/$BIN_NAME"
fi

# -----------------------------------------------------------------------------
# Smoke test
# -----------------------------------------------------------------------------
echo ""
echo "==> Smoke test"
run "${SSH[@]}" "$HOST" "command -v node >/dev/null 2>&1 || { export NVM_DIR=\"\$HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; }; node $REMOTE_DIST_DIR/main.js --version 2>&1 | head -3" || true

echo ""
echo "Done. On the remote, run:"
echo "  export VIVUS_API_KEY=sk-vivus-..."
if $SYMLINK; then
  echo "  $BIN_NAME"
else
  echo "  $REMOTE_BIN_DIR/$BIN_NAME"
fi
