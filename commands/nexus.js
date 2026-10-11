// NEXUS command — talk to the bot's AI brain in natural language. It can act on
// your data (reminders, deadlines, timetable, notes, expenses, …) via tool-calls
// through AgentRouter, and remembers context across messages. Owner-only.
import { askNexus, nexusReady } from '../services/nexus.js';
import { clearNexusHistory, listNexusMemory, deleteNexusMemory, clearNexusMemory } from '../db/queries.js';
import { reply, PREFIX, getText } from '../lib/helpers.js';

async function handleNexus(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'reset') {
    clearNexusHistory();
    return reply(sock, msg, '⚡ NEXUS conversation reset — starting fresh (saved facts kept).');
  }
  if (sub === 'memory' || sub === 'mem') {
    const mems = listNexusMemory();
    return reply(sock, msg, mems.length
      ? `⚡ *NEXUS remembers:*\n${mems.map(m => `*#${m.id}* ${m.fact}`).join('\n')}\n\nForget: *${PREFIX()}nexus forget <id|all>*`
      : '⚡ NEXUS has no saved facts yet. Tell me things like "remember I\'m a 300-level CS student".');
  }
  if (sub === 'forget') {
    if ((args[1] || '').toLowerCase() === 'all') {
      const n = clearNexusMemory();
      return reply(sock, msg, `⚡ Cleared ${n} memor${n === 1 ? 'y' : 'ies'}.`);
    }
    const id = parseInt(args[1], 10);
    if (!id) return reply(sock, msg, `Usage: *${PREFIX()}nexus forget <id|all>* (see *${PREFIX()}nexus memory*)`);
    const n = deleteNexusMemory(id);
    return reply(sock, msg, n ? `⚡ Forgot #${id}.` : `⚠️ No memory #${id}.`);
  }

  const text = args.join(' ').trim();
  if (!text) {
    return reply(sock, msg,
      `⚡ *NEXUS* — your assistant brain. Just talk to me (no prefix needed):\n` +
      `• *nexus remind me to call mum at 6pm*\n` +
      `• *nexus add CSC201 exam 2026-07-20 9am*\n` +
      `• *nexus I spent 1500 on lunch*\n` +
      `• *nexus what's due this week?*\n\n` +
      `*${PREFIX()}nexus memory* · *${PREFIX()}nexus forget <id>* · *${PREFIX()}nexus reset*`);
  }
  if (!nexusReady()) {
    return reply(sock, msg, '⚡ NEXUS needs a *GEMINI_API_KEY* in config.env (free at aistudio.google.com — several comma-separated keys spread the rate limit), then restart.');
  }
  try {
    const chatId = msg.key.remoteJid;
    // If the owner is REPLYING to a message, feed that message to NEXUS as context
    // so "nexus translate" / "nexus what does this mean" works on the quoted text.
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedText = quoted ? (getText(quoted) || '').trim() : '';
    const prompt = quotedText
      ? `[The owner is replying to this message:\n"""\n${quotedText.slice(0, 2000)}\n"""]\n\n${text}`
      : text;
    const { text: answer } = await askNexus(prompt, { sock, chatId, isGroup: chatId.endsWith('@g.us') });
    return reply(sock, msg, `⚡ ${answer}`);
  } catch (err) {
    console.error('[RF] nexus failed:', err);
    return reply(sock, msg, err.message?.startsWith('⚡')
      ? err.message
      : '⚡ NEXUS hit an error — try again, or check the AgentRouter key/model with *' + PREFIX() + 'aimodel*.');
  }
}

export const commands = [
  { name: 'nexus', aliases: ['nx'], execute: handleNexus },
];
