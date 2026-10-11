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
**Startup** tab (or Docker image dropdown) pick a Node version — **Node 20 or 22
(LTS) is safest** for the native modules (better-sqlite3, sharp). Very new odd
versions (e.g. Node 25) sometimes lack prebuilt binaries and fail to install.

> This egg's startup is a fixed template that ends with `node /home/container/${BOT_JS_FILE}`
> and already runs `npm install` for you on boot (and `git pull` when `AUTO_UPDATE=1`).
> So you don't type a startup command — you set **variables** (below).

## 2. Get the code onto the server — pick ONE

**Option A — from GitHub (recommended; enables one-click updates):**
Your repo is up: **`https://github.com/Nakahara-alpha/RED-FLAG-V2`** (public).
The egg clones it **during Reinstall**, and only into an *empty* folder — so:

1. **File Manager** → `/home/container` → if anything is there (a stray
   `package.json`, a default `index.js`, etc.), **select all → Delete**. The clone
   is skipped if the folder isn't empty, which is the #1 cause of
   *"Cannot find module index.js"*.
2. **Startup** tab → set these variables (names vary by egg — match by meaning):

   | Variable | Value |
   |---|---|
   | **Git Address** (`GIT_ADDRESS`) | `https://github.com/Nakahara-alpha/RED-FLAG-V2` |
   | **Install Branch** (`BRANCH`) | `main` |
   | **User Uploaded Files** (`USER_UPLOAD`) | `0` (clone from Git) |
   | **Auto Update** (`AUTO_UPDATE`) | `1` |
   | **Bot JS File** (`BOT_JS_FILE`) | `setup.js` (or `index.js`) |

3. **Settings** tab → **Reinstall**. Watch the **Console**: you should see
   **`Cloning into …`** and **a lot** of packages install (hundreds — not 26). If
   you only see ~26 packages and no "Cloning", the folder wasn't empty — redo step 1.

> **Private repo?** Make it public (nothing secret is committed), or give the egg a
> GitHub token (`GIT_USER` + `GIT_ACCESS_TOKEN`, or embed it in the URL).

**Option B — upload a zip (no Git):**
Zip this folder, **File Manager** → upload into `/home/container` → **Decompress**
(the ⋮ menu). Ensure `index.js` + `package.json` sit directly in `/home/container`,
not in a sub-folder. Set **`BOT_JS_FILE`** = `index.js`. (Zip uploads have no
`.git`, so no auto-update — re-upload to update.)

> Never upload `node_modules/`, `session/`, `db/*.db`, or `config.env`.

## 3. Dependencies — automatic
This egg runs `npm install` itself every boot (you saw it in the console), so
there's nothing to do here. `setup.js` also double-checks and only reinstalls when
the code actually changed. (better-sqlite3 + sharp build native code — the first
install takes a minute.)

## 4. Create your `config.env` (in the File Manager)
Do this **after** the repo is cloned (§2) — `config.env` isn't in Git, so a fresh
clone won't have it, and `setup.js` will create a blank one you then fill. In the
server's **File Manager**:
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

## 5. Point the egg at the bootstrapper
This egg has no free-form "startup command" — it runs `node /home/container/${BOT_JS_FILE}`.
So just set the **`BOT_JS_FILE`** variable (Startup tab):
```
BOT_JS_FILE = setup.js
```
`setup.js` makes sure `config.env` exists, installs only when the code changed,
pulls updates, then launches the bot. Prefer to keep it bare? Set `BOT_JS_FILE = index.js`
instead — the egg still installs deps and (with `AUTO_UPDATE=1`) pulls updates;
you'd just create `config.env` yourself (§4).

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
- **If your startup command is `node setup.js`:** just **Restart** — it pulls the
  latest commit from GitHub and reinstalls deps only if they changed. Nothing else
  to do. (Set `AUTO_UPDATE=0` in config.env/variables to pause auto-pull.)
- **Manual:** re-pull from the panel (or re-run install) if you use `npm start`.
Either way, `config.env`, `session/`, and `db/redflag.db` are left untouched — no
re-pairing, no data loss; the schema auto-migrates on boot.

## 11. Troubleshooting (on the panel)
- **`Cannot find module '/home/container/index.js'`** + only ~26 packages installed
  → the repo never cloned; the egg installed a stray/empty `package.json` instead.
  Fix: File Manager → **empty** `/home/container`, set `GIT_ADDRESS` + `USER_UPLOAD=0`
  (§2), then **Reinstall**. A good clone shows `Cloning into …` and installs hundreds
  of packages.
- **No pairing code in Console** → confirm `PAIRING_NUMBER` is set and the server
  actually started (wait for `npm install` to finish first).
- **Native build errors** (better-sqlite3, sharp) on install → switch the egg to
  **Node 20 or 22 (LTS)** and Reinstall; brand-new Node builds sometimes lack
  prebuilt binaries.
- **`Cannot find module` for a dependency** → deps didn't install; Reinstall, or
  set `BOT_JS_FILE=setup.js` (it force-installs when needed).
- **"Waiting for this message" in your DMs** → send `.reset`; if it sticks,
  `.relink confirm`. Only run **one** server per number — two corrupt encryption.
- **AI "down/rate-limited"** → add more Gemini keys, or `.aimodel list` then
  `.aimodel <id>` for AgentRouter.
- **`.compress` / video stickers fail** → that needs `ffmpeg`, which most panels
  don't include; everything else works without it.

---
Architecture & provider choices → **DECISIONS.md**. Multi-client details → **HOSTING.md**.


