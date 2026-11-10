#!/usr/bin/env bash
# Install AIOStream as a systemd user service, no root required.
#
#   HUB_URL="http://<host>:3817/stremio/<uuid>/<token>/manifest.json" \
#   PUBLIC_URL="http://<host>:3819" ./install.sh
#
# The hub URL comes from the AIOStreams configure page after you save a
# configuration; PUBLIC_URL must be an address your player can actually reach.
set -euo pipefail

HUB_URL="${HUB_URL:?set HUB_URL to the AIOStreams manifest URL}"
PUBLIC_URL="${PUBLIC_URL:?set PUBLIC_URL, e.g. http://192.168.1.10:3819}"
PORT="${PORT:-3819}"
STREAMING_URL="${STREAMING_URL:-http://127.0.0.1:11470}"
TARGET="$HOME/.local/share/aiostrem"
UNIT="$HOME/.config/systemd/user/aiostrem.service"

command -v node >/dev/null || { echo "node 18+ is required" >&2; exit 1; }

mkdir -p "$TARGET" "$(dirname "$UNIT")"
install -m 0644 "$(dirname "$0")/addon/server.js" "$TARGET/server.js"
install -m 0644 "$(dirname "$0")/addon/package.json" "$TARGET/package.json"

cat > "$UNIT" <<UNIT
[Unit]
Description=AIOStream: one Stremio stream per title, ranked and failed over on the backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$TARGET
Environment=PORT=$PORT
Environment=PUBLIC_URL=$PUBLIC_URL
Environment=STREAMING_URL=$STREAMING_URL
Environment=HUB_URL=$HUB_URL
ExecStart=$(command -v node) $TARGET/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now aiostrem.service
sleep 2
curl -fsS "http://127.0.0.1:$PORT/manifest.json" >/dev/null && echo "aiostrem is up on port $PORT"
echo "Install this in Stremio: $PUBLIC_URL/manifest.json"
