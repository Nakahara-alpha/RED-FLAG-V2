// NEXUS — the bot's conversational "brain". Owner talks to it in natural
// language ("remind me to call mum at 6", "add CSC201 exam on the 20th", "what's
// due this week?") and NEXUS calls the bot's own data functions via tool-calling
// through AgentRouter (OpenAI-compatible). It keeps rolling chat history and a
// durable memory of facts about the owner.
//
// SCOPE (deliberately safe): tools only ADD or READ the owner's personal data
// (reminders, deadlines, timetable, notes, ideas, todos, expenses, birthdays,
// read-later, anime, recurring/habits) plus its own memory. It cannot delete
// data, send messages to other chats, moderate groups, or run system/PC
// commands — do those with the explicit commands.
import { wat, parseWhen, fmtDT, fetchBuffer, fetchJson, groupMeta, botIsAdmin, jidNum, mentionTag, PREFIX } from '../lib/helpers.js';
import { nextOccurrence } from '../commands/productivity.js';
import { fetchHeadlines } from '../commands/news.js';
import { searchCommands } from '../commands/menu.js';
import { airingBetween } from '../services/anime.js';
import { agentRouterComplete, agentRouterReady, geminiComplete, geminiReady } from './ai-client.js';
import {
  addReminder, addDeadline, addTimetable, addNote, addIdea, addTodo, addExpense,
  addBirthday, addReadLater, addTrackedAnime, addRecurring, addHabit,
  listDeadlines, listTodos, timetableForDay, listReminders, expensesSince,
  listTrackedAnime, activeSince, statsTrackingSince, ownerLastActivity, ownerActivityByChat, oldestCachedMsg,
  addNexusTurn, recentNexusTurns, trimNexusHistory,
  addNexusMemory, listNexusMemory,
} from '../db/queries.js';

const DOW = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
const isoToday = () => (wat().day() === 0 ? 7 : wat().day());

// Tool-calling rounds (model reasons, calls a tool, reasons again) legitimately
// take longer than a one-shot chat — especially on a "thinking" model like
// gemini-3.8-flash. Give each agent step a roomier deadline than the default
// AI_TIMEOUT_MS so a working request isn't aborted mid-thought. Override with
// NEXUS_TIMEOUT_MS in config.env.
const NEXUS_TIMEOUT_MS = parseInt(process.env.NEXUS_TIMEOUT_MS, 10) || 60000;

function normHM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}
function parseClock(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hh = +m[1]; const mm = m[2] ? +m[2] : 0; const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

const str = (desc) => ({ type: 'string', description: desc });
const S = (props, required) => ({ type: 'object', properties: props, required: required || [] });

// Group-admin helpers, shared by the group_* tools. ctx = { sock, chatId, isGroup }.
// Returns an error string if the action can't run (not a group / bot not admin), else null.
async function requireGroupAdmin(ctx) {
  if (!ctx?.isGroup) return 'that only works inside a group';
  if (!(await botIsAdmin(ctx.sock, ctx.chatId))) return 'I need to be a group admin here first';
  return null;
}
// Match a bare phone number back to the group's real participant jid (handles the
// @lid vs @s.whatsapp.net split by comparing digits), falling back to a plain jid.
async function resolveParticipant(ctx, number) {
  const want = String(number || '').replace(/\D/g, '');
  if (!want) return null;
  try {
    const meta = await groupMeta(ctx.sock, ctx.chatId);
    const hit = meta.participants.find(p => jidNum(p.id) === want || p.id.replace(/\D/g, '').startsWith(want));
    if (hit) return hit.id;
  } catch { /* fall through to a constructed jid */ }
  return `${want}@s.whatsapp.net`;
}
// Pick the member to act on: an explicit @mention or reply-target (WhatsApp gives
// us their exact jid) always wins; otherwise match the number the model supplied
// against the group roster. This is why "nexus kick @Someone" works.
async function resolveTarget(ctx, number) {
  const mentions = ctx?.mentions || [];
  const want = String(number || '').replace(/\D/g, '');
  if (want) {
    const m = mentions.find(j => jidNum(j) === want || j.replace(/\D/g, '').startsWith(want));
    if (m) return m;
    return resolveParticipant(ctx, want);
  }
  return mentions.length ? mentions[0] : null;
}

// Each tool: run(args) → { ok, summary } on success or { error } on failure.
const TOOLS = [
  {
    name: 'remember_fact',
    description: 'Save a durable fact about the owner to long-term memory (preferences, context you should recall in future conversations). Use for lasting facts, not one-off tasks.',
    parameters: S({ fact: str('The fact to remember, e.g. "Owner studies Computer Science at UNILAG"') }, ['fact']),
    run: ({ fact }) => {
      if (!fact?.trim()) return { error: 'empty fact' };
      const id = addNexusMemory(fact.trim());
      return { ok: true, summary: `remembered #${id}: ${fact.trim()}` };
    },
  },
  {
    name: 'add_reminder',
    description: 'Set a one-off reminder that DMs the owner at a time. `when` must be one of: a relative duration like "2h"/"30m"/"1d", or "HH:MM" (today/next), "tomorrow HH:MM", "YYYY-MM-DD HH:MM", "DD/MM HH:MM". All times are WAT.',
    parameters: S({ when: str('when to fire, e.g. "2h", "18:30", "tomorrow 09:00"'), text: str('what to remind about') }, ['when', 'text']),
    run: ({ when, text }) => {
      const at = parseWhen(when);
      if (!at) return { error: `could not parse time "${when}"` };
      if (at <= Date.now()) return { error: 'that time is in the past' };
      if (!text?.trim()) return { error: 'empty reminder text' };
      addReminder(at, text.trim());
      return { ok: true, summary: `reminder set for ${fmtDT(at)}: ${text.trim()}` };
    },
  },
  {
    name: 'add_deadline',
    description: 'Add an academic deadline. The owner is auto-reminded 24h and 2h before. `when` uses the same formats as add_reminder and must be in the future.',
    parameters: S({ course: str('course code, e.g. CSC201'), task: str('what is due'), when: str('due date/time, WAT') }, ['course', 'task', 'when']),
    run: ({ course, task, when }) => {
      const at = parseWhen(when);
      if (!at) return { error: `could not parse time "${when}"` };
      if (at <= Date.now()) return { error: 'that due date is in the past' };
      const id = addDeadline(course, task, at);
      return { ok: true, summary: `deadline #${id}: ${course} — ${task} due ${fmtDT(at)}` };
    },
  },
  {
    name: 'add_class',
    description: 'Add a weekly timetable class. day is a weekday name (monday..sunday). start/end are "HH:MM" 24-hour.',
    parameters: S({ day: str('weekday name'), start: str('HH:MM'), end: str('HH:MM'), course: str('course'), location: str('optional room/venue') }, ['day', 'start', 'end', 'course']),
    run: ({ day, start, end, course, location }) => {
      const d = DOW[String(day || '').toLowerCase()];
      const s = normHM(start), e = normHM(end);
      if (!d) return { error: 'day must be monday..sunday' };
      if (!s || !e) return { error: 'start/end must be HH:MM 24-hour' };
      if (!course?.trim()) return { error: 'missing course' };
      addTimetable(d, s, e, course.trim(), location?.trim() || null);
      return { ok: true, summary: `class added: ${day} ${s}-${e} ${course}${location ? ' @ ' + location : ''}` };
    },
  },
  {
    name: 'add_note',
    description: 'Save a tagged note.',
    parameters: S({ tag: str('short category tag'), text: str('note body') }, ['tag', 'text']),
    run: ({ tag, text }) => {
      if (!tag?.trim() || !text?.trim()) return { error: 'need tag and text' };
      const id = addNote(tag.trim(), text.trim());
      return { ok: true, summary: `note #${id} under ${tag.trim().toLowerCase()}` };
    },
  },
  {
    name: 'add_idea',
    description: 'Capture a quick idea/thought.',
    parameters: S({ text: str('the idea') }, ['text']),
    run: ({ text }) => {
      if (!text?.trim()) return { error: 'empty idea' };
      const id = addIdea(text.trim());
      return { ok: true, summary: `idea #${id} saved` };
    },
  },
  {
    name: 'add_todo',
    description: 'Add a task to the to-do list. Set high=true for high priority.',
    parameters: S({ task: str('the task'), high: { type: 'boolean', description: 'high priority?' } }, ['task']),
    run: ({ task, high }) => {
      if (!task?.trim()) return { error: 'empty task' };
      const id = addTodo(task.trim(), high ? 1 : 0);
      return { ok: true, summary: `todo #${id}${high ? ' (high)' : ''}: ${task.trim()}` };
    },
  },
  {
    name: 'log_expense',
    description: 'Log a spend/expense (amount in Naira).',
    parameters: S({ amount: { type: 'number', description: 'amount in NGN' }, category: str('category e.g. food, transport') }, ['amount', 'category']),
    run: ({ amount, category }) => {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) return { error: 'amount must be a positive number' };
      if (!category?.trim()) return { error: 'missing category' };
      addExpense(amt, category.trim());
      return { ok: true, summary: `logged ₦${amt} on ${category.trim().toLowerCase()}` };
    },
  },
  {
    name: 'add_birthday',
    description: "Save someone's birthday. date is DD-MM or DD-MM-YYYY.",
    parameters: S({ name: str('person name'), date: str('DD-MM or DD-MM-YYYY') }, ['name', 'date']),
    run: ({ name, date }) => {
      const m = String(date || '').match(/^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{4}))?$/);
      if (!m) return { error: 'date must be DD-MM or DD-MM-YYYY' };
      const day = +m[1], month = +m[2], year = m[3] ? +m[3] : null;
      const DIM = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (month < 1 || month > 12 || day < 1 || day > DIM[month - 1]) return { error: 'impossible date' };
      if (!name?.trim()) return { error: 'missing name' };
      addBirthday(name.trim(), day, month, year);
      return { ok: true, summary: `birthday saved: ${name.trim()} ${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}` };
    },
  },
  {
    name: 'stash_link',
    description: 'Save a URL to the read-later list.',
    parameters: S({ url: str('the URL'), note: str('optional note') }, ['url']),
    run: ({ url, note }) => {
      if (!/^https?:\/\/\S+/i.test(url || '')) return { error: 'need a valid http(s) URL' };
      const id = addReadLater(url.trim(), note?.trim() || null);
      return { ok: true, summary: `stashed link #${id}` };
    },
  },
  {
    name: 'follow_anime',
    description: 'Follow an anime title (the owner gets episode alerts).',
    parameters: S({ title: str('anime title') }, ['title']),
    run: ({ title }) => {
      if (!title?.trim()) return { error: 'missing title' };
      const id = addTrackedAnime(title.trim());
      return { ok: true, summary: `following "${title.trim()}" (#${id})` };
    },
  },
  {
    name: 'add_recurring_reminder',
    description: 'Create a repeating reminder. kind="daily" needs time ("9pm"/"21:00"); kind="weekly" needs weekday + time; kind="interval" needs every_minutes (>=5).',
    parameters: S({
      kind: { type: 'string', enum: ['daily', 'weekly', 'interval'] },
      text: str('what to remind'),
      time: str('for daily/weekly, e.g. "9pm" or "21:00"'),
      weekday: str('for weekly: monday..sunday'),
      every_minutes: { type: 'number', description: 'for interval: minutes between fires (>=5)' },
    }, ['kind', 'text']),
    run: ({ kind, text, time, weekday, every_minutes }) => {
      if (!text?.trim()) return { error: 'missing text' };
      let schedule, label;
      if (kind === 'interval') {
        const mins = Number(every_minutes);
        if (!Number.isFinite(mins) || mins < 5) return { error: 'every_minutes must be >= 5' };
        schedule = { type: 'interval', ms: mins * 60000 }; label = `every ${mins}m`;
      } else if (kind === 'daily') {
        const t = parseClock(time); if (!t) return { error: 'daily needs a valid time' };
        schedule = { type: 'daily', ...t }; label = `daily at ${time}`;
      } else if (kind === 'weekly') {
        const dow = DOW[String(weekday || '').toLowerCase()]; const t = parseClock(time);
        if (!dow || !t) return { error: 'weekly needs weekday + time' };
        schedule = { type: 'weekly', dow, ...t }; label = `${weekday}s at ${time}`;
      } else return { error: 'kind must be daily|weekly|interval' };
      const id = addRecurring(schedule, label, text.trim(), nextOccurrence(schedule));
      return { ok: true, summary: `recurring #${id}: "${text.trim()}" ${label}` };
    },
  },
  {
    name: 'add_habit',
    description: 'Add a recurring nudge every N minutes (lighter than a recurring reminder).',
    parameters: S({ interval_minutes: { type: 'number', description: 'minutes between nudges' }, text: str('nudge text') }, ['interval_minutes', 'text']),
    run: ({ interval_minutes, text }) => {
      const mins = Number(interval_minutes);
      if (!Number.isFinite(mins) || mins < 1) return { error: 'interval_minutes must be >= 1' };
      if (!text?.trim()) return { error: 'missing text' };
      const id = addHabit(text.trim(), mins, Date.now() + mins * 60000);
      return { ok: true, summary: `habit #${id}: ${text.trim()} every ${mins}m` };
    },
  },
  {
    name: 'get_deadlines',
    description: 'List pending (not-done) deadlines.',
    parameters: S({}, []),
    run: () => ({ ok: true, data: listDeadlines().map(d => ({ id: d.id, course: d.course, task: d.task, due: fmtDT(d.due_at) })) }),
  },
  {
    name: 'get_todos',
    description: 'List open to-do items.',
    parameters: S({}, []),
    run: () => ({ ok: true, data: listTodos().map(t => ({ id: t.id, task: t.task, high: !!t.priority })) }),
  },
  {
    name: 'get_today_classes',
    description: "List today's timetable classes.",
    parameters: S({}, []),
    run: () => ({ ok: true, data: timetableForDay(isoToday()).map(c => ({ start: c.start, end: c.end, course: c.course, location: c.location })) }),
  },
  {
    name: 'get_reminders',
    description: 'List pending one-off reminders.',
    parameters: S({}, []),
    run: () => ({ ok: true, data: listReminders().map(r => ({ id: r.id, text: r.text, at: fmtDT(r.run_at) })) }),
  },
  {
    name: 'get_expenses',
    description: 'Summarize expenses over a period: "day", "week", or "month".',
    parameters: S({ period: { type: 'string', enum: ['day', 'week', 'month'] } }, ['period']),
    run: ({ period }) => {
      const since = wat().startOf(period === 'day' ? 'day' : period === 'week' ? 'week' : 'month').valueOf();
      const rows = expensesSince(since);
      const total = rows.reduce((s, r) => s + r.amount, 0);
      const byCat = {};
      for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + r.amount;
      return { ok: true, data: { total, count: rows.length, byCategory: byCat } };
    },
  },
  {
    name: 'get_memory',
    description: 'Recall the durable facts you have saved about the owner.',
    parameters: S({}, []),
    run: () => ({ ok: true, data: listNexusMemory().map(m => ({ id: m.id, fact: m.fact })) }),
  },
  {
    name: 'get_news',
    description: 'Fetch current news headlines. Pass a topic/query to search, or omit for top headlines.',
    parameters: S({ topic: str('optional topic or search query') }, []),
    run: async ({ topic }) => {
      const items = await fetchHeadlines((topic || '').trim(), 6);
      if (!items.length) return { error: 'no headlines found' };
      return { ok: true, data: items.map(i => ({ title: i.title, source: i.source })) };
    },
  },
  {
    name: 'read_url',
    description: 'Fetch a web page and return its readable text (truncated). Use to read a link the owner shared or one that get_news/web_lookup surfaced.',
    parameters: S({ url: str('the http(s) URL to read') }, ['url']),
    run: async ({ url }) => {
      if (!/^https?:\/\/\S+/i.test(url || '')) return { error: 'need a valid http(s) URL' };
      try {
        const html = (await fetchBuffer(url, 15000, 5 * 1024 * 1024)).toString('utf8');
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 4000);
        return text ? { ok: true, data: { url, text } } : { error: 'no readable text on that page' };
      } catch (e) { return { error: `fetch failed: ${e.message}` }; }
    },
  },
  {
    name: 'web_lookup',
    description: 'Look up a topic on Wikipedia and return a short factual summary (people, places, definitions, events).',
    parameters: S({ query: str('what to look up') }, ['query']),
    run: async ({ query }) => {
      if (!query?.trim()) return { error: 'empty query' };
      try {
        const j = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query.trim())}?redirect=true`, {}, 10000);
        if (!j.extract) return { error: 'nothing found' };
        return { ok: true, data: { title: j.title, summary: j.extract, url: j.content_urls?.desktop?.page || '' } };
      } catch (e) { return { error: `lookup failed: ${e.message}` }; }
    },
  },
  {
    name: 'get_airing_anime',
    description: "List anime airing TODAY, with titles the owner follows flagged. Use this for any 'what anime is releasing/airing today' question — the bot has this data, don't web-search for it.",
    parameters: S({}, []),
    run: async () => {
      const now = wat();
      const start = Math.floor(now.startOf('day').valueOf() / 1000);
      const end = Math.floor(now.endOf('day').valueOf() / 1000);
      const shows = await airingBetween(start, end);
      const tracked = listTrackedAnime().map(t => t.title.toLowerCase());
      const data = shows
        .map(s => ({ title: s.title, score: s.score || null, following: tracked.some(t => s.title.toLowerCase().includes(t)) }))
        .sort((a, b) => (b.following - a.following) || ((b.score || 0) - (a.score || 0)))
        .slice(0, 30);
      return data.length ? { ok: true, data } : { error: 'nothing airing today' };
    },
  },
  {
    name: 'group_members',
    description: "List this group's members (phone number + whether each is an admin). Call this first when you need to find who to kick/promote by name or number.",
    parameters: S({}, []),
    run: async (_args, ctx) => {
      if (!ctx?.isGroup) return { error: 'that only works inside a group' };
      const meta = await groupMeta(ctx.sock, ctx.chatId);
      return { ok: true, data: meta.participants.map(p => ({ number: jidNum(p.id), admin: !!p.admin })) };
    },
  },
  {
    name: 'group_tag_all',
    description: 'Tag/mention every member of this group with an optional announcement.',
    parameters: S({ message: str('optional text to send above the mentions') }, []),
    run: async ({ message }, ctx) => {
      if (!ctx?.isGroup) return { error: 'that only works inside a group' };
      const meta = await groupMeta(ctx.sock, ctx.chatId);
      const jids = meta.participants.map(p => p.id);
      const text = (message || '').trim() || '📢 Attention everyone!';
      await ctx.sock.sendMessage(ctx.chatId, { text: `${text}\n\n${jids.map(mentionTag).join(' ')}`, mentions: jids });
      return { ok: true, summary: `tagged ${jids.length} members` };
    },
  },
  {
    name: 'group_kick',
    description: 'Remove a member from this group. If the owner @mentioned someone, you can leave number blank — the mention is used. Destructive: only on a clear instruction.',
    parameters: S({ number: str('member phone number, or the number shown in their @mention; omit if already mentioned') }, []),
    run: async ({ number }, ctx) => {
      const bad = await requireGroupAdmin(ctx); if (bad) return { error: bad };
      const jid = await resolveTarget(ctx, number); if (!jid) return { error: 'who? give me their number' };
      try { await ctx.sock.groupParticipantsUpdate(ctx.chatId, [jid], 'remove'); return { ok: true, summary: `removed ${jidNum(jid)}` }; }
      catch (e) { return { error: `couldn't remove them (they may be an admin): ${e.message}` }; }
    },
  },
  {
    name: 'group_promote',
    description: 'Make a member a group admin. Omit number if the owner @mentioned them.',
    parameters: S({ number: str('member phone number, or omit if @mentioned') }, []),
    run: async ({ number }, ctx) => {
      const bad = await requireGroupAdmin(ctx); if (bad) return { error: bad };
      const jid = await resolveTarget(ctx, number); if (!jid) return { error: 'give me their number' };
      try { await ctx.sock.groupParticipantsUpdate(ctx.chatId, [jid], 'promote'); return { ok: true, summary: `promoted ${jidNum(jid)} to admin` }; }
      catch (e) { return { error: `couldn't promote: ${e.message}` }; }
    },
  },
  {
    name: 'group_demote',
    description: 'Remove admin from a member. Omit number if the owner @mentioned them.',
    parameters: S({ number: str('member phone number, or omit if @mentioned') }, []),
    run: async ({ number }, ctx) => {
      const bad = await requireGroupAdmin(ctx); if (bad) return { error: bad };
      const jid = await resolveTarget(ctx, number); if (!jid) return { error: 'give me their number' };
      try { await ctx.sock.groupParticipantsUpdate(ctx.chatId, [jid], 'demote'); return { ok: true, summary: `demoted ${jidNum(jid)}` }; }
      catch (e) { return { error: `couldn't demote: ${e.message}` }; }
    },
  },
  {
    name: 'group_setting',
    description: "Change who can post or edit this group. action: lock_chat (only admins can send messages), unlock_chat (everyone can), lock_info (only admins edit group name/icon/description), unlock_info (everyone can).",
    parameters: S({ action: { type: 'string', enum: ['lock_chat', 'unlock_chat', 'lock_info', 'unlock_info'] } }, ['action']),
    run: async ({ action }, ctx) => {
      const bad = await requireGroupAdmin(ctx); if (bad) return { error: bad };
      const map = { lock_chat: 'announcement', unlock_chat: 'not_announcement', lock_info: 'locked', unlock_info: 'unlocked' };
      const s = map[action]; if (!s) return { error: 'action must be lock_chat/unlock_chat/lock_info/unlock_info' };
      try { await ctx.sock.groupSettingUpdate(ctx.chatId, s); return { ok: true, summary: `group setting: ${action}` }; }
      catch (e) { return { error: `couldn't change that setting: ${e.message}` }; }
    },
  },
  {
    name: 'group_update_info',
    description: "Rename this group and/or change its description. Pass subject, description, or both.",
    parameters: S({ subject: str('new group name (optional)'), description: str('new group description (optional)') }, []),
    run: async ({ subject, description }, ctx) => {
      const bad = await requireGroupAdmin(ctx); if (bad) return { error: bad };
      const done = [];
      try {
        if (subject?.trim()) { await ctx.sock.groupUpdateSubject(ctx.chatId, subject.trim()); done.push(`name → ${subject.trim()}`); }
        if (description?.trim()) { await ctx.sock.groupUpdateDescription(ctx.chatId, description.trim()); done.push('description updated'); }
      } catch (e) { return { error: `failed: ${e.message}` }; }
      return done.length ? { ok: true, summary: done.join('; ') } : { error: 'give me a new subject and/or description' };
    },
  },
  {
    name: 'get_group_activity',
    description: "Who's been active in THIS group. Pass days to look back (e.g. 7 = last week); omit for all time. CRITICAL: your data only starts at tracking_since — if a member isn't listed, say they've had 'no activity since <tracking_since>', NEVER that they 'never messaged'. You cannot see messages from before you started counting.",
    parameters: S({ days: { type: 'number', description: 'look-back window in days; omit for all time' } }, []),
    run: async ({ days }, ctx) => {
      if (!ctx?.isGroup) return { error: 'that only works inside a group' };
      const d = Number(days);
      const since = (Number.isFinite(d) && d > 0) ? Date.now() - d * 86400000 : 0;
      const rows = activeSince(ctx.chatId, since);
      const trackingSince = statsTrackingSince(ctx.chatId);
      return {
        ok: true,
        data: {
          tracking_since: trackingSince ? fmtDT(trackingSince) : 'when I started counting in this group',
          window: since ? `last ${d} day(s)` : 'all time',
          active_count: rows.length,
          members: rows.slice(0, 40).map(r => ({ number: r.user_id, messages: r.count, last_seen: fmtDT(r.last_ts) })),
          note: 'Absence from this list means no activity since tracking_since, NOT that they never messaged.',
        },
      };
    },
  },
  {
    name: 'get_my_activity',
    description: "When the OWNER was last active on WhatsApp, as the bot saw it. Use for 'when did I last do something', 'when was I last active/online', 'which chats was I last in'. scope='last' = his most recent activity; scope='by_chat' = last activity per chat. These are times the bot observed (since it was running/linked), not WhatsApp's native last-seen.",
    parameters: S({ scope: { type: 'string', enum: ['last', 'by_chat'] } }, []),
    run: async ({ scope }, ctx) => {
      const label = async (id) => {
        if (!id.endsWith('@g.us')) return `chat with ${jidNum(id)}`;
        try { return `group "${(await groupMeta(ctx.sock, id)).subject}"`; } catch { return 'a group'; }
      };
      if (scope === 'by_chat') {
        const rows = ownerActivityByChat(10);
        if (!rows.length) return { ok: true, data: { note: "I haven't seen you send anything yet." } };
        const data = [];
        for (const r of rows) data.push({ where: await label(r.chat_id), last_active: fmtDT(r.last_ts), your_messages: r.n });
        return { ok: true, data };
      }
      const [last] = ownerLastActivity(1);
      if (!last) return { ok: true, data: { note: "I haven't seen you send anything yet." } };
      return { ok: true, data: {
        last_active: fmtDT(last.ts),
        where: await label(last.chat_id),
        last_message_preview: String(last.content || '').slice(0, 80) || '(no text)',
        caveat: 'Only what I observed while running/linked — not WhatsApp\'s own last-seen.',
      } };
    },
  },
  {
    name: 'get_commands',
    description: "Look up the bot's manual slash-commands (the ones the owner types with the prefix, like .menu, .backfill, .antidelete). Use when he asks 'what's the command for X', 'how do I Y', or 'what can the bot do'. Optional keyword filters the list. These are commands HE runs — distinct from the actions you perform via your own tools.",
    parameters: S({ query: str('optional keyword to filter commands') }, []),
    run: ({ query }) => {
      const rows = searchCommands(query || '');
      if (!rows.length) return { error: `no command matches "${query}"` };
      const p = PREFIX();
      return { ok: true, data: rows.slice(0, 40).map(c => ({ command: `${p}${c.name}`, usage: `${p}${c.usage}`, what: c.desc })) };
    },
  },
  {
    name: 'backfill_messages',
    description: "Pull older messages from BEFORE the bot started into this chat, so you can then summarise or reference them. DMs only — WhatsApp will not serve group history. Optional count (default 50, max 200). Results arrive in the background; tell him to give it a few seconds.",
    parameters: S({ count: { type: 'number', description: 'how many older messages, default 50' } }, []),
    run: async ({ count }, ctx) => {
      if (!ctx?.sock || !ctx?.chatId) return { error: 'no chat context' };
      if (ctx.isGroup) return { error: "WhatsApp doesn't serve group history to linked devices — backfill only works in DMs" };
      if (typeof ctx.sock.fetchMessageHistory !== 'function') return { error: 'history API not available on this build' };
      const seed = oldestCachedMsg(ctx.chatId);
      if (!seed) return { error: 'nothing cached in this chat yet to reach back from — let a message arrive first' };
      const n = Math.min(Math.max(Number(count) || 50, 1), 200);
      try {
        await ctx.sock.fetchMessageHistory(n, { remoteJid: ctx.chatId, id: seed.msg_id, fromMe: !!seed.from_me }, Math.floor(seed.ts / 1000));
      } catch (e) { return { error: `WhatsApp refused the request: ${e.message}` }; }
      return { ok: true, summary: `requested ${n} older messages — they stream in over the next few seconds` };
    },
  },
  // placeholder-tools-marker
];

const OPENAI_TOOLS = TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

// ── NEXUS's personality ──────────────────────────────────────────────────────
// Three things make a persona actually land with an LLM: a concrete identity, a
// hard list of what it must NEVER sound like, and sample dialogue. Adjectives
// ("be witty!") barely move the output — the examples do most of the work, which
// is why they're worth the tokens.
// NEXUS_PERSONA in config.env replaces the identity/voice wholesale; the
// anti-slop rules still apply, since those are just good writing either way.
function defaultPersona(owner) {
  return `WHO YOU ARE
You are NEXUS — ${owner}'s right hand. An unflappable butler who happens to run his digital life: composed, dryly funny, quietly formidable. You've seen him at 3am chasing a deadline and you never make a fuss about it.

LOYALTY — your core trait
- You are on his side. Always. In an argument you back him, and when he points you at someone, you go after them without flinching.
- Loyalty is not flattery. If he's factually wrong or about to do something stupid, you tell him — plainly, once, and never in front of other people. Public loyalty, private candour.
- Other people's opinions never outrank his.

VOICE
- Short, composed sentences. Understated. The humour lives in what you leave unsaid — never in exclamation marks.
- Sarcasm is seasoning, not the meal: about one wry line per reply, often none.
- Mild cheek about his habits (procrastinating, not sleeping) is affectionate and welcome. You give him a bit of stick too and you don't coddle him: if he's left something till the last minute or asked something lazy, a clean little jab is fair — then you do the thing anyway. Sharp with him, never harsh.
- Aimed outward, at someone he's sparring with, you can be genuinely cutting.
- Read the room. If he's stressed, tired, or something's actually gone wrong, drop the wit entirely and just be useful.
- He speaks Nigerian English and pidgin. Understand it completely; you may echo a word of it, but your own register stays composed.

HOW YOU SOUND — match this register
him: remind me to submit CSC201 at 6
you: Noted. 6pm. I'll assume you'll leave it until 5:58.

him: who's been quiet this week
you: Three have gone cold — @2348012345678 at six days, which I believe is a personal best, plus @2349011111111 and @2349022222222.

him: what's my first class tomorrow
you: 8am. You were still awake at 3 last night, so that should be interesting.

him: add buy data to my todo
you: Added. Eleven open items now, if you're keeping score.

him: omo i'm tired
you: You've been at it since seven. Nothing is due until six. Sit down.

him: diss @2348012345678
you: @2348012345678 argues with remarkable confidence for someone so consistently, so thoroughly incorrect.

him: add the exam for yesterday
you: That one has already been and gone. Give me a real date and it's done.`;
}

// Universal voice guardrails — the difference between "a person" and "an AI".
// These apply even when NEXUS_PERSONA overrides the persona above.
const ANTI_SLOP = `NEVER DO THIS
- Never mention being an AI, a bot, a model, a prompt, a tool or a token. You are simply NEXUS.
- Banned openers: "Certainly", "Of course!", "Great question", "I'd be happy to", "Sure thing". Banned closer: "Let me know if you need anything else".
- Never restate his request before answering. Answer.
- No markdown headings. No bullet lists in conversation — lists only for genuinely listy data. No emoji unless it is doing real work.
- Never pad. If one line does it, send one line.
- Apologise at most once, and never grovel.`;

function buildSystemPrompt(ctx = {}) {
  const now = wat();
  const owner = process.env.OWNER_NAME || 'the owner';
  const persona = process.env.NEXUS_PERSONA?.trim() || defaultPersona(owner);
  // Long-term memory, but bounded so it can't balloon the prompt: most recent
  // facts first, capped by count and characters. Durable facts persist in the DB
  // regardless — this only limits how many are injected per request.
  const allMems = listNexusMemory();
  let budget = 2000;
  const picked = [];
  for (let i = allMems.length - 1; i >= 0 && picked.length < 40; i--) {
    const line = `- ${allMems[i].fact}`;
    if ((budget -= line.length) < 0) break;
    picked.unshift(line);
  }
  const memBlock = picked.length
    ? `What you already know about ${owner} (${allMems.length} saved facts):\n` + picked.join('\n')
    : `You have no saved facts about ${owner} yet — learn as you go and call remember_fact for lasting ones.`;
  // Inject the real tool list so NEXUS always knows exactly what it can touch
  // (and can answer "what can you do?" honestly). The model also receives the
  // full tool schemas separately.
  const toolList = TOOLS.map(t => `- ${t.name}: ${t.description.split('. ')[0].replace(/\.$/, '')}`).join('\n');
  return [
    `You are NEXUS, ${owner}'s personal assistant, reachable through his WhatsApp. You're talking directly to ${owner}.`,
    persona,
    ANTI_SLOP,
    `Current date & time: ${now.format('dddd, DD MMM YYYY HH:mm')} (WAT, UTC+1). Every time you set is WAT.`,
    `You get things done by calling tools — don't just describe, DO. These are the ONLY things you can access:\n${toolList}`,
    `Group admin: you CAN kick, promote/demote, tag everyone, lock/unlock the chat, and rename or re-describe a group — but ONLY inside a group where I'm an admin${ctx.isGroup ? ' (this chat IS a group)' : " (this chat is NOT a group, so group tools won't work here)"}. For anything that affects other people (kick, demote, lock, rename), act only on a clear instruction; if you're unsure who or what, ask ONE short question first.`,
    'Tagging people: to mention someone, write @ followed by their digits only (e.g. @2348012345678) — WhatsApp turns that into a real @mention showing their name, so NEVER write their name and never explain the number. You get numbers from the recent-messages context, the mention list, or group_members. If you don\'t know a person\'s number, say so instead of inventing one.',
    'You CANNOT message other chats on your own, read other people\'s private data, or control the PC/system. If asked, say so plainly. If the owner asks what you can do, summarise the list above honestly — don\'t invent abilities.',
    'When the owner shares a lasting fact or preference about himself, call remember_fact. If a request is missing a key detail (time, course, amount…), ask ONE short question instead of guessing. After acting, confirm it in one line — in your own voice, not a receipt.',
    memBlock,
  ].join('\n\n');
}

export function nexusReady() { return geminiReady() || agentRouterReady(); }

// Load recent history but keep it CHEAP: cap to the last few turns AND a rough
// character budget so a long conversation doesn't balloon every request's token
// (and credit) cost. Tool schemas + system prompt are already fixed-size.
const HISTORY_TURNS = 10;
const HISTORY_CHAR_BUDGET = 4000;
function loadHistory() {
  const turns = recentNexusTurns(HISTORY_TURNS);
  const out = [];
  let budget = HISTORY_CHAR_BUDGET;
  for (let i = turns.length - 1; i >= 0; i--) {       // newest-first, keep what fits
    const content = String(turns[i].content || '').slice(0, 1500);
    budget -= content.length;
    if (budget < 0 && out.length) break;
    out.unshift({ role: turns[i].role, content });
  }
  return out;
}

// Shared tool executor — runs a tool by name, records a summary action. `ctx`
// ({ sock, chatId, isGroup }) is forwarded so group_* tools can act on this chat.
async function callTool(name, args, actions, ctx) {
  const tool = TOOLS.find(t => t.name === name);
  let result;
  try { result = tool ? await tool.run(args || {}, ctx) : { error: `unknown tool ${name}` }; }
  catch (e) { result = { error: `tool error: ${e.message}` }; }
  if (result?.ok && result.summary) actions.push(result.summary);
  return result;
}

// AgentRouter (OpenAI-style `tools`) agent loop.
async function runAgentRouterAgent(system, history, userText, ctx) {
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: userText }];
  const actions = [];
  let final = '';
  for (let i = 0; i < 6; i++) {
    const msg = await agentRouterComplete(messages, { tools: OPENAI_TOOLS, timeoutMs: NEXUS_TIMEOUT_MS });
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
    if (msg.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        const result = await callTool(call.function?.name, args, actions, ctx);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 2000) });
      }
      continue;
    }
    final = (msg.content || '').trim();
    break;
  }
  if (!final) final = actions.length ? `✅ Done:\n• ${actions.join('\n• ')}` : '🤔 I didn\'t get a response — try rephrasing.';
  return { text: final, actions };
}

// Convert our JSON-schema tool params to Gemini's Schema shape (UPPERCASE types;
// no-arg tools get no `parameters` so Gemini accepts them).
function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return undefined;
  const out = {};
  if (s.type) out.type = String(s.type).toUpperCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = toGeminiSchema(v);
  }
  if (s.required?.length) out.required = s.required;
  return out;
}
const GEMINI_TOOL_DECLS = [{
  functionDeclarations: TOOLS.map(t => {
    const decl = { name: t.name, description: t.description };
    const p = toGeminiSchema(t.parameters);
    if (p?.properties && Object.keys(p.properties).length) decl.parameters = p;
    return decl;
  }),
}];

// Gemini native function-calling agent loop.
async function runGeminiAgent(system, history, userText, ctx) {
  const contents = [
    ...history.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: userText }] },
  ];
  const actions = [];
  let final = '';
  for (let i = 0; i < 6; i++) {
    const content = await geminiComplete(contents, { tools: GEMINI_TOOL_DECLS, systemInstruction: system, timeoutMs: NEXUS_TIMEOUT_MS });
    contents.push(content);
    const calls = (content.parts || []).filter(p => p.functionCall).map(p => p.functionCall);
    if (calls.length) {
      const parts = [];
      for (const call of calls) {
        const result = await callTool(call.name, call.args, actions, ctx);
        parts.push({ functionResponse: { name: call.name, response: (result && typeof result === 'object') ? result : { result } } });
      }
      // Gemini 3 dropped the old `function` role — tool results go back as
      // `user` (the valid roles are SYSTEM/USER/MODEL/…; `function`/`tool` 400).
      contents.push({ role: 'user', parts });
      continue;
    }
    final = (content.parts || []).map(p => p.text || '').join('').trim();
    break;
  }
  if (!final) final = actions.length ? `✅ Done:\n• ${actions.join('\n• ')}` : '🤔 I didn\'t get a response — try rephrasing.';
  return { text: final, actions };
}

// %%ASKNEXUS%%
/**
 * One NEXUS turn. Gemini (native function-calling) first, AgentRouter as backup.
 * Persists the exchange and returns { text, actions }.
 */
export async function askNexus(userText, ctx = {}) {
  if (!nexusReady()) {
    throw new Error('⚡ NEXUS needs a GEMINI_API_KEY (or AGENTROUTER_API_KEY) in config.env.');
  }
  const system = buildSystemPrompt(ctx);
  const history = loadHistory();
  addNexusTurn('user', userText);

  let result = null;
  if (geminiReady()) {
    try { result = await runGeminiAgent(system, history, userText, ctx); }
    catch (e) { console.error('[RF] NEXUS Gemini failed → AgentRouter:', e.message); }
  }
  if (!result && agentRouterReady()) {
    try { result = await runAgentRouterAgent(system, history, userText, ctx); }
    catch (e) { console.error('[RF] NEXUS AgentRouter failed:', e.message); }
  }
  // No leading emoji — the command layer prepends the NEXUS marker, so adding one
  // here would double it ("⚡ ⚡ All providers failed").
  if (!result) result = { text: 'All AI providers failed just now — check your keys/model and try again.', actions: [] };

  addNexusTurn('assistant', result.text);
  trimNexusHistory(200);
  return result;
}


