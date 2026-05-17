#!/usr/bin/env bash
set -euo pipefail

APP_NAME="sub-converter"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
FETCH_RELAYS="${FETCH_RELAYS:-}"
RELAY_SECRET="${RELAY_SECRET:-}"
SHORTENER_ENDPOINT="${SHORTENER_ENDPOINT:-https://d.flysub.org/short}"
MAIN_SERVER="${MAIN_SERVER:-}"
SERVICE_USER="${SERVICE_USER:-root}"
JOURNAL_SYSTEM_MAX_USE="${JOURNAL_SYSTEM_MAX_USE:-100M}"
JOURNAL_SYSTEM_KEEP_FREE="${JOURNAL_SYSTEM_KEEP_FREE:-500M}"
JOURNAL_MAX_RETENTION_SEC="${JOURNAL_MAX_RETENTION_SEC:-7day}"
ENV_FILE="/etc/${APP_NAME}.env"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
JOURNALD_LIMIT_FILE="/etc/systemd/journald.conf.d/99-${APP_NAME}-limits.conf"
EFFECTIVE_RELAY_SECRET=""

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Please run as root: sudo bash scripts/deploy-ubuntu.sh"
    exit 1
  fi
}

version_major() {
  local version="${1#v}"
  echo "${version%%.*}"
}

install_node20_if_needed() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(version_major "$(node -v)")"
    if [ "$major" -ge 20 ]; then
      echo "Node.js $(node -v) is ready."
      return
    fi
    echo "Detected Node.js $(node -v), upgrading to Node.js 20..."
  else
    echo "Node.js not found, installing Node.js 20..."
  fi

  apt-get update
  apt-get install -y ca-certificates curl gnupg
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
}

detect_public_base_url() {
  if [ -n "$PUBLIC_BASE_URL" ]; then
    echo "$PUBLIC_BASE_URL"
    return
  fi

  local ip=""
  ip="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
  if [ -z "$ip" ]; then
    ip="$(hostname -I | awk '{print $1}')"
  fi
  echo "http://${ip}:${PORT}"
}

write_env_file() {
  local base_url="$1"
  local secret relay_secret
  if [ -f "$ENV_FILE" ] && grep -q "^SUB_TOKEN_SECRET=" "$ENV_FILE"; then
    secret="$(grep "^SUB_TOKEN_SECRET=" "$ENV_FILE" | cut -d= -f2-)"
  else
    secret="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  fi
  if [ -n "$RELAY_SECRET" ]; then
    relay_secret="$RELAY_SECRET"
  elif [ -f "$ENV_FILE" ] && grep -q "^RELAY_SECRET=" "$ENV_FILE"; then
    relay_secret="$(grep "^RELAY_SECRET=" "$ENV_FILE" | cut -d= -f2-)"
  else
    relay_secret="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  fi
  EFFECTIVE_RELAY_SECRET="$relay_secret"

  cat > "$ENV_FILE" <<EOF
PORT=${PORT}
HOST=${HOST}
PUBLIC_BASE_URL=${base_url}
SUB_TOKEN_SECRET=${secret}
RELAY_SECRET=${relay_secret}
FETCH_RELAYS=${FETCH_RELAYS}
SHORTENER_ENDPOINT=${SHORTENER_ENDPOINT}
RAW_CACHE_TTL_MS=600000
OUTPUT_CACHE_TTL_MS=600000
STALE_CACHE_TTL_MS=86400000
MAX_UPSTREAM_BYTES=5242880
MAX_NODES=3000
FETCH_TIMEOUT_MS=8000
EOF
  chmod 600 "$ENV_FILE"
}

write_service_file() {
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Airport Subscription Converter
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v node) ${APP_DIR}/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
}

open_firewall_port() {
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow "${PORT}/tcp" || true
  fi
}

configure_journal_limits() {
  mkdir -p "$(dirname "$JOURNALD_LIMIT_FILE")"
  cat > "$JOURNALD_LIMIT_FILE" <<EOF
[Journal]
SystemMaxUse=${JOURNAL_SYSTEM_MAX_USE}
SystemKeepFree=${JOURNAL_SYSTEM_KEEP_FREE}
MaxRetentionSec=${JOURNAL_MAX_RETENTION_SEC}
EOF
  systemctl restart systemd-journald || true
}

register_to_main_server() {
  if [ -z "$MAIN_SERVER" ]; then
    return
  fi
  if [ -z "$EFFECTIVE_RELAY_SECRET" ]; then
    echo "MAIN_SERVER is set, but RELAY_SECRET is empty. Skipping relay registration."
    return
  fi

  local relay_url
  relay_url="$(detect_public_base_url)"
  echo "Registering relay ${relay_url} to main server ${MAIN_SERVER}..."
  curl -fsS --max-time 15 \
    -H "Authorization: Bearer ${EFFECTIVE_RELAY_SECRET}" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"${relay_url}\"}" \
    "${MAIN_SERVER%/}/api/register-relay" \
    || echo "Relay registration failed. You can rerun deploy later."
}

main() {
  need_root
  install_node20_if_needed

  if [ -f "${APP_DIR}/package.json" ]; then
    npm install --omit=dev
  fi

  local base_url
  base_url="$(detect_public_base_url)"
  write_env_file "$base_url"
  write_service_file
  configure_journal_limits
  open_firewall_port

  systemctl daemon-reload
  systemctl enable "${APP_NAME}"
  systemctl restart "${APP_NAME}"
  register_to_main_server

  echo
  echo "Deployment completed."
  echo "Service: ${APP_NAME}"
  echo "URL: ${base_url}"
  echo
  echo "Useful commands:"
  echo "  systemctl status ${APP_NAME}"
  echo "  journalctl -u ${APP_NAME} -f"
  echo "  systemctl restart ${APP_NAME}"
}

main "$@"
