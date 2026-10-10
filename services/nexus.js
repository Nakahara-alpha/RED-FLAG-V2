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
import { wat, parseWhen, fmtDT, fetchBuffer, fetchJson } from '../lib/helpers.js';
import { nextOccurrence } from '../commands/productivity.js';
import { fetchHeadlines } from '../commands/news.js';
import { agentRouterComplete, agentRouterReady } from './ai-client.js';
import {
  addReminder, addDeadline, addTimetable, addNote, addIdea, addTodo, addExpense,
  addBirthday, addReadLater, addTrackedAnime, addRecurring, addHabit,
  listDeadlines, listTodos, timetableForDay, listReminders, expensesSince,
  addNexusTurn, recentNexusTurns, trimNexusHistory,
  addNexusMemory, listNexusMemory,
} from '../db/queries.js';

const DOW = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
const isoToday = () => (wat().day() === 0 ? 7 : wat().day());

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
  // placeholder-tools-marker
];

const OPENAI_TOOLS = TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

// Default personality. Override wholesale with NEXUS_PERSONA in config.env.
const DEFAULT_PERSONA =
  'Your personality: NEXUS is sharp, loyal and a little cheeky — the owner\'s trusted right-hand who just gets things done. ' +
  'Talk like a real person, not a corporate FAQ: concise, warm, a bit of banter is fine, and you can match the owner\'s casual/Nigerian tone when they use it. ' +
  'Be proactive and decisive — if you can just do the thing, do it; never pad replies or over-explain.';

function buildSystemPrompt() {
  const now = wat();
  const owner = process.env.OWNER_NAME || 'the owner';
  const persona = process.env.NEXUS_PERSONA?.trim() || DEFAULT_PERSONA;
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
    `You are NEXUS, the brain of ${owner}'s personal WhatsApp assistant bot. You're talking directly to ${owner}.`,
    persona,
    `Current date & time: ${now.format('dddd, DD MMM YYYY HH:mm')} (WAT, UTC+1). Every time you set is WAT.`,
    `You get things done by calling tools — don't just describe, DO. These are the ONLY things you can access:\n${toolList}`,
    'You CANNOT delete data, message other people, send to other chats, moderate groups, or control the PC/system. If asked to, say so plainly and point to the explicit bot commands. If the owner asks what you can do, summarise the list above honestly in a line or two — don\'t invent abilities.',
    'When the owner shares a lasting fact or preference about themselves, call remember_fact. If a request is missing a key detail (time, course, amount…), ask ONE short question instead of guessing. After acting, confirm what you did in a short line. Keep replies short, plain-text, no markdown headers.',
    memBlock,
  ].join('\n\n');
}

export function nexusReady() { return agentRouterReady(); }

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

/**
 * One NEXUS turn: feeds history + the new message to AgentRouter with tools,
 * runs the tool-call loop, persists the exchange, and returns the final text
 * plus a list of actions taken.
 */
export async function askNexus(userText) {
  if (!agentRouterReady()) {
    throw new Error('🧠 NEXUS needs AGENTROUTER_API_KEY in config.env (key from agentrouter.org/console/token).');
  }
  const messages = [{ role: 'system', content: buildSystemPrompt() }, ...loadHistory(), { role: 'user', content: userText }];
  addNexusTurn('user', userText);

  const actions = [];
  let final = '';
  for (let i = 0; i < 6; i++) {
    const msg = await agentRouterComplete(messages, { tools: OPENAI_TOOLS });
    // Normalize for the next request (content must be a string, keep tool_calls).
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
    if (msg.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        const tool = TOOLS.find(t => t.name === call.function?.name);
        let result;
        try {
          const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
          result = tool ? await tool.run(args) : { error: `unknown tool ${call.function?.name}` };
        } catch (e) {
          result = { error: `tool error: ${e.message}` };
        }
        if (result?.ok && result.summary) actions.push(result.summary);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 2000) });
      }
      continue; // let the model react to the tool results
    }
    final = (msg.content || '').trim();
    break;
  }
  if (!final) final = actions.length ? `✅ Done:\n• ${actions.join('\n• ')}` : '🤔 I didn\'t get a response — try rephrasing.';
  addNexusTurn('assistant', final);
  trimNexusHistory(200);
  return { text: final, actions };
}


