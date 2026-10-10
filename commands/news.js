// News — top headlines or a topic search via Google News RSS (no API key).
import { reply, PREFIX, fetchBuffer, wat } from '../lib/helpers.js';

const EDITION = process.env.NEWS_EDITION || 'en-NG:en:NG'; // hl:ceid-lang:gl
function edition() {
  const [hl, lang, gl] = EDITION.split(':');
  return { hl: hl || 'en-NG', ceid: `${gl || 'NG'}:${lang || 'en'}`, gl: gl || 'NG' };
}

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseItems(xml, limit) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const source = decode((b.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]);
    let title = decode((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    // Google News appends " - Source" to titles; drop it when we already have source
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    if (title) out.push({ title, source });
    if (out.length >= limit) break;
  }
  return out;
}

// Fetch + parse headlines from Google News RSS. Shared by the .news command and
// NEXUS's get_news tool. Returns [{ title, source }].
export async function fetchHeadlines(topic, limit = 8) {
  const { hl, ceid, gl } = edition();
  const url = topic
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=${hl}&gl=${gl}&ceid=${ceid}`
    : `https://news.google.com/rss?hl=${hl}&gl=${gl}&ceid=${ceid}`;
  const xml = (await fetchBuffer(url, 15000, 8 * 1024 * 1024)).toString('utf8');
  return parseItems(xml, limit);
}

async function handleNews(sock, msg, args) {
  const topic = args.join(' ').trim();
  try {
    const items = await fetchHeadlines(topic, 8);
    if (!items.length) return reply(sock, msg, topic ? `📰 No headlines for "*${topic}*".` : '📰 Couldn\'t load headlines right now.');
    const body = items.map((it, i) => `${i + 1}. *${it.title}*${it.source ? `\n   _${it.source}_` : ''}`).join('\n');
    return reply(sock, msg,
      `📰 *${topic ? `News · ${topic}` : 'Top headlines'}*  _(${wat().format('ddd DD MMM, HH:mm')})_\n\n${body}\n\n` +
      `_${PREFIX()}news <topic> for a specific search_`);
  } catch {
    return reply(sock, msg, '📰 News service unreachable right now — try again shortly.');
  }
}

export const commands = [
  { name: 'news', aliases: ['headlines'], execute: handleNews },
];
