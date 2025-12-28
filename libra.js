const { TelegramClient } = require("telegram")
const { StringSession } = require("telegram/sessions")
const { NewMessage } = require("telegram/events")
const input = require("input")
const cron = require("node-cron")
require("dotenv").config()
const { Client: WaClient, LocalAuth } = require("whatsapp-web.js")
const qrcode = require("qrcode-terminal")

//CONFIG
const API_ID = Number(process.env.API_ID)
const API_HASH = process.env.API_HASH
const BOT_USERNAME = process.env.BOT_USERNAME
const SHEET_API_URL = process.env.SHEET_API_URL
const SESSION = process.env.SESSION
const WA_GROUP_ID = process.env.GROUPID_WA


function getLocalDate() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" })
}

// ATTENDANCE STATE
let attendance = { date: null, clockIn: false, clockOut: false }

function resetDaily() {
    const today = getLocalDate()
    if (attendance.date !== today) {
        attendance = { date: today, clockIn: false, clockOut: false }
        console.log("reset absensi harian")
    }
}


// WHATSAPP CLIENT
let waReady = false

const waClient = new WaClient({

    authStrategy: new LocalAuth({

        clientId: "libra-bot"

    }),

    puppeteer: {
        headless: true,

        args: [

            "--no-sandbox",

            "--disable-setuid-sandbox",

            "--disable-dev-shm-usage",

            "--disable-gpu",

            "--single-process"

        ]

    }

})






waClient.on("qr", (qr) => {
    console.log(":::: scan qr:")
    qrcode.generate(qr, { small: false })
})

waClient.on("ready", () => {
    waReady = true
    console.log(":::: wa ready")
})

waClient.on("auth_failure", (msg) => {
    waReady = false
    console.error(":::: xxx wa auth gagal:", msg)
})

waClient.on("disconnected", (reason) => {
    waReady = false
    console.error(":::: wa disconnected:", reason)

})



waClient.on("authenticated", () => {

    console.log("✅ AUTHENTICATED (session tersimpan)")

})



process.on("SIGINT", async () => {

    console.log("\n:::: shutdown detected, closing WA client...")



    try {

        if (waClient) {

            await waClient.destroy()

            console.log(":::: WA client closed cleanly")

        }

    } catch (e) {

        console.error(":::: error closing WA:", e.message)

    }



    process.exit(0)

})




waClient.initialize()

async function sendWA(text) {
    if (!waReady) {
        console.log(":::: wa belum siap, kirim pesan diskip")
        return false
    }

    try {
        await waClient.sendMessage(WA_GROUP_ID, text)
        console.log(":::: wa terkirim:", text)
        return true
    } catch (e) {
        console.error(":::: gagal kirim WA:", e.message)
        return false
    }
}

// TELEGRAM CLIENT
const tgClient = new TelegramClient(
    new StringSession(SESSION), API_ID, API_HASH, { connectionRetries: 5 }
)

async function sendTG(text) {
    if (!tgClient.connected) {
        console.log(":::: telegram belum connected, skip:", text)
        return false
    }

    try {
        const bot = await tgClient.getEntity(BOT_USERNAME)
        await tgClient.sendMessage(bot, { message: text })
        console.log(":::: telegram terkirim:", text)
        return true
    } catch (e) {
        console.error(":::: gagal kirim ke telegram:", e.message)
        return false
    }
}

async function fetchTasksFromSheet() {
    try {
        const res = await fetch(SHEET_API_URL)
        if (!res.ok) throw new Error(":::: gagal get sheet")
        return await res.json()
    } catch (err) {
        console.error(":::: fetch data dari google sheet error", err.message)
        return null
    }
}

// MAIN
; (async () => {
    // LOGIN TELEGRAM
    if (!SESSION) {
        console.log(":::: login telegram ...")
        await tgClient.start({
            phoneNumber: () => input.text(":::: INPUT NO HP: "),
            phoneCode: () => input.text(":::: OTP: "),
            password: async () => input.text(":::: PASS 2FA (jika ada): "),
            onError: console.error,
        })
        console.log(":::: login telgram ok!")
        console.log(":::: COPY KE .env:")
        console.log(tgClient.session.save())
    } else {
        await tgClient.connect()
        console.log(":::: telegram connected")
    }

    // LISTENER TELEGRAM
    tgClient.addEventHandler(async (event) => {
        try {
            const m = event.message
            if (!m || m.out) return
            const sender = await m.getSender()
            if (!sender?.bot || sender.username !== BOT_USERNAME) return

            console.log(":::: pesan dari bot:", m.message)
        } catch (err) {
            console.error(":::: telegram event handler error:", err.message)
        }
    }, new NewMessage({ incoming: true }))


    console.log(":::: bot siap")

    // CRON CLOCK IN
    cron.schedule(
        "00 08 * * 1-5",
        async () => {
            resetDaily()
            if (attendance.clockIn) return

            console.log("clock in")
            await sendTG("/clock_in")

            const data = await fetchTasksFromSheet()

            const ciMessage = data?.cico?.[0]?.ci
            if (!ciMessage) {
                console.log(":::: CI kosong / tidak ditemukan")
            } else {
                attendance.clockIn = true
                await sendWA(ciMessage)
            }
        },
        { timezone: "Asia/Jakarta" }
    )

    // CRON CLOCK OUT
    cron.schedule("00 17 * * 1-5", async () => {
        resetDaily()
        if (attendance.clockOut) return
        console.log(":::: clock out")
        await sendTG("/clock_out")
        attendance.clockOut = true

        const data = await fetchTasksFromSheet()
        if (!data) {
            console.log(":::: data kosong dari sheet")
            return
        }

        const coMessage = data?.cico?.[0]?.co
        if (!coMessage) {
            console.log(":::: CO kosong / tidak ditemukan")
        } else {
            await sendWA(coMessage)
        }

        if (!Array.isArray(data.tasks) || data.tasks.length === 0) {
            console.log(":::: list task kosong")
            attendance.clockOut = true
            return
        }

        const delay = ms => new Promise(r => setTimeout(r, ms))
        for (const task of data.tasks) {
            if (!task?.taskId || !task?.task || !task?.hour) {
                console.log(":::: data task tidak lengkap:", task)
                continue
            }

            const text = `/TS ${task.taskId} : ${task.task} : ${task.hour}`

            console.log("text --> " + text)

            await sendTG(text)
            await delay(1000)
        }
        attendance.clockOut = true
    },
        { timezone: "Asia/Jakarta" }
    )
})()