const dbcon      = require('../config/mysqlClient');
const constants  = require('../vars/constants');
const dhanFeed   = require('./dhanMarketFeed');
const { getPrice } = require('./priceCache');
const {
    checkDemoPnlNotification,
    _notifyUser,
    getAvailableCoins,
    checkRealizedPnlBlock,
} = require('../controllers/DemoController');
const { onTradeExit } = require('./challengeEngine'); // same import DemoController.js uses
const demoFifo   = require('./demoFifo');
const marketSession = require('./marketSession');
const instrumentStatus = require('./instrumentStatus');
const utility    = require('./utility');
const notificationHelper = require('./notificationHelper');

const DB         = constants.vals.defaultDB;
const BATCH_SIZE = 50;

let demoOffset = 0;

// Subscribes securities that need a live LTP but wouldn't otherwise be
// covered by "traded today" (the original scope of this function):
//   1. Positions traded today (existing behavior).
//   2. ANY open DELIVERY position, regardless of which day it was bought —
//      delivery positions can span multiple days.
//   3. ANY security with a PENDING LIMIT order, regardless of placement
//      date — checkPendingLimitOrders() needs live LTP to evaluate it.
async function subscribeOpenPositions() {
    try {
        const openToday = await dbcon.query(DB,
            `SELECT security_id, MAX(exchange_segment) AS exchange_segment
             FROM demo_orders
             WHERE order_status='TRADED' AND DATE(created_at)=CURDATE()
             GROUP BY security_id
             HAVING SUM(CASE WHEN transaction_type='BUY' THEN quantity ELSE -quantity END) > 0`
        );

        const openDelivery = await dbcon.query(DB,
            `SELECT security_id, MAX(exchange_segment) AS exchange_segment
             FROM demo_orders
             WHERE order_status='TRADED' AND product_type='DELIVERY'
             GROUP BY security_id
             HAVING SUM(CASE WHEN transaction_type='BUY' THEN quantity ELSE -quantity END) > 0`
        );

        const pendingLimit = await dbcon.query(DB,
            `SELECT DISTINCT security_id, exchange_segment
             FROM demo_orders
             WHERE order_status='PENDING' AND order_type='LIMIT'`
        );

        const merged = new Map();
        for (const p of [...(openToday || []), ...(openDelivery || []), ...(pendingLimit || [])]) {
            if (p.security_id != null) merged.set(String(p.security_id), p.exchange_segment);
        }
        if (merged.size === 0) return;

        const unpriced = [...merged.entries()].filter(([secId]) => getPrice(secId) == null);
        if (unpriced.length > 0) {
            dhanFeed.subscribe(unpriced.map(([secId, seg]) => ({
                ExchangeSegment: seg,
                SecurityId: secId,
            })));
            console.log(`[DEMO LivePnL] Subscribed ${unpriced.length} open position(s)/pending order(s) to price feed: ${unpriced.map(([s]) => s).join(', ')}`);
        }
    } catch (e) {
        console.log('[DEMO LivePnL] subscribeOpenPositions error:', e.message);
    }
}

// Auto SL/TP execution for SUPER orders
async function checkSuperOrderExits() {
    try {
        // Find SUPER BUY orders with SL or TP that still have open quantity
        const superOrders = await dbcon.query(DB,
            `SELECT o.id, o.dhan_client_id, o.security_id, o.trading_symbol,
                    o.exchange_segment, o.quantity, o.price AS buy_price,
                    o.target_price, o.stop_loss_price, o.order_type, o.product_type
             FROM demo_orders o
             WHERE o.order_type = 'SUPER'
               AND o.transaction_type = 'BUY'
               AND o.order_status = 'TRADED'
               AND (o.target_price > 0 OR o.stop_loss_price > 0)
             ORDER BY o.created_at DESC`
        );

        if (!superOrders?.length) return;

        for (const order of superOrders) {
            const ltp = getPrice(order.security_id);
            if (!ltp || ltp <= 0) continue;

            const productType = order.product_type || 'INTRADAY';
            const netQty = await demoFifo.getNetQty({
                dhanClientId: order.dhan_client_id, securityId: order.security_id, productType,
            });
            if (netQty <= 0) continue;

            const sellQty = Math.min(netQty, order.quantity);
            let exitReason = null;
            let exitPrice = ltp;

            // Target hit
            if (order.target_price > 0 && ltp >= order.target_price) {
                exitReason = 'TARGET_HIT';
                exitPrice = order.target_price;
            }
            // Stop loss hit
            if (order.stop_loss_price > 0 && ltp <= order.stop_loss_price) {
                exitReason = 'SL_HIT';
                exitPrice = order.stop_loss_price;
            }

            if (!exitReason) continue;

            // Atomic claim FIRST — disarm target/SL guarded by a WHERE that
            // only succeeds once, mirroring checkPendingLimitOrders' claim-
            // then-act pattern. Prevents a duplicate tick from inserting a
            // second exit SELL for the same trigger.
            const claimed = await dbcon.query(DB,
                `UPDATE demo_orders SET target_price=0, stop_loss_price=0
                 WHERE id=? AND (target_price>0 OR stop_loss_price>0)`,
                [order.id]
            );
            if (!claimed || claimed.affectedRows !== 1) {
                console.log(`[DEMO Auto-Exit] duplicate execution prevented — order #${order.id} already claimed by another tick`);
                continue;
            }

            const { avgCostBasis } = await demoFifo.computeAvgCostBasis({
                dhanClientId: order.dhan_client_id, securityId: order.security_id, productType, sellQty,
            });
            const pnl = parseFloat(((exitPrice - avgCostBasis) * sellQty).toFixed(2));
            const squareOffReason = exitReason === 'TARGET_HIT' ? 'SUPER_TARGET' : 'SUPER_SL';

            // Place auto SELL order
            await dbcon.query(DB,
                `INSERT INTO demo_orders
                 (dhan_client_id, security_id, trading_symbol, exchange_segment,
                  transaction_type, order_type, product_type, quantity, price,
                  order_status, executed_price, executed_at, square_off_reason, pnl)
                 VALUES (?, ?, ?, ?, 'SELL', 'MARKET', ?, ?, ?, 'TRADED', ?, NOW(), ?, ?)`,
                [order.dhan_client_id, order.security_id, order.trading_symbol,
                 order.exchange_segment, productType, sellQty, exitPrice, exitPrice, squareOffReason, pnl]
            );

            // Notify user
            const emoji = exitReason === 'TARGET_HIT' ? '🎯' : '🛑';
            const label = exitReason === 'TARGET_HIT' ? 'Target Hit' : 'Stop Loss Hit';
            const pnlStr = pnl >= 0 ? `+${pnl.toFixed(0)}` : `${pnl.toFixed(0)}`;

            _notifyUser(
                order.dhan_client_id,
                `${emoji} ${label} — ${order.trading_symbol}`,
                `Auto-sold ${sellQty} qty @ ₹${exitPrice.toFixed(2)} | P&L: ${pnlStr} coins`,
                order.id
            );

            console.log(`[DEMO Auto-Exit] ${exitReason} ${order.trading_symbol} qty=${sellQty} @ ${exitPrice} PnL=${pnl}`);
            console.log(`[AUTO_SQUARE_OFF] product=${productType} securityId=${order.security_id} quantity=${sellQty} price=${exitPrice} reason=${squareOffReason}`);
        }
    } catch (e) {
        console.log('[DEMO Auto-Exit] Error:', e.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry-safety-net for expired open positions: catches anything
// checkDeliverySquareOff() couldn't close on the contract's actual expiry
// day (e.g. no price tick ever arrived that day). Runs on every tick.
//
// RETRY-INDEFINITELY, NEVER FAKE A FILL: only closes using a real live
// price from getPrice(). If no valid price is available, it does NOT touch
// the position — no exit trade, no status change — just logs and leaves it
// for the next cycle. A position can only disappear via a real, priced
// exit transaction. Idempotent the same way as every other exit path in
// this file: once the SELL is inserted, net_qty for that group is 0, so
// the aggregate query naturally excludes it on the next tick — no separate
// status machine needed.
// ─────────────────────────────────────────────────────────────────────────────
async function autoExpirePositions() {
    try {
        const expiredPositions = await dbcon.query(DB,
            `SELECT
                 o.dhan_client_id,
                 o.security_id,
                 o.product_type,
                 MAX(o.trading_symbol)   AS trading_symbol,
                 MAX(o.exchange_segment) AS exchange_segment,
                 SUM(CASE WHEN o.transaction_type='BUY' THEN o.quantity ELSE -o.quantity END) AS net_qty
             FROM demo_orders o
             JOIN instruments i ON i.security_id = o.security_id
             WHERE o.order_status = 'TRADED'
               AND i.sm_expiry_date IS NOT NULL
               AND i.sm_expiry_date > '1900-01-01'
               AND DATE(i.sm_expiry_date) < ?
             GROUP BY o.dhan_client_id, o.security_id, o.product_type
             HAVING net_qty > 0`,
            // Same expiry rule as everywhere else (IST, after market close).
            [instrumentStatus.firstActiveExpiryDate()]
        );

        if (!expiredPositions?.length) return;

        for (const pos of expiredPositions) {
            const netQty = Number(pos.net_qty);
            if (netQty <= 0) continue;

            const productType = pos.product_type || 'INTRADAY';

            const ltp = getPrice(pos.security_id);
            if (!ltp || ltp <= 0) {
                console.log(`[AUTO_SQUARE_OFF] product=${productType} securityId=${pos.security_id} quantity=${netQty} price=SKIPPED reason=AUTO_SQUARE_OFF_EXPIRY status=NO_VALID_PRICE_RETRYING`);
                continue;
            }

            const { avgCostBasis } = await demoFifo.computeAvgCostBasis({
                dhanClientId: pos.dhan_client_id, securityId: pos.security_id, productType, sellQty: netQty,
            });
            const pnl = parseFloat(((ltp - avgCostBasis) * netQty).toFixed(2));

            await dbcon.query(DB,
                `INSERT INTO demo_orders
                 (dhan_client_id, security_id, trading_symbol, exchange_segment,
                  transaction_type, order_type, product_type, quantity, price,
                  order_status, executed_price, executed_at, square_off_reason, pnl)
                 VALUES (?, ?, ?, ?, 'SELL', 'MARKET', ?, ?, ?, 'TRADED', ?, NOW(), 'AUTO_SQUARE_OFF_EXPIRY', ?)`,
                [pos.dhan_client_id, pos.security_id, pos.trading_symbol,
                 pos.exchange_segment, productType, netQty, ltp, ltp, pnl]
            );

            _notifyUser(
                pos.dhan_client_id,
                `⏰ Expiry Position Closed — ${pos.trading_symbol}`,
                `${netQty} qty auto-squared @ ₹${ltp.toFixed(2)} (contract expired) | P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)} coins`
            );

            console.log(`[DEMO Expiry] Auto-closed ${pos.trading_symbol} for ${pos.dhan_client_id} qty=${netQty} @ ${ltp} PnL=${pnl}`);
            console.log(`[AUTO_SQUARE_OFF] product=${productType} securityId=${pos.security_id} quantity=${netQty} price=${ltp} reason=AUTO_SQUARE_OFF_EXPIRY`);
        }
    } catch (e) {
        console.log('[DEMO Expiry] autoExpirePositions error:', e.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: PENDING LIMIT order execution engine.
// BUY fires when live LTP <= limit price; SELL fires when live LTP >= limit
// price. Each row is claimed exactly once via a conditional UPDATE (no
// transaction support exists in this codebase — see helpers/demoFifo.js
// header note), so overlapping cron ticks can never double-execute the same
// order.
// ─────────────────────────────────────────────────────────────────────────────
async function checkPendingLimitOrders() {
    try {
        const pending = await dbcon.query(DB,
            `SELECT id, dhan_client_id, security_id, trading_symbol, exchange_segment,
                    transaction_type, product_type, quantity, price
             FROM demo_orders
             WHERE order_status='PENDING' AND order_type='LIMIT'
             ORDER BY created_at ASC`
        );
        if (!pending?.length) return;

        for (const order of pending) {
            const ltp = getPrice(order.security_id);
            if (!ltp || ltp <= 0) continue;

            const limitPrice = parseFloat(order.price);
            const triggered = order.transaction_type === 'BUY'
                ? ltp <= limitPrice
                : ltp >= limitPrice;
            if (!triggered) continue;

            console.log(`[DEMO LIMIT] triggered — order #${order.id} ${order.transaction_type} ${order.trading_symbol} limit=₹${limitPrice} ltp=₹${ltp}`);

            const qty = Number(order.quantity);
            const productType = order.product_type || 'INTRADAY';
            const amount = qty * ltp;

            // Re-validate at execution time — funds/holdings may have moved
            // since placement. If no longer valid, reject instead of filling.
            let rejectReason = null;
            if (order.transaction_type === 'BUY') {
                const available = await getAvailableCoins(order.dhan_client_id);
                if (available < amount) rejectReason = 'Insufficient Demo Coins at execution time';
            } else {
                const netQty = await demoFifo.getNetQty({
                    dhanClientId: order.dhan_client_id, securityId: order.security_id, productType,
                });
                if (qty > netQty) rejectReason = 'Insufficient holding quantity at execution time';
            }

            if (rejectReason) {
                const rejected = await dbcon.query(DB,
                    `UPDATE demo_orders SET order_status='REJECTED', updated_at=NOW() WHERE id=? AND order_status='PENDING'`,
                    [order.id]
                );
                if (rejected?.affectedRows === 1) {
                    console.log(`[DEMO LIMIT] execution failure — order #${order.id} rejected: ${rejectReason}`);
                    _notifyUser(order.dhan_client_id, '❌ Demo Limit Order Rejected',
                        `${order.trading_symbol} — ${rejectReason}`, order.id);
                } else {
                    console.log(`[DEMO LIMIT] duplicate execution prevented — order #${order.id} already claimed`);
                }
                continue;
            }

            // FIFO P&L for a triggered SELL, computed BEFORE the atomic claim
            // (read-only; the claim below is what actually prevents double-fill).
            let pnl = 0;
            if (order.transaction_type === 'SELL') {
                const { avgCostBasis } = await demoFifo.computeAvgCostBasis({
                    dhanClientId: order.dhan_client_id, securityId: order.security_id, productType, sellQty: qty,
                });
                pnl = parseFloat(((ltp - avgCostBasis) * qty).toFixed(2));
            }

            // Atomic claim — exactly-once execution guard. Also updates `price`
            // (not just `executed_price`) to the actual fill — getAvailableCoins()
            // and demoFifo.js both read the `price` column as the fill price for
            // TRADED rows, so it must reflect what actually happened, not the
            // originally-requested limit price.
            const claimed = await dbcon.query(DB,
                `UPDATE demo_orders
                 SET order_status='TRADED', price=?, executed_price=?, executed_at=NOW(), pnl=?
                 WHERE id=? AND order_status='PENDING'`,
                [ltp, ltp, pnl, order.id]
            );
            if (!claimed || claimed.affectedRows !== 1) {
                console.log(`[DEMO LIMIT] duplicate execution prevented — order #${order.id} already claimed by another tick`);
                continue;
            }

            console.log(`[DEMO LIMIT] executed — order #${order.id} ${order.transaction_type} ${qty}x ${order.trading_symbol} @ ₹${ltp} PnL=${pnl}`);

            if (order.transaction_type === 'SELL') {
                checkRealizedPnlBlock(order.dhan_client_id);
                onTradeExit(order.dhan_client_id, pnl, order.trading_symbol);
            }

            const pnlStr = order.transaction_type === 'SELL' && pnl !== 0
                ? `  |  P&L ₹${pnl > 0 ? '+' : ''}${pnl.toFixed(0)}`
                : '';
            _notifyUser(
                order.dhan_client_id,
                `✅ DEMO LIMIT ${order.transaction_type} Executed`,
                `${order.trading_symbol}  •  Qty: ${qty}  @  ₹${ltp.toFixed(2)}${pnlStr}`,
                order.id
            );
        }
    } catch (e) {
        console.log('[DEMO LIMIT] checkPendingLimitOrders error:', e.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: INTRADAY auto square-off, before market close.
// No short-selling exists anywhere in this system (SELL is always validated
// against existing holdings — see DemoController.placeOrder), so every open
// position is long; squaring off always means an auto SELL, same execution
// pattern as checkSuperOrderExits/autoExpirePositions above.
// Self-guarding like autoExpirePositions: once net qty reaches 0, subsequent
// ticks in the same window naturally find nothing to close.
// ─────────────────────────────────────────────────────────────────────────────
async function checkIntradaySquareOff() {
    try {
        if (!(await marketSession.isPastSquareoffTime())) return;
        // Logged every time this gate opens — if square-off or limit-expiry
        // ever fires earlier than expected again, this line (not guesswork)
        // is what should explain why: it names the exact IST time and the
        // configured trigger that let it through.
        console.log(`[DEMO Squareoff] past squareoff time — IST now=${marketSession.minutesSinceMidnightIst()}min, trigger=${await marketSession.getIntradaySquareoffMinutes()}min`);

        const openIntraday = await dbcon.query(DB,
            `SELECT dhan_client_id, security_id,
                    MAX(trading_symbol)   AS trading_symbol,
                    MAX(exchange_segment) AS exchange_segment,
                    SUM(CASE WHEN transaction_type='BUY' THEN quantity ELSE -quantity END) AS net_qty
             FROM demo_orders
             WHERE order_status='TRADED' AND product_type='INTRADAY'
             GROUP BY dhan_client_id, security_id
             HAVING net_qty > 0`
        );

        if (openIntraday?.length) {
            for (const pos of openIntraday) {
                const netQty = Number(pos.net_qty);
                if (netQty <= 0) continue;

                const ltp = getPrice(pos.security_id);
                if (!ltp || ltp <= 0) continue; // wait for a price tick rather than closing at 0

                const { avgCostBasis } = await demoFifo.computeAvgCostBasis({
                    dhanClientId: pos.dhan_client_id, securityId: pos.security_id,
                    productType: 'INTRADAY', sellQty: netQty,
                });
                const pnl = parseFloat(((ltp - avgCostBasis) * netQty).toFixed(2));

                await dbcon.query(DB,
                    `INSERT INTO demo_orders
                     (dhan_client_id, security_id, trading_symbol, exchange_segment,
                      transaction_type, order_type, product_type, quantity, price,
                      order_status, executed_price, executed_at, square_off_reason, pnl)
                     VALUES (?, ?, ?, ?, 'SELL', 'MARKET', 'INTRADAY', ?, ?, 'TRADED', ?, NOW(), 'INTRADAY_EOD', ?)`,
                    [pos.dhan_client_id, pos.security_id, pos.trading_symbol,
                     pos.exchange_segment, netQty, ltp, ltp, pnl]
                );

                _notifyUser(
                    pos.dhan_client_id,
                    `🔔 Intraday Auto Square-off — ${pos.trading_symbol}`,
                    `${netQty} qty auto-squared @ ₹${ltp.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)} coins`
                );

                console.log(`[DEMO Squareoff] INTRADAY_EOD ${pos.trading_symbol} for ${pos.dhan_client_id} qty=${netQty} @ ${ltp} PnL=${pnl}`);
                console.log(`[AUTO_SQUARE_OFF] product=INTRADAY securityId=${pos.security_id} quantity=${netQty} price=${ltp} reason=INTRADAY_EOD`);
            }
        }

        // Same-day unfilled INTRADAY LIMIT orders are moot by EOD — expire them
        // rather than leaving them PENDING into the next trading day.
        const staleLimits = await dbcon.query(DB,
            `SELECT id FROM demo_orders
             WHERE order_status='PENDING' AND order_type='LIMIT' AND product_type='INTRADAY'
               AND DATE(created_at) = CURDATE()`
        );
        for (const row of (staleLimits || [])) {
            const result = await dbcon.query(DB,
                `UPDATE demo_orders SET order_status='EXPIRED', square_off_reason='LIMIT_EXPIRED', updated_at=NOW()
                 WHERE id=? AND order_status='PENDING'`,
                [row.id]
            );
            if (result?.affectedRows === 1) {
                console.log(`[DEMO LIMIT] expired — pending INTRADAY limit order #${row.id} never triggered by EOD (squareoff gate was open)`);
            }
        }
    } catch (e) {
        console.log('[DEMO Squareoff] checkIntradaySquareOff error:', e.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: DELIVERY auto square-off ON the instrument's own expiry date, closed
// while the market is still live (real LTP) BEFORE close — distinct from
// autoExpirePositions() above, which is only a retry-safety-net for
// whatever this function couldn't close on the day itself.
// Explicitly gated to F&O instrument types (OPTIDX/OPTSTK/FUTIDX/FUTSTK) —
// equity DELIVERY has no contract expiry and must never be auto-closed.
// The sm_expiry_date IS NOT NULL check already excludes equity in practice
// (equities have no expiry date), but the instrument filter makes that
// explicit/auditable rather than incidental.
// ─────────────────────────────────────────────────────────────────────────────
async function checkDeliverySquareOff() {
    try {
        if (!(await marketSession.isPastExpirySquareoffTime())) return;

        const expiringToday = await dbcon.query(DB,
            `SELECT o.dhan_client_id, o.security_id,
                    MAX(o.trading_symbol)   AS trading_symbol,
                    MAX(o.exchange_segment) AS exchange_segment,
                    SUM(CASE WHEN o.transaction_type='BUY' THEN o.quantity ELSE -o.quantity END) AS net_qty
             FROM demo_orders o
             JOIN instruments i ON i.security_id = o.security_id
             WHERE o.order_status='TRADED' AND o.product_type='DELIVERY'
               AND i.instrument IN ('OPTIDX','OPTSTK','FUTIDX','FUTSTK')
               AND i.sm_expiry_date IS NOT NULL
               AND DATE(i.sm_expiry_date) = ?
             GROUP BY o.dhan_client_id, o.security_id
             HAVING net_qty > 0`,
            [instrumentStatus.istDateKey()]
        );
        if (!expiringToday?.length) return;

        for (const pos of expiringToday) {
            const netQty = Number(pos.net_qty);
            if (netQty <= 0) continue;

            const ltp = getPrice(pos.security_id);
            if (!ltp || ltp <= 0) continue;

            const { avgCostBasis } = await demoFifo.computeAvgCostBasis({
                dhanClientId: pos.dhan_client_id, securityId: pos.security_id,
                productType: 'DELIVERY', sellQty: netQty,
            });
            const pnl = parseFloat(((ltp - avgCostBasis) * netQty).toFixed(2));

            await dbcon.query(DB,
                `INSERT INTO demo_orders
                 (dhan_client_id, security_id, trading_symbol, exchange_segment,
                  transaction_type, order_type, product_type, quantity, price,
                  order_status, executed_price, executed_at, square_off_reason, pnl)
                 VALUES (?, ?, ?, ?, 'SELL', 'MARKET', 'DELIVERY', ?, ?, 'TRADED', ?, NOW(), 'DELIVERY_EXPIRY', ?)`,
                [pos.dhan_client_id, pos.security_id, pos.trading_symbol,
                 pos.exchange_segment, netQty, ltp, ltp, pnl]
            );

            _notifyUser(
                pos.dhan_client_id,
                `📦 Delivery Position Expired — ${pos.trading_symbol}`,
                `${netQty} qty auto-squared @ ₹${ltp.toFixed(2)} (expiry day) | P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)} coins`
            );

            console.log(`[DEMO Squareoff] DELIVERY_EXPIRY ${pos.trading_symbol} for ${pos.dhan_client_id} qty=${netQty} @ ${ltp} PnL=${pnl}`);
            console.log(`[AUTO_SQUARE_OFF] product=DELIVERY securityId=${pos.security_id} quantity=${netQty} price=${ltp} reason=DELIVERY_EXPIRY`);
        }
    } catch (e) {
        console.log('[DEMO Squareoff] checkDeliverySquareOff error:', e.message);
    }
}

exports.syncDemoPnL = async () => {
    try {
        await subscribeOpenPositions();

        // Retry-safety-net: close anything checkDeliverySquareOff couldn't
        // close on its actual expiry day (e.g. no price tick that day).
        // Real price only — never fakes a fill, retries indefinitely.
        await autoExpirePositions();

        // Auto-close DELIVERY positions ON their expiry day, at live LTP
        await checkDeliverySquareOff();

        // Auto square-off INTRADAY positions before market close
        await checkIntradaySquareOff();

        // Auto SL/TP execution for SUPER orders
        await checkSuperOrderExits();

        // Execute PENDING LIMIT orders whose condition has been met
        await checkPendingLimitOrders();

        const users = await dbcon.query(DB,
            `SELECT DISTINCT dhan_client_id
             FROM demo_orders
             WHERE transaction_type='BUY'
               AND order_status='TRADED'
               AND DATE(created_at) = CURDATE()
             LIMIT ? OFFSET ?`,
            [BATCH_SIZE, demoOffset]
        );

        if (!users || users.length === 0) {
            demoOffset = 0;
            return;
        }

        console.log(`[DEMO LivePnL] Checking ${users.length} user(s) (offset: ${demoOffset})`);

        for (const row of users) {
            await checkDemoPnlNotification(row.dhan_client_id);
        }

        demoOffset += BATCH_SIZE;

    } catch (err) {
        console.log('[DEMO LivePnL] Cron error:', err.message);
    }
};
