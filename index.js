import {
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    makeWASocket,
} from "@innovatorssoft/baileys";
import { configDotenv } from "dotenv";
import pino from "pino";
import qrcode from "qrcode-terminal";
import fs from "fs";

configDotenv({ quiet: true, path: "./config.env" });

import { getDb } from "./db/queries.js";
import { handleUpsert } from "./lib/handler.js";
import { handleParticipantsUpdate } from "./handlers/welcome.js";
import { setSock as setSchedulerSock, startScheduler } from "./services/scheduler.js";
import { initSessionFromGist } from "./lib/session.js";
import { remember, recall, makeCounterCache } from "./lib/msgstore.js";
import { setRestarter } from "./lib/control.js";
import { BOT_NAME, PREFIX } from "./lib/helpers.js";

// Survive throws that originate DEEP INSIDE Baileys' own async event handlers
// (e.g. the on-connect group sync in some fork builds throws
// "groupFetchAllParticipating is not a function"). Those surface as unhandled
// rejections and, under Node's default, would kill the whole process — but they
// are almost always non-fatal to message handling, so log and keep running.
process.on("unhandledRejection", (reason) => {
    console.error("[RF] unhandledRejection (ignored):", reason?.stack || reason?.message || reason);
});
process.on("uncaughtException", (err) => {
    console.error("[RF] uncaughtException (ignored):", err?.stack || err?.message || err);
});

// Init DB + scheduler up front — failures log, they never kill the process.
try {
    getDb();
    startScheduler();
} catch (err) {
    console.error("[RF] init error:", err);
}

let sock;
let hasSentHello = false;
let onlineSince = 0; // ms timestamp of the last successful connect (to skip replayed history)
// Each socket generation gets a unique epoch. Any event from a socket whose
// epoch is no longer current is IGNORED — this is what prevents a dying old
// socket from touching Signal state / killing the new socket (the root cause
// of DMs decaying into "Waiting for this message…" after a reconnect).
let currentEpoch = 0;
let reconnectArmed = false;

// Single-flight reconnect: end the current socket and bring up exactly one new
// one. Guarded so overlapping close events can't stack multiple sockets.
// `reconnectArmed` stays TRUE until startBot() actually brings a socket up (or
// gives up and re-schedules), so a failed/slow startup can't be raced into
// spawning a second socket.
function scheduleReconnect(reason, delayMs, wipeSession = false) {
    if (reconnectArmed) return;
    reconnectArmed = true;
    currentEpoch++; // invalidate the outgoing socket's listeners immediately
    console.log(`[RF] Reconnecting (${reason})…`);
    const dying = sock;
    sock = null;
    try { dying?.end?.(new Error(reason)); } catch { /* already dead */ }
    if (wipeSession) {
        try { fs.rmSync("session", { recursive: true, force: true }); } catch { /* ignore */ }
        pairingCodeShown = false;
    }
    setTimeout(() => { startBot(); }, delayMs);
}

// .reset / .relink — commands cleanly bounce the socket via the same path.
setRestarter(async (wipeSession) => {
    scheduleReconnect(wipeSession ? "relink requested" : "reset requested", 3000, wipeSession);
});
// Pairing code must be requested ONCE per process. If this resets per socket,
// the restart-required reconnect after pairing requests a 2nd code and
// invalidates the session → "Logged out" loop.
let pairingCodeShown = false;
// If pairing-code login fails, fall back to QR for the rest of the process.
let pairingFailed = false;

const startBot = async () => {
    const myEpoch = ++currentEpoch;      // this socket's generation
    const isCurrent = () => myEpoch === currentEpoch;
    // Login order: existing session → SESSION_ID gist (Mellow-style) →
    // pairing code (PAIRING_NUMBER) → QR in terminal.
    if (process.env.SESSION_ID) {
        try {
            await initSessionFromGist(process.env.SESSION_ID.trim());
        } catch (err) {
            console.error("[RF] SESSION_ID bootstrap failed:", err.message, "— falling back to pairing/QR.");
        }
    }

    let state, saveCreds, newSock;
    try {
        ({ state, saveCreds } = await useMultiFileAuthState("session"));
        const logger = pino({ level: "fatal" });
        newSock = makeWASocket({
            // Canonical single auth object: the SAME keystore the socket authenticates
            // with is the one persisted by creds.update — anything else 401s on reconnect.
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger.child({ level: "fatal" })),
            },
            logger: logger.child({ level: "fatal" }),
            browser: ["Ubuntu", "Chrome", "20.04"], // stable signature for pairing-code login
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            printQRInTerminal: false,
            markOnlineOnConnect: process.env.ALWAYS_ONLINE === "true",
            // Count retry receipts so Baileys re-establishes a FRESH session and
            // resends when a recipient can't decrypt (fixes DMs decaying into
            // "Waiting for this message…" mid-session).
            msgRetryCounterCache: makeCounterCache(),
            // Answer decryption-retry requests with the EXACT proto we sent. Never
            // reconstruct content — a mismatched retry produces empty bubbles.
            getMessage: async (key) => recall(key.id) || undefined,
        });
    } catch (err) {
        // Any failure before the socket is up (FS error, corrupt keys, makeWASocket
        // throw) must NOT reject unhandled — that kills the process with no retry.
        // Re-arm and schedule another attempt so startup is self-healing.
        console.error("[RF] startBot failed:", err);
        reconnectArmed = false;
        scheduleReconnect("startup failed", 10000, false);
        return;
    }

    // A newer generation started during our awaits (e.g. a .reset raced in) —
    // abandon this socket instead of leaking a live, orphaned connection.
    if (!isCurrent()) { try { newSock.end(new Error("superseded")); } catch { /* ignore */ } return; }
    sock = newSock;
    reconnectArmed = false; // a socket is up — a later close may now reconnect

    const thisSock = sock; // bind this generation's socket for all handlers

    // Capture every OUTGOING message at send time — the reliable moment, before
    // any retry can arrive (messages.upsert for our own sends is delayed/flaky).
    const origSend = thisSock.sendMessage.bind(thisSock);
    thisSock.sendMessage = async (jid, content, opts) => {
        const sent = await origSend(jid, content, opts);
        try { if (sent?.key?.id && sent?.message) remember(sent.key, sent.message); } catch { /* ignore */ }
        return sent;
    };

    // Epoch-guarded like every other listener: a superseded socket must not
    // persist its (possibly stale) creds over the current generation's.
    thisSock.ev.on("creds.update", () => { if (isCurrent()) saveCreds(); });

    // Pairing-code login: no QR scan — enter the code in
    // WhatsApp > Linked devices > Link with phone number instead.
    const pairingNumber = (process.env.PAIRING_NUMBER || "").replace(/\D/g, "");

    thisSock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        if (!isCurrent()) return; // event from a superseded socket — ignore
        // Only request a pairing code ONCE per process, and never once registered.
        if (qr && pairingNumber && !pairingFailed && !state.creds.registered && !pairingCodeShown) {
            pairingCodeShown = true; // set before the await so overlapping qr events can't request twice
            try {
                const code = await thisSock.requestPairingCode(pairingNumber);
                console.log(`\n[RF] Pairing code for +${pairingNumber}:  ${code}`);
                console.log("[RF] WhatsApp > Linked devices > Link a device > Link with phone number instead");
                console.log("[RF] (waiting — do NOT restart the server until you've entered this)\n");
            } catch (err) {
                // Pairing failed — fall back to QR mode for the rest of this
                // process so EVERY subsequent qr event refreshes a scannable code
                // (the old code showed exactly one QR then swallowed the rest).
                console.error("[RF] Pairing code failed:", err.message, "— showing QR instead.");
                pairingFailed = true;
                qrcode.generate(qr, { small: true });
            }
            return;
        }
        if (qr && (!pairingNumber || pairingFailed)) {
            console.log(`\n[RF] Scan this QR with WhatsApp (Linked devices) to pair ${BOT_NAME()}:\n`);
            qrcode.generate(qr, { small: true });
        }
        if (connection === "open") {
            setSchedulerSock(thisSock);
            onlineSince = Date.now();
            console.log(`[RF] ${BOT_NAME()} connected to WhatsApp`);
            if (!hasSentHello) {
                hasSentHello = true;
                try {
                    const me = thisSock.user.id.split(":")[0] + "@s.whatsapp.net";
                    const p = PREFIX();
                    await thisSock.sendMessage(me, {
                        text:
                            `🚩 *${BOT_NAME()}* is online.\n\n` +
                            `⌨️ Prefix: *${p}*\n` +
                            `📖 *${p}menu* — all commands\n` +
                            `💡 *${p}help <command>* — usage + example\n` +
                            `🏓 *${p}ping* — check I'm alive`,
                    });
                } catch { /* non-fatal */ }
            }
        } else if (connection === "close") {
            const loggedOut =
                lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
            if (loggedOut) {
                // Creds are dead — wipe + re-pair fresh so the panel isn't stuck.
                console.log("[RF] Logged out — clearing session and re-pairing…");
                scheduleReconnect("logged out", 8000, true);
            } else {
                scheduleReconnect("connection closed", 5000, false);
            }
        }
    });

    thisSock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (!isCurrent()) return; // stale socket — ignore
        // Remember every message (incl. our own sends, which upsert fromMe:true)
        // so getMessage can serve retry requests.
        for (const msg of messages) {
            if (msg?.message) remember(msg.key, msg.message);
        }
        for (const msg of messages) {
            if (!msg?.message) continue;
            if (process.env.RF_DEBUG !== "0" && msg.key?.fromMe) {
                console.log(`[RF][dbg] upsert type=${type} fromMe=true chat=${msg.key?.remoteJid}`);
            }
            // Self-bot: the owner's own commands are fromMe (some builds deliver
            // them as 'append', not 'notify'). Process every 'notify' message plus
            // ANY fromMe message. History sync is disabled, so nothing old replays.
            if (type !== "notify" && !msg.key?.fromMe) continue;
            try {
                await handleUpsert(thisSock, msg);
            } catch (err) {
                console.error("[RF] message handler error:", err);
            }
        }
    });

    thisSock.ev.on("group-participants.update", async (update) => {
        if (!isCurrent()) return;
        try {
            await handleParticipantsUpdate(thisSock, update);
        } catch (err) {
            console.error("[RF] participants handler error:", err);
        }
    });

    return sock;
};

// Kick off the first connection. startBot() handles its own failures (re-arms
// and reschedules), but guard the call too so nothing can reject unhandled.
startBot().catch((err) => {
    console.error("[RF] fatal startup error:", err);
    reconnectArmed = false;
    scheduleReconnect("fatal startup", 10000, false);
});
