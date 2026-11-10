# free-stremio-stack

A self-hosted Stremio stack that shows **one row per episode** and does all the
choosing on the server: highest quality first, dead sources skipped, the rest
kept as a fallback list.

```
player  ──►  AIOStream (one addon, port 3819)
               │
               ├──►  AIOStreams hub (port 3817)  ──►  Torrentio, Comet, MediaFusion, PenguPlay
               │
               └──►  Stremio streaming server (port 11470)  ──►  torrents → playable bytes
```

## Why the extra layer

Stremio's normal behaviour is to hand you a list and let you scroll. That is
slow for three separate reasons:

- the player renders and scores every result before you can pick one;
- P2P results may have no peers at all, so the "best" row stalls;
- a web client has **no torrent engine**, so without a streaming server every
  torrent row stalls regardless of how fast the addons are.

This stack fixes all three: the hub merges the sources, the streaming server
makes torrents playable in a browser, and the addon ranks, probes and redirects
to one stream that is known to answer.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the ranking keys and the
fallback algorithm.

## Docker

```bash
cp .env.example .env
# fill BASE_URL, SECRET_KEY ($(openssl rand -hex 32)), PUBLIC_URL, HUB_URL
docker compose up -d
```

Then install the player addon at `PUBLIC_URL/manifest.json`.

## Without Docker for the addon

```bash
HUB_URL="http://<host>:3817/stremio/<uuid>/<token>/manifest.json" \
PUBLIC_URL="http://<host>:3819" \
./install.sh
```

That installs `addon/server.js` into `~/.local/share/aiostrem` and runs it as a
systemd user service (`aiostrem.service`). Node 18+ is the only requirement —
the addon has no dependencies.

## Getting `HUB_URL`

1. Open `http://<host>:3817/stremio/configure`.
2. Add your sources under **Installed → Add by URL**, set filters and sort order.
3. **Install Addon → Create**, save the configuration, and copy the manifest URL.

Give that URL to `HUB_URL`. Install **only** the AIOStream addon in your player —
the hub is a backend now, not something the player should see.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUB_URL` | — | AIOStreams manifest URL |
| `PUBLIC_URL` | — | Address players use to reach this addon |
| `STREAMING_URL` | `http://127.0.0.1:11470` | Stremio streaming server |
| `PORT` | `3819` | Listen port |
| `PROBE_MS` | `2500` | Direct-link probe timeout |
| `WANT` | `12` | Candidates kept for fallback |

## Endpoints

| Path | Purpose |
| --- | --- |
| `/manifest.json` | Addon manifest (`stream` resource only) |
| `/stream/<type>/<id>.json` | One stream: the best candidate |
| `/play/<type>/<id>` | Probe, then 302 to the first candidate that answers |

## Notes and limits

- A torrent cannot be probed cheaply; it is offered as-is and the streaming
  server does the work. Direct links are probed before being handed over.
- Stremio retries the same URL when playback **fails**; that retry is what
  advances the fallback. If playback opens and stalls instead, re-selecting the
  row moves to the next source.
- No credentials are handled here. Debrid keys live in the hub's configuration.
