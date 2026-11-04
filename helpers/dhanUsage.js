// Live-mode trade/PnL/lots usage, computed directly from Dhan's own trade
// and position APIs. REAL orders have no local database log (they go
// straight to Dhan), so challenge_trade_logs is permanently empty — this
// module is the single source of truth for "what has this user actually
// done today in real mode," used by both checkOrderRules and the usage
// endpoint so there's only ever one counter to keep accurate.
const axios = require("axios");
const query = require("./query");
const constants = require("../vars/constants");

async function getDhanToken(dhanClientId) {
    const row = await query.fetchSingleRecord(
        constants.vals.defaultDB,
        "users",
        `WHERE dhan_client_id='${dhanClientId}'`,
        "dhan_access_token"
    );
    return row?.dhan_access_token || null;
}

const INDEX_MATCHERS = {
    NIFTY: (sym) =>
        sym.startsWith("NIFTY") &&
        !sym.startsWith("BANKNIFTY") &&
        !sym.startsWith("FINNIFTY") &&
        !sym.startsWith("MIDCPNIFTY") &&
        !sym.startsWith("MIDCAPNIFTY"),
    BANKNIFTY: (sym) => sym.startsWith("BANKNIFTY"),
    FINNIFTY: (sym) => sym.startsWith("FINNIFTY"),
    MIDCAPNIFTY: (sym) => sym.startsWith("MIDCPNIFTY") || sym.startsWith("MIDCAPNIFTY"),
    SENSEX: (sym) => sym.startsWith("SENSEX") || sym.startsWith("BANKEX"),
};

// Today's completed (SELL-side) trades + realized PnL, netted per security
// exactly like DhanController.getTradeHistory does, so this figure never
// disagrees with the trade-history screen. sessionStart (set after a quick
// unlock) filters out legs from before the reset.
async function getLiveTradesAndPnL(dhanClientId, sessionStart) {
    const token = await getDhanToken(dhanClientId);
    if (!token) return { tradesUsed: 0, sessionPnL: 0 };

    const today = new Date().toISOString().split("T")[0];
    let trades;
    try {
        const response = await axios.get(
            `https://api.dhan.co/v2/trades/${today}/${today}/0`,
            { headers: { "access-token": token, "Accept": "application/json" } }
        );
        trades = Array.isArray(response.data) ? response.data : [];
    } catch (error) {
        console.log("[dhanUsage] trade-history fetch failed:", error.response?.data || error.message);
        return { tradesUsed: 0, sessionPnL: 0 };
    }

    if (sessionStart) {
        const cutoff = new Date(sessionStart).getTime();
        trades = trades.filter((t) => new Date(t.exchangeTime).getTime() > cutoff);
    }

    const bySecurity = {};
    for (const t of trades) {
        const sid = t.securityId;
        if (!bySecurity[sid]) bySecurity[sid] = { buys: [], sells: [] };
        const charges =
            (t.sebiTax || 0) +
            (t.stt || 0) +
            (t.brokerageCharges || 0) +
            (t.serviceTax || 0) +
            (t.exchangeTransactionCharges || 0) +
            (t.stampDuty || 0);
        const leg = { qty: t.tradedQuantity, price: t.tradedPrice, charges };
        if (t.transactionType === "BUY") bySecurity[sid].buys.push(leg);
        else if (t.transactionType === "SELL") bySecurity[sid].sells.push(leg);
    }

    let tradesUsed = 0;
    let sessionPnL = 0;
    for (const { buys, sells } of Object.values(bySecurity)) {
        const sellQty = sells.reduce((s, l) => s + l.qty, 0);
        if (sellQty <= 0) continue; // still open, not a completed trade
        const buyQty = buys.reduce((s, l) => s + l.qty, 0);
        tradesUsed += 1;
        const avgBuy = buyQty > 0 ? buys.reduce((s, l) => s + l.price * l.qty, 0) / buyQty : 0;
        const avgSell = sells.reduce((s, l) => s + l.price * l.qty, 0) / sellQty;
        const closedQty = Math.min(buyQty, sellQty);
        const gross = (avgSell - avgBuy) * closedQty;
        const totalCharges = [...buys, ...sells].reduce((s, l) => s + l.charges, 0);
        sessionPnL += gross - totalCharges;
    }

    return { tradesUsed, sessionPnL: Math.round(sessionPnL * 100) / 100 };
}

// Current open lots for one index, from Dhan's real positions — mirrors the
// DEMO-mode net-qty check but reads Dhan's live book instead of demo_orders.
async function getLiveOpenLots(dhanClientId, index) {
    const matcher = INDEX_MATCHERS[index];
    if (!matcher) return 0;

    const token = await getDhanToken(dhanClientId);
    if (!token) return 0;

    let positions;
    try {
        const response = await axios.get("https://api.dhan.co/v2/positions", {
            headers: { "access-token": token, "Accept": "application/json" },
        });
        positions = Array.isArray(response.data) ? response.data : [];
    } catch (error) {
        console.log("[dhanUsage] positions fetch failed:", error.response?.data || error.message);
        return 0;
    }

    const matching = positions.filter((p) => p.tradingSymbol && matcher(p.tradingSymbol.toUpperCase()));
    if (!matching.length) return 0;

    // Lot size is per underlying, not per strike/expiry — any matching
    // position's securityId gives the right value for the whole index.
    const lotRow = await query.fetchSingleRecord(
        constants.vals.defaultDB,
        "instruments",
        `WHERE security_id='${matching[0].securityId}'`,
        "lot_size"
    );
    const lotSize = Number(lotRow?.lot_size || 1);

    const openQty = matching.reduce((s, p) => s + Math.max(0, Number(p.netQty) || 0), 0);
    return lotSize > 0 ? Math.round(openQty / lotSize) : 0;
}

module.exports = { getDhanToken, getLiveTradesAndPnL, getLiveOpenLots, INDEX_MATCHERS };
