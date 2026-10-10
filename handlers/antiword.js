import { isToggled, listAntiwords, bumpWarn, resetWarns } from '../db/queries.js';
import { isOwnerMsg, isGroupAdmin, botIsAdmin, senderJid, mentionTag } from '../lib/helpers.js';

function warnLimit() {
  const n = parseInt(process.env.WARN_LIMIT, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

// HARDEN #5: one "need admin" notice per chat per boot
const adminNoticeSent = new Set();

/** Returns true if the message was handled (deleted). */
export async function checkAntiword(sock, msg, body) {
  const chatId = msg.key.remoteJid;
  if (!isToggled(chatId, 'antiword', false)) return false;

  const words = listAntiwords(chatId);
  if (!words.length) return false;
  const lower = body.toLowerCase();
  const hit = words.find(w => new RegExp(`(^|\\W)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\W)`, 'i').test(lower));
  if (!hit) return false;

  const sender = senderJid(msg, sock);
  if (isOwnerMsg(msg, sock) || await isGroupAdmin(sock, chatId, sender)) return false;

  const canModerate = await botIsAdmin(sock, chatId);
  if (!canModerate) {
    // Can't enforce — announce once and STOP. Don't accumulate warnings while
    // powerless: otherwise a user racks up strikes they can't see enforced and
    // gets kicked the instant the bot is later promoted to admin.
    if (!adminNoticeSent.has(chatId)) {
      adminNoticeSent.add(chatId);
      await sock.sendMessage(chatId, { text: '⚠️ Antiword is on here, but I need *admin rights* to delete messages and kick repeat offenders.' });
    }
    return false;
  }

  try { await sock.sendMessage(chatId, { delete: msg.key }); } catch { /* already gone */ }

  const count = bumpWarn(chatId, sender);
  const limit = warnLimit();

  if (count >= limit) {
    try {
      await sock.groupParticipantsUpdate(chatId, [sender], 'remove');
      await sock.sendMessage(chatId, {
        text: `🤬 ${mentionTag(sender)} removed — ${count}/${limit} warnings (banned word).`,
        mentions: [sender],
      });
      resetWarns(chatId, sender); // fresh start if they rejoin, so they aren't pre-kicked
      return true;
    } catch { /* fall through to warn text */ }
  }
  await sock.sendMessage(chatId, {
    text: `⚠️ ${mentionTag(sender)} that word is banned here. Warning ${count}/${limit}.`,
    mentions: [sender],
  });
  return true;
}
