// Feature 14 — view-once openers. vv → re-send to current chat, pvv → owner DM.
import {
  reply, PREFIX, quotedInfo, isViewOnce, unwrapMessage, contentTypeOf, getText,
  downloadQuoted, ownerJid,
} from '../lib/helpers.js';

async function openViewOnce(sock, msg, targetJid) {
  const q = quotedInfo(msg);
  if (!q) return reply(sock, msg, `Reply to a *view-once* message with *${PREFIX()}vv* (here) or *${PREFIX()}pvv* (to your DM).`);

  const inner = unwrapMessage(q.message);
  const looksViewOnce = isViewOnce(q.message)
    || inner.imageMessage?.viewOnce || inner.videoMessage?.viewOnce || inner.audioMessage?.viewOnce;
  if (!looksViewOnce) return reply(sock, msg, '👁️ That doesn\'t look like a view-once message.');

  const type = contentTypeOf(q.message);
  const caption = getText(q.message) || undefined;

  let buf;
  try {
    buf = await downloadQuoted(msg);
  } catch (err) {
    console.error('[RF] vv download failed:', err.message);
    return reply(sock, msg, '👁️ Couldn\'t fetch that media — view-once files expire once opened or after a while.');
  }

  try {
    if (type === 'image') await sock.sendMessage(targetJid, { image: buf, caption });
    else if (type === 'video') await sock.sendMessage(targetJid, { video: buf, caption });
    else if (type === 'audio') await sock.sendMessage(targetJid, { audio: buf, mimetype: 'audio/mp4', ptt: true });
    else return reply(sock, msg, '👁️ Unsupported view-once type.');
  } catch (err) {
    console.error('[RF] vv send failed:', err.message);
    return reply(sock, msg, '👁️ Got the media but failed to send it. Try again.');
  }
}

export const commands = [
  { name: 'vv', execute: (sock, msg) => openViewOnce(sock, msg, msg.key.remoteJid) },
  { name: 'pvv', execute: async (sock, msg) => {
      await openViewOnce(sock, msg, ownerJid(sock));
    } },
];
