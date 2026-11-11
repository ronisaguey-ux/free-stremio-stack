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
const PROBE_MS = Number(process.env.PROBE_MS || 2500);
const WANT = Number(process.env.WANT || 12);
const MIN_SEEDERS = Number(process.env.MIN_SEEDERS || 3);
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

function rank(stream, browser) {
  const text = `${stream.name || ''} ${stream.title || ''} ${stream.description || ''}`.toLowerCase();
  // A browser cannot decode HEVC at all and 10-bit HEVC in no case: the stream
  // opens, the player shows nothing, and it looks like the addon hung.
  const heavy = browser && /(hevc|h\.?265|x265|10 ?bit)/i.test(text);
  const q = QUALITY.findIndex((token) => text.includes(token));
  const t = TIER.findIndex((token) => text.includes(token));
  const p2p = isMediaLink(stream) ? 0 : 1;     // a real file link starts sooner than a swarm
  // The hub writes the swarm size in the description, not the title.
  const seeders = Number(
    (/(?:👥|👤|seeders?[:\s]+)\s*(\d+)/.exec(`${stream.title || ''} ${stream.description || ''}`) || [])[1] || 0,
  );
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
  const streams = (body.streams || [])
    .filter((stream) => stream.url || stream.infoHash)
    .filter((stream) => !isPlaceholder(stream))
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
      for (let step = 0; step < list.length; step += 1) {
        const at = (start + step) % list.length;
        const stream = list[at];
        const target = playUrl(stream);
        const ok = stream.url ? await alive(target) : await delivers(target, 32 * 1024, 2500);
        if (ok) {
          attempts.set(key, { index: at + 1, at: Date.now() });
          console.log(`play ${key} -> #${at} ${target.slice(0, 90)}`);
          res.writeHead(302, { location: target, 'access-control-allow-origin': '*' });
          res.end();
          return;
        }
        console.log(`dead ${key} #${at} ${target.slice(0, 90)}`);
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
