// Downloaders — ruhend-scraper (installed) + vxtwitter for X. See DECISIONS.md.
import { fetchBuffer, fetchJson } from '../lib/helpers.js';

async function scraper() {
  const mod = await import('ruhend-scraper');
  return mod.default || mod;
}

function firstUrl(res) {
  // ruhend results vary in shape; hunt for the first usable media URL
  if (!res) return null;
  if (typeof res === 'string') return res;
  if (Array.isArray(res)) return firstUrl(res[0]);
  for (const k of ['url', 'video', 'audio', 'link', 'download', 'media']) {
    if (typeof res[k] === 'string' && res[k].startsWith('http')) return res[k];
    if (res[k] && typeof res[k] === 'object') {
      const u = firstUrl(res[k]);
      if (u) return u;
    }
  }
  if (res.data) return firstUrl(res.data);
  return null;
}

const MAX_SONG_SECONDS = 30 * 60; // don't try to buffer hour-long videos
const MAX_AUDIO_BYTES = 70 * 1024 * 1024; // hard byte ceiling even if duration is unknown
const YT_INFO_TIMEOUT_MS = 30 * 1000;
const YT_STREAM_TIMEOUT_MS = 3 * 60 * 1000;

// Reject a promise that doesn't settle in time (ytdl.getInfo can hang forever
// on a stalled connection, leaving the command with no reply).
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), timeout]);
}

// Drain a stream to a Buffer with a byte ceiling AND an idle/overall timeout, so
// a mislabeled live stream can't exhaust memory and a stalled one can't hang.
function streamToBuffer(stream, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => stream.destroy(new Error('download timed out')), timeoutMs);
    stream.on('data', c => {
      size += c.length;
      if (size > maxBytes) { stream.destroy(new Error('too large')); return; }
      chunks.push(c);
    });
    stream.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    stream.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Optional YouTube cookie (YT_COOKIE env) — datacenter IPs (most hosts) get
// "confirm you're not a bot" without it. Accepts a JSON cookie array (from a
// cookie-export extension) or a raw "name=value; name=value" header string.
let _agent;
function ytAgent(ytdl) {
  if (_agent !== undefined) return _agent;
  const raw = process.env.YT_COOKIE?.trim();
  if (!raw) { _agent = null; return null; }
  try {
    const cookies = raw.startsWith('[')
      ? JSON.parse(raw)
      : raw.split(';').map(p => {
          const [name, ...v] = p.trim().split('=');
          return { name, value: v.join('=') };
        });
    _agent = ytdl.createAgent(cookies);
  } catch (err) {
    console.error('[RF] bad YT_COOKIE, ignoring:', err.message);
    _agent = null;
  }
  return _agent;
}

// Search a song by name (or take a YouTube URL) and return its audio.
// Uses yt-search (find) + @distube/ytdl-core (maintained) — ruhend's ytmp3
// parser is broken (deprecated). Streams audio-only to a buffer.
export async function ytAudio(link) {
  return playAudio(link);
}

export async function playAudio(query) {
  const ytdl = (await import('@distube/ytdl-core')).default;
  const ytSearch = (await import('yt-search')).default;

  let url = query.trim();
  let title = null;
  if (!ytdl.validateURL(url)) {
    const res = await ytSearch(url);
    const first = res?.videos?.[0];
    if (!first) throw new Error('no search results');
    url = first.url;
    title = first.title;
  }

  const agent = ytAgent(ytdl);
  const info = await withTimeout(ytdl.getInfo(url, agent ? { agent } : {}), YT_INFO_TIMEOUT_MS, 'yt info timed out');
  title = title || info.videoDetails.title;
  const seconds = Number(info.videoDetails.lengthSeconds) || 0;
  if (seconds && seconds > MAX_SONG_SECONDS) throw new Error('too long');

  // Prefer an m4a/mp4 audio-only track — WhatsApp plays it natively (no ffmpeg).
  let format;
  try {
    format = ytdl.chooseFormat(info.formats, {
      quality: 'highestaudio',
      filter: f => f.hasAudio && !f.hasVideo && /mp4|m4a/i.test(f.container || ''),
    });
  } catch { /* none — fall back below */ }
  if (!format) format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
  if (!format) throw new Error('no audio format');

  const stream = ytdl.downloadFromInfo(info, { format, agent, highWaterMark: 1 << 25 });
  const buffer = await streamToBuffer(stream, MAX_AUDIO_BYTES, YT_STREAM_TIMEOUT_MS);
  const mimetype = /mp4|m4a/i.test(format.container || '') ? 'audio/mp4' : 'audio/webm';
  return { buffer, title, url, mimetype };
}

// YouTube video via ytdl-core (ruhend's ytmp4 is broken like its ytmp3).
// itag 18 = 360p mp4 with audio muxed in — plays natively, no ffmpeg.
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;

export async function ytVideo(link) {
  const ytdl = (await import('@distube/ytdl-core')).default;
  if (!ytdl.validateURL(link)) throw new Error('bad yt link');
  const agent = ytAgent(ytdl);
  const info = await withTimeout(ytdl.getInfo(link, agent ? { agent } : {}), YT_INFO_TIMEOUT_MS, 'yt info timed out');
  const title = info.videoDetails.title || 'video';

  let format;
  try {
    format = ytdl.chooseFormat(info.formats, { quality: '18' }); // 360p mp4+audio
  } catch { /* fall through */ }
  if (!format) {
    format = ytdl.chooseFormat(info.formats, {
      quality: 'highest',
      filter: f => f.hasAudio && f.hasVideo && /mp4/i.test(f.container || ''),
    });
  }
  if (!format) throw new Error('no playable format');
  if (Number(format.contentLength || 0) > MAX_VIDEO_BYTES) throw new Error('too large');

  const stream = ytdl.downloadFromInfo(info, { format, agent, highWaterMark: 1 << 25 });
  const buffer = await streamToBuffer(stream, MAX_VIDEO_BYTES, YT_STREAM_TIMEOUT_MS);
  return { buffer, title };
}

export async function tiktok(link) {
  const s = await scraper();
  const res = await s.ttdl(link);
  const url = res?.video || firstUrl(res);
  if (!url) throw new Error('no tiktok url');
  return { buffer: await fetchBuffer(url), title: res?.title || 'tiktok' };
}

export async function instagram(link) {
  const s = await scraper();
  const res = await s.igdl(link);
  const items = res?.data || res || [];
  const url = firstUrl(items);
  if (!url) throw new Error('no instagram url');
  // Detect image vs video from the resolved URL so the caller sends the right
  // kind — reply() swallows send errors, so a throw-based fallback never fired.
  const type = /\.(jpe?g|png|webp|heic|heif)(\?|$)/i.test(url) ? 'image' : 'video';
  return { buffer: await fetchBuffer(url), type };
}

export async function twitterX(link) {
  // vxtwitter public API — no installed lib covers X
  const m = link.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/i);
  if (!m) throw new Error('bad x link');
  const j = await fetchJson(`https://api.vxtwitter.com/${m[1]}/status/${m[2]}`);
  const media = j.media_extended?.[0];
  if (!media?.url) throw new Error('no media in that post');
  return { buffer: await fetchBuffer(media.url), type: media.type === 'image' ? 'image' : 'video', text: j.text || '' };
}
