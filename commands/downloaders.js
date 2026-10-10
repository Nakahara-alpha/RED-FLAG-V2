// Phase 6 — downloaders (ruhend-scraper + vxtwitter; see DECISIONS.md)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ytAudio, ytVideo, tiktok, instagram, twitterX, playAudio } from '../services/downloader.js';
import { reply, PREFIX, quotedInfo, contentTypeOf, downloadQuoted } from '../lib/helpers.js';

const execAsync = promisify(exec);

async function handlePlay(sock, msg, args) {
  const query = args.join(' ').trim();
  if (!query) return reply(sock, msg, `Usage: *${PREFIX()}play <song name or YouTube link>* — e.g. \`${PREFIX()}play burna boy last last\``);
  await reply(sock, msg, `🎧 Searching for *${query}*…`);
  try {
    const { buffer, title, mimetype } = await playAudio(query);
    return reply(sock, msg, {
      audio: buffer,
      mimetype: mimetype || 'audio/mp4',
      fileName: `${(title || 'audio').replace(/[\\/:*?"<>|]/g, '')}.m4a`,
    });
  } catch (err) {
    console.error('[RF] play failed:', err.message);
    const hint = err.message === 'too long' ? ' (that one\'s over 30 min)'
      : err.message === 'too large' ? ' (that one\'s too big to send)' : '';
    return reply(sock, msg, `🎧 Couldn't fetch that song${hint} — try a more specific name or a direct link.`);
  }
}

async function handleYt(sock, msg, args) {
  const link = args.find(a => /youtu\.?be/i.test(a));
  const wantAudio = args.some(a => /^(mp3|audio)$/i.test(a));
  if (!link) return reply(sock, msg, `Usage: *${PREFIX()}yt <link> [mp3]* — mp4 by default.`);
  await reply(sock, msg, `⬇️ Fetching ${wantAudio ? 'audio' : 'video'}… give me a moment.`);
  try {
    if (wantAudio) {
      const { buffer, title, mimetype } = await ytAudio(link);
      return reply(sock, msg, {
        audio: buffer,
        mimetype: mimetype || 'audio/mp4',
        fileName: `${(title || 'audio').replace(/[\\/:*?"<>|]/g, '')}.m4a`,
      });
    }
    const { buffer, title } = await ytVideo(link);
    return reply(sock, msg, { video: buffer, caption: `🎬 ${title}` });
  } catch (err) {
    console.error('[RF] yt failed:', err.message);
    const hint = err.message === 'too large' ? ' (over 60 MB — try the mp3)' : '';
    return reply(sock, msg, `⬇️ That YouTube download failed${hint} — try again or use *${PREFIX()}play* for audio.`);
  }
}

async function handleTiktok(sock, msg, args) {
  const link = args.find(a => /tiktok\.com/i.test(a));
  if (!link) return reply(sock, msg, `Usage: *${PREFIX()}tiktok <link>* (no watermark)`);
  await reply(sock, msg, '⬇️ Grabbing that TikTok…');
  try {
    const { buffer, title } = await tiktok(link);
    return reply(sock, msg, { video: buffer, caption: `🎵 ${title || 'TikTok'}` });
  } catch (err) {
    console.error('[RF] tiktok failed:', err.message);
    return reply(sock, msg, '⬇️ TikTok download failed — try again or use a different link.');
  }
}

async function handleIg(sock, msg, args) {
  const link = args.find(a => /instagram\.com/i.test(a));
  if (!link) return reply(sock, msg, `Usage: *${PREFIX()}ig <link>*`);
  await reply(sock, msg, '⬇️ Grabbing that from IG…');
  try {
    const { buffer, type } = await instagram(link);
    return reply(sock, msg, type === 'image'
      ? { image: buffer, caption: '📸 Instagram' }
      : { video: buffer, caption: '📸 Instagram' });
  } catch (err) {
    console.error('[RF] ig failed:', err.message);
    return reply(sock, msg, '⬇️ Instagram download failed — private posts can\'t be fetched.');
  }
}

async function handleX(sock, msg, args) {
  // Anchor to a host boundary so "x.com" doesn't match inside e.g. netflix.com.
  const link = args.find(a => /(?:^|\/\/|\.)(?:twitter|x)\.com\//i.test(a));
  if (!link) return reply(sock, msg, `Usage: *${PREFIX()}x <link>*`);
  await reply(sock, msg, '⬇️ Grabbing that post…');
  try {
    const { buffer, type, text } = await twitterX(link);
    const caption = `🐦 ${text.slice(0, 200)}`;
    return reply(sock, msg, type === 'image' ? { image: buffer, caption } : { video: buffer, caption });
  } catch (err) {
    console.error('[RF] x failed:', err.message);
    return reply(sock, msg, '⬇️ Couldn\'t fetch that post — it may have no media or be from a private account.');
  }
}

async function handleCompress(sock, msg) {
  const q = quotedInfo(msg);
  if (!q || contentTypeOf(q.message) !== 'video') {
    return reply(sock, msg, `Reply to a *video* with *${PREFIX()}compress*.`);
  }
  try { await execAsync('ffmpeg -version', { timeout: 5000 }); }
  catch { return reply(sock, msg, '🗜️ Compression needs *ffmpeg* installed and on PATH.'); }

  await reply(sock, msg, '🗜️ Compressing… this can take a minute.');
  const tmpIn = path.join(os.tmpdir(), `rf-in-${Date.now()}.mp4`);
  const tmpOut = path.join(os.tmpdir(), `rf-out-${Date.now()}.mp4`);
  try {
    fs.writeFileSync(tmpIn, await downloadQuoted(msg));
    await execAsync(
      `ffmpeg -y -i "${tmpIn}" -vf "scale='min(720,iw)':-2" -c:v libx264 -crf 28 -preset veryfast -c:a aac -b:a 96k "${tmpOut}"`,
      { timeout: 5 * 60 * 1000 },
    );
    const out = fs.readFileSync(tmpOut);
    const before = (fs.statSync(tmpIn).size / 1024 / 1024).toFixed(1);
    const after = (out.length / 1024 / 1024).toFixed(1);
    await reply(sock, msg, { video: out, caption: `🗜️ ${before} MB → ${after} MB` });
  } catch (err) {
    console.error('[RF] compress failed:', err.message);
    await reply(sock, msg, '🗜️ Compression failed — the video may be too large.');
  } finally {
    for (const f of [tmpIn, tmpOut]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
  }
}

export const commands = [
  { name: 'play', aliases: ['song', 'music'], execute: handlePlay },
  { name: 'yt', aliases: ['ytdl'], execute: handleYt },
  { name: 'tiktok', aliases: ['tt-dl', 'ttdl'], execute: handleTiktok },
  { name: 'ig', aliases: ['insta'], execute: handleIg },
  { name: 'x', aliases: ['twitter'], execute: handleX },
  { name: 'compress', execute: handleCompress },
];
