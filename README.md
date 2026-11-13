# free-stremio-stack

A self-hosted Stremio stack that shows **one row per episode** and does all the
choosing on the server: a source that actually plays, in a language you speak,
with audio your device can decode. Dead swarms, silent codecs and foreign-only
releases are dropped before the player ever sees them.

Three containers, one addon, no accounts beyond your own.

```
player  ──►  AIOStream (one addon, port 3819)
               │
               ├──►  AIOStreams hub (port 3817)  ──►  Torrentio, Comet, MediaFusion, PenguPlay
               │
               └──►  Stremio streaming server (port 11470)  ──►  torrents → playable bytes
```

## Why the extra layer

Stremio's normal behaviour is to hand you a list and let you scroll. That is slow
for four separate reasons, and three of them look like "it hangs":

- the player renders and scores every result before you can pick;
- P2P results may have no peers, so the "best" row buffers forever;
- a **browser has no torrent engine at all**, so without a streaming server every
  torrent row stalls no matter how fast the addons are;
- the "best" row is often a 4K REMUX whose audio is TrueHD or DTS-HD, which a
  Fire TV cannot decode: the picture plays and the sound is silent with the
  volume at maximum.

This stack fixes all four. The hub merges the sources, the streaming server makes
torrents playable in a browser, and the addon ranks, filters and redirects — so
the player is told about one stream instead of forty.

## Quick start

### Docker (everything)

```bash
cp .env.example .env
# BASE_URL, SECRET_KEY (openssl rand -hex 32), PUBLIC_URL, HUB_URL, STREAMING_URL
docker compose up -d
docker compose logs -f aiostreams   # first start downloads its metadata databases
```

### Addon only, as a user service

```bash
HUB_URL="http://<host>:3817/stremio/<uuid>/<token>/manifest.json" \
PUBLIC_URL="http://<host>:3819" \
STREAMING_URL="http://<host>:11470" \
./install.sh
```

`install.sh` copies the addon to `~/.local/share/aiostrem`, writes
`aiostrem.service`, enables it, and prints the manifest URL to install. Node 18+
is the only requirement — the addon has no dependencies.

### Getting `HUB_URL`

1. Open `http://<host>:3817/stremio/configure`.
2. **Installed → Add by URL** for each source you want
   (`https://torrentio.strem.fun/manifest.json`,
   `https://comet.elfhosted.com/manifest.json`,
   `https://mediafusion.elfhosted.com/manifest.json`, `https://pengu.uk/manifest.json`).
3. Set filters and sort order.
4. **Install Addon → Create**, save the configuration, copy the manifest URL.

Install **only** the AIOStream addon in your player. The hub is a backend now —
if you install it too, you get the list you were trying to escape, and Stremio
keeps both entries forever because it keys addons by transport URL, not by name.

## Install in Stremio

| Client | Where |
| --- | --- |
| Web | `https://web.stremio.com` → Addons → paste `PUBLIC_URL/manifest.json` |
| Desktop | Addons → Install from URL |
| Android TV / Fire TV | Stremio app → Addons → Add addon by URL |
| Phone | same as desktop |

The addon is reachable only on your network unless you front it with a reverse
proxy; it holds no credentials of its own.

### A Fire TV needs https, so it needs a tunnel or a proxy

A Fire TV installs an addon only from an `https://` URL — its `stremio://`
handler rewrites the link to `https` before fetching. A plain `http://` addon on
the LAN therefore never installs by hand, and the error it gives is a generic
"cannot install". Two ways out:

1. a reverse proxy with a real certificate in front of port 3819, or
2. a Cloudflare quick tunnel (`cloudflared tunnel --url http://127.0.0.1:3819`),
   which gives a trusted `https://<random>.trycloudflare.com`.

`deploy/aiostrem-tv.sh` (+ `aiostrem-tv.service`) automates the second one,
including the part that matters: a quick-tunnel hostname **changes on every
restart**, and a changed hostname orphans the addon on the TV and leaves a dead
entry that stalls the stream panel. The loop keeps one tunnel alive and, when the
hostname changes, reinstalls the addon over adb:

```bash
adb connect <tv-ip>:5555         # Fire TV: enable ADB debugging first
adb shell am start -a android.intent.action.VIEW \
  -d "stremio://<tunnel-host>/manifest.json"
adb shell input tap <install-button-x> <install-button-y>
```

The tap is the same press a person makes; coordinates depend on the TV's
resolution, so check them once with a screenshot (`adb exec-out screencap -p`).

## What the addon decides

In order, per candidate:

1. **A source with no peers is demoted** below every source people are seeding
   (`MIN_SEEDERS`). A 4K torrent with two peers is a buffer, not a quality win.
2. **Audio that cannot be decoded is demoted below resolution.** If the release
   names AC3, EAC3, DDP, AAC, Opus or MP3, it wins over anything listing only
   TrueHD, Atmos, DTS-HD, DTS:X, FLAC or PCM. A 1080p AAC source beats a 4K
   TrueHD one every time, because the failure being avoided is silence.
3. **A foreign-only release is dropped.** A printed language line is
   authoritative; otherwise the release name is read for a standing foreign tag
   (ITA, FRE, VFF, GER, DEU, SPA, RUS, HIN, TAM, TEL, JPN, KOR, CHI, POL, TUR,
   SWE, NOR, DAN, DUT, POR, CZE, HUN, ROM, GRE, UKR, ARA, HEB, THA, VIE, MAY,
   IND) with no ENG, MULTI or DUAL beside it. Ambiguous names are kept — dropping
   what cannot be read would empty the list.
4. **Quality, then tier, then direct-link over swarm**, then seeders.

Subtitles are **not** a stream property: no source in the hub declares them, so
filtering on "has subtitles" would remove nearly every row. Install the
**OpenSubtitles v3** addon (`stremio://opensubtitles-v3.strem.io/manifest.json`)
alongside this one; then every title can fetch subtitles regardless of which
release played.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUB_URL` | — | AIOStreams manifest URL (the backend) |
| `PUBLIC_URL` | — | Address players use to reach the addon |
| `STREAMING_URL` | `http://127.0.0.1:11470` | Streaming server. **LAN address** if any player is remote — `127.0.0.1` on a TV means the TV |
| `PORT` | `3819` | Listen port |
| `PROBE_MS` | `2500` | Direct-link probe timeout |
| `WANT` | `12` | Candidates kept for the fallback walk |
| `MIN_SEEDERS` | `3` | Below this, a torrent drops under every well-seeded source |
| `LIVE_WINDOW_MS` | `20000` | How long `/play` waits for a candidate to report peers |

## Endpoints

| Path | Purpose |
| --- | --- |
| `/manifest.json` | Addon manifest (`stream` resource only) |
| `/stream/<type>/<id>.json` | One stream: the best candidate for that title |
| `/play/<type>/<id>` | Probe the ranked list, then 302 to the first source that answers |

Every request is logged as one line — timestamp, source address, user agent and
path — because "did the TV reach this box" is the first question in every one of
these investigations:

```bash
journalctl --user -u aiostrem -n 20 --no-pager | grep -v 'AIOStream on'
```

## Verifying it works

```bash
# the addon answers, and with what
curl -s -A "Stremio/1.6.0" "http://127.0.0.1:3819/stream/series/tt4975856:2:10.json" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['streams'])); print(d['streams'][0]['description'][:160])"

# the hub alone — if this is empty, the addon is not the problem
curl -s "http://127.0.0.1:3817/stremio/<uuid>/<token>/stream/series/tt4975856:2:10.json" | head -c 200
```

From the TV side, with adb:

```bash
adb shell am start -a android.intent.action.VIEW -d "stremio://detail/series/tt4975856"
adb exec-out screencap -p > /tmp/tv.png   # look, do not guess
```

## Troubleshooting

**It hangs and never plays.**
First check whether the player is waiting on an addon at all. Stremio's panel
prints `X addon is still loading...` while one addon has not answered, and it
**caches that failure for the session** — the fix is to remove the dead addon
entry, not to restart the stack. Addons are keyed by transport URL, so the same
addon installed twice (an old tunnel hostname, an old IP) leaves two entries and
one of them is dead. A dead entry whose host accepts TCP and never replies hangs
the panel indefinitely; a host that refuses fails fast and only costs a timeout.

Second cause, in the browser: the player was handed `127.0.0.1:11470`. Check
`STREAMING_URL` is the LAN address.
Third: a torrent with no peers — the ranking demotes those, but `MIN_SEEDERS=0`
disables that protection.

**No streams at all.**
`curl "<PUBLIC_URL>/stream/series/tt4975856:1:1.json"` — an empty `streams` array
means the hub has nothing, and the hub is where to look:
`curl "<HUB_URL_BASE>/stream/series/tt4975856:1:1.json"`. If that is empty too,
your sources do not cover the title.

**The panel says an addon is still loading, forever.**
That addon's transport is unreachable *and* unresponsive — it accepts the
connection and never answers, which is what a frozen host looks like. See "A host
can freeze without going offline" below.

**The wrong title plays.**
Check the id. `curl https://v3-cinemeta.strem.io/meta/series/tt<id>.json`
confirms what the show actually is — a wrong IMDb id silently returns zero
results from every addon and looks exactly like a broken stack.

**A sign-in clip plays instead of the film.**
That source returns a placeholder URL (`signin.mp4`). It is filtered by name;
if a new placeholder appears, add it to `PLACEHOLDER` in `addon/server.js`.

**The picture plays and there is no sound.**
The release carries TrueHD/Atmos/DTS-HD and the device cannot decode it. The
ranking already demotes those (with `clear` and `mute` in `rank()`); if it still
happens, the release named a decodable codec it does not actually contain, and
the audio track menu in the player is the way out.

**The 4K row buffers, the 1080p row does not.**
That is the swarm, not the addon: `MIN_SEEDERS` exists for exactly this.

## A host can freeze without going offline

Worth knowing, because it costs an evening if you misread it. A box can end up
with the kernel answering and no userland running (classically swap exhaustion):

- `ping` replies, 0% loss;
- TCP connects succeed on every listening port — the kernel completes handshakes;
- then nothing: `ssh` times out **during banner exchange**, `curl` returns
  `000` after the full timeout, every application is silent.

That is not a network problem and not a crash, and nothing can restart it from
the network. It needs a power cycle. Meanwhile the address can be served from
another machine, which is reversible:

```bash
# take the address on this box (host network + NET_ADMIN, no root login needed)
docker run --rm --network host --cap-add NET_ADMIN alpine \
  ip addr add 192.168.86.37/32 dev wlan0

# give it back
docker run --rm --network host --cap-add NET_ADMIN alpine \
  ip addr del 192.168.86.37/32 dev wlan0
```

`deploy/aiostrem-heal.sh` (+ `aiostrem-heal.service`) does exactly this: it
serves the frozen host's address, and the moment that host answers again it
removes the alias (two hosts answering one address is a coin toss for the TV)
and restarts the remote addon.

## Notes and limits

- A torrent cannot be probed cheaply; it is offered as-is and the streaming
  server (or the client's own engine) does the work. Direct links are probed
  before being handed over.
- Stremio retries the same URL when playback **fails**; that retry is what
  advances the fallback. If playback opens and stalls instead, re-selecting the
  row moves to the next source.
- A quick tunnel is a public hostname: anyone with the URL reaches the addon.
  It exposes no credentials and the hub's own token is in its path, but the
  manifest is reachable. Use a named tunnel or a reverse proxy if that matters.
- No credentials are handled here. Debrid keys live in the hub's configuration.
- Everything stays inside your network except the tunnel; nothing is sent
  anywhere but to the sources you configured.

## Layout

```
addon/server.js           the failover addon (dependency-free Node)
addon/Dockerfile          alpine image
docker-compose.yml        hub + streaming server + addon
deploy/aiostrem.service   the addon as a systemd user unit
deploy/aiostrem-tv.sh     tunnel + Fire TV install, kept in step
deploy/aiostrem-heal.sh   frozen-host address takeover and handback
install.sh                rootless installer
docs/ARCHITECTURE.md      ranking keys and the fallback algorithm
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the ranking keys, the
placeholder rule, the browser/native split, and how the attempt counter walks
the list and wraps.
