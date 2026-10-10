// Phase 6 — sticker maker (stickers-formatter; video stickers need ffmpeg on PATH)
import sharp from 'sharp';
import { GLOBAL, getConfig, setConfig } from '../db/queries.js';
import {
  reply, PREFIX, quotedInfo, contentTypeOf, downloadQuoted, downloadFromMsg, unwrapMessage,
} from '../lib/helpers.js';

function packName() { return getConfig(GLOBAL, 'sticker_pack', process.env.STICKER_PACKNAME || '𝐵𝑌 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺'); }
function authorName() { return getConfig(GLOBAL, 'sticker_author', process.env.OWNER_NAME || 'RED FLAG'); }

// Reject oversized source media BEFORE downloading it into memory. `sticker` is
// a public command, so a group member replying to a 100 MB video must not be
// able to make the bot buffer it. 25 MB is plenty for any sticker source.
const MAX_STICKER_SRC_BYTES = 25 * 1024 * 1024;
function srcSize(message) {
  const m = unwrapMessage(message);
  const inner = m.imageMessage || m.videoMessage || m.stickerMessage;
  return Number(inner?.fileLength || 0);
}

async function handleSticker(sock, msg, args) {
  if ((args[0] || '').toLowerCase() === 'pack') {
    const name = args.slice(1).join(' ').trim();
    if (!name) return reply(sock, msg, `Current pack: *${packName()}* by *${authorName()}*\nSet: *${PREFIX()}sticker pack <name>*`);
    setConfig(GLOBAL, 'sticker_pack', name);
    return reply(sock, msg, `✅ Sticker pack name set to *${name}*.`);
  }

  // media source: replied message or the command message itself (image/video with caption)
  const q = quotedInfo(msg);
  let type, buffer;
  if (q && ['image', 'video', 'sticker'].includes(contentTypeOf(q.message))) {
    type = contentTypeOf(q.message);
    if (srcSize(q.message) > MAX_STICKER_SRC_BYTES) return reply(sock, msg, '🎟️ That media is too large to turn into a sticker (keep it small — a short clip or an image).');
    buffer = await downloadQuoted(msg);
  } else if (['image', 'video'].includes(contentTypeOf(msg.message))) {
    type = contentTypeOf(msg.message);
    if (srcSize(msg.message) > MAX_STICKER_SRC_BYTES) return reply(sock, msg, '🎟️ That media is too large to turn into a sticker (keep it small — a short clip or an image).');
    buffer = await downloadFromMsg(msg);
  } else {
    return reply(sock, msg, `Send or reply to an *image/short video* with *${PREFIX()}sticker*.`);
  }

  try {
    const { Sticker } = await import('stickers-formatter');
    const sticker = new Sticker(buffer, {
      pack: packName(),
      author: authorName(),
      type: 'full',
      quality: 70,
    });
    await sock.sendMessage(msg.key.remoteJid, await sticker.toMessage(), { quoted: msg });
  } catch (err) {
    console.error('[RF] sticker failed:', err.message);
    if (type === 'video') return reply(sock, msg, '🎟️ Video sticker failed — ffmpeg may be missing, or the clip is too long (keep it under ~7s).');
    return reply(sock, msg, '🎟️ Sticker creation failed. Try another image.');
  }
}

async function handleToImg(sock, msg) {
  const q = quotedInfo(msg);
  if (!q || contentTypeOf(q.message) !== 'sticker') {
    return reply(sock, msg, `Reply to a *sticker* with *${PREFIX()}toimg*.`);
  }
  const isAnimated = !!unwrapMessage(q.message).stickerMessage?.isAnimated;
  try {
    const webp = await downloadQuoted(msg);
    if (isAnimated) {
      // animated webp → send as gif-style video is unreliable without ffmpeg; grab first frame instead
      const png = await sharp(webp, { animated: false }).png().toBuffer();
      return reply(sock, msg, { image: png, caption: '🖼️ First frame (animated sticker).' });
    }
    const png = await sharp(webp).png().toBuffer();
    return reply(sock, msg, { image: png });
  } catch (err) {
    console.error('[RF] toimg failed:', err.message);
    return reply(sock, msg, '🖼️ Couldn\'t convert that sticker.');
  }
}

export const commands = [
  { name: 'sticker', aliases: ['s'], execute: handleSticker },
  { name: 'toimg', execute: handleToImg },
];
