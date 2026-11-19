# Friction log — putting this stack on a Google TV (2026-11-18/19)

Every hangup hit while getting a Hisense Google TV (Android 11 / SDK 30,
32-bit armeabi-v7a, ADB at `192.168.86.24:5555`) onto **AIOStream addon only**,
with a new Stremio *account* (not a TV user profile).

Read this before touching the TV. Half of these cost 10+ minutes each.

---

## 1. Browser automation

### 1.1 The browse extension was offline
`browse status` returned `pairingState: paired-offline` — the agent-side Chrome
was not running. Nothing retries it.

**Fix:** launch a **headed** Chrome with a debugging port and drive it over CDP
directly; don't wait for the extension.

```bash
setsid nohup /opt/google/chrome/chrome --no-sandbox \
  --remote-debugging-port=9334 --remote-allow-origins=* \
  --user-data-dir=/tmp/stremio-headed2 --no-first-run \
  --no-default-browser-check --window-size=1600,950 \
  "https://web.stremio.com/#/addons" >/tmp/chrome-headed2.log 2>&1 </dev/null &
```

### 1.2 `--headless=new` looks fine but the owner wants to see it
Headed also means a human can take over mid-flow. Use it for anything on a
console that a human might watch.

### 1.3 WebSocket handshake 403
```
Handshake status 403 Forbidden ... Rejected an incoming WebSocket connection
from the http://127.0.0.1:9333 origin.
```
Chrome refuses CDP websocket upgrades unless the origin is allowed.

**Fix:** `--remote-allow-origins=*` on the Chrome command line.

### 1.4 Killing the wrong thing kills your own shell
`pgrep -f "user-data-dir=/tmp/stremio-cdp"` matches the *shell command line that
contains the pattern* — the `kill` then terminates the running command
(`Killed by SIGTERM`, work lost twice).

**Fix:** filter on the real executable name, never on the pattern:

```bash
for p in $(pgrep -f "stremio-headed"); do
  [ "$(cat /proc/$p/comm 2>/dev/null)" = "chrome" ] && kill "$p"
done
```
`pkill` is also blocked by the shell guard entirely.

### 1.5 Playwright's text/role locators time out on this app
`get_by_text("Install")`, `get_by_role("button", name=...)` all timeout 20-25s:
Stremio's web UI is React inside nested `div`s, with no roles and sometimes no
text node at the click target.

**Fix — drive CDP one action at a time** (see `tools/cdp.py` in this repo):
- locate by exact `innerText` match and use `getClientRects().length`, **not**
  `offsetParent` (children of a `position: fixed` modal report `offsetParent
  === null` while being perfectly visible);
- click with real input events at the element centre
  (`Input.dispatchMouseEvent` press+release), not `element.click()`;
- type with `Input.insertText` (React does see it) and confirm the value before
  pressing anything else.

### 1.6 The Add-addon modal
- With the URL typed, the button is labelled **Add**. After Enter the modal
  switches to the manifest preview and the same button becomes **Install** —
  looking for "Add" after the preview is why the install looked impossible.
- The URL field is the second `input[type=text]`; its placeholder is
  **`Paste addon URL`**. The first text input is the addon *search* box — typing
  the URL there silently does nothing.
- The button does not appear until the manifest has been fetched: focus the
  field and press **Enter**, wait for the addon preview card, then click Add.
  Enter on an unfocused field closes the modal instead.
- Verify the result from the API, not the DOM.

### 1.7 Logged-in state is not obvious
`#/settings` shows `Guest | Log in or Sign up` when anonymous, and
`Account | <email>` when logged in. `localStorage` after login has **no**
`authKey` key (it lives elsewhere) — don't test for it.

Login flow that works: `#/settings` → click `Log in or Sign up` (228,125) →
click `Log in` in the modal → fill `input[type=email]` / `input[type=password]`
→ click the submit `Log in` **in the form** (it is a second element with the
same text).

---

## 2. Stremio account API (`https://api.strem.io/api/`)

| call | works? | note |
|---|---|---|
| `addonCollectionGet {authKey, update:true}` | yes | the source of truth for "what the TV will see" |
| `addonCollectionRemove {authKey, transportUrl}` | yes | returns `{}` on success |
| `addonCollectionAdd {authKey, transportUrl}` | **no** | returns `{}` and silently does nothing — for `https://` **and** `http://` URLs. Installation must go through a client (web app UI or an install dialog on the TV). |
| `datastoreGet {authKey, key:"addon_collection"}` | no | `{"error":{"code":5992,"message":"Sync disabled"}}` |

**Rule:** install in the web app, verify with `addonCollectionGet`, remove with
the API. Do not trust `{}` from `Add` as success.

**A removed addon comes back while a client is logged in.** The web tab and the
TV each hold their own copy and push it back on the next sync, so an API
`addonCollectionRemove` can be silently undone a few seconds later (observed
twice; the entry reappeared with the same `transportUrl`). Remove it on the
device that holds it, or with every client closed.

Removing on the Android TV: open the Addons screen, press/hold (or long-press
DPAD_CENTER, `adb shell input keyevent --longpress 23`) on the addon card → a
dialog appears showing **URL: …** and **Uninstall** → tap Uninstall. The dialog
is the only place the TV tells you which URL that card is bound to, which is how
you tell a stale duplicate from the good one.


---

## 3. Stremio Android TV client

### 3.1 The deep link only speaks HTTPS
```
adb shell am start -a android.intent.action.VIEW \
  -d 'stremio://<host>/manifest.json' com.stremio.one
```
`stremio://` prepends `https://`. A LAN URL (`http://192.168.86.37:3819`) fails
with `Failed to fetch: error sending request for url (https://192.168.86.37:3819/...)`.
An HTTPS endpoint is therefore **mandatory** — this is the whole reason for the
tunnel in §4.

### 3.2 The install dialog is tap-only and invisible to the UI dump
After the deep link, `uiautomator dump` returns ten empty `text=""` nodes (the
Compose dialog has no semantics while it fetches). Tapping the Install button by
bounds still worked once (`1159,842` on 1920x1080). If the fetch fails the
dialog closes silently — no error text stays on screen.

**Prefer the web app + account sync over the TV dialog** whenever you can log in.

### 3.3 Never verify the TV with a screenshot
`screencap` returns an **all-black frame** for Stremio's GL/Compose surface.
Use `uiautomator dump` and read `text="..."`, or better:
- `dumpsys media_session | grep PlaybackState` → `state=3` means playing,
  `position=` advancing;
- the streaming server's `/stats.json` → `downSpeed` proves bytes are moving.

### 3.4 Empty dumps happen mid-transition
A dump taken while the app is loading or switching returns zero text nodes. Wait
3-5 s and dump again before concluding anything is broken.

### 3.5 Addons screen is reachable but scroll-happy
`input keyevent 21` (twice) shows the sidebar; `Addons` sat at `(179,705)`. The
list needs ~6 `input swipe 900 800 900 250 250` to reach the last entry. Search
each dump for the addon name rather than assuming an order.

### 3.6 This Hisense is 32-bit
Install the `armeabi-v7a` APK of Stremio Android TV (1.10.4), not arm64.

---

## 4. Reaching the addon over HTTPS

### 4.1 Quick tunnels are not durable
`cloudflared tunnel --url http://127.0.0.1:3819` prints a random
`*.trycloudflare.com` hostname. Every restart changes it, so an addon installed
with that URL breaks the next time the tunnel comes up.

Use it to prove the flow, never to finish the job.

### 4.2 This account's zone is `helpotron.dpdns.org`
- `cloudflared tunnel route dns aiostrem stremio.dpdns.org` "succeeds" and
  creates the nonsense record `stremio.dpdns.org.helpotron.dpdns.org`.
- `stremio.helpotron.dpdns.org` already exists as a **proxied A record**, so
  routing it to a tunnel is refused:
  `code: 1003 ... An A, AAAA, or CNAME record with that host already exists`.
- Working hostname: **`stremio-tv.helpotron.dpdns.org`**.

### 4.3 The durable tunnel (this is what is installed)
```bash
cloudflared tunnel create aiostrem           # id fbae9559-…
cloudflared tunnel route dns aiostrem stremio-tv.helpotron.dpdns.org
```
`~/.cloudflared/aiostrem.yml`
```yaml
tunnel: fbae9559-fd20-4d2f-b90d-5e7859f4b2db
credentials-file: /home/roni-saguey/.cloudflared/fbae9559-fd20-4d2f-b90d-5e7859f4b2db.json
protocol: quic
ingress:
  - hostname: stremio-tv.helpotron.dpdns.org
    service: http://127.0.0.1:3819
  - service: http_status:404
```
`~/.config/systemd/user/aiostrem-tunnel.service`
```ini
[Unit]
Description=AIOStream addon HTTPS tunnel
After=network-online.target
[Service]
ExecStart=/home/roni-saguey/.local/bin/cloudflared --no-autoupdate --config /home/roni-saguey/.cloudflared/aiostrem.yml tunnel run
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
```
Addon URL to install: `https://stremio-tv.helpotron.dpdns.org/manifest.json`

### 4.4 Why 127.0.0.1:3819 is the right origin
The addon server itself runs on **mastercrust** (`192.168.86.37:3819`,
`systemctl status aiostrem`). This laptop has a `socat` listener on `*:3819`
forwarding to it, so the tunnel can point at `127.0.0.1` and nothing else has to
move. The addon's `PUBLIC_URL` is `http://192.168.86.37:3819`, which is what it
puts in the stream URLs it hands the player — the TV reaches that over the LAN,
not through the tunnel. Playback therefore does not depend on Cloudflare.

---

## 5. "AIOStream addon is still loading…" then nothing

Symptom: the TV shows the loading row, then the row disappears and no stream
appears. Server log:
```
no live source for series:tt7631058:1:1 (40 candidates)
```

Cause, in `addon/server.js`:

```js
const PROBE_MS = Number(process.env.PROBE_MS || 1800);          // per-torrent gate
const PROBE_DEADLINE_MS = Number(process.env.PROBE_DEADLINE_MS || 7000);
const PLAYABLE_BYTES_PER_SEC = Number(process.env.PLAYABLE_BYTES_PER_SEC || 600000);
```
A cold torrent reports `peers:0` / `0 B/s` for several seconds after
`/create`, so an 1800 ms window rejects every candidate — including torrents
that are healthy two seconds later.

**Fix applied (env only, no code change):**
```bash
mkdir -p /etc/systemd/system/aiostrem.service.d
printf '[Service]\nEnvironment=PROBE_MS=12000\n' > /etc/systemd/system/aiostrem.service.d/probe.conf
systemctl daemon-reload && systemctl restart aiostrem
```
Measured: first request per title **≈9-10 s**, second identical request **≈1.0 s**
(the addon caches per title). The TV drops the loading row at ~10 s, so the first
open can still show nothing — **reopen the sources panel and it fills
immediately**.

Cheaper follow-ups, in order of value:
1. warm the cache for the title on details-open (a preflight `/stream/…` call);
2. run the probe with `PLAYABLE_BYTES_PER_SEC` lowered to ~150 k for the first
   pass and re-rank upwards as rates settle;
3. keep `PROBE_DEADLINE_MS` just under the client's patience (≈9 s) so the
   response never arrives after the row has been dropped.

---

## 6. Things that were tried and do not work (don't repeat)

- **Torrentio as the "watchable right now" fallback** — the owner does not want
  it on the TV; AIOStream only. It was installed and then removed again.
- **The public AIOStreams hub configured from scratch** —
  `https://aiostreams.elfhosted.com/stremio/configure` serves debrid/Usenet
  streams only (Torrentio disabled), so it yields nothing without a
  Real-Debrid/TorBox/Premiumize key. The stack already has a working hub on this
  LAN (port 3817) — use it.
- **Installing the addon with `stremio://` from the TV for a LAN URL** — see §3.1.
- **`addonCollectionAdd`** — see §2.
- **Judging the TV by screenshot** — see §3.3.

---

## 7. The working end-to-end recipe

1. Stremio Android TV (armeabi-v7a) installed; log in to the reading account.
2. Addon server up on mastercrust: `systemctl status aiostrem`, manifest at
   `http://192.168.86.37:3819/manifest.json` → `{"id":"org.aiostre.am"}`.
3. Hub reachable: `http://192.168.86.49:3817/stremio/<uuid>/<b64>/manifest.json`.
4. Tunnel up: `systemctl --user status aiostrem-tunnel` →
   `https://stremio-tv.helpotron.dpdns.org/manifest.json` returns 200.
5. Web app: log in as the reading account → Addons → Add addon →
   paste the URL → Enter → Add.
6. Verify from anywhere:
   ```bash
   curl -s -X POST -H 'content-type: application/json' \
     -d "{\"authKey\":\"$KEY\",\"update\":true}" \
     https://api.strem.io/api/addonCollectionGet \
     | python3 -c 'import json,sys; a=json.load(sys.stdin)["result"]["addons"]; print([x["manifest"]["name"] for x in a])'
   ```
   Expect `AIOStream` present and `Torrentio` absent.
7. TV: force-stop + start Stremio → the addon list shows AIOStream → open a
   title → sources panel fills (reopen it if the first pass timed out) → play.
8. Prove playback, not intent:
   ```bash
   adb shell dumpsys media_session | grep PlaybackState   # state=3
   ssh mastercrust 'curl -s http://127.0.0.1:11470/stats.json' | head -c 300
   ```
