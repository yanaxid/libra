const { TelegramClient } = require("telegram")
const { StringSession } = require("telegram/sessions")
const { NewMessage } = require("telegram/events")
const input = require("input")
const cron = require("node-cron")
require("dotenv").config()


// CONFIG
const apiId = Number(process.env.API_ID)
const apiHash = process.env.API_HASH
const BOT_USERNAME = process.env.BOT_USERNAME
const SHEET_API_URL = process.env.SHEET_API_URL
const SESSION = process.env.SESSION


if (!SESSION) throw new Error("SESSION env belum di-set")


//FUNCTION
function getLocalDate() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" })
}

async function send(text) {
    try {
        const bot = await client.getEntity(BOT_USERNAME)
        await client.sendMessage(bot, { message: text })
        console.log(`terkirim: ${text}`)
        return true
    } catch (e) {
        console.error("gagal kirim: ", e.message)
        return false
    }
}


async function fetchTasksFromSheet() {
    try {
        const res = await fetch(SHEET_API_URL)
        if (!res.ok) throw new Error("Gagal ambil sheet")
        const tasks = await res.json()
        return tasks
    } catch (err) {
        console.error("Error fetch tasks:", err.message)
        return []
    }
}


// ATTENDANCE STATE
let attendance = { date: null, clockIn: false, clockOut: false }

// RESET HARIAN
function resetDaily() {
    const today = getLocalDate()
    if (attendance.date !== today) {
        attendance = { date: today, clockIn: false, clockOut: false }
        console.log("reset absensi harian")
    }
}

// SESSION
const client = new TelegramClient(
    new StringSession(SESSION),
    apiId,
    apiHash,
    { connectionRetries: 5 }
);



// MAIN
(async () => {
    console.log("LOGIN TELEGRAM")
    await client.start({
        phoneNumber: () => input.text("INPUT NO HP: "),
        phoneCode: () => input.text("OTP: "),
        password: async () => input.text("PASS 2FA (jika ada): "),
    })
    console.log("login ok! session disimpan")



    // LISTENER
    client.addEventHandler(async (event) => {
        const m = event.message
        if (!m || m.out) return

        const sender = await m.getSender()
        if (!sender?.bot || sender.username !== BOT_USERNAME) return

        console.log("\n📩 Pesan dari Virgo:")
        console.log(m.message || "gak ada text")

    }, new NewMessage({ incoming: true }))



    console.log("bot redy!!")

    //CEK IN
    cron.schedule("18 00 * * *", async () => {
        resetDaily()
        if (attendance.clockIn) return
        console.log("[CRON] Saatnya Clock In!")
        const ok = await send("/clock_in")
        if (ok) attendance.clockIn = true
    }, { timezone: "Asia/Jakarta"})

    //CEK OUT
    cron.schedule("15 10 * * *", async () => {
        resetDaily()
        if (attendance.clockOut) return
        console.log("⏰ [CRON] Saatnya Clock Out!")
        const ok = await send("/clock_out")
        if (ok) attendance.clockOut = true



        const tasks = await fetchTasksFromSheet()
        console.log("\n📄 TASKS DARI GOOGLE SHEET:")
        tasks.forEach(task => {
            console.log(`/TS ${task.taskId} :  ${task.task} : ${task.hour}`)
        })


    }, {timezone: "Asia/Jakarta"})

})()
