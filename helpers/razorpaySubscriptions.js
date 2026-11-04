"use strict";
// Real Razorpay UPI Autopay for the 30-day trial — see TrialController.js
// for the endpoints that use this, and the header comment on migration
// 017_razorpay_autopay.sql for why activation only ever happens from the
// webhook, never from the client's own checkout success callback.
const query = require("./query");
const constants = require("../vars/constants");

const DB = constants.vals.defaultDB;

// Built lazily, same reasoning as PaymentController.getRazorpay — must not
// crash the whole process at boot if the env vars aren't set yet.
let _razorpay = null;
function getRazorpay() {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        throw new Error("Razorpay is not configured (missing RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET)");
    }
    if (!_razorpay) {
        const Razorpay = require("razorpay");
        _razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });
    }
    return _razorpay;
}

// Razorpay billing period/interval per plan type, plus a total_count (max
// number of billing cycles it will ever attempt) — all set to roughly 5
// years' worth; the user can cancel anytime before that via
// POST /trial/cancel-autopay or directly in their UPI app.
const PLAN_DEFS = {
    monthly:     { period: "monthly", interval: 1, totalCount: 60 },
    quarterly:   { period: "monthly", interval: 3, totalCount: 20 },
    half_yearly: { period: "monthly", interval: 6, totalCount: 10 },
    yearly:      { period: "yearly",  interval: 1, totalCount: 5 },
};

// forceNew skips the cache read (but still overwrites the cache row after)
// — used by createSubscription below to recover from a stale cached plan
// id that no longer exists on Razorpay's side (e.g. created under the
// other key mode, test vs live, or deleted from the dashboard).
async function getOrCreatePlanId(planType, amountRupees, forceNew = false) {
    const def = PLAN_DEFS[planType];
    if (!def) throw new Error(`Unknown plan type: ${planType}`);

    if (!forceNew) {
        const cached = await query.fetchSingleRecord(
            DB, "razorpay_plan_cache", `WHERE plan_type='${planType}'`
        );
        if (cached && !Array.isArray(cached) && cached.razorpay_plan_id) {
            return cached.razorpay_plan_id;
        }
    }

    const plan = await getRazorpay().plans.create({
        period: def.period,
        interval: def.interval,
        item: {
            name: `Investapas ${planType}`,
            amount: amountRupees * 100,
            currency: "INR",
        },
    });

    // Replaces any existing (stale) row for this plan_type.
    await query.executeQuery(
        DB,
        `INSERT INTO razorpay_plan_cache (plan_type, razorpay_plan_id) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE razorpay_plan_id = VALUES(razorpay_plan_id)`,
        [planType, plan.id]
    );
    return plan.id;
}

function isMissingIdError(error) {
    const desc = error?.error?.description || "";
    return error?.error?.code === "BAD_REQUEST_ERROR" &&
        /invalid or could not be found/i.test(desc);
}

// startAtUnix: Unix seconds for the first attempted charge (trial end + 1
// day) — Razorpay will not attempt to collect anything before this, which
// is what makes the first 30 days genuinely free even though the mandate
// itself is approved today.
async function createSubscription(dhanClientId, planType, amountRupees, startAtUnix) {
    const def = PLAN_DEFS[planType];
    const subParams = (planId) => ({
        plan_id: planId,
        customer_notify: 1,
        total_count: def.totalCount,
        start_at: startAtUnix,
        notes: { dhanClientId, planType },
    });

    let planId = await getOrCreatePlanId(planType, amountRupees);
    try {
        const subscription = await getRazorpay().subscriptions.create(subParams(planId));
        return { planId, subscription };
    } catch (error) {
        // Stale cached plan id (e.g. left over from a different key mode)
        // — recreate the plan fresh and retry exactly once, instead of
        // failing every signup until someone manually clears the cache.
        if (!isMissingIdError(error)) throw error;
        console.log(`[Razorpay] Cached plan id for ${planType} is invalid — recreating`);
        planId = await getOrCreatePlanId(planType, amountRupees, true);
        const subscription = await getRazorpay().subscriptions.create(subParams(planId));
        return { planId, subscription };
    }
}

async function cancelSubscription(subscriptionId) {
    return getRazorpay().subscriptions.cancel(subscriptionId, {
        cancel_at_cycle_end: 0,
    });
}

async function fetchSubscription(subscriptionId) {
    return getRazorpay().subscriptions.fetch(subscriptionId);
}

module.exports = {
    getRazorpay,
    getOrCreatePlanId,
    createSubscription,
    cancelSubscription,
    fetchSubscription,
};
