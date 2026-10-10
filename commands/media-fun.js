// Features 9-10 — meme maker + quote cards. Pure sharp/SVG, no external calls.
// Font: SVG text with Impact/'Arial Black' stack (Windows ships Impact; sans-serif
// fallback elsewhere) — see DECISIONS.md.
import sharp from 'sharp';
import { getCachedMsg } from '../db/queries.js';
import {
  reply, PREFIX, quotedInfo, contentTypeOf, downloadQuoted, getText, jidNum,
} from '../lib/helpers.js';

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function wrap(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

// ── meme maker ───────────────────────────────────────────────────────────────
async function handleMeme(sock, msg, args) {
  const q = quotedInfo(msg);
  const type = q ? contentTypeOf(q.message) : null;
  if (!q || !['image', 'sticker'].includes(type)) {
    return reply(sock, msg, `Reply to an *image* (or static sticker) with *${PREFIX()}meme <top> | <bottom>*`);
  }
  const raw = args.join(' ').trim();
  if (!raw) return reply(sock, msg, `Give me text: *${PREFIX()}meme <top> | <bottom>* (one part = top only).`);
  const [topText, bottomText] = raw.split('|').map(s => s.trim());

  try {
    let buf = await downloadQuoted(msg);
    if (type === 'sticker') buf = await sharp(buf, { animated: false }).png().toBuffer(); // static frame
    const img = sharp(buf);
    const meta = await img.metadata();
    const W = meta.width, H = meta.height;
    if (!W || !H) throw new Error('bad image');

    const fontSize = Math.round(W / 9);
    const maxChars = Math.max(8, Math.floor(W / (fontSize * 0.52)));
    const lineH = Math.round(fontSize * 1.08);
    const stroke = Math.max(2, Math.round(fontSize / 14));

    const textBlock = (text, anchor) => {
      if (!text) return '';
      const lines = wrap(text.toUpperCase(), maxChars).slice(0, 4);
      return lines.map((line, i) => {
        const y = anchor === 'top'
          ? Math.round(fontSize * 1.1) + i * lineH
          : H - Math.round(fontSize * 0.35) - (lines.length - 1 - i) * lineH;
        return `<text x="${W / 2}" y="${y}" font-size="${fontSize}" text-anchor="middle">${xmlEscape(line)}</text>`;
      }).join('');
    };

    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <style>text{font-family:Impact,'Arial Black','Anton',sans-serif;font-weight:900;fill:#fff;stroke:#000;stroke-width:${stroke}px;paint-order:stroke;letter-spacing:1px}</style>
      ${textBlock(topText, 'top')}${textBlock(bottomText, 'bottom')}
    </svg>`;

    const out = await img.composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 90 }).toBuffer();
    return reply(sock, msg, { image: out });
  } catch (err) {
    console.error('[RF] meme failed:', err.message);
    return reply(sock, msg, '🎨 Meme failed — animated stickers and weird formats don\'t work, try a plain image.');
  }
}

// ── quote cards ──────────────────────────────────────────────────────────────
const STYLES = {
  dark: {
    bg: `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#141414"/><stop offset="1" stop-color="#2d2d34"/>
         </linearGradient></defs><rect width="1080" height="1080" fill="url(#g)"/>
         <rect x="0" y="0" width="14" height="1080" fill="#e0313f"/>`,
    text: '#f5f5f5', sub: '#9a9aa2', mark: '#e0313f',
  },
  light: {
    bg: `<rect width="1080" height="1080" fill="#faf7f0"/>
         <rect x="0" y="1066" width="1080" height="14" fill="#c9a227"/>`,
    text: '#26221c', sub: '#8a8377', mark: '#c9a227',
  },
};

export function buildQuoteCard(text, attribution, styleName) {
  const style = STYLES[styleName] || STYLES.dark;
  const clean = text.slice(0, 420);
  const fontSize = clean.length <= 80 ? 64 : clean.length <= 160 ? 52 : clean.length <= 280 ? 42 : 34;
  const maxChars = Math.floor(880 / (fontSize * 0.48));
  const lines = wrap(clean, maxChars);
  const lineH = Math.round(fontSize * 1.45);
  const blockH = lines.length * lineH;
  const startY = Math.round(540 - blockH / 2 + fontSize);

  const textEls = lines.map((l, i) =>
    `<text x="540" y="${startY + i * lineH}" font-size="${fontSize}" text-anchor="middle" fill="${style.text}"
       font-family="Georgia,'Times New Roman',serif">${xmlEscape(l)}</text>`).join('');
  const attr = attribution
    ? `<text x="540" y="${startY + lines.length * lineH + 40}" font-size="34" text-anchor="middle"
         fill="${style.sub}" font-family="Georgia,serif" font-style="italic">— ${xmlEscape(attribution)}</text>`
    : '';

  const svg = `<svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
    ${style.bg}
    <text x="90" y="220" font-size="220" fill="${style.mark}" opacity="0.35" font-family="Georgia,serif">&#10077;</text>
    ${textEls}${attr}
    <text x="540" y="1030" font-size="24" text-anchor="middle" fill="${style.sub}"
      font-family="Georgia,serif" letter-spacing="4">B Y&#160;&#160;R E D&#160;&#160;F L A G&#160;&#160;V 2</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function handleQuote(sock, msg, args) {
  let asSticker = false, styleName = 'dark';
  while (args.length) {
    const a = args[0].toLowerCase();
    if (a === 'sticker') { asSticker = true; args = args.slice(1); }
    else if (STYLES[a]) { styleName = a; args = args.slice(1); }
    else break;
  }

  let text = args.join(' ').trim();
  let attribution = null;
  const q = quotedInfo(msg);
  if (!text && q) {
    text = getText(q.message);
    const cached = q.stanzaId ? getCachedMsg(q.stanzaId) : null;
    attribution = cached?.push_name || (q.participant ? '+' + jidNum(q.participant) : null);
  }
  if (!text) return reply(sock, msg, `Usage: *${PREFIX()}quote [dark|light] [sticker] <text>* — or reply to a message with *${PREFIX()}quote*.`);

  try {
    const png = await buildQuoteCard(text, attribution, styleName);
    if (asSticker) {
      const webp = await sharp(png).resize(512, 512).webp({ quality: 80 }).toBuffer();
      return reply(sock, msg, { sticker: webp });
    }
    return reply(sock, msg, { image: png });
  } catch (err) {
    console.error('[RF] quote card failed:', err.message);
    return reply(sock, msg, '🎨 Couldn\'t render that quote — try shorter text.');
  }
}

export const commands = [
  { name: 'meme', execute: handleMeme },
  { name: 'quote', execute: handleQuote },
];
