const axios = require("axios");
const query = require("../helpers/query");
const constants = require("../vars/constants");

const {
    checkUserRules,
    checkCapitalBeforeTrade,
    notifyChallenge,
    onTradeExit
} = require("../helpers/challengeEngine");

const { cancelPendingOrders } = require("../helpers/orderManager");

let currentOffset = 0;
const BATCH_SIZE = 50;

exports.syncDhanTrades = async () => {
    try {

        const users = await query.fetchRecords(
            constants.vals.defaultDB,
            "users",
            `WHERE dhan_client_id IS NOT NULL 
             AND is_active = 1
             LIMIT ${BATCH_SIZE} OFFSET ${currentOffset}`
        );

        if (!users || users.length === 0) {
            currentOffset = 0;
            return;
        }

        for (const user of users) {

            const token = user.dhan_access_token;
            const clientId = user.dhan_client_id;

            if (!token) continue;

            // =========================
            // 🚫 RULE CHECK
            // =========================
            const rule = await checkUserRules(clientId);
            const userBlocked = rule.blocked;

            // Fetch active challenge_id once per user (used when logging BUY trades)
            const activeChallenge = await query.fetchSingleRecord(
                constants.vals.defaultDB,
                "user_challenges",
                `WHERE dhan_client_id='${clientId}' AND is_active=1`
            );
            const challengeId = activeChallenge?.id || null;

            if (userBlocked) {
                console.log(`🚫 User Blocked → ${clientId} | Cancelling pending BUYs only, still syncing SELLs`);
                await cancelPendingOrders(clientId, token); // now only cancels BUY orders
                // Do NOT use `continue` here — we still need to process SELL executions
                // so the user can close their open positions and PnL gets recorded.
            }

            try {

                const response = await axios.get(
                    "https://api.dhan.co/v2/trades",
                    {
                        headers: { "access-token": token }
                    }
                );

                const trades = response.data || [];

                for (const trade of trades) {

                    console.log("➡️ Trade:", trade.orderId, trade.transactionType);

                    if (!trade.tradedQuantity || trade.tradedQuantity <= 0) continue;

                    // =========================
                    // 🔁 DUPLICATE CHECK (FIXED)
                    // =========================
                    let exists = null;

                    if (trade.transactionType === "BUY") {
                        exists = await query.fetchSingleRecord(
                            constants.vals.defaultDB,
                            "challenge_trade_logs",
                            `WHERE buy_order_id='${trade.orderId}'`
                        );
                    }

                    if (trade.transactionType === "SELL") {
                        exists = await query.fetchSingleRecord(
                            constants.vals.defaultDB,
                            "challenge_trade_logs",
                            `WHERE sell_order_id='${trade.orderId}'`
                        );
                    }

                    if (exists && Object.keys(exists).length > 0) {
                        console.log("⛔ Duplicate skip:", trade.orderId);
                        continue;
                    }

                    // =========================
                    // 🟢 BUY TRADE
                    // =========================
                    if (trade.transactionType === "BUY") {

                        // When user is blocked: skip logging new BUY trades
                        if (userBlocked) {
                            console.log(`⛔ Blocked — skipping BUY log for ${trade.orderId}`);
                            continue;
                        }

                        // 🚫 CAPITAL CHECK
                        const capitalCheck = await checkCapitalBeforeTrade(
                            clientId,
                            trade.tradedPrice,
                            trade.tradedQuantity
                        );

                        if (!capitalCheck.allowed) {
                            console.log(`⚠️ Capital limit reached for ${clientId} — still logging (order already executed)`);
                        }

                        await query.insertSingle(constants.vals.defaultDB, "challenge_trade_logs", {
                            dhan_client_id: clientId,
                            challenge_id: challengeId,
                            security_id: trade.securityId,
                            trading_symbol: trade.tradingSymbol,
                            exchange_segment: trade.exchangeSegment,
                            product_type: trade.productType,
                            buy_price: trade.tradedPrice,
                            buy_order_id: trade.orderId,
                            buy_executed_at: trade.exchangeTime,
                            quantity: trade.tradedQuantity,
                            status: "OPEN",
                            pnl: 0,
                            trade_date: new Date().toISOString().slice(0, 10)
                        });
                    }

                    // =========================
                    // 🔻 SELL TRADE
                    // =========================
                    if (trade.transactionType === "SELL") {

                        // Only match a BUY that executed BEFORE this sell.
                        // Without this filter the sync can pair a sell to a future buy
                        // (when both arrive in the same sync batch), producing wrong P&L.
                        const openTrade = await query.fetchSingleRecord(
                            constants.vals.defaultDB,
                            "challenge_trade_logs",
                            `WHERE security_id='${trade.securityId}'
                             AND status='OPEN'
                             AND dhan_client_id='${clientId}'
                             AND buy_executed_at <= '${trade.exchangeTime}'
                             ORDER BY buy_executed_at ASC`
                        );

                        if (!openTrade || Object.keys(openTrade).length === 0) {
                            console.log("⚠️ No BUY found for SELL:", trade.orderId);
                            continue;
                        }

                        const sellQty = Number(trade.tradedQuantity);
                        const buyQty = Number(openTrade.quantity);

                        const remainingQty = buyQty - sellQty;

                        const pnl =
                            (Number(trade.tradedPrice) - Number(openTrade.buy_price)) *
                            sellQty;

                        // =========================
                        // FULL CLOSE
                        // =========================
                        if (remainingQty <= 0) {

                            await query.updateRecord(
                                constants.vals.defaultDB,
                                "challenge_trade_logs",
                                `id='${openTrade.id}'`,
                                `
                                sell_price='${trade.tradedPrice}',
                                sell_order_id='${trade.orderId}',
                                sell_executed_at='${trade.exchangeTime}',
                                status='CLOSED',
                                pnl='${pnl}'
                                `
                            );

                            // ── Advanced: track cooldown + consecutive losses ──
                            onTradeExit(clientId, pnl, trade.tradingSymbol);

                        } else {

                            // =========================
                            // PARTIAL SELL
                            // =========================

                            // Update remaining qty
                            await query.updateRecord(
                                constants.vals.defaultDB,
                                "challenge_trade_logs",
                                `id='${openTrade.id}'`,
                                `quantity='${remainingQty}'`
                            );

                            // Insert closed trade for sold qty
                            await query.insertSingle(
                                constants.vals.defaultDB,
                                "challenge_trade_logs",
                                {
                                    dhan_client_id: clientId,
                                    challenge_id: challengeId,
                                    security_id: trade.securityId,
                                    trading_symbol: trade.tradingSymbol,
                                    exchange_segment: trade.exchangeSegment,
                                    product_type: trade.productType,
                                    buy_price: openTrade.buy_price,
                                    sell_price: trade.tradedPrice,
                                    sell_order_id: trade.orderId,
                                    quantity: sellQty,
                                    status: "CLOSED",
                                    pnl,
                                    trade_date: new Date().toISOString().slice(0, 10)
                                }
                            );

                            // ── Advanced: track cooldown + consecutive losses ──
                            onTradeExit(clientId, pnl, trade.tradingSymbol);
                        }
                    }
                }

            } catch (err) {

                // =========================
                // 🔐 TOKEN EXPIRED
                // =========================
                if (err.response?.status === 401) {
                    console.log(`🔒 Token expired for user: ${clientId}`);

                    await query.updateRecord(
                        constants.vals.defaultDB,
                        "users",
                        `dhan_client_id='${clientId}'`,
                        `dhan_access_token=NULL`
                    );

                    continue;
                }

                console.log("❌ CRON ERROR:", err.message);
                continue;
            }

            // =========================
            // 🔔 LIVE P&L ALERT (notify-only, no blocking)
            // Only runs for users who have at least one real trade logged today
            // (challenge_trade_logs). Demo-only traders are excluded — their
            // P&L alerts come from checkDemoChallengeRules, not this cron.
            // =========================
            if (activeChallenge && !userBlocked) {
                const maxLoss = Number(activeChallenge.max_loss || 0);
                const maxProfit = Number(activeChallenge.max_profit || 0);

                if (maxLoss > 0 || maxProfit > 0) {
                    // Skip users with no real trades — they are demo-only traders
                    const realTradeCount = await query.fetchSingleRecord(
                        constants.vals.defaultDB,
                        "challenge_trade_logs",
                        `WHERE dhan_client_id='${clientId}' AND DATE(created_at)=CURDATE()`,
                        "COUNT(*) as total"
                    );
                    const hasRealTrades = Number(realTradeCount?.total || 0) > 0;

                    if (!hasRealTrades) {
                        console.log(`[LivePnL] Skipping ${clientId} — no real trades today (demo-only)`);
                    } else {
                        try {
                            const posResponse = await axios.get(
                                "https://api.dhan.co/v2/positions",
                                { headers: { "access-token": token } }
                            );
                            const positions = Array.isArray(posResponse.data) ? posResponse.data : [];
                            const totalLivePnl = positions.reduce(
                                (sum, pos) => sum + (Number(pos.unrealizedProfit) || 0) + (Number(pos.realizedProfit) || 0),
                                0
                            );

                            let alertReason = null;
                            if (maxLoss > 0 && totalLivePnl <= -maxLoss) {
                                alertReason = 'MAX LOSS HIT';
                            } else if (maxProfit > 0 && totalLivePnl >= maxProfit) {
                                alertReason = 'TARGET ACHIEVED';
                            }

                            const lastAlertDate = activeChallenge.last_pnl_alert_date
                                ? new Date(activeChallenge.last_pnl_alert_date).toDateString()
                                : null;
                            const alreadyAlertedToday = lastAlertDate === new Date().toDateString();

                            if (alertReason && !alreadyAlertedToday) {
                                notifyChallenge(clientId, alertReason);
                                await query.updateRecord(
                                    constants.vals.defaultDB,
                                    "user_challenges",
                                    `id=${activeChallenge.id}`,
                                    `last_pnl_alert_date=CURDATE(), last_pnl_alert_reason='${alertReason}'`
                                );
                                console.log(`[LivePnL] 🔔 ${alertReason} → ${clientId} | totalPnl=${totalLivePnl.toFixed(2)}`);
                            }
                        } catch (e) {
                            console.log(`[LivePnL] Error for ${clientId}:`, e.message);
                        }
                    }
                }
            }
        }

        currentOffset += BATCH_SIZE;

    } catch (err) {
        console.log("❌ CRON ERROR:", err.message);
    }
};