#!/usr/bin/env bash
set -euo pipefail

# Deploy Vivus proxy + portal to remote server
# Usage: ./deploy.sh [--setup]
#   --setup  First-time setup (install Node, Python, create systemd services)
#
# DNS mapping (handled by nginx proxy manager):
#   https://proxy.vivus.ai → 10.5.143.213:4089  (translation proxy)
#   https://agent.vivus.ai → 10.5.143.213:5050  (portal dashboard)

REMOTE_HOST="10.5.143.213"
REMOTE_USER="witt"
SSH_TARGET="${REMOTE_USER}@${REMOTE_HOST}"

REMOTE_BASE="/home/${REMOTE_USER}/vivus"
REMOTE_PROXY="${REMOTE_BASE}/proxy"
REMOTE_PORTAL="${REMOTE_BASE}/portal"

LOCAL_PROXY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_PORTAL="${LOCAL_PROXY}/../../../vivus-portal"

# Resolve portal path
if [ ! -d "$LOCAL_PORTAL" ]; then
  LOCAL_PORTAL="$HOME/Projects/vivus-portal"
fi
if [ ! -d "$LOCAL_PORTAL" ]; then
  echo "ERROR: Cannot find vivus-portal directory" >&2
  exit 1
fi

SETUP=false
if [[ "${1:-}" == "--setup" ]]; then
  SETUP=true
fi

echo "==> Deploying to ${SSH_TARGET}"
echo "    Proxy:  ${REMOTE_PROXY}  → https://proxy.vivus.ai"
echo "    Portal: ${REMOTE_PORTAL} → https://agent.vivus.ai"
echo ""

# ---------------------------------------------------------------------------
# First-time setup
# ---------------------------------------------------------------------------
if $SETUP; then
  echo "==> Running first-time setup..."
  ssh "$SSH_TARGET" bash -s <<'SETUP_EOF'
set -euo pipefail

# Install Node.js via nvm (no sudo needed)
if ! command -v node &>/dev/null; then
  echo "Installing Node.js via nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm alias default 20
fi

# Source nvm in case it was just installed
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
echo "Node: $(node --version)"

# Ensure Python venv module is available
python3 -m venv --help >/dev/null 2>&1 || {
  echo "ERROR: python3-venv not available. Install it with: sudo apt install python3-venv"
  exit 1
}
echo "Python: $(python3 --version)"

# Create directory structure
mkdir -p ~/vivus/proxy ~/vivus/portal

echo "Setup complete."
SETUP_EOF
fi

# ---------------------------------------------------------------------------
# Sync files
# ---------------------------------------------------------------------------
echo "==> Syncing proxy files..."
ssh "$SSH_TARGET" "mkdir -p ${REMOTE_PROXY} ${REMOTE_PORTAL}"
scp "${LOCAL_PROXY}/server.mjs" "${LOCAL_PROXY}/agents.json" \
  "${SSH_TARGET}:${REMOTE_PROXY}/"

echo "==> Syncing portal files..."
# Build a tar of the portal (excluding venv, git, cache, instance, .env)
# and extract on remote — preserves directory structure without rsync
tar -C "$LOCAL_PORTAL" \
  --exclude='.venv' --exclude='__pycache__' --exclude='.git' \
  --exclude='instance' --exclude='.env' \
  -cf - . | ssh "$SSH_TARGET" "tar -C ${REMOTE_PORTAL} -xf -"

# ---------------------------------------------------------------------------
# Create env files and install deps on remote
# ---------------------------------------------------------------------------
echo "==> Setting up remote environment..."
ssh "$SSH_TARGET" bash -s <<'REMOTE_EOF'
set -euo pipefail

# -- Proxy env --
cat > ~/vivus/proxy/.env <<'ENV'
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.6:latest
PORTAL_URL=http://127.0.0.1:5050
PROXY_PORT=4089
NUM_CTX=262144
PROXY_DEBUG=0
ENV

# -- Portal env & venv --
if [ ! -f ~/vivus/portal/.env ]; then
  SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  cat > ~/vivus/portal/.env <<ENV
PORT=5050
HOST=0.0.0.0
SECRET_KEY=${SECRET_KEY}
DATABASE_URL=sqlite:///vivus.db
ENV
  echo "Created portal .env with generated SECRET_KEY"
fi

# Set up Python venv
if [ ! -d ~/vivus/portal/.venv ]; then
  python3 -m venv ~/vivus/portal/.venv
fi
~/vivus/portal/.venv/bin/pip install -q -r ~/vivus/portal/requirements.txt

echo "Remote environment ready."
REMOTE_EOF

# ---------------------------------------------------------------------------
# Create systemd user services
# ---------------------------------------------------------------------------
echo "==> Installing systemd services..."
ssh "$SSH_TARGET" bash -s <<'SVC_EOF'
set -euo pipefail

# Resolve nvm node path
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
NODE_BIN="$(which node)"

mkdir -p ~/.config/systemd/user

# -- vivus-proxy.service --
cat > ~/.config/systemd/user/vivus-proxy.service <<SVC
[Unit]
Description=Vivus Translation Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/${USER}/vivus/proxy
EnvironmentFile=/home/${USER}/vivus/proxy/.env
ExecStart=${NODE_BIN} /home/${USER}/vivus/proxy/server.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SVC

# -- vivus-portal.service --
cat > ~/.config/systemd/user/vivus-portal.service <<SVC
[Unit]
Description=Vivus Portal Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/${USER}/vivus/portal
EnvironmentFile=/home/${USER}/vivus/portal/.env
ExecStart=/home/${USER}/vivus/portal/.venv/bin/python -m flask run --host=0.0.0.0 --port=5050
Environment=FLASK_APP=app.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SVC

# Enable lingering so user services survive logout
loginctl enable-linger "${USER}" 2>/dev/null || true

systemctl --user daemon-reload
systemctl --user enable vivus-proxy vivus-portal
systemctl --user restart vivus-proxy vivus-portal

sleep 2
echo ""
echo "Service status:"
systemctl --user --no-pager status vivus-proxy || true
echo ""
systemctl --user --no-pager status vivus-portal || true

SVC_EOF

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
echo ""
echo "==> Verifying endpoints..."
sleep 3

PROXY_OK=$(ssh "$SSH_TARGET" "curl -sf http://127.0.0.1:4089/health 2>/dev/null" && echo "OK" || echo "FAIL")
PORTAL_OK=$(ssh "$SSH_TARGET" "curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:5050/ 2>/dev/null" && echo "OK" || echo "FAIL")

echo "  Proxy  (127.0.0.1:4089): ${PROXY_OK}"
echo "  Portal (127.0.0.1:5050): ${PORTAL_OK}"
echo ""
echo "==> Done! Ensure nginx proxy manager routes:"
echo "    https://proxy.vivus.ai → ${REMOTE_HOST}:4089"
echo "    https://agent.vivus.ai → ${REMOTE_HOST}:5050"
echo ""
echo "    IMPORTANT: Set proxy timeout to 120s+ for proxy.vivus.ai"
echo "    (Ollama responses can take 60-90s)"
