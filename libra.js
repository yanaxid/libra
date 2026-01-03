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


/**
 * mengambil tanggal hari ini dalam format YYYY-MM-DD
 * menggunakan timezone Asia/Jakarta
 * @returns {string}
 */
function getLocalDate() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" })
}

// ATTENDANCE STATE
let attendance = { date: null, clockIn: false, clockOut: false }


/**
 * mereset status absensi ketika tanggal berganti
 * mencegah data clock in / clock out hari sebelumnya terbawa
 * @returns {void}
 */
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
        headless: true,                 // jalankan chromium tanpa gui (wajib di vps/server)
        args: [
            "--no-sandbox",             // matikan sandbox chromium
            "--disable-setuid-sandbox", // hindari crash karena setuid tidak diizinkan
            "--disable-dev-shm-usage",  // hindari freeze karena /dev/shm kecil
            "--disable-gpu"             // nonaktifkan gpu
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
    console.log("AUTHENTICATED (session tersimpan)")
})



/**
 * menangani proses shutdown aplikasi
 * menutup whatsapp client secara aman
 * @returns {void}
 */
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




/**
 * mengirim pesan ke grup whatsapp
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function sendWA(text) {
    if (!text) return false

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


/**
 * mengirim pesan ke bot telegram tujuan
 * @param {string} text
 * @returns {Promise<boolean>}
 */
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

let tgReconnecting = false


/**
 * menjaga koneksi telegram tetap hidup
 * melakukan reconnect otomatis jika terjadi timeout
 * dijalankan secara periodik menggunakan setInterval
 * @returns {void}
 */
setInterval(async () => {
    if (tgReconnecting) return

    try {
        if (!tgClient.connected) {
            tgReconnecting = true
            console.log(":::: telegram not connected, reconnecting...")
            await tgClient.connect()
            console.log(":::: telegram reconnected")
            tgReconnecting = false
            return
        }

        await tgClient.getMe()
        console.log(":::: telegram keep-alive ok")
    } catch (e) {
        console.error(":::: telegram keep-alive error:", e.message)

        if (e.message.includes("TIMEOUT")) {
            try {
                tgReconnecting = true
                await tgClient.disconnect()
                await tgClient.connect()
                console.log(":::: telegram reconnected after timeout")
            } catch (err) {
                console.error(":::: reconnect failed:", err.message)
            } finally {
                tgReconnecting = false
            }
        }
    }
}, 10 * 60 * 1000)


/**
 * mengambil data task dan pesan dari google sheet api
 * @returns {Promise<Object|null>}
 */
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


    /**
     * cron clock out untuk hari senin–kamis
     * run 17:00
     */
    cron.schedule("00 17 * * 1-4", async () => {
        resetDaily()
        if (attendance.clockOut) return

        console.log(":::: clock out (senin–kamis)")
        await handleClockOut()
    }, { timezone: "Asia/Jakarta" })


    /**
     * cron clock out khusus hari jumat
     * run 16:30
     */
    cron.schedule("30 16 * * 5", async () => {
        resetDaily()
        if (attendance.clockOut) return

        console.log(":::: clock out (jumat)")
        await handleClockOut()
    }, { timezone: "Asia/Jakarta" })


    /**
     * menjalankan proses clock out:
     */
    async function handleClockOut() {
        await sendTG("/clock_out")

        const data = await fetchTasksFromSheet()
        if (!data) {
            console.log(":::: data kosong dari sheet")
            attendance.clockOut = true
            return
        }

        const coMessage = data?.cico?.[0]?.co
        if (coMessage) {
            await sendWA(coMessage)
        } else {
            console.log(":::: CO kosong / tidak ditemukan")
        }

        if (Array.isArray(data.tasks) && data.tasks.length > 0) {
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
        } else {
            console.log(":::: list task kosong")
        }

        attendance.clockOut = true
    }
})()