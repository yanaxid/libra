const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const cron = require("node-cron");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

require("dotenv").config();

// configuration
const CONFIG = {
    telegram: {
        apiId: Number(process.env.API_ID),
        apiHash: process.env.API_HASH,
        botUsername: process.env.BOT_USERNAME,
        session: new StringSession(process.env.SESSION || ""),
    },
    whatsapp: {
        groupId: process.env.GROUPID_WA?.includes('@') ? process.env.GROUPID_WA : `${process.env.GROUPID_WA}@g.us`,
    },
    api: {
        sheetUrl: process.env.SHEET_API_URL,
    },
    timezone: "Asia/Jakarta"
};

// state management
let tgClient;
let waSock;
let isWaReady = false;
let attendance = { date: null, clockIn: false, clockOut: false };



// get local date
const getLocalDate = () => new Date().toLocaleDateString("en-CA", { timeZone: CONFIG.timezone });

// reset harian
const resetDailyStatus = () => {
    const today = getLocalDate();
    if (attendance.date !== today) {
        attendance = { date: today, clockIn: false, clockOut: false };
        console.log(`[SYSTEM] Daily status reset for ${today}`);
    }
};

// logging
const logger = {
    info: (msg) => {
        console.log(`[INFO] ${msg}`);
        sendLogToSheet(msg, "INFO");
    },
    error: (msg, err = "") => {
        console.error(`[ERROR] ${msg}`, err);
        sendLogToSheet(`${msg} ${err}`, "ERROR");
    }
};

async function sendLogToSheet(message, level) {
    if (!CONFIG.api.sheetUrl) return;
    try {
        await fetch(CONFIG.api.sheetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ logs: `[${level}] ${new Date().toISOString()} - ${message}` }),
        });
    } catch (e) {
        process.stdout.write(`! Log Sheet Error: ${e.message}\n`);
    }
}

// wa service
async function initWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    waSock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Libra Bot", "Server", "1.0.0"],
        printQRInTerminal: false // qrcode-terminal
    });

    waSock.ev.on('creds.update', saveCreds);

    waSock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("\n[WA] scan qr untuk login:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            isWaReady = false;
            logger.error(`WA connection closed. reconnecting ... : ${shouldReconnect}`);
            if (shouldReconnect) initWhatsApp();
        } else if (connection === 'open') {
            isWaReady = true;
            logger.info("WhatsApp client is ready");
        }
    });
}

async function sendWhatsAppMsg(text) {
    if (!isWaReady || !waSock) return logger.error("WhatsApp not ready, message skipped.");
    try {
        await waSock.sendMessage(CONFIG.whatsapp.groupId, { text });
        logger.info(`WA Sent: ${text.substring(0, 20)}...`);
    } catch (e) {
        logger.error("Failed to send WA message", e.message);
    }
}

// telegram service
async function initTelegram() {
    tgClient = new TelegramClient(CONFIG.telegram.session, CONFIG.telegram.apiId, CONFIG.telegram.apiHash, { 
        connectionRetries: 5,
    });

    if (!process.env.SESSION) {
        await tgClient.start({
            phoneNumber: () => input.text("Enter Phone Number: "),
            phoneCode: () => input.text("Enter OTP: "),
            password: async () => input.text("Enter 2FA Password: "),
            onError: (e) => logger.error("Telegram Auth Error", e.message),
        });
        console.log("\n--- SAVE THIS SESSION TO .env ---");
        console.log(tgClient.session.save());
        console.log("--------------------------------\n");
    } else {
        await tgClient.connect();
    }
    logger.info("Telegram Client is Connected");

    // keep alive
    setInterval(async () => {
        if (tgClient.connected) try {await tgClient.invoke(new Api.help.GetConfig());} catch (e) {}

    }, 1000 * 60 * 15);
}

async function sendTelegramMsg(text) {
    if (!tgClient?.connected) return logger.error("Telegram not connected.");
    try {
        const bot = await tgClient.getEntity(CONFIG.telegram.botUsername);
        await tgClient.sendMessage(bot, { message: text });
        logger.info(`TG Sent: ${text}`);
    } catch (e) {
        logger.error("Failed to send TG message", e.message);
    }
}

// data service
async function getSheetData() {
    try {
        const res = await fetch(CONFIG.api.sheetUrl);
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        return await res.json();
    } catch (e) {
        logger.error("Fetch Google Sheet failed", e.message);
        return null;
    }
}

// core
async function performClockIn() {

    resetDailyStatus();
    if (attendance.clockIn) return;

    const data = await getSheetData();
    const msg = data?.cico?.[0]?.ci;

    if (msg) {
        await sendTelegramMsg("/clock_in");
        await sendWhatsAppMsg(msg);
        attendance.clockIn = true;
    }
}

async function performClockOut() {
    resetDailyStatus();
    if (attendance.clockOut) return;


    const data = await getSheetData();
    if (!data) return;

    await sendTelegramMsg("/clock_out");

    if (data.cico?.[0]?.co) await sendWhatsAppMsg(data.cico[0].co);

    if (Array.isArray(data.tasks)) {
        for (const t of data.tasks) {
            if (t.taskId && t.task && t.hour) {
                await sendTelegramMsg(`/TS ${t.taskId} : ${t.task} : ${t.hour}`);
                await new Promise(r => setTimeout(r, 2000)); // 2s delay to avoid flood
            }
        }
    }
    attendance.clockOut = true;
}

// main
(async () => {
    logger.info("Initializing Libra Bot...");

    await initWhatsApp();
    await initTelegram();

    cron.schedule("00 08 * * 1-5", performClockIn, { timezone: CONFIG.timezone });
    cron.schedule("00 17 * * 1-4", performClockOut, { timezone: CONFIG.timezone });
    cron.schedule("30 16 * * 5", performClockOut, { timezone: CONFIG.timezone });
    logger.info("All schedules are locked and loaded.");
})();

// graceful Shutdown
process.on("SIGINT", async () => {
    logger.info("Shutdown signal received. Cleaning up...");
    process.exit(0);
});