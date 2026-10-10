import { getWelcome, GLOBAL, isToggled } from '../db/queries.js';
import { groupMeta, mentionTag } from '../lib/helpers.js';

function render(template, jid, subject) {
  return template
    .replaceAll('{user}', mentionTag(jid))
    .replaceAll('{group}', subject);
}

/** Wired to sock.ev 'group-participants.update' in index.js. */
export async function handleParticipantsUpdate(sock, { id: chatId, participants, action }) {
  if (action !== 'add' && action !== 'remove') return;
  if (isToggled(GLOBAL, 'panic', false)) return; // kill switch (HARDEN #7)
  const cfg = getWelcome(chatId);
  if (!cfg?.enabled) return;

  let subject = 'the group';
  try { subject = (await groupMeta(sock, chatId)).subject; } catch { /* keep default */ }

  const template = action === 'add'
    ? (cfg.join_text || `👋 Welcome {user} to *{group}*!`)
    : (cfg.leave_text || `👋 {user} left *{group}*. Safe travels.`);

  // Aggregate into ONE message (mentions capped) instead of one send per
  // participant — a message-per-user burst on a bulk add is a classic
  // spam-ban trigger for a personal WhatsApp account.
  const MAX_TAG = 20;
  const tagged = participants.slice(0, MAX_TAG);
  if (!tagged.length) return;
  const text = tagged.map(jid => render(template, jid, subject)).join('\n');
  try {
    await sock.sendMessage(chatId, { text, mentions: tagged });
  } catch (err) {
    console.error('[RF] welcome send failed:', err.message);
  }
}
