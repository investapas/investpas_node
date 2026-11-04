"use strict";
// 30-day free trial, with real Razorpay UPI Autopay (migration
// 017_razorpay_autopay.sql). Billing is deferred via Razorpay's
// `start_at` — the mandate is approved today, the first actual charge
// isn't attempted until the day after the trial ends, so the trial itself
// is genuinely free regardless of how fast the user approves.
//
// Activation is never trusted from the app's own checkout success
// callback (see razorpayWebhook below) — only from Razorpay's signed
// server webhook, same rule the PDF spec itself calls out.
const crypto = require("crypto");
const query = require("../helpers/query");
const constants = require("../vars/constants");
const {
    createSubscription,
    cancelSubscription,
    fetchSubscription,
} = require("../helpers/razorpaySubscriptions");

const DB = constants.vals.defaultDB;

// Razorpay's Node SDK rejects with {statusCode, error:{description,...}},
// not a normal Error — error.message was coming back undefined (that's
// what showed up as "[Trial] approveAutopay error: undefined" in the
// logs), hiding the actual reason the subscription/plan call failed.
function razorpayErrorMessage(error) {
    return error?.error?.description || error?.message || String(error);
}

// Server-side price list — mirrors the plan cards in the Flutter wizard
// (lib/presentation/pages/trial/trial_signup_page.dart). Never trust a
// client-sent price for what the mandate is created for.
const TRIAL_PLAN_PRICES = {
    monthly:     1999,
    quarterly:   4999,
    half_yearly: 9999,
    yearly:      14999,
};

// Challenge rules are NOT auto-created with fixed defaults here — the
// user fills in their own trading capital, profit/loss targets, max
// trades and position size themselves, same form every other challenge
// uses. approveAutopay below only starts the trial; the Flutter side
// hands off to the existing manual rules wizard
// (setup_challenge_screen.dart, planType 'trial') right after.

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function toDateOnly(d) {
    return new Date(d).toISOString().slice(0, 10);
}

function toUnixSeconds(d) {
    return Math.floor(new Date(d).getTime() / 1000);
}

// GET /trial/status — the single source of truth the PDF explicitly asks
// for ("Plan ka status ek API se: trial / active / grace / expired"), so
// Profile and Dashboard can never show conflicting trial/plan state.
exports.getStatus = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const trial = await query.fetchSingleRecord(
            DB, "user_trials", `WHERE dhan_client_id='${user.dhanClientId}'`
        );

        if (!trial || Array.isArray(trial)) {
            return res.json({ status: true, data: { planStatus: 'none' } });
        }

        const now = new Date();
        const trialEnds = new Date(trial.trial_ends_at);
        let planStatus;
        if (now < trialEnds) {
            // The trial itself was never gated on Autopay succeeding —
            // only the recurring billing after it is. A user who
            // abandoned the UPI approval mid-checkout (autopay_status
            // stays 'created') still gets their 30 free days; they just
            // won't roll into 'active' once the trial ends unless they
            // completed it (see below).
            planStatus = 'trial';
        } else if (trial.autopay_status === 'approved') {
            planStatus = 'active';
        } else if (trial.autopay_status === 'failed') {
            planStatus = 'grace';
        } else {
            planStatus = 'expired';
        }

        const daysLeft = Math.max(0, Math.ceil((trialEnds - now) / 86400000));

        return res.json({
            status: true,
            data: {
                planStatus,
                planType: trial.plan_type,
                planPriceRupees: trial.plan_price_rupees,
                trialStartedAt: trial.trial_started_at,
                trialEndsAt: trial.trial_ends_at,
                daysLeft,
                firstDebitDate: trial.first_debit_date,
                autopayStatus: trial.autopay_status,
            },
        });
    } catch (error) {
        return res.json({ status: false, message: error.message });
    }
};

// POST /trial/approve-autopay — creates the Razorpay subscription (so the
// app has a subscription_id to open Checkout for) but does NOT write
// anything to user_trials yet. The trial must not appear active just
// because this call succeeded — a user who then cancels/dismisses the UPI
// approval screen never actually committed to anything, and used to still
// see "Free trial · 30 days left" because this endpoint wrote the trial
// row before the user had even seen the checkout. See confirmAutopay
// below, the real commit point now.
// body: { planType, fullName, email, mobile, state }
exports.approveAutopay = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }
        const dhanClientId = user.dhanClientId;

        const existing = await query.fetchSingleRecord(
            DB, "user_trials", `WHERE dhan_client_id='${dhanClientId}'`
        );
        if (existing && !Array.isArray(existing)) {
            return res.json({ status: false, message: "You've already used your free trial on this account." });
        }

        const { planType, fullName, email, mobile, state } = req.body;
        const planPriceRupees = TRIAL_PLAN_PRICES[planType];
        if (!planPriceRupees) {
            return res.json({ status: false, message: "Invalid plan" });
        }

        const now = new Date();
        const trialEndsAt = addDays(now, 30);
        const firstDebitDate = addDays(trialEndsAt, 1);

        const { subscription } = await createSubscription(
            dhanClientId, planType, planPriceRupees, toUnixSeconds(firstDebitDate)
        );

        return res.json({
            status: true,
            message: "Now approve the UPI mandate to activate your trial.",
            data: {
                subscriptionId: subscription.id,
                razorpayKeyId: process.env.RAZORPAY_KEY_ID,
                amount: planPriceRupees * 100,
                planLabel: planType,
                planType,
                planPriceRupees,
                fullName: fullName || null,
                email: email || null,
                mobile: mobile || null,
                state: state || null,
            },
        });
    } catch (error) {
        const message = razorpayErrorMessage(error);
        console.error("[Trial] approveAutopay error:", message, error?.error || error);
        return res.json({ status: false, message });
    }
};

// POST /trial/confirm-autopay — the ONE real commit point. Only reached
// after the user has actually completed the UPI mandate approval in
// Razorpay's checkout (its client-side success callback) — cancelling or
// dismissing that screen never reaches here, so no trial row is ever
// written for an abandoned signup.
//
// The trial's dates are derived from the Razorpay subscription's own
// `start_at` (fetched fresh here, not trusted from the client) rather than
// recomputed from "now" — start_at was fixed the moment the subscription
// was created in approveAutopay above, so this stays consistent with
// whatever Razorpay actually scheduled the first real charge for.
// body: { subscriptionId, razorpayPaymentId, razorpaySignature, planType,
//         fullName, email, mobile, state }
exports.confirmAutopay = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }
        const dhanClientId = user.dhanClientId;

        const existing = await query.fetchSingleRecord(
            DB, "user_trials", `WHERE dhan_client_id='${dhanClientId}'`
        );
        if (existing && !Array.isArray(existing)) {
            return res.json({ status: false, message: "You've already used your free trial on this account." });
        }

        const {
            subscriptionId, razorpayPaymentId, razorpaySignature,
            planType, fullName, email, mobile, state,
        } = req.body;
        if (!subscriptionId || !razorpayPaymentId || !razorpaySignature) {
            return res.json({ status: false, message: "Missing payment confirmation details" });
        }
        const planPriceRupees = TRIAL_PLAN_PRICES[planType];
        if (!planPriceRupees) {
            return res.json({ status: false, message: "Invalid plan" });
        }

        // Razorpay's subscription checkout signs payment_id|subscription_id
        // (the reverse of the order_id|payment_id order the one-time-order
        // flow in PaymentController uses) — accepting either ordering here
        // is just defensive; a forged signature still can't pass either way
        // without the real key secret.
        const secret = process.env.RAZORPAY_KEY_SECRET;
        const sigA = crypto.createHmac("sha256", secret)
            .update(`${razorpayPaymentId}|${subscriptionId}`).digest("hex");
        const sigB = crypto.createHmac("sha256", secret)
            .update(`${subscriptionId}|${razorpayPaymentId}`).digest("hex");
        if (razorpaySignature !== sigA && razorpaySignature !== sigB) {
            console.error(`[Trial] confirmAutopay signature mismatch for ${dhanClientId}`);
            return res.json({ status: false, message: "Payment verification failed" });
        }

        // Authoritative schedule + ownership check — never trust client-
        // supplied dates for something that gates trial/challenge access.
        const subscription = await fetchSubscription(subscriptionId);
        if (subscription?.notes?.dhanClientId !== dhanClientId) {
            console.error(`[Trial] confirmAutopay subscription/user mismatch for ${dhanClientId}`);
            return res.json({ status: false, message: "Subscription does not belong to this account" });
        }
        const firstDebitDate = new Date(subscription.start_at * 1000);
        const trialEndsAt = addDays(firstDebitDate, -1);

        await query.insertSingle(DB, "user_trials", {
            dhan_client_id: dhanClientId,
            plan_type: planType,
            plan_price_rupees: planPriceRupees,
            full_name: fullName || null,
            email: email || null,
            mobile: mobile || null,
            state: state || null,
            trial_started_at: new Date(),
            trial_ends_at: trialEndsAt,
            first_debit_date: toDateOnly(firstDebitDate),
            autopay_status: 'created',
            razorpay_plan_id: subscription.plan_id,
            razorpay_subscription_id: subscriptionId,
        });

        return res.json({
            status: true,
            message: "Trial started. Now set your trading rules.",
            data: {
                trialEndsAt,
                firstDebitDate: toDateOnly(firstDebitDate),
            },
        });
    } catch (error) {
        const message = razorpayErrorMessage(error);
        console.error("[Trial] confirmAutopay error:", message, error?.error || error);
        return res.json({ status: false, message });
    }
};

// POST /trial/cancel-autopay — PDF: "Cancel hone pe trial khatam hone tak
// sab chalta rahe" — does NOT end the trial early, just stops it from
// rolling into 'active' once trial_ends_at passes.
exports.cancelAutopay = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }
        const trial = await query.fetchSingleRecord(
            DB, "user_trials", `WHERE dhan_client_id='${user.dhanClientId}'`
        );
        if (trial && !Array.isArray(trial) && trial.razorpay_subscription_id) {
            try {
                await cancelSubscription(trial.razorpay_subscription_id);
            } catch (e) {
                // Already cancelled/expired on Razorpay's side is fine —
                // still record the user's intent locally either way.
                console.log("[Trial] cancelSubscription warning:", razorpayErrorMessage(e));
            }
        }
        await query.updateRecord(
            DB, "user_trials", `dhan_client_id='${user.dhanClientId}'`,
            `autopay_status='cancelled', cancelled_at=NOW()`
        );
        return res.json({ status: true, message: "Autopay cancelled. Your trial stays active until it ends." });
    } catch (error) {
        return res.json({ status: false, message: error.message });
    }
};

// POST /trial/razorpay-webhook — the ONLY thing allowed to flip
// autopay_status to 'approved'. No auth middleware (Razorpay calls this
// directly, not a logged-in user) — authenticity instead comes from the
// HMAC-SHA256 signature in the X-Razorpay-Signature header, computed over
// the exact raw body using RAZORPAY_WEBHOOK_SECRET (set this same secret
// when configuring the webhook URL in the Razorpay dashboard).
exports.razorpayWebhook = async (req, res) => {
    try {
        const signature = req.headers["x-razorpay-signature"];
        const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!secret) {
            console.error("[Trial] RAZORPAY_WEBHOOK_SECRET not configured — rejecting webhook");
            return res.status(500).json({ status: false });
        }
        if (!signature || !req.rawBody) {
            return res.status(400).json({ status: false });
        }

        const expected = crypto
            .createHmac("sha256", secret)
            .update(req.rawBody)
            .digest("hex");

        // Timing-safe compare — both buffers must be equal length first,
        // crypto.timingSafeEqual throws otherwise.
        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
            console.error("[Trial] Webhook signature mismatch");
            return res.status(400).json({ status: false });
        }

        const event = req.body.event;
        const subscriptionEntity = req.body.payload?.subscription?.entity;
        const subscriptionId = subscriptionEntity?.id;

        if (!subscriptionId) {
            // Not a subscription event we care about (could be a payment/
            // order webhook from the separate one-time-payment flow) —
            // acknowledge so Razorpay doesn't keep retrying it.
            return res.json({ status: true });
        }

        console.log(`[Trial] Webhook ${event} for subscription ${subscriptionId}`);

        if (event === "subscription.authenticated") {
            // The UPI mandate itself is approved — this is the trigger
            // the PDF spec means by "gateway ke server webhook pe active
            // ho". The actual first charge still won't happen until
            // start_at (day after trial end).
            await query.updateRecord(
                DB, "user_trials", `razorpay_subscription_id='${subscriptionId}'`,
                `autopay_status='approved'`
            );
        } else if (event === "subscription.cancelled" || event === "subscription.completed") {
            await query.updateRecord(
                DB, "user_trials", `razorpay_subscription_id='${subscriptionId}'`,
                `autopay_status='cancelled', cancelled_at=NOW()`
            );
        } else if (event === "subscription.halted") {
            // Razorpay gives up retrying after repeated charge failures —
            // this is the "payment failed, grace period" state from the
            // PDF's Home-screen Change 5·B.
            await query.updateRecord(
                DB, "user_trials", `razorpay_subscription_id='${subscriptionId}'`,
                `autopay_status='failed'`
            );
        }

        return res.json({ status: true });
    } catch (error) {
        console.error("[Trial] webhook error:", error.message);
        // Still 200 — a 5xx makes Razorpay retry indefinitely for an
        // error that's almost certainly not transient (e.g. a bad
        // payload shape), and we've already logged it above for someone
        // to investigate.
        return res.json({ status: false, message: error.message });
    }
};
