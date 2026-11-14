'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const mod = require('../server');

function listen(srv) {
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function closeSrv(srv) {
  return new Promise((resolve) => srv.close(() => resolve()));
}

async function fetchJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

async function withMockStack(handlers, envOverrides, fn) {
  const hubSrv = http.createServer(handlers.hub);
  const streamSrv = http.createServer(handlers.streaming);
  const hubUrl = await listen(hubSrv);
  const streamUrl = await listen(streamSrv);

  const port = 30000 + Math.floor(Math.random() * 15000);
  const addonUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: addonUrl,
      HUB_URL: `${hubUrl}/manifest.json`,
      STREAMING_URL: streamUrl,
      STREAMING_PUBLIC_URL: 'http://192.168.86.37:11470',
      PROBE_MS: '500',
      STREAM_PROBE_MS: '1200',
      DELIVERS_MS: '800',
      DELIVERS_MIN_BYTES: '64',
      PLAYABLE_BYTES_PER_SEC: '1000',
      WARM_HOLD_MS: '500',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    // Wait for /manifest.json
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${addonUrl}/manifest.json`);
        if (r.ok) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 80));
    }
    return await fn({ addonUrl, hubUrl, streamUrl });
  } finally {
    child.kill('SIGKILL');
    await Promise.all([closeSrv(hubSrv), closeSrv(streamSrv)]);
  }
}

test('unit helpers: decodeId, resolveEngineBase, requestPublicBase, rank', () => {
  assert.equal(mod.decodeId('tt2193021%3A1%3A4'), 'tt2193021:1:4');
  assert.equal(mod.decodeId('tt2193021%253A1%253A4'), 'tt2193021:1:4');

  // Tunnel public URL must never leak into :11470 engine URL
  const fromTunnel = mod.resolveEngineBase('http://127.0.0.1:11470', 'https://stremio.helpotron.dpdns.org', '');
  assert.equal(fromTunnel.includes('stremio.helpotron.dpdns.org'), false);
  assert.match(fromTunnel, /^http:\/\/.+:11470$/);

  assert.equal(
    mod.resolveEngineBase('http://127.0.0.1:11470', 'http://192.168.86.37:3819', ''),
    'http://192.168.86.37:11470',
  );
  assert.equal(
    mod.resolveEngineBase('http://127.0.0.1:11470', 'https://stremio.helpotron.dpdns.org', 'http://192.168.86.49:11470'),
    'http://192.168.86.49:11470',
  );

  assert.equal(
    mod.requestPublicBase({ headers: { host: 'stremio.helpotron.dpdns.org', 'x-forwarded-proto': 'https' } }),
    'https://stremio.helpotron.dpdns.org',
  );

  const av1 = { name: 'T 1080p', title: 'Show.1080p.BluRay.AV1.DDP5.1', description: '👥 50', infoHash: 'a'.repeat(40) };
  const h264 = { name: 'T 1080p', title: 'Show.1080p.BluRay.H.264.DDP5.1', description: '👥 20', infoHash: 'b'.repeat(40) };
  assert.ok(mod.better(h264, av1) < 0, 'H264 must outrank AV1 for Fire TV');

  const truehd = { name: 'T 1080p', title: 'Show.1080p.TrueHD', description: '👥 80', infoHash: 'c'.repeat(40) };
  assert.ok(mod.better(h264, truehd) < 0, 'DDP must outrank TrueHD');
});

test('delivers follows 307 redirect and fails on 500 or insufficient bytes', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(307, { Location: '/ok' });
      res.end();
    } else if (req.url === '/ok') {
      res.writeHead(206, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.alloc(2048, 0x41));
    } else if (req.url === '/err500') {
      res.writeHead(500);
      res.end('fail');
    } else {
      res.writeHead(200);
      res.end(Buffer.alloc(10, 0x42));
    }
  });
  const base = await listen(srv);
  try {
    assert.equal(await mod.delivers(`${base}/redir`, 1024, 2000), true);
    assert.equal(await mod.alive(`${base}/redir`), true);
    assert.equal(await mod.delivers(`${base}/err500`, 1024, 2000), false);
    assert.equal(await mod.delivers(`${base}/tiny`, 1024, 2000), false);
  } finally {
    await closeSrv(srv);
  }
});

test('/healthz reports ok=true when healthy and 503 when streaming server returns 500', async () => {
  let streamHealthy = true;
  await withMockStack(
    {
      hub: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'hub.test', resources: ['stream'] }));
      },
      streaming: (req, res) => {
        if (!streamHealthy) {
          res.writeHead(500);
          res.end('down');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ values: { serverVersion: '4.22.5' } }));
      },
    },
    {},
    async ({ addonUrl }) => {
      const okRes = await fetchJson(`${addonUrl}/healthz`);
      assert.equal(okRes.status, 200);
      assert.equal(okRes.body.ok, true);

      streamHealthy = false;
      const failRes = await fetchJson(`${addonUrl}/healthz`);
      assert.equal(failRes.status, 503);
      assert.equal(failRes.body.ok, false);
      assert.equal(failRes.body.streaming.ok, false);
    },
  );
});

test('/stream fails fast with empty streams (no hang/unverified fallback) when streaming returns 500 or dead swarm', async () => {
  const hashDead = '1'.repeat(40);
  await withMockStack(
    {
      hub: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          streams: [
            { name: '[P2P] Torrentio 1080p', title: 'Arrow.S01E04.1080p.WEB-DL.DDP5.1', description: '👤 20', infoHash: hashDead, fileIdx: 3 },
          ],
        }));
      },
      streaming: (req, res) => {
        if (req.url === '/stats.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ [hashDead]: { peers: 0, wires: [], files: [] } }));
          return;
        }
        res.writeHead(500);
        res.end('engine error');
      },
    },
    {},
    async ({ addonUrl }) => {
      const started = Date.now();
      const res = await fetchJson(`${addonUrl}/stream/series/tt2193021%3A1%3A4.json`);
      const elapsed = Date.now() - started;
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.streams, []);
      assert.ok(elapsed < 1000, `Expected fast failure < 1000ms, got ${elapsed}ms`);
    },
  );
});

test('/stream returns verified winning torrent with resolved series episode fileIdx even beyond top-4', async () => {
  const hashes = Array.from({ length: 6 }, (_, i) => String(i + 1).repeat(40));
  const bestHash = hashes[5]; // index 5: past slice(0, 4)!
  await withMockStack(
    {
      hub: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          streams: hashes.map((h, i) => ({
            name: '[P2P] Torrentio 1080p',
            title: `Arrow.S01.Pack.${i}.1080p.DDP5.1`,
            description: `👤 ${30 - i}`,
            infoHash: h,
            // omitted fileIdx to exercise season pack fileIndexFor lookup
          })),
        }));
      },
      streaming: (req, res) => {
        if (req.url === '/stats.json') {
          const stats = {};
          for (const h of hashes) {
            stats[h] = h === bestHash
              ? {
                peers: 8,
                wires: [{ downSpeed: 2000000 }],
                files: [
                  { name: 'Arrow.S01E01.mkv', length: 500000000 },
                  { name: 'Arrow.S01E04.mkv', length: 500000000 },
                ],
              }
              : { peers: 0, wires: [], files: [] };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(stats));
          return;
        }
        if (req.url.startsWith(`/${bestHash}/1`)) {
          res.writeHead(206, { 'Content-Type': 'video/x-matroska' });
          res.end(Buffer.alloc(4096, 0x1a));
          return;
        }
        // Note: initial probe uses /<hash>/ (fileIdx omitted)
        if (req.url.startsWith(`/${bestHash}/`)) {
          res.writeHead(200);
          res.end(Buffer.alloc(256, 0x00));
          return;
        }
        res.writeHead(500);
        res.end();
      },
    },
    {},
    async ({ addonUrl }) => {
      const res = await fetchJson(`${addonUrl}/stream/series/tt2193021%3A1%3A4.json`);
      assert.equal(res.status, 200);
      assert.equal(res.body.streams.length, 1);
      assert.equal(res.body.streams[0].url, `http://192.168.86.37:11470/${bestHash}/1`);

      // Second consecutive request hits streamChoice cache and must still return the winner (never [])
      const res2 = await fetchJson(`${addonUrl}/stream/series/tt2193021%3A1%3A4.json`);
      assert.equal(res2.status, 200);
      assert.equal(res2.body.streams.length, 1);
      assert.equal(res2.body.streams[0].url, `http://192.168.86.37:11470/${bestHash}/1`);
    },
  );
});

test('/stream falls back to verified direct HTTP 307 media link when torrents are dead', async () => {
  const hashDead = '9'.repeat(40);
  const mediaSrv = http.createServer((req, res) => {
    if (req.url === '/video.mp4') {
      res.writeHead(307, { Location: '/cdn/video.mp4' });
      res.end();
    } else if (req.url === '/cdn/video.mp4') {
      res.writeHead(206, { 'Content-Type': 'video/mp4' });
      res.end(Buffer.alloc(2048, 0x33));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const mediaBase = await listen(mediaSrv);
  try {
    await withMockStack(
      {
        hub: (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            streams: [
              { name: '[P2P] Torrentio 1080p', title: 'Dead.1080p', description: '👤 5', infoHash: hashDead, fileIdx: 0 },
              { name: 'DirectMP4', title: 'Direct.1080p', url: `${mediaBase}/video.mp4` },
            ],
          }));
        },
        streaming: (req, res) => {
          if (req.url === '/stats.json') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({}));
            return;
          }
          res.writeHead(500);
          res.end();
        },
      },
      {},
      async ({ addonUrl }) => {
        const res = await fetchJson(`${addonUrl}/stream/movie/tt0111161.json`);
        assert.equal(res.status, 200);
        assert.equal(res.body.streams.length, 1);
        assert.equal(res.body.streams[0].url, `${mediaBase}/video.mp4`);
      },
    );
  } finally {
    await closeSrv(mediaSrv);
  }
});
