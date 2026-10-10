// Phase 6 — utility toolbox
import { reply, PREFIX, quotedInfo, contentTypeOf, downloadQuoted, fetchJson, fetchBuffer } from '../lib/helpers.js';

// ── QR ───────────────────────────────────────────────────────────────────────
async function readQrFromReply(sock, msg) {
  const q = quotedInfo(msg);
  if (!q || contentTypeOf(q.message) !== 'image') {
    return reply(sock, msg, `Reply to an *image containing a QR code* with *${PREFIX()}qrread*.`);
  }
  try {
    const buf = await downloadQuoted(msg);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'image/jpeg' }), 'qr.jpg');
    const res = await fetch('https://api.qrserver.com/v1/read-qr-code/', { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
    const j = await res.json();
    const data = j?.[0]?.symbol?.[0]?.data;
    return reply(sock, msg, data ? `🔍 *QR content:*\n${data}` : '🔍 No QR code found in that image.');
  } catch { return reply(sock, msg, '🔍 QR reading failed — try a clearer image.'); }
}

async function handleQr(sock, msg, args) {
  const q = quotedInfo(msg);
  // read mode: reply to an image
  if (q && contentTypeOf(q.message) === 'image') return readQrFromReply(sock, msg);
  // generate mode
  const text = args.join(' ').trim();
  if (!text) return reply(sock, msg, `Usage: *${PREFIX()}qr <text>* to generate, or reply to a QR image with *${PREFIX()}qr* to read it.`);
  try {
    const buf = await fetchBuffer(`https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(text)}`);
    return reply(sock, msg, { image: buf, caption: `🔳 ${text}` });
  } catch { return reply(sock, msg, '🔳 QR generation failed. Try again.'); }
}

// ── currency ─────────────────────────────────────────────────────────────────
async function convert(amount, from, to) {
  const j = await fetchJson(`https://open.er-api.com/v6/latest/${from.toUpperCase()}`);
  const rate = j?.rates?.[to.toUpperCase()];
  if (!rate) throw new Error(`unknown currency ${to}`);
  return { value: amount * rate, rate };
}
async function handleUsd(sock, msg, args) {
  const amt = parseFloat(args[0]) || 1;
  try {
    const { value, rate } = await convert(amt, 'USD', 'NGN');
    return reply(sock, msg, `💵 $${amt.toLocaleString()} = *₦${value.toLocaleString('en-NG', { maximumFractionDigits: 0 })}*\n(1 USD = ₦${rate.toLocaleString('en-NG', { maximumFractionDigits: 2 })})`);
  } catch { return reply(sock, msg, '💵 Rate service unavailable right now.'); }
}
async function handleFx(sock, msg, args) {
  const amt = parseFloat(args[0]);
  const from = args[1], to = args[2];
  if (!Number.isFinite(amt) || !from || !to) return reply(sock, msg, `Usage: *${PREFIX()}fx <amount> <from> <to>* — e.g. \`${PREFIX()}fx 100 GBP NGN\``);
  try {
    const { value, rate } = await convert(amt, from, to);
    return reply(sock, msg, `💱 ${amt} ${from.toUpperCase()} = *${value.toLocaleString('en-NG', { maximumFractionDigits: 2 })} ${to.toUpperCase()}*\n(rate: ${rate})`);
  } catch { return reply(sock, msg, '💱 Couldn\'t get that rate — check the currency codes.'); }
}

// ── calculator ───────────────────────────────────────────────────────────────
async function handleCalc(sock, msg, args) {
  let expr = args.join(' ').trim();
  if (!expr) return reply(sock, msg, `Usage: *${PREFIX()}calc <expression>* — e.g. \`${PREFIX()}calc (4500*3 + 1200) * 0.075\``);
  if (expr.length > 200 || !/^[\d\s+\-*/().%^eE,]+$/.test(expr)) {
    return reply(sock, msg, '🧮 Only numbers and + - * / ( ) % ^ are allowed.');
  }
  try {
    expr = expr.replace(/\^/g, '**').replace(/,/g, '');
    // SECURITY: this Function() evaluator is only safe because the input is
    // whitelisted to [\d\s+\-*/().%^eE,] and capped at 200 chars above — no
    // identifiers, calls, or globals are reachable. Do NOT loosen that character
    // class (adding letters, $, _, backtick, etc.) without replacing this with a
    // real expression parser first — it would become arbitrary code execution.
    const result = Function(`"use strict"; return (${expr});`)();
    if (!Number.isFinite(result)) throw new Error('bad');
    return reply(sock, msg, `🧮 ${args.join(' ')} = *${Number(result.toFixed(10)).toLocaleString('en-US', { maximumFractionDigits: 10 })}*`);
  } catch { return reply(sock, msg, '🧮 That expression didn\'t compute.'); }
}

// ── unit conversion ──────────────────────────────────────────────────────────
const UNITS = {
  km: ['m', 1000], m: ['m', 1], cm: ['m', 0.01], mm: ['m', 0.001], mi: ['m', 1609.344], ft: ['m', 0.3048], in: ['m', 0.0254], yd: ['m', 0.9144],
  kg: ['g', 1000], g: ['g', 1], mg: ['g', 0.001], lb: ['g', 453.592], oz: ['g', 28.3495],
  l: ['l', 1], ml: ['l', 0.001], gal: ['l', 3.78541],
  gb: ['b', 1024 ** 3], mb: ['b', 1024 ** 2], kb: ['b', 1024], tb: ['b', 1024 ** 4], b: ['b', 1],
  kmh: ['ms', 1 / 3.6], mph: ['ms', 0.44704], ms: ['ms', 1],
};
async function handleConv(sock, msg, args) {
  const amt = parseFloat(args[0]);
  const from = (args[1] || '').toLowerCase();
  const to = (args[2] || '').toLowerCase();
  if (!Number.isFinite(amt) || !from || !to) {
    return reply(sock, msg, `Usage: *${PREFIX()}conv <amount> <from> <to>* — e.g. \`${PREFIX()}conv 10 km mi\`, \`${PREFIX()}conv 30 c f\``);
  }
  // temperature special-case
  if ((from === 'c' && to === 'f') || (from === 'f' && to === 'c')) {
    const out = from === 'c' ? amt * 9 / 5 + 32 : (amt - 32) * 5 / 9;
    return reply(sock, msg, `🌡️ ${amt}°${from.toUpperCase()} = *${out.toFixed(1)}°${to.toUpperCase()}*`);
  }
  const f = UNITS[from], t = UNITS[to];
  if (!f || !t || f[0] !== t[0]) return reply(sock, msg, `📏 Can't convert ${from} → ${to}. Supported: length, mass, volume, data, speed, c/f.`);
  const out = (amt * f[1]) / t[1];
  return reply(sock, msg, `📏 ${amt} ${from} = *${Number(out.toPrecision(8)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${to}*`);
}

// ── url shortener ────────────────────────────────────────────────────────────
async function handleShort(sock, msg, args) {
  const url = args[0];
  if (!url || !/^https?:\/\//i.test(url)) return reply(sock, msg, `Usage: *${PREFIX()}short <url>*`);
  try {
    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(10000) });
    const short = await res.text();
    if (!short.startsWith('http')) throw new Error('bad');
    return reply(sock, msg, `🔗 ${short}`);
  } catch { return reply(sock, msg, '🔗 Shortener unavailable right now.'); }
}

// ── weather ──────────────────────────────────────────────────────────────────
async function handleWeather(sock, msg, args) {
  const city = args.join(' ').trim() || process.env.WEATHER_CITY || 'Lagos';
  try {
    const w = await fetchJson(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    const cur = w.current_condition?.[0];
    if (!cur) throw new Error('no data');
    const today = w.weather?.[0];
    return reply(sock, msg,
      `🌤️ *${city}*\n` +
      `${cur.weatherDesc?.[0]?.value}, *${cur.temp_C}°C* (feels ${cur.FeelsLikeC}°C)\n` +
      `💧 Humidity ${cur.humidity}% · 💨 ${cur.windspeedKmph} km/h\n` +
      `📅 Today: ${today?.mintempC}–${today?.maxtempC}°C, rain chance ${today?.hourly?.[4]?.chanceofrain ?? '?'}%`);
  } catch { return reply(sock, msg, `🌤️ Couldn't get weather for "${city}".`); }
}

// ── dictionary ───────────────────────────────────────────────────────────────
async function handleDefine(sock, msg, args) {
  const word = args[0];
  if (!word) return reply(sock, msg, `Usage: *${PREFIX()}define <word>*`);
  try {
    const j = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    const entry = j?.[0];
    if (!entry) throw new Error('none');
    const lines = [`📖 *${entry.word}*${entry.phonetic ? ` ${entry.phonetic}` : ''}`];
    for (const m of (entry.meanings || []).slice(0, 3)) {
      lines.push(`\n_${m.partOfSpeech}_`);
      m.definitions.slice(0, 2).forEach((d, i) => {
        lines.push(`${i + 1}. ${d.definition}${d.example ? `\n   e.g. "${d.example}"` : ''}`);
      });
    }
    return reply(sock, msg, lines.join('\n'));
  } catch { return reply(sock, msg, `📖 No definition found for "${word}".`); }
}

// ── wikipedia ────────────────────────────────────────────────────────────────
async function handleWiki(sock, msg, args) {
  const query = args.join(' ').trim();
  if (!query) return reply(sock, msg, `Usage: *${PREFIX()}wiki <query>*`);
  try {
    const j = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}?redirect=true`);
    if (!j.extract) throw new Error('none');
    return reply(sock, msg, `📚 *${j.title}*\n\n${j.extract}\n\n${j.content_urls?.desktop?.page || ''}`);
  } catch { return reply(sock, msg, `📚 Wikipedia has nothing for "${query}".`); }
}

export const commands = [
  { name: 'qr', execute: handleQr },
  { name: 'qrread', execute: readQrFromReply },
  { name: 'usd', execute: handleUsd },
  { name: 'fx', aliases: ['currency'], execute: handleFx },
  { name: 'calc', execute: handleCalc },
  { name: 'conv', aliases: ['convert'], execute: handleConv },
  { name: 'short', execute: handleShort },
  { name: 'weather', execute: handleWeather },
  { name: 'define', aliases: ['dict'], execute: handleDefine },
  { name: 'wiki', execute: handleWiki },
];
