// Torrent streaming sidecar for the Stremio addon.
//
// The engine that shipped with the stack never dialled a peer: every torrent it
// held sat at 0 sources and 0 connection attempts, so the panel had nothing to
// play and spun forever. This replaces it with one WebTorrent client, one
// torrent per infoHash, HTTP range serving, and a /ready endpoint the addon
// calls before it answers a stream: warm the swarm, select the episode, buffer
// the first megabytes, and report the throughput it actually achieved so the
// addon can refuse a source the swarm cannot feed.
const http = require('http');

let WebTorrent;

const PORT = Number(process.env.WT_PORT || 11471);
const TRACKERS = (process.env.WT_TRACKERS || [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'https://tracker.gbitt.info:443/announce',
].join(',')).split(',');

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|webm|ts)$/i;

let client;
const torrents = new Map();
const pending = new Map();
const started = Date.now();

function getTorrent(hash, budgetMs) {
  const key = String(hash).toLowerCase();
  if (torrents.has(key)) return Promise.resolve(torrents.get(key));
  if (pending.has(key)) return pending.get(key);
  const budget = Math.max(1000, Math.min(Number(budgetMs) || 30000, 60000));
  const promise = new Promise((resolve, reject) => {
    const torrent = client.add(key, { announce: TRACKERS });
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error('no metadata yet'));
    }, budget);
    const done = (err) => {
      clearTimeout(timer);
      pending.delete(key);
      if (err) reject(err);
      else resolve(torrent);
    };
    torrent.on('metadata', () => {
      torrents.set(key, torrent);
      console.log(`metadata ${key} files=${torrent.files.length} peers=${torrent.numPeers}`);
      done(null);
    });
    torrent.on('error', (err) => done(err));
  });
  pending.set(key, promise);
  return promise;
}

// Which file inside the pack is the one asked for: the episode by its SxxEyy
// name, else the biggest video (a film pack carries a sample beside it).
function pickIndex(torrent, idx, id) {
  const files = torrent.files || [];
  if (Number.isInteger(idx) && idx >= 0 && idx < files.length) return idx;
  const series = /:(\d+):(\d+)$/.exec(String(id || ''));
  if (series) {
    const season = Number(series[1]);
    const episode = Number(series[2]);
    const wanted = [
      new RegExp(`S0*${season}E0*${episode}\\b`, 'i'),
      new RegExp(`\\b${season}x0*${episode}\\b`, 'i'),
    ];
    const at = files.findIndex((file) => wanted.some((pattern) => pattern.test(String(file.name || ''))));
    if (at >= 0) return at;
  }
  let best = 0;
  let longest = -1;
  files.forEach((file, index) => {
    if (!VIDEO.test(String(file.name || ''))) return;
    const length = Number(file.length || 0);
    if (length > longest) {
      longest = length;
      best = index;
    }
  });
  return best;
}

function selectOnly(torrent, index) {
  torrent.files.forEach((file, i) => {
    try {
      if (i === index) file.select();
      else file.deselect();
    } catch (_) {}
  });
}

function bufferedOf(torrent, index) {
  const file = torrent.files[index];
  if (!file) return 0;
  const length = Number(file.length || 0);
  if (typeof file.progress === 'number' && file.progress > 0) return file.progress * length;
  const overall = typeof torrent.progress === 'number' ? torrent.progress : 0;
  return overall * length;
}

function contentFor(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['mp4', 'm4v'].includes(ext)) return 'video/mp4';
  if (ext === 'mkv') return 'video/x-matroska';
  if (ext === 'avi') return 'video/x-msvideo';
  if (ext === 'webm') return 'video/webm';
  return 'application/octet-stream';
}

function json(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(payload));
}

function statsShape() {
  const out = {};
  for (const [hash, torrent] of torrents) {
    out[hash] = {
      peers: torrent.numPeers,
      wires: torrent.wires.map((wire) => ({ downSpeed: wire.downloadSpeed ? wire.downloadSpeed() : 0 })),
      files: torrent.files.map((file) => ({ name: file.name, length: file.length })),
    };
  }
  return out;
}

async function handleWarm(res, hash, budget) {
  try {
    const torrent = await getTorrent(hash, budget);
    json(res, 200, {
      ok: true,
      hash: String(hash).toLowerCase(),
      peers: torrent.numPeers,
      files: torrent.files.length,
      progress: Number(torrent.progress.toFixed(5)),
    });
  } catch (err) {
    json(res, 503, { ok: false, hash: String(hash).toLowerCase(), error: String(err.message || err) });
  }
}

// Warm, select the file, buffer the first megabytes, and measure what the swarm
// really delivers. A source that cannot beat the bitrate the file needs is a
// stream that stalls every few seconds, and the addon needs the number to know.
async function handleReady(res, hash, url) {
  const budget = Math.max(4000, Math.min(Number(url.searchParams.get('ms')) || 20000, 45000));
  const wantBytes = Math.max(1, Number(url.searchParams.get('mb')) || 6) * 1024 * 1024;
  const idxParam = url.searchParams.get('idx');
  const idx = idxParam === null || idxParam === '' ? null : Number(idxParam);
  const id = url.searchParams.get('id') || '';
  const began = Date.now();
  let torrent;
  try {
    torrent = await getTorrent(hash, budget);
  } catch (err) {
    json(res, 503, { ok: false, hash: String(hash).toLowerCase(), error: String(err.message || err) });
    return;
  }
  const index = pickIndex(torrent, idx, id);
  selectOnly(torrent, index);
  const file = torrent.files[index];
  const sampleAt = Date.now();
  let speedSum = 0;
  let speedSamples = 0;
  while (Date.now() - began < budget) {
    speedSum += Number(torrent.downloadSpeed || 0);
    speedSamples += 1;
    if (bufferedOf(torrent, index) >= wantBytes) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const seconds = Math.max(1, (Date.now() - sampleAt) / 1000);
  const averageSpeed = speedSamples ? speedSum / speedSamples : Number(torrent.downloadSpeed || 0);
  const mbps = (averageSpeed * 8) / 1e6;
  json(res, 200, {
    ok: true,
    hash: String(hash).toLowerCase(),
    idx: index,
    name: file ? file.name : null,
    length: file ? Number(file.length) : 0,
    buffered: Math.round(bufferedOf(torrent, index)),
    peers: torrent.numPeers,
    mbps: Number(mbps.toFixed(2)),
    waitedMs: Date.now() - began,
  });
}

// Warm a batch of candidates, select the right file in each, and measure what
// each swarm really delivers over a fixed window. Measuring them together is
// deliberate: the addon deselects the losers the moment playback starts, so the
// winner gets the whole pipe, and a shared measurement still ranks the cheap
// bitrates above the expensive ones.
async function handleProbe(res, url) {
  const hashes = String(url.searchParams.get('hashes') || '').split(',').filter(Boolean).slice(0, 8);
  const idxList = String(url.searchParams.get('idx') || '').split(',');
  const id = url.searchParams.get('id') || '';
  const budget = Math.max(6000, Math.min(Number(url.searchParams.get('ms')) || 14000, 30000));
  if (!hashes.length) {
    json(res, 200, { ok: true, rows: [] });
    return;
  }
  const began = Date.now();
  const loaded = await Promise.all(hashes.map((hash) => getTorrent(hash, budget).catch(() => null)));
  const indexFor = (torrent, k) => {
    const raw = idxList[k];
    const idx = raw === '' || raw === undefined ? null : Number(raw);
    return pickIndex(torrent, idx, id);
  };
  loaded.forEach((torrent, k) => {
    if (!torrent) return;
    selectOnly(torrent, indexFor(torrent, k));
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  // Per-interval deltas, then the median. A torrent that has just been added
  // reports one burst of already-counted bytes, and an average over the window
  // turns that burst into a throughput no pipe could carry — the gate then
  // trusts a source that stalls. The median ignores the burst.
  const samples = loaded.map(() => []);
  let last = loaded.map((torrent) => (torrent ? Number(torrent.downloaded || 0) : 0));
  const windowMs = Math.max(4000, Math.min(8000, budget - (Date.now() - began)));
  const sampleAt = Date.now();
  const tick = 500;
  const ticks = Math.max(2, Math.floor(windowMs / tick));
  for (let step = 0; step < ticks; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, tick));
    loaded.forEach((torrent, k) => {
      if (!torrent) return;
      const now = Number(torrent.downloaded || 0);
      samples[k].push(Math.max(0, now - last[k]));
      last[k] = now;
    });
  }
  const seconds = Math.max(1, (Date.now() - sampleAt) / 1000);
  const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const rows = loaded.map((torrent, k) => {
    if (!torrent) return { hash: hashes[k], ok: false, mbps: 0 };
    const index = indexFor(torrent, k);
    const file = torrent.files[index];
    const delta = median(samples[k]) * (1000 / tick);
    return {
      hash: hashes[k],
      ok: true,
      idx: index,
      name: file ? file.name : null,
      length: file ? Number(file.length) : 0,
      peers: torrent.numPeers,
      mbps: Number(((delta * 8) / (seconds * 1e6)).toFixed(2)),
    };
  });
  json(res, 200, { ok: true, seconds: Number(seconds.toFixed(1)), rows });
}

// Commit to one source: drop every other torrent so the whole pipe feeds this
// one, select only the episode, and buffer a real cushion before the player
// asks for its first byte. A stream that starts with a minute in hand does not
// stall on the five-second dips.
async function handleCommit(res, url, hash) {
  const budget = Math.max(6000, Math.min(Number(url.searchParams.get('ms')) || 30000, 60000));
  const wantBytes = Math.max(2, Number(url.searchParams.get('mb')) || 12) * 1024 * 1024;
  const idxParam = url.searchParams.get('idx');
  const idx = idxParam === null || idxParam === '' ? null : Number(idxParam);
  const id = url.searchParams.get('id') || '';
  const key = String(hash).toLowerCase();
  const began = Date.now();
  let torrent;
  try {
    torrent = await getTorrent(key, budget);
  } catch (err) {
    json(res, 503, { ok: false, hash: key, error: String(err.message || err) });
    return;
  }
  // Everything else is competing for the same peers and the same pipe.
  for (const [other, held] of [...torrents.entries()]) {
    if (other === key) continue;
    try {
      client.remove(other, { destroyStore: false });
      torrents.delete(other);
      console.log(`commit ${key.slice(0, 8)}: dropped ${other.slice(0, 8)}`);
    } catch (err) {
      console.log(`commit drop failed ${other.slice(0, 8)}: ${err && err.message}`);
    }
  }
  const index = pickIndex(torrent, idx, id);
  selectOnly(torrent, index);
  const file = torrent.files[index];
  await new Promise((resolve) => setTimeout(resolve, 500));
  const sampleAt = Date.now();
  const base = Number(torrent.downloaded || 0);
  let best = 0;
  let gained = 0;
  while (Date.now() - began < budget) {
    gained = Math.max(0, Number(torrent.downloaded || 0) - base);
    const seconds = Math.max(1, (Date.now() - sampleAt) / 1000);
    const rate = (gained * 8) / (seconds * 1e6);
    if (rate > best) best = rate;
    if (gained >= wantBytes) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  json(res, 200, {
    ok: true,
    hash: key,
    idx: index,
    name: file ? file.name : null,
    length: file ? Number(file.length) : 0,
    buffered: Math.round(gained),
    wanted: Math.round(wantBytes),
    peers: torrent.numPeers,
    mbps: Number(best.toFixed(2)),
    waitedMs: Date.now() - began,
  });
}

async function handleFile(req, res, hash, index) {
  let torrent;
  try {
    torrent = await getTorrent(hash, 30000);
  } catch (err) {
    res.writeHead(503, { 'content-type': 'text/plain' }).end(String(err.message || err));
    return;
  }
  const file = torrent.files[index];
  if (!file) {
    res.writeHead(404).end('no such file');
    return;
  }
  selectOnly(torrent, index);

  const headers = { 'content-type': contentFor(file.name), 'accept-ranges': 'bytes' };
  const range = req.headers.range;
  const total = file.length;
  let stream;
  if (range) {
    const [fromRaw, toRaw] = String(range).replace('bytes=', '').split('-');
    const from = Number(fromRaw || 0);
    const to = toRaw ? Math.min(Number(toRaw), total - 1) : Math.min(from + 4 * 1024 * 1024, total - 1);
    headers['content-range'] = `bytes ${from}-${to}/${total}`;
    headers['content-length'] = to - from + 1;
    res.writeHead(206, headers);
    stream = file.createReadStream({ start: from, end: to });
  } else {
    headers['content-length'] = total;
    res.writeHead(200, headers);
    stream = file.createReadStream();
  }
  // A player that seeks away closes the socket mid-read, the stream errors with
  // PREMATURE_CLOSE, and an unhandled 'error' takes the whole process down:
  // systemd restarts it, every torrent is dropped, and the panel hangs again.
  stream.on('error', (err) => {
    console.log(`stream aborted ${hash}/${index}: ${err.code || err.message}`);
    try { res.destroy(); } catch (_) {}
  });
  res.on('close', () => { try { stream.destroy(); } catch (_) {} });
  stream.pipe(res);
}

function start() {
  client = new WebTorrent();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/healthz') {
      json(res, 200, {
        up: Math.round((Date.now() - started) / 1000),
        torrents: [...torrents.entries()].map(([hash, t]) => ({
          hash,
          peers: t.numPeers,
          downloaded: t.downloaded,
          files: t.files.length,
          progress: Number(t.progress.toFixed(5)),
        })),
      });
      return;
    }

    // The old engine's shape, which the addon reads to resolve an episode's file
    // index inside a season pack.
    if (url.pathname === '/stats.json') {
      json(res, 200, statsShape());
      return;
    }

    if (parts[0] === 'warm' && parts[1]) {
      await handleWarm(res, parts[1], url.searchParams.get('ms'));
      return;
    }

    if (parts[0] === 'commit' && parts[1]) {
      await handleCommit(res, url, parts[1]);
      return;
    }

    if (parts[0] === 'probe') {
      await handleProbe(res, url);
      return;
    }

    if (parts[0] === 'ready' && parts[1]) {
      await handleReady(res, parts[1], url);
      return;
    }

    const hash = parts[0];
    const index = Number(parts[1] || 0);
    if (!hash || !/^[0-9a-f]{40}$/i.test(hash)) {
      res.writeHead(400).end('bad hash');
      return;
    }
    await handleFile(req, res, hash.toLowerCase(), index);
  });

  server.listen(PORT, '0.0.0.0', () => console.log(`webtorrent streamer on :${PORT}`));
}

// Nothing a single stream does may kill the process.
process.on('uncaughtException', (err) => console.log('uncaught', err && err.code, err && err.message));
process.on('unhandledRejection', (err) => console.log('unhandled', err && err.message));

(async () => {
  const mod = await import('webtorrent');
  WebTorrent = mod.default || mod;
  start();
})().catch((err) => {
  console.error('webtorrent failed to load', err);
  process.exit(1);
});
