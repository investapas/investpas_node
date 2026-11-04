const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const logger = require("morgan");
require("dotenv").config({ path: "./.env" });

const indexRouter = require("./routes/index");
const wishlistRouter = require("./routes/wishlist");
const dhanRouter = require("./routes/dhan");
const challengeRouter = require("./routes/challenge");
const trialRouter     = require("./routes/trial");
const profileRouter = require("./routes/profile");
const walletRouter    = require("./routes/wallet");
const demoRouter      = require("./routes/demo");
const tradingRouter   = require("./routes/trading");
const contactRouter   = require("./routes/contact");
const paymentRouter   = require("./routes/payment");
const accountRouter   = require("./routes/account");
const quizRouter = require("./routes/quiz");
const { syncExpiryDates } = require("./controllers/DhanController");
const adminRouter =
    require("./routes/admin.routes");
const notificationRouter = require("./routes/notification");
const apiResponse = require("./vars/apiResponse");
const cors = require("cors");
const moment = require("moment");

const dbQuery = require("./helpers/query");
const { syncDhanTrades } = require("./helpers/syncDhanTrades");
const { syncDemoPnL }   = require("./helpers/syncDemoTrades");
const { syncTodayTrades } = require("./helpers/dhanTradeHistorySync");

const cron = require("node-cron");
let constants = require("./vars/constants");
const dbcon = require("./config/mysqlClient");
const utility = require("./helpers/utility");

const http = require("http");
const { Server } = require("socket.io");
const { setupSocket } = require("./config/socket");
const instrumentController = require("./controllers/instrumentController");

const app = express();

// Logger
if (process.env.NODE_ENV !== "test") {
    app.use(logger("dev"));
}

// Server
const server = http.createServer(app);

// Socket
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use((req, res, next) => {
    req.io = io;
    next();
});

setupSocket(io);

// Middleware
// verify: stashes the raw request bytes before JSON-parsing them — needed
// by POST /trial/razorpay-webhook to check Razorpay's HMAC signature,
// which is computed over the exact raw body, not the re-serialized object.
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use(cors());

// Static paths
app.use('/apiService', express.static(path.join(__dirname, 'Assets', 'Evidence')));
app.use('/userProfile', express.static(path.join(__dirname, 'Assets', 'profilePicture')));
app.use('/notificationImages', express.static(path.join(__dirname, 'Assets', 'notificationImages')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Test API
app.get('/test', (req, res) => {
    res.status(200).json({
        status: true,
        message: 'Test API is working!',
        time: moment().format("YYYY-MM-DD HH:mm:ss")
    });
});

// Routes
app.use("/", indexRouter);
app.use("/dhan/", dhanRouter);
app.use("/challenge/", challengeRouter);
app.use("/trial/", trialRouter);
app.use("/wishlist/", wishlistRouter);
app.use("/profile/", profileRouter);
app.use("/wallet/",  walletRouter);
app.use("/demo/",    demoRouter);
app.use("/payment/", paymentRouter);
app.use("/admin/", adminRouter);
app.use("/notification/", notificationRouter);
app.use("/api/trading/", tradingRouter);
app.use("/contact/",    contactRouter);
app.use("/account/",    accountRouter);
app.use("/api/quiz/",   quizRouter);

// Investapas Quiz page itself — static HTML, served under the same app so
// investapas.in/quiz can simply be a reverse-proxy/redirect to this route
// (query string, e.g. ?src=cafe-casa, is preserved either way).
app.get("/quiz", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "quiz", "index.html"));
});

// 404
app.all("*", function (req, res) {
    return apiResponse.notFoundResponse(res, "Page not found");
});

// Auth error
app.use((err, req, res) => {
    if (err.name === "UnauthorizedError") {
        return apiResponse.unauthorizedResponse(res, err.message);
    }
});


// =======================================================
// 🔥 CRON 1 — INSTRUMENT SYNC (DAILY)
// =======================================================

cron.schedule("30 8 * * *", async () => {
    try {
        console.log("📊 Instrument Cron Started");

        if (utility.checkEmpty(constants.vals.dbconn)) {
            constants.vals.dbconn = await dbcon.connection();
        }

        await instrumentController.runInstrumentCron();

        console.log("✅ Instrument Cron Done");
        // Sync option expiry dates from Dhan API (NIFTY, BANKNIFTY, etc.)
        console.log("📅 Syncing option expiry dates...");
        await syncExpiryDates(null, null);  // null = no req/res (cron context)
        console.log("✅ Expiry Dates Sync Done");

        // Update historical candles for all cached securities
        console.log("📈 Updating historical candles...");
        const histCache = require("./helpers/historicalCache");
        const cachedSecurities = await dbcon.query(constants.vals.defaultDB,
            `SELECT DISTINCT security_id, exchange_segment FROM historical_candles`);
        for (const row of (cachedSecurities || [])) {
            const seg = row.exchange_segment;
            const instr = seg === 'IDX_I' ? 'INDEX' : seg.includes('FNO') ? 'OPTIDX' : 'EQUITY';
            await histCache.syncHistory(row.security_id, seg, instr);
        }
        console.log(`✅ Historical Candles Updated (${cachedSecurities?.length || 0} securities)`);

        // Update intraday candles (1m/5m/15m/etc.) for all cached security+interval combos.
        // Scope stays bounded to combos users have actually viewed — the expensive
        // 180-day backfill only ever runs once, lazily, on first view (see
        // DhanController.getCachedIntradayData); this just tops up what's already there.
        console.log("📊 Updating intraday candles...");
        const intradayCache = require("./helpers/intradayCandleCache");
        const cachedIntraday = await dbcon.query(constants.vals.defaultDB,
            `SELECT DISTINCT security_id, exchange_segment, interval_minutes FROM market_historical_candles`);
        for (const row of (cachedIntraday || [])) {
            const seg = row.exchange_segment;
            const instr = seg === 'IDX_I' ? 'INDEX' : seg.includes('FNO') ? 'OPTIDX' : 'EQUITY';
            try {
                await intradayCache.syncHistory(row.security_id, seg, instr, row.interval_minutes);
            } catch (e) {
                console.log(`❌ Intraday cron item error (${row.security_id}/${row.interval_minutes}m):`, e.message);
            }
            await new Promise(r => setTimeout(r, 200));
        }
        console.log(`✅ Intraday Candles Updated (${cachedIntraday?.length || 0} combos)`);

    } catch (error) {
        console.error("❌ Instrument Cron Error:", error.message);
    }
}, {
    timezone: "Asia/Kolkata"
});


// =======================================================
// 🔥 CRON 2 — TRADE SYNC (EVERY 3 SEC)
// =======================================================

let isRunning = false;

cron.schedule("*/3 * * * * *", async () => {

    if (isRunning) return;
    isRunning = true;

    try {

        if (utility.checkEmpty(constants.vals.dbconn)) {
            constants.vals.dbconn = await dbcon.connection();
        }

        await syncDhanTrades();

    } catch (e) {
        console.log("❌ Trade Cron Error:", e.message);
    }

    isRunning = false;

});


// =======================================================
// 🔥 CRON 4 — DEMO P&L ALERT (EVERY 3 SEC)
// =======================================================

let isDemoRunning = false;

cron.schedule("*/3 * * * * *", async () => {

    if (isDemoRunning) return;
    isDemoRunning = true;

    try {

        if (utility.checkEmpty(constants.vals.dbconn)) {
            constants.vals.dbconn = await dbcon.connection();
        }

        await syncDemoPnL();

    } catch (e) {
        console.log("❌ Demo PnL Cron Error:", e.message);
    }

    isDemoRunning = false;

});


// =======================================================
// 🔥 CRON 3 — DAILY CHALLENGE RESET (MIDNIGHT)
// =======================================================

cron.schedule("0 0 * * *", async () => {
    try {

        console.log("🔄 Daily Challenge Reset Started...");

        if (utility.checkEmpty(constants.vals.dbconn)) {
            constants.vals.dbconn = await dbcon.connection();
        }

        // ✅ 1. CLOSE OLD PAUSE LOGS
        await dbQuery.updateRecord(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            `pause_end IS NULL`,
            `pause_end = NOW()`
        );

        // ✅ 2. RESET USER STATUS
        await dbQuery.updateRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `challenge_status='BLOCKED'`,
            `challenge_status='ACTIVE', updated_at=NOW()`
        );

        console.log("✅ Daily Challenge Reset Completed");

    } catch (error) {
        console.log("❌ Reset Cron Error:", error.message);
    }
}, {
    timezone: "Asia/Kolkata"
});

// =======================================================
// ⏳ INSTRUMENT LIFECYCLE SWEEP
// Marks contracts EXPIRED once their expiry day's session has closed
// (instrument master, watchlists, pending demo orders, live feed).
// Runs right after market close, just after midnight, at startup, and after
// every instrument-master sync. Idempotent; never deletes anything.
// =======================================================
const instrumentStatus = require("./helpers/instrumentStatus");

async function runLifecycleSweep(label) {
    try {
        await instrumentStatus.sweepExpired();
    } catch (e) {
        console.log(`❌ [INSTRUMENT_EXPIRY] ${label} sweep error:`, e.message);
    }
}

cron.schedule("31 15 * * 1-5", () => runLifecycleSweep("post-close"), { timezone: "Asia/Kolkata" });
cron.schedule("1 0 * * *", () => runLifecycleSweep("midnight"), { timezone: "Asia/Kolkata" });

// =======================================================
// 📅 STARTUP — sync expiry dates on first boot
// =======================================================
setTimeout(async () => {
    try {
        if (utility.checkEmpty(constants.vals.dbconn)) {
            constants.vals.dbconn = await dbcon.connection();
        }
        await runLifecycleSweep("startup");
        console.log("📅 [Startup] Syncing option expiry dates...");
        await syncExpiryDates(null, null);
    } catch (e) {
        console.log("📅 [Startup] Expiry sync error:", e.message);
    }
}, 5000);

// =======================================================
// 🔥 CRON 4 — MORNING NOTIFICATION (9:10 AM)
// =======================================================

const notificationHelper = require("./helpers/notificationHelper");

cron.schedule("10 9 * * *", async () => {
    try {
        console.log("🌅 Morning notification started");
        const tokens = await notificationHelper.getAllFirebaseTokens();
        if (!tokens.length) { console.log("⚠️ No tokens for morning notif"); return; }
        await utility.sendNotification(tokens, 'notification', '', { title: "Good Morning", body: "Market opens soon" });
        console.log(`📢 Morning notif sent to ${tokens.length} user(s)`);
    } catch (e) { console.log("❌ Morning Notif Error:", e.message); }
}, { timezone: "Asia/Kolkata" });


// =======================================================
// 🔥 CRON 5 — AFTERNOON NOTIFICATION (3:15 PM)
// =======================================================

cron.schedule("15 15 * * *", async () => {
    try {
        console.log("☀️ Afternoon notification started");
        const tokens = await notificationHelper.getAllFirebaseTokens();
        if (!tokens.length) { console.log("⚠️ No tokens for afternoon notif"); return; }
        await utility.sendNotification(tokens, 'notification', '', { title: "Market Update", body: "Daily summary" });
        console.log(`📢 Afternoon notif sent to ${tokens.length} user(s)`);
    } catch (e) { console.log("❌ Afternoon Notif Error:", e.message); }
}, { timezone: "Asia/Kolkata" });

// =======================================================
// 🔥 CRON 6 — JOURNAL TRADE HISTORY SYNC (3:40 PM, trading days)
// Keeps `dhan_trades` (see migrations/015_dhan_trade_history.sql) caught
// up with today's fills so the Journal screen never has to call Dhan live.
// =======================================================
cron.schedule("40 15 * * 1-5", async () => {
    try {
        console.log("📒 Trade history sync started");
        const users = await dbQuery.fetchRecords(
            constants.vals.defaultDB,
            "users",
            `WHERE dhan_client_id IS NOT NULL AND dhan_access_token IS NOT NULL AND is_active = 1`
        );
        if (!users || !users.length) { console.log("📒 No Dhan-linked users to sync"); return; }
        for (const u of users) {
            try {
                await syncTodayTrades(u.dhan_client_id, u.dhan_access_token);
            } catch (e) {
                console.log(`📒 Trade history sync error (${u.dhan_client_id}):`, e.message);
            }
        }
        console.log(`📒 Trade history sync done for ${users.length} user(s)`);
    } catch (e) { console.log("❌ Trade History Sync Cron Error:", e.message); }
}, { timezone: "Asia/Kolkata" });

// =======================================================
// 🚀 SERVER START
// =======================================================

module.exports = { app, server };