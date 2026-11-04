const Razorpay = require("razorpay");
const crypto = require("crypto");
const dbcon = require("../config/mysqlClient");
const constants = require("../vars/constants");

const DB = constants.vals.defaultDB;

// Built lazily (not at require-time) — constructing Razorpay eagerly with a
// missing key_id/key_secret throws immediately, which would crash the whole
// server at boot (this file is required by ChallengeController.js, so it's
// on the hot path for every process start) just because this one feature's
// env vars aren't set yet. Deferring it means a misconfigured payment
// gateway only breaks payment endpoints, not the entire app.
let _razorpay = null;
function getRazorpay() {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        throw new Error("Razorpay is not configured (missing RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET)");
    }
    if (!_razorpay) {
        _razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });
    }
    return _razorpay;
}

// Server-side price list — never trust a client-sent amount for what to
// charge. Keep this in sync with the plan cards in the Flutter app's
// SelectPlanPage (lib/presentation/pages/setup_challenge/select_plan_page.dart).
const PLAN_PRICES = {
    firstWeek: { amountPaise: 29900, label: "First Week", challengeDays: 5 },
    monthly: { amountPaise: 99900, label: "Monthly", challengeDays: 30 },
};

async function ensureTable() {
    await dbcon.query(
        DB,
        `CREATE TABLE IF NOT EXISTS plan_payments (
            id INT AUTO_INCREMENT PRIMARY KEY,
            dhan_client_id VARCHAR(64) NOT NULL,
            plan_type VARCHAR(32) NOT NULL,
            amount_paise INT NOT NULL,
            razorpay_order_id VARCHAR(64) NOT NULL,
            razorpay_payment_id VARCHAR(64) NULL,
            status ENUM('created','paid','failed') NOT NULL DEFAULT 'created',
            used_for_challenge TINYINT(1) NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            verified_at DATETIME NULL,
            INDEX (dhan_client_id),
            INDEX (razorpay_order_id)
        )`,
        []
    );
}

// ── POST /payment/create-order  { planType: 'firstWeek' | 'monthly' } ──────
exports.createOrder = async (req, res) => {
    try {
        await ensureTable();
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const { planType } = req.body;
        const plan = PLAN_PRICES[planType];
        if (!plan) {
            return res.json({ status: false, message: "Invalid plan" });
        }

        // Already paid for this plan but never used it to finish creating a
        // challenge (e.g. backed out of the rules form)? Hand that order
        // back instead of charging again — the client skips checkout
        // entirely when it sees alreadyPaid:true.
        const existing = await dbcon.query(
            DB,
            `SELECT * FROM plan_payments
             WHERE dhan_client_id=? AND plan_type=? AND status='paid' AND used_for_challenge=0
             ORDER BY id DESC LIMIT 1`,
            [user.dhanClientId, planType]
        );
        if (existing && existing[0]) {
            return res.json({
                status: true,
                data: {
                    alreadyPaid: true,
                    orderId: existing[0].razorpay_order_id,
                    planLabel: plan.label,
                },
            });
        }

        const order = await getRazorpay().orders.create({
            amount: plan.amountPaise,
            currency: "INR",
            receipt: `plan_${planType}_${Date.now()}`,
            notes: { dhanClientId: user.dhanClientId, planType },
        });

        await dbcon.query(
            DB,
            `INSERT INTO plan_payments (dhan_client_id, plan_type, amount_paise, razorpay_order_id, status)
             VALUES (?, ?, ?, ?, 'created')`,
            [user.dhanClientId, planType, plan.amountPaise, order.id]
        );

        return res.json({
            status: true,
            data: {
                orderId: order.id,
                amount: plan.amountPaise,
                currency: "INR",
                keyId: process.env.RAZORPAY_KEY_ID,
                planLabel: plan.label,
            },
        });
    } catch (error) {
        console.error("[Payment] createOrder error:", error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ── POST /payment/verify  { razorpay_order_id, razorpay_payment_id, razorpay_signature } ──
exports.verifyPayment = async (req, res) => {
    try {
        await ensureTable();
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.json({ status: false, message: "Missing payment details" });
        }

        // Confirm this order actually belongs to this user before verifying —
        // stops someone replaying another user's order/payment ids.
        const rows = await dbcon.query(
            DB,
            `SELECT * FROM plan_payments WHERE razorpay_order_id=? AND dhan_client_id=? LIMIT 1`,
            [razorpay_order_id, user.dhanClientId]
        );
        const record = rows && rows[0];
        if (!record) {
            return res.json({ status: false, message: "Order not found for this user" });
        }

        const expectedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");

        if (expectedSignature !== razorpay_signature) {
            await dbcon.query(
                DB,
                `UPDATE plan_payments SET status='failed', razorpay_payment_id=? WHERE razorpay_order_id=?`,
                [razorpay_payment_id, razorpay_order_id]
            );
            return res.json({ status: false, message: "Payment verification failed" });
        }

        await dbcon.query(
            DB,
            `UPDATE plan_payments SET status='paid', razorpay_payment_id=?, verified_at=NOW() WHERE razorpay_order_id=?`,
            [razorpay_payment_id, razorpay_order_id]
        );

        return res.json({
            status: true,
            message: "Payment verified",
            data: { planType: record.plan_type, orderId: razorpay_order_id },
        });
    } catch (error) {
        console.error("[Payment] verifyPayment error:", error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ── GET /payment/history ────────────────────────────────────────────────
exports.getPaymentHistory = async (req, res) => {
    try {
        await ensureTable();
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const rows = await dbcon.query(
            DB,
            `SELECT id, plan_type, amount_paise, razorpay_order_id, razorpay_payment_id,
                    status, used_for_challenge, created_at, verified_at
             FROM plan_payments
             WHERE dhan_client_id=?
             ORDER BY id DESC`,
            [user.dhanClientId]
        );

        const data = (rows || []).map((r) => ({
            id: r.id,
            planType: r.plan_type,
            planLabel: PLAN_PRICES[r.plan_type]?.label || r.plan_type,
            amountPaise: r.amount_paise,
            orderId: r.razorpay_order_id,
            paymentId: r.razorpay_payment_id,
            status: r.status,
            usedForChallenge: !!r.used_for_challenge,
            createdAt: r.created_at,
            verifiedAt: r.verified_at,
        }));

        return res.json({ status: true, count: data.length, data });
    } catch (error) {
        console.error("[Payment] getPaymentHistory error:", error.message);
        return res.json({ status: false, message: error.message });
    }
};

// Used internally by ChallengeController to confirm a paid plan has a
// verified, not-yet-used payment before letting challenge creation proceed.
exports.consumeVerifiedPayment = async function (dhanClientId, orderId, planType) {
    await ensureTable();
    const rows = await dbcon.query(
        DB,
        `SELECT * FROM plan_payments
         WHERE razorpay_order_id=? AND dhan_client_id=? AND plan_type=? AND status='paid' AND used_for_challenge=0
         LIMIT 1`,
        [orderId, dhanClientId, planType]
    );
    const record = rows && rows[0];
    if (!record) return false;

    await dbcon.query(
        DB,
        `UPDATE plan_payments SET used_for_challenge=1 WHERE id=?`,
        [record.id]
    );
    return true;
};

exports.PLAN_PRICES = PLAN_PRICES;
exports.getRazorpay = getRazorpay;
