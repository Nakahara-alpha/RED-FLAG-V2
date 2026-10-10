// Edit tracker — WhatsApp edits arrive as protocolMessage type 14 (MESSAGE_EDIT)
// carrying the new content. The original comes from msg_cache (populated by
// anti-delete's cacheIncoming, 7-day retention — see DECISIONS.md).
import { isToggled, getCachedMsg, setCachedContent } from '../db/queries.js';
import { getText, senderJid, jidNum, dmOwner, groupMeta, fmtDT } from '../lib/helpers.js';

export async function handleEdit(sock, msg, proto) {
  if (msg.key.fromMe) return; // own edits don't need reporting
  const chatId = msg.key.remoteJid;
  if (!isToggled(chatId, 'edittrack', false)) return;

  const editedId = proto.key?.id;
  const newText = getText(proto.editedMessage);
  if (!editedId || !newText) return;

  const cached = getCachedMsg(editedId);
  const original = cached?.content || null;
  if (original === newText) return;

  // keep the cache current so a second edit diffs against this version
  if (cached) setCachedContent(editedId, newText);

  let where = 'DM';
  if (chatId.endsWith('@g.us')) {
    try { where = `group "${(await groupMeta(sock, chatId)).subject}"`; } catch { where = 'a group'; }
  }
  const who = `${cached?.push_name || msg.pushName || 'Unknown'} (+${jidNum(cached?.sender || senderJid(msg, sock))})`;

  await dmOwner(sock,
    `✏️ *Edit tracker*\n👤 ${who}\n📍 ${where}\n🕒 ${fmtDT(Date.now())}\n\n` +
    `📜 *Original:*\n${original || '_(not in cache — sent before I saw it)_'}\n\n` +
    `🆕 *Edited to:*\n${newText}`);
}
