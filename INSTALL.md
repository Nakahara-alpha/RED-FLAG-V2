# 🚩 RED FLAG V2 — Install on OptikLink (no PC hosting)

This runs the bot **entirely on OptikLink** — your PC is only used to open a
browser (and, once, your phone to link WhatsApp). OptikLink is a Pterodactyl-style
panel, so the steps below use that layout; the exact menu labels on your plan may
differ slightly — I've said what to look for.

> Running it for several people? Each person = one OptikLink server from the same
> repo. See [HOSTING.md](HOSTING.md).

## What you need
- An **OptikLink server** that can run **Node.js 20+** (a "Node.js", "Bot Hosting"
  or "Discord Bot" egg — anything that runs `node`).
- Your **WhatsApp number** + your phone (to link once).
- **(free, optional) API keys** for AI — see §7. Skip for now if you just want it running.

---

## 1. Create the server
In the OptikLink dashboard, create a server using a **Node.js / bot egg**. In its
**Startup** tab (or Docker image dropdown) pick **Node 20 or newer**. Start it once
so the container/files exist, then **Stop** it while you set things up.

## 2. Get the code onto the server — pick ONE

**Option A — from GitHub (easiest updates):**
Put this project in a GitHub repo, then on the panel set the egg's **Git Repository
Address** to your repo URL (and branch `main`). Reinstall/boot pulls it in.

**Option B — upload a zip (no Git):**
Zip this folder, open the server's **File Manager**, upload the zip into
`/home/container`, then **Decompress/Unarchive** it (the ⋮ menu next to the file).
Make sure `index.js` and `package.json` sit directly in `/home/container`, not in a
sub-folder.

> Do **not** upload `node_modules/` — the panel installs fresh (§3). Also skip
> `session/`, `db/*.db`, and `config.env` (secrets); `.gitignore` already excludes them.

## 3. Make sure dependencies install
The bot needs `npm install` to run on the container. Most Node eggs do this
automatically on install, or have an **"Additional Node packages" / "Auto npm
install"** option — leave it on. If yours doesn't, set the **Startup command** to:
```
npm install && npm start
```
(better-sqlite3 and sharp build native code — the first install takes a minute).

## 4. Create your `config.env` (in the File Manager)
This is the reliable way on a panel. In the server's **File Manager**:
1. **New File** → name it `config.env`.
2. Open `config.env.example` (it's in the repo), copy everything, paste into `config.env`.
3. Fill in the essentials and **Save**:
   ```
   OWNER_NUMBER=2348012345678      # your number, digits only
   PAIRING_NUMBER=2348012345678    # same number → pairing code (no QR)
   ```
   Add any API keys you have (§7). Leave the rest as-is.

> Prefer the panel's **Startup → Variables** UI? You can set these as environment
> variables there instead — they override `config.env`. The File Manager method
> works on every egg, so start there.

## 5. Set the startup command
In **Startup**, make sure the command runs the bot:
```
npm start
```
(or `npm install && npm start` from §3). If the egg asks for a **"Main/Bot JS
file"**, set it to `index.js`.

## 6. Start it & link WhatsApp
1. Press **Start** and open the **Console** tab.
2. Wait for a line like: `[RF] Pairing code for +234…:  ABCD1234`.
3. On your phone: **WhatsApp → Linked devices → Link a device → Link with phone
   number instead** → type the code. **Don't restart the server while the code
   shows.** (No `PAIRING_NUMBER`? A QR prints in the console instead — scan it.)
4. You'll see `[RF] … connected to WhatsApp` and get a DM to yourself. Done.

## 7. API keys (free, optional)
Add to `config.env`. AI + NEXUS switch on as soon as a key is present. Order used:
**Gemini → AgentRouter → Groq**.
- **Gemini (primary):** aistudio.google.com → `GEMINI_API_KEY=key1,key2,key3`
  (several keys allowed, comma-separated, to dodge rate limits).
- **AgentRouter (powers NEXUS):** agentrouter.org/console/token → `AGENTROUTER_API_KEY`.
- **Groq (voice `.transcribe` + fallback):** console.groq.com → `GROQ_API_KEY`.

## 8. First things to do
Message **yourself** on WhatsApp:
- `.menu` — all commands · `.help <command>` — usage + example · `.ping` — alive check.
- **NEXUS** (AI brain, no prefix needed): `nexus remind me to call mum at 6pm`,
  `nexus what's airing today?`, `nexus I spent 1500 on lunch`. `.nexus memory` / `.nexus reset`.
- Turn on protection per chat: `.antidelete on`, `.viewonce on`, `.edittrack on`.
- Set up life: `.tt add mon 08:00-10:00 MTH202 @ LT1`, `.due add …`, `.track add one piece`.
  Daily digest (classes, deadlines, weather, your airing anime) arrives 06:30 WAT.

## 9. Keeping it running & your data
- The container keeps `/home/container` between **restarts/stops**, so your login
  (`session/`) and database (`db/redflag.db`) persist — no re-pairing.
- ⚠️ **Avoid "Reinstall"** on the panel unless you've backed up — it can wipe files.
- `.backup` DMs you the database anytime; auto-backup runs nightly at 02:00 WAT
  (last 7 kept in `data/backups/`). Download `db/redflag.db` from the File Manager
  occasionally as an extra copy.

## 10. Updating
- **Option A (GitHub):** if the egg has an **Auto-Update / git pull** toggle, turn
  it on — it pulls on each boot. Otherwise, re-pull from the panel or re-run the
  install. `session/` + `db/` are untouched; the schema auto-migrates.
- **Option B (zip):** upload the changed files via File Manager and **Restart**.
  (Don't overwrite `config.env`, `session/`, or `db/`.)

## 11. Troubleshooting (on the panel)
- **No pairing code in Console** → confirm `PAIRING_NUMBER` is set and the server
  actually started (check for `npm install` finishing first).
- **`Cannot find module …`** → dependencies didn't install; set startup to
  `npm install && npm start` (§3) and Restart.
- **Old Node / native build errors** (better-sqlite3, sharp) → bump the egg to
  **Node 20+** in Startup/Docker image, then Reinstall-free Restart; if it must
  rebuild, back up `db/` + `session/` first.
- **"Waiting for this message" in your DMs** → send `.reset`; if it sticks,
  `.relink confirm`. Only run **one** server per number — two corrupt encryption.
- **AI "down/rate-limited"** → add more Gemini keys, or `.aimodel list` then
  `.aimodel <id>` for AgentRouter.
- **`.compress` / video stickers fail** → that needs `ffmpeg`, which most panels
  don't include; everything else works without it.

---
Architecture & provider choices → **DECISIONS.md**. Multi-client details → **HOSTING.md**.


