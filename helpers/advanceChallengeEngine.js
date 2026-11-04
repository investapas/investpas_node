const dbcon = require('../config/mysqlClient');
const constants = require('../vars/constants');
const utility = require('./utility');
const query = require('./query');

const DB = constants.vals.defaultDB;

let _migrated = false;
async function _ensureMigration() {
    if (_migrated) return;
    try {
        const col = await dbcon.query(DB,
            `SELECT COUNT(*) AS cnt FROM information_schema.columns
             WHERE table_schema=DATABASE() AND table_name='user_challenges' AND column_name='trading_style'`);
        if (Number(col?.[0]?.cnt || 0) === 0) {
            const stmts = [
                `ALTER TABLE user_challenges ADD COLUMN trading_style ENUM('SCALPER','INTRADAY','SWING','EQUITY','OPTIONS_BUYER','OPTIONS_SELLER') DEFAULT 'SCALPER' AFTER dhan_client_id`,
                `ALTER TABLE user_challenges ADD COLUMN cooldown_minutes INT DEFAULT 5 AFTER max_trades_per_day`,
                `ALTER TABLE user_challenges ADD COLUMN consecutive_loss_limit INT DEFAULT 3 AFTER cooldown_minutes`,
                `ALTER TABLE user_challenges ADD COLUMN max_capital_per_trade_pct INT DEFAULT 25 AFTER consecutive_loss_limit`,
                `ALTER TABLE user_challenges ADD COLUMN risk_per_trade_pct DECIMAL(5,2) DEFAULT 2.50 AFTER max_capital_per_trade_pct`,
                `ALTER TABLE user_challenges ADD COLUMN target_per_trade_pct DECIMAL(5,2) DEFAULT 5.00 AFTER risk_per_trade_pct`,
                `ALTER TABLE user_challenges ADD COLUMN hero_trade_allowed TINYINT(1) DEFAULT 1 AFTER target_per_trade_pct`,
            ];
            for (const s of stmts) { try { await dbcon.query(DB, s, []); } catch (_) {} }
        }

        const tbl = await dbcon.query(DB,
            `SELECT COUNT(*) AS cnt FROM information_schema.tables
             WHERE table_schema=DATABASE() AND table_name='challenge_session_state'`);
        if (Number(tbl?.[0]?.cnt || 0) === 0) {
            await dbcon.query(DB,
                `CREATE TABLE IF NOT EXISTS challenge_session_state (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    dhan_client_id VARCHAR(50) NOT NULL,
                    challenge_id INT NOT NULL,
                    trade_date DATE NOT NULL,
                    consecutive_losses INT DEFAULT 0,
                    last_trade_exit_time DATETIME DEFAULT NULL,
                    cooldown_end DATETIME DEFAULT NULL,
                    hero_trade_used TINYINT(1) DEFAULT 0,
                    daily_stop_triggered TINYINT(1) DEFAULT 0,
                    last_quantity INT DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY idx_session (dhan_client_id, challenge_id, trade_date)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, []);
        }

        // Phase 2: OTM trade tracking for lottery trade detection
        const otmTbl = await dbcon.query(DB,
            `SELECT COUNT(*) AS cnt FROM information_schema.tables
             WHERE table_schema=DATABASE() AND table_name='otm_trade_log'`);
        if (Number(otmTbl?.[0]?.cnt || 0) === 0) {
            await dbcon.query(DB,
                `CREATE TABLE IF NOT EXISTS otm_trade_log (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    dhan_client_id VARCHAR(50) NOT NULL,
                    trading_symbol VARCHAR(150) NOT NULL,
                    premium DECIMAL(12,2) NOT NULL,
                    trade_date DATE NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    KEY idx_otm (dhan_client_id, trade_date)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, []);
        }

        // Phase 2: position holding time tracking
        const holdCol = await dbcon.query(DB,
            `SELECT COUNT(*) AS cnt FROM information_schema.columns
             WHERE table_schema=DATABASE() AND table_name='challenge_session_state' AND column_name='last_buy_time'`);
        if (Number(holdCol?.[0]?.cnt || 0) === 0) {
            try { await dbcon.query(DB, `ALTER TABLE challenge_session_state ADD COLUMN last_buy_time DATETIME DEFAULT NULL`, []); } catch (_) {}
            try { await dbcon.query(DB, `ALTER TABLE challenge_session_state ADD COLUMN last_buy_security_id VARCHAR(20) DEFAULT NULL`, []); } catch (_) {}
            try { await dbcon.query(DB, `ALTER TABLE challenge_session_state ADD COLUMN last_buy_price DECIMAL(12,2) DEFAULT NULL`, []); } catch (_) {}
            try { await dbcon.query(DB, `ALTER TABLE challenge_session_state ADD COLUMN peak_pnl_today DECIMAL(12,2) DEFAULT 0`, []); } catch (_) {}
            try { await dbcon.query(DB, `ALTER TABLE challenge_session_state ADD COLUMN avg_quantity DECIMAL(12,2) DEFAULT 0`, []); } catch (_) {}
        }

        // Phase 2: discipline score on user_challenges
        const dsCol = await dbcon.query(DB,
            `SELECT COUNT(*) AS cnt FROM information_schema.columns
             WHERE table_schema=DATABASE() AND table_name='user_challenges' AND column_name='holding_period_intent'`);
        if (Number(dsCol?.[0]?.cnt || 0) === 0) {
            try { await dbcon.query(DB, `ALTER TABLE user_challenges ADD COLUMN holding_period_intent ENUM('SHORT','MEDIUM','LONG') DEFAULT 'SHORT'`, []); } catch (_) {}
        }
    } catch (_) {}
    _migrated = true;
}

async function _getSession(dhanClientId, challengeId) {
    await _ensureMigration();
    const rows = await dbcon.query(DB,
        `SELECT * FROM challenge_session_state
         WHERE dhan_client_id=? AND challenge_id=? AND trade_date=CURDATE() LIMIT 1`,
        [dhanClientId, challengeId]);

    if (rows?.[0]) return rows[0];

    await dbcon.query(DB,
        `INSERT INTO challenge_session_state (dhan_client_id, challenge_id, trade_date)
         VALUES (?, ?, CURDATE())
         ON DUPLICATE KEY UPDATE updated_at=NOW()`,
        [dhanClientId, challengeId]);

    const fresh = await dbcon.query(DB,
        `SELECT * FROM challenge_session_state
         WHERE dhan_client_id=? AND challenge_id=? AND trade_date=CURDATE() LIMIT 1`,
        [dhanClientId, challengeId]);
    return fresh?.[0] || {};
}

async function _updateSession(dhanClientId, challengeId, updates) {
    const sets = Object.entries(updates).map(([k, v]) => `${k}=${typeof v === 'string' ? `'${v}'` : v}`).join(', ');
    await dbcon.query(DB,
        `UPDATE challenge_session_state SET ${sets}, updated_at=NOW()
         WHERE dhan_client_id=? AND challenge_id=? AND trade_date=CURDATE()`,
        [dhanClientId, challengeId]);
}

async function _notify(dhanClientId, title, body) {
    try {
        const row = await query.fetchSingleRecord(DB, 'users', `WHERE dhan_client_id='${dhanClientId}'`, 'firebase_token');
        const token = row?.firebase_token;
        if (!token) return;
        await utility.sendNotification([token], 'challengeBlocked', '', { title, body });
    } catch (_) {}
}

// ── RULE: Post-trade Cooldown ────────────────────────────────────────────────
exports.checkCooldown = async function (dhanClientId, challenge) {
    await _ensureMigration();
    const cooldownMins = Number(challenge.cooldown_minutes || 0);
    if (cooldownMins <= 0) return { blocked: false };

    const session = await _getSession(dhanClientId, challenge.id);
    if (!session.cooldown_end) return { blocked: false };

    const cooldownEnd = new Date(session.cooldown_end);
    const now = new Date();
    if (now < cooldownEnd) {
        const remaining = Math.ceil((cooldownEnd - now) / 60000);
        return {
            blocked: true,
            reason: 'COOLDOWN',
            message: `Cooldown active — wait ${remaining} min before next trade. Take a breath.`,
        };
    }
    return { blocked: false };
};

// ── RULE: Start cooldown after trade exit ─────────────────────────────────────
exports.startCooldown = async function (dhanClientId, challenge) {
    await _ensureMigration();
    const cooldownMins = Number(challenge.cooldown_minutes || 0);
    if (cooldownMins <= 0) return;

    const cooldownEnd = new Date(Date.now() + cooldownMins * 60000);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;

    await _updateSession(dhanClientId, challenge.id, {
        last_trade_exit_time: `'${fmt(new Date())}'`,
        cooldown_end: `'${fmt(cooldownEnd)}'`,
    });

    console.log(`[AdvChallenge] Cooldown started: ${dhanClientId} → ${cooldownMins} min`);
};

// ── RULE: Consecutive Loss Tracking → Lock ────────────────────────────────────
exports.recordTradeResult = async function (dhanClientId, challenge, pnl) {
    await _ensureMigration();
    const session = await _getSession(dhanClientId, challenge.id);
    const limit = Number(challenge.consecutive_loss_limit || 3);

    if (pnl < 0) {
        const newCount = Number(session.consecutive_losses || 0) + 1;
        await _updateSession(dhanClientId, challenge.id, { consecutive_losses: newCount });

        if (newCount >= limit) {
            // 30-minute lock
            const lockEnd = new Date(Date.now() + 30 * 60000);
            const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;

            await _updateSession(dhanClientId, challenge.id, { cooldown_end: `'${fmt(lockEnd)}'` });

            await _notify(dhanClientId,
                '🛑 3 Consecutive Losses — Trading Paused',
                `Your recent trade sequence suggests emotionally reactive behavior. Take 30 minutes before re-entering.`
            );

            console.log(`[AdvChallenge] ${dhanClientId} → ${newCount} consecutive losses → 30 min lock`);
            return { locked: true, consecutiveLosses: newCount };
        }
    } else if (pnl > 0) {
        // Reset streak on profit
        await _updateSession(dhanClientId, challenge.id, { consecutive_losses: 0 });
    }

    return { locked: false, consecutiveLosses: Number(session.consecutive_losses || 0) };
};

// ── RULE: Max 25% Capital Per Trade ───────────────────────────────────────────
exports.checkCapitalPerTrade = function (challenge, orderAmount) {
    const maxPct = Number(challenge.max_capital_per_trade_pct || 25);
    const capital = Number(challenge.trading_capital || 0);
    if (capital <= 0 || maxPct <= 0) return { blocked: false };

    const maxAllowed = capital * (maxPct / 100);
    if (orderAmount > maxAllowed) {
        return {
            blocked: true,
            reason: 'CAPITAL_PER_TRADE',
            message: `Order ₹${Math.round(orderAmount)} exceeds ${maxPct}% of capital (max ₹${Math.round(maxAllowed)})`,
        };
    }
    return { blocked: false };
};

// ── RULE: Quantity Escalation Detection ───────────────────────────────────────
exports.checkQuantityEscalation = async function (dhanClientId, challenge, qty) {
    await _ensureMigration();
    const session = await _getSession(dhanClientId, challenge.id);
    const lastQty = Number(session.last_quantity || 0);

    // Update last quantity
    await _updateSession(dhanClientId, challenge.id, { last_quantity: qty });

    if (lastQty > 0 && qty > lastQty * 2) {
        await _notify(dhanClientId,
            '⚠️ Quantity Spike Detected',
            `Your order quantity (${qty}) is ${Math.round(qty/lastQty)}x your last trade (${lastQty}). This may indicate emotional trading.`
        );
        return { warning: true, message: `Quantity jumped from ${lastQty} to ${qty}` };
    }
    return { warning: false };
};

// ── RULE: Revenge Trade Detection ─────────────────────────────────────────────
exports.checkRevengeTrade = async function (dhanClientId, challenge) {
    await _ensureMigration();
    const session = await _getSession(dhanClientId, challenge.id);

    if (!session.last_trade_exit_time) return { warning: false };

    const lastExit = new Date(session.last_trade_exit_time);
    const now = new Date();
    const diffSec = (now - lastExit) / 1000;

    // If new trade within 60 seconds of last exit AND last trade was a loss
    if (diffSec < 60 && Number(session.consecutive_losses || 0) > 0) {
        await _notify(dhanClientId,
            '⚠️ Possible Revenge Trade',
            `You are entering a trade just ${Math.round(diffSec)} seconds after a loss. Pause and think before acting.`
        );
        return { warning: true, message: 'Revenge trade detected — trade within 60s of a loss' };
    }
    return { warning: false };
};

// ── RULE: Hero-to-Zero Detection (Expiry Day) ────────────────────────────────
exports.checkHeroTrade = async function (dhanClientId, challenge, tradingSymbol, price, qty) {
    await _ensureMigration();
    if (!Number(challenge.hero_trade_allowed)) return { blocked: false };

    // Check if expiry day
    const sym = (tradingSymbol || '').toUpperCase();
    const isOption = sym.includes('CALL') || sym.includes('PUT') || sym.includes('CE') || sym.includes('PE');
    if (!isOption) return { blocked: false };

    // Check if today is expiry for this contract
    const expiryRows = await dbcon.query(DB,
        `SELECT sm_expiry_date FROM instruments WHERE display_name LIKE ? LIMIT 1`,
        [`%${tradingSymbol}%`]);
    const expiry = expiryRows?.[0]?.sm_expiry_date;
    if (!expiry) return { blocked: false };

    const today = new Date().toISOString().split('T')[0];
    const expiryDate = new Date(expiry).toISOString().split('T')[0];
    if (today !== expiryDate) return { blocked: false };

    // Low premium + high quantity = hero trade
    if (price < 30) {
        const session = await _getSession(dhanClientId, challenge.id);

        // Check if after 2:30 PM IST
        const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const mins = ist.getHours() * 60 + ist.getMinutes();

        if (mins >= 870 && !session.hero_trade_used) { // 2:30 PM = 870 mins
            // Allow ONE hero trade with capped risk
            const capital = Number(challenge.trading_capital || 0);
            const maxHeroCapital = capital * 0.20;
            const orderVal = price * qty;

            if (orderVal > maxHeroCapital) {
                return {
                    blocked: true,
                    reason: 'HERO_TRADE_LIMIT',
                    message: `Hero trade allowed max ₹${Math.round(maxHeroCapital)} (20% capital). Reduce quantity.`,
                };
            }

            await _updateSession(dhanClientId, challenge.id, { hero_trade_used: 1 });
            await _notify(dhanClientId,
                '🎰 Hero Trade Activated',
                `This is your 1 allowed hero trade today. Risk is capped. Trade wisely.`
            );
            return { blocked: false, heroTrade: true };
        }

        if (session.hero_trade_used) {
            return {
                blocked: true,
                reason: 'HERO_TRADE_USED',
                message: 'You already used your 1 hero trade today. No more expiry day low-premium trades.',
            };
        }

        // Before 2:30 PM — warn and suggest next expiry
        return {
            blocked: false,
            warning: true,
            message: `⚠️ This contract expires today with premium ₹${price}. Consider next expiry for less theta risk.`,
        };
    }

    return { blocked: false };
};

// ── Get default rules based on trading style ──────────────────────────────────
exports.getStyleDefaults = function (style) {
    const defaults = {
        SCALPER: {
            cooldown_minutes: 5,
            consecutive_loss_limit: 3,
            max_capital_per_trade_pct: 25,
            risk_per_trade_pct: 2.5,
            target_per_trade_pct: 5,
            max_trades_per_day: 15,
            hero_trade_allowed: 1,
            stop_loss_required: true,
        },
        INTRADAY: {
            cooldown_minutes: 3,
            consecutive_loss_limit: 3,
            max_capital_per_trade_pct: 30,
            risk_per_trade_pct: 3,
            target_per_trade_pct: 6,
            max_trades_per_day: 10,
            hero_trade_allowed: 1,
            stop_loss_required: true,
        },
        SWING: {
            cooldown_minutes: 0,
            consecutive_loss_limit: 5,
            max_capital_per_trade_pct: 20,
            risk_per_trade_pct: 3,
            target_per_trade_pct: 8,
            max_trades_per_day: 5,
            hero_trade_allowed: 0,
            stop_loss_required: false,
        },
        EQUITY: {
            cooldown_minutes: 0,
            consecutive_loss_limit: 5,
            max_capital_per_trade_pct: 25,
            risk_per_trade_pct: 5,
            target_per_trade_pct: 10,
            max_trades_per_day: 5,
            hero_trade_allowed: 0,
            stop_loss_required: false,
        },
        OPTIONS_BUYER: {
            cooldown_minutes: 5,
            consecutive_loss_limit: 3,
            max_capital_per_trade_pct: 20,
            risk_per_trade_pct: 2,
            target_per_trade_pct: 5,
            max_trades_per_day: 10,
            hero_trade_allowed: 1,
            stop_loss_required: true,
        },
        OPTIONS_SELLER: {
            cooldown_minutes: 10,
            consecutive_loss_limit: 2,
            max_capital_per_trade_pct: 40,
            risk_per_trade_pct: 2,
            target_per_trade_pct: 4,
            max_trades_per_day: 5,
            hero_trade_allowed: 0,
            stop_loss_required: false,
        },
    };
    return defaults[style] || defaults.SCALPER;
};

// ── PHASE 1 RULE: Options Buyer — Max Premium Risk Per Trade ──────────────────
exports.checkMaxPremiumRisk = function (challenge, price, qty) {
    const style = (challenge.trading_style || '').toUpperCase();
    if (style !== 'OPTIONS_BUYER' && style !== 'SCALPER' && style !== 'INTRADAY') return { blocked: false };

    const capital = Number(challenge.trading_capital || 0);
    if (capital <= 0) return { blocked: false };

    // Max premium risk = 5% of total capital per single trade
    const maxPremiumRisk = capital * 0.05;
    const premiumRisk = price * qty;

    if (premiumRisk > maxPremiumRisk) {
        return {
            blocked: true,
            reason: 'MAX_PREMIUM_RISK',
            message: `Premium risk ₹${Math.round(premiumRisk)} exceeds 5% of capital (max ₹${Math.round(maxPremiumRisk)}). Reduce quantity.`,
        };
    }
    return { blocked: false };
};

// ── PHASE 1 RULE: Swing — Max Open Positions ─────────────────────────────────
exports.checkMaxOpenPositions = async function (dhanClientId, challenge) {
    const style = (challenge.trading_style || '').toUpperCase();
    if (style !== 'SWING' && style !== 'EQUITY') return { blocked: false };

    const maxOpen = style === 'SWING' ? 3 : 5;

    // Count distinct securities with open positions (BUY qty > SELL qty)
    const rows = await dbcon.query(DB,
        `SELECT COUNT(DISTINCT security_id) AS open_count
         FROM (
             SELECT security_id,
                    SUM(CASE WHEN transaction_type='BUY' THEN quantity ELSE -quantity END) AS net
             FROM demo_orders
             WHERE dhan_client_id=? AND order_status='TRADED'
             GROUP BY security_id
             HAVING net > 0
         ) t`,
        [dhanClientId]
    );

    // Also check real trades
    const realRows = await dbcon.query(DB,
        `SELECT COUNT(*) AS open_count FROM challenge_trade_logs
         WHERE dhan_client_id=? AND status='OPEN'`,
        [dhanClientId]
    );

    const openCount = Math.max(
        Number(rows?.[0]?.open_count || 0),
        Number(realRows?.[0]?.open_count || 0)
    );

    if (openCount >= maxOpen) {
        return {
            blocked: true,
            reason: 'MAX_OPEN_POSITIONS',
            message: `You already have ${openCount} open positions. ${style} mode allows max ${maxOpen}. Close a position first.`,
        };
    }
    return { blocked: false };
};

// ── PHASE 1: Calculate suggested SL/Target based on risk framework ────────────
exports.getRiskFramework = function (challenge, entryPrice) {
    const riskPct = Number(challenge.risk_per_trade_pct || 2.5);
    const targetPct = Number(challenge.target_per_trade_pct || 5);
    const capital = Number(challenge.trading_capital || 0);
    const maxCapPct = Number(challenge.max_capital_per_trade_pct || 25);

    const maxTradeCapital = capital * (maxCapPct / 100);
    const suggestedSL = +(entryPrice * (1 - riskPct / 100)).toFixed(2);
    const suggestedTarget = +(entryPrice * (1 + targetPct / 100)).toFixed(2);
    const maxLossAmount = +(maxTradeCapital * riskPct / 100).toFixed(2);
    const maxTargetAmount = +(maxTradeCapital * targetPct / 100).toFixed(2);

    return {
        riskPct,
        targetPct,
        maxTradeCapital: +maxTradeCapital.toFixed(0),
        suggestedSL,
        suggestedTarget,
        maxLossAmount,
        maxTargetAmount,
    };
};

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 RULES
// ═══════════════════════════════════════════════════════════════════════════

// ── PHASE 2: Risk-Reward Validation (warn if R:R < 1.5) ───────────────────────
exports.checkRiskReward = function (target, stopLoss, entryPrice, isBuy = true) {
    if (!target || !stopLoss || !entryPrice) return { warning: false };

    const reward = isBuy ? (target - entryPrice) : (entryPrice - target);
    const risk = isBuy ? (entryPrice - stopLoss) : (stopLoss - entryPrice);

    if (risk <= 0) return { warning: false };

    const rrRatio = +(reward / risk).toFixed(2);
    if (rrRatio < 1.5) {
        return {
            warning: true,
            rrRatio,
            message: `Risk:Reward is ${rrRatio}:1 — recommended minimum is 1.5:1. Consider a better target/SL.`,
        };
    }
    return { warning: false, rrRatio };
};

// ── PHASE 2: No Averaging Down Rule ───────────────────────────────────────────
// Blocks BUY of the same security if currently in a loss vs current avg buy price
exports.checkAveragingDown = async function (dhanClientId, challenge, securityId, newPrice, isDemoMode) {
    const style = (challenge.trading_style || '').toUpperCase();
    if (style !== 'SWING' && style !== 'EQUITY') return { blocked: false };

    try {
        let avgBuyPrice = 0, netQty = 0;

        if (isDemoMode) {
            const rows = await dbcon.query(DB,
                `SELECT SUM(CASE WHEN transaction_type='BUY' THEN quantity ELSE -quantity END) AS net_qty,
                        SUM(CASE WHEN transaction_type='BUY' THEN quantity*price ELSE 0 END) AS total_cost,
                        SUM(CASE WHEN transaction_type='BUY' THEN quantity ELSE 0 END) AS total_buy_qty
                 FROM demo_orders
                 WHERE dhan_client_id=? AND security_id=? AND order_status='TRADED'`,
                [dhanClientId, securityId]);
            netQty = Number(rows?.[0]?.net_qty || 0);
            const totalBuyQty = Number(rows?.[0]?.total_buy_qty || 0);
            avgBuyPrice = totalBuyQty > 0 ? Number(rows?.[0]?.total_cost || 0) / totalBuyQty : 0;
        } else {
            const rows = await dbcon.query(DB,
                `SELECT AVG(buy_price) AS avg_price, SUM(quantity) AS qty
                 FROM challenge_trade_logs
                 WHERE dhan_client_id=? AND security_id=? AND status='OPEN'`,
                [dhanClientId, securityId]);
            avgBuyPrice = Number(rows?.[0]?.avg_price || 0);
            netQty = Number(rows?.[0]?.qty || 0);
        }

        if (netQty > 0 && avgBuyPrice > 0 && newPrice < avgBuyPrice) {
            return {
                blocked: true,
                reason: 'AVERAGING_DOWN',
                message: `This position is already at a loss (avg ₹${avgBuyPrice.toFixed(2)}, now ₹${newPrice}). Averaging down is blocked for ${style} mode.`,
            };
        }
    } catch (_) {}
    return { blocked: false };
};

// ── PHASE 2: Holding Discipline — prevent emotional early exit on profit ──────
exports.checkHoldingDiscipline = async function (dhanClientId, challenge, securityId, isDemoMode) {
    const style = (challenge.trading_style || '').toUpperCase();
    if (style !== 'SWING' && style !== 'EQUITY') return { warning: false };

    await _ensureMigration();
    const session = await _getSession(dhanClientId, challenge.id);
    if (!session.last_buy_time || session.last_buy_security_id !== securityId) return { warning: false };

    const minHoldMinutes = style === 'SWING' ? 30 : 60;
    const buyTime = new Date(session.last_buy_time);
    const now = new Date();
    const heldMinutes = (now - buyTime) / 60000;

    if (heldMinutes < minHoldMinutes) {
        return {
            warning: true,
            message: `You've held this position for only ${Math.round(heldMinutes)} min. ${style} trades typically need ${minHoldMinutes}+ min to develop. Consider holding longer.`,
        };
    }
    return { warning: false };
};

// ── PHASE 2: Track BUY for holding discipline + averaging down checks ─────────
exports.recordBuyEntry = async function (dhanClientId, challenge, securityId, price) {
    await _ensureMigration();
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    await _getSession(dhanClientId, challenge.id); // ensure row exists
    await _updateSession(dhanClientId, challenge.id, {
        last_buy_time: `'${fmt(new Date())}'`,
        last_buy_security_id: `'${securityId}'`,
        last_buy_price: price,
    });
};

// ── PHASE 2: Lottery Trade Detection (repeated far-OTM low premium buys) ──────
exports.checkLotteryTrade = async function (dhanClientId, challenge, tradingSymbol, price) {
    const style = (challenge.trading_style || '').toUpperCase();
    if (style !== 'OPTIONS_BUYER' && style !== 'SCALPER' && style !== 'INTRADAY') return { warning: false };

    await _ensureMigration();
    const sym = (tradingSymbol || '').toUpperCase();
    const isOption = sym.includes('CALL') || sym.includes('PUT') || sym.includes('CE') || sym.includes('PE');
    if (!isOption || price >= 30) return { warning: false };

    // Log this OTM trade
    await dbcon.query(DB,
        `INSERT INTO otm_trade_log (dhan_client_id, trading_symbol, premium, trade_date)
         VALUES (?, ?, ?, CURDATE())`,
        [dhanClientId, tradingSymbol, price]);

    // Count today's OTM low-premium trades
    const rows = await dbcon.query(DB,
        `SELECT COUNT(*) AS cnt FROM otm_trade_log
         WHERE dhan_client_id=? AND trade_date=CURDATE()`,
        [dhanClientId]);
    const count = Number(rows?.[0]?.cnt || 0);

    if (count >= 3) {
        await _notify(dhanClientId,
            '🎰 Lottery Trade Pattern Detected',
            `You've bought ${count} low-premium options today (under ₹30). This pattern often leads to repeated small losses. Consider higher-probability setups.`
        );
        return { warning: true, count, message: `${count} low-premium OTM trades today — lottery trading pattern detected` };
    }
    return { warning: false, count };
};

// ── PHASE 2: Margin Utilization Cap — Options Seller ──────────────────────────
exports.checkMarginUtilization = async function (dhanClientId, challenge, marginRequired) {
    const style = (challenge.trading_style || '').toUpperCase();
    if (style !== 'OPTIONS_SELLER') return { blocked: false };

    const capital = Number(challenge.trading_capital || 0);
    if (capital <= 0) return { blocked: false };

    const maxMarginPct = 60; // Options sellers shouldn't use more than 60% margin
    const maxMargin = capital * (maxMarginPct / 100);

    if (marginRequired > maxMargin) {
        return {
            blocked: true,
            reason: 'MARGIN_CAP',
            message: `Margin required ₹${Math.round(marginRequired)} exceeds ${maxMarginPct}% cap (max ₹${Math.round(maxMargin)}). Reduce position size.`,
        };
    }
    return { blocked: false };
};

// ── PHASE 2: Hedge Required Rule — Options Seller ─────────────────────────────
// Warns if selling naked options without an offsetting position
exports.checkHedgeRequired = async function (dhanClientId, challenge, isDemoMode) {
    const style = (challenge.trading_style || '').toUpperCase();
    if (style !== 'OPTIONS_SELLER') return { warning: false };

    try {
        const table = isDemoMode ? 'demo_orders' : 'challenge_trade_logs';
        const statusCol = isDemoMode ? `DATE(created_at)=CURDATE()` : `status='OPEN'`;

        const rows = await dbcon.query(DB,
            `SELECT COUNT(DISTINCT security_id) AS positions
             FROM ${table}
             WHERE dhan_client_id=? AND ${statusCol}`,
            [dhanClientId]);

        const positions = Number(rows?.[0]?.positions || 0);

        // If only 1 naked position open (no hedge leg), warn
        if (positions === 1) {
            return {
                warning: true,
                message: 'You have an unhedged (naked) option position. Consider adding a hedge leg to limit tail risk.',
            };
        }
    } catch (_) {}
    return { warning: false };
};

// ── PHASE 2: Volatility Spike Warning — Options Seller ────────────────────────
exports.checkVolatilitySpike = async function (dhanClientId, challenge, currentATR, avgATR) {
    const style = (challenge.trading_style || '').toUpperCase();
    if (style !== 'OPTIONS_SELLER') return { warning: false };
    if (!currentATR || !avgATR || avgATR <= 0) return { warning: false };

    const spike = currentATR / avgATR;
    if (spike >= 1.5) {
        await _notify(dhanClientId,
            '⚡ Volatility Spike Warning',
            `Market volatility is ${spike.toFixed(1)}x normal levels. Option selling carries higher risk right now — consider reducing position size or widening strikes.`
        );
        return { warning: true, spikeFactor: +spike.toFixed(2), message: `Volatility ${spike.toFixed(1)}x normal — high risk for option selling` };
    }
    return { warning: false };
};

// ── PHASE 2: Panic Selling Detection — Equity ─────────────────────────────────
// Detects selling at a big loss shortly after a market-wide drop
exports.checkPanicSelling = async function (dhanClientId, challenge, sellPnl, holdingMinutes) {
    const style = (challenge.trading_style || '').toUpperCase();
    if (style !== 'EQUITY' && style !== 'SWING') return { warning: false };

    const capital = Number(challenge.trading_capital || 0);
    if (capital <= 0 || sellPnl >= 0) return { warning: false };

    const lossPct = Math.abs(sellPnl) / capital * 100;

    // Large loss + held for very short time = panic selling signature
    if (lossPct > 3 && holdingMinutes < 15) {
        await _notify(dhanClientId,
            '😰 Possible Panic Selling',
            `You exited at a ${lossPct.toFixed(1)}% loss after holding only ${Math.round(holdingMinutes)} min. This may be a panic reaction rather than a planned exit.`
        );
        return { warning: true, message: `Panic selling pattern: ${lossPct.toFixed(1)}% loss in ${Math.round(holdingMinutes)} min` };
    }
    return { warning: false };
};

// ── PHASE 2: Sector Exposure Limit (simplified — by underlying symbol group) ──
exports.checkSectorExposure = async function (dhanClientId, challenge, tradingSymbol, orderAmount, isDemoMode) {
    const style = (challenge.trading_style || '').toUpperCase();
    if (style !== 'EQUITY') return { blocked: false };

    const capital = Number(challenge.trading_capital || 0);
    if (capital <= 0) return { blocked: false };

    // Simplified sector grouping by common prefixes (extend as needed)
    const sectorMap = {
        BANK: ['HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK', 'BANKNIFTY', 'INDUSINDBK'],
        IT:   ['TCS', 'INFY', 'WIPRO', 'HCLTECH', 'TECHM'],
        AUTO: ['MARUTI', 'TATAMOTORS', 'M&M', 'BAJAJ-AUTO', 'HEROMOTOCO'],
        PHARMA: ['SUNPHARMA', 'DRREDDY', 'CIPLA', 'DIVISLAB'],
    };

    const sym = (tradingSymbol || '').toUpperCase();
    let sector = null;
    for (const [sec, symbols] of Object.entries(sectorMap)) {
        if (symbols.some(s => sym.includes(s))) { sector = sec; break; }
    }
    if (!sector) return { blocked: false }; // unknown sector, skip check

    try {
        const table = isDemoMode ? 'demo_orders' : 'challenge_trade_logs';
        const symbols = sectorMap[sector];
        const likeConditions = symbols.map(() => `trading_symbol LIKE ?`).join(' OR ');
        const likeParams = symbols.map(s => `%${s}%`);

        const statusCol = isDemoMode
            ? `(SELECT SUM(CASE WHEN transaction_type='BUY' THEN quantity*price ELSE -quantity*price END))`
            : `(SELECT SUM(buy_price*quantity))`;

        const rows = await dbcon.query(DB,
            `SELECT SUM(CASE WHEN transaction_type='BUY' THEN quantity*price ELSE 0 END) AS total
             FROM ${table}
             WHERE dhan_client_id=? AND (${likeConditions}) AND ${isDemoMode ? "order_status='TRADED'" : "status='OPEN'"}`,
            [dhanClientId, ...likeParams]);

        const sectorExposure = Number(rows?.[0]?.total || 0) + orderAmount;
        const maxSectorPct = 40; // max 40% capital in one sector
        const maxSectorAmount = capital * (maxSectorPct / 100);

        if (sectorExposure > maxSectorAmount) {
            return {
                blocked: true,
                reason: 'SECTOR_EXPOSURE',
                message: `${sector} sector exposure would reach ₹${Math.round(sectorExposure)} — exceeds ${maxSectorPct}% cap (max ₹${Math.round(maxSectorAmount)})`,
            };
        }
    } catch (_) {}
    return { blocked: false };
};

// ── PHASE 2: Euphoric Trading Detection — increased size after big profit ─────
exports.checkEuphoricTrading = async function (dhanClientId, challenge, newOrderAmount) {
    await _ensureMigration();
    const session = await _getSession(dhanClientId, challenge.id);
    const avgQty = Number(session.avg_quantity || 0);
    const peakPnl = Number(session.peak_pnl_today || 0);
    const capital = Number(challenge.trading_capital || 0);

    if (capital <= 0 || peakPnl <= 0) return { warning: false };

    const profitPct = (peakPnl / capital) * 100;

    // If user is up significantly today AND this order is much bigger than usual
    if (profitPct > 5 && avgQty > 0 && newOrderAmount > avgQty * 2) {
        await _notify(dhanClientId,
            '🎉 Euphoric Trading Alert',
            `You're up ${profitPct.toFixed(1)}% today and this order is unusually large. Many traders give back profits by oversizing after wins. Stay disciplined.`
        );
        return { warning: true, message: `Position size increased after ${profitPct.toFixed(1)}% profit — euphoric trading risk` };
    }
    return { warning: false };
};

// ── PHASE 2: Discipline Score Calculation ─────────────────────────────────────
exports.calculateDisciplineScore = async function (dhanClientId, challengeId) {
    await _ensureMigration();
    try {
        const session = await dbcon.query(DB,
            `SELECT * FROM challenge_session_state
             WHERE dhan_client_id=? AND challenge_id=? AND trade_date=CURDATE() LIMIT 1`,
            [dhanClientId, challengeId]);

        const s = session?.[0] || {};
        let score = 100;
        const deductions = [];

        const consecLosses = Number(s.consecutive_losses || 0);
        if (consecLosses >= 3) { score -= 20; deductions.push('Consecutive losses (-20)'); }
        else if (consecLosses >= 2) { score -= 10; deductions.push('Multiple losses (-10)'); }

        if (Number(s.daily_stop_triggered)) { score -= 15; deductions.push('Daily stop triggered (-15)'); }

        // Check OTM lottery trades today
        const otmRows = await dbcon.query(DB,
            `SELECT COUNT(*) AS cnt FROM otm_trade_log WHERE dhan_client_id=? AND trade_date=CURDATE()`,
            [dhanClientId]);
        const otmCount = Number(otmRows?.[0]?.cnt || 0);
        if (otmCount >= 3) { score -= 15; deductions.push('Lottery trading pattern (-15)'); }
        else if (otmCount >= 1) { score -= 5; deductions.push('Low-premium OTM trades (-5)'); }

        score = Math.max(0, Math.min(100, score));

        let grade = 'A';
        if (score < 50) grade = 'D';
        else if (score < 65) grade = 'C';
        else if (score < 80) grade = 'B';

        return { score, grade, deductions };
    } catch (e) {
        return { score: 100, grade: 'A', deductions: [] };
    }
};
