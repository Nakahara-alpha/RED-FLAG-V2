// Phase 3 — AI brain (Groq/Gemini/AgentRouter via services/ai-client.js)
import { aiChat, aiPdf, listAgentRouterModels, currentModel, agentRouterConfigured } from '../services/ai-client.js';
import { ocrImage } from '../services/ocr.js';
import { transcribeAudio } from '../services/transcriber.js';
import { recentMsgs, GLOBAL, getConfig, setConfig, delConfig } from '../db/queries.js';
import {
  reply, PREFIX, getText, quotedInfo, contentTypeOf, downloadQuoted, jidNum, unwrapMessage,
} from '../lib/helpers.js';

// ai-client throws user-facing messages that start with a known emoji (🤖/🎙️/📄).
// Pass those through; anything else is an internal error — log it and show a
// generic line instead of leaking raw provider/stack text into the chat.
const PASSTHRU = ['🤖', '🎙️', '📄'];
function sayErr(sock, msg, err, fallback = '⚠️ Something went wrong. Try again shortly.') {
  const m = err?.message || '';
  if (PASSTHRU.some(p => m.startsWith(p))) return reply(sock, msg, m);
  console.error('[RF] AI command failed:', err);
  return reply(sock, msg, fallback);
}

async function handleAi(sock, msg, args) {
  const prompt = args.join(' ').trim();
  if (!prompt) return reply(sock, msg, `Usage: *${PREFIX()}ai <prompt>*`);
  try {
    const answer = await aiChat(prompt, 'You are a helpful assistant inside a WhatsApp bot. Be concise. Plain text only, no markdown headers.');
    return reply(sock, msg, `🤖 ${answer}`);
  } catch (err) { return sayErr(sock, msg, err); }
}

async function handleSummarize(sock, msg, args) {
  const n = Math.min(parseInt(args[0], 10) || 50, 300);
  const rows = recentMsgs(msg.key.remoteJid, n).filter(r => r.content);
  if (rows.length < 3) return reply(sock, msg, '📝 Not enough cached messages in this chat yet.');
  const transcript = rows.map(r => `${r.push_name || '+' + jidNum(r.sender)}: ${r.content}`).join('\n').slice(0, 12000);
  try {
    const summary = await aiChat(
      `Summarize this WhatsApp conversation in a few short bullet points. Mention who said what where it matters:\n\n${transcript}`,
      'You summarize chats. Be brief and concrete. Plain text bullets.');
    return reply(sock, msg, `📝 *Summary of last ${rows.length} messages:*\n\n${summary}`);
  } catch (err) { return sayErr(sock, msg, err); }
}

async function handleTldr(sock, msg, args) {
  const q = quotedInfo(msg);
  const quotedText = q ? getText(q.message) : '';
  const inline = args.join(' ').trim();
  const source = quotedText || inline;

  // replied-to document (PDF)?
  if (q && contentTypeOf(q.message) === 'document') {
    const doc = unwrapMessage(q.message).documentMessage;
    if (!/pdf/i.test(doc?.mimetype || '')) return reply(sock, msg, '📄 I can only TLDR PDF documents for now.');
    try {
      const buf = await downloadQuoted(msg);
      const out = await aiPdf(buf, 'Give a concise TLDR of this document: key points as short bullets.');
      return reply(sock, msg, `📄 *TLDR:*\n\n${out}`);
    } catch (err) { return sayErr(sock, msg, err); }
  }

  const urlMatch = source.match(/https?:\/\/\S+/);
  if (urlMatch) {
    try {
      const res = await fetch(urlMatch[0], { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
      const html = await res.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 12000);
      const out = await aiChat(`TLDR this web page content in short bullets:\n\n${text}`,
        'You summarize articles. Short bullets, plain text.');
      return reply(sock, msg, `🔗 *TLDR:*\n\n${out}`);
    } catch (err) {
      return reply(sock, msg, err.message.startsWith('🤖') ? err.message : '🔗 Could not fetch that link.');
    }
  }

  if (source) {
    try {
      const out = await aiChat(`TLDR this:\n\n${source.slice(0, 12000)}`, 'Short bullets, plain text.');
      return reply(sock, msg, `📝 *TLDR:*\n\n${out}`);
    } catch (err) { return sayErr(sock, msg, err); }
  }
  return reply(sock, msg, `Reply to a link/text/PDF with *${PREFIX()}tldr*, or *${PREFIX()}tldr <link>*.`);
}

async function handleTranslate(sock, msg, args) {
  const lang = args[0];
  let text = args.slice(1).join(' ').trim();
  if (!text) {
    const q = quotedInfo(msg);
    text = q ? getText(q.message) : '';
  }
  if (!lang || !text) return reply(sock, msg, `Usage: *${PREFIX()}tr <lang> <text>* (or reply to a message) — e.g. \`${PREFIX()}tr yoruba how are you\``);
  try {
    const out = await aiChat(
      `Translate the following into ${lang}. Auto-detect the source language. Reply with ONLY the translation:\n\n${text}`);
    return reply(sock, msg, `🌐 ${out}`);
  } catch (err) { return sayErr(sock, msg, err); }
}

async function handleDraft(sock, msg, args) {
  const instruction = args.join(' ').trim();
  if (!instruction) return reply(sock, msg, `Usage: *${PREFIX()}draft <what to write>* — e.g. \`${PREFIX()}draft polite message to my lecturer asking for an extension\``);
  try {
    const out = await aiChat(
      `Write a WhatsApp message for this: ${instruction}. Reply with ONLY the message text, ready to copy-send. Keep the tone natural.`);
    return reply(sock, msg, `✍️ *Draft (copy below):*\n\n${out}`);
  } catch (err) { return sayErr(sock, msg, err); }
}

async function handleOcr(sock, msg) {
  const q = quotedInfo(msg);
  if (!q || contentTypeOf(q.message) !== 'image') {
    return reply(sock, msg, `Reply to an *image* with *${PREFIX()}ocr* to extract its text.`);
  }
  try {
    const buf = await downloadQuoted(msg);
    const mime = unwrapMessage(q.message).imageMessage?.mimetype || 'image/jpeg';
    const text = await ocrImage(buf, mime);
    return reply(sock, msg, `🔎 *OCR:*\n\n${text}`);
  } catch (err) { return sayErr(sock, msg, err); }
}

async function handleTranscribe(sock, msg) {
  const q = quotedInfo(msg);
  if (!q || contentTypeOf(q.message) !== 'audio') {
    return reply(sock, msg, `Reply to a *voice note* with *${PREFIX()}transcribe*.`);
  }
  try {
    const buf = await downloadQuoted(msg);
    const mime = unwrapMessage(q.message).audioMessage?.mimetype || 'audio/ogg';
    const text = await transcribeAudio(buf, mime.split(';')[0]);
    return reply(sock, msg, text ? `🎙️ *Transcript:*\n\n${text}` : '🎙️ I couldn\'t hear anything in that.');
  } catch (err) { return sayErr(sock, msg, err); }
}

// ── AgentRouter model control ─────────────────────────────────────────────────
// `.aimodel`            → show the active model
// `.aimodel list`       → list model ids this key can use (live)
// `.aimodel <id>`       → switch the AgentRouter chat model (persists)
// `.aimodel reset`      → go back to the configured default
async function handleAiModel(sock, msg, args) {
  const sub = args.join(' ').trim();
  if (!agentRouterConfigured()) {
    return reply(sock, msg, '🤖 AgentRouter isn\'t set up. Add *AGENTROUTER_API_KEY* in config.env (key from agentrouter.org/console/token) and restart.');
  }
  if (!sub) {
    return reply(sock, msg,
      `🤖 *AI model (AgentRouter):* \`${currentModel()}\`\n\n` +
      `*${PREFIX()}aimodel list* — what your key can use\n` +
      `*${PREFIX()}aimodel <id>* — switch model\n` +
      `*${PREFIX()}aimodel reset* — back to default`);
  }
  if (sub.toLowerCase() === 'list') {
    try {
      const ids = await listAgentRouterModels();
      if (!ids.length) return reply(sock, msg, '🤖 AgentRouter returned no models for this key.');
      return reply(sock, msg, `🤖 *Available models (${ids.length}):*\n${ids.map(i => `• \`${i}\``).join('\n')}\n\nSwitch: *${PREFIX()}aimodel <id>*`);
    } catch (err) {
      return reply(sock, msg, err.message?.startsWith('🤖') ? err.message : '🤖 Couldn\'t fetch the model list.');
    }
  }
  if (sub.toLowerCase() === 'reset') {
    delConfig(GLOBAL, 'ai_model');
    return reply(sock, msg, `🤖 AI model reset to the default: \`${currentModel()}\``);
  }
  // treat the argument as a model id (no spaces expected)
  const id = args[0];
  setConfig(GLOBAL, 'ai_model', id);
  return reply(sock, msg, `🤖 AI model set to \`${id}\`.\n_(If requests start failing, it may not be on your plan — try *${PREFIX()}aimodel list*.)_`);
}

export const commands = [
  { name: 'ai', aliases: ['ask', 'gpt'], execute: handleAi },
  { name: 'aimodel', aliases: ['model', 'setmodel'], execute: handleAiModel },
  { name: 'summarize', aliases: ['sum'], execute: handleSummarize },
  { name: 'tldr', execute: handleTldr },
  { name: 'tr', aliases: ['translate'], execute: handleTranslate },
  { name: 'draft', execute: handleDraft },
  { name: 'ocr', execute: handleOcr },
  { name: 'transcribe', aliases: ['vn'], execute: handleTranscribe },
];
