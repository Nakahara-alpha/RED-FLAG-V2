// Menu + per-command help. Single source of truth: SECTIONS below drives both
// the !menu listing and !help <command> details. Banner: data/menu-banner.jpg
// (optional — falls back to text if missing).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { reply, PREFIX, fmtDuration } from '../lib/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNER_PATH = path.join(__dirname, '../data/menu-banner.jpg');

// [name, usage, description, example, aliases?]
const SECTIONS = [
  ['🛡️', 'PROTECTION', [
    ['antidelete', 'antidelete on/off · all <number>', 'Deleted msgs → your DM (per chat) or all → one number', 'antidelete all 2348012345678'],
    ['viewonce', 'viewonce on/off', 'Auto-save view-once media to your DM (per chat)', 'viewonce on'],
    ['edittrack', 'edittrack on/off', 'DM you original + edited text on edits (per chat)', 'edittrack on'],
    ['antiword', 'antiword add/remove/list/on/off', 'Banned-word filter for this group', 'antiword add spoiler'],
    ['antilink', 'antilink on/off · whitelist add <pat>', 'Delete links, warn → kick repeaters', 'antilink whitelist add youtube.com'],
    ['alert', 'alert add/remove <word> · on/off', 'DM you when a keyword appears (per-chat opt-in)', 'alert add tunde', ['alerts']],
    ['vv', 'vv (reply to view-once)', 'Re-open a view-once HERE', 'reply → vv'],
    ['pvv', 'pvv (reply to view-once)', 'Re-open a view-once to your DM', 'reply → pvv'],
    ['panic', 'panic / panic off', 'Kill switch: disable ALL passive handlers', 'panic', ['silent']],
  ]],
  ['💾', 'SAVE & CAPTURE', [
    ['pin', 'pin [tag] (reply) · pin get <id>', 'Save a replied msg (text or media)', 'reply → pin recipes'],
    ['pins', 'pins [tag] [page]', 'List saved pins', 'pins recipes'],
    ['findpin', 'findpin <keyword>', 'Search pin text', 'findpin wifi password'],
    ['unpin', 'unpin <id>', 'Remove a pin (deletes its media)', 'unpin 3'],
    ['idea', 'idea <text> · idea del <id>', 'Zero-friction thought dump', 'idea app that rates jollof'],
    ['ideas', 'ideas [page|keyword]', 'List/search captures', 'ideas jollof'],
    ['later', 'later <url> [note] (or reply)', 'Stash a link to read later', 'later https://x.yz must read'],
    ['readlist', 'readlist [unread] [page]', 'Your read-later stash', 'readlist unread'],
    ['read', 'read <id>', 'Re-send a stashed link', 'read 2'],
    ['readdone', 'readdone <id>', 'Mark a stashed link read', 'readdone 2'],
    ['readdel', 'readdel <id>', 'Delete from the stash', 'readdel 2'],
    ['note', 'note <tag> <text>', 'Save a tagged note', 'note ideas buy whiteboard'],
    ['notes', 'notes [tag] · notes del <id>', 'Browse notes by tag', 'notes ideas'],
  ]],
  ['✅', 'PRODUCTIVITY', [
    ['todo', 'todo add [!high] <task> · done/del/clear', 'Personal task list', 'todo add !high submit CSC201', ['todos']],
    ['pomo', 'pomo [work] [break] [cycles] · stop/status', 'Pomodoro timer, DMs each phase', 'pomo 50 10 4', ['pomodoro']],
    ['every', 'every 1h|day 9pm|monday 8am <text>', 'Recurring reminder (WAT)', 'every monday 8am gym'],
    ['recurring', 'recurring', 'List recurring reminders', 'recurring'],
    ['remind', 'remind <duration> <text>', 'One-shot reminder', 'remind 2h call mum'],
    ['remindme', 'remindme <duration> (reply)', 'Resend a replied msg later', 'reply → remindme 3h'],
    ['schedule', 'schedule <when> | <message>', 'Send a msg to THIS chat later', 'schedule 18:30 | standup!'],
    ['scheduled', 'scheduled', 'List pending scheduled msgs', 'scheduled'],
    ['unschedule', 'unschedule <id>', 'Cancel a scheduled msg', 'unschedule 3'],
    ['busy', 'busy <reason> / off', 'Auto-reply once per person while away', 'busy writing exams'],
  ]],
  ['🎓', 'UNI', [
    ['tt', 'tt add <day> <start-end> <course> [@ loc]', 'Weekly timetable', 'tt add mon 08:00-10:00 MTH202 @ LT1', ['timetable']],
    ['today', 'today', "Today's classes", 'today'],
    ['next', 'next', 'Next class + countdown', 'next'],
    ['due', 'due add <course> | <task> | <when>', 'Deadlines, auto 24h/2h reminders', 'due add CSC201 | hw2 | 10/07 18:00'],
    ['gpa', 'gpa <units> <grade> ... [save <sem>]', '5.0-scale GPA + CGPA history', 'gpa 3 A 2 B save 2025-1', ['cgpa']],
    ['exam', 'exam add <course> <date>', 'Store exam dates', 'exam add CSC201 2026-07-20 09:00'],
    ['countdown', 'countdown', 'Days until each exam', 'countdown'],
    ['pq', 'pq <course> [year] · pq setdir <path>', 'Send past-question PDFs', 'pq csc201 2023'],
  ]],
  ['🤖', 'AI', [
    ['nexus', 'nexus <anything> · memory · reset', 'Your AI brain — talk naturally; sets reminders/deadlines/notes etc., fetches news & looks things up, and remembers', 'nexus remind me to call mum at 6pm', ['nx']],
    ['ai', 'ai <prompt>', 'Ask the AI anything', 'ai explain OSI layers briefly', ['ask', 'gpt']],
    ['aimodel', 'aimodel · list · <id> · reset', 'View/switch the AgentRouter model', 'aimodel list', ['model', 'setmodel']],
    ['summarize', 'summarize <n>', 'Summarize last n msgs in this chat', 'summarize 100', ['sum']],
    ['tldr', 'tldr (reply to link/PDF/text)', 'Summarize a link, PDF or text', 'reply → tldr'],
    ['tr', 'tr <lang> <text> (or reply)', 'Translate (auto-detect source)', 'tr yoruba how are you', ['translate']],
    ['draft', 'draft <what to write>', 'Draft a message to copy-send', 'draft extension request to lecturer'],
    ['ocr', 'ocr (reply to image)', 'Extract text from an image', 'reply → ocr'],
    ['transcribe', 'transcribe (reply to voice note)', 'Voice note → text', 'reply → transcribe', ['vn']],
  ]],
  ['🎨', 'MEDIA', [
    ['meme', 'meme <top> | <bottom> (reply to image)', 'Classic meme text overlay', 'reply → meme me | also me'],
    ['quote', 'quote [dark|light] [sticker] <text>', 'Styled quote card (or reply)', 'quote light sticker no wahala'],
    ['sticker', 'sticker (reply to image/video)', 'Make a sticker', 'reply → sticker', ['s']],
    ['toimg', 'toimg (reply to sticker)', 'Sticker → image', 'reply → toimg'],
    ['qr', 'qr <text>', 'Generate a QR code', 'qr https://mysite.com'],
    ['qrread', 'qrread (reply to image)', 'Decode a QR from an image', 'reply → qrread'],
  ]],
  ['⬇️', 'DOWNLOADS', [
    ['play', 'play <song or link>', 'Search & send a song as audio', 'play burna boy last last', ['song', 'music']],
    ['yt', 'yt <link> [mp3]', 'YouTube video/audio', 'yt https://youtu.be/… mp3', ['ytdl']],
    ['tiktok', 'tiktok <link>', 'TikTok, no watermark', 'tiktok https://tiktok.com/…', ['ttdl', 'tt-dl']],
    ['ig', 'ig <link>', 'Instagram post/reel', 'ig https://instagram.com/…', ['insta']],
    ['x', 'x <link>', 'X/Twitter media', 'x https://x.com/…/status/…', ['twitter']],
    ['compress', 'compress (reply to video)', 'Shrink a big video (needs ffmpeg)', 'reply → compress'],
  ]],
  ['🧰', 'UTILITY', [
    ['calc', 'calc <expression>', 'Calculator', 'calc (4500*3+1200)*0.075'],
    ['conv', 'conv <amt> <from> <to>', 'Unit converter (length/mass/data/temp)', 'conv 10 km mi', ['convert']],
    ['usd', 'usd <amount>', 'USD → NGN live rate', 'usd 50'],
    ['fx', 'fx <amt> <from> <to>', 'Any currency conversion', 'fx 100 GBP NGN', ['currency']],
    ['weather', 'weather [city]', 'Weather (default Lagos)', 'weather Ibadan'],
    ['define', 'define <word>', 'Dictionary', 'define serendipity', ['dict']],
    ['wiki', 'wiki <query>', 'Wikipedia summary', 'wiki UNILAG'],
    ['short', 'short <url>', 'Shorten a link', 'short https://long.url/…'],
    ['export', 'export <n> [json]', 'Dump last n cached msgs as a file', 'export 200'],
    ['ghost', 'ghost on/off · ghost global on/off', 'Read-receipt control (per chat + global)', 'ghost off', ['autoread']],
  ]],
  ['🔔', 'TRACKERS & DAILY', [
    ['bday', 'bday add <name> <DD-MM[-YYYY]> · bday <name>', 'Birthday reminders (morning-of + day-before)', 'bday add Tobi 14-09-2005', ['birthday', 'bdays']],
    ['monitor', 'monitor add <url> [name] · check/del', 'Uptime watch, DM on up/down', 'monitor add https://mysite.com', ['monitors']],
    ['digest', 'digest on/off · time HH:MM · now', 'Morning digest (classes/deadlines/weather/anime)', 'digest time 07:00'],
    ['spent', 'spent <amount> <category>', 'Log an expense', 'spent 1500 food'],
    ['expenses', 'expenses [day|week|month]', 'Spending summary', 'expenses month'],
    ['habit', 'habit add <interval> <text>', 'Recurring nudges', 'habit add 2h drink water', ['habits']],
    ['airing', 'airing', "Today's full anime schedule", 'airing'],
    ['anime', 'anime <title>', 'Airing dates & info for any anime', 'anime dandadan', ['airdate']],
    ['track', 'track add <title>', 'Follow an anime → DM on every episode', 'track add one piece', ['follow']],
    ['news', 'news [topic]', 'Top headlines, or a topic search', 'news nigeria economy', ['headlines']],
  ]],
  ['👥', 'GROUP ADMIN', [
    ['tagall', 'tagall [message]', 'Mention all members (visible @tags)', 'tagall meeting 8pm', ['everyone']],
    ['tag', 'tag <message>', 'Ping everyone, hidden mentions (no @tags shown)', 'tag pls check the pinned', ['hidetag']],
    ['tagnotadmin', 'tagnotadmin [message]', 'Mention only non-admins', 'tagnotadmin dues o!', ['tagmembers']],
    ['warn', 'warn @user [reason]', `Warn (kick at limit)`, 'warn @user spam'],
    ['warns', 'warns @user', 'Check warnings', 'warns @user'],
    ['resetwarn', 'resetwarn @user', 'Clear warnings', 'resetwarn @user'],
    ['welcome', 'welcome on/off · set <text>', 'Join messages ({user}/{group})', 'welcome set Welcome {user}!'],
    ['goodbye', 'goodbye set <text>', 'Leave messages ({user}/{group})', 'goodbye set Bye {user} 👋'],
    ['stats', 'stats', 'Most active members + peak hour', 'stats'],
    ['poll', 'poll <q> | <opt1> | <opt2>', 'Native poll', 'poll lunch? | rice | beans'],
    ['public', 'public on/off', 'Let members use the safe command set here', 'public on'],
    ['block', 'block <cmd> · unblock <cmd> · blocked', 'Restrict which public commands members get', 'block play', ['unblock', 'blocked']],
  ]],
  ['⚙️', 'SYSTEM', [
    ['ping', 'ping', 'Latency + uptime', 'ping'],
    ['prefix', 'prefix <symbol>', 'Change the command prefix (persists)', 'prefix !'],
    ['reset', 'reset', 'Bounce the connection (fixes stuck "waiting" DMs)', 'reset', ['restart']],
    ['relink', 'relink confirm', 'Wipe session + re-pair (code in server console)', 'relink confirm'],
    ['status', 'status', 'Uptime, RAM, disk (flags >85%)', 'status', ['health']],
    ['backup', 'backup', 'DB backup to your DM (auto-nightly, keeps 7)', 'backup'],
    ['led', 'led on/off', 'ESP32 LED over MQTT', 'led on'],
    ['room', 'room', 'Ask the ESP32 for room status', 'room'],
    ['esp', 'esp <topic> <payload>', 'Publish anything to the ESP32', 'esp fan on'],
    ['pc', 'pc lock/shutdown/screenshot/status', 'PC remote (shutdown needs confirm)', 'pc screenshot'],
    ['relay', 'relay <command>', 'Relay to an external Nexus API (NEXUS_API_URL)', 'relay lights off'],
    ['menu', 'menu · help <command>', 'This menu / per-command help', 'help pomo', ['help', 'rf']],
  ]],
];

// name/alias → help entry
const HELP = new Map();
for (const [, , items] of SECTIONS) {
  for (const [name, usage, desc, example, aliases = []] of items) {
    const entry = { name, usage, desc, example, aliases };
    HELP.set(name, entry);
    for (const a of aliases) HELP.set(a, entry);
  }
}

function buildMenuText() {
  const p = PREFIX();
  const lines = [`╭━━〔 🚩 *𝐵𝑌 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺 V2* 〕━━╮`, `┃ up ${fmtDuration(process.uptime() * 1000)} · prefix *${p}*`];
  for (const [emoji, title, items] of SECTIONS) {
    lines.push('', `${emoji} *${title}*`);
    items.forEach(([name, , desc], i) => {
      const bar = i === items.length - 1 ? '┗' : '┣';
      lines.push(`${bar} \`${p}${name}\` — ${desc}`);
    });
  }
  lines.push('', '╰━━━━━━━━━━━━━━━━━━╯', `💡 *${p}help <command>* for usage + example`);
  return lines.join('\n');
}

async function handleMenu(sock, msg, args) {
  // !help <command> → detailed help from the same source of truth
  const query = (args[0] || '').toLowerCase().replace(new RegExp(`^\\${PREFIX()}`), '');
  if (query) {
    const h = HELP.get(query);
    if (!h) return reply(sock, msg, `❓ No command called *${query}*. See *${PREFIX()}menu*.`);
    return reply(sock, msg,
      `📖 *${PREFIX()}${h.name}*\n${h.desc}\n\n` +
      `*Usage:* \`${PREFIX()}${h.usage}\`\n*Example:* \`${h.example.startsWith('reply') ? h.example : PREFIX() + h.example}\`` +
      (h.aliases.length ? `\n*Aliases:* ${h.aliases.map(a => PREFIX() + a).join(', ')}` : ''));
  }

  const text = buildMenuText();
  // banner + caption like the Pokemon menu; clean text fallback
  try {
    const banner = fs.readFileSync(BANNER_PATH);
    await reply(sock, msg, { image: banner, caption: text });
  } catch {
    await reply(sock, msg, text);
  }
}

export const commands = [
  { name: 'menu', aliases: ['help', 'rf'], execute: handleMenu },
];
