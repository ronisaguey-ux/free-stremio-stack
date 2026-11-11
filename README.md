# free-stremio-stack

A self-hosted Stremio stack that shows **one row per episode** and does all the
choosing on the server: highest quality first, dead and lonely sources skipped,
the rest kept as a fallback list.

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
for three separate reasons, and each one looks like "it hangs":

- the player renders and scores every result before you can pick;
- P2P results may have no peers, so the "best" row buffers forever;
- a **browser has no torrent engine at all**, so without a streaming server every
  torrent row stalls no matter how fast the addons are.

This stack fixes all three. The hub merges the sources, the streaming server makes
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
if you install it too, you get the list you were trying to escape.

## Install in Stremio

| Client | Where |
| --- | --- |
| Web | `https://web.stremio.com` → Addons → paste `PUBLIC_URL/manifest.json` |
| Desktop | Addons → Install from URL |
| Android TV / Fire TV | Stremio app → Addons → Add addon by URL |
| Phone | same as desktop |

The addon is reachable only on your network unless you front it with a reverse
proxy; it holds no credentials of its own.

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

## Endpoints

| Path | Purpose |
| --- | --- |
| `/manifest.json` | Addon manifest (`stream` resource only) |
| `/stream/<type>/<id>.json` | One stream: the best candidate for that title |
| `/play/<type>/<id>` | Probe the ranked list, then 302 to the first source that answers |

## Troubleshooting

**It hangs and never plays.**
Nine times in ten the player was handed `127.0.0.1:11470`. Check `STREAMING_URL`
is the LAN address. Second cause: a torrent with no peers — the ranking already
demotes those, but `MIN_SEEDERS=0` disables that protection.

**No streams at all.**
`curl "<PUBLIC_URL>/stream/series/tt4975856:1:1.json"` — an empty `streams` array
means the hub has nothing, and the hub is where to look:
`curl "<HUB_URL_BASE>/stream/series/tt4975856:1:1.json"`. If that is empty too,
your sources do not cover the title.

**The wrong title plays.**
Check the id. `curl https://v3-cinemeta.strem.io/meta/series/tt<id>.json`
confirms what the show actually is — a wrong IMDb id silently returns zero
results from every addon and looks exactly like a broken stack.

**A sign-in clip plays instead of the film.**
That source returns a placeholder URL (`signin.mp4`). It is filtered by name;
if a new placeholder appears, add it to `PLACEHOLDER` in `addon/server.js`.

**The 4K row buffers, the 1080p row does not.**
That is the swarm, not the addon: `MIN_SEEDERS` exists for exactly this.

## Notes and limits

- A torrent cannot be probed cheaply; it is offered as-is and the streaming
  server (or the client's own engine) does the work. Direct links are probed
  before being handed over.
- Stremio retries the same URL when playback **fails**; that retry is what
  advances the fallback. If playback opens and stalls instead, re-selecting the
  row moves to the next source.
- No credentials are handled here. Debrid keys live in the hub's configuration.
- Everything stays inside your network; nothing is sent anywhere but to the
  sources you configured.

## Layout

```
addon/server.js       the failover addon (dependency-free Node)
addon/Dockerfile      alpine image
docker-compose.yml    hub + streaming server + addon
deploy/              systemd user unit
install.sh            rootless installer
docs/ARCHITECTURE.md  ranking keys and the fallback algorithm
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the ranking keys, the
placeholder rule, the browser/native split, and how the attempt counter walks
the list and wraps.
