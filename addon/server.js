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
const os = require('os');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3819);
const PUBLIC = process.env.PUBLIC_URL || 'http://192.168.86.49:3819';
const HUB = process.env.HUB_URL || '';           // .../manifest.json
const STREAMING = (process.env.STREAMING_URL || 'http://127.0.0.1:11470').replace(/\/$/, '');
const STREAMING_PUBLIC = (process.env.STREAMING_PUBLIC_URL || '').replace(/\/$/, '');
// A dead swarm answers nothing at all: 1.8s is long enough to know a torrent
// is not going to start and short enough that four of them in parallel stay
// under the player's patience.
const PROBE_MS = Number(process.env.PROBE_MS || 1800);
const WANT = Number(process.env.WANT || 40);
const MIN_SEEDERS = Number(process.env.MIN_SEEDERS || 3);
// Probing is a race, not a walk: PROBES candidates at a time, each given
// PROBE_MS, and the whole list abandoned after PROBE_DEADLINE_MS. A player that
// waits eight seconds still tries; one that waits thirty has already hung.
const PROBES = Number(process.env.PROBES || 40);
const PROBE_DEADLINE_MS = Number(process.env.PROBE_DEADLINE_MS || 7000);
// A source is playable when some wire is actually delivering: peers that never
// send look identical to a dead swarm to the player.
const PLAYABLE_BYTES_PER_SEC = Number(process.env.PLAYABLE_BYTES_PER_SEC || 600000);
const ADDON_NAME = 'AIOStream';

if (require.main === module && !HUB) {
  console.error('HUB_URL is required (the AIOStreams manifest URL)');
  process.exit(1);
}
const HUB_BASE = HUB.replace(/\/manifest\.json$/, '');

function decodeId(raw) {
  let id = String(raw || '');
  for (let pass = 0; pass < 3; pass += 1) {
    let next = id;
    try { next = decodeURIComponent(id); } catch (_) { break; }
    if (next === id) break;
    id = next;
  }
  return id;
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return !h || h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function isPrivateLanHost(host) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(host || ''));
}

function detectLanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const info of ifaces || []) {
      if (info && info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '';
}

function resolveEngineBase(streamingUrl = STREAMING, publicUrl = PUBLIC, explicitPublic = STREAMING_PUBLIC) {
  if (explicitPublic) return explicitPublic.replace(/\/$/, '');
  const u = new URL(streamingUrl);
  if (!isLoopbackHost(u.hostname)) return streamingUrl.replace(/\/$/, '');
  const pubHost = new URL(publicUrl).hostname;
  if (isPrivateLanHost(pubHost)) {
    u.hostname = pubHost;
    return u.toString().replace(/\/$/, '');
  }
  const lanIp = detectLanIp();
  if (lanIp) {
    u.hostname = lanIp;
    return u.toString().replace(/\/$/, '');
  }
  return streamingUrl.replace(/\/$/, '');
}

function requestPublicBase(req) {
  const host = req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host);
  if (host && process.env.PUBLIC_FROM_HOST !== '0') {
    const fwdProto = req.headers['x-forwarded-proto'];
    const proto = (fwdProto ? String(fwdProto).split(',')[0].trim() : '') || new URL(PUBLIC).protocol.replace(':', '');
    return `${proto}://${String(host).split(',')[0].trim()}`;
  }
  return PUBLIC.replace(/\/$/, '');
}

const attempts = new Map(); // "type:id" -> how far down the list we have walked
// A title played twice within a few minutes must not pay the swarm's cold start
// twice: the winning stream is remembered, and the next play goes straight to it
// while the torrent is still delivering.
const warm = new Map(); // "type:id" -> { target, at }
// The source the panel was last handed for a title, so a refresh does not pay
// the probe again while the swarm is already warm.
const streamChoice = new Map();
const CHOICE_TTL_MS = Number(process.env.CHOICE_TTL_MS || 120000);
const WARM_TTL_MS = Number(process.env.WARM_TTL_MS || 180000);

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

// A release that says ITA, FRE, GER and nothing else is not an English watch,
// and the panel cannot tell until the volume is up and nobody is speaking it.
// A language line the hub prints is authoritative; otherwise the release name
// is read for a foreign tag that stands alone, with no English or multi beside
// it. Ambiguous names are kept: dropping what cannot be read would empty the
// list.
const FOREIGN_TAG = /(?:^|[.\s_(\\/\-])(ita|fre|vff|vf|ger|deu|spa|esp|rus|hin|tam|tel|jpn|jap|kor|chi|zho|pol|tur|swe|nor|dan|dut|nld|por|pob|cze|hun|rom|gre|ukr|ara|heb|tha|vie|may|ind)(?=[.\s_)\\/\-]|$)/i;
const ENGLISH_TAG = /(?:^|[.\s_(\\/\-])(eng|english|multi|dual)(?=[.\s_)\\/\-]|$)|🌎[^\n]{0,40}English/i;

function englishOnly(stream) {
  const text = `${stream.name || ''} ${stream.title || ''} ${stream.description || ''} ${
    (stream.behaviorHints && stream.behaviorHints.filename) || ''
  }`;
  const line = /🌎([^\n📁]*)📝?/.exec(text);
  if (line) return /English|Multi/i.test(line[1]);
  if (ENGLISH_TAG.test(text)) return true;
  return !FOREIGN_TAG.test(text);
}

// What the panel can put a picture on screen from. H.264 decodes everywhere and
// is the only codec this stack has ever seen work; HEVC, AV1 and VP9 open the
// stream, play the audio, and show nothing at all, which is the failure that
// turned an Arrow episode into a radio play. Capability is a setting, not a
// guess about the client: the panel's user agent is a lie (the Stremio core
// asks for addons, not the player) so the release name and, above all, the
// file's own codec id decide.
const PLAYABLE_CODECS = new Set(
  String(process.env.PLAYABLE_VIDEO_CODECS || 'h264')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean),
);

function videoAllowed(codec) {
  return !codec || PLAYABLE_CODECS.has(codec);
}

const CODEC_MARKERS = [
  ['hevc', ['V_MPEGH/ISO/HEVC', 'dvh1', 'dva1', 'hvc1', 'hev1']],
  ['av1', ['V_AV1', 'av01']],
  ['vp9', ['V_VP9', 'vp09']],
  ['h264', ['V_MPEG4/ISO/AVC', 'avc1', 'avc3']],
];

// The container's own id, read from the first kilobytes: a Matroska Tracks
// element names its codec within a few hundred bytes, an MP4 names it in the
// sample entry. A release name is a claim and can be wrong or silent; this
// cannot.
function codecFromBytes(head) {
  if (!head || head.length < 64) return null;
  const texts = [];
  for (const [codec, marks] of CODEC_MARKERS) {
    for (const mark of marks) {
      if (head.indexOf(mark) !== -1) {
        texts.push(codec);
        break;
      }
    }
  }
  return texts[0] || null;
}

const AUDIO_MARKERS = [
  ["aac", ["A_AAC"]],
  ["opus", ["A_OPUS"]],
  ["mp3", ["A_MPEG/L3"]],
  ["eac3", ["A_EAC3"]],
  ["ac3", ["A_AC3"]],
  ["dts", ["A_DTS"]],
  ["truehd", ["A_TRUEHD"]],
  ["flac", ["A_FLAC"]],
];

// The picture codec is not the only way a stream fails: a file carrying only
// DTS, TrueHD or FLAC plays a picture and no sound, which is the same broken
// experience as a black screen. The container names its audio track in the first
// kilobytes, so the same sniff that settles the video codec settles this.
function audioFromBytes(head) {
  if (!head || head.length < 64) return null;
  for (const [codec, marks] of AUDIO_MARKERS) {
    for (const mark of marks) {
      if (head.indexOf(mark) !== -1) return codec;
    }
  }
  return null;
}

// Every Fire TV here drives the TV's own speakers over plain HDMI: AAC always
// decodes in software, Opus/MP3 usually do, AC3/EAC3 only with the panel's
// passthrough path up, and DTS/TrueHD/FLAC never. Silence is a failure, so the
// audible tracks come first and the silent-only ones are a last resort.
const SILENT_AUDIO = new Set(["dts", "truehd", "flac"]);

function audioAllowed(audio) {
  return !audio || !SILENT_AUDIO.has(audio);
}

function audioTier(audio) {
  if (audio === "aac" || audio === "opus" || audio === "mp3") return 0;
  if (audio === "ac3" || audio === "eac3") return 1;
  if (!audio) return 2;
  return 3;
}

function pickAudible(rows) {
  const audible = rows.filter((row) => audioAllowed(row.audio));
  const pool = audible.length ? audible : rows;
  return [...pool].sort((left, right) => audioTier(left.audio) - audioTier(right.audio));
}

function codecFromLabel(text) {
  const line = String(text || '');
  if (/\b(x265|h\.?265|hevc)\b/i.test(line)) return 'hevc';
  if (/\bav1\b/i.test(line)) return 'av1';
  if (/\bvp9\b/i.test(line)) return 'vp9';
  if (/\b(x264|h\.?264|avc)\b/i.test(line)) return 'h264';
  return null;
}


// 0 = not a stereo universal codec (5.1 AAC is as silent here as AC3), 1 = unnamed,
// 2 = explicitly AAC/MP3/Opus stereo. Ranking uses the number.
function stereoAudio(text) {
  const line = String(text || "");
  const surround = /\b(5[.\s]?1|6[.\s]?ch|7[.\s]?1|dts|ac-?3|e-?ac-?3|eac3|ddp|dd\+|truehd|atmos|flac)\b/i.test(line);
  const universal = /\b(aac|mp3|opus|vorbis)\b/i.test(line);
  const stereo = /\b(2[.\s]?0|stereo|2ch|2\s*ch)\b/i.test(line);
  if (universal && stereo && !surround) return 2;
  if (universal && !surround) return 1;
  return 0;
}

function labelOf(stream) {
  return `${stream.name || ''} ${stream.title || ''} ${stream.description || ''} ${
    (stream.behaviorHints && stream.behaviorHints.filename) || ''
  }`;
}

function rank(stream, browser) {
  const text = labelOf(stream).toLowerCase();
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
  // Fire TV cannot decode TrueHD, Atmos or DTS-HD: the picture plays and the
  // sound is silent with the volume at maximum. That is a worse outcome than a
  // lower resolution, so the audio codec is ranked above quality: a 1080p AC3
  // source beats a 4K TrueHD one. A description that names both is fine — the
  // clear token wins — so `mute` only fires when nothing decodable is listed.
  // A BluRay REMUX at six to sixty gigabytes carries TrueHD or DTS-HD almost
  // without exception, and the panel has no codec field to say so: the picture
  // plays and the sound is silent with the volume at maximum. Size is the only
  // signal a remux leaves, so it queues behind every ordinary encode.
  const remux = /\bremux\b/i.test(text) ? 1 : 0;
  const gb = Number((/([\d.]+)\s*GB/i.exec(text) || [])[1] || 0);
  const heavyFile = gb >= 4 ? 1 : 0;
  const av1 = /\bav1\b/i.test(text) ? 1 : 0;
  // The panel plays Dolby only when something downstream decodes it; with plain
  // HDMI-to-TV it renders silence on an AC3 track. AAC/MP3/Opus always decode in
  // software, so they come first, AC3/DD next (they work with passthrough on),
  // and the codecs that need a receiver last.
  const universal = /(aac|mp3|opus|vorbis)/i.test(text);
  const clear = /(e-?ac-?3|eac3|ddp|dd\+|ac-?3|aac|opus|mp3)/i.test(text);
  const mute = !clear && /(truehd|atmos|dts[- ]?hd|dts[- ]?x|\bdts\b|flac|pcm)/i.test(text);
  const codec = codecFromLabel(labelOf(stream));
  // Resolution first, then the swarm. Audio codec used to outrank both and it
  // picked a 720p HDTV rip with three peers over a 1080p WEB-DL with forty-five,
  // which is a spinner, not a preference. A playable file that streams beats a
  // perfect file that cannot: `lonely` still outranks everything, and the codec
  // gate below it drops AV1/HEVC outright.
  // Swarm first, then the size of the picture. A 2160p release with four peers
  // opened a black screen that polled stats for a minute (the panel has to pull
  // the whole thing itself), while a 1080p with forty-five started instantly.
  // A 4K stream only wins when it is seeded like the 1080p one is.
  const uhd = /\b(2160p|4k)\b/i.test(text) ? 1 : 0;
  const uhdHealthy = uhd && seeders >= 30 ? 0 : uhd;
  return [
    lonely,
    videoAllowed(codec) ? 0 : 1,
    stereoAudio(text) === 2 ? 0 : 1,
    // A link that plays from its first byte beats a swarm that has to be found
    // first, then a file small enough to fill the buffer before the panel gives
    // up, then the size of the swarm. Size moved above raw seeders on purpose:
    // a 20 GB remux with forty peers still stalls a Fire TV that has to pull
    // the whole thing itself, while a 2 GB WEB-DL with a dozen starts at once.
    p2p,
    remux || heavyFile,
    -seeders,
    uhdHealthy,
    q === -1 ? 99 : q,
    mute ? 1 : 0,
    universal ? 0 : 1,
    clear ? 0 : 1,
    heavy ? 1 : 0,
    t === -1 ? 99 : t,
    av1,
  ];
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
function delivers(url, need, within, redirects = 3) {
  return new Promise((resolve) => {
    const started = Date.now();
    let got = 0;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(ok);
    };
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: { range: 'bytes=0-262143', 'user-agent': 'aio-failover/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, target).toString(); } catch (_) { finish(false); return; }
        const left = Math.max(200, within - (Date.now() - started));
        clearInterval(timer);
        settled = true;
        delivers(next, need, left, redirects - 1).then(resolve);
        return;
      }
      if (res.statusCode >= 400 || res.statusCode >= 300) {
        res.resume();
        finish(false);
        return;
      }
      res.on('data', (chunk) => {
        got += chunk.length;
        if (got >= need) {
          req.destroy();
          finish(true);
        }
      });
      res.on('error', () => finish(false));
      res.on('end', () => finish(got >= need));
    });
    const timer = setInterval(() => {
      if (Date.now() - started > within) {
        req.destroy();
        finish(got >= need);
      }
    }, 200);
    req.on('error', () => finish(false));
    req.on('close', () => clearInterval(timer));
  });
}

// The same ranged read, keeping the bytes: the head of the file is the only
// place the real video codec is written down, and it is what decides whether the
// panel can show a picture.
const CODEC_SNIFF_BYTES = 262144;

function headBytes(url, within, redirects = 3) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    let got = 0;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(ok ? Buffer.concat(chunks) : null);
    };
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const timer = setInterval(() => {
      if (Date.now() - started > within + 1500) {
        req.destroy();
        finish(got >= 1024);
      }
    }, 200);
    const req = lib.get(url, {
      headers: { range: `bytes=0-${CODEC_SNIFF_BYTES - 1}`, 'user-agent': 'aio-failover/1.0' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, target).toString(); } catch (_) { finish(false); return; }
        clearInterval(timer);
        settled = true;
        headBytes(next, Math.max(400, within - (Date.now() - started)), redirects - 1).then(resolve);
        return;
      }
      if (res.statusCode >= 300) {
        res.resume();
        finish(false);
        return;
      }
      res.on('data', (chunk) => {
        chunks.push(chunk);
        got += chunk.length;
        if (got >= CODEC_SNIFF_BYTES) {
          req.destroy();
          finish(true);
        }
      });
      res.on('error', () => finish(got >= 1024));
      res.on('end', () => finish(got >= 1024));
    });
    req.on('error', () => finish(false));
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
function alive(url, redirects = 3) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: { range: 'bytes=0-1', 'user-agent': 'aio-failover/1.0' },
    }, (res) => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        let next;
        try { next = new URL(res.headers.location, target).toString(); } catch (_) { resolve(false); return; }
        alive(next, redirects - 1).then(resolve);
        return;
      }
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.setTimeout(PROBE_MS, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function candidates(type, id, browser) {
  let body;
  try {
    body = await get(`${HUB_BASE}/stream/${type}/${id}.json`, 15000);
  } catch (_) {
    body = null;
  }
  // The hub answers 324 streams for a title and then, under load, nothing at
  // all: one failed fetch showed the player "no streams found" for every
  // title until the next request. One retry costs 350 ms and removes a class
  // of empty answers that reads as a broken addon.
  if (!body || !(body.streams || []).length) {
    await new Promise((r) => setTimeout(r, 350));
    try {
      const again = await get(`${HUB_BASE}/stream/${type}/${id}.json`, 15000);
      if (again && (again.streams || []).length) body = again;
    } catch (_) {}
  }
  body = body || {};
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
    .map((stream) => ({ ...stream, browser }))
    // A release whose own name says AV1, HEVC or VP9 is not a candidate on this
    // panel at all: the hardware cannot decode it, so it plays black with sound
    // or buffers forever. Demoting it was not enough - an AV1 1080p with forty
    // seeders still outranked a lonely H.264 - so the wrong codec is dropped
    // before ranking. A stream that names no codec stays: the first kilobytes
    // of the file are probed at play time and decide there.
    .filter((stream) => videoAllowed(codecFromLabel(labelOf(stream))))
    // The panel has no working Dolby path at all: AC3 and 5.1 render silence.
    // A source is only a candidate when it NAMES a stereo-capable universal
    // audio codec (AAC/MP3/Opus) and does not name 5.1/6-channel. Anything the
    // release name does not state is not guessed at - the owner hears silence
    // once and it is a bug, so an unnamed source ranks behind every named one.
    // An audio track nobody names is not a reason to drop a source: the release
    // name is a hint, not metadata. Only a stream that NAMES a codec this panel
    // renders as silence (DTS, TrueHD, Atmos, FLAC, 5.1/7.1 with no AAC) is
    // removed; everything else joins the chain below every named-stereo source.
    .filter((stream) => {
      const text = labelOf(stream);
      if (stereoAudio(text) !== 0) return true;
      const universal = /(aac|mp3|opus|vorbis)/i.test(text);
      const silentOnly = /(truehd|atmos|dts|flac|5[.\s]?1|6[.\s]?ch|7[.\s]?1)/i.test(text);
      return !(silentOnly && !universal);
    });
  // A torrent nobody seeds is a spinner, however good its name reads: drop it,
  // but only while something healthy is left. A rare title whose only remaining
  // sources are thin still has to play - "no streams found" is a worse answer
  // than a slow one.
  const seeded = streams.filter((stream) => !stream.infoHash || seedersOf(stream) >= MIN_SEEDERS);
  const pool = seeded.length ? seeded : streams;
  pool.sort(better);
  const spoken = pool.filter(englishOnly);
  return (spoken.length ? spoken : pool).slice(0, WANT);
}

// English subtitle tracks for a title, from OpenSubtitles v3, matched to the
// release when the hub handed us a filename. Failures are an empty list, never
// an error: the player must not lose playback because subtitles are missing.
const subtitleCache = new Map();

// Stremio's client rejects a payload with "Invalid type null" when a field it
// expects to be a string arrives as null, and the hub's rows are full of them:
// `url: null` on a torrent row, `title: null` on an untitled rip. The addon's
// own contract is "every field is either absent or the right type", so the
// serializer drops nulls instead of forwarding them.
function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => (item === null ? undefined : item));
}

// Subtitles are only in sync with the release they were timed against. The
// panel plays the torrent this addon chose and then asks for subtitles by title
// id alone, so OpenSubtitles answers with whatever it likes — an HDTV rip's
// track under a BluRay source drifts by minutes, which is what a ten minute
// offset looks like. Reading the release we actually handed the player and
// ranking the tracks against it is the whole fix: the first track in the list
// is the one the player auto-selects.
const RELEASE_TAGS = /\b(2160p|1080p|720p|480p|web-?dl|web-?rip|bluray|blu-ray|brrip|bdrip|hdtv|dvdrip|dvdscr|remux|hdr|x264|x265|h264|hevc|av1)\b/gi;
const RELEASE_NOISE = /\b(eng|english|subs?|subtitle|srt|ass|multi|complete|season|episode)\b/gi;

function releaseTokens(text) {
  const tokens = new Set();
  const words = String(text || '')
    .replace(/[._\[\]()]/g, ' ')
    .replace(RELEASE_TAGS, (tag) => ` ${tag.toLowerCase()} `)
    .replace(RELEASE_NOISE, ' ')
    .split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (clean.length >= 3) tokens.add(clean);
  }
  return tokens;
}

/** How well a subtitle's release name fits the torrent we chose. */
function releaseScore(subtitle, release) {
  if (!release) return 0;
  const wanted = releaseTokens(release);
  if (!wanted.size) return 0;
  const found = releaseTokens(`${subtitle.movieReleaseName || ''} ${subtitle.subtitleFileName || ''}`);
  let score = 0;
  for (const token of found) if (wanted.has(token)) score += 1;
  // The source tag is the part that decides timing: HDTV against BluRay is the
  // ten minute drift, while a matching encode is a second at most.
  for (const tag of ['hdtv', 'bluray', 'webdl', 'webrip', 'dvdrip', 'remux']) {
    if (found.has(tag) && wanted.has(tag)) score += 4;
    else if (found.has(tag) && !wanted.has(tag)) score -= 2;
  }
  return score;
}

// A season pack is one torrent with every episode inside it. `/0` is the first
// file in the pack, not the episode the panel asked for: pointing the player at
// file zero played episode one under an episode three title, and nothing in the
// URL said so. The engine already knows the file list, so the index is resolved
// from the name the panel's own id implies.
const fileLists = new Map(); // hash -> { files, at }

async function filesFor(hash) {
  const known = fileLists.get(hash);
  if (known && Date.now() - known.at < 10 * 60 * 1000) return known.files;
  try {
    const stats = await get(`${STREAMING}/stats.json`, 4000);
    const entry = stats && stats[hash.toLowerCase().slice(0, 40)];
    const files = (entry && entry.files) || [];
    if (files.length) {
      fileLists.set(hash, { files, at: Date.now() });
      return files;
    }
  } catch (_) {}
  return [];
}

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|webm|ts)$/i;

/** The file index inside a torrent that holds the episode (or film) asked for. */
async function fileIndexFor(hash, id) {
  const files = await filesFor(hash);
  if (!files.length) return 0;
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
    return 0;
  }
  // A film: the pack is a sample beside the feature, so take the biggest video.
  let best = 0;
  let longest = -1;
  files.forEach((file, index) => {
    const name = String(file.name || '');
    if (!VIDEO.test(name)) return;
    const length = Number(file.length || 0);
    if (length > longest) {
      longest = length;
      best = index;
    }
  });
  return best;
}

// The player loads a subtitle by URL and, after a seek, asks that same URL for
// the whole track again. Handing it OpenSubtitles' download link means a
// redirect chain and a raw SRT with a BOM: the two things that make a player
// keep the old timing after a jump. The addon serves the track itself as WebVTT
// from one stable URL, so a seek re-reads a file that starts with WEBVTT.
const vttCache = new Map(); // token -> { body, expires }
const VTT_TTL_MS = 30 * 60 * 1000;

function vttToken(url) {
  return Buffer.from(url).toString('base64url');
}

function srtToVtt(text) {
  const cleaned = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^(\d+)\n(\d{2}:\d{2}:\d{2}),(\d{3}) --> /gm, '$2.$3 --> ')
    .replace(/,([0-9]{3})/g, '.$1');
  return `WEBVTT\n\n${cleaned.trim()}\n`;
}

async function vttBody(token) {
  const known = vttCache.get(token);
  if (known && Date.now() < known.expires) return known.body;
  const url = Buffer.from(token, 'base64url').toString('utf8');
  if (!/^https?:\/\//.test(url)) return null;
  const body = await new Promise((resolve) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: { 'user-agent': 'aio-failover/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(null);
        return;
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(text));
    });
    req.setTimeout(15000, () => req.destroy());
    req.on('error', () => resolve(null));
  });
  if (!body) return null;
  const vtt = srtToVtt(body);
  vttCache.set(token, { body: vtt, expires: Date.now() + VTT_TTL_MS });
  return vtt;
}

async function subtitlesFor(type, id, release) {
  const url = `https://opensubtitles-v3.strem.io/subtitles/${type}/${encodeURIComponent(id)}.json`;
  let body = null;
  try {
    body = await get(url, Number(process.env.SUBS_TIMEOUT_MS || 8000));
  } catch (err) {
    body = null;
  }
  const rows = (body && body.subtitles) || [];
  const english = rows
    .filter((row) => /^(eng|en)$/i.test(String(row.lang || '')))
    .filter((row) => row.url)
    .map((row, index) => ({ row, index, score: releaseScore(row, release) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, 20)
    .map(({ row }) => row);
  return english
    .map((row, index) => ({
      ...row,
      // The panel shows this text in the track list; without it every entry
      // reads 'English' and nobody can tell the sync apart.
      id: String(row.id || index),
      lang: 'eng',
      title: String(row.subtitleFileName || row.movieReleaseName || `English ${index + 1}`).slice(0, 70),
      // Token resolved relative to the client's request origin in /subtitles/.
      token: vttToken(row.url),
    }));
}

// The engine only keeps a torrent loaded while something is asking for it: a
// probe that closes the moment it has its verdict leaves the swarm cold again,
// and the player's next request pays the entire cold start (16.8s measured on a
// 45-peer WEB-DL). One held range request per title keeps it loaded in the
// background, so the row the panel is showing is already warm when it is
// pressed — and it is renewed before it expires.
const held = new Map(); // hash -> { req, until }
const WARM_HOLD_MS = Number(process.env.WARM_HOLD_MS || 90000);

function keepWarm(hash, fileAt) {
  if (!hash) return;
  const index = Number(fileAt || 0);
  const key = `${hash}:${index}`;
  const now = Date.now();
  const prior = held.get(key);
  if (prior && prior.until > now) return;
  if (prior) {
    try { prior.req.destroy(); } catch (_) {}
    held.delete(key);
  }
  // Warm the file the panel is about to ask for: warming file 0 of a season
  // pack warms the pilot, which is the wrong episode at 200 MB a minute.
  const req = http.get(`${STREAMING}/${hash}/${index}`, { headers: { Range: 'bytes=0-1048575' } }, (res) => {
    if (res.statusCode >= 400) {
      res.resume();
      held.delete(key);
      return;
    }
    res.on('data', () => {});
    res.on('end', () => held.delete(key));
    res.on('error', () => held.delete(key));
  });
  req.on('error', () => held.delete(key));
  req.setTimeout(WARM_HOLD_MS + 5000, () => { req.destroy(); held.delete(key); });
  held.set(key, { req, until: now + WARM_HOLD_MS });
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
// A 1080p encode needs roughly two megabytes a second to keep a Fire TV from
// stalling; 0.6 MB/s played for a few seconds and then buffered forever, which
// reads as the same complaint as a dead swarm. The floor follows the picture
// size, and an explicit PLAYABLE_BYTES_PER_SEC still overrides all of it.
function neededRate(stream) {
  if (PLAYABLE_BYTES_PER_SEC > 0) return PLAYABLE_BYTES_PER_SEC;
  const text = labelOf(stream);
  if (/\b(2160p|4k)\b/i.test(text)) return 4000000;
  if (/\b1080p\b/i.test(text)) return 1200000;
  if (/\b720p\b/i.test(text)) return 800000;
  return 400000;
}

async function firstLive(list, orderUnsorted, windowMs, maxProbes, id = '') {
  let order = orderUnsorted;
  // How many candidates this call is allowed to load. Every probe leaves a
  // torrent loaded on the engine, so a stream request that probes the whole
  // list leaves forty swarms spinning for one chosen source.
  const probeCap = Number(maxProbes || PROBES);
  const probeWindow = Number(windowMs || process.env.LIVE_WINDOW_MS || 20000);
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
    loaded.push({ at, target, hash: match[1].toLowerCase(), hasFileIdx: Number.isInteger(stream.fileIdx) });
    if (loaded.length >= probeCap) break;
  }
  if (!loaded.length) return null;
  // A ranged request that closes at once reads as an abandoned download and the
  // engine is torn down before it ever finds a peer. These stay open for the
  // whole window — that is what a player does — and are dropped once the answer
  // is known.
  const open = [];
  const failed = new Set();
  for (const item of loaded) {
    const req = http.get(item.target, { headers: { 'user-agent': 'aio-failover/1.0' } }, (res) => {
      if (res.statusCode >= 400 || (res.statusCode >= 300 && !res.headers.location)) {
        failed.add(item.hash);
        res.resume();
        req.destroy();
        return;
      }
      res.on('data', () => {});
      res.on('error', () => {});
    });
    req.on('error', () => failed.add(item.hash));
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
  const needBytes = Number(process.env.DELIVERS_MIN_BYTES || 1024);
  const deliversWait = Number(process.env.DELIVERS_MS || 6000);
  // A source with bytes but no decodable picture: it plays as sound only, which
  // is the bug this guard exists for. Kept only for a title where nothing else
  // answers.
  let fallback = null;
  let slowest = null;
  while (Date.now() < deadline && failed.size < loaded.length) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (failed.size >= loaded.length) break;
    const stats = await readStats();
    if (!stats) continue;
    let best = null;
    for (const item of loaded) {
      if (failed.has(item.hash)) continue;
      const row = stats[item.hash];
      if (!row) continue;
      const peers = Number(row.peers || 0);
      // A peer that never sends is not a source: the wires carry the rate, and
      // a torrent whose only peer is silent looks exactly like a dead one to a
      // player.
      const rate = (row.wires || []).reduce(
        (most, wire) => Math.max(most, Number(wire.downSpeed || 0)),
        0,
      );
      if (peers > 0 && rate >= neededRate(list[item.at])) {
        if (!best || rate > best.rate) best = { ...item, peers, rate };
      } else if (peers > 0) {
        // Too slow to play without stalling, but it is still the fastest thing
        // available if nothing clears the floor.
        if (!slowest || rate > slowest.rate) slowest = { ...item, peers, rate };
      }
    }
    // The rate is the swarm's, not this file's: a season pack can have fast
    // peers and no complete copy of the episode that was asked for. So `best`
    // and the next fastest candidates are verified for real byte delivery.
    if (best) {
      close(best.hash);
      const rest = loaded.filter((item) => item.hash !== best.hash && !failed.has(item.hash)).slice(0, 3);
      const want = [best, ...rest];
      const race = await Promise.all(
        want.map(async (item) => {
          let verifyUrl = item.target;
          if (!item.hasFileIdx && id) {
            const idx = await fileIndexFor(item.hash, id);
            verifyUrl = `${STREAMING}/${item.hash}/${idx}`;
          }
          const within = Math.min(deliversWait, Math.max(500, deadline - Date.now() + 1000));
          const head = await headBytes(verifyUrl, within);
          if (!head) return null;
          // The bytes are the verdict: a codec the panel cannot decode is not
          // "lower quality", it is a stream with no picture, so it is skipped
          // as dead and the loop walks to one that has a picture.
          const codec = codecFromBytes(head) || codecFromLabel(labelOf(list[item.at]));
          const audio = audioFromBytes(head);
          return { ...item, target: verifyUrl, codec, audio };
        }),
      );
      const decodable = race.filter(Boolean).filter((row) => videoAllowed(row.codec));
      const winner = pickAudible(decodable)[0];
      if (winner) {
        close();
        const row = (stats && stats[winner.hash]) || {};
        const rate = (row.wires || []).reduce((most, wire) => Math.max(most, Number(wire.downSpeed || 0)), 0);
        return { ...winner, peers: Number(row.peers || 0), rate };
      }
      // Nothing with a picture in this round: keep one source back so a title
      // whose only copies are HEVC still plays something, and keep looking.
      for (const row of race.filter(Boolean)) {
        if (!fallback) fallback = row;
      }
      // Only what failed or cannot be decoded is retired. A decodable
      // candidate that simply lost the race stays for the next round, or the
      // HEVC source ranked first would take the working H.264 down with it.
      for (const item of want) {
        const row = race.find((candidate) => candidate && candidate.hash === item.hash);
        if (!row || !videoAllowed(row.codec)) failed.add(item.hash);
      }
    }
  }
  close();
  if (slowest) {
    const want = Math.round(neededRate(list[slowest.at]) / 1000);
    console.log(`nothing reaches ${want} kB/s for ${id || 'title'}; using the fastest at ${Math.round(slowest.rate / 1000)} kB/s`);
    return slowest;
  }
  if (fallback) {
    console.log(`only undecodable video for ${id || 'title'} (${fallback.codec}); using it`);
    return { ...fallback, peers: 0, rate: 0 };
  }
  return null;
}

async function firstLiveHttp(list) {
  const httpCandidates = list
    .map((stream, at) => ({ stream, at }))
    .filter(({ stream }) => isMediaLink(stream))
    .slice(0, 4);
  if (!httpCandidates.length) return null;
  const race = await Promise.all(
    httpCandidates.map(async ({ stream, at }) => {
      const head = await headBytes(stream.url, Math.max(PROBE_MS, 4000));
      if (!head) return null;
      const codec = codecFromBytes(head) || codecFromLabel(labelOf(stream));
      const audio = audioFromBytes(head);
      return { at, hash: null, target: stream.url, peers: 0, rate: 0, codec, audio };
    }),
  );
  const rows = race.filter(Boolean);
  const decodable = rows.filter((row) => videoAllowed(row.codec));
  const audible = pickAudible(decodable);
  return audible[0] || decodable[0] || rows[0] || null;
}

function readStats() {
  return new Promise((resolve) => {
    const req = http.get(`${STREAMING}/stats.json`, { timeout: 1500 }, (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        resolve(null);
        return;
      }
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
  const pubBase = requestPublicBase(req);
  const url = new URL(req.url, pubBase);
  const path = url.pathname;
  // One line per request: the only way to see whether the TV reached this box.
  console.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${req.headers['user-agent'] || '-'} ${path}`);

  try {
    if (path === '/healthz') {
      const [hubRes, streamRes] = await Promise.allSettled([
        get(HUB, 3000),
        get(`${STREAMING}/settings`, 2500),
      ]);
      const hubOk = hubRes.status === 'fulfilled' && Boolean(hubRes.value && hubRes.value.id);
      const streamingOk = streamRes.status === 'fulfilled' && Boolean(streamRes.value && streamRes.value.values);
      const ok = hubOk && streamingOk;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(jsonSafe({
        ok,
        engine: resolveEngineBase(),
        hub: { ok: hubOk, ...(hubOk ? {} : { error: hubRes.reason ? String(hubRes.reason.message || hubRes.reason) : 'bad manifest' }) },
        streaming: { ok: streamingOk, ...(streamingOk ? {} : { error: streamRes.reason ? String(streamRes.reason.message || streamRes.reason) : 'bad settings' }) },
      }));
      return;
    }

    if (path === '/manifest.json') {
      const manifest = {
        id: 'org.aiostre.am',
        // Bumped when resources change: the panel caches a manifest by version,
        // and a stale cache is an addon that silently has no subtitles.
        version: '1.1.0',
        name: ADDON_NAME,
        description: 'One ranked source per title: the backend picks the one that answers.',
        resources: ['stream', 'subtitles'],
        types: ['movie', 'series'],
        idPrefixes: ['tt'],
        catalogs: [],
      };
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(jsonSafe(manifest));
      return;
    }

    // Subtitles are not a stream property: no source in the hub declares them,
    // so the panel has nothing to show unless an addon supplies tracks. This
    // addon supplies them itself — OpenSubtitles v3 is queried directly and
    // only English comes back, so the list is short enough to be useful on a
    // remote and every title has something to pick.
    const vttMatch = path.match(/^\/vtt\/([A-Za-z0-9_-]+)\.vtt$/);
    if (vttMatch) {
      const body = await vttBody(vttMatch[1]);
      if (!body) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('subtitle unavailable');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/vtt; charset=utf-8',
        'cache-control': 'public, max-age=1800',
        'access-control-allow-origin': '*',
      });
      res.end(body);
      return;
    }

    const subtitleMatch = path.match(/^\/subtitles\/([^/]+)\/(.+)\.json$/);
    if (subtitleMatch) {
      const subType = subtitleMatch[1];
      const subId = decodeId(subtitleMatch[2]);
      const picked = streamChoice.get(`${subType}:${subId}`);
      const release = picked ? [picked.releaseName, picked.releaseTitle].filter(Boolean).join(' ') : '';
      const cacheKey = `${subType}:${subId}:${release}`;
      let tracks = subtitleCache.get(cacheKey);
      if (!tracks || Date.now() > tracks.expires) {
        tracks = { rows: await subtitlesFor(subType, subId, release), expires: Date.now() + 10 * 60 * 1000 };
        subtitleCache.set(cacheKey, tracks);
      }
      const mapped = tracks.rows.map(({ token, ...row }) => ({ ...row, url: `${pubBase}/vtt/${token}.vtt` }));
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(jsonSafe({ subtitles: mapped }));
      return;
    }

    const streamMatch = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamMatch) {
      // The panel percent-encodes the id (`tt2193021%3A1%3A4` or double-encoded).
      const type = streamMatch[1];
      const id = decodeId(streamMatch[2]);
      const uaStream = String(req.headers['user-agent'] || '');
      const isBrowser = /Chrome|Mozilla|Safari|Firefox/i.test(uaStream);
      const list = await candidates(type, id, isBrowser);
      if (!list.length) {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(jsonSafe({ streams: [] }));
        return;
      }
      // The single row must be a source that is actually delivering: probing
      // here costs a few seconds once and removes 'it spins forever'.
      const cacheKey = `${type}:${id}`;
      const cached = streamChoice.get(cacheKey);
      let live = null;
      if (cached && cached.hash && Date.now() - Number(cached.cachedAt || 0) < CHOICE_TTL_MS) {
        const stillIdx = list.findIndex((row) => (row.infoHash || '').toLowerCase() === cached.hash.toLowerCase());
        if (stillIdx >= 0) {
          const stats = await readStats();
          if (stats && stats[cached.hash] && Number(stats[cached.hash].peers || 0) > 0) {
            live = { ...cached, at: stillIdx };
          }
        }
      }
      if (!live) {
        const probed = await firstLive(
          list,
          list.map((_, step) => step),
          Number(process.env.STREAM_PROBE_MS || 6000),
          Number(process.env.STREAM_PROBES || 8),
          id,
        ).catch((err) => {
          console.error(`firstLive error for ${cacheKey}:`, err && err.message ? err.message : err);
          return null;
        });
        if (probed) {
          live = { at: probed.at, hash: probed.hash, peers: probed.peers, rate: probed.rate, cachedAt: Date.now() };
          streamChoice.set(cacheKey, live);
        }
      }
      if (!live) {
        live = await firstLiveHttp(list).catch((err) => {
          console.error(`firstLiveHttp error for ${cacheKey}:`, err && err.message ? err.message : err);
          return null;
        });
      }
      if (!live || !list[live.at]) {
        // Every delivery probe failed. Answering nothing is the dead end the
        // panel shows as a hang, so hand it the best-ranked source as a plain
        // torrent stream and let its own engine try: a codec-gated,
        // seeder-checked candidate is still the right answer, and this proxy is
        // not the only way to read it.
        const bestTop = list[0];
        const bestLabel = `${ADDON_NAME} · ${(bestTop.name || "").replace(/^\[[^\]]*\]\s*/, "").slice(0, 28)}`;
        console.log(`no live source for ${cacheKey} (${list.length} candidates) - handing the panel ${bestTop.infoHash || bestTop.url}`);
        // A raw infoHash here makes the panel's own engine join the swarm from
        // the house's public IP, outside the VPN that every other request on
        // this box goes through. The stream is routed through this engine
        // instead, even when it has not gone live yet: the player warming it is
        // also what turns it live.
        const direct = isMediaLink(bestTop)
          ? { name: ADDON_NAME, title: bestLabel, url: bestTop.url }
          : {
            name: ADDON_NAME,
            title: bestLabel,
            url: `${resolveEngineBase()}/${bestTop.infoHash}/${await fileIndexFor(bestTop.infoHash, id)}`,
          };
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(jsonSafe({ streams: [{ ...direct, behaviorHints: { notWebReady: false, bingeGroup: "aiostre-am" } }] }));
        return;
      }
      const top = list[live.at];
      const label = `${ADDON_NAME} · ${(top.name || '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 28)}`;
      streamChoice.set(cacheKey, {
        ...(streamChoice.get(cacheKey) || live),
        cachedAt: Date.now(),
        releaseName: String(top.name || ''),
        releaseTitle: [top.title, top.description, (top.behaviorHints && top.behaviorHints.filename)]
          .filter(Boolean)
          .join(' '),
      });
      const hash = (live && live.hash) || top.infoHash || (/\/([0-9a-f]{40})\//i.exec(top.url || '') || [])[1];
      const engine = resolveEngineBase();
      let engineHost = '';
      try { engineHost = new URL(engine).hostname; } catch (_) {}
      if (hash && isLoopbackHost(engineHost) && process.env.ALLOW_LOOPBACK_STREAMING !== '1') {
        console.error(`refusing unroutable engine url ${engine} for ${cacheKey}`);
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(jsonSafe({ streams: [] }));
        return;
      }
      const fileAt = hash ? await fileIndexFor(hash, id) : 0;
      const streams = [{
        ...(hash ? {} : top),
        name: ADDON_NAME,
        title: label,
        url: hash ? `${engine}/${hash}/${fileAt}` : (live.target || `${pubBase}/play/${type}/${encodeURIComponent(id)}`),
        behaviorHints: { notWebReady: false, bingeGroup: 'aiostre-am' },
      }];
      if (hash) keepWarm(hash, fileAt);
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(jsonSafe({ streams }));
      return;
    }

    const playMatch = path.match(/^\/play\/([^/]+)\/(.+)$/);
    if (playMatch) {
      const [, type, rawId] = playMatch;
      const id = decodeId(rawId);
      const key = `${type}:${id}`;
      const list = await candidates(type, id, true);
      if (!list.length) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('no sources');
        return;
      }
      const now = Date.now();
      let remembered = warm.get(key);
      if (remembered && now - remembered.at < WARM_TTL_MS) {
        // A remembered stream is only worth reusing while its swarm is still
        // there: an engine that lost its peers answers nothing, and trusting the
        // memory turned a fast second play into a 502.
        const memoHash = /\/([0-9a-f]{40})\//i.exec(remembered.target);
        const known = memoHash ? await readStats() : null;
        const memoRow = known && memoHash ? known[memoHash[1].toLowerCase()] : null;
        if (!memoRow || Number(memoRow.peers || 0) === 0) {
          warm.delete(key);
          remembered = null;
        }
      }
      if (remembered && now - remembered.at < WARM_TTL_MS) {
        const fresh = `${remembered.target}${remembered.target.includes('?') ? '&' : '?'}n=${now}`;
        console.log(`play ${key} -> warm ${fresh.slice(0, 60)}`);
        const headers = { 'user-agent': 'aio-failover/1.0' };
        if (req.headers.range) headers.range = req.headers.range;
        const upstream = http.get(fresh, { headers }, (body) => {
          res.writeHead(body.statusCode || 200, {
            'content-type': body.headers['content-type'] || 'video/x-matroska',
            'accept-ranges': 'bytes',
            ...(body.headers['content-length'] ? { 'content-length': body.headers['content-length'] } : {}),
            ...(body.headers['content-range'] ? { 'content-range': body.headers['content-range'] } : {}),
            'access-control-allow-origin': '*',
          });
          body.pipe(res);
        });
        upstream.on('error', () => {
          warm.delete(key);
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('source error');
        });
        res.on('close', () => upstream.destroy());
        return;
      }
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
      const live = await firstLive(list, order, undefined, undefined, id);
      if (live) {
        attempts.set(key, { index: live.at + 1, at: Date.now() });
        // Proxied, not redirected. The player is on another device and a 302 to
        // a second port is one more thing it can refuse: serving the bytes from
        // this addon's own origin is what every player understands, and it keeps
        // the request that warmed the engine alive for the whole playback.
        const fresh = `${live.target}${live.target.includes('?') ? '&' : '?'}n=${Date.now()}`;
        console.log(`play ${key} -> #${live.at} ${live.peers} peers ${Math.round(live.rate / 1024)} KB/s ${live.target.slice(0, 60)}`);
        const headers = { 'user-agent': 'aio-failover/1.0' };
        if (req.headers.range) headers.range = req.headers.range;
        const upstream = http.get(fresh, { headers }, (body) => {
          res.writeHead(body.statusCode || 200, {
            'content-type': body.headers['content-type'] || 'video/x-matroska',
            'accept-ranges': 'bytes',
            ...(body.headers['content-length'] ? { 'content-length': body.headers['content-length'] } : {}),
            ...(body.headers['content-range'] ? { 'content-range': body.headers['content-range'] } : {}),
            'access-control-allow-origin': '*',
          });
          body.pipe(res);
        });
        upstream.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain' });
          }
          res.end('source error');
        });
        res.on('close', () => upstream.destroy());
        return;
      }
      // No second opinion below this line: firstLive has already asked the
      // engine which swarms are alive and which of those deliver. A slower
      // fallback that hands over any candidate is what produced the spinner.
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

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`${ADDON_NAME} on ${PUBLIC} -> ${HUB_BASE}`);
  });
}

module.exports = {
  server,
  decodeId,
  rank,
  better,
  englishOnly,
  isPlaceholder,
  isMediaLink,
  resolveEngineBase,
  requestPublicBase,
  delivers,
  alive,
  headBytes,
  codecFromBytes,
  codecFromLabel,
  videoAllowed,
  firstLive,
  firstLiveHttp,
};
