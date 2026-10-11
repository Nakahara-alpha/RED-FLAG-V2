// Providers. For plain chat/vision the order is Gemini (multi-key) → AgentRouter
// → Groq. NEXUS's tool-calling always uses AgentRouter (OpenAI-style `tools`;
// Gemini's function-calling format differs). Keys from env only — never hardcoded.
import { GLOBAL, getConfig } from '../db/queries.js';

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

// AgentRouter (agentrouter.org) — OpenAI-compatible: POST <base>/chat/completions
// with a Bearer key. Base/model overridable so you can point at any model the
// console exposes (run `GET <base>/models` with your key to see the live list).
// Default is a DeepSeek V3 model: it's the reliably-available / low-cost option
// (the Claude/GPT ids are frequently plan-gated or hit "budget pool exhausted"
// 402s) and it supports tool-calling, which NEXUS needs.
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const AGENTROUTER_BASE = (process.env.AGENTROUTER_BASE_URL || 'https://agentrouter.org/v1').replace(/\/+$/, '');
const AGENTROUTER_URL = `${AGENTROUTER_BASE}/chat/completions`;
const AGENTROUTER_MODEL = process.env.AGENTROUTER_MODEL || 'deepseek-v3.2';
const AGENTROUTER_VISION_MODEL = process.env.AGENTROUTER_VISION_MODEL || AGENTROUTER_MODEL;

// Every network call is bounded: a stalled connection must THROW (not hang) so
// the provider-fallback chain can move on. Without this, a hung socket never
// rejects and the command replies never arrive.
const AI_TIMEOUT_MS = (parseInt(process.env.AI_TIMEOUT_MS, 10) || 30000);

export class AiUnavailableError extends Error {}

function groqKey() { return process.env.GROQ_API_KEY; }
function agentRouterKey() { return process.env.AGENTROUTER_API_KEY; }

// Gemini supports MULTIPLE keys — comma-separated in GEMINI_API_KEY and/or
// GEMINI_API_KEYS. We round-robin which key leads and, if one fails (quota/rate/
// auth), fall through to the next; only when ALL keys fail does Gemini as a whole
// fail and the chain moves on to AgentRouter.
function geminiKeys() {
  const raw = `${process.env.GEMINI_API_KEY || ''},${process.env.GEMINI_API_KEYS || ''}`;
  return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
}
let _gemIdx = 0;

// Active AgentRouter chat model: a live override set via `.aimodel <id>` (stored
// in config) wins over the env/default, so the owner can switch models without
// a restart.
export function currentModel() {
  return getConfig(GLOBAL, 'ai_model', null) || AGENTROUTER_MODEL;
}
export function agentRouterConfigured() { return !!agentRouterKey(); }

/** List the model ids this AgentRouter key can see (GET <base>/models). */
export async function listAgentRouterModels() {
  const key = agentRouterKey();
  if (!key) throw new Error('🤖 No AGENTROUTER_API_KEY set in config.env.');
  const res = await fetch(`${AGENTROUTER_BASE}/models`, {
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'red-flag-bot/2.0' },
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`🤖 AgentRouter /models ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  return (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
}

// Generic OpenAI-compatible chat completion — shared by Groq and AgentRouter.
async function openAiChat(url, key, messages, { model, maxTokens = 1024, label = 'ai' } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      // Some gateways (AgentRouter behind its WAF) reject requests with no
      // User-Agent as "unauthorized client" — send a stable, honest one.
      'User-Agent': 'red-flag-bot/2.0',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.6 }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content?.trim();
  // Treat an empty/filtered completion as a failure so the next provider runs,
  // rather than returning '' and showing the user a blank reply.
  if (!content) throw new Error(`${label}: empty response`);
  return content;
}

async function groqChat(messages, { model = GROQ_MODEL, maxTokens = 1024 } = {}) {
  const key = groqKey();
  if (!key) throw new AiUnavailableError('no groq key');
  return openAiChat(GROQ_URL, key, messages, { model, maxTokens, label: 'groq' });
}

async function agentRouterChat(messages, { model = currentModel(), maxTokens = 1024 } = {}) {
  const key = agentRouterKey();
  if (!key) throw new AiUnavailableError('no agentrouter key');
  return openAiChat(AGENTROUTER_URL, key, messages, { model, maxTokens, label: 'agentrouter' });
}

export function agentRouterReady() { return !!agentRouterKey(); }

/**
 * Raw OpenAI-compatible completion that PRESERVES tool_calls — the primitive the
 * NEXUS agent loop drives. Returns the assistant message object as-is
 * ({ role, content, tool_calls? }). Throws AiUnavailableError if no key.
 */
export async function agentRouterComplete(messages, { tools, toolChoice = 'auto', maxTokens = 1024, model = currentModel(), timeoutMs = AI_TIMEOUT_MS } = {}) {
  const key = agentRouterKey();
  if (!key) throw new AiUnavailableError('no agentrouter key');
  const body = { model, messages, max_tokens: maxTokens };
  if (tools?.length) { body.tools = tools; body.tool_choice = toolChoice; }
  const res = await fetch(AGENTROUTER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'red-flag-bot/2.0' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`agentrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const choice = j.choices?.[0];
  if (!choice?.message) throw new Error('agentrouter: no message returned');
  return choice.message;
}

// Keep Gemini FAST: minimise "thinking" on models that support it. Gemini 3.x
// uses thinkingLevel ("low"/"high"). Set GEMINI_THINKING=high to let it deliberate,
// or =off to omit the field. If a model rejects it the request auto-retries
// without it, so a wrong value never takes AI down — it just runs normally.
function thinkingConfig() {
  const v = (process.env.GEMINI_THINKING || 'low').trim().toLowerCase();
  if (!v || v === 'off' || v === 'none') return null;
  return { thinkingLevel: v === 'high' ? 'high' : 'low' };
}

const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// One POST. Throws on HTTP error, tagging .status/.body so callers can decide
// whether to retry (e.g. drop thinkingConfig) or move to the next key.
async function geminiFetch(model, key, body, timeoutMs) {
  const res = await fetch(GEMINI_URL(model), {
    method: 'POST',
    // Key in a header, not the query string — URLs leak into proxy/access logs.
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    const err = new Error(`gemini ${res.status}: ${text}`);
    err.status = res.status; err.body = text;
    throw err;
  }
  return res.json();
}

async function geminiGenerate(parts, { model = GEMINI_MODEL } = {}) {
  const content = await geminiRequest({ contents: [{ role: 'user', parts }] }, { model });
  const text = (content.parts || []).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('gemini: empty response');
  return text;
}

// Multi-key, thinking-minimised request. Returns the model's `content` object
// ({ role, parts }). Rotates keys on failure; on a thinking rejection retries
// the same key once WITHOUT the field. Shared by every Gemini call below.
async function geminiRequest(base, { model = GEMINI_MODEL, timeoutMs = AI_TIMEOUT_MS } = {}) {
  const keys = geminiKeys();
  if (!keys.length) throw new AiUnavailableError('no gemini key');
  const tc = thinkingConfig();
  const variants = tc
    ? [{ ...base, generationConfig: { ...(base.generationConfig || {}), thinkingConfig: tc } }, base]
    : [base];
  let lastErr;
  for (let n = 0; n < keys.length; n++) {
    const key = keys[(_gemIdx + n) % keys.length];
    for (let v = 0; v < variants.length; v++) {
      try {
        const j = await geminiFetch(model, key, variants[v], timeoutMs);
        const content = j.candidates?.[0]?.content;
        if (!content) { lastErr = new Error('gemini: no content'); break; }
        _gemIdx = (_gemIdx + n + 1) % keys.length;
        return content;
      } catch (e) {
        lastErr = e;
        const thinkingRejected = v === 0 && variants.length > 1 && e.status === 400 &&
          /think|generationConfig|Unknown name|Invalid JSON/i.test(e.body || e.message || '');
        if (thinkingRejected) continue;   // same key, no thinkingConfig
        break;                            // other error → next key
      }
    }
  }
  throw lastErr || new Error('gemini: all keys failed');
}

export function geminiReady() { return geminiKeys().length > 0; }

/**
 * Raw Gemini generateContent that supports function-calling and returns the
 * model's `content` object ({ role, parts }) — parts may contain `functionCall`.
 * Used by the NEXUS agent loop. Multi-key with rotation, like geminiGenerate.
 * `tools` is Gemini's shape: [{ functionDeclarations: [...] }].
 */
export async function geminiComplete(contents, { tools, systemInstruction, model = GEMINI_MODEL, timeoutMs = AI_TIMEOUT_MS } = {}) {
  const base = { contents };
  if (tools) base.tools = tools;
  if (systemInstruction) base.systemInstruction = { parts: [{ text: systemInstruction }] };
  return geminiRequest(base, { model, timeoutMs });
}

const NO_KEYS_MSG =
  '🤖 No AI key configured. Add GEMINI_API_KEY (aistudio.google.com — supports several comma-separated), AGENTROUTER_API_KEY (agentrouter.org) or GROQ_API_KEY (console.groq.com) to config.env and restart.';

// Try providers in order. If EVERY provider was merely unconfigured (no key),
// surface the "add a key" message; if at least one had a key but failed, report
// a transient-failure message and log the details.
async function runChain(label, providers, failMsg) {
  const errs = [];
  let allUnavailable = true;
  for (const p of providers) {
    try {
      return await p();
    } catch (e) {
      errs.push(e);
      if (!(e instanceof AiUnavailableError)) allUnavailable = false;
    }
  }
  if (allUnavailable) throw new Error(NO_KEYS_MSG);
  console.error(`[RF] ${label} failed:`, errs.map(e => e.message).join(' | '));
  throw new Error(failMsg);
}

/** General text prompt. Gemini (multi-key) → AgentRouter. (Groq is transcription-only.) */
export async function aiChat(prompt, system = null) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const geminiParts = [{ text: system ? `${system}\n\n${prompt}` : prompt }];
  return runChain('aiChat', [
    () => geminiGenerate(geminiParts),
    () => agentRouterChat(messages),
  ], '🤖 AI request failed — the provider may be down or rate-limited. Try again shortly.');
}

/** OCR / describe an image. Gemini vision → AgentRouter vision. */
export async function aiVision(buffer, mimeType, prompt) {
  const b64 = buffer.toString('base64');
  const openAiVisionMsg = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } },
    ],
  }];
  return runChain('aiVision', [
    () => geminiGenerate([{ text: prompt }, { inline_data: { mime_type: mimeType, data: b64 } }]),
    () => agentRouterChat(openAiVisionMsg, { model: AGENTROUTER_VISION_MODEL }),
  ], '🤖 Vision request failed. Try again shortly.');
}

/** Summarize a PDF (Gemini accepts PDFs as inline data). */
export async function aiPdf(buffer, prompt) {
  try {
    return await geminiGenerate([
      { text: prompt },
      { inline_data: { mime_type: 'application/pdf', data: buffer.toString('base64') } },
    ]);
  } catch (e) {
    if (e instanceof AiUnavailableError) throw new Error(NO_KEYS_MSG + ' (PDF summaries need the Gemini key.)');
    console.error('[RF] aiPdf failed:', e.message);
    throw new Error('🤖 Could not read that PDF. It may be too large.');
  }
}

/** Voice note → text via Groq Whisper. */
export async function transcribeAudio(buffer, mimeType = 'audio/ogg') {
  const key = groqKey();
  if (!key) throw new Error('🎙️ Transcription needs GROQ_API_KEY in config.env (free at console.groq.com).');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), 'audio.ogg');
  form.append('model', GROQ_WHISPER_MODEL);
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(Math.max(AI_TIMEOUT_MS, 60000)),
  });
  if (!res.ok) {
    console.error('[RF] transcribe failed:', res.status, (await res.text()).slice(0, 200));
    throw new Error('🎙️ Transcription failed — the audio may be too long or the service is busy.');
  }
  const j = await res.json();
  return (j.text || '').trim();
}
