const dbcon    = require('../config/mysqlClient');
const constants = require('../vars/constants');
const utility  = require('../helpers/utility');
const query    = require('../helpers/query');
const { notifyChallenge, onTradeExit, checkHeroTrade } = require('../helpers/challengeEngine');
const advChallenge = require('../helpers/advanceChallengeEngine');
const { getPrice }        = require('../helpers/priceCache');
const demoFifo            = require('../helpers/demoFifo');
const instrumentStatus    = require('../helpers/instrumentStatus');

const DB              = constants.vals.defaultDB;
const FREE_COINS      = 100000; // 1 lakh coins given free on first activation

// Set to false to run only the 4 basic rules (max loss, max profit, max trades, capital limit).
// Set to true to re-enable cooldown, hero-trade, capital-per-trade, etc.
const ADVANCE_RULES_ENABLED = false;

// Run migration once per process start — not on every request
let _tablesReady = false;

// ── Push notification helper (fire-and-forget, same pattern as DhanController) ──
function _notifyUser(dhanClientId, title, body, orderId) {
    (async () => {
        try {
            const row = await query.fetchSingleRecord(
                DB, 'users',
                `WHERE dhan_client_id='${dhanClientId}'`,
                'firebase_token'
            );
            const token = row?.firebase_token;
            if (!token) return;
            await utility.sendNotification(
                [token],
                'orderPage',
                String(orderId || ''),
                { title, body }
            );
            console.log(`[DEMO NOTIF] Sent "${title}" to ${dhanClientId}`);
        } catch (e) {
            console.log('[DEMO NOTIF] Failed:', e.message);
        }
    })();
}
exports._notifyUser = _notifyUser;

// ── Expiry-day new-order gate (configurable, default: allowed) ─────────────
// No such restriction exists in the real-money flow, and none existed here
// before this — default 'true' means zero behavior change unless an admin
// flips demo_settings.allow_new_orders_on_expiry_day to 'false'. Only ever
// applies to F&O instruments (OPTIDX/OPTSTK/FUTIDX/FUTSTK) expiring today —
// equity DELIVERY has no contract expiry, so it's never gated.
async function _isExpiryDayOrderBlocked(securityId, productType) {
    if (productType !== 'DELIVERY') return false;
    try {
        const settingRows = await dbcon.query(DB,
            `SELECT setting_value FROM demo_settings WHERE setting_key='allow_new_orders_on_expiry_day'`,
            []
        );
        const allowed = (settingRows?.[0]?.setting_value ?? 'true').toLowerCase() !== 'false';
        if (allowed) return false;

        const rows = await dbcon.query(DB,
            `SELECT 1 FROM instruments
             WHERE security_id=? AND instrument IN ('OPTIDX','OPTSTK','FUTIDX','FUTSTK')
               AND sm_expiry_date IS NOT NULL AND DATE(sm_expiry_date) = ?
             LIMIT 1`,
            [securityId, instrumentStatus.istDateKey()]
        );
        return !!rows?.length;
    } catch (e) {
        console.log('[DEMO ORDER] _isExpiryDayOrderBlocked check failed, allowing order:', e.message);
        return false; // fail open — never block an order because this check itself errored
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Returns true if the user has an active challenge block (pause_end > NOW()).
// Auto-clears the DB status when the pause has naturally expired.
// ─────────────────────────────────────────────────────────────────────────────
async function isDemoUserBlocked(dhanClientId) {
    const rows = await dbcon.query(DB,
        `SELECT id, challenge_status FROM user_challenges
         WHERE dhan_client_id=? AND is_active=1 LIMIT 1`,
        [dhanClientId]
    );
    const challenge = rows?.[0];
    if (!challenge || challenge.challenge_status !== 'BLOCKED') return { blocked: false };

    const activePause = await dbcon.query(DB,
        `SELECT id, pause_end, rule_triggered FROM challenge_pause_logs
         WHERE dhan_client_id=? AND challenge_id=? AND pause_end > NOW() LIMIT 1`,
        [dhanClientId, challenge.id]
    );

    if (activePause && activePause.length > 0) {
        const p = activePause[0];
        return {
            blocked: true,
            reason: p.rule_triggered,
            pauseEnd: p.pause_end,
            message: `Challenge blocked: ${p.rule_triggered}. Use Quick Unlock to resume.`,
        };
    }

    // Pause expired naturally — auto-clear so next order goes through
    await dbcon.query(DB,
        `UPDATE user_challenges SET challenge_status='ACTIVE' WHERE dhan_client_id=? AND is_active=1`,
        [dhanClientId]
    );
    return { blocked: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo challenge check — mirrors challengeEngine.checkUserRules exactly.
// Called for BUY only; SELL block is handled by isDemoUserBlocked above.
// orderAmount: qty × price of the new order (for capital projection).
// tradingSymbol + qty + securityId: used for per-index lot limit check.
// ─────────────────────────────────────────────────────────────────────────────
async function checkDemoChallengeRules(dhanClientId, orderAmount = 0, tradingSymbol = '', qty = 0, securityId = '') {
    try {
        const rows = await dbcon.query(DB,
            `SELECT * FROM user_challenges WHERE dhan_client_id=? AND is_active=1 LIMIT 1`,
            [dhanClientId]
        );
        const challenge = rows?.[0];
        if (!challenge) {
            console.log(`[DEMO CHALLENGE] No active challenge for ${dhanClientId} — allowing`);
            return { blocked: false };
        }

        // ── Extract index name from trading symbol (check longer names first) ──
        const sym = (tradingSymbol || '').toUpperCase();
        let index = null;
        if      (sym.includes('MIDCAPNIFTY')) index = 'MIDCAPNIFTY';
        else if (sym.includes('BANKNIFTY'))   index = 'BANKNIFTY';
        else if (sym.includes('FINNIFTY'))    index = 'FINNIFTY';
        else if (sym.includes('BANKEX'))      index = 'SENSEX';
        else if (sym.includes('SENSEX'))      index = 'SENSEX';
        else if (sym.includes('NIFTY'))       index = 'NIFTY';

        // ── Per-index lot limit (QUANTITY_RULE — not a day-end block) ──────────
        if (index && qty > 0) {
            const lotRows = await dbcon.query(DB,
                `SELECT lot_size FROM instruments WHERE security_id = ? LIMIT 1`,
                [securityId]
            );
            const lotSize = Number(lotRows?.[0]?.lot_size || 1);
            const lotsRequested = lotSize > 1 ? Math.round(qty / lotSize) : qty;

            const lotLimits = {
                'NIFTY':       Number(challenge.nifty_lots       || 0),
                'BANKNIFTY':   Number(challenge.banknifty_lots   || 0),
                'FINNIFTY':    Number(challenge.finnifty_lots    || 0),
                'MIDCAPNIFTY': Number(challenge.midcapnifty_lots || 0),
                'SENSEX':      Number(challenge.sensex_lots      || 0),
            };
            const allowedLots = lotLimits[index] || 0;

            // Build symbol filter to query cumulative open lots for this index
            let symbolFilter = '';
            if      (index === 'MIDCAPNIFTY') symbolFilter = `trading_symbol LIKE 'MIDCAPNIFTY%'`;
            else if (index === 'BANKNIFTY')   symbolFilter = `trading_symbol LIKE 'BANKNIFTY%'`;
            else if (index === 'FINNIFTY')    symbolFilter = `trading_symbol LIKE 'FINNIFTY%'`;
            else if (index === 'SENSEX')      symbolFilter = `(trading_symbol LIKE 'SENSEX%' OR trading_symbol LIKE 'BANKEX%')`;
            else if (index === 'NIFTY')       symbolFilter = `(trading_symbol LIKE 'NIFTY%' AND trading_symbol NOT LIKE 'BANKNIFTY%' AND trading_symbol NOT LIKE 'FINNIFTY%' AND trading_symbol NOT LIKE 'MIDCAPNIFTY%')`;

            if (allowedLots > 0 && symbolFilter) {
                const openRows = await dbcon.query(DB,
                    `SELECT COALESCE(SUM(CASE WHEN transaction_type='BUY' THEN quantity ELSE -quantity END), 0) AS net_qty
                     FROM demo_orders
                     WHERE dhan_client_id=? AND order_status='TRADED' AND DATE(created_at)=CURDATE()
                     AND ${symbolFilter}`,
                    [dhanClientId]
                );
                const currentOpenQty  = Math.max(0, Number(openRows?.[0]?.net_qty || 0));
                const currentOpenLots = lotSize > 0 ? Math.round(currentOpenQty / lotSize) : 0;
                const totalAfter      = currentOpenLots + lotsRequested;
                console.log(`[DEMO CHALLENGE] lot check: ${index} lotSize=${lotSize} requested=${lotsRequested} openLots=${currentOpenLots} totalAfter=${totalAfter} allowed=${allowedLots}`);
                if (totalAfter > allowedLots) {
                    const remaining = Math.max(0, allowedLots - currentOpenLots);
                    return {
                        blocked: true,
                        reason: 'QUANTITY_RULE',
                        message: remaining > 0
                            ? `You can only buy ${remaining} more lot${remaining !== 1 ? 's' : ''} for ${index}. Already holding ${currentOpenLots} lot${currentOpenLots !== 1 ? 's' : ''} (limit: ${allowedLots}).`
                            : `${index} lot limit of ${allowedLots} already reached. Cannot buy more.`,
                    };
                }
            } else if (allowedLots > 0 && lotsRequested > allowedLots) {
                return {
                    blocked: true,
                    reason: 'QUANTITY_RULE',
                    message: `You cannot trade more than ${allowedLots} lot${allowedLots > 1 ? 's' : ''} for ${index} in this challenge`,
                };
            }
        }

        // ── Already BLOCKED? Check if there is still an active pause ──────────
        if (challenge.challenge_status === 'BLOCKED') {
            const activePause = await dbcon.query(DB,
                `SELECT id FROM challenge_pause_logs
                 WHERE dhan_client_id=? AND challenge_id=? AND pause_end > NOW() LIMIT 1`,
                [dhanClientId, challenge.id]
            );
            if (activePause && activePause.length > 0) {
                console.log(`[DEMO CHALLENGE] ${dhanClientId} already BLOCKED (active pause)`);
                notifyChallenge(dhanClientId, 'ALREADY BLOCKED');
                return { blocked: true, reason: 'ALREADY BLOCKED' };
            }
            // Pause expired — auto-clear (Quick Unlock used on real side or just midnight)
            await dbcon.query(DB,
                `UPDATE user_challenges SET challenge_status='ACTIVE'
                 WHERE dhan_client_id=? AND is_active=1`,
                [dhanClientId]
            );
        }

        // ── Session start: last Quick Unlock time today (same logic as real engine) ─
        const unlockRows = await dbcon.query(DB,
            `SELECT pause_end FROM challenge_pause_logs
             WHERE dhan_client_id=? AND quick_unlock_used=1 AND DATE(pause_end)=CURDATE()
             ORDER BY id DESC LIMIT 1`,
            [dhanClientId]
        );
        const sessionStart = (unlockRows && unlockRows.length > 0) ? unlockRows[0].pause_end : null;

        const sessionFilter = sessionStart
            ? `AND created_at > '${sessionStart}'`
            : `AND DATE(created_at) = CURDATE()`;

        // ── P&L: sum of stored pnl on today's SELL orders (session-scoped) ────
        const pnlRows = await dbcon.query(DB,
            `SELECT COALESCE(SUM(pnl), 0) AS total
             FROM demo_orders
             WHERE dhan_client_id=? AND transaction_type='SELL'
               AND order_status='TRADED' ${sessionFilter}`,
            [dhanClientId]
        );
        const pnl = Number(pnlRows?.[0]?.total || 0);

        // ── Trade count: completed round-trips today (session-scoped) ─────────
        // A completed trade is a TRADED SELL row (matches ChallengeController
        // .checkOrderRules' definition and what the pre-trade checklist UI
        // shows) — this used to count BUY rows instead, so a user averaging
        // into one position got blocked far sooner than the "X of N trades
        // used" the UI told them.
        const countRows = await dbcon.query(DB,
            `SELECT COUNT(*) AS cnt FROM demo_orders
             WHERE dhan_client_id=? AND transaction_type='SELL'
               AND order_status='TRADED' ${sessionFilter}`,
            [dhanClientId]
        );
        const tradesUsed = Number(countRows?.[0]?.cnt || 0);

        // ── Capital: net open position value + new order ──────────────────────
        const capRows = await dbcon.query(DB,
            `SELECT COALESCE(SUM(
                CASE WHEN transaction_type='BUY' THEN price * quantity
                     ELSE -(price * quantity) END
             ), 0) AS capital
             FROM demo_orders
             WHERE dhan_client_id=? AND order_status='TRADED'`,
            [dhanClientId]
        );
        const capitalUsed    = Number(capRows?.[0]?.capital || 0);
        const projectedCap   = capitalUsed + orderAmount;

        const maxLoss      = Number(challenge.max_loss            || 0);
        const maxProfit    = Number(challenge.max_profit          || 0);
        const maxTrades    = Number(challenge.max_trades_per_day  || 0);
        const capitalLimit = Number(challenge.trading_capital     || 0);

        let blocked = false;
        let reason  = '';
        let message = '';

        if      (maxLoss > 0 && pnl <= -maxLoss)
            { blocked = true; reason = 'MAX LOSS HIT'; message = `Daily loss limit of ₹${maxLoss} reached`; }
        else if (maxProfit > 0 && pnl >= maxProfit)
            { blocked = true; reason = 'TARGET ACHIEVED'; message = `Daily profit target of ₹${maxProfit} achieved`; }
        else if (maxTrades > 0 && tradesUsed >= maxTrades)
            { blocked = true; reason = 'MAX DAILY TRADES LIMIT HIT'; message = `Max ${maxTrades} trades per day reached`; }
        else if (capitalLimit > 0 && projectedCap > capitalLimit)
            { blocked = true; reason = 'CAPITAL LIMIT EXCEEDED'; message = `Order would exceed challenge capital of ₹${capitalLimit}`; }

        // ── Advanced rules (disabled when ADVANCE_RULES_ENABLED = false) ────────
        if (ADVANCE_RULES_ENABLED) {
            if (!blocked) {
                const cooldownCheck = await advChallenge.checkCooldown(dhanClientId, challenge);
                if (cooldownCheck.blocked) { blocked = true; reason = 'COOLDOWN'; message = cooldownCheck.message; }
            }
            if (!blocked) {
                const perTradeCheck = advChallenge.checkCapitalPerTrade(challenge, orderAmount);
                if (perTradeCheck.blocked) { blocked = true; reason = perTradeCheck.reason; message = perTradeCheck.message; }
            }
            if (!blocked) {
                await advChallenge.checkRevengeTrade(dhanClientId, challenge);
                await advChallenge.checkQuantityEscalation(dhanClientId, challenge, qty);
                const heroCheck = await advChallenge.checkHeroTrade(dhanClientId, challenge, tradingSymbol, orderAmount / (qty || 1), qty);
                if (heroCheck.blocked) { blocked = true; reason = heroCheck.reason || 'HERO_TRADE'; message = heroCheck.message; }
            }
            if (!blocked) {
                const premiumCheck = advChallenge.checkMaxPremiumRisk(challenge, orderAmount / (qty || 1), qty);
                if (premiumCheck.blocked) { blocked = true; reason = premiumCheck.reason; message = premiumCheck.message; }
            }
            if (!blocked) {
                const posCheck = await advChallenge.checkMaxOpenPositions(dhanClientId, challenge);
                if (posCheck.blocked) { blocked = true; reason = posCheck.reason; message = posCheck.message; }
            }
            if (!blocked) {
                const avgPrice = orderAmount / (qty || 1);
                const avgDownCheck = await advChallenge.checkAveragingDown(dhanClientId, challenge, securityId, avgPrice, true);
                if (avgDownCheck.blocked) { blocked = true; reason = avgDownCheck.reason; message = avgDownCheck.message; }
                if (!blocked) {
                    await advChallenge.checkLotteryTrade(dhanClientId, challenge, tradingSymbol, avgPrice);
                    const sectorCheck = await advChallenge.checkSectorExposure(dhanClientId, challenge, tradingSymbol, orderAmount, true);
                    if (sectorCheck.blocked) { blocked = true; reason = sectorCheck.reason; message = sectorCheck.message; }
                }
                if (!blocked) {
                    await advChallenge.checkEuphoricTrading(dhanClientId, challenge, orderAmount);
                    await advChallenge.recordBuyEntry(dhanClientId, challenge, securityId, avgPrice);
                }
            }
        }

        console.log(`[DEMO CHALLENGE] ${dhanClientId} | pnl=${pnl.toFixed(2)} trades=${tradesUsed}/${maxTrades} cap=${capitalUsed.toFixed(0)}+${orderAmount}=${projectedCap.toFixed(0)}/${capitalLimit} blocked=${blocked} reason=${reason}`);

        // ── If blocked: update challenge_status + insert pause log ────────────
        if (blocked) {
            await dbcon.query(DB,
                `UPDATE user_challenges SET challenge_status='BLOCKED'
                 WHERE dhan_client_id=? AND is_active=1`,
                [dhanClientId]
            );
            const existing = await dbcon.query(DB,
                `SELECT id FROM challenge_pause_logs
                 WHERE dhan_client_id=? AND challenge_id=? AND pause_end > NOW() LIMIT 1`,
                [dhanClientId, challenge.id]
            );
            if (!existing || existing.length === 0) {
                const endOfDay = new Date();
                endOfDay.setHours(23, 59, 59, 0);
                await dbcon.query(DB,
                    `INSERT INTO challenge_pause_logs
                     (dhan_client_id, challenge_id, rule_triggered, pause_start, pause_end, quick_unlock_used)
                     VALUES (?, ?, ?, NOW(), ?, 0)`,
                    [dhanClientId, challenge.id, reason, endOfDay]
                );

                // 🔔 Send push notification — first time this rule fires today
                notifyChallenge(dhanClientId, reason);
            }
        }

        return { blocked, reason, message };
    } catch (err) {
        console.error('❌ [DEMO CHALLENGE CHECK]', err.message);
        return { blocked: false };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Proactive demo P&L notification — called fire-and-forget after every order.
// Checks if today's demo realized P&L has crossed max_loss or max_profit and,
// if so, blocks the challenge + sends a push immediately (not just on next BUY).
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Shared helper — returns session filter string and realized P&L for a user.
// ─────────────────────────────────────────────────────────────────────────────
async function _getSessionData(dhanClientId) {
    const unlockRows = await dbcon.query(DB,
        `SELECT pause_end FROM challenge_pause_logs
         WHERE dhan_client_id=? AND quick_unlock_used=1 AND DATE(pause_end)=CURDATE()
         ORDER BY id DESC LIMIT 1`,
        [dhanClientId]
    );
    const sessionStart = unlockRows?.[0]?.pause_end ?? null;
    const sessionFilter = sessionStart
        ? `AND created_at > '${sessionStart}'`
        : `AND DATE(created_at) = CURDATE()`;

    const pnlRows = await dbcon.query(DB,
        `SELECT COALESCE(SUM(pnl), 0) AS total
         FROM demo_orders
         WHERE dhan_client_id=? AND transaction_type='SELL'
           AND order_status='TRADED' ${sessionFilter}`,
        [dhanClientId]
    );
    return {
        sessionStart,
        sessionFilter,
        realizedPnl: Number(pnlRows?.[0]?.total || 0),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKGROUND CRON — called every 3 s for every user who traded today.
// Checks LIVE P&L (realized + unrealized) and sends a NOTIFICATION ONLY.
// Does NOT block — blocking only happens via checkRealizedPnlBlock (on SELL).
// ─────────────────────────────────────────────────────────────────────────────
async function checkDemoPnlNotification(dhanClientId) {
    try {
        const rows = await dbcon.query(DB,
            `SELECT * FROM user_challenges WHERE dhan_client_id=? AND is_active=1 LIMIT 1`,
            [dhanClientId]
        );
        const challenge = rows?.[0];
        if (!challenge) return;

        const maxLoss   = Number(challenge.max_loss   || 0);
        const maxProfit = Number(challenge.max_profit || 0);
        if (!maxLoss && !maxProfit) return;

        if (challenge.challenge_status === 'BLOCKED') return;

        const { sessionFilter, realizedPnl } = await _getSessionData(dhanClientId);

        // ── Unrealized P&L: session-scoped open positions × live LTP ─────────
        const posRows = await dbcon.query(DB,
            `SELECT security_id,
                    SUM(CASE WHEN transaction_type='BUY' THEN quantity ELSE -quantity END) AS net_qty,
                    SUM(CASE WHEN transaction_type='BUY' THEN price * quantity ELSE 0 END) /
                    NULLIF(SUM(CASE WHEN transaction_type='BUY' THEN quantity ELSE 0 END), 0) AS avg_price
             FROM demo_orders
             WHERE dhan_client_id=? AND order_status='TRADED' ${sessionFilter}
             GROUP BY security_id
             HAVING net_qty > 0`,
            [dhanClientId]
        );

        let unrealizedPnl = 0;
        for (const pos of (posRows || [])) {
            const ltp = getPrice(pos.security_id);
            const qty = Number(pos.net_qty);
            const avg = Number(pos.avg_price);
            const posPnl = ltp != null ? (ltp - avg) * qty : 0;
            console.log(`[DEMO PnL]   secId=${pos.security_id} qty=${qty} avg=${avg.toFixed(2)} ltp=${ltp ?? 'N/A'} posPnl=${posPnl.toFixed(2)}`);
            if (ltp != null) unrealizedPnl += posPnl;
        }

        const totalPnl = realizedPnl + unrealizedPnl;
        console.log(`[DEMO PnL] ${dhanClientId} | realized=${realizedPnl.toFixed(2)} unrealized=${unrealizedPnl.toFixed(2)} total=${totalPnl.toFixed(2)} | limits: maxLoss=${maxLoss} maxProfit=${maxProfit}`);

        let reason = null;
        if      (maxLoss   > 0 && totalPnl <= -maxLoss)   reason = 'MAX LOSS HIT';
        else if (maxProfit > 0 && totalPnl >= maxProfit)   reason = 'TARGET ACHIEVED';
        if (!reason) return;

        // ── NOTIFY ONLY — do not block here ──────────────────────────────────
        // Blocking only happens in checkRealizedPnlBlock when the user closes
        // the trade (SELL) and final realized P&L crosses the limit.
        const lastAlertDate = challenge.last_pnl_alert_date
            ? new Date(challenge.last_pnl_alert_date).toDateString()
            : null;
        if (lastAlertDate === new Date().toDateString()) return; // already notified this session

        notifyChallenge(dhanClientId, reason);
        await dbcon.query(DB,
            `UPDATE user_challenges SET last_pnl_alert_date=CURDATE(), last_pnl_alert_reason=?
             WHERE id=?`,
            [reason, challenge.id]
        );
        console.log(`[DEMO PnL] 🔔 ${reason} (notify only — no block) → ${dhanClientId} | live total=${totalPnl.toFixed(2)}`);
    } catch (e) {
        console.log('[DEMO PnL] Notification error:', e.message);
    }
}

exports.checkDemoPnlNotification = checkDemoPnlNotification;

// ─────────────────────────────────────────────────────────────────────────────
// Called fire-and-forget after every SELL order.
// Checks REALIZED P&L only (no unrealized) — this is the blocking decision point.
// If session realized P&L crosses max_loss or max_profit → block + notify.
// ─────────────────────────────────────────────────────────────────────────────
async function checkRealizedPnlBlock(dhanClientId) {
    try {
        const rows = await dbcon.query(DB,
            `SELECT * FROM user_challenges WHERE dhan_client_id=? AND is_active=1 LIMIT 1`,
            [dhanClientId]
        );
        const challenge = rows?.[0];
        if (!challenge) return;

        const maxLoss   = Number(challenge.max_loss   || 0);
        const maxProfit = Number(challenge.max_profit || 0);
        if (!maxLoss && !maxProfit) return;

        if (challenge.challenge_status === 'BLOCKED') return;

        const { realizedPnl } = await _getSessionData(dhanClientId);

        let reason = null;
        if      (maxLoss   > 0 && realizedPnl <= -maxLoss)   reason = 'MAX LOSS HIT';
        else if (maxProfit > 0 && realizedPnl >= maxProfit)   reason = 'TARGET ACHIEVED';
        if (!reason) return;

        // ── Block challenge ────────────────────────────────────────────────────
        await dbcon.query(DB,
            `UPDATE user_challenges SET challenge_status='BLOCKED'
             WHERE dhan_client_id=? AND is_active=1`,
            [dhanClientId]
        );
        const existing = await dbcon.query(DB,
            `SELECT id FROM challenge_pause_logs
             WHERE dhan_client_id=? AND challenge_id=? AND pause_end > NOW() LIMIT 1`,
            [dhanClientId, challenge.id]
        );
        if (!existing || existing.length === 0) {
            const endOfDay = new Date();
            endOfDay.setHours(23, 59, 59, 0);
            await dbcon.query(DB,
                `INSERT INTO challenge_pause_logs
                 (dhan_client_id, challenge_id, rule_triggered, pause_start, pause_end, quick_unlock_used)
                 VALUES (?, ?, ?, NOW(), ?, 0)`,
                [dhanClientId, challenge.id, reason, endOfDay]
            );
            notifyChallenge(dhanClientId, reason);
            console.log(`[DEMO REALIZED] 🔴 ${reason} → ${dhanClientId} | realized=${realizedPnl.toFixed(2)}`);
        }
    } catch (e) {
        console.log('[DEMO REALIZED] Error:', e.message);
    }
}
exports.checkRealizedPnlBlock = checkRealizedPnlBlock;

// ─────────────────────────────────────────────────────────────────────────────
// Table setup
// ─────────────────────────────────────────────────────────────────────────────
async function ensureTables() {
    if (_tablesReady) return;
    // Demo orders — includes target/SL for super orders
    await dbcon.query(DB, `
        CREATE TABLE IF NOT EXISTS demo_orders (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            dhan_client_id   VARCHAR(50)    NOT NULL,
            security_id      VARCHAR(20)    NOT NULL,
            trading_symbol   VARCHAR(100)   NOT NULL,
            exchange_segment VARCHAR(30)    NOT NULL,
            transaction_type VARCHAR(10)    NOT NULL,
            order_type       VARCHAR(20)    NOT NULL DEFAULT 'MARKET',
            quantity         INT            NOT NULL,
            price            DECIMAL(12,2)  NOT NULL,
            target_price     DECIMAL(12,2)  DEFAULT 0,
            stop_loss_price  DECIMAL(12,2)  DEFAULT 0,
            trailing_jump    DECIMAL(8,2)   DEFAULT 0,
            order_status     VARCHAR(20)    NOT NULL DEFAULT 'TRADED',
            product_type     VARCHAR(20)    NOT NULL DEFAULT 'INTRADAY',
            executed_price   DECIMAL(12,2)  DEFAULT NULL,
            executed_at      DATETIME       DEFAULT NULL,
            square_off_reason VARCHAR(50)   DEFAULT NULL,
            created_at       DATETIME       DEFAULT CURRENT_TIMESTAMP,
            updated_at       DATETIME       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_client (dhan_client_id)
        )
    `, []);

    // Add new columns to existing table — check INFORMATION_SCHEMA first to avoid errors on MySQL 5.7
    const colsToAdd = [
        ['target_price',      'DECIMAL(12,2) DEFAULT 0'],
        ['stop_loss_price',   'DECIMAL(12,2) DEFAULT 0'],
        ['trailing_jump',     'DECIMAL(8,2)  DEFAULT 0'],
        ['pnl',               'DECIMAL(12,2) DEFAULT 0'],
        // MARKET/LIMIT/DELIVERY/INTRADAY + PENDING-order lifecycle support:
        ['product_type',      "VARCHAR(20) NOT NULL DEFAULT 'INTRADAY'"],
        ['executed_price',    'DECIMAL(12,2) DEFAULT NULL'],
        ['executed_at',       'DATETIME DEFAULT NULL'],
        ['square_off_reason', 'VARCHAR(50) DEFAULT NULL'],
    ];
    for (const [col, def] of colsToAdd) {
        const exists = await dbcon.query(DB,
            `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'demo_orders' AND COLUMN_NAME = ?`,
            [col]
        );
        if (Number(exists?.[0]?.cnt || 0) === 0) {
            await dbcon.query(DB, `ALTER TABLE demo_orders ADD COLUMN ${col} ${def}`, []);
        }
    }

    // Composite index for the PENDING-LIMIT-order cron scan (runs every 3s).
    const idxExists = await dbcon.query(DB,
        `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'demo_orders' AND INDEX_NAME = 'idx_pending'`,
        []
    );
    if (Number(idxExists?.[0]?.cnt || 0) === 0) {
        await dbcon.query(DB, `ALTER TABLE demo_orders ADD INDEX idx_pending (order_status, order_type)`, []);
    }

    // Per-user coin wallet
    await dbcon.query(DB, `
        CREATE TABLE IF NOT EXISTS demo_wallets (
            id                   INT AUTO_INCREMENT PRIMARY KEY,
            dhan_client_id       VARCHAR(50)    NOT NULL UNIQUE,
            total_granted_coins  DECIMAL(15,2)  DEFAULT 0,
            is_first_activation  TINYINT(1)     DEFAULT 1,
            created_at           DATETIME       DEFAULT CURRENT_TIMESTAMP,
            updated_at           DATETIME       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `, []);

    // Admin-configurable settings (coin pack price etc.)
    await dbcon.query(DB, `
        CREATE TABLE IF NOT EXISTS demo_settings (
            setting_key   VARCHAR(50)  PRIMARY KEY,
            setting_value VARCHAR(255) NOT NULL,
            updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `, []);

    // Seed default settings (won't overwrite existing)
    await dbcon.query(DB, `
        INSERT IGNORE INTO demo_settings (setting_key, setting_value) VALUES
        ('coin_pack_price',        '100'),
        ('coin_pack_coins',        '100000'),
        ('free_coins_on_signup',   '100000'),
        ('intraday_squareoff_time', '15:20:00'),
        ('expiry_squareoff_time',  '15:15:00'),
        ('allow_new_orders_on_expiry_day', 'true')
    `, []);

    _tablesReady = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns available coins = total granted + all SELL receipts - all BUY spends */
async function getAvailableCoins(dhanClientId) {
    const walletRows = await dbcon.query(DB,
        `SELECT total_granted_coins FROM demo_wallets WHERE dhan_client_id=?`,
        [dhanClientId]
    );
    const totalGranted = parseFloat(walletRows[0]?.total_granted_coins ?? 0);

    const pnlRows = await dbcon.query(DB,
        `SELECT COALESCE(SUM(
            CASE WHEN transaction_type='SELL' THEN price*quantity
                 ELSE -(price*quantity) END
         ), 0) AS trading_pnl
         FROM demo_orders
         WHERE dhan_client_id=? AND order_status='TRADED'`,
        [dhanClientId]
    );
    const tradingPnl = parseFloat(pnlRows[0]?.trading_pnl ?? 0);

    return parseFloat((totalGranted + tradingPnl).toFixed(2));
}
exports.getAvailableCoins = getAvailableCoins;

/** Returns { price, coins } for a coin pack */
async function getCoinPackSettings() {
    const rows = await dbcon.query(DB,
        `SELECT setting_key, setting_value FROM demo_settings WHERE setting_key IN ('coin_pack_price','coin_pack_coins')`,
        []
    );
    const map = {};
    (rows || []).forEach(r => { map[r.setting_key] = r.setting_value; });
    return {
        price: parseFloat(map['coin_pack_price'] ?? 100),
        coins: parseInt(map['coin_pack_coins']  ?? 100000),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /demo/activate  — call when user turns demo ON
// ─────────────────────────────────────────────────────────────────────────────
exports.activateDemo = async (req, res) => {
    try {
        await ensureTables();
        const { dhanClientId } = req.user;

        // Get or create wallet row
        let walletRow = await dbcon.query(DB,
            `SELECT * FROM demo_wallets WHERE dhan_client_id=?`,
            [dhanClientId]
        );

        let isFirstTime = false;

        if (!walletRow || walletRow.length === 0) {
            // Brand new user — grant free coins
            const freeCoinsRow = await dbcon.query(DB,
                `SELECT setting_value FROM demo_settings WHERE setting_key='free_coins_on_signup'`,
                []
            );
            const freeCoins = parseInt(freeCoinsRow[0]?.setting_value ?? FREE_COINS);

            await dbcon.query(DB,
                `INSERT INTO demo_wallets (dhan_client_id, total_granted_coins, is_first_activation) VALUES (?, ?, 0)`,
                [dhanClientId, freeCoins]
            );
            isFirstTime = true;

            console.log(`✅ [DEMO ACTIVATE] First time — granted ${freeCoins} free coins to ${dhanClientId}`);
        } else if (walletRow[0].is_first_activation == 1) {
            // Wallet exists but demo was never activated (edge case — shouldn't happen)
            const freeCoinsRow = await dbcon.query(DB,
                `SELECT setting_value FROM demo_settings WHERE setting_key='free_coins_on_signup'`,
                []
            );
            const freeCoins = parseInt(freeCoinsRow[0]?.setting_value ?? FREE_COINS);

            await dbcon.query(DB,
                `UPDATE demo_wallets SET total_granted_coins=?, is_first_activation=0 WHERE dhan_client_id=?`,
                [freeCoins, dhanClientId]
            );
            isFirstTime = true;
        }

        const availableCoins = await getAvailableCoins(dhanClientId);
        const packSettings   = await getCoinPackSettings();

        return res.json({
            status: true,
            data: {
                isFirstTime,
                availableCoins,
                totalGrantedCoins: parseFloat((await dbcon.query(DB,
                    `SELECT total_granted_coins FROM demo_wallets WHERE dhan_client_id=?`,
                    [dhanClientId]
                ))[0]?.total_granted_coins ?? 0),
                coinPackPrice: packSettings.price,
                coinPackCoins: packSettings.coins,
            },
        });
    } catch (error) {
        console.error('❌ [DEMO ACTIVATE] Error:', error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /demo/wallet  — coin balance summary
// ─────────────────────────────────────────────────────────────────────────────
exports.getDemoWallet = async (req, res) => {
    try {
        await ensureTables();
        const { dhanClientId } = req.user;

        const walletRow = await dbcon.query(DB,
            `SELECT total_granted_coins FROM demo_wallets WHERE dhan_client_id=?`,
            [dhanClientId]
        );

        if (!walletRow || walletRow.length === 0) {
            return res.json({ status: true, data: { availableCoins: 0, totalGrantedCoins: 0 } });
        }

        const availableCoins    = await getAvailableCoins(dhanClientId);
        const totalGrantedCoins = parseFloat(walletRow[0].total_granted_coins);
        const packSettings      = await getCoinPackSettings();

        return res.json({
            status: true,
            data: { availableCoins, totalGrantedCoins, coinPackPrice: packSettings.price, coinPackCoins: packSettings.coins },
        });
    } catch (error) {
        console.error('❌ [DEMO WALLET] Error:', error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /demo/coin-pack-price
// ─────────────────────────────────────────────────────────────────────────────
exports.getCoinPackPrice = async (req, res) => {
    try {
        await ensureTables();
        const pack = await getCoinPackSettings();
        return res.json({ status: true, data: pack });
    } catch (error) {
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /demo/purchase-coins  — adds a coin pack to user wallet
// Payment verification is handled separately by your payment flow;
// call this endpoint AFTER payment is confirmed.
// ─────────────────────────────────────────────────────────────────────────────
exports.purchaseCoins = async (req, res) => {
    try {
        await ensureTables();
        const { dhanClientId } = req.user;

        const pack = await getCoinPackSettings();

        // Add coins to wallet (upsert)
        await dbcon.query(DB,
            `INSERT INTO demo_wallets (dhan_client_id, total_granted_coins, is_first_activation)
             VALUES (?, ?, 0)
             ON DUPLICATE KEY UPDATE total_granted_coins = total_granted_coins + ?, is_first_activation = 0`,
            [dhanClientId, pack.coins, pack.coins]
        );

        const availableCoins = await getAvailableCoins(dhanClientId);

        console.log(`✅ [DEMO PURCHASE] +${pack.coins} coins for ${dhanClientId} — available: ${availableCoins}`);

        return res.json({
            status: true,
            message: `${pack.coins.toLocaleString()} Demo Coins added to your account`,
            data: { coinsAdded: pack.coins, availableCoins, coinPackPrice: pack.price },
        });
    } catch (error) {
        console.error('❌ [DEMO PURCHASE] Error:', error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /demo/order
// ─────────────────────────────────────────────────────────────────────────────
exports.placeOrder = async (req, res) => {
    try {
        await ensureTables();
        const { dhanClientId } = req.user;
        const {
            securityId,
            tradingSymbol: rawTradingSymbol,
            exchangeSegment,
            transactionType,
            orderType = 'MARKET',  // MARKET | LIMIT | SUPER
            productType: rawProductType = 'INTRADAY', // INTRADAY | DELIVERY
            quantity, price,
            targetPrice   = 0,
            stopLossPrice = 0,
            trailingJump  = 0,
        } = req.body;

        const tradingSymbol = rawTradingSymbol || securityId;
        const productType = String(rawProductType || 'INTRADAY').toUpperCase();

        console.log('='.repeat(50));
        console.log('📋 [DEMO ORDER] Incoming');
        console.log('  dhanClientId    :', dhanClientId);
        console.log('  securityId      :', securityId);
        console.log('  tradingSymbol   :', tradingSymbol);
        console.log('  orderType       :', orderType);
        console.log('  productType     :', productType);
        console.log('  transactionType :', transactionType);
        console.log('  quantity        :', quantity);
        console.log('  price           :', price);
        if (orderType === 'SUPER') {
            console.log('  targetPrice     :', targetPrice);
            console.log('  stopLossPrice   :', stopLossPrice);
        }
        console.log('='.repeat(50));

        if (!securityId || !tradingSymbol || !transactionType || !quantity || !price) {
            return res.json({ status: false, message: 'Missing required fields' });
        }
        if (!['INTRADAY', 'DELIVERY'].includes(productType)) {
            return res.json({ status: false, message: 'Invalid productType — must be INTRADAY or DELIVERY' });
        }
        // Expired/inactive contracts can't be traded — demo mirrors the exchange.
        const tradable = await instrumentStatus.checkTradable({ securityId, exchangeSegment });
        if (!tradable.ok) {
            return res.json({ status: false, message: tradable.message });
        }
        if (await _isExpiryDayOrderBlocked(securityId, productType)) {
            return res.json({ status: false, message: 'New Delivery orders are disabled for this contract on its expiry day' });
        }

        const qty       = Number(quantity);
        const clientPrc = parseFloat(price);
        const tgt       = parseFloat(targetPrice  || 0);
        const sl        = parseFloat(stopLossPrice || 0);
        const tj        = parseFloat(trailingJump  || 0);

        // ── Determine execution price + resulting order status ────────────────
        // MARKET: backend is authoritative — fill at the live Dhan LTP from
        // priceCache, not whatever the client happened to read locally.
        // Falls back to the client-sent price only if the cache has no data
        // yet (e.g. security not subscribed until this instant).
        // LIMIT: does NOT execute now — stored PENDING until the background
        // cron (helpers/syncDemoTrades.js checkPendingLimitOrders) sees the
        // live LTP satisfy the limit condition.
        // SUPER: unchanged — executes immediately, same as before.
        let execPrice = clientPrc;
        let orderStatus = 'TRADED';
        let executedAt = null;

        if (orderType === 'MARKET') {
            const livePrice = getPrice(securityId);
            execPrice = (livePrice != null && livePrice > 0) ? livePrice : clientPrc;
            executedAt = new Date();
        } else if (orderType === 'LIMIT') {
            if (!(clientPrc > 0)) {
                return res.json({ status: false, message: 'A valid limit price is required for LIMIT orders' });
            }
            orderStatus = 'PENDING';
            execPrice = null; // not filled yet
            console.log(`[DEMO LIMIT] created — ${transactionType} ${qty}x ${tradingSymbol} [${productType}] @ limit ₹${clientPrc}`);
        } else if (orderType === 'SUPER') {
            execPrice = clientPrc;
            executedAt = new Date();
        }

        // Drives amount/challenge/balance validation below — for a PENDING
        // LIMIT order this is the limit price (what it WOULD cost if filled);
        // for MARKET/SUPER it's the actual execution price.
        const prc    = orderType === 'LIMIT' ? clientPrc : execPrice;
        const amount = qty * prc;

        // Validate SUPER order fields
        let rrWarning = null;
        if (orderType === 'SUPER' && transactionType === 'BUY') {
            if (tgt > 0 && tgt <= prc) {
                return res.json({ status: false, message: 'Target price must be above buy price for SUPER order' });
            }
            if (sl > 0 && sl >= prc) {
                return res.json({ status: false, message: 'Stop Loss must be below buy price for SUPER order' });
            }
            // PHASE 2: Risk-Reward validation (warning only, doesn't block)
            if (tgt > 0 && sl > 0) {
                const rr = advChallenge.checkRiskReward(tgt, sl, prc, true);
                if (rr.warning) rrWarning = rr.message;
            }
        }

        // ── Full challenge rule check for BUY (P&L, trade count, capital) ───
        // SELL orders are always allowed — user must be able to close open positions.
        if (transactionType === 'BUY') {
            const rule = await checkDemoChallengeRules(dhanClientId, amount, tradingSymbol, qty, securityId);
            if (rule.blocked) {
                const isQtyRule = rule.reason === 'QUANTITY_RULE';
                return res.json({
                    status: false,
                    message: rule.message || `Demo challenge limit reached: ${rule.reason}`,
                    challengeBlocked: !isQtyRule,
                    reason: rule.reason,
                    pauseEnd: rule.pauseEnd,
                });
            }
        }

        if (transactionType === 'BUY') {
            const available = await getAvailableCoins(dhanClientId);
            if (available < amount) {
                return res.json({
                    status: false,
                    message: `Insufficient Demo Coins. Available: ${Math.floor(available).toLocaleString()} coins, Required: ${Math.floor(amount).toLocaleString()} coins`,
                });
            }
        } else if (transactionType === 'SELL') {
            // INTRADAY and DELIVERY are separate holding pools — a SELL of one
            // product type only draws against that same product type's BUYs.
            const netQty = await demoFifo.getNetQty({ dhanClientId, securityId, productType });
            if (qty > netQty) {
                return res.json({
                    status: false,
                    message: `Cannot sell ${qty} — you only hold ${netQty} units of ${tradingSymbol} (${productType})`,
                });
            }
        }

        // ── Calculate P&L for SELL orders using FIFO cost basis ───────────────
        // Mirrors how challenge_trade_logs.pnl is stored in real trading.
        // Only computed for orders that execute NOW (MARKET/SUPER) — a PENDING
        // LIMIT SELL has no fill price yet, so P&L is computed later by the
        // cron (checkPendingLimitOrders) at the moment it actually fills.
        let orderPnl = 0;
        if (transactionType === 'SELL' && orderStatus === 'TRADED') {
            const { avgCostBasis } = await demoFifo.computeAvgCostBasis({
                dhanClientId, securityId, productType, sellQty: qty,
            });
            orderPnl = parseFloat(((execPrice - avgCostBasis) * qty).toFixed(2));

            // ── PHASE 2: Holding discipline + panic selling detection ──
            try {
                const challRows = await dbcon.query(DB,
                    `SELECT * FROM user_challenges WHERE dhan_client_id=? AND is_active=1 LIMIT 1`,
                    [dhanClientId]);
                const challenge = challRows?.[0];
                if (challenge) {
                    const holdCheck = await advChallenge.checkHoldingDiscipline(dhanClientId, challenge, securityId, true);
                    if (holdCheck.warning) {
                        console.log(`[DEMO Phase2] Holding discipline warning: ${holdCheck.message}`);
                    }

                    const lastBuyRows = await dbcon.query(DB,
                        `SELECT last_buy_time FROM challenge_session_state
                         WHERE dhan_client_id=? AND challenge_id=? AND trade_date=CURDATE() LIMIT 1`,
                        [dhanClientId, challenge.id]);
                    const lastBuyTime = lastBuyRows?.[0]?.last_buy_time;
                    const holdingMinutes = lastBuyTime ? (Date.now() - new Date(lastBuyTime).getTime()) / 60000 : 999;

                    await advChallenge.checkPanicSelling(dhanClientId, challenge, orderPnl, holdingMinutes);
                }
            } catch (e) { console.log('[DEMO Phase2] SELL check error:', e.message); }
        }

        const insertResult = await dbcon.query(DB,
            `INSERT INTO demo_orders
             (dhan_client_id, security_id, trading_symbol, exchange_segment,
              transaction_type, order_type, product_type, quantity, price,
              target_price, stop_loss_price, trailing_jump, order_status,
              executed_price, executed_at, pnl)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [dhanClientId, securityId, tradingSymbol, exchangeSegment || '',
             transactionType, orderType, productType, qty, prc,
             tgt, sl, tj, orderStatus, execPrice, executedAt, orderPnl]
        );
        const newOrderId = insertResult?.insertId || 0;

        const availableCoins = await getAvailableCoins(dhanClientId);

        let msg;
        if (orderStatus === 'PENDING') {
            msg = `Demo ${transactionType.toLowerCase()} LIMIT order placed — pending at ₹${clientPrc}`;
        } else {
            msg = `Demo ${transactionType.toLowerCase()} ${orderType.toLowerCase()} order placed`;
            if (orderType === 'SUPER' && tgt > 0) msg += ` | Target ₹${tgt} | SL ₹${sl}`;
        }

        console.log(`✅ [DEMO ORDER] ${transactionType} ${qty} x ${tradingSymbol} [${productType}] ` +
            (orderStatus === 'TRADED' ? `@ ₹${execPrice}` : `PENDING @ limit ₹${clientPrc}`) +
            ` — coins left: ${availableCoins}`);

        // Push notification for the order itself
        const pnlStr = (transactionType === 'SELL' && orderStatus === 'TRADED' && orderPnl !== 0)
            ? `  |  P&L ₹${orderPnl > 0 ? '+' : ''}${orderPnl.toFixed(0)}`
            : '';
        if (orderStatus === 'PENDING') {
            _notifyUser(
                dhanClientId,
                `⏳ DEMO ${transactionType} LIMIT Order Placed`,
                `${tradingSymbol}  •  Qty: ${qty}  •  Pending @ ₹${clientPrc.toFixed(2)}`,
                newOrderId
            );
        } else {
            _notifyUser(
                dhanClientId,
                `${transactionType === 'BUY' ? '🟢 DEMO BUY' : '🔴 DEMO SELL'} Order Placed`,
                `${tradingSymbol}  •  Qty: ${qty}  @  ₹${execPrice.toFixed(2)}${pnlStr}`,
                newOrderId
            );
        }

        // After SELL: check if final realized P&L crosses the challenge limit → block.
        // After BUY: no action here — live floating P&L is checked by the background
        // cron (checkDemoPnlNotification) which sends a NOTIFY-ONLY alert.
        // Only relevant for orders that actually executed now — a PENDING LIMIT
        // order has no realized P&L yet.
        if (transactionType === 'SELL' && orderStatus === 'TRADED') {
            checkRealizedPnlBlock(dhanClientId);
            // ── Advanced: start cooldown + track consecutive losses ──
            onTradeExit(dhanClientId, orderPnl, tradingSymbol);
        }

        return res.json({
            status: true,
            message: orderStatus === 'PENDING'
                ? msg
                : `${msg} — ${Math.floor(availableCoins).toLocaleString()} coins remaining`,
            data: { availableCoins, riskRewardWarning: rrWarning, orderStatus, executedPrice: execPrice, orderId: newOrderId },
        });
    } catch (error) {
        console.error('❌ [DEMO ORDER] Error:', error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /demo/orders
// ─────────────────────────────────────────────────────────────────────────────
exports.getOrders = async (req, res) => {
    try {
        await ensureTables();
        const { dhanClientId } = req.user;

        // status=OPEN -> still-pending LIMIT orders; status=EXECUTED -> final
        // states (TRADED/CANCELLED/REJECTED/EXPIRED). Previously this ignored
        // the status filter entirely and always returned every order ever
        // placed, so the Open and Executed tabs showed identical, unbounded
        // history — mirrors DhanController.getOrderList's OPEN/CLOSED split.
        const filterMode = (req.query.status || req.body.status || '').toUpperCase();
        const statusFilter = filterMode === 'OPEN'
            ? "AND o.order_status='PENDING'"
            : filterMode === 'EXECUTED'
                ? "AND o.order_status IN ('TRADED','CANCELLED','REJECTED','EXPIRED')"
                : '';

        // Scoped to today, like a real broker's order book — full history
        // isn't what either tab is meant to show.
        const rows = await dbcon.query(DB,
            `SELECT o.*,
                    COALESCE(
                        IF(o.trading_symbol REGEXP '^[0-9]+$', NULL, o.trading_symbol),
                        i.display_name,
                        o.trading_symbol
                    ) AS trading_symbol
             FROM demo_orders o
             LEFT JOIN instruments i ON i.security_id = o.security_id
             WHERE o.dhan_client_id=? AND DATE(o.created_at)=CURDATE() ${statusFilter}
             ORDER BY o.created_at DESC`,
            [dhanClientId]
        );

        return res.json({ status: true, data: rows || [] });
    } catch (error) {
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/trading/trade-history (mode=DEMO)
// Demo-mode equivalent of DhanController.getTradeHistory — same response
// shape (status/totalRawTrades/summary/data, same TradePosition/TradeOrder
// field names) so the existing Flutter models parse it unchanged, but reads
// demo_orders instead of Dhan's live trades API. Realized P&L per security
// comes straight from the FIFO `pnl` already stored on each SELL row
// (computed via demoFifo.computeAvgCostBasis at execution time in
// placeOrder) rather than recomputing an avgPrice*closedQty approximation —
// that's accurate across multiple partial buys, which the approximation
// used on the real-money side is not.
// ─────────────────────────────────────────────────────────────────────────────
exports.getTradeHistory = async (req, res) => {
    try {
        await ensureTables();
        const { dhanClientId } = req.user;
        const { fromDate, toDate } = req.body;

        if (!fromDate || !toDate) {
            return res.json({ status: false, message: "fromDate and toDate are required (YYYY-MM-DD)" });
        }

        const rows = await dbcon.query(DB,
            `SELECT o.id, o.security_id, o.exchange_segment, o.transaction_type,
                    o.product_type, o.quantity, o.executed_price, o.price,
                    o.executed_at, o.created_at, o.pnl,
                    COALESCE(
                        IF(o.trading_symbol REGEXP '^[0-9]+$', NULL, o.trading_symbol),
                        i.display_name,
                        o.trading_symbol
                    ) AS trading_symbol,
                    i.instrument, i.sm_expiry_date, i.option_type, i.strike_price
             FROM demo_orders o
             LEFT JOIN instruments i ON i.security_id = o.security_id
             WHERE o.dhan_client_id=? AND o.order_status='TRADED'
               AND DATE(o.created_at) BETWEEN ? AND ?
             ORDER BY o.created_at ASC`,
            [dhanClientId, fromDate, toDate]
        );

        const trades = rows || [];

        // Group: date → securityId → { meta, buys[], sells[] }
        const byDate = {};
        for (const t of trades) {
            const dateKey = new Date(t.created_at).toISOString().split('T')[0];
            if (!byDate[dateKey]) byDate[dateKey] = {};

            const sid = t.security_id;
            if (!byDate[dateKey][sid]) {
                byDate[dateKey][sid] = {
                    customSymbol: t.trading_symbol,
                    securityId: sid,
                    exchangeSegment: t.exchange_segment,
                    productType: t.product_type,
                    instrument: t.instrument || 'EQUITY',
                    drvExpiryDate: t.sm_expiry_date,
                    drvOptionType: t.option_type,
                    drvStrikePrice: t.strike_price != null ? parseFloat(t.strike_price) : null,
                    buys: [],
                    sells: [],
                    sellPnl: 0,
                };
            }

            const data = byDate[dateKey][sid];
            const execPrice = parseFloat(t.executed_price != null ? t.executed_price : t.price);
            const exchangeTime = (t.executed_at ? new Date(t.executed_at) : new Date(t.created_at)).toISOString();
            const leg = {
                orderId: String(t.id),
                tradedQuantity: Number(t.quantity),
                tradedPrice: execPrice,
                exchangeTime,
                charges: 0, // demo trades have no real brokerage/taxes
            };

            if (t.transaction_type === 'BUY') {
                data.buys.push(leg);
            } else if (t.transaction_type === 'SELL') {
                data.sells.push(leg);
                data.sellPnl += parseFloat(t.pnl || 0);
            }
        }

        const result = {};
        for (const [date, securities] of Object.entries(byDate)) {
            result[date] = [];
            for (const data of Object.values(securities)) {
                const totalBuyQty = data.buys.reduce((s, l) => s + l.tradedQuantity, 0);
                const totalSellQty = data.sells.reduce((s, l) => s + l.tradedQuantity, 0);
                const avgBuyPrice = totalBuyQty > 0
                    ? data.buys.reduce((s, l) => s + l.tradedPrice * l.tradedQuantity, 0) / totalBuyQty
                    : 0;
                const avgSellPrice = totalSellQty > 0
                    ? data.sells.reduce((s, l) => s + l.tradedPrice * l.tradedQuantity, 0) / totalSellQty
                    : 0;

                const grossPnL = totalSellQty > 0 ? Math.round(data.sellPnl * 100) / 100 : null;
                const totalCharges = 0;
                const netPnL = grossPnL;

                let status = 'OPEN';
                if (totalSellQty >= totalBuyQty && totalBuyQty > 0) status = 'COMPLETED';
                else if (totalSellQty > 0) status = 'PARTIAL';

                result[date].push({
                    customSymbol: data.customSymbol,
                    securityId: data.securityId,
                    exchangeSegment: data.exchangeSegment,
                    productType: data.productType,
                    instrument: data.instrument,
                    drvExpiryDate: data.drvExpiryDate,
                    drvOptionType: data.drvOptionType,
                    drvStrikePrice: data.drvStrikePrice,
                    totalBuyQty,
                    totalSellQty,
                    avgBuyPrice: Math.round(avgBuyPrice * 100) / 100,
                    avgSellPrice: Math.round(avgSellPrice * 100) / 100,
                    status,
                    grossPnL,
                    totalCharges,
                    netPnL,
                    buyOrders: data.buys,
                    sellOrders: data.sells,
                });
            }

            result[date].sort((a, b) => {
                const aTime = a.buyOrders[0]?.exchangeTime || a.sellOrders[0]?.exchangeTime || '';
                const bTime = b.buyOrders[0]?.exchangeTime || b.sellOrders[0]?.exchangeTime || '';
                return aTime.localeCompare(bTime);
            });
        }

        const sorted = Object.fromEntries(
            Object.entries(result).sort(([a], [b]) => b.localeCompare(a))
        );

        const summary = Object.entries(sorted).map(([date, dayRows]) => ({
            date,
            totalTrades: dayRows.length,
            grossPnL: Math.round(dayRows.reduce((s, r) => s + (r.grossPnL || 0), 0) * 100) / 100,
            totalCharges: 0,
            netPnL: Math.round(dayRows.reduce((s, r) => s + (r.netPnL || 0), 0) * 100) / 100,
        }));

        return res.json({
            status: true,
            totalRawTrades: trades.length,
            summary,
            data: sorted,
        });
    } catch (error) {
        console.log('[DEMO TRADE HISTORY ERROR]', error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /demo/portfolio
// ─────────────────────────────────────────────────────────────────────────────
exports.getPortfolio = async (req, res) => {
    try {
        await ensureTables();
        const { dhanClientId } = req.user;

        // Fetch all traded orders oldest-first.
        // JOIN instruments to resolve display_name for old rows where trading_symbol was stored as securityId.
        // is_today: used to split today vs earlier for display purposes.
        const allOrders = await dbcon.query(DB,
            `SELECT o.security_id, o.product_type,
                    COALESCE(
                        IF(o.trading_symbol REGEXP '^[0-9]+$', NULL, o.trading_symbol),
                        i.display_name,
                        o.trading_symbol
                    ) AS trading_symbol,
                    o.exchange_segment,
                    o.transaction_type, o.quantity, o.price, o.created_at,
                    (DATE(o.created_at) = CURDATE()) AS is_today
             FROM demo_orders o
             LEFT JOIN instruments i ON i.security_id = o.security_id
             WHERE o.dhan_client_id=? AND o.order_status='TRADED'
             ORDER BY o.created_at ASC`,
            [dhanClientId]
        );

        // Group by (security, product_type) — INTRADAY and DELIVERY are
        // separate FIFO pools (see helpers/demoFifo.js), so a position built
        // from intraday buys is never netted against delivery buys of the
        // same security, and vice versa.
        const secMap = {};
        for (const row of (allOrders || [])) {
            const key = `${row.security_id}::${row.product_type || 'INTRADAY'}`;
            if (!secMap[key]) {
                secMap[key] = {
                    securityId:      row.security_id,
                    productType:     row.product_type || 'INTRADAY',
                    tradingSymbol:   row.trading_symbol,
                    exchangeSegment: row.exchange_segment,
                    buyQueue:    [],   // FIFO queue of open buy lots { qty, price }
                    closedToday: [],   // realized P&L records for today's sells
                };
            }
            const sec = secMap[key];

            if (row.transaction_type === 'BUY') {
                sec.buyQueue.push({ qty: Number(row.quantity), price: parseFloat(row.price) });
            } else {
                // SELL — match against oldest buys (FIFO)
                let sellQty    = Number(row.quantity);
                const sellPrice = parseFloat(row.price);
                let matchedQty  = 0;
                let totalCost   = 0;

                while (sellQty > 0 && sec.buyQueue.length > 0) {
                    const oldest = sec.buyQueue[0];
                    if (oldest.qty <= sellQty) {
                        totalCost  += oldest.qty * oldest.price;
                        matchedQty += oldest.qty;
                        sellQty    -= oldest.qty;
                        sec.buyQueue.shift();
                    } else {
                        totalCost    += sellQty * oldest.price;
                        matchedQty   += sellQty;
                        oldest.qty   -= sellQty;
                        sellQty       = 0;
                    }
                }

                if (matchedQty > 0) {
                    const avgBuyPrice = totalCost / matchedQty;
                    sec.closedToday.push({
                        qty:         matchedQty,
                        avgBuyPrice: parseFloat(avgBuyPrice.toFixed(2)),
                        sellPrice,
                        pnl:         parseFloat(((sellPrice - avgBuyPrice) * matchedQty).toFixed(2)),
                        isToday:     !!row.is_today,
                    });
                }
            }
        }

        // Build final response
        const positions      = [];
        const closedToday    = [];   // today's sells only, per security
        const closedAllTime  = [];   // all-time sells, per security
        let totalRealizedPnl = 0;

        for (const data of Object.values(secMap)) {
            // Open positions
            const netQty = data.buyQueue.reduce((s, b) => s + b.qty, 0);
            if (netQty > 0) {
                const totalCost = data.buyQueue.reduce((s, b) => s + b.qty * b.price, 0);
                positions.push({
                    securityId:      data.securityId,
                    productType:     data.productType,
                    tradingSymbol:   data.tradingSymbol,
                    exchangeSegment: data.exchangeSegment,
                    netQuantity:     netQty,
                    avgBuyPrice:     parseFloat((totalCost / netQty).toFixed(2)),
                });
            }

            if (data.closedToday.length === 0) continue;

            // All-time entry (all sells for this security)
            const aQty  = data.closedToday.reduce((s, t) => s + t.qty, 0);
            const aPnl  = data.closedToday.reduce((s, t) => s + t.pnl, 0);
            const aSell = data.closedToday.reduce((s, t) => s + t.sellPrice   * t.qty, 0) / aQty;
            const aBuy  = data.closedToday.reduce((s, t) => s + t.avgBuyPrice * t.qty, 0) / aQty;
            totalRealizedPnl += aPnl;
            closedAllTime.push({
                securityId:      data.securityId,
                productType:     data.productType,
                tradingSymbol:   data.tradingSymbol,
                exchangeSegment: data.exchangeSegment,
                qty:             aQty,
                avgBuyPrice:     parseFloat(aBuy.toFixed(2)),
                avgSellPrice:    parseFloat(aSell.toFixed(2)),
                pnl:             parseFloat(aPnl.toFixed(2)),
                isToday:         data.closedToday.some(t => t.isToday),
            });

            // Today-only entry (only today's sell lots for this security)
            const todayEntries = data.closedToday.filter(t => t.isToday);
            if (todayEntries.length > 0) {
                const tQty  = todayEntries.reduce((s, t) => s + t.qty, 0);
                const tPnl  = todayEntries.reduce((s, t) => s + t.pnl, 0);
                const tSell = todayEntries.reduce((s, t) => s + t.sellPrice   * t.qty, 0) / tQty;
                const tBuy  = todayEntries.reduce((s, t) => s + t.avgBuyPrice * t.qty, 0) / tQty;
                closedToday.push({
                    securityId:      data.securityId,
                    productType:     data.productType,
                    tradingSymbol:   data.tradingSymbol,
                    exchangeSegment: data.exchangeSegment,
                    qty:             tQty,
                    avgBuyPrice:     parseFloat(tBuy.toFixed(2)),
                    avgSellPrice:    parseFloat(tSell.toFixed(2)),
                    pnl:             parseFloat(tPnl.toFixed(2)),
                    isToday:         true,
                });
            }
        }

        return res.json({
            status: true,
            data: {
                positions,
                realizedPnl: parseFloat(totalRealizedPnl.toFixed(2)),
                closedToday,
                closedAllTime,
            },
        });
    } catch (error) {
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /demo/order/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.cancelOrder = async (req, res) => {
    try {
        await ensureTables();
        const { dhanClientId } = req.user;
        const orderId = req.params.id || req.body.orderId;

        if (!orderId) return res.json({ status: false, message: 'Missing orderId' });

        const order = await dbcon.query(DB,
            `SELECT * FROM demo_orders WHERE id=? AND dhan_client_id=?`,
            [orderId, dhanClientId]
        );

        if (!order || !order[0]) return res.json({ status: false, message: 'Order not found' });
        if (order[0].order_status !== 'PENDING') {
            return res.json({ status: false, message: 'Only a pending order can be cancelled' });
        }

        // Atomic claim — guards against the background cron (checkPendingLimitOrders)
        // executing this exact order in the same instant. No transaction support
        // exists in this codebase (config/mysqlClient.js), so this conditional
        // UPDATE + affectedRows check is the concurrency-safety mechanism.
        const result = await dbcon.query(DB,
            `UPDATE demo_orders SET order_status='CANCELLED', updated_at=NOW() WHERE id=? AND order_status='PENDING'`,
            [orderId]
        );
        if (!result || result.affectedRows !== 1) {
            console.log(`[DEMO LIMIT] cancel race — order #${orderId} was already claimed (executed/cancelled) by another process`);
            return res.json({ status: false, message: 'Order was already executed or cancelled' });
        }

        const availableCoins = await getAvailableCoins(dhanClientId);

        _notifyUser(
            dhanClientId,
            '🗑️ Demo Order Cancelled',
            `Order #${orderId} — ${order[0].trading_symbol || order[0].security_id} has been cancelled`,
            orderId
        );

        return res.json({ status: true, message: 'Demo order cancelled', data: { availableCoins } });
    } catch (error) {
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /demo/reset  — clear all orders, restore original granted coins
// ─────────────────────────────────────────────────────────────────────────────
exports.resetDemo = async (req, res) => {
    try {
        await ensureTables();
        const { dhanClientId } = req.user;

        await dbcon.query(DB,
            `DELETE FROM demo_orders WHERE dhan_client_id=?`,
            [dhanClientId]
        );

        // Restore wallet to its granted amount (keeps any purchased packs)
        const walletRow = await dbcon.query(DB,
            `SELECT total_granted_coins FROM demo_wallets WHERE dhan_client_id=?`,
            [dhanClientId]
        );
        const totalGranted = parseFloat(walletRow[0]?.total_granted_coins ?? FREE_COINS);

        _notifyUser(
            dhanClientId,
            '🔄 Demo Account Reset',
            `Your demo account has been reset. ${totalGranted} Demo Coins restored.`
        );

        return res.json({
            status: true,
            message: 'Demo account reset. Your Demo Coins have been restored.',
            data: { availableCoins: totalGranted },
        });
    } catch (error) {
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /demo/modify-order  — modify price/quantity of a pending order
// ─────────────────────────────────────────────────────────────────────────────
exports.modifyOrder = async (req, res) => {
    try {
        await ensureTables();
        const { dhanClientId } = req.user;
        const { orderId, newPrice, newQuantity } = req.body;

        if (!orderId || !newPrice || !newQuantity) {
            return res.json({ status: false, message: 'Missing orderId, newPrice, or newQuantity' });
        }

        const prc = parseFloat(newPrice);
        const qty = parseInt(newQuantity, 10);
        if (!(prc > 0) || !(qty > 0)) {
            return res.json({ status: false, message: 'newPrice and newQuantity must be greater than 0' });
        }

        const order = await dbcon.query(DB,
            `SELECT * FROM demo_orders WHERE id=? AND dhan_client_id=?`,
            [orderId, dhanClientId]
        );

        if (!order || !order[0]) {
            return res.json({ status: false, message: 'Order not found' });
        }
        if (order[0].order_status !== 'PENDING') {
            return res.json({ status: false, message: 'Only a pending order can be modified' });
        }

        // Atomic claim — same race guard as cancelOrder (see comment there).
        const result = await dbcon.query(DB,
            `UPDATE demo_orders SET price=?, quantity=?, updated_at=NOW() WHERE id=? AND order_status='PENDING'`,
            [prc, qty, orderId]
        );
        if (!result || result.affectedRows !== 1) {
            console.log(`[DEMO LIMIT] modify race — order #${orderId} was already claimed by another process`);
            return res.json({ status: false, message: 'Order was already executed or cancelled' });
        }

        const availableCoins = await getAvailableCoins(dhanClientId);

        _notifyUser(
            dhanClientId,
            '📝 Demo Order Modified',
            `Order #${orderId} updated  |  Qty: ${newQuantity}  @  ₹${newPrice}`,
            orderId
        );

        return res.json({
            status: true,
            message: 'Demo order modified successfully',
            data: { availableCoins, orderId },
        });
    } catch (error) {
        console.error('❌ [DEMO MODIFY ORDER]', error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /demo/challenge-info  — return the user's active challenge limits
// Used by frontend to display trading capital and other limits in trade sheet
// ─────────────────────────────────────────────────────────────────────────────
exports.getChallengeInfo = async (req, res) => {
    try {
        const { dhanClientId } = req.user;
        const rows = await dbcon.query(DB,
            `SELECT trading_capital, max_profit, max_loss, max_trades_per_day,
                    nifty_lots, banknifty_lots, finnifty_lots, midcapnifty_lots, sensex_lots,
                    challenge_status
             FROM user_challenges
             WHERE dhan_client_id=? AND is_active=1 LIMIT 1`,
            [dhanClientId]
        );
        if (!rows || rows.length === 0) {
            return res.json({ status: true, data: null });
        }
        const c = rows[0];
        return res.json({
            status: true,
            data: {
                tradingCapital:   Number(c.trading_capital    || 0),
                maxProfit:        Number(c.max_profit         || 0),
                maxLoss:          Number(c.max_loss           || 0),
                maxTradesPerDay:  Number(c.max_trades_per_day || 0),
                niftyLots:        Number(c.nifty_lots         || 0),
                bankNiftyLots:    Number(c.banknifty_lots     || 0),
                finNiftyLots:     Number(c.finnifty_lots      || 0),
                midcapNiftyLots:  Number(c.midcapnifty_lots   || 0),
                sensexLots:       Number(c.sensex_lots        || 0),
                challengeStatus:  c.challenge_status,
            },
        });
    } catch (error) {
        console.error('❌ [DEMO CHALLENGE INFO]', error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /demo/order/:orderId  — get single order details
// ─────────────────────────────────────────────────────────────────────────────
exports.getOrderDetails = async (req, res) => {
    try {
        await ensureTables();
        const { dhanClientId } = req.user;
        const orderId = req.params.orderId || req.body.orderId;

        if (!orderId) {
            return res.json({ status: false, message: 'Missing orderId' });
        }

        const order = await dbcon.query(DB,
            `SELECT * FROM demo_orders WHERE id=? AND dhan_client_id=?`,
            [orderId, dhanClientId]
        );

        if (!order || !order[0]) {
            return res.json({ status: false, message: 'Order not found' });
        }

        const orderData = order[0];

        return res.json({
            status: true,
            data: {
                id: orderData.id,
                orderId: orderData.id,
                securityId: orderData.security_id,
                tradingSymbol: orderData.trading_symbol,
                exchangeSegment: orderData.exchange_segment,
                transactionType: orderData.transaction_type,
                orderType: orderData.order_type,
                quantity: orderData.quantity,
                price: orderData.price,
                status: orderData.order_status,
                targetPrice: orderData.target_price,
                stopLossPrice: orderData.stop_loss_price,
                createdAt: orderData.created_at,
                updatedAt: orderData.updated_at,
            },
        });
    } catch (error) {
        console.error('❌ [DEMO GET ORDER DETAILS]', error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /demo/block-status
// Returns whether the user's demo challenge is currently blocked, along with
// unlock count and pause_end so Flutter can render the correct unlock screen.
// ─────────────────────────────────────────────────────────────────────────────
exports.getDemoBlockStatus = async (req, res) => {
    try {
        const { dhanClientId } = req.user;

        const check = await isDemoUserBlocked(dhanClientId);

        const unlockCount = await dbcon.query(DB,
            `SELECT COUNT(*) AS total FROM challenge_pause_logs
             WHERE dhan_client_id=? AND quick_unlock_used=1 AND DATE(pause_end)=CURDATE()`,
            [dhanClientId]
        );

        return res.json({
            status: true,
            isBlocked: check.blocked,
            reason: check.reason || null,
            pauseEnd: check.pauseEnd || null,
            message: check.message || null,
            unlocksUsedToday: Number(unlockCount?.[0]?.total || 0),
        });
    } catch (error) {
        console.error('❌ [DEMO BLOCK STATUS]', error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /demo/quick-unlock
// Proxies to the shared quickUnlock in ChallengeController.
// Handles coin deduction (INSTANT) or timed free unlock (FREE).
// After INSTANT unlock: challenge_status reset to ACTIVE immediately.
// After FREE unlock: status auto-clears when pause_end expires.
// In both cases a new session starts from the unlock time, resetting P&L.
// ─────────────────────────────────────────────────────────────────────────────
exports.demoQuickUnlock = async (req, res) => {
    const { quickUnlock } = require('./ChallengeController');
    return quickUnlock(req, res);
};
