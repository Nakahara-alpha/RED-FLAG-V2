// Phase 6 — daily digest, expenses, habits, anime airing
import { wat } from '../lib/helpers.js';
import {
  GLOBAL, getConfig, setConfig, isToggled,
  addExpense, expensesSince,
  addHabit, listHabits, removeHabit,
  addTrackedAnime, listTrackedAnime, removeTrackedAnime,
} from '../db/queries.js';
import { buildDigest } from '../services/scheduler.js';
import { searchAnime, airingBetween } from '../services/anime.js';
import { reply, PREFIX, parseDuration, fmtDuration, fmtDT, naira } from '../lib/helpers.js';

// ── digest ───────────────────────────────────────────────────────────────────
async function handleDigest(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'on' || sub === 'off') {
    setConfig(GLOBAL, 'digest', sub === 'on' ? '1' : '0');
    return reply(sock, msg, `☀️ Daily digest is now *${sub.toUpperCase()}*.`);
  }
  if (sub === 'time') {
    const t = (args[1] || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!t) return reply(sock, msg, `Usage: *${PREFIX()}digest time 06:30*`);
    setConfig(GLOBAL, 'digest_time', args[1]);
    return reply(sock, msg, `☀️ Digest will arrive at *${args[1]}* every morning.`);
  }
  if (sub === 'now') {
    return reply(sock, msg, await buildDigest());
  }
  const time = getConfig(GLOBAL, 'digest_time', process.env.DIGEST_TIME || '06:30');
  return reply(sock, msg,
    `☀️ Digest: *${isToggled(GLOBAL, 'digest', true) ? 'ON' : 'OFF'}* at *${time}*\n` +
    `Commands: *${PREFIX()}digest on/off*, *time HH:MM*, *now*`);
}

// ── expenses ─────────────────────────────────────────────────────────────────
async function handleSpent(sock, msg, args) {
  const amount = parseFloat((args[0] || '').replace(/[,₦]/g, ''));
  const category = args.slice(1).join(' ').trim() || 'misc';
  if (!Number.isFinite(amount) || amount <= 0) {
    return reply(sock, msg, `Usage: *${PREFIX()}spent <amount> <category>* — e.g. \`${PREFIX()}spent 1500 food\``);
  }
  addExpense(amount, category);
  const today = expensesSince(wat().startOf('day').valueOf());
  const total = today.reduce((s, e) => s + e.amount, 0);
  return reply(sock, msg, `💸 Logged ${naira(amount)} on *${category}*. Today so far: ${naira(total)}.`);
}

async function handleExpenses(sock, msg, args) {
  const period = (args[0] || 'week').toLowerCase();
  const today = wat().startOf('day');
  const isoDow = today.day() === 0 ? 7 : today.day(); // week starts Monday
  const start = period === 'day' || period === 'today' ? today
    : period === 'month' ? wat().startOf('month')
    : today.subtract(isoDow - 1, 'day');
  const rows = expensesSince(start.valueOf());
  if (!rows.length) return reply(sock, msg, `💸 Nothing logged this ${period}.`);
  const byCat = {};
  for (const e of rows) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  const total = rows.reduce((s, e) => s + e.amount, 0);
  const lines = Object.entries(byCat).sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `• ${cat}: ${naira(amt)} (${Math.round((amt / total) * 100)}%)`);
  return reply(sock, msg, `💸 *Expenses (${period}, since ${start.format('DD MMM')}):*\n${lines.join('\n')}\n\n*Total: ${naira(total)}* across ${rows.length} entries`);
}

// ── habits ───────────────────────────────────────────────────────────────────
async function handleHabit(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'add') {
    // !habit add 90m drink water
    const ms = parseDuration(args[1]);
    const text = args.slice(2).join(' ').trim();
    if (!ms || ms < 60000 || !text) {
      return reply(sock, msg, `Usage: *${PREFIX()}habit add <interval> <text>* — e.g. \`${PREFIX()}habit add 90m drink water\``);
    }
    const id = addHabit(text, Math.round(ms / 60000), Date.now() + ms);
    return reply(sock, msg, `🔔 Habit *#${id}*: "${text}" every ${fmtDuration(ms)}. First nudge in ${fmtDuration(ms)}.`);
  }
  if (sub === 'remove' || sub === 'del') {
    const n = removeHabit(parseInt(args[1], 10) || 0);
    return reply(sock, msg, n ? '✅ Habit removed.' : `Usage: *${PREFIX()}habit remove <id>*`);
  }
  const rows = listHabits();
  return reply(sock, msg, rows.length
    ? `🔔 *Habits:*\n${rows.map(h => `*#${h.id}* ${h.text} — every ${fmtDuration(h.interval_min * 60000)}`).join('\n')}`
    : `🔔 No habits yet. Add: *${PREFIX()}habit add 2h stretch*`);
}

// ── anime (AniList) ──────────────────────────────────────────────────────────
// Today's airing shows, deduped, with the owner's followed titles flagged.
// Shared by !airing and the daily digest.
export async function fetchAiringShows(now = wat()) {
  const start = Math.floor(now.startOf('day').valueOf() / 1000);
  const end = Math.floor(now.endOf('day').valueOf() / 1000);
  const shows = await airingBetween(start, end);
  const tracked = listTrackedAnime().map(t => t.title.toLowerCase());
  return shows
    .map(s => ({ ...s, isTracked: tracked.some(t => s.title.toLowerCase().includes(t)) }))
    .sort((x, y) => (y.isTracked - x.isTracked) || ((y.score || 0) - (x.score || 0)));
}

const AIRING_TOP = 15; // cap the "top picks" list so !airing isn't a 100-line wall

async function handleAiring(sock, msg, args) {
  const showAll = ['all', 'full', 'more'].includes((args[0] || '').toLowerCase());
  try {
    const now = wat();
    const shows = await fetchAiringShows(now);
    if (!shows.length) return reply(sock, msg, '📺 Nothing airing today (or AniList is napping).');

    const followed = shows.filter(s => s.isTracked);
    const rest = shows.filter(s => !s.isTracked).slice(0, showAll ? Infinity : AIRING_TOP);
    const fmt = s => `• *${s.title}*${s.score ? `  ★${s.score}` : ''}`;

    const parts = [`📺 *Airing — ${now.format('ddd DD MMM')}*  ·  ${shows.length} shows`];
    if (followed.length) parts.push('', `⭐ *Following*`, followed.map(fmt).join('\n'));
    if (rest.length) parts.push('', showAll ? `🔥 *All shows*` : `🔥 *Top picks*`, rest.map(fmt).join('\n'));
    const shownRest = followed.length + rest.length;
    const more = shows.length - shownRest;
    parts.push('', more > 0
      ? `_+${more} more · *${PREFIX()}airing all* to see every show_`
      : `_${PREFIX()}track add <title> to follow_`);

    return reply(sock, msg, parts.join('\n'));
  } catch {
    return reply(sock, msg, '📺 Couldn\'t reach the anime schedule right now.');
  }
}

// ── anime info / airing dates + follow (AniList) ─────────────────────────────
const STATUS_TEXT = {
  RELEASING: 'Currently airing', FINISHED: 'Finished airing',
  NOT_YET_RELEASED: 'Not yet aired', CANCELLED: 'Cancelled', HIATUS: 'On hiatus',
};

async function handleAnime(sock, msg, args) {
  const query = args.join(' ').trim();
  if (!query) return reply(sock, msg, `Usage: *${PREFIX()}anime <title>* — airing dates & info. Follow releases: *${PREFIX()}track add <title>*`);
  try {
    const a = await searchAnime(query);
    if (!a) return reply(sock, msg, `📺 Nothing found for "*${query}*".`);
    const status = STATUS_TEXT[a.status] || a.status || '?';
    const when = a.nextAt
      ? `\n⏭️ Next episode${a.nextEp ? ` (#${a.nextEp})` : ''}: *${fmtDT(a.nextAt)}* WAT (in ${fmtDuration(a.nextAt - Date.now())})`
      : (a.status === 'NOT_YET_RELEASED' && a.startDate?.year)
        ? `\n🗓️ Premieres: ${String(a.startDate.day || '??').padStart(2, '0')}/${String(a.startDate.month || '??').padStart(2, '0')}/${a.startDate.year}`
        : '';
    return reply(sock, msg,
      `🎬 *${a.title}*\n` +
      `📊 ${a.score ? `★${a.score} · ` : ''}${a.format || '?'}${a.episodes ? ` · ${a.episodes} eps` : ''} · ${status}${when}\n\n` +
      `_Follow it: *${PREFIX()}track add ${a.title.toLowerCase()}* → DM on every episode_`);
  } catch {
    return reply(sock, msg, '📺 Anime lookup failed — try again shortly.');
  }
}

async function handleTrack(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();
  const title = args.slice(1).join(' ').trim();

  if (sub === 'add' && title) {
    // resolve via AniList so we can DM on releases, not just flag in .airing
    let a = null;
    try { a = await searchAnime(title); } catch { /* offline — fall back below */ }
    if (a) {
      const id = addTrackedAnime(a.title, a.id, null, a.nextAt);
      return reply(sock, msg,
        `⭐ Following *${a.title}* (#${id}).` +
        (a.nextAt
          ? `\n🔔 I'll DM you every episode — next: *${fmtDT(a.nextAt)}* WAT.`
          : a.status === 'NOT_YET_RELEASED'
            ? '\n🔔 Not aired yet — I\'ll flag it in *airing*; re-add once it starts for episode DMs.'
            : `\n_${a.status === 'FINISHED' ? 'Already finished airing — flagged in lists only.' : 'No upcoming episode scheduled — flagged in lists only.'}_`));
    }
    const id = addTrackedAnime(title);
    return reply(sock, msg, `⭐ Tracking "*${title}*" (#${id}) — flagged in *${PREFIX()}airing* and your digest (couldn't fetch its schedule for DM alerts right now).`);
  }

  if ((sub === 'remove' || sub === 'del') && args[1]) {
    const n = removeTrackedAnime(parseInt(args[1], 10) || 0);
    return reply(sock, msg, n ? '✅ Unfollowed.' : `Usage: *${PREFIX()}track remove <id>*`);
  }

  const rows = listTrackedAnime();
  return reply(sock, msg, rows.length
    ? `⭐ *Following:*\n${rows.map(t =>
        `*#${t.id}* ${t.title}${t.next_air_at ? `\n   ⏭️ next ep: ${fmtDT(t.next_air_at)}` : '\n   _(list-flag only, no episode alerts)_'}`).join('\n')}\n\n` +
      `*${PREFIX()}track remove <id>* to unfollow`
    : `⭐ Nothing followed. *${PREFIX()}track add one piece* → DM on every episode.`);
}

export const commands = [
  { name: 'digest', execute: handleDigest },
  { name: 'spent', execute: handleSpent },
  { name: 'expenses', execute: handleExpenses },
  { name: 'habit', aliases: ['habits'], execute: handleHabit },
  { name: 'airing', execute: handleAiring },
  { name: 'anime', aliases: ['airdate'], execute: handleAnime },
  { name: 'track', aliases: ['follow'], execute: handleTrack },
];
