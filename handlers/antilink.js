import { isToggled, listWhitelist, bumpLinkStrike, resetLinkStrikes } from '../db/queries.js';
import { isOwnerMsg, isGroupAdmin, botIsAdmin, senderJid, mentionTag } from '../lib/helpers.js';

const LINK_RE = /(https?:\/\/\S+|www\.\S{3,}|chat\.whatsapp\.com\/\S+|wa\.me\/\S+)/i;

// HARDEN #5: when the bot can't enforce, say so once per chat instead of a silent no-op
const adminNoticeSent = new Set();

/** Returns true if the message was handled (deleted). Warn → kick on repeat. */
export async function checkAntilink(sock, msg, body) {
  const chatId = msg.key.remoteJid;
  if (!isToggled(chatId, 'antilink', false)) return false;

  const match = body.match(LINK_RE);
  if (!match) return false;

  const link = match[0].toLowerCase();
  if (listWhitelist(chatId).some(p => link.includes(p))) return false;

  const sender = senderJid(msg, sock);
  if (isOwnerMsg(msg, sock) || await isGroupAdmin(sock, chatId, sender)) return false;

  if (!(await botIsAdmin(sock, chatId))) {
    if (!adminNoticeSent.has(chatId)) {
      adminNoticeSent.add(chatId);
      await sock.sendMessage(chatId, { text: '⚠️ Antilink is on here, but I need *admin rights* to delete links and remove offenders.' });
    }
    return false;
  }

  try { await sock.sendMessage(chatId, { delete: msg.key }); } catch { /* already gone */ }
  const strikes = bumpLinkStrike(chatId, sender);

  if (strikes >= 2) {
    try {
      await sock.groupParticipantsUpdate(chatId, [sender], 'remove');
      resetLinkStrikes(chatId, sender); // clear so a rejoiner isn't instantly re-kicked
      await sock.sendMessage(chatId, {
        text: `🔗🚫 ${mentionTag(sender)} kicked — repeated links after a warning.`,
        mentions: [sender],
      });
    } catch {
      await sock.sendMessage(chatId, {
        text: `🔗🚫 ${mentionTag(sender)} link deleted (strike ${strikes}) — I couldn't remove them.`,
        mentions: [sender],
      });
    }
  } else {
    await sock.sendMessage(chatId, {
      text: `🔗🚫 ${mentionTag(sender)} links aren't allowed here. Next one gets you removed.`,
      mentions: [sender],
    });
  }
  return true;
}
