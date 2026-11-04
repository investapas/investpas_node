const query = require("../helpers/query");
const constants = require("../vars/constants");
const utility = require("../helpers/utility");
const advChallenge = require("../helpers/advanceChallengeEngine");
const { addTradingDays } = require("../helpers/nseHolidays");
const { consumeVerifiedPayment } = require("./PaymentController");
const dhanUsage = require("../helpers/dhanUsage");

// challengeDays -> the paid plan type that must have a verified payment.
// Fallback only — used when an older app build doesn't send planType.
// The trial now also runs 30 trading days (same as Monthly), so day count
// alone can no longer tell them apart; planType is the real signal.
const PAID_PLAN_BY_DAYS = { 5: "firstWeek", 30: "monthly" };

// Core challenge-creation logic, shared by the existing POST /challenge/create
// handler (exports.createChallenge below, request-shaped input) and
// TrialController's Universal Challenge auto-activation (exports.createChallengeForUser,
// plain-object input — no req/res, no payment-verification step since the
// free trial already skips that same check below via planType==='trial').
exports.createChallengeForUser = async (dhanClientId, params) => {
    const {
        tradingCapital,
        minProfit,
        maxProfit,
        minLoss,
        maxLoss,
        maxTradesPerDay,
        cooldownMinutes,
        consecutiveLossLimit,
        maxCapitalPerTradePct,
        riskPerTradePct,
        targetPerTradePct,
        heroTradeAllowed,
        niftyLots,
        bankNiftyLots,
        finNiftyLots,
        midcapNiftyLots,
        sensexLots,
        challengeDays,
        planType,
        razorpayOrderId
    } = params;

    // Paid plans (First Week / Monthly) need a verified, unused payment
        // for THIS order before the challenge is allowed to start — the
        // free trial skips this check. Prefer the explicit planType the app
        // sends; PAID_PLAN_BY_DAYS is only a fallback for older app builds
        // that predate this field, back when day count alone was enough to
        // tell trial and paid plans apart.
        const requiredPlan = planType
            ? (planType !== 'trial' ? planType : null)
            : PAID_PLAN_BY_DAYS[challengeDays];
        if (requiredPlan) {
            if (!razorpayOrderId) {
                return { status: false, message: "Payment required for this plan" };
            }
            const paid = await consumeVerifiedPayment(dhanClientId, razorpayOrderId, requiredPlan);
            if (!paid) {
                return { status: false, message: "Payment not verified for this plan" };
            }
        }

        // plan_type lets getCurrentChallenge/history tell a 30-day trial
        // apart from a 30-day Monthly plan now that they share a day count.
        // Idempotent — cheap no-op after the first successful run.
        try {
            const dbcon = require('../config/mysqlClient');
            await dbcon.query(
                constants.vals.defaultDB,
                `ALTER TABLE user_challenges ADD COLUMN plan_type VARCHAR(20) DEFAULT NULL AFTER challenge_days`
            );
        } catch (_) {}

        // Trading style temporarily fixed to SCALPER (selector removed from UI)
        const style = 'SCALPER';
        const styleDefaults = advChallenge.getStyleDefaults(style);

        // 🔍 check existing challenge
        const existing = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );

        // ── Step 1: Close existing active challenge if any ────────────────
        if (existing && !Array.isArray(existing) && existing.id) {
            const pnlData = await query.fetchSingleRecord(
                constants.vals.defaultDB, 'challenge_trade_logs',
                `WHERE challenge_id=${existing.id}`,
                'SUM(pnl) as total_pnl, COUNT(*) as total_trades'
            );
            const finalPnl    = Number(pnlData?.total_pnl || 0);
            const totalTrades = Number(pnlData?.total_trades || 0);
            // COMPLETED if its own duration had already run out, ABANDONED
            // if the user is switching away from a still-running one.
            const alreadyEnded = existing.challenge_end_date &&
                new Date(existing.challenge_end_date) < new Date();
            const closeStatus = alreadyEnded ? 'COMPLETED' : 'ABANDONED';

            await query.updateRecord(
                constants.vals.defaultDB, 'user_challenges', `id=${existing.id}`,
                `is_active=0, status='${closeStatus}', completed_at=NOW(), final_pnl=${finalPnl}, total_trades_count=${totalTrades}, updated_at=NOW()`
            );

            console.log(`[Challenge] Closed existing challenge id=${existing.id} (${closeStatus}) for ${dhanClientId}`);
        }

        // ── Clear all active pause/cooldown blocks so new challenge starts fresh
        const dbcon = require('../config/mysqlClient');
        await dbcon.query(
            constants.vals.defaultDB,
            `UPDATE challenge_pause_logs SET pause_end = NOW()
             WHERE dhan_client_id = ? AND pause_end > NOW()`,
            [dhanClientId]
        );
        console.log(`[Challenge] Cleared active pause logs for ${dhanClientId}`);

        // ── Step 2: Always create new challenge ───────────────────────────
        const insertRes = await query.insertSingle(
            constants.vals.defaultDB,
            "user_challenges",
            {
                dhan_client_id: dhanClientId,
                trading_style: style,
                trading_capital: tradingCapital,
                min_profit: minProfit,
                max_profit: maxProfit,
                min_loss: minLoss,
                max_loss: maxLoss,
                max_trades_per_day: maxTradesPerDay || styleDefaults.max_trades_per_day,
                cooldown_minutes: cooldownMinutes ?? styleDefaults.cooldown_minutes,
                consecutive_loss_limit: consecutiveLossLimit ?? styleDefaults.consecutive_loss_limit,
                max_capital_per_trade_pct: maxCapitalPerTradePct ?? styleDefaults.max_capital_per_trade_pct,
                risk_per_trade_pct: riskPerTradePct ?? styleDefaults.risk_per_trade_pct,
                target_per_trade_pct: targetPerTradePct ?? styleDefaults.target_per_trade_pct,
                hero_trade_allowed: heroTradeAllowed ?? styleDefaults.hero_trade_allowed,
                nifty_lots: niftyLots,
                banknifty_lots: bankNiftyLots,
                finnifty_lots: finNiftyLots,
                midcapnifty_lots: midcapNiftyLots,
                sensex_lots: sensexLots,
                challenge_days: challengeDays,
                plan_type: planType || null,
                challenge_start_date: new Date(),
                // Trading days, not calendar days — a challenge starting on
                // a Thursday shouldn't lose its Sat/Sun/holiday sessions.
                challenge_end_date: addTradingDays(new Date(), challengeDays),
                is_active: 1,
                status: 'ACTIVE'
            }
        );

        if (!insertRes) {
            return { status: false, message: "Failed to create new challenge" };
        }

        console.log(`[Challenge] New challenge created id=${insertRes} for ${dhanClientId}`);

        return {
            status: true,
            message: "Challenge created successfully",
            data: { challengeId: insertRes }
        };
};

// Thin wrapper — existing POST /challenge/create route, unchanged request
// shape (req.body.inputdata) and response shape, just delegates the actual
// work to createChallengeForUser above.
exports.createChallenge = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }
        const result = await exports.createChallengeForUser(user.dhanClientId, req.body.inputdata);
        return res.json(result);
    } catch (error) {
        res.json({
            status: false,
            message: error.message
        });
    }
};


exports.completeChallenge = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) return res.json({ status: false, message: "Auth required" });

        const dhanClientId = user.dhanClientId;

        const challenge = await query.fetchSingleRecord(
            constants.vals.defaultDB, 'user_challenges',
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );

        if (!challenge || Array.isArray(challenge) || !challenge.id) {
            return res.json({ status: false, message: "No active challenge found" });
        }

        // Calculate final PnL and trade count
        const pnlData = await query.fetchSingleRecord(
            constants.vals.defaultDB, 'challenge_trade_logs',
            `WHERE challenge_id=${challenge.id}`, 'SUM(pnl) as total_pnl, COUNT(*) as total_trades'
        );

        const finalPnl    = Number(pnlData?.total_pnl || 0);
        const totalTrades = Number(pnlData?.total_trades || 0);
        const passed      = finalPnl >= challenge.min_profit ? 1 : 0;

        await query.updateRecord(
            constants.vals.defaultDB, 'user_challenges',
            `id=${challenge.id}`,
            `is_active=0, status='COMPLETED', completed_at=NOW(), final_pnl=${finalPnl}, total_trades_count=${totalTrades}, updated_at=NOW()`
        );

        return res.json({
            status: true,
            message: "Challenge completed",
            data: { finalPnl, totalTrades, passed: !!passed }
        });

    } catch (e) {
        return res.json({ status: false, message: e.message });
    }
};

// GET CHALLENGE HISTORY — all past challenges for this user
exports.getChallengeHistory = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) return res.json({ status: false, message: "Auth required" });

        const dhanClientId = user.dhanClientId;

        const challenges = await query.fetchRecords(
            constants.vals.defaultDB, 'user_challenges',
            `WHERE dhan_client_id='${dhanClientId}' ORDER BY created_at DESC`
        );

        const formatted = (challenges || []).map(c => ({
            id:               c.id,
            tradingStyle:     c.trading_style || 'SCALPER',
            tradingCapital:   c.trading_capital,
            minProfit:        c.min_profit,
            maxProfit:        c.max_profit,
            minLoss:          c.min_loss,
            maxLoss:          c.max_loss,
            maxTradesPerDay:  c.max_trades_per_day,
            cooldownMinutes:  c.cooldown_minutes || 0,
            consecutiveLossLimit: c.consecutive_loss_limit || 3,
            maxCapitalPerTradePct: c.max_capital_per_trade_pct || 25,
            heroTradeAllowed: c.hero_trade_allowed || 0,
            challengeDays:    c.challenge_days,
            startDate:        c.challenge_start_date,
            endDate:          c.challenge_end_date,
            completedAt:      c.completed_at,
            isActive:         !!c.is_active,
            status:           c.status || (c.is_active ? 'ACTIVE' : 'COMPLETED'),
            finalPnl:         Number(c.final_pnl || 0),
            totalTrades:      Number(c.total_trades_count || 0),
            createdAt:        c.created_at,
        }));

        return res.json({ status: true, count: formatted.length, data: formatted });

    } catch (e) {
        return res.json({ status: false, message: e.message });
    }
};

// GET CURRENT CHALLENGE
exports.getCurrentChallenge = async (req, res) => {

    try {

        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({
                status: false,
                message: "User authentication required"
            });
        }

        const dhanClientId = user.dhanClientId;
        const result = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );

        // Read-only "has this challenge's duration passed?" check (PDF
        // Change 5·A — Home's "challenge ended" result card). Deliberately
        // does NOT call completeChallenge / flip is_active here: per the
        // PDF, old rules must keep protecting every order until the user
        // explicitly sets up a new challenge — createChallenge already
        // closes this row out (status ABANDONED→ here would be more
        // accurately COMPLETED, see below) the moment that happens. Until
        // then this stays is_active=1 so the order-rule engine keeps using
        // it unchanged.
        let isEnded = false;
        let endedSummary = null;
        if (result && !Array.isArray(result) && result.id &&
            result.challenge_end_date && new Date(result.challenge_end_date) < new Date()) {
            isEnded = true;
            const pnlData = await query.fetchSingleRecord(
                constants.vals.defaultDB, 'challenge_trade_logs',
                `WHERE challenge_id=${result.id}`,
                'SUM(pnl) as total_pnl, COUNT(*) as total_trades'
            );
            const finalPnl    = Number(pnlData?.total_pnl || 0);
            const totalTrades = Number(pnlData?.total_trades || 0);
            const maxLossRows = await query.fetchRecords(
                constants.vals.defaultDB, 'challenge_trade_logs',
                `WHERE challenge_id=${result.id}
                 GROUP BY DATE(created_at)
                 HAVING SUM(pnl) <= -${Number(result.max_loss) || 0}`
            ) || [];
            endedSummary = {
                finalPnl,
                totalTrades,
                passed: finalPnl >= Number(result.min_profit || 0),
                maxLossDays: maxLossRows.length,
            };
        }

        res.json({
            status: true,
            data: result || null,
            isEnded,
            endedSummary,
        });
    } catch (error) {
        res.json({
            status: false,
            message: error.message
        });
    }
};

// CHECK ORDER RULES
// exports.checkOrderRules = async (req, res) => {

//     try {
//         const user = req.user;
//         if (!user || !user.dhanClientId) {
//             return res.json({
//                 status: false,
//                 message: "User authentication required"
//             });
//         }

//         const dhanClientId = user.dhanClientId;
//         let { index, quantity } = req.body;

//         index = index?.toUpperCase();

//         // cooldown check
//         const cooldown = await query.fetchRecords(
//             constants.vals.defaultDB,
//             "challenge_pause_logs",
//             `WHERE dhan_client_id='${dhanClientId}' AND pause_end > NOW() ORDER BY id DESC LIMIT 1`
//         );

//         if (cooldown.length) {
//             return res.json({
//                 allowed: false,
//                 rule: "COOLDOWN_ACTIVE",
//                 pause_end: cooldown[0].pause_end
//             });
//         }

//         // challenge
//         const rules = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "user_challenges",
//             `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
//         );

//         if (!rules) return res.json({ allowed: true });

//         // pnl
//         const pnlData = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "challenge_trade_logs",
//             `WHERE dhan_client_id='${dhanClientId}' AND trade_date=CURDATE()`,
//             "SUM(pnl) as total"
//         );

//         const todayPnL = pnlData?.total || 0;

//         if (todayPnL <= -rules.max_loss) {
//             await exports.triggerCooldown(dhanClientId, rules.id, "DAILY_LOSS_LIMIT");
//             return res.json({ allowed: false, rule: "DAILY_LOSS_LIMIT" });
//         }

//         if (todayPnL >= rules.max_profit) {
//             await exports.triggerCooldown(dhanClientId, rules.id, "DAILY_PROFIT_TARGET");
//             return res.json({ allowed: false, rule: "DAILY_PROFIT_TARGET" });
//         }

//         // trades
//         const tradeCount = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "challenge_trade_logs",
//             `WHERE dhan_client_id='${dhanClientId}' AND trade_date=CURDATE()`,
//             "COUNT(*) as total"
//         );

//         if ((tradeCount?.total || 0) >= rules.max_trades_per_day) {
//             await exports.triggerCooldown(dhanClientId, rules.id, "MAX_TRADES_LIMIT");
//             return res.json({ allowed: false, rule: "MAX_TRADES_LIMIT" });
//         }

//         // quantity
//         let allowedQty = {
//             NIFTY: rules.nifty_lots,
//             BANKNIFTY: rules.banknifty_lots,
//             FINNIFTY: rules.finnifty_lots,
//             MIDCAPNIFTY: rules.midcapnifty_lots,
//             SENSEX: rules.sensex_lots
//         }[index] || 0;

//         if (quantity > allowedQty) {
//             return res.json({
//                 allowed: false,
//                 rule: "QUANTITY_RULE",
//                 message: `Allowed ${allowedQty}`
//             });
//         }

//         res.json({ allowed: true });

//     } catch (error) {
//         console.log(error);
//         res.json({ allowed: false, message: error.message });
//     }
// };

// exports.logTrade = async (req, res) => {

//     try {
//         const user = req.user;
//         if (!user || !user.dhanClientId) {
//             return res.json({
//                 status: false,
//                 message: "User authentication required"
//             });
//         }

//         const dhanClientId = user.dhanClientId;
//         const { index, quantity, pnl } = req.body;

//         const challenge = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "user_challenges",
//             `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
//         );

//         await query.insertSingle(
//             constants.vals.defaultDB,
//             "challenge_trade_logs",
//             {
//                 dhan_client_id: dhanClientId,
//                 challenge_id: challenge?.id || null,
//                 index_name: index,
//                 quantity,
//                 pnl,
//                 trade_date: new Date()
//             }
//         );

//         res.json({
//             status: true,
//             message: "Trade logged successfully"
//         });

//     } catch (error) {
//         console.log(error);
//         res.json({ status: false, message: error.message });
//     }
// };

// exports.checkCooldown = async (req, res) => {

//     try {
//         const user = req.user;
//         const pause = await query.fetchRecords(
//             constants.vals.defaultDB,
//             "challenge_pause_logs",
//             `WHERE dhan_client_id='${user.dhanClientId}' AND pause_end > NOW() ORDER BY id DESC LIMIT 1`
//         );

//         if (pause.length) {
//             return res.json({
//                 allowed: false,
//                 pause_end: pause[0].pause_end
//             });
//         }

//         res.json({ allowed: true });

//     } catch (error) {
//         res.json({ allowed: false, message: error.message });
//     }
// };

// exports.triggerCooldown = async (dhanClientId, challengeId, rule) => {
//     try {
//         await query.insertSingle(
//             constants.vals.defaultDB,
//             "challenge_pause_logs",
//             {
//                 dhan_client_id: dhanClientId,
//                 challenge_id: challengeId,
//                 rule_triggered: rule,
//                 pause_start: new Date(),
//                 pause_end: new Date(Date.now() + 30 * 60 * 1000)
//             }
//         );

//     } catch (error) {
//         console.log(error);
//     }
// };

// exports.quickUnlock = async (req, res) => {

//     try {
//         const user = req.user;
//         const pause = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "challenge_pause_logs",
//             `WHERE dhan_client_id='${user.dhanClientId}' AND pause_end > NOW() ORDER BY id DESC`
//         );

//         if (!pause || !pause.id) {
//             return res.json({
//                 status: false,
//                 message: "No active cooldown"
//             });
//         }

//         await query.updateRecord(
//             constants.vals.defaultDB,
//             "challenge_pause_logs",
//             `id=${pause.id}`,
//             `
//             pause_end=NOW(),
//             quick_unlock_used=1,
//             updated_at=NOW()
//             `
//         );

//         res.json({
//             status: true,
//             message: "Trading resumed"
//         });

//     } catch (error) {
//         res.json({ status: false, message: error.message });
//     }
// };



// CHECK ORDER RULES
exports.checkOrderRules = async (req, res) => {

    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({
                status: false,
                message: "User authentication required"
            });
        }

        const dhanClientId = user.dhanClientId;
        let { index, quantity, lots, mode, transactionType } = req.body;

        index = index?.toUpperCase();
        mode  = (mode || 'REAL').toUpperCase();
        // SELL closes/reduces a position, it never opens new exposure — the
        // PnL / trade-count / lot-limit rules below (and the cooldown block
        // check right after this) exist to stop someone from taking on MORE
        // risk, not from getting out. Without this, a user who hits any
        // limit becomes unable to close the very position that triggered
        // it — permanently stuck until the block clears on its own.
        const isSell = (transactionType || '').toUpperCase() === 'SELL';

        // ── 1. Get current active challenge FIRST ─────────────────────────
        const rules = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );

        if (!rules) return res.json({ status: true, allowed: true });

        // ── 2. Block check — scoped to CURRENT challenge only ──────────────
        // Prevents old challenge's blocks from affecting the new challenge
        const cooldown = await query.fetchRecords(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            `WHERE dhan_client_id='${dhanClientId}' AND challenge_id=${rules.id} AND pause_end > NOW() ORDER BY id DESC LIMIT 1`
        );

        if (cooldown.length && !isSell) {
            return res.json({
                allowed: false,
                rule: cooldown[0].rule_triggered,
                message: "Challenge completed. Use Quick Unlock to trade again.",
                pause_end: cooldown[0].pause_end
            });
        }

        // ── 3. Find last quick unlock time today (session start) ───────────
        // After a quick unlock, PnL and trade count reset for the new session
        const lastUnlock = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            `WHERE dhan_client_id='${dhanClientId}' AND quick_unlock_used=1 AND DATE(pause_end)=CURDATE() ORDER BY id DESC LIMIT 1`
        );

        const sessionStart = (lastUnlock && !Array.isArray(lastUnlock))
            ? lastUnlock.pause_end
            : null;

        // DEMO trades never land in challenge_trade_logs — demo activity
        // lives in demo_orders instead, one row per BUY/SELL leg (not one
        // row per round-trip like challenge_trade_logs — a completed trade
        // is a TRADED 'SELL' row, which also carries the realized pnl).
        //
        // REAL trades also never land in challenge_trade_logs (nothing logs
        // to it — that table is effectively unused), so real-mode usage is
        // computed live from Dhan's own trade/position APIs via
        // helpers/dhanUsage.js instead of a local table.
        const isDemo = mode === 'DEMO';
        const demoFilter = sessionStart
            ? `WHERE dhan_client_id='${dhanClientId}' AND order_status='TRADED' AND created_at > '${sessionStart}'`
            : `WHERE dhan_client_id='${dhanClientId}' AND order_status='TRADED' AND DATE(created_at)=CURDATE()`;

        // ── 4. PnL + trade count — ACTIVE ───────────────────────────────────
        let sessionPnL = 0;
        let tradesUsed = 0;
        if (isDemo) {
            const pnlData = await query.fetchSingleRecord(
                constants.vals.defaultDB,
                "demo_orders",
                demoFilter,
                "SUM(pnl) as session_pnl"
            );
            sessionPnL = Number(pnlData?.session_pnl || 0);

            const tradeCount = await query.fetchSingleRecord(
                constants.vals.defaultDB,
                "demo_orders",
                `${demoFilter} AND transaction_type='SELL'`,
                "COUNT(*) as total"
            );
            tradesUsed = tradeCount?.total || 0;
        } else {
            const live = await dhanUsage.getLiveTradesAndPnL(dhanClientId, sessionStart);
            sessionPnL = live.sessionPnL;
            tradesUsed = live.tradesUsed;
        }

        // ── Accumulate ALL check results instead of returning on the first
        // failure — lets the client show a real multi-item checklist (which
        // rules passed vs failed) instead of only "the first reason it would
        // block." `allowed`/`rule`/`message` below still reflect the FIRST
        // failing rule, unchanged, so existing callers (BuyBloc/SellBloc)
        // that only read those three fields keep working exactly as before.
        const checks = [];
        let allowed = true;
        let firstFailRule = null;
        let firstFailMessage = null;
        let cooldownTriggered = false; // fire triggerCooldown at most once per request

        const failFirst = (rule, message) => {
            if (allowed) {
                allowed = false;
                firstFailRule = rule;
                firstFailMessage = message;
            }
        };
        const triggerCooldownOnce = async (rule) => {
            if (cooldownTriggered) return;
            cooldownTriggered = true;
            await exports.triggerCooldown(dhanClientId, rules.id, rule);
        };

        // ── 4. PnL check — ACTIVE ──────────────────────────────────────────
        let pnlPassed = true;
        const pnlSign = sessionPnL >= 0 ? '+' : '-';
        let pnlMessage = `Risk within daily limit · ${pnlSign}₹${Math.abs(sessionPnL).toFixed(2)} today`;
        if (rules.max_loss > 0 && sessionPnL <= -rules.max_loss) {
            pnlPassed = false;
            pnlMessage = `⛔ Daily loss limit of ₹${rules.max_loss} reached. Use Quick Unlock to continue trading.`;
            if (!isSell) {
                await triggerCooldownOnce("DAILY_LOSS_LIMIT");
                failFirst("DAILY_LOSS_LIMIT", pnlMessage);
            }
        } else if (rules.max_profit > 0 && sessionPnL >= rules.max_profit) {
            pnlPassed = false;
            pnlMessage = `🎯 Daily profit target of ₹${rules.max_profit} reached! Use Quick Unlock to continue trading.`;
            if (!isSell) {
                await triggerCooldownOnce("DAILY_PROFIT_TARGET");
                failFirst("DAILY_PROFIT_TARGET", pnlMessage);
            }
        }
        checks.push({ key: "DAILY_PNL", label: "Risk within daily limit", passed: pnlPassed, message: pnlMessage });

        // ── 5. Max trades per day — ACTIVE ────────────────────────────────
        const tradeCountPassed = tradesUsed < rules.max_trades_per_day;
        const tradeCountMessage = tradeCountPassed
            ? `Trade count available · ${tradesUsed} of ${rules.max_trades_per_day}`
            : "📊 Max trades reached. Use Quick Unlock to continue trading.";
        if (!tradeCountPassed && !isSell) {
            await triggerCooldownOnce("MAX_TRADES_LIMIT");
            failFirst("MAX_TRADES_LIMIT", tradeCountMessage);
        }
        checks.push({ key: "MAX_TRADES_LIMIT", label: "Trade count available", passed: tradeCountPassed, message: tradeCountMessage });

        // ── 6. Lot limit per index — CUMULATIVE open-position check ──────────
        // Blocks if (currently open lots) + (lots being requested) > limit.
        // Example: limit=2, already open=1, requesting=2 → 1+2=3 > 2 → blocked
        //          limit=2, already open=1, requesting=1 → 1+1=2 ≤ 2 → allowed
        const lotLimits = {
            'NIFTY':       rules.nifty_lots       || 0,
            'BANKNIFTY':   rules.banknifty_lots    || 0,
            'FINNIFTY':    rules.finnifty_lots     || 0,
            'MIDCAPNIFTY': rules.midcapnifty_lots  || 0,
            'SENSEX':      rules.sensex_lots        || 0,
        };
        const allowedLots    = lotLimits[index] || 0;
        const lotsRequested  = Number(lots) || Number(quantity) || 0;
        const rawQty         = Number(quantity) || 0;

        // Derive lot size from this request (quantity ÷ lots)
        const lotSize = lotsRequested > 0 ? Math.round(rawQty / lotsRequested) : 1;

        console.log(`[Challenge] Check — ${dhanClientId} mode=${mode} index=${index} lots=${lotsRequested} lotSize=${lotSize} allowedLots=${allowedLots} trades=${tradesUsed}/${rules.max_trades_per_day}`);

        let quantityPassed = true;
        let quantityMessage = "Position size within limit.";

        // Skipped for SELL — this math (currentOpenLots + lotsRequested)
        // only makes sense for a BUY adding to exposure. For a SELL it
        // would nonsensically block closing a position that's already at
        // or over the limit (open=2, limit=2, selling 1 to reduce it:
        // 2+1=3>2 → falsely blocked) — the opposite of its intent.
        if (!isSell && allowedLots > 0 && lotsRequested > 0 && index) {

            // Build trading-symbol LIKE pattern for this index
            // Order of checks matters: longer names first to avoid NIFTY matching BANKNIFTY
            let symbolPattern;
            if (index === 'BANKNIFTY') {
                symbolPattern = `trading_symbol LIKE 'BANKNIFTY%'`;
            } else if (index === 'FINNIFTY') {
                symbolPattern = `trading_symbol LIKE 'FINNIFTY%'`;
            } else if (index === 'MIDCAPNIFTY') {
                symbolPattern = `trading_symbol LIKE 'MIDCAPNIFTY%'`;
            } else if (index === 'SENSEX') {
                symbolPattern = `(trading_symbol LIKE 'SENSEX%' OR trading_symbol LIKE 'BANKEX%')`;
            } else if (index === 'NIFTY') {
                symbolPattern = `(trading_symbol LIKE 'NIFTY%' AND trading_symbol NOT LIKE 'BANKNIFTY%' AND trading_symbol NOT LIKE 'FINNIFTY%' AND trading_symbol NOT LIKE 'MIDCAPNIFTY%')`;
            }

            let currentOpenLots = 0;

            // Wrapped in its own try/catch — e.g. demo_orders not existing
            // yet for a brand-new demo account — so a failure here degrades
            // to "no open position counted" instead of throwing and
            // dropping the WHOLE checks array (which was silently hiding
            // the rule-check card in demo mode: the outer catch at the
            // bottom of this function has no checks to return on error).
            try {
                if (mode === 'DEMO') {
                    if (symbolPattern) {
                        // Demo mode: count net open quantity from demo_orders (BUY - SELL, today)
                        const openRows = await query.fetchSingleRecord(
                            constants.vals.defaultDB,
                            'demo_orders',
                            `WHERE dhan_client_id='${dhanClientId}'
                             AND order_status='TRADED'
                             AND DATE(created_at)=CURDATE()
                             AND ${symbolPattern}`,
                            `COALESCE(SUM(CASE WHEN transaction_type='BUY' THEN quantity ELSE -quantity END), 0) AS net_qty`
                        );
                        const currentOpenQty = Math.max(0, Number(openRows?.net_qty || 0));
                        currentOpenLots = lotSize > 0 ? Math.round(currentOpenQty / lotSize) : 0;
                    }
                } else {
                    // Real mode: read Dhan's own live positions (no local
                    // table for real trades) — already returns lots.
                    currentOpenLots = await dhanUsage.getLiveOpenLots(dhanClientId, index);
                }
            } catch (openQtyError) {
                console.log(`[Challenge] open-qty lookup failed (mode=${mode}), defaulting to 0:`, openQtyError.message);
                currentOpenLots = 0;
            }
            const totalLotsAfterBuy = currentOpenLots + lotsRequested;
            const remainingLots     = allowedLots - currentOpenLots;

            console.log(`[Challenge] Lot check — open=${currentOpenLots} requesting=${lotsRequested} allowed=${allowedLots} total=${totalLotsAfterBuy}`);

            if (totalLotsAfterBuy > allowedLots) {
                quantityPassed = false;
                if (currentOpenLots >= allowedLots) {
                    quantityMessage = `You have reached your ${index} lot limit of ${allowedLots} lot${allowedLots !== 1 ? 's' : ''}. Please close existing positions before buying more.`;
                } else {
                    quantityMessage = `${index} limit is ${allowedLots} lot${allowedLots !== 1 ? 's' : ''}. You already have ${currentOpenLots} lot${currentOpenLots !== 1 ? 's' : ''} open — only ${remainingLots} more lot${remainingLots !== 1 ? 's' : ''} available.`;
                }
                failFirst("QUANTITY_RULE", quantityMessage);
            } else {
                quantityMessage = `Position size within limit · ${totalLotsAfterBuy} of ${allowedLots} lot${allowedLots !== 1 ? 's' : ''}`;
            }
        }
        checks.push({ key: "QUANTITY_RULE", label: "Position size within limit", passed: quantityPassed, message: quantityMessage });

        // ── 7. Stop loss required — style-dependent, BUY only ──────────────
        // Never blocks SELL/exit (same reasoning as the lot-limit check above
        // — exiting a position should never be blocked by a risk rule).
        const styleDefaults = advChallenge.getStyleDefaults((rules.trading_style || '').toUpperCase());
        const slRequired = !!styleDefaults.stop_loss_required;
        const stopLossPrice = Number(req.body.stopLossPrice) || 0;
        let slPassed = true;
        let slMessage = "Stop loss required";
        if (slRequired) {
            slPassed = isSell || stopLossPrice > 0;
            slMessage = slPassed
                ? `Stop loss set · ₹${stopLossPrice.toFixed(2)}`
                : "🛡️ Add a stop loss before placing this order.";
            if (!slPassed) failFirst("STOP_LOSS_REQUIRED", slMessage);
            checks.push({ key: "STOP_LOSS_REQUIRED", label: "Stop loss required", passed: slPassed, message: slMessage });
        }

        return res.json({
            status: true,
            allowed,
            rule: firstFailRule,
            message: firstFailMessage,
            sessionPnL,
            checks,
            // Structured fields for the "Your rules" summary line — avoids
            // the client parsing numbers back out of check messages.
            tradingStyle: (rules.trading_style || '').toUpperCase(),
            tradesUsed,
            maxTradesPerDay: rules.max_trades_per_day,
            maxLotsForIndex: allowedLots,
            stopLossRequired: slRequired,
        });

    } catch (error) {
        // Distinct from the "no active challenge" case above (also no
        // `checks`) — status:false here is what tells the client this was
        // a real failure worth retrying, not a legitimate "nothing to
        // check" response. Without this they were indistinguishable, so
        // an unexpected error here silently looked like a clean pass.
        console.log(error);
        res.json({ status: false, allowed: false, message: error.message });
    }
};

// ── GET /challenge/usage?mode=LIVE|DEMO ─────────────────────────────────
// Single source of truth for "what has this user used today in this mode" —
// same trade/PnL/lots computation checkOrderRules uses, exposed standalone
// so any screen (mode strip, dashboard summary, etc.) can query it without
// duplicating the counters.
exports.getUsage = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }
        const dhanClientId = user.dhanClientId;
        const mode = (req.query.mode || 'REAL').toUpperCase();
        const isDemo = mode === 'DEMO';

        const rules = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );
        if (!rules) {
            return res.json({ status: true, data: null, message: "No active challenge" });
        }

        const lastUnlock = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            `WHERE dhan_client_id='${dhanClientId}' AND quick_unlock_used=1 AND DATE(pause_end)=CURDATE() ORDER BY id DESC LIMIT 1`
        );
        const sessionStart = (lastUnlock && !Array.isArray(lastUnlock)) ? lastUnlock.pause_end : null;

        let tradesUsed = 0;
        let sessionPnL = 0;
        if (isDemo) {
            const demoFilter = sessionStart
                ? `WHERE dhan_client_id='${dhanClientId}' AND order_status='TRADED' AND created_at > '${sessionStart}'`
                : `WHERE dhan_client_id='${dhanClientId}' AND order_status='TRADED' AND DATE(created_at)=CURDATE()`;
            const pnlData = await query.fetchSingleRecord(
                constants.vals.defaultDB, "demo_orders", demoFilter, "SUM(pnl) as session_pnl"
            );
            sessionPnL = Number(pnlData?.session_pnl || 0);
            const tradeCount = await query.fetchSingleRecord(
                constants.vals.defaultDB, "demo_orders", `${demoFilter} AND transaction_type='SELL'`, "COUNT(*) as total"
            );
            tradesUsed = tradeCount?.total || 0;
        } else {
            const live = await dhanUsage.getLiveTradesAndPnL(dhanClientId, sessionStart);
            sessionPnL = live.sessionPnL;
            tradesUsed = live.tradesUsed;
        }

        const lotLimits = {
            NIFTY: rules.nifty_lots || 0,
            BANKNIFTY: rules.banknifty_lots || 0,
            FINNIFTY: rules.finnifty_lots || 0,
            MIDCAPNIFTY: rules.midcapnifty_lots || 0,
            SENSEX: rules.sensex_lots || 0,
        };
        const symbolPatterns = {
            BANKNIFTY: `trading_symbol LIKE 'BANKNIFTY%'`,
            FINNIFTY: `trading_symbol LIKE 'FINNIFTY%'`,
            MIDCAPNIFTY: `trading_symbol LIKE 'MIDCAPNIFTY%'`,
            SENSEX: `(trading_symbol LIKE 'SENSEX%' OR trading_symbol LIKE 'BANKEX%')`,
            NIFTY: `(trading_symbol LIKE 'NIFTY%' AND trading_symbol NOT LIKE 'BANKNIFTY%' AND trading_symbol NOT LIKE 'FINNIFTY%' AND trading_symbol NOT LIKE 'MIDCAPNIFTY%')`,
        };

        const lotsOpen = {};
        for (const idx of Object.keys(lotLimits)) {
            if (!lotLimits[idx]) continue; // not configured for this challenge
            try {
                if (isDemo) {
                    const openRows = await query.fetchSingleRecord(
                        constants.vals.defaultDB,
                        'demo_orders',
                        `WHERE dhan_client_id='${dhanClientId}'
                         AND order_status='TRADED'
                         AND DATE(created_at)=CURDATE()
                         AND ${symbolPatterns[idx]}`,
                        `COALESCE(SUM(CASE WHEN transaction_type='BUY' THEN quantity ELSE -quantity END), 0) AS net_qty`
                    );
                    const openQty = Math.max(0, Number(openRows?.net_qty || 0));
                    const lotRow = await query.fetchSingleRecord(
                        constants.vals.defaultDB,
                        'instruments',
                        `WHERE ${symbolPatterns[idx]} LIMIT 1`,
                        'lot_size'
                    );
                    const lotSize = Number(lotRow?.lot_size || 1);
                    lotsOpen[idx] = { open: lotSize > 0 ? Math.round(openQty / lotSize) : 0, allowed: lotLimits[idx] };
                } else {
                    lotsOpen[idx] = { open: await dhanUsage.getLiveOpenLots(dhanClientId, idx), allowed: lotLimits[idx] };
                }
            } catch (e) {
                console.log(`[Challenge] usage lots_open failed for ${idx}:`, e.message);
                lotsOpen[idx] = { open: 0, allowed: lotLimits[idx] };
            }
        }

        const tradingStyle = (rules.trading_style || '').toUpperCase();
        return res.json({
            status: true,
            data: {
                mode,
                trades_used: tradesUsed,
                trades_limit: rules.max_trades_per_day,
                pnl_today: sessionPnL,
                loss_room_left: rules.max_loss > 0 ? Math.max(0, rules.max_loss + sessionPnL) : null,
                lots_open: lotsOpen,
                // For the Instrument Window's "Your rules" box — same style
                // keys as ChallengeController.checkOrderRules's stop-loss
                // check, exposed here too so a pre-order summary can show it
                // before the user even opens the order form.
                trading_style: tradingStyle,
                stop_loss_required: !!advChallenge.getStyleDefaults(tradingStyle).stop_loss_required,
            },
        });
    } catch (error) {
        console.log(error);
        res.json({ status: false, message: error.message });
    }
};

exports.logTrade = async (req, res) => {

    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({
                status: false,
                message: "User authentication required"
            });
        }

        const dhanClientId = user.dhanClientId;
        const { index, quantity, pnl } = req.body;

        const challenge = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );

        await query.insertSingle(
            constants.vals.defaultDB,
            "challenge_trade_logs",
            {
                dhan_client_id: dhanClientId,
                challenge_id: challenge?.id || null,
                index_name: index,
                quantity,
                pnl,
                trade_date: new Date()
            }
        );

        res.json({
            status: true,
            message: "Trade logged successfully"
        });

    } catch (error) {
        console.log(error);
        res.json({ status: false, message: error.message });
    }
};

exports.checkCooldown = async (req, res) => {

    try {
        const user = req.user;
        const pause = await query.fetchRecords(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            `WHERE dhan_client_id='${user.dhanClientId}' AND pause_end > NOW() ORDER BY id DESC LIMIT 1`
        );

        if (pause.length) {
            return res.json({
                allowed: false,
                rule: pause[0].rule_triggered,
                message: "Challenge completed. Use Quick Unlock to trade again.",
                pause_end: pause[0].pause_end
            });
        }

        // Count how many times unlocked today
        const unlockCount = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            `WHERE dhan_client_id='${user.dhanClientId}' AND quick_unlock_used=1 AND DATE(pause_end)=CURDATE()`,
            "COUNT(*) as total"
        );

        res.json({
            allowed: true,
            unlockCount: Number(unlockCount?.total || 0)
        });

    } catch (error) {
        res.json({ allowed: false, message: error.message });
    }
};

exports.triggerCooldown = async (dhanClientId, challengeId, rule) => {
    try {
        // Block until end of day — user must use Quick Unlock to resume
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 0);

        await query.insertSingle(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            {
                dhan_client_id: dhanClientId,
                challenge_id: challengeId,
                rule_triggered: rule,
                pause_start: new Date(),
                pause_end: endOfDay
            }
        );

    } catch (error) {
        console.log(error);
    }
};

exports.quickUnlock = async (req, res) => {
    try {
        const user = req.user;
        const dhanClientId = user.dhanClientId;
        const unlockType = (req.body.type || 'INSTANT').toUpperCase(); // INSTANT | FREE

        const { getOrCreateBalance, todayUnlockCount, monthUnlockStats, ordinal, UNLOCK_RULES, MAX_UNLOCKS_PER_DAY } = require('./WalletController');
        const dbcon = require('../config/mysqlClient');

        // Check max unlocks
        const done = await todayUnlockCount(dhanClientId);
        if (done >= MAX_UNLOCKS_PER_DAY) {
            return res.json({ status: false, message: `Maximum ${MAX_UNLOCKS_PER_DAY} quick unlocks per day reached.` });
        }

        const rule = UNLOCK_RULES[done];

        // Scoped to the CURRENT active challenge only — same reasoning as
        // checkOrderRules' cooldown check. Without this, a more-recent
        // pause row left over from a different (already-inactive) challenge
        // could get unlocked instead of the real block on the active one.
        const activeChallenge = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );
        const challengeFilter = activeChallenge?.id ? ` AND challenge_id=${activeChallenge.id}` : '';

        const pause = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            `WHERE dhan_client_id='${dhanClientId}'${challengeFilter} AND pause_end > NOW() ORDER BY id DESC LIMIT 1`
        );

        if (!pause || Array.isArray(pause) || !pause.id) {
            return res.json({ status: false, message: "No active block found" });
        }

        let coinsSpent = 0;
        let newPauseEnd;
        let resumeMessage;

        if (unlockType === 'INSTANT') {
            // Deduct coins
            const balance = await getOrCreateBalance(dhanClientId);
            if (balance < rule.instantCoins) {
                return res.json({
                    status: false,
                    message: `Not enough unlock balance. Need ₹${rule.instantCoins}, you have ₹${balance}.`
                });
            }
            // Deduct from wallet
            await dbcon.query(constants.vals.defaultDB,
                `UPDATE user_coins SET balance = balance - ?, updated_at = NOW() WHERE dhan_client_id = ?`,
                [rule.instantCoins, dhanClientId]
            );
            await query.insertSingle(constants.vals.defaultDB, 'coin_transactions', {
                dhan_client_id: dhanClientId,
                type: 'SPEND',
                amount: rule.instantCoins,
                description: `Quick Unlock #${done + 1} (Instant) — ₹${rule.instantCoins}`,
                reference_id: pause.id,
            });
            coinsSpent = rule.instantCoins;
            newPauseEnd = 'NOW()';
            resumeMessage = `Instant unlock! ₹${rule.instantCoins} used from your unlock balance. Trading resumed now.`;
        } else {
            // FREE — delayed unlock
            const mins = rule.freeMinutes;
            newPauseEnd = `DATE_ADD(NOW(), INTERVAL ${mins} MINUTE)`;
            resumeMessage = `Free unlock activated. Trading resumes in ${mins} minute${mins !== 1 ? 's' : ''}.`;
        }

        await dbcon.query(constants.vals.defaultDB,
            `UPDATE challenge_pause_logs
             SET pause_end = ${newPauseEnd},
                 quick_unlock_used = 1,
                 unlock_type = ?,
                 coins_spent = ?
             WHERE id = ?`,
            [unlockType, coinsSpent, pause.id]
        );

        // ── Reset challenge_status + clear PnL alert dedup for new session ──
        // For INSTANT: unblock immediately.
        // For FREE: unblock is deferred (status stays BLOCKED until pause_end passes
        // and isDemoUserBlocked auto-clears it).
        // In both cases reset last_pnl_alert_date so the cron can fire a fresh
        // floating-PnL notification in the new session.
        if (unlockType === 'INSTANT') {
            await query.updateRecord(
                constants.vals.defaultDB,
                'user_challenges',
                `dhan_client_id='${dhanClientId}' AND is_active=1`,
                `challenge_status='ACTIVE', last_pnl_alert_date=NULL, last_pnl_alert_reason=NULL`
            );
            console.log(`[QuickUnlock] Reset challenge_status → ACTIVE + cleared PnL alert for ${dhanClientId}`);
        } else {
            // FREE unlock — keep BLOCKED until timer fires, but reset alert dedup
            await query.updateRecord(
                constants.vals.defaultDB,
                'user_challenges',
                `dhan_client_id='${dhanClientId}' AND is_active=1`,
                `last_pnl_alert_date=NULL, last_pnl_alert_reason=NULL`
            );
            console.log(`[QuickUnlock] FREE unlock queued — cleared PnL alert for ${dhanClientId}`);
        }

        // New balance
        const newBalance = await getOrCreateBalance(dhanClientId);
        const totalUnlocks = done + 1;
        // Counted after this unlock was recorded, so it includes it.
        const month = await monthUnlockStats(dhanClientId);

        console.log(`[QuickUnlock] ${dhanClientId} type=${unlockType} coins=${coinsSpent} unlock#=${totalUnlocks}`);

        res.json({
            status: true,
            message: resumeMessage,
            unlockType,
            coinsSpent,
            newBalance,
            unlocksUsed: totalUnlocks,
            maxUnlocks: MAX_UNLOCKS_PER_DAY,
            // Weight of the unlock: "This is your 4th unlock this month."
            monthUnlockNumber: month.count,
            monthRupeesSpent: month.spent,
            monthMessage: `This is your ${ordinal(month.count)} unlock this month` +
                (month.spent > 0 ? ` (₹${month.spent} spent on unlocks).` : '.'),
            // For FREE unlock: when trading resumes
            resumeAt: unlockType === 'FREE'
                ? new Date(Date.now() + rule.freeMinutes * 60 * 1000).toISOString()
                : null,
        });

    } catch (error) {
        console.log('[QuickUnlock] ERROR:', error.message);
        res.json({ status: false, message: error.message });
    }
};
