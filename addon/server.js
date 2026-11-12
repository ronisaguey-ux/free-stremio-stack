#!/usr/bin/env node
'use strict';
// AIOStream: one entry in Stremio, all the choice moved into the backend.
//
// Stremio shows a single "AIOStream" row per episode. Clicking it asks this
// server for that title, which fetches the AIOStreams hub, ranks the results by
// quality and then by measured latency, and redirects to the best one that
// actually answers. A second attempt for the same title walks further down the
// list, so a dead source costs one retry instead of a menu.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3819);
const PUBLIC = process.env.PUBLIC_URL || 'http://192.168.86.49:3819';
const HUB = process.env.HUB_URL;           // .../manifest.json
const STREAMING = process.env.STREAMING_URL || 'http://127.0.0.1:11470';
// A dead swarm answers nothing at all: 1.8s is long enough to know a torrent
// is not going to start and short enough that four of them in parallel stay
// under the player's patience.
const PROBE_MS = Number(process.env.PROBE_MS || 1800);
const WANT = Number(process.env.WANT || 40);
const MIN_SEEDERS = Number(process.env.MIN_SEEDERS || 3);
// Probing is a race, not a walk: PROBES candidates at a time, each given
// PROBE_MS, and the whole list abandoned after PROBE_DEADLINE_MS. A player that
// waits eight seconds still tries; one that waits thirty has already hung.
const PROBES = Number(process.env.PROBES || 24);
const PROBE_DEADLINE_MS = Number(process.env.PROBE_DEADLINE_MS || 7000);
// A source is playable when some wire is actually delivering: peers that never
// send look identical to a dead swarm to the player.
const PLAYABLE_BYTES_PER_SEC = Number(process.env.PLAYABLE_BYTES_PER_SEC || 600000);
const ADDON_NAME = 'AIOStream';

if (!HUB) {
  console.error('HUB_URL is required (the AIOStreams manifest URL)');
  process.exit(1);
}
const HUB_BASE = HUB.replace(/\/manifest\.json$/, '');

const attempts = new Map(); // "type:id" -> how far down the list we have walked

const QUALITY = ['2160p', '1440p', '1080p', '720p', '576p', '480p', '360p'];
const TIER = ['remux', 'bluray', 'web-dl', 'webrip', 'hdrip', 'dvdrip', 'hdtv', 'cam', 'ts'];

// A source that answers with a sign-in page or a placeholder clip is worse
// than no source: it plays, it looks like a film, and it is not one.
const PLACEHOLDER = /(signin|sign-in|login|signup|sign-up|placeholder|sample\.mp4)/i;
const MEDIA = /\.(mp4|mkv|avi|webm|m3u8|ts)(\?|$)/i;

function isPlaceholder(stream) {
  const url = stream.url || '';
  return PLACEHOLDER.test(url);
}

function isMediaLink(stream) {
  return Boolean(stream.url) && MEDIA.test(stream.url) && !isPlaceholder(stream);
}

function seedersOf(stream) {
  return Number(
    (/(?:👥|👤|seeders?[:\s]+)\s*(\d+)/.exec(`${stream.title || ''} ${stream.description || ''}`) || [])[1] || 0,
  );
}

function rank(stream, browser) {
  const text = `${stream.name || ''} ${stream.title || ''} ${stream.description || ''}`.toLowerCase();
  // A browser cannot decode HEVC at all and 10-bit HEVC in no case: the stream
  // opens, the player shows nothing, and it looks like the addon hung.
  const heavy = browser && /(hevc|h\.?265|x265|10 ?bit)/i.test(text);
  const q = QUALITY.findIndex((token) => text.includes(token));
  const t = TIER.findIndex((token) => text.includes(token));
  const p2p = isMediaLink(stream) ? 0 : 1;     // a real file link starts sooner than a swarm
  // The hub writes the swarm size in the description, not the title.
  const seeders = seedersOf(stream);
  // A 4K torrent with two peers is not the "highest quality" anything: it is a
  // buffer. A swarm nobody is in is demoted below every source people are
  // actually seeding, however good its resolution reads.
  const lonely = stream.infoHash && seeders < MIN_SEEDERS ? 1 : 0;
  return [lonely, heavy ? 1 : 0, q === -1 ? 99 : q, t === -1 ? 99 : t, p2p, -seeders];
}

function better(a, b) {
  const ra = rank(a, a.browser);
  const rb = rank(b, b.browser);
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return ra[i] - rb[i];
  }
  return 0;
}

function get(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: { 'user-agent': 'aio-failover/1.0', accept: 'application/json' },
    }, (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// A torrent the streaming server has loaded still has to carry bytes. A swarm
// of three peers can deliver four kilobytes a second, and the player sits on a
// spinner for a minute before it gives up. So the first kilobytes are read here
// first: a source that cannot deliver them in a few seconds is treated as dead
// and the next one is tried, before the player ever sees a URL.
function delivers(url, need, within) {
  return new Promise((resolve) => {
    const started = Date.now();
    let got = 0;
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: { range: 'bytes=0-262143', 'user-agent': 'aio-failover/1.0' } }, (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        resolve(false);
        return;
      }
      res.on('data', (chunk) => {
        got += chunk.length;
        if (got >= need) {
          req.destroy();
          resolve(true);
        }
      });
      res.on('end', () => resolve(got >= need));
    });
    const timer = setInterval(() => {
      if (Date.now() - started > within) {
        clearInterval(timer);
        req.destroy();
        resolve(got >= need);
      }
    }, 200);
    req.on('error', () => {
      clearInterval(timer);
      resolve(false);
    });
    req.on('close', () => clearInterval(timer));
  });
}

// A cold torrent has no bytes to give for several seconds — the streaming server
// is still fetching metadata and its first peers — so a byte-count probe calls a
// perfectly good source dead and the list is walked for nothing. The server's
// own stats say whether the swarm has anyone in it, which is the fact that
// decides, and it answers in milliseconds.
function swarmAlive(target) {
  const match = /^https?:\/\/[^/]+\/([0-9a-f]{40})\//i.exec(target);
  if (!match) return Promise.resolve(null);
  const hash = match[1].toLowerCase();
  return new Promise((resolve) => {
    const req = http.get(`${STREAMING}/stats.json`, { timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const stats = JSON.parse(body)[hash];
          if (!stats) return resolve(null);
          const peers = Number(stats.peers || 0);
          const unchoked = Number(stats.unchoked || 0);
          resolve(peers > 0 && (unchoked > 0 || peers > 1));
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// A direct link is checked with a ranged GET: a dead host or a 403 must not be
// handed to the player, and a few kilobytes is enough to know the link is real.
function alive(url) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: { range: 'bytes=0-1', 'user-agent': 'aio-failover/1.0' },
    }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.setTimeout(PROBE_MS, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function candidates(type, id, browser) {
  const body = await get(`${HUB_BASE}/stream/${type}/${id}.json`, 15000);
  const EPISODE = /\bS\d{1,2}E\d{1,3}\b|\b\d{1,2}x\d{1,2}\b|\bSeason[ ._-]?\d{1,2}\b/i;
  const streams = (body.streams || [])
    .filter((stream) => stream.url || stream.infoHash)
    .filter((stream) => !isPlaceholder(stream))
    // A movie id answered with a season pack is a spinner waiting to happen: the
    // swarm is healthy and the episode is still unseeded at the offset the
    // player seeks to. They are not dropped — sometimes an index maps a series
    // id as a movie and they are all there is — but they queue behind anything
    // that looks like the title itself.
    .map((stream) => {
      const name = `${stream.name || ''} ${stream.title || ''} ${stream.description || ''} ${
        (stream.behaviorHints && stream.behaviorHints.filename) || ''
      }`;
      return { ...stream, episode: type === 'movie' && EPISODE.test(name) };
    })
    .sort((left, right) => Number(left.episode) - Number(right.episode))
    .map((stream) => ({ ...stream, browser }));
  streams.sort(better);
  return streams.slice(0, WANT);
}

function playUrl(stream) {
  if (stream.url) return stream.url;
  const name = (stream.behaviorHints && stream.behaviorHints.filename) || '';
  const file = stream.fileIdx === undefined ? '' : `/${stream.fileIdx}`;
  const trackers = (stream.sources || [])
    .filter((source) => typeof source === 'string' && source.startsWith('tracker:'))
    .map((source) => source.slice(8));
  const query = trackers.length ? `?tr=${encodeURIComponent(trackers.join(','))}` : '';
  return `${STREAMING}/${stream.infoHash}${file}/${encodeURIComponent(name)}${query}`;
}

// Which of these torrents has anyone in it, asked of the engine rather than of
// the hub. A ranged GET is what starts an engine, so the first few candidates
// are loaded at once and their stats are polled until one reports peers or the
// budget runs out. Nothing is awaited in series: the answer costs the slowest
// load, not the sum of them.
async function firstLive(list, orderUnsorted) {
  let order = orderUnsorted;
  const probeWindow = Number(process.env.LIVE_WINDOW_MS || 10000);
  // The hub's own count is a cheap ordering hint: a torrent the hub believes has
  // thirty seeders is a better first guess than one it lists as empty, even
  // though only the engine can decide.
  order = [...order].sort((left, right) => seedersOf(list[right]) - seedersOf(list[left]));
  const loaded = [];
  for (const at of order) {
    const stream = list[at];
    if (stream.url || !stream.infoHash) continue;
    const target = playUrl(stream);
    const match = /^https?:\/\/[^/]+\/([0-9a-f]{40})\//i.exec(target);
    if (!match) continue;
    loaded.push({ at, target, hash: match[1].toLowerCase() });
    if (loaded.length >= PROBES) break;
  }
  if (!loaded.length) return null;
  // A ranged request that closes at once reads as an abandoned download and the
  // engine is torn down before it ever finds a peer. These stay open for the
  // whole window — that is what a player does — and are dropped once the answer
  // is known.
  const open = [];
  for (const item of loaded) {
    const req = http.get(item.target, { headers: { 'user-agent': 'aio-failover/1.0' } });
    req.on('error', () => {});
    req.setTimeout(probeWindow + 2000, () => req.destroy());
    open.push({ req, hash: item.hash });
  }
  // Everything but the winner is dropped. The winner's request is left open on
  // purpose: it is what warmed the engine, and tearing it down makes the player
  // pay the cold start all over again — a spinner that ends as "failed to play".
  const close = (keepHash) => {
    for (const { req, hash } of open) {
      if (hash === keepHash) continue;
      try { req.destroy(); } catch (_) {}
    }
  };
  const deadline = Date.now() + probeWindow;
  let best = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stats = await readStats();
    if (!stats) continue;
    for (const item of loaded) {
      const row = stats[item.hash];
      if (!row) continue;
      const peers = Number(row.peers || 0);
      // A peer that never sends is not a source: the wires carry the rate, and
      // a torrent whose only peer is silent looks exactly like a dead one to a
      // player. 200 KB/s is past what a 1080p stream needs to start.
      const rate = (row.wires || []).reduce(
        (most, wire) => Math.max(most, Number(wire.downSpeed || 0)),
        0,
      );
      if (peers > 0 && rate >= PLAYABLE_BYTES_PER_SEC) {
        if (!best || rate > best.rate) best = { ...item, peers, rate };
      }
    }
    // The rate is the swarm's, not this file's: a season pack can have fast
    // peers and no complete copy of the episode that was asked for. So the
    // fastest few are asked for their first kilobytes before one is handed over.
    if (best) {
      close();
      const want = loaded.slice(0, 4);
      const race = await Promise.all(
        want.map(async (item) => ((await delivers(item.target, 16 * 1024, 6000)) ? item : null)),
      );
      const winner = race.find(Boolean);
      // Report the winner's own swarm rate, not a placeholder: the log is how the
      // next slow start gets diagnosed instead of guessed at.
      if (winner) {
        const row = (stats && stats[winner.hash]) || {};
        const rate = (row.wires || []).reduce((most, wire) => Math.max(most, Number(wire.downSpeed || 0)), 0);
        return { ...winner, peers: Number(row.peers || 0), rate };
      }
      return best;
    }
  }
  close();
  return best;
}

function readStats() {
  return new Promise((resolve) => {
    const req = http.get(`${STREAMING}/stats.json`, { timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC);
  const path = url.pathname;

  try {
    if (path === '/manifest.json') {
      const manifest = {
        id: 'org.aiostre.am',
        version: '1.0.0',
        name: ADDON_NAME,
        description: 'One stream per title: the best source that answers, with a fallback list behind it.',
        resources: ['stream'],
        types: ['movie', 'series'],
        idPrefixes: ['tt'],
        catalogs: [],
      };
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(manifest));
      return;
    }

    const streamMatch = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamMatch) {
      const [, type, id] = streamMatch;
      const uaStream = String(req.headers['user-agent'] || '');
      const isBrowser = /Chrome|Mozilla|Safari|Firefox/i.test(uaStream);
      const list = await candidates(type, id, isBrowser);
      if (!list.length) {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ streams: [] }));
        return;
      }
      const top = list[0];
      const label = `${ADDON_NAME} · ${(top.name || '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 28)}`;
      // A native client has its own torrent engine and plays peer to peer far
      // better than a LAN hop through this host's streaming server. A browser
      // has none, so it gets the redirect. The user agent is the only signal a
      // Stremio addon is given about who is asking.
      const ua = String(req.headers['user-agent'] || '');
      const native = /Stremio/i.test(ua) && !/Chrome|Mozilla|Safari/i.test(ua);
      const streams = [native
        ? { ...top, name: ADDON_NAME, title: label, behaviorHints: { bingeGroup: 'aiostre-am' } }
        : {
            name: ADDON_NAME,
            title: label,
            url: `${PUBLIC}/play/${type}/${encodeURIComponent(id)}`,
            behaviorHints: { notWebReady: false, bingeGroup: 'aiostre-am' },
          }];
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ streams }));
      return;
    }

    const playMatch = path.match(/^\/play\/([^/]+)\/(.+)$/);
    if (playMatch) {
      const [, type, rawId] = playMatch;
      const id = decodeURIComponent(rawId);
      const key = `${type}:${id}`;
      const list = await candidates(type, id, true);
      if (!list.length) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('no sources');
        return;
      }
      const now = Date.now();
      const last = attempts.get(key);
      // A player often asks twice for the same title within a second (manifest
      // probe, then play). Treating that as a failure skipped a good source and
      // walked the list for no reason.
      let start = last && now - last.at < 4000 ? last.index : (last ? last.index : 0);
      // Probed in parallel, not one after another: a dead swarm costs its own
      // probe and nothing else. Twelve candidates at 2.5s each in series is
      // thirty seconds of spinner, and the player gives up long before the
      // list is walked.
      const order = list.map((_, step) => (start + step) % list.length);
      // The hub's seed count is a claim about a swarm, not about this machine: a
      // Torrentio result can say thirty-three seeders while the engine finds
      // nobody. The engine's own stats are the fact, so a few torrents are
      // loaded at once and the first one that reports peers is the answer.
      const live = await firstLive(list, order);
      if (live) {
        attempts.set(key, { index: live.at + 1, at: Date.now() });
        // The player keys its resume position off the URL. The device was
        // resuming 1.5 GB into an episode and waiting for a piece the swarm did
        // not have, which is a spinner with no error. A fresh nonce makes each
        // play a new stream, so it starts at zero.
        const fresh = `${live.target}${live.target.includes('?') ? '&' : '?'}n=${Date.now()}`;
        console.log(`play ${key} -> #${live.at} ${live.peers} peers ${Math.round(live.rate / 1024)} KB/s ${live.target.slice(0, 60)}`);
        res.writeHead(302, { location: fresh, 'access-control-allow-origin': '*' });
        res.end();
        return;
      }
      const deadline = Date.now() + PROBE_DEADLINE_MS;
      let winner = null;
      let cursor = 0;
      const probe = async () => {
        while (!winner && Date.now() < deadline) {
          const step = cursor;
          cursor += 1;
          if (step >= order.length) return;
          const at = order[step];
          const stream = list[at];
          const target = playUrl(stream);
          let ok;
          if (stream.url) {
            ok = await alive(target);
          } else {
            // The swarm first, the bytes second: stats is instant, a cold
            // torrent is not.
            const swarm = await swarmAlive(target);
            ok = swarm === null ? await delivers(target, 32 * 1024, PROBE_MS) : swarm;
          }
          if (ok) {
            if (!winner) winner = { at, target };
            return;
          }
          console.log(`dead ${key} #${at} ${target.slice(0, 90)}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PROBES, order.length) }, probe));
      if (winner) {
        attempts.set(key, { index: winner.at + 1, at: Date.now() });
        console.log(`play ${key} -> #${winner.at} ${winner.target.slice(0, 90)}`);
        res.writeHead(302, { location: winner.target, 'access-control-allow-origin': '*' });
        res.end();
        return;
      }
      attempts.set(key, { index: start + 1, at: Date.now() });
      res.writeHead(504, { 'content-type': 'text/plain' });
      res.end('no source answered');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('hub error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`${ADDON_NAME} on ${PUBLIC} -> ${HUB_BASE}`);
});
