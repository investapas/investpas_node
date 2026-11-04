const crypto = require('crypto');
const query  = require('../helpers/query');
const constants = require('../vars/constants');
const dbcon  = require('../config/mysqlClient');
const instrumentStatus = require('../helpers/instrumentStatus');

const DB = constants.vals.defaultDB;

// ─────────────────────────────────────────────────────────────────────────────
// UNLOCK BALANCE — real money. The user tops it up with a Razorpay payment
// and spends it on Instant Quick Unlocks. Stored in user_coins.balance as
// whole rupees (1 = ₹1). It is NOT the same thing as demo coins (practice
// money in demo_wallets) — the API and app name them differently on purpose.
// ─────────────────────────────────────────────────────────────────────────────

// Index = (unlocks done today), so [0] = 1st unlock, [4] = 5th unlock.
// instantCoins = rupees charged from the unlock balance.
const UNLOCK_RULES = [
  { instantCoins: 50,  freeMinutes: 5 },   // 1st unlock
  { instantCoins: 50,  freeMinutes: 5 },   // 2nd unlock
  { instantCoins: 50,  freeMinutes: 5 },   // 3rd unlock
  { instantCoins: 100, freeMinutes: 5 },   // 4th unlock
  { instantCoins: 100, freeMinutes: 5 },   // 5th unlock
];
const MAX_UNLOCKS_PER_DAY = 5;

// Top-up amounts (₹) the app offers. Server-side list — never trust an
// amount the client sends.
const TOPUP_PACKS = [100, 250, 500, 1000];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrCreateBalance(dhanClientId) {
    const rows = await dbcon.query(DB, `SELECT balance FROM user_coins WHERE dhan_client_id = ? LIMIT 1`, [dhanClientId]);
    if (!rows || !rows[0]) {
        await dbcon.query(DB,
            `INSERT INTO user_coins (dhan_client_id, balance) VALUES (?, 0) ON DUPLICATE KEY UPDATE balance = balance`,
            [dhanClientId]);
        return 0;
    }
    return Number(rows[0].balance || 0);
}

async function todayUnlockCount(dhanClientId) {
    const rows = await dbcon.query(DB,
        `SELECT COUNT(*) AS total FROM challenge_pause_logs
         WHERE dhan_client_id = ? AND quick_unlock_used = 1 AND DATE(pause_start) = CURDATE()`,
        [dhanClientId]);
    return Number(rows?.[0]?.total || 0);
}

// Unlocks used this calendar month (IST) and rupees spent on them.
async function monthUnlockStats(dhanClientId) {
    const rows = await dbcon.query(DB,
        `SELECT COUNT(*) AS total, COALESCE(SUM(coins_spent), 0) AS spent
         FROM challenge_pause_logs
         WHERE dhan_client_id = ? AND quick_unlock_used = 1
           AND DATE_FORMAT(pause_start, '%Y-%m') = ?`,
        [dhanClientId, instrumentStatus.istDateKey().slice(0, 7)]);
    return { count: Number(rows?.[0]?.total || 0), spent: Number(rows?.[0]?.spent || 0) };
}

function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function ensureTopupTable() {
    await dbcon.query(DB,
        `CREATE TABLE IF NOT EXISTS wallet_topups (
            id INT AUTO_INCREMENT PRIMARY KEY,
            dhan_client_id VARCHAR(50) NOT NULL,
            amount_rupees INT NOT NULL,
            razorpay_order_id VARCHAR(64) NOT NULL,
            razorpay_payment_id VARCHAR(64) NULL,
            status ENUM('created','paid','failed') NOT NULL DEFAULT 'created',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            verified_at DATETIME NULL,
            UNIQUE KEY uq_topup_order (razorpay_order_id),
            INDEX idx_topup_client (dhan_client_id)
        )`, []);
}

module.exports.getOrCreateBalance  = getOrCreateBalance;
module.exports.todayUnlockCount    = todayUnlockCount;
module.exports.monthUnlockStats    = monthUnlockStats;
module.exports.ordinal             = ordinal;
module.exports.UNLOCK_RULES        = UNLOCK_RULES;
module.exports.MAX_UNLOCKS_PER_DAY = MAX_UNLOCKS_PER_DAY;

// ── GET /wallet/balance ───────────────────────────────────────────────────────
exports.getBalance = async (req, res) => {
    try {
        const dhanClientId = req.user.dhanClientId;
        const balance = await getOrCreateBalance(dhanClientId);
        return res.json({ status: true, data: { balance, currency: 'INR', label: 'Unlock balance' } });
    } catch (e) {
        return res.json({ status: false, message: e.message });
    }
};

// ── POST /wallet/add-coins — retired ──────────────────────────────────────────
// This used to credit the balance with no payment at all. Top-ups now go
// through /wallet/topup/order → Razorpay → /wallet/topup/verify.
exports.addCoins = async (req, res) => {
    return res.json({
        status: false,
        message: 'Please update the app — unlock balance top-ups now go through secure payment.',
    });
};

// ── POST /wallet/topup/order  { amount: 500 } ─────────────────────────────────
exports.createTopupOrder = async (req, res) => {
    try {
        await ensureTopupTable();
        const dhanClientId = req.user.dhanClientId;
        const amount = Number(req.body.amount || 0);
        if (!TOPUP_PACKS.includes(amount)) {
            return res.json({ status: false, message: `Choose a top-up of ₹${TOPUP_PACKS.join(', ₹')}.` });
        }

        const { getRazorpay } = require('./PaymentController');
        const order = await getRazorpay().orders.create({
            amount: amount * 100,
            currency: 'INR',
            receipt: `unlock_${dhanClientId}_${Date.now()}`,
            notes: { dhanClientId, purpose: 'unlock_balance_topup', rupees: String(amount) },
        });

        await dbcon.query(DB,
            `INSERT INTO wallet_topups (dhan_client_id, amount_rupees, razorpay_order_id) VALUES (?, ?, ?)`,
            [dhanClientId, amount, order.id]);

        return res.json({
            status: true,
            data: { orderId: order.id, amount: amount * 100, currency: 'INR', keyId: process.env.RAZORPAY_KEY_ID },
        });
    } catch (e) {
        console.log('[Wallet] createTopupOrder error:', e.message);
        return res.json({ status: false, message: e.message });
    }
};

// ── POST /wallet/topup/verify  { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Credits the balance exactly once per paid order (safe to call again).
exports.verifyTopup = async (req, res) => {
    try {
        await ensureTopupTable();
        const dhanClientId = req.user.dhanClientId;
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.json({ status: false, message: 'Missing payment details' });
        }

        const rows = await dbcon.query(DB,
            `SELECT * FROM wallet_topups WHERE razorpay_order_id = ? AND dhan_client_id = ? LIMIT 1`,
            [razorpay_order_id, dhanClientId]);
        const topup = rows && rows[0];
        if (!topup) return res.json({ status: false, message: 'Top-up not found for this account' });

        const expected = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');
        if (expected !== razorpay_signature) {
            await dbcon.query(DB,
                `UPDATE wallet_topups SET status = 'failed', razorpay_payment_id = ? WHERE id = ? AND status = 'created'`,
                [razorpay_payment_id, topup.id]);
            return res.json({ status: false, message: 'Payment verification failed' });
        }

        // Only the call that flips created → paid credits the balance.
        const flip = await dbcon.query(DB,
            `UPDATE wallet_topups SET status = 'paid', razorpay_payment_id = ?, verified_at = NOW()
             WHERE id = ? AND status = 'created'`,
            [razorpay_payment_id, topup.id]);

        if (flip && flip.affectedRows === 1) {
            await dbcon.query(DB,
                `INSERT INTO user_coins (dhan_client_id, balance) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance), updated_at = NOW()`,
                [dhanClientId, topup.amount_rupees]);
            await query.insertSingle(DB, 'coin_transactions', {
                dhan_client_id: dhanClientId,
                type: 'PURCHASE',
                amount: topup.amount_rupees,
                description: `Unlock balance top-up ₹${topup.amount_rupees}`,
                reference_id: topup.id,
            });
            console.log(`[Wallet] Top-up +₹${topup.amount_rupees} for ${dhanClientId} (${razorpay_payment_id})`);
        }

        const balance = await getOrCreateBalance(dhanClientId);
        return res.json({ status: true, message: `₹${topup.amount_rupees} added to your unlock balance`, data: { balance } });
    } catch (e) {
        console.log('[Wallet] verifyTopup error:', e.message);
        return res.json({ status: false, message: e.message });
    }
};

// ── GET /wallet/transactions ──────────────────────────────────────────────────
exports.getTransactions = async (req, res) => {
    try {
        const rows = await dbcon.query(DB,
            `SELECT * FROM coin_transactions WHERE dhan_client_id = ? ORDER BY created_at DESC LIMIT 50`,
            [req.user.dhanClientId]);
        return res.json({ status: true, data: rows || [] });
    } catch (e) {
        return res.json({ status: false, message: e.message });
    }
};

// ── GET /wallet/unlock-options ─────────────────────────────────────────────────
// Returns pricing + wait time for the NEXT unlock this user can do today
exports.getUnlockOptions = async (req, res) => {
    try {
        const dhanClientId = req.user.dhanClientId;
        const done    = await todayUnlockCount(dhanClientId);
        const balance = await getOrCreateBalance(dhanClientId);
        const month   = await monthUnlockStats(dhanClientId);

        if (done >= MAX_UNLOCKS_PER_DAY) {
            return res.json({
                status: true,
                canUnlock: false,
                message: `Maximum ${MAX_UNLOCKS_PER_DAY} quick unlocks per day reached.`,
                unlocksUsed: done,
                maxUnlocks: MAX_UNLOCKS_PER_DAY,
                month,
            });
        }

        const rule = UNLOCK_RULES[done];
        const freeAvailableAt = new Date(Date.now() + rule.freeMinutes * 60 * 1000);
        const monthUnlockNumber = month.count + 1;

        return res.json({
            status: true,
            canUnlock: true,
            unlocksUsed: done,
            maxUnlocks: MAX_UNLOCKS_PER_DAY,
            unlockNumber: done + 1,
            // "This is your 4th unlock this month" — shown before the user confirms.
            monthUnlockNumber,
            monthMessage: `This will be your ${ordinal(monthUnlockNumber)} unlock this month.`,
            month,
            instant: {
                coins: rule.instantCoins,          // kept for older app builds
                rupees: rule.instantCoins,
                userBalance: balance,
                canAfford: balance >= rule.instantCoins,
            },
            free: {
                waitMinutes: rule.freeMinutes,
                availableAt: freeAvailableAt.toISOString(),
            },
        });
    } catch (e) {
        return res.json({ status: false, message: e.message });
    }
};

// ── GET /wallet/unlocks?from=YYYY-MM-DD&to=YYYY-MM-DD ─────────────────────────
// Every quick unlock in the range, each with the trades that followed it
// (closed between trading resuming and the next unlock / end of that day),
// plus totals. Live P&L is rupees; demo P&L is practice coins — kept apart.
exports.getUnlocks = async (req, res) => {
    try {
        const dhanClientId = req.user.dhanClientId;
        const today = instrumentStatus.istDateKey();
        const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : `${today.slice(0, 7)}-01`;
        const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;

        const unlocks = (await dbcon.query(DB,
            `SELECT id, rule_triggered, pause_start, pause_end, unlock_type, coins_spent
             FROM challenge_pause_logs
             WHERE dhan_client_id = ? AND quick_unlock_used = 1
               AND DATE(pause_start) BETWEEN ? AND ?
             ORDER BY pause_start ASC`,
            [dhanClientId, from, to])) || [];

        // Running count within each month, for "your 4th unlock this month".
        const firstMonth = `${from.slice(0, 7)}-01`;
        const prior = await dbcon.query(DB,
            `SELECT COUNT(*) AS n FROM challenge_pause_logs
             WHERE dhan_client_id = ? AND quick_unlock_used = 1
               AND pause_start >= ? AND DATE(pause_start) < ?`,
            [dhanClientId, firstMonth, from]);
        let monthKey = from.slice(0, 7);
        let monthCounter = Number(prior?.[0]?.n || 0);

        // Trades closed in the whole range, fetched once and bucketed below.
        // Separate queries: these tables use different collations.
        const rangeEnd = `${to} 23:59:59`;
        const liveTrades = (await dbcon.query(DB,
            `SELECT trading_symbol, pnl, COALESCE(sell_executed_at, created_at) AS closed_at
             FROM challenge_trade_logs
             WHERE dhan_client_id = ? AND pnl IS NOT NULL
               AND COALESCE(sell_executed_at, created_at) BETWEEN ? AND ?`,
            [dhanClientId, `${from} 00:00:00`, rangeEnd])) || [];
        let demoTrades = [];
        try {
            demoTrades = (await dbcon.query(DB,
                `SELECT trading_symbol, pnl, COALESCE(executed_at, created_at) AS closed_at
                 FROM demo_orders
                 WHERE dhan_client_id = ? AND transaction_type = 'SELL' AND order_status = 'TRADED'
                   AND COALESCE(executed_at, created_at) BETWEEN ? AND ?`,
                [dhanClientId, `${from} 00:00:00`, rangeEnd])) || [];
        } catch (e) {
            if (!/doesn't exist|Unknown column/i.test(e.message)) throw e;
        }
        const trades = [
            ...liveTrades.map((t) => ({ ...t, mode: 'LIVE' })),
            ...demoTrades.map((t) => ({ ...t, mode: 'DEMO' })),
        ].map((t) => ({ symbol: t.trading_symbol, pnl: Number(t.pnl || 0), at: String(t.closed_at), mode: t.mode }))
         .sort((a, b) => (a.at < b.at ? -1 : 1));

        const items = unlocks.map((u, i) => {
            const startedAt = String(u.pause_start);
            if (startedAt.slice(0, 7) !== monthKey) { monthKey = startedAt.slice(0, 7); monthCounter = 0; }
            monthCounter += 1;

            const resumeAt = String(u.pause_end || u.pause_start);
            const dayEnd = `${resumeAt.slice(0, 10)} 23:59:59`;
            const next = unlocks[i + 1] && String(unlocks[i + 1].pause_end || unlocks[i + 1].pause_start);
            const windowEnd = next && next < dayEnd ? next : dayEnd;
            const following = trades.filter((t) => t.at >= resumeAt && t.at < windowEnd);
            const sum = (mode) => following.filter((t) => t.mode === mode).reduce((s, t) => s + t.pnl, 0);

            return {
                id: u.id,
                date: startedAt.slice(0, 10),
                blockedAt: startedAt,
                resumedAt: resumeAt,
                type: u.unlock_type || 'INSTANT',
                rupeesSpent: Number(u.coins_spent || 0),
                ruleTriggered: u.rule_triggered,
                monthUnlockNumber: monthCounter,
                followingTrades: following,
                followingLivePnl: Number(sum('LIVE').toFixed(2)),
                followingDemoPnl: Number(sum('DEMO').toFixed(2)),
            };
        });

        const totals = {
            count: items.length,
            rupeesSpent: items.reduce((s, u) => s + u.rupeesSpent, 0),
            followingLivePnl: Number(items.reduce((s, u) => s + u.followingLivePnl, 0).toFixed(2)),
            followingDemoPnl: Number(items.reduce((s, u) => s + u.followingDemoPnl, 0).toFixed(2)),
        };

        return res.json({ status: true, data: { from, to, unlocks: items, totals } });
    } catch (e) {
        console.log('[Wallet] getUnlocks error:', e.message);
        return res.json({ status: false, message: e.message });
    }
};
