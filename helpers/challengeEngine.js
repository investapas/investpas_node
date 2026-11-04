const query = require("../helpers/query");
const constants = require("../vars/constants");
const utility = require("../helpers/utility");
const advChallenge = require("./advanceChallengeEngine");

// ── Notification templates (one per rule reason) ──────────────────────────────
const NOTIF = {
    'MAX LOSS HIT': {
        title: '🚫 Daily Loss Limit Reached',
        body:  'You have reached your daily loss limit for today. Continuing to trade now can increase emotional decisions and risk larger losses. Please take a break.\n\n💬 Discipline today protects opportunities tomorrow.',
        route: 'challengeBlocked',
    },
    'TARGET ACHIEVED': {
        title: '🎯 Daily Profit Target Achieved',
        body:  'You have achieved your daily profit target for today. Greed after profits often turns winning days into losing ones. Kindly lock in your gains.\n\n💬 Consistency matters more than one extra trade.',
        route: 'challengeBlocked',
    },
    'MAX DAILY TRADES LIMIT HIT': {
        title: '🚫 Trade Limit Reached',
        body:  'You have already completed the maximum number of trades set for today. Over-trading increases fatigue and reduces decision quality. No further trades are allowed today.\n\n💬 Less trades, better clarity, stronger discipline.',
        route: 'challengeBlocked',
    },
    'CAPITAL LIMIT EXCEEDED': {
        title: '⚠️ Quantity Rule Violation',
        body:  'You are trying to place an order that exceeds your allowed quantity or capital limit. This order has been blocked to prevent emotional risk and panic trading.\n\n💬 Stick to your planned size. Control builds confidence.',
        route: 'challengeBlocked',
    },
    'ALREADY BLOCKED': {
        title: '⏸ Trading Paused',
        body:  'Your trading remains paused for today as per your challenge rules. Investapas never places or exits trades for you — we only protect you from breaking your own rules.\n\n💬 You can resume trading via Quick Unlock (₹50).',
        route: 'challengeBlocked',
    },
};

// Fire-and-forget push notification to a user by dhan_client_id
exports.notifyChallenge = _notifyChallenge;
async function _notifyChallenge(clientId, reason) {
    try {
        const tmpl = NOTIF[reason];
        if (!tmpl) return;

        const row = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            'users',
            `WHERE dhan_client_id='${clientId}'`,
            'firebase_token'
        );
        const token = row?.firebase_token;
        if (!token) return;

        await utility.sendNotification(
            [token],
            tmpl.route,
            '',
            { title: tmpl.title, body: tmpl.body }
        );
        console.log(`[ChallengeEngine] 🔔 Notif sent → ${clientId} | ${reason}`);
    } catch (e) {
        console.log('[ChallengeEngine] Notification error:', e.message);
    }
}

// ======================================================
// 🔥 MAIN RULE CHECK FUNCTION
// ======================================================
exports.checkUserRules = async (clientId, transactionType) => {
    try {

        const challenge = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `WHERE dhan_client_id='${clientId}' AND is_active=1`
        );

        if (!challenge) {
            return { blocked: false };
        }

        // 🚫 Already blocked — but verify pause_end hasn't expired
        // (Quick Unlock sets pause_end=NOW() but may not reset challenge_status in time)
        if (challenge.challenge_status === "BLOCKED") {
            const activePause = await query.fetchRecords(
                constants.vals.defaultDB,
                "challenge_pause_logs",
                `WHERE dhan_client_id='${clientId}' AND challenge_id=${challenge.id} AND pause_end > NOW() LIMIT 1`
            );
            if (!activePause || activePause.length === 0) {
                // Pause expired (Quick Unlock was used) — auto-clear the blocked status
                await query.updateRecord(
                    constants.vals.defaultDB,
                    'user_challenges',
                    `dhan_client_id='${clientId}' AND is_active=1`,
                    `challenge_status='ACTIVE'`
                );
                console.log(`[Engine] Auto-cleared stale BLOCKED status for ${clientId}`);
            } else {
                // 🔔 Remind user their trading is still paused — only when triggered
                // by an actual order attempt (transactionType set). Without this guard,
                // the trade-sync cron (which calls checkUserRules with no transactionType
                // every 3s) would spam this notification continuously.
                if (transactionType) {
                    _notifyChallenge(clientId, 'ALREADY BLOCKED');
                }
                return { blocked: true, reason: "ALREADY BLOCKED" };
            }
        }

        // ── Find session start (last Quick Unlock time today) ─────────────
        // Trades are counted from session start so Quick Unlock properly resets the count
        const lastUnlock = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            `WHERE dhan_client_id='${clientId}' AND quick_unlock_used=1 AND DATE(pause_end)=CURDATE() ORDER BY id DESC LIMIT 1`
        );
        const sessionStart = (lastUnlock && !Array.isArray(lastUnlock))
            ? lastUnlock.pause_end
            : null;

        // IMPORTANT: use created_at (DATETIME), NOT trade_date (DATE).
        // trade_date is a DATE column — comparing DATE vs DATETIME on the same day
        // always returns FALSE ('2026-05-22 00:00:00' > '2026-05-22 08:26:54' = false),
        // so all same-day trades would be excluded and the count stays 0 after unlock.
        const sessionFilter = sessionStart
            ? `WHERE dhan_client_id='${clientId}' AND created_at > '${sessionStart}'`
            : `WHERE dhan_client_id='${clientId}' AND DATE(created_at)=CURDATE()`;

        // ======================================================
        // ✅ CLOSED PnL — session-scoped
        // ======================================================
        const closed = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_trade_logs",
            `${sessionFilter} AND status='CLOSED'`,
            "SUM(pnl) as total"
        );

        const pnl = Number(closed?.total || 0);

        // ======================================================
        // ✅ BUY EXECUTIONS COUNT — session-scoped (OPEN + CLOSED)
        // Count ALL trade entries (each BUY = 1 row), matching checkOrderRules logic.
        // Counting only CLOSED would miss open positions and allow extra BUYs.
        // ======================================================
        const closedTradesData = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_trade_logs",
            sessionFilter,
            "COUNT(*) as total"
        );

        const closedTrades = Number(closedTradesData?.total || 0);
        // ======================================================
        // ✅ CAPITAL USED — session-scoped
        // ======================================================
        const capitalData = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_trade_logs",
            `${sessionFilter} AND status='OPEN'`,
            "SUM(buy_price * quantity) as total"
        );

        const capital = Number(capitalData?.total || 0);

        // ======================================================
        // LIMITS
        // ======================================================
        const maxLoss = Number(challenge.max_loss || 0);
        const maxProfit = Number(challenge.max_profit || 0);
        const maxTrades = Number(challenge.max_trades_per_day || 0);
        const capitalLimit = Number(challenge.trading_capital || 0);

        let blocked = false;
        let reason = "";

        // ======================================================
        // 🔥 RULE ENGINE
        // ======================================================
        if (maxLoss > 0 && pnl <= -maxLoss) {
            blocked = true;
            reason = "MAX LOSS HIT";

        } else if (maxProfit > 0 && pnl >= maxProfit) {
            blocked = true;
            reason = "TARGET ACHIEVED";

        } else if (
            transactionType === "BUY" &&
            maxTrades > 0 &&
            closedTrades >= maxTrades
        ) {
            blocked = true;
            reason = "MAX DAILY TRADES LIMIT HIT";
        } else if (capitalLimit > 0 && capital > capitalLimit) {
            blocked = true;
            reason = "CAPITAL LIMIT EXCEEDED";
        }

        // ======================================================
        // 🔥 ADVANCED RULES (cooldown, consecutive loss, per-trade capital, revenge, hero)
        // ======================================================
        // NOTE: must NOT early-return here — all blocks must fall through to the
        // `if (blocked)` section below that writes challenge_status='BLOCKED' and
        // inserts challenge_pause_logs, otherwise quickUnlock finds no active pause.
        if (!blocked && transactionType === 'BUY') {
            const cooldownCheck = await advChallenge.checkCooldown(clientId, challenge);
            if (cooldownCheck.blocked) {
                blocked = true; reason = 'COOLDOWN';
            }
        }

        if (!blocked && transactionType === 'BUY') {
            // ── Revenge trade check ──
            await advChallenge.checkRevengeTrade(clientId, challenge);

            const posCheck = await advChallenge.checkMaxOpenPositions(clientId, challenge);
            if (posCheck.blocked) {
                blocked = true; reason = posCheck.reason;
            }
        }

        if (!blocked && transactionType === 'BUY') {
            // ── PHASE 2: Euphoric trading detection (warning) ──
            await advChallenge.checkEuphoricTrading(clientId, challenge, capital);
        }

        // ======================================================
        // 🔥 BLOCK + LOG
        // ======================================================
        if (blocked) {

            console.log(`🚫 Blocking user: ${clientId} | Reason: ${reason}`);

            // ✅ Update status
            await query.updateRecord(
                constants.vals.defaultDB,
                "user_challenges",
                `dhan_client_id='${clientId}'`,
                `challenge_status='BLOCKED'`
            );

            // ✅ Avoid duplicate logs for the current session
            // After Quick Unlock, a new block entry is always allowed
            const activeBlock = await query.fetchRecords(
                constants.vals.defaultDB,
                "challenge_pause_logs",
                `WHERE dhan_client_id='${clientId}' AND challenge_id=${challenge.id} AND pause_end > NOW() LIMIT 1`
            );

            if (!activeBlock || activeBlock.length === 0) {
                // Set pause_end = end of day
                const endOfDay = new Date();
                endOfDay.setHours(23, 59, 59, 0);

                await query.insertSingle(
                    constants.vals.defaultDB,
                    "challenge_pause_logs",
                    {
                        dhan_client_id: clientId,
                        challenge_id: challenge.id,
                        rule_triggered: reason,
                        pause_start: new Date(),
                        pause_end: endOfDay,
                        quick_unlock_used: 0
                    }
                );

                console.log(`📝 [Engine] Pause log inserted for ${clientId} reason=${reason}`);

                // 🔔 Send push notification — first time this rule fires today
                _notifyChallenge(clientId, reason);
            }
        }

        // ======================================================
        // DEBUG
        // ======================================================
        // console.log({
        //     clientId,
        //     pnl,
        //     trades,
        //     capital,
        //     maxLoss,
        //     maxProfit,
        //     maxTrades,
        //     capitalLimit,
        //     blocked,
        //     reason
        // });

        return { blocked, reason };

    } catch (err) {
        console.log("❌ RULE CHECK ERROR:", err.message);
        return { blocked: false };
    }
};


exports.checkCapitalBeforeTrade = async (clientId, price, quantity, securityId = '', tradingSymbol = '') => {

    const challenge = await query.fetchSingleRecord(
        constants.vals.defaultDB,
        "user_challenges",
        `WHERE dhan_client_id='${clientId}' AND is_active=1`
    );

    if (!challenge) return { allowed: true };

    const capitalLimit = Number(challenge.trading_capital || 0);

    // current capital
    const capitalData = await query.fetchSingleRecord(
        constants.vals.defaultDB,
        "challenge_trade_logs",
        `WHERE dhan_client_id='${clientId}' 
         AND status='OPEN'
         AND trade_date=CURDATE()`,
        "SUM(buy_price * quantity) as total"
    );

    const currentCapital = Number(capitalData?.total || 0);

    const newOrderValue = Number(price) * Number(quantity);

    if (capitalLimit > 0 && (currentCapital + newOrderValue) > capitalLimit) {
        return {
            allowed: false,
            reason: "CAPITAL LIMIT EXCEEDED"
        };
    }

    // ── Advanced: Max % capital per single trade ──
    const perTradeCheck = advChallenge.checkCapitalPerTrade(challenge, newOrderValue);
    if (perTradeCheck.blocked) {
        return { allowed: false, reason: perTradeCheck.reason, message: perTradeCheck.message };
    }

    // ── Advanced: Quantity escalation warning ──
    await advChallenge.checkQuantityEscalation(clientId, challenge, Number(quantity));

    // ── Advanced: Max premium risk for options buyers ──
    const premiumCheck = advChallenge.checkMaxPremiumRisk(challenge, Number(price), Number(quantity));
    if (premiumCheck.blocked) {
        return { allowed: false, reason: premiumCheck.reason, message: premiumCheck.message };
    }

    // ── PHASE 2: No averaging down (Swing/Equity) ──
    if (securityId) {
        const avgDownCheck = await advChallenge.checkAveragingDown(clientId, challenge, securityId, Number(price), false);
        if (avgDownCheck.blocked) {
            return { allowed: false, reason: avgDownCheck.reason, message: avgDownCheck.message };
        }
    }

    // ── PHASE 2: Lottery trade detection (warning) ──
    if (tradingSymbol) {
        await advChallenge.checkLotteryTrade(clientId, challenge, tradingSymbol, Number(price));
    }

    // ── PHASE 2: Sector exposure limit (Equity) ──
    if (tradingSymbol) {
        const sectorCheck = await advChallenge.checkSectorExposure(clientId, challenge, tradingSymbol, newOrderValue, false);
        if (sectorCheck.blocked) {
            return { allowed: false, reason: sectorCheck.reason, message: sectorCheck.message };
        }
    }

    // ── PHASE 2: Margin utilization cap (Options Seller) ──
    const marginCheck = await advChallenge.checkMarginUtilization(clientId, challenge, newOrderValue);
    if (marginCheck.blocked) {
        return { allowed: false, reason: marginCheck.reason, message: marginCheck.message };
    }

    // ── PHASE 2: Hedge required warning (Options Seller) ──
    await advChallenge.checkHedgeRequired(clientId, challenge, false);

    // Record BUY entry for holding-discipline tracking
    if (securityId) {
        await advChallenge.recordBuyEntry(clientId, challenge, securityId, Number(price));
    }

    return { allowed: true };
};

// ── Called after every SELL order to track behavior ──
exports.onTradeExit = async (clientId, pnl, tradingSymbol) => {
    try {
        const challenge = await query.fetchSingleRecord(
            constants.vals.defaultDB, 'user_challenges',
            `WHERE dhan_client_id='${clientId}' AND is_active=1`
        );
        if (!challenge) return;

        // Start cooldown timer
        await advChallenge.startCooldown(clientId, challenge);

        // Track consecutive wins/losses
        await advChallenge.recordTradeResult(clientId, challenge, Number(pnl));

        // ── AI Coaching: generate a behavior-based message (rate-limited) ──
        const aiCoaching = require('./aiCoachingEngine');
        aiCoaching.maybeGenerateCoaching(clientId, challenge.id).catch(() => {});

        console.log(`[Engine] onTradeExit: ${clientId} pnl=${pnl}`);
    } catch (e) {
        console.log('[Engine] onTradeExit error:', e.message);
    }
};

// ── Called before BUY to check hero trade on expiry day ──
exports.checkHeroTrade = async (clientId, tradingSymbol, price, qty) => {
    try {
        const challenge = await query.fetchSingleRecord(
            constants.vals.defaultDB, 'user_challenges',
            `WHERE dhan_client_id='${clientId}' AND is_active=1`
        );
        if (!challenge) return { blocked: false };
        return advChallenge.checkHeroTrade(clientId, challenge, tradingSymbol, price, qty);
    } catch (e) {
        return { blocked: false };
    }
};