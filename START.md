# 🚩 𝐵𝑌 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺 V2 — Start Here

Your quick setup + first-run guide. Default prefix is `.` (change anytime with `.prefix`).

---

## 1. Before first launch — `config.env`

Fill these in (only the first two really matter to get running):

| Key | What to put | Needed? |
|-----|-------------|---------|
| `OWNER_NUMBER` | Your number(s), digits only, comma-separated. e.g. `2348135802885` | ✅ yes |
| `PAIRING_NUMBER` | Same number → prints a pairing code (no QR) | ✅ (or use QR) |
| `GROQ_API_KEY` | Free from console.groq.com — powers all AI + transcription | for AI |
| `GEMINI_API_KEY` | Free from aistudio.google.com — OCR, PDF tldr, AI fallback | for AI |
| `YT_COOKIE` | YouTube cookie (JSON array or `name=value; …`) — only if `.play` gets blocked on the host | optional |
| `WEATHER_CITY` | Default weather city (already `Lagos`) | optional |
| `DIGEST_TIME` | Morning digest time, WAT (already `06:30`) | optional |
| `PQ_DIR` | Folder of past-question PDFs for `.pq` | optional |
| `MQTT_URL` / `NEXUS_API_URL` | Only if you use the ESP32 / Nexus features | optional |

Leave anything you don't use blank — every feature fails gracefully.

---

## 2. Pair the bot (one time)

1. Start the server. Watch the console for:
   ```
   [RF] Pairing code for +234…:  ABCD1234
   ```
2. On your phone: **WhatsApp → Linked devices → Link a device → Link with phone number instead** → type the code.
3. Wait for `[RF] … connected to WhatsApp`. You'll get a DM to yourself confirming it's online.

> **Don't restart the server while a pairing code is showing** — enter it first.
> No `PAIRING_NUMBER`? A QR appears in the console instead — scan it.

---

## 3. First thing to run

Message **yourself** (or any chat) `.menu` — the full command list with the banner.
`.help <command>` gives usage + an example for any command (e.g. `.help play`).
`.ping` confirms it's alive.

**Banner:** drop an image at `data/menu-banner.jpg` to show it above the menu.

---

## 4. Turn on what you want (nothing is on by default)

Protection is **opt-in per chat** so the bot stays quiet until you say so.

### Anti-delete (see deleted messages)
- Per chat: `.antidelete on` → deleted messages in that chat come to your DM.
- **All chats → one place:** `.antidelete all 2348135802885` → *every* deleted message, everywhere, goes to that number. Turn off: `.antidelete all off`.

### Other passive tools (run in the chat you want them)
| Command | Does |
|---------|------|
| `.viewonce on` | Auto-saves view-once photos/videos to your DM |
| `.edittrack on` | DMs you the before/after when someone edits a message |
| `.alert add <word>` | DMs you when a keyword shows up (per chat: `.alert on`) |
| `.ghost on` | Stops the bot sending read receipts (blue ticks) in that chat |
| `.antiword add <word>` | (groups) deletes banned words — bot must be admin |
| `.antilink on` | (groups) deletes links, warns then kicks — bot must be admin |

**Kill switch:** `.panic` instantly disables ALL passive tools everywhere. `.panic off` restores. Survives restarts.

---

## 5. Set up your daily life stuff (optional but nice)

- **Timetable:** `.tt add mon 08:00-10:00 MTH202 @ LT1` … then `.today` / `.next`.
- **Deadlines:** `.due add CSC201 | assignment 2 | 2026-07-15 18:00` → auto-reminded 24h & 2h before.
- **Daily digest:** on by default at 06:30 — classes, deadlines, Lagos weather, anime. Change: `.digest time 07:00`, or `.digest now` to preview.
- **Follow anime:** `.track add one piece` → DM on every new episode. Check dates: `.anime frieren`. Full schedule: `.airing`.
- **Birthdays:** `.bday add Tobi 14-09-2005` → reminder the morning of (and the day before).
- **Reminders:** `.remind 2h call mum` · recurring: `.every monday 8am gym` · `.every day 9pm review`.
- **Money:** `.spent 1500 food` then `.expenses week`.
- **Notes/ideas/links:** `.note`, `.idea <thought>`, `.later <url>`, `.pin` (reply to a message).

*(All times are West Africa Time, UTC+1, no matter where it's hosted.)*

---

## 6. Let a group use the bot (optional)

By default only **you** can use commands. To open a group to its members:

- `.public on` — members can now use the safe, fun set (play, meme, quote, sticker, calc, weather, define, wiki, downloaders, ai, etc.). Your private stuff stays yours.
- `.block <cmd>` / `.unblock <cmd>` — trim what members get (e.g. `.block play`).
- `.public off` — back to owner-only.

Group admins can also use the admin tools: `.tagall`, `.tag` (hidden mentions), `.warn`, `.welcome`, `.stats`, `.poll`.

---

## 7. Quick command cheat-sheet

| You want… | Command |
|-----------|---------|
| A song | `.play <name>` |
| YouTube / TikTok / IG / X | `.yt` · `.tiktok` · `.ig` · `.x` |
| Make a sticker | reply to image + `.sticker` |
| Meme / quote card | `.meme top \| bottom` · `.quote <text>` |
| Ask AI / translate | `.ai <q>` · `.tr yoruba <text>` |
| Read an image / voice note | reply + `.ocr` · reply + `.transcribe` |
| Open a view-once here / to DM | reply + `.vv` · reply + `.pvv` |
| Calc / convert / currency | `.calc` · `.conv 10 km mi` · `.usd 50` |
| Bot health | `.status` (flags disk >85%) |

---

## 8. Maintenance & rescue

- **`.backup`** → sends the database to your DM. (Auto-backup runs nightly at 02:00; last 7 kept.)
- **`.reset`** → cleanly restarts the connection. **Use this if DMs start showing "Waiting for this message"** — send it from a group if your DMs are stuck. ~10s.
- **`.relink confirm`** → wipes the session and re-pairs from scratch (new code in the console). Use if `.reset` isn't enough.
- **`.prefix !`** → change the command prefix (persists across restarts).

### If you ever see "Waiting for this message" in DMs
1. `.reset` (from a group if needed) — usually clears it.
2. If it comes back, `.relink confirm` for a clean session.
3. **Make sure only ONE copy of the bot is running** against this account (no leftover container on the panel, no local copy). Two instances corrupt encryption and no fix helps — this is the #1 cause.

---

## 9. Optional extras

- `npm i mqtt` → enables the ESP32 features (`.led`, `.room`, `.esp`).
- Install **ffmpeg** on the host → enables video stickers and `.compress`.
- The host runs `npm install` from `package.json` on deploy — `@distube/ytdl-core`, `yt-search`, `better-sqlite3` (v12, Node-25 safe), `sharp`, etc. all pull automatically.

---

*Everything's owner-only unless you flip `.public` on in a group. Reminders, follows, backups and schedules all survive restarts. Questions about any command → `.help <command>`.*
