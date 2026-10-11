# RED FLAG V2 → Mellow-MD plugin migration — PROGRESS / HANDOFF

> Hand this file to a fresh chat. It is self-contained: it explains the goal, why
> we pivoted, exactly what to port, where every piece of logic lives, and the
> hard-won gotchas so nothing gets re-learned the painful way.

---

## 0. THE DECISION (read first)

**Plan:** Stop running the custom `RED FLAG V2` bot as the host. Instead, deploy the
**official Mellow-MD** bot and **re-implement RED FLAG V2's custom features as
Mellow-MD plugins**. All the valuable logic (NEXUS AI brain, anime tracking, news,
scheduler, group tools, etc.) already exists in this repo and is being ported, not
rewritten from scratch.

**Why we pivoted (important — it is NOT because the bot is broken):**
- RED FLAG V2 runs fine. Recipients receive everything the bot sends.
- The *only* problem: it runs as a **linked device on the owner's own WhatsApp
  number**, so the **owner's own phone** can't decrypt the bot's own replies →
  shows "Waiting for this message" on the owner's screen only. Everyone else is
  unaffected. This is a known WhatsApp multi-device self-sync quirk, not a code bug.
- The robust fix is a dedicated number — owner can't do that. So: switch to
  Mellow-MD (a mature, maintained base with its own session handling) and carry our
  features over as plugins.

**Owner:** number `2348135802885`, name "RED FLAG". Nigerian English / pidgin.

---

## 1. REPO + DEPLOY STATE

- GitHub: `github.com/Nakahara-alpha/RED-FLAG-V2`, branch `main`, HEAD `0cad71e` (all
  work pushed, tree clean).
- Mellow-MD source to study: `github.com/DemmyJay-99/Mellow-MD` (default branch
  `master`). Its `lib/session.js` loads creds from a GitHub gist.
- Host: **OptikLink** (Pterodactyl-style panel). `BOT_JS_FILE=setup.js` boots it;
  `setup.js` self-clones + force-syncs `origin/main` then launches `index.js`.
  `/home/container` persists; `config.env`, `session/`, `db/` are gitignored.
- Login that WORKS today: `SESSION_ID=293237f899dc122e41ddc6fc1059c36b` (a bare
  GitHub gist id, Mellow-style, under the `DemmyJay-99` generator account) OR
  pairing code via `PAIRING_NUMBER`. Both work.

---

## 2. MIGRATION STEPS (suggested order for the new chat)

1. **Deploy stock Mellow-MD first** and get it online with the owner's session, so
   there's a working base.
2. **Learn Mellow-MD's plugin API** — read its repo: how it registers commands
   (likely a `plugins/` or `commands/` folder, a command/handler convention, and an
   events hook). Match RED FLAG's features to that shape. **Do this before porting.**
3. **Port features in priority order** (section 3). Most logic is provider-agnostic
   JS and lifts over with light glue (swap RED FLAG's `reply(sock,msg,…)` / `sock`
   calls for Mellow's equivalents, and RED FLAG's `db/queries.js` for Mellow's store
   or a bundled sqlite).
4. **Map config/env** (section 5) and **DB tables** (section 6).
5. Keep NEXUS's provider layer (`services/ai-client.js`) almost as-is — it's the
   most finished, most valuable, most gotcha-laden piece.

---

## 3. WHAT TO PORT — feature inventory (priority order)

### ⭐ NEXUS — the AI brain (highest value, port first)
Conversational assistant the owner talks to in natural language; it calls the
bot's own functions via LLM tool-calling, keeps rolling history + durable memory.
- `services/nexus.js` — tool registry (~25 tools), persona, agent loops
  (Gemini-native function-calling first, AgentRouter OpenAI-style fallback),
  system-prompt builder, history/memory injection (bounded).
- `services/ai-client.js` — provider layer (**keep as-is**): Gemini multi-key with
  `thinkingLevel:low`, 429→rotate / 5xx→retry, AgentRouter, Groq Whisper. Carries
  the Gemini-3 fixes (section 4).
- `commands/nexus.js` — `.nexus`/`.nx`, memory/reset subcommands, the natural
  `nexus <message>` wake-word (no prefix), reply-context (reply + "nexus translate"
  feeds the quoted text), @mention passthrough, recent-chat-context injection, and
  rendering `@number` into real WhatsApp mentions on the way out.
- DB tables: `nexus_history`, `nexus_memory`.
- Persona: butler — loyal, deadpan, dry, a bit sharp with the owner. Lives in
  `defaultPersona()` + `ANTI_SLOP` in `services/nexus.js`. Override via `NEXUS_PERSONA`.
- NEXUS tool surface (so the porter knows scope): add reminder/deadline/class/note/
  idea/todo/expense/birthday/read-later/anime-follow/recurring/habit; remember_fact;
  reads: deadlines/todos/today-classes/reminders/expenses/memory; internet:
  get_news/read_url/web_lookup(wiki); get_airing_anime; group admin: group_members/
  group_tag_all/group_kick/group_promote/group_demote/group_setting/group_update_info;
  get_group_activity; get_my_activity; get_commands; backfill_messages.
  Group tools are owner-only + require the bot be a group admin; they thread a
  `ctx = { sock, chatId, isGroup, mentions }` into each tool's `run(args, ctx)`.

### ⭐ Anime (AniList) 
- `services/anime.js` — AniList GraphQL: `searchAnime`, `animeById`, `airingBetween`.
- `commands/daily.js` — `.airing` (+`.airing all`), `.anime`, `.track add/remove`
  (follows a title and DMs the owner on every new episode).
- Episode-alert + "airing today" digest logic in `services/scheduler.js`.
- DB table: `tracked_anime` (+ migration cols `mal_id/broadcast/next_air_at`).

### ⭐ News
- `commands/news.js` — `.news`/`.headlines`, `fetchHeadlines()` (Google News RSS, no
  key). Reused by NEXUS's `get_news` tool.

### Scheduler (powers a lot)
- `services/scheduler.js` — 20s tick: due reminders, deadline auto-reminders
  (24h/2h), habits, recurring reminders, pomodoro, birthdays, anime episode DMs,
  monitors, daily digest (weather + news + classes + due + airing anime), DB backup.
  Re-entrancy guard, lost-reminder gating, missed/rolled handling already fixed.

### Productivity / Uni / Capture
- `commands/productivity.js` (todo, pomo, every/recurring, remind, remindme,
  schedule, busy), `commands/uni.js` (tt/timetable, today, next, due, gpa, exam,
  countdown, pq), `commands/stash.js` + `commands/pins.js` (idea/ideas, later/
  readlist, note/notes, pin/pins/findpin), `commands/trackers.js`.
- DB: reminders, timetable, deadlines, notes, ideas, todos, expenses, exams,
  gpa_history, recurring, habits, pins, readlater, pomodoro, monitors, birthdays.

### Group admin + protection + access
- `commands/group-admin.js` (tagall, tag/hidetag, tagnotadmin, warn/warns/
  resetwarn, welcome, goodbye, stats, poll), `commands/protection.js`
  (antidelete, antilink, antiword, vv/pvv, panic), `commands/access.js`
  (public, block/unblock).
- Passive handlers: `handlers/anti-delete.js`, `antiword.js`, `antilink.js`,
  `keyword-alert.js`, `welcome.js`, `edit-tracker.js`, busy auto-reply.
- DB: warns, welcome, msg_stats (group activity, has `first_ts`), msg_cache.

### Media / stickers / downloaders / utility
- `commands/stickers.js`, `commands/downloaders.js` (+`services/downloader.js`,
  YT cookie support), `commands/media-fun.js`, `commands/utility.js`
  (tr/translate, draft, wiki, etc.), `commands/vv.js`.
- `services/ocr.js`, `services/transcriber.js` (Groq Whisper voice notes).

### IoT + misc
- `commands/iot.js` (ping, backup, `.update`, `.relay`, sysinfo, MQTT/ESP32),
  `services/mqtt-bridge.js`.

### History backfill (OPT-IN, currently off)
- `services/history.js` + `commands/backfill.js`. `HISTORY_SYNC=1` to enable.
  Pulls pre-launch messages into `msg_cache`. **DMs only** (WhatsApp refuses group
  history). Left OFF by default because enabling it was the prime suspect for a
  send-decay scare (later ruled out — see section 4). Low priority to port.


---

## 4. HARD-WON GOTCHAS (do not re-learn these)

**Gemini (the AI, in `services/ai-client.js`) — all verified live:**
- Model is `gemini-3.8-flash` (env `GEMINI_MODEL`). `gemini-2.0-flash` was retired by
  Google — a 404 will tell you the new id.
- Gemini 3 **thinks by default and is slow** (20-40s → request timeouts). Fix:
  send `generationConfig.thinkingConfig.thinkingLevel = "low"` (env `GEMINI_THINKING`,
  default low). `thinkingBudget` is IGNORED on Gemini 3 — must use `thinkingLevel`.
  Code auto-retries without the field if a model rejects it.
- Gemini 3 **dropped the `function` role** for tool results — send tool/function
  responses back with role **`user`**, not `function` (else HTTP 400).
- Multi-key: `GEMINI_API_KEY` + `GEMINI_API_KEYS` (comma-separated), round-robin;
  on 429 rotate to the next key, on 5xx retry briefly.
- `GROQ_API_KEY` is used ONLY for Whisper voice-note transcription now.

**AgentRouter:** the current key is **DEAD (HTTP 401 "unauthorized client")**. NEXUS
is Gemini-first so it doesn't matter, but to use AgentRouter as a real fallback you
need a fresh key from agentrouter.org, or just drop it from the chain.

**Baileys (`@innovatorssoft/baileys` 7.4.3, Node 20):**
- The fork's `chats.js` calls `groupFetchAllParticipating()` which is undefined there
  → throws on an inbound frame → drops messages. Patched at boot by `setup.js`
  `patchBaileys()` (regex-guards the call). Mellow-MD may use a different Baileys —
  check whether this bug exists there.
- **Only ONE instance may ever run on a session.** Two writers on one `session/`
  dir advance Signal ratchets independently → permanent "Waiting for this message"
  for ALL recipients. (Different from the owner-only self-view issue below.)
- `index.js` has epoch-guarded listeners + single-flight reconnect to prevent a
  dying socket from corrupting the new one.

**The self-view issue (the reason for this whole migration):** bot on the owner's
OWN number → owner's phone can't decrypt the bot's own sends (shows "Waiting for
this message") while real recipients CAN read them. Own-number multi-device
quirk; no reliable bot-side fix; dedicated number is the only robust cure.
History sync was briefly suspected and made opt-in, but it was NOT the cause.

**Login / session:** `SESSION_ID` = a bare GitHub gist id of `creds.json` under the
`DemmyJay-99` account (Mellow's generator). Importing creds-only works but the full
session is healthier from a fresh pair. One linked-device slot per session.

---

## 5. CONFIG / ENV to carry over (`config.env`)
`PREFIX` · `BOT_NAME` · `OWNER_NUMBER=2348135802885` · `OWNER_NAME` ·
`SESSION_ID` / `PAIRING_NUMBER` (login) · `TZ_OFFSET_MIN=60` (WAT) ·
`GEMINI_API_KEY` / `GEMINI_API_KEYS` / `GEMINI_MODEL=gemini-3.8-flash` /
`GEMINI_THINKING=low` · `AGENTROUTER_API_KEY` (+ `_MODEL`,`_BASE_URL`,`_VISION_MODEL`) ·
`GROQ_API_KEY` · `AI_TIMEOUT_MS=30000` · `NEXUS_TIMEOUT_MS=60000` · `NEXUS_PERSONA`
(blank = built-in butler) · `NEXUS_WAKE=nexus` · `STICKER_PACKNAME` · `WARN_LIMIT=3` ·
`DIGEST_TIME=06:30` · `WEATHER_CITY=Lagos` · `NEWS_EDITION=en-NG:en:NG` · `PQ_DIR` ·
`YT_COOKIE` · `MQTT_*` · `HISTORY_SYNC=0` · `TEXT_RETENTION_DAYS=30` ·
`MEDIA_RETENTION_MIN=15` · `MEDIA_CAP_MB=500` · `ALWAYS_ONLINE`.

## 6. DATABASE
`db/schema.sql` (better-sqlite3) + migrations array in `db/queries.js` (adds
`tracked_anime.mal_id/broadcast/next_air_at` and `msg_stats.first_ts`). Tables RED
FLAG uses: config, reminders, timetable, deadlines, notes, exams, gpa_history,
expenses, warns, welcome, habits, busy_replied, msg_stats, tracked_anime, cooldowns,
pins, todos, pomodoro, recurring, ideas, readlater, monitors, birthdays,
nexus_history, nexus_memory, msg_cache, scheduled, alerts, antiword,
antilink_whitelist, link_strikes. If Mellow has its own store, bundle a sqlite DB
for these or adapt `db/queries.js` (it's plain better-sqlite3, portable).

## 7. OPEN ITEMS
- Decide/learn Mellow-MD's plugin API before porting (step 2).
- Replace or drop the dead AgentRouter key.
- `RF_DEBUG` logging is still verbose (`[RF][dbg] …`); set `RF_DEBUG=0` to silence
  once stable (RED FLAG only — may not exist in Mellow).
- `.backfill` / history sync is opt-in and low priority.

## 8. FILE MAP (RED FLAG V2)
- `index.js` — boot, socket, reconnect/epoch, upsert dispatch, hello greeting.
- `setup.js` — OptikLink bootstrapper (self-clone, force-sync, Baileys patch, launch).
- `repair.js` — one-shot force-sync helper.
- `lib/` — `handler.js` (dispatch + NEXUS wake-word), `helpers.js` (reply, jids,
  groupMeta, getText, wat/time, fetch), `session.js` (SESSION_ID gist loader),
  `msgstore.js` (in-mem store for decrypt retries), `control.js`, `access.js`.
- `services/` — `nexus.js`, `ai-client.js`, `anime.js`, `scheduler.js`, `history.js`,
  `downloader.js`, `ocr.js`, `transcriber.js`, `mqtt-bridge.js`.
- `commands/` — menu, nexus, ai, daily, news, backfill, group-admin, protection,
  access, productivity, uni, stash, pins, trackers, stickers, downloaders,
  media-fun, utility, vv, chat-tools, iot.
- `handlers/` — anti-delete, antiword, antilink, keyword-alert, welcome, edit-tracker.
- `db/` — `schema.sql`, `queries.js`.
- Docs: `README.md`, `HOSTING.md`, `INSTALL.md`, `DECISIONS.md`, this `PROGRESS.md`.

## 9. HOW TO CONTINUE IN THE NEW CHAT
Open with: *"Read PROGRESS.md. We're deploying stock Mellow-MD and porting RED FLAG
V2's features (NEXUS first) as Mellow plugins. Start by fetching the Mellow-MD repo
and explaining its plugin API, then plan the NEXUS port."* Everything referenced
above is in this repo at `main` / `0cad71e`.
