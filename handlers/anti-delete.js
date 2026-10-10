import fs from 'fs';
import path from 'path';
import { GLOBAL, getConfig, cacheMsg, getCachedMsg, setCachedMediaPath, isToggled, MEDIA_DIR } from '../db/queries.js';
import {
  contentTypeOf, getText, unwrapMessage, isViewOnce, senderPhoneJid, resolvePhoneJid, jidNum,
  downloadFromMsg, dmOwner, ownerJid, groupMeta, fmtDT,
} from '../lib/helpers.js';

const CACHEABLE_MEDIA = new Set(['image', 'video', 'audio', 'sticker', 'document']);
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const EXT = { image: 'jpg', video: 'mp4', audio: 'ogg', sticker: 'webp', document: 'bin' };

function mediaSize(message) {
  const m = unwrapMessage(message);
  const inner = m.imageMessage || m.videoMessage || m.audioMessage || m.stickerMessage || m.documentMessage;
  return Number(inner?.fileLength || 0);
}

// Where deleted messages from this chat should go, or null if anti-delete is off.
// Global mode (all chats → one number) overrides the per-chat setting.
function antideleteDest(sock, chatId) {
  if (isToggled(GLOBAL, 'antidelete_all', false)) {
    const to = getConfig(GLOBAL, 'antidelete_to', '');
    if (to) return to;
  }
  if (isToggled(chatId, 'antidelete', false)) return ownerJid(sock);
  return null;
}
function antideleteActive(sock, chatId) {
  // Must agree with antideleteDest — otherwise media gets cached (disk I/O) in a
  // state where handleRevoke has nowhere to send it (global on, destination empty).
  return antideleteDest(sock, chatId) !== null;
}
async function sendTo(sock, dest, payload) {
  const body = typeof payload === 'string' ? { text: payload } : payload;
  try { await sock.sendMessage(dest, body); }
  catch (err) { console.error('[RF] anti-delete send failed:', err.message); }
}

/** Cache every incoming message (text sync, media async) — must stay cheap. */
export function cacheIncoming(sock, msg) {
  const chatId = msg.key.remoteJid;
  const type = contentTypeOf(msg.message);
  cacheMsg({
    msg_id: msg.key.id,
    chat_id: chatId,
    sender: senderPhoneJid(msg, sock) || null,
    push_name: msg.pushName || null,
    type,
    content: getText(msg.message) || null,
    media_path: null,
    from_me: msg.key.fromMe ? 1 : 0,
    ts: Date.now(),
  });

  // media: fire-and-forget, never blocks the pipeline
  if (!msg.key.fromMe && CACHEABLE_MEDIA.has(type)
      && antideleteActive(sock, chatId)
      && mediaSize(msg.message) <= MAX_MEDIA_BYTES) {
    (async () => {
      try {
        const buf = await downloadFromMsg(msg);
        const file = path.join(MEDIA_DIR, `${msg.key.id.replace(/[^\w-]/g, '')}.${EXT[type]}`);
        fs.writeFileSync(file, buf);
        setCachedMediaPath(msg.key.id, file);
      } catch { /* media may already be gone */ }
    })();
  }
}

/** A delete-for-everyone came in — resend the original to the configured DM. */
export async function handleRevoke(sock, msg, proto) {
  if (msg.key.fromMe) return; // own deletes don't need reporting
  const chatId = msg.key.remoteJid;
  const dest = antideleteDest(sock, chatId);
  if (!dest) return;

  const deletedId = proto.key?.id;
  if (!deletedId) return;
  const cached = getCachedMsg(deletedId);
  if (!cached) return;

  let where = 'DM';
  if (chatId.endsWith('@g.us')) {
    try { where = `group "${(await groupMeta(sock, chatId)).subject}"`; } catch { where = 'a group'; }
  }
  // resolve a LID to a real phone number if it slipped through at capture time
  const senderStr = await resolvePhoneJid(sock, cached.sender);
  const who = senderStr?.endsWith('@lid')
    ? `${cached.push_name || 'Unknown'} (number hidden by WhatsApp)`
    : `${cached.push_name || 'Unknown'} (+${jidNum(senderStr)})`;
  const header = `🗑️ *Anti-delete*\n👤 ${who}\n📍 ${where}\n🕒 sent ${fmtDT(cached.ts)}, deleted ${fmtDT(Date.now())}`;

  if (cached.media_path && fs.existsSync(cached.media_path)) {
    const buf = fs.readFileSync(cached.media_path);
    const caption = `${header}${cached.content ? `\n\n💬 ${cached.content}` : ''}`;
    const payloads = {
      image: { image: buf, caption },
      video: { video: buf, caption },
      audio: { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true },
      sticker: { sticker: buf },
      document: { document: buf, fileName: 'deleted-file', mimetype: 'application/octet-stream', caption },
    };
    await sendTo(sock, dest, payloads[cached.type] || { text: `${header}\n\n(unsupported media type)` });
    if (cached.type === 'audio' || cached.type === 'sticker') await sendTo(sock, dest, header);
  } else if (cached.content) {
    await sendTo(sock, dest, `${header}\n\n💬 ${cached.content}`);
  } else {
    await sendTo(sock, dest, `${header}\n\n_(a ${cached.type} message — media no longer cached)_`);
  }
}

/** Auto-save incoming view-once media to the owner. */
export function captureViewOnce(sock, msg) {
  if (msg.key.fromMe) return;
  if (!isViewOnce(msg.message)) return;
  const chatId = msg.key.remoteJid;
  if (!isToggled(chatId, 'viewonce', false)) return;

  (async () => {
    try {
      const buf = await downloadFromMsg(msg);
      const type = contentTypeOf(msg.message);
      const senderStr = await resolvePhoneJid(sock, senderPhoneJid(msg, sock));
      const who = senderStr?.endsWith('@lid')
        ? `${msg.pushName || 'Unknown'} (number hidden)`
        : `${msg.pushName || 'Unknown'} (+${jidNum(senderStr)})`;
      let where = 'DM';
      if (chatId.endsWith('@g.us')) {
        try { where = `group "${(await groupMeta(sock, chatId)).subject}"`; } catch { where = 'a group'; }
      }
      const caption = `👁️ *View-once saved*\n👤 ${who}\n📍 ${where}${getText(msg.message) ? `\n💬 ${getText(msg.message)}` : ''}`;
      if (type === 'image') await dmOwner(sock, { image: buf, caption });
      else if (type === 'video') await dmOwner(sock, { video: buf, caption });
      else if (type === 'audio') { await dmOwner(sock, { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true }); await dmOwner(sock, caption); }
    } catch (err) {
      console.error('[RF] view-once capture failed:', err.message);
    }
  })();
}
