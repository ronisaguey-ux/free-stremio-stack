// Torrent streaming sidecar for the Stremio addon.
//
// The engine that shipped with the stack never dialled a peer: every torrent it
// held sat at 0 sources and 0 connection attempts, so the panel had nothing to
// play and spun forever. This replaces it with one WebTorrent client, one
// torrent per infoHash, HTTP range serving, and a /warm endpoint the addon
// calls before it answers a stream so the player starts with data already
// flowing instead of waiting for a cold swarm.
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
  // One episode per request: deselect the rest of the pack so the swarm's
  // pieces come down for the file the player is actually watching.
  torrent.files.forEach((f, i) => {
    try {
      if (i === index) f.select();
      else f.deselect();
    } catch (_) {}
  });

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
  WebTorrent = WebTorrent || require('webtorrent');
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

    if (parts[0] === 'warm' && parts[1]) {
      await handleWarm(res, parts[1], url.searchParams.get('ms'));
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
