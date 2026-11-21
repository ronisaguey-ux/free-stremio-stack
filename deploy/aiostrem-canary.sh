#!/usr/bin/env bash
# aiostrem canary: the TV must always get exactly one playable source.
#
# Two things break silently on this box:
#   1. the streaming engine behind :11470 dies, so every delivery probe fails;
#   2. the hub (AIOStreams) starts answering empty under load.
# Both read to the panel as a spinner with no streams, which is the failure the
# owner cannot debug from a remote. This asks the addon the same question the TV
# asks, and restarts what is broken. Every check is cheap: one healthz and one
# stream request for a title that always has sources.
set -u

URL=${AIOSTREM_URL:-http://127.0.0.1:3819}
CANARY_ID=${AIOSTREM_CANARY_ID:-series/tt2193021:1:1}
LOG=/var/log/aiostrem-canary.log

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

health=$(curl -s -m 12 "$URL/healthz" || true)
case "$health" in
  *'"ok": true'*|*'"ok":true'*) ;;
  *)
    say "healthz not ok ($health) - restarting aiostrem"
    systemctl restart aiostrem.service
    sleep 8
    ;;
esac

count=$(curl -s -m 40 "$URL/stream/$CANARY_ID.json" \
  | python3 -c 'import json,sys
try:
    print(len(json.load(sys.stdin).get("streams") or []))
except Exception:
    print(-1)' 2>/dev/null)

if [ "${count:-0}" -ge 1 ] 2>/dev/null; then
  say "ok streams=$count"
  exit 0
fi

# Nothing came back for a title that always has sources. Restart the addon once,
# and the engine too if it is the one that stopped answering.
say "canary returned streams=$count - restarting aiostrem"
systemctl restart aiostrem.service
sleep 10
again=$(curl -s -m 40 "$URL/stream/$CANARY_ID.json" \
  | python3 -c 'import json,sys
try:
    print(len(json.load(sys.stdin).get("streams") or []))
except Exception:
    print(-1)' 2>/dev/null)
if [ "${again:-0}" -ge 1 ] 2>/dev/null; then
  say "recovered after restart streams=$again"
  exit 0
fi

say "still empty after restart (streams=$again) - restarting the engine"
docker restart stremio-server >/dev/null 2>&1 || true
sleep 15
final=$(curl -s -m 40 "$URL/stream/$CANARY_ID.json" \
  | python3 -c 'import json,sys
try:
    print(len(json.load(sys.stdin).get("streams") or []))
except Exception:
    print(-1)' 2>/dev/null)
say "after engine restart streams=$final"
[ "${final:-0}" -ge 1 ] 2>/dev/null
