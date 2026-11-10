# How AIOStream decides what you watch

The player is given one row per episode. Everything else — which sources exist,
which one is best, what happens when it dies — lives here, on the server.

## The three pieces

| Piece | Job |
| --- | --- |
| **AIOStreams** (hub) | Wraps Torrentio, Comet, MediaFusion, PenguPlay and friends, and answers with one merged list |
| **Stremio streaming server** | Turns a torrent infohash into bytes a browser can play. Without it a web client has no torrent engine at all |
| **AIOStream** (this addon) | The only addon the player sees: asks the hub, ranks, hands over one stream, keeps the rest as fallback |

## Ranking

Each candidate is scored on four keys, compared left to right:

1. **Resolution** — 2160p, 1440p, 1080p, 720p, 576p, 480p, 360p, then unknown.
2. **Quality tier** — remux, bluray, web-dl, webrip, hdrip, dvdrip, hdtv, cam, ts.
3. **Transport** — a direct HTTP link starts immediately; a torrent waits for peers.
4. **Seeders** — for torrents, more is sooner.

The list is truncated to `WANT` (default 12) before anything is handed out. The
first entry is what the player is told about; the rest are the fallback.

## Fallback

`/play/<type>/<id>` owns the failover:

1. Read the ranked list for that title.
2. Start at the attempt counter kept for that title.
3. For a direct link, probe it with a 2.5 s ranged GET. A dead host, a 403 or a
   timeout is skipped, never shown to the player.
4. For a torrent there is nothing to probe — the streaming server can only prove
   it by playing — so it is offered as-is.
5. Redirect (302) to the first candidate that passes, and move the counter past
   it so the next attempt for the same title continues down the list.

When every candidate has been tried the endpoint answers 504 and the counter
wraps, so a later retry starts from the top again rather than refusing forever.

## Why not just let the player choose

Because the choice is the slow part. A list means the player fetches metadata for
scores of results, renders them, and then picks one — and with P2P sources the
one they pick may have no peers. Ranking on the server and probing before
handing over moves that work off the critical path.

## Configuration

Everything is environment variables; see `.env.example` and `deploy/aiostrem.service`.

| Variable | Meaning |
| --- | --- |
| `HUB_URL` | The AIOStreams manifest URL (from its configure page) |
| `PUBLIC_URL` | The address players use to reach this addon |
| `STREAMING_URL` | Stremio streaming server address |
| `PROBE_MS` | Direct-link probe timeout, default 2500 |
| `WANT` | How many candidates to keep as fallback, default 12 |
