// Feature 1 — pin-to-self (saved messages). Media saved to data/pins/ (no
// retention purge — pins live until unpinned).
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { addPin, listPins, getPin, deletePin, searchPins, getCachedMsg, PIN_DIR } from '../db/queries.js';
import {
  reply, PREFIX, quotedInfo, contentTypeOf, getText, downloadQuoted,
  jidNum, fmtDT, paginate,
} from '../lib/helpers.js';

const EXT = { image: 'jpg', video: 'mp4', audio: 'ogg', sticker: 'webp', document: 'bin' };

async function handlePin(sock, msg, args) {
  const q = quotedInfo(msg);
  if (!q) return reply(sock, msg, `Reply to a message with *${PREFIX()}pin [tag]* to save it.`);

  const tag = (args[0] || null)?.toLowerCase() || null;
  const type = contentTypeOf(q.message);
  const content = getText(q.message) || null;
  const cached = q.stanzaId ? getCachedMsg(q.stanzaId) : null;

  let mediaPath = null;
  if (EXT[type]) {
    try {
      const buf = await downloadQuoted(msg);
      // Unique name — two media pins in the same millisecond must not share a
      // file (which would overwrite one, and unpinning either would delete the
      // other's media). Date.now() alone collided.
      mediaPath = path.join(PIN_DIR, `pin-${Date.now()}-${randomUUID()}.${EXT[type]}`);
      fs.writeFileSync(mediaPath, buf);
    } catch {
      if (!content) return reply(sock, msg, '📌 Couldn\'t download that media (it may have expired). Nothing saved.');
      mediaPath = null; // save the text part anyway
    }
  }
  if (!content && !mediaPath) return reply(sock, msg, '📌 Nothing pinnable in that message.');

  const id = addPin({
    tag,
    sender: q.participant || msg.key.remoteJid,
    push_name: cached?.push_name || null,
    chat_id: msg.key.remoteJid,
    type,
    content,
    media_path: mediaPath,
    ts: Date.now(),
  });
  return reply(sock, msg, `📌 Pinned *#${id}*${tag ? ` under *${tag}*` : ''}. View: *${PREFIX()}pins*`);
}

function pinLine(p) {
  const label = p.content
    ? `"${p.content.slice(0, 50)}${p.content.length > 50 ? '…' : ''}"`
    : `<${p.type}>`;
  const from = p.push_name || '+' + jidNum(p.sender);
  return `*#${p.id}*${p.tag ? ` [${p.tag}]` : ''} ${label}\n   from ${from}, ${fmtDT(p.ts)}`;
}

async function handlePins(sock, msg, args) {
  let tag = null, page = 1;
  for (const a of args) {
    if (/^\d+$/.test(a)) page = parseInt(a, 10);
    else tag = a;
  }
  const rows = listPins(tag);
  if (!rows.length) return reply(sock, msg, tag ? `📌 No pins tagged *${tag}*.` : `📌 No pins yet. Reply to a message with *${PREFIX()}pin*.`);
  const { slice, page: p, pages, total } = paginate(rows, page, 8);
  return reply(sock, msg,
    `📌 *Pins${tag ? ` [${tag}]` : ''}* (${total}) — page ${p}/${pages}\n\n${slice.map(pinLine).join('\n')}\n\n` +
    `Open: *${PREFIX()}pin get <id>* · Remove: *${PREFIX()}unpin <id>*${pages > 1 ? ` · Next: *${PREFIX()}pins ${tag ? tag + ' ' : ''}${p + 1}*` : ''}`);
}

async function handlePinGet(sock, msg, args) {
  const id = parseInt(args[0], 10);
  const p = id ? getPin(id) : null;
  if (!p) return reply(sock, msg, `Usage: *${PREFIX()}pin get <id>* (see *${PREFIX()}pins*)`);

  const header = `📌 *Pin #${p.id}*${p.tag ? ` [${p.tag}]` : ''} — from ${p.push_name || '+' + jidNum(p.sender)}, ${fmtDT(p.ts)}`;
  if (p.media_path && fs.existsSync(p.media_path)) {
    const buf = fs.readFileSync(p.media_path);
    const caption = `${header}${p.content ? `\n\n${p.content}` : ''}`;
    const payloads = {
      image: { image: buf, caption },
      video: { video: buf, caption },
      audio: { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true },
      sticker: { sticker: buf },
      document: { document: buf, fileName: `pin-${p.id}`, mimetype: 'application/octet-stream', caption },
    };
    await reply(sock, msg, payloads[p.type] || { text: header });
    if (p.type === 'audio' || p.type === 'sticker') await reply(sock, msg, header);
    return;
  }
  return reply(sock, msg, `${header}\n\n${p.content || '_(media file no longer on disk)_'}`);
}

async function handleUnpin(sock, msg, args) {
  const id = parseInt(args[0], 10);
  if (!id) return reply(sock, msg, `Usage: *${PREFIX()}unpin <id>*`);
  const p = getPin(id);
  if (!p) return reply(sock, msg, `⚠️ No pin #${id}.`);
  if (p.media_path) { try { fs.unlinkSync(p.media_path); } catch { /* already gone */ } }
  deletePin(id);
  return reply(sock, msg, `✅ Pin #${id} removed.`);
}

async function handleFindPin(sock, msg, args) {
  const keyword = args.join(' ').trim();
  if (!keyword) return reply(sock, msg, `Usage: *${PREFIX()}findpin <keyword>*`);
  const rows = searchPins(keyword);
  if (!rows.length) return reply(sock, msg, `🔍 No pins matching "*${keyword}*".`);
  return reply(sock, msg, `🔍 *Pins matching "${keyword}":*\n\n${rows.map(pinLine).join('\n')}`);
}

export const commands = [
  {
    name: 'pin',
    execute: (sock, msg, args) =>
      (args[0] || '').toLowerCase() === 'get' ? handlePinGet(sock, msg, args.slice(1)) : handlePin(sock, msg, args),
  },
  { name: 'pins', execute: handlePins },
  { name: 'unpin', execute: handleUnpin },
  { name: 'findpin', execute: handleFindPin },
];
