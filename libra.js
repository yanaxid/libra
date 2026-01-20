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


// mengambil tanggal hari ini dalam format YYYY-MM-DD
function getLocalDate() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" })
}

// ATTENDANCE STATE
let attendance = { date: null, clockIn: false, clockOut: false }


// mereset status absensi ketika tanggal berganti mencegah data clock in / clock out hari sebelumnya terbawa
function resetDaily() {
    const today = getLocalDate()
    if (attendance.date !== today) {
        attendance = { date: today, clockIn: false, clockOut: false }
        console.log("reset absensi harian")
    }
}


// LOGGING ------------------------------------------------------------

async function sendLog(message, level = "INFO") {
    if (!SHEET_API_URL) return

    const payload = {
        logs: `[${level}] ${message}`
    }

    try {
        await fetch(SHEET_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            timeout: 5000
        })
    } catch (err) {
        console.error(":::: gagal kirim log ke sheet:", err.message)
    }
}

const originalLog = console.log
const originalError = console.error

console.log = (...args) => {
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
    originalLog(...args)
    sendLog(msg, "INFO")
}

console.error = (...args) => {
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
    originalError(...args)
    sendLog(msg, "ERROR")
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



waClient.on("qr", (qr) => { console.log(":::: scan qr:"); qrcode.generate(qr, { small: false }) })


waClient.on("ready", async () => {
    waReady = true
    console.log(":::: wa ready")

    try {
        const chat = await waClient.getChatById(WA_GROUP_ID)
        console.log(":::: group wa id :", chat?.name)
    } catch (e) {
        console.error(":::: chat tidak ditemukan (cek WA_GROUP_ID):", e.message)
    }

    // await listGroups() // klw mau menampilkan list group wa
})


waClient.on("auth_failure", (msg) => { waReady = false; console.error(":::: xxx wa auth gagal:", msg) })
waClient.on("disconnected", (reason) => { waReady = false; console.error(":::: wa disconnected:", reason) })
waClient.on("authenticated", () => { console.log("AUTHENTICATED (session tersimpan)") })



// menangani proses shutdown aplikasi menutup whatsapp client secara aman
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




// mengirim pesan ke grup whatsapp
async function sendWA(text) {

    if (!text) { console.log(":::: wa text belum siap"); return false }
    if (!waReady) { console.log(":::: wa belum siap, kirim pesan diskip"); return false }

    try {
        const chat = await waClient.getChatById(WA_GROUP_ID)
        await chat.fetchMessages({ limit: 1 })

        await waClient.sendMessage(WA_GROUP_ID, text, { sendSeen: false })
        console.log(":::: wa terkirim:", text)
        return true
    } catch (e) {
        console.error(":::: gagal kirim WA:", e.message)
        return false
    }
}



// menampilkan list group
async function listGroups() {
    try {
        const chats = await waClient.getChats()

        const groups = chats.filter(c => c.isGroup)

        console.log(":::: total chat:", chats.length)
        console.log(":::: total group:", groups.length)

        groups.forEach((g, idx) => {
            console.log(`---- group ${idx + 1} ----`)
            console.log("name:", g.name)
            console.log("id:", g.id?._serialized)
            console.log("--------------------")
        })

        return groups
    } catch (e) {
        console.error(":::: gagal list group:", e)
        return []
    }
}


// TELEGRAM CLIENT
const tgClient = new TelegramClient(
    new StringSession(SESSION), API_ID, API_HASH, { connectionRetries: 5 }
)


// mengirim pesan ke bot telegram tujuan

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
 */
setInterval(async () => {
    try {
        if (!tgClient.connected) {
            console.log(":::: telegram disconnected, waiting auto reconnect")
            return
        }

        // ringan & aman
        await tgClient.invoke(new (require("telegram").Api.help.GetConfig)())
        console.log(":::: telegram keep-alive ok")
    } catch (e) {
        console.warn(":::: telegram keep-alive skipped:", e.message)
    }
}, 15 * 60 * 1000)


// mengambil data task dan pesan dari google sheet api
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



    console.log(":::: bot siap")

    // CRON CLOCK IN
    cron.schedule(
        "00 08 * * 1-5",
        async () => {
            resetDaily()
            if (attendance.clockIn) return

            console.log("attendance:", JSON.stringify(attendance, null, 2))

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


    // cron senin–kamis : 17:00
    cron.schedule("53 20 * * 1-4", async () => {
        resetDaily()
        if (attendance.clockOut) return

        console.log(":::: clock out (senin–kamis)")
        await handleClockOut()
    }, { timezone: "Asia/Jakarta" })


    // cron khusus hari jumat : 16:30
    cron.schedule("30 16 * * 5", async () => {
        resetDaily()
        if (attendance.clockOut) return

        console.log(":::: clock out (jumat)")
        await handleClockOut()
    }, { timezone: "Asia/Jakarta" })


    // run clockout
    async function handleClockOut() {

         await sendWA("test") // for test
         return 

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
