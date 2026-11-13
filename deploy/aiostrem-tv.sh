#!/bin/bash
# Keeps the AIOStream addon reachable by the Fire TV and installed on it.
#
# The TV only installs an addon over https (its own stremio:// handler rewrites
# the link to https), and this box serves plain http on 3819. A Cloudflare quick
# tunnel gives a trusted https URL, but that URL is different every time the
# tunnel restarts, which silently orphans the addon on the TV. So this loop owns
# both halves: it keeps one tunnel alive, and whenever its hostname changes it
# pushes the new manifest link to the TV over adb and presses Install.
set -u

STATE=/home/roni-saguey/.local/state
URL_FILE=$STATE/aiostrem-tunnel.url
LOG=$STATE/aiostrem-tunnel.log
TV_LOG=$STATE/aiostrem-tv.log
CF=/usr/bin/cloudflared
TV=192.168.86.50:5555
LOCAL=http://127.0.0.1:3819

log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$TV_LOG"; }

tunnel_alive() { pgrep -f "cloudflared tunnel --url $LOCAL" | grep -qv "^$$\$"; }

while true; do
  if ! curl -fsS -m 5 "$LOCAL/manifest.json" >/dev/null 2>&1; then
    log "local addon on 3819 is not answering, waiting"
    sleep 15
    continue
  fi
  if ! tunnel_alive; then
    log "starting tunnel"
    : > "$LOG"
    nohup "$CF" tunnel --url "$LOCAL" --no-autoupdate >> "$LOG" 2>&1 &
  fi
  url=""
  for _ in $(seq 1 60); do
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1)
    [ -n "$url" ] && break
    sleep 1
  done
  if [ -z "$url" ] || ! curl -fsS -m 10 "$url/manifest.json" >/dev/null 2>&1; then
    log "tunnel has no working url yet"
    sleep 15
    continue
  fi
  if [ "$url" != "$(cat "$URL_FILE" 2>/dev/null)" ]; then
    adb connect "$TV" >/dev/null 2>&1
    adb -s "$TV" shell am start -a android.intent.action.VIEW \
      -d "stremio://${url#https://}/manifest.json" >/dev/null 2>&1
    # The install sheet opens with Install focused; the tap is the same press a
    # person makes. If the sheet is not there the tap lands on the addon page,
    # which changes nothing.
    sleep 6
    adb -s "$TV" shell input tap 1050 757 >/dev/null 2>&1
    printf '%s\n' "$url" > "$URL_FILE"
    log "pushed $url to the TV"
  fi
  sleep 120
done
