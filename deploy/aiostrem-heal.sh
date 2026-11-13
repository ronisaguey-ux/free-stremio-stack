#!/bin/bash
# Keeps the mastercrust failover addon alive and the home copy in step.
#
# mastercrust froze on 2026-11-12 (all ports accepted TCP, no userland answer,
# ssh banner never sent) and the TV hung on the addon with nothing to fall back
# to. This loop does two things and nothing else: it pushes the home copy of
# server.js to mastercrust whenever the remote is reachable and differs, and it
# restarts the remote unit when the remote stopped answering. When the remote is
# frozen it waits — that state cannot be fixed from here.
set -u

HOME_SERVER=/home/roni-saguey/.local/share/aiostrem/server.js
REMOTE_HOST=100.88.179.28   # tailscale: unchanged when .37 is aliased locally
REMOTE_KEY=/home/roni-saguey/.ssh/lan_ed25519
STATE=/home/roni-saguey/.local/state/aiostrem-heal.log
SSH=(ssh -i "$REMOTE_KEY" -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=no "root@$REMOTE_HOST")

log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$STATE"; }

while true; do
  if "${SSH[@]}" 'true' 2>/dev/null; then
    # mastercrust is alive again: hand its address back before touching it, or
    # the LAN answers .37 twice and the TV picks a coin toss.
    if ip -4 addr show wlp3s0 | grep -q '192.168.86.37/32'; then
      docker run --rm --network host --cap-add NET_ADMIN python:3.12-alpine \
        ip addr del 192.168.86.37/32 dev wlp3s0 >/dev/null 2>&1 \
        && log "mastercrust is back: removed the .37 alias from this box"
    fi
  fi
  if curl -fsS -m 8 "http://$REMOTE_HOST:3819/manifest.json" >/dev/null 2>&1; then
    # Remote answers: is it running the current file?
    if "${SSH[@]}" 'test -f /root/aiostrem/server.js' 2>/dev/null; then
      local_sum=$(sha256sum "$HOME_SERVER" | cut -d' ' -f1)
      remote_sum=$("${SSH[@]}" 'sha256sum /root/aiostrem/server.js 2>/dev/null | cut -d" " -f1' 2>/dev/null)
      if [ -n "$remote_sum" ] && [ "$local_sum" != "$remote_sum" ]; then
        if scp -q -i "$REMOTE_KEY" -o BatchMode=yes -o ConnectTimeout=8 "$HOME_SERVER" "root@$REMOTE_HOST:/root/aiostrem/server.js" 2>/dev/null \
          && "${SSH[@]}" 'node -c /root/aiostrem/server.js && systemctl restart aiostrem' 2>/dev/null; then
          log "pushed server.js to $REMOTE_HOST and restarted aiostrem"
        else
          log "push to $REMOTE_HOST failed"
        fi
      fi
    fi
  else
    # Not answering. If ssh still works the unit is down: restart it.
    if "${SSH[@]}" 'systemctl restart aiostrem' 2>/dev/null; then
      sleep 3
      if curl -fsS -m 8 "http://$REMOTE_HOST:3819/manifest.json" >/dev/null 2>&1; then
        log "remote addon was down, restarted it"
      else
        log "restart attempted, still not answering"
      fi
    else
      log "remote unreachable (ssh too), waiting"
    fi
  fi
  sleep 60
done
