#!/bin/bash
# Self-healing coordinator for AIOStream across mastercrust (primary) and laptop (failover).
set -u

HOME_SERVER=/home/roni-saguey/.local/share/aiostrem/server.js
REMOTE_IP="${AIOSTREM_MASTER_IP:-192.168.86.37}"
REMOTE_KEY="${AIOSTREM_SSH_KEY:-/home/roni-saguey/.ssh/server_ed25519}"
REMOTE_HUB_CONF=/etc/systemd/system/aiostrem.service.d/hub.conf
HUB_SUFFIX="${AIOSTREM_HUB_SUFFIX:-3817/stremio/1594c4ff-bfb7-4b79-a831-13e495c9e7a9/eyJpIjoiRmUvN0ErN09wU2ZZYXY0MTZybFl1UT09IiwiZSI6IkF1cHc2czU5T1BibXNRUEJIQ2NiN3QxTzdWL2RTUzJ4dk9rSnVwbEdWbzQ9IiwidCI6ImEifQ/manifest.json}"
LOG=/home/roni-saguey/.local/state/aiostrem-heal.log
GUARD=/home/roni-saguey/.local/bin/aiostrem-collection-guard.py
SSH=(ssh -i "$REMOTE_KEY" -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no "root@$REMOTE_IP")
SCP=(scp -q -i "$REMOTE_KEY" -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no)

LAST_MODE=""
TICK=0

log() {
  local line
  line="$(date -Is) $*"
  printf '%s\n' "$line" >> "$LOG"
  printf '%s\n' "$line"
}

lan_ip() {
  ip -4 route get 192.168.86.1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}'
}

clear_stale_arp_alias() {
  if ip -4 addr show 2>/dev/null | grep -q "${REMOTE_IP}/32"; then
    local iface
    iface=$(ip -4 addr show | awk "/${REMOTE_IP}\\/32/{print \$NF; exit}")
    docker run --rm --network host --cap-add NET_ADMIN python:3.12-alpine \
      ip addr del "${REMOTE_IP}/32" dev "$iface" >/dev/null 2>&1 \
      && log "removed stale ${REMOTE_IP}/32 alias on ${iface}"
  fi
}

ensure_tunnel_up() {
  if ! systemctl --user is-active --quiet helpotron-tunnel.service; then
    systemctl --user restart helpotron-tunnel.service >/dev/null 2>&1 \
      && log "restarted inactive helpotron-tunnel.service"
  fi
}

sync_mastercrust() {
  "${SSH[@]}" 'true' 2>/dev/null || return 0
  if [ -f "$HOME_SERVER" ]; then
    local lsum rsum
    lsum=$(sha256sum "$HOME_SERVER" | cut -d' ' -f1)
    rsum=$("${SSH[@]}" 'sha256sum /root/aiostrem/server.js 2>/dev/null | cut -d" " -f1' 2>/dev/null)
    if [ -n "$lsum" ] && [ "$lsum" != "$rsum" ]; then
      if "${SCP[@]}" "$HOME_SERVER" "root@$REMOTE_IP:/root/aiostrem/server.js" 2>/dev/null \
        && "${SSH[@]}" 'node -c /root/aiostrem/server.js && systemctl restart aiostrem' 2>/dev/null; then
        log "synced server.js ($lsum) to $REMOTE_IP and restarted aiostrem"
      else
        log "sync server.js to $REMOTE_IP failed"
      fi
    fi
  fi

  local my_ip want_hub cur_hub
  my_ip=$(lan_ip)
  if [ -n "$my_ip" ]; then
    want_hub="http://${my_ip}:${HUB_SUFFIX}"
    cur_hub=$("${SSH[@]}" "sed -n 's/^Environment=HUB_URL=//p' $REMOTE_HUB_CONF 2>/dev/null" 2>/dev/null || true)
    if [ "$cur_hub" != "$want_hub" ]; then
      "${SSH[@]}" "mkdir -p /etc/systemd/system/aiostrem.service.d && printf '[Service]\nEnvironment=HUB_URL=%s\n' '$want_hub' > $REMOTE_HUB_CONF && systemctl daemon-reload && systemctl restart aiostrem" 2>/dev/null \
        && log "updated mastercrust HUB_URL to ${my_ip}:3817"
    fi
  fi
}

recover_mastercrust() {
  "${SSH[@]}" '
    if ! curl -fsS -m 3 http://127.0.0.1:11470/settings >/dev/null 2>&1; then
      docker restart stremio-server >/dev/null 2>&1 || true
      sleep 2
    fi
    systemctl restart aiostrem >/dev/null 2>&1 || true
  ' 2>/dev/null || return 1
  sleep 3
  curl -fsS -m 5 "http://${REMOTE_IP}:3819/healthz" >/dev/null 2>&1
}

run_once() {
  clear_stale_arp_alias
  ensure_tunnel_up

  if curl -fsS -m 5 "http://${REMOTE_IP}:3819/healthz" >/dev/null 2>&1; then
    if [ "$LAST_MODE" != "primary" ] \
      || systemctl --user is-active --quiet aiostrem.service \
      || ! systemctl --user is-active --quiet aiostrem-forward.service \
      || ! curl -fsS -m 4 http://127.0.0.1:3819/healthz >/dev/null 2>&1; then
      systemctl --user stop aiostrem.service >/dev/null 2>&1 || true
      systemctl --user restart aiostrem-forward.service >/dev/null 2>&1
      log "mode=primary ($REMOTE_IP healthy; socat forward active on :3819)"
      LAST_MODE="primary"
    fi
    sync_mastercrust
  else
    if recover_mastercrust; then
      systemctl --user stop aiostrem.service >/dev/null 2>&1 || true
      systemctl --user restart aiostrem-forward.service >/dev/null 2>&1
      log "recovered primary ($REMOTE_IP) after restart; socat forward active on :3819"
      LAST_MODE="primary"
      sync_mastercrust
    elif [ "$LAST_MODE" != "failover" ] || ! systemctl --user is-active --quiet aiostrem.service; then
      systemctl --user stop aiostrem-forward.service >/dev/null 2>&1 || true
      systemctl --user start aiostrem.service >/dev/null 2>&1
      log "mode=failover ($REMOTE_IP unhealthy; local aiostrem active on :3819)"
      LAST_MODE="failover"
    fi
  fi

  if [ $((TICK % 15)) -eq 0 ] && [ -x "$GUARD" ]; then
    local out
    if ! out=$(python3 "$GUARD" 2>&1); then
      log "collection-guard error: $out"
    elif [ -n "$out" ]; then
      log "$out"
    fi
  fi
  TICK=$((TICK + 1))
}

if [ "${1:-}" = "--once" ]; then
  run_once
  exit 0
fi

log "aiostrem-heal started (master=$REMOTE_IP)"
while true; do
  run_once
  sleep 20
done
