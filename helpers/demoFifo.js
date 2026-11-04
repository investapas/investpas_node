// ─────────────────────────────────────────────────────────────────────────────
// Shared FIFO cost-basis helper for Demo Trading.
//
// Extracted from the near-identical logic previously duplicated in:
//   - controllers/DemoController.js  placeOrder()      (SELL branch)
//   - helpers/syncDemoTrades.js      checkSuperOrderExits()
//   - helpers/syncDemoTrades.js      autoExpirePositions()
// All three now call getNetQty()/computeAvgCostBasis() from here instead.
//
// Position scoping: every call takes `productType` and filters by it —
// INTRADAY and DELIVERY are separate FIFO pools per (client, security), so
// a SELL of one product type never draws against the other's holdings.
// ─────────────────────────────────────────────────────────────────────────────
const dbcon = require('../config/mysqlClient');
const constants = require('../vars/constants');

const DB = constants.vals.defaultDB;

// Net open quantity for (dhanClientId, securityId, productType), TRADED rows only.
async function getNetQty({ dhanClientId, securityId, productType }) {
    const rows = await dbcon.query(
        DB,
        `SELECT SUM(CASE WHEN transaction_type='BUY' THEN quantity ELSE -quantity END) AS net_qty
         FROM demo_orders
         WHERE dhan_client_id=? AND security_id=? AND product_type=? AND order_status='TRADED'`,
        [dhanClientId, securityId, productType]
    );
    return parseInt(rows?.[0]?.net_qty ?? 0, 10) || 0;
}

// Walks the FIFO buy queue (oldest-first), removes lots already consumed by
// prior TRADED sells, then consumes `sellQty` more from what remains and
// returns the weighted average cost basis for exactly that quantity.
// Mirrors the exact algorithm previously duplicated 3x — unchanged math.
async function computeAvgCostBasis({ dhanClientId, securityId, productType, sellQty }) {
    const buyLots = await dbcon.query(
        DB,
        `SELECT quantity, price FROM demo_orders
         WHERE dhan_client_id=? AND security_id=? AND product_type=?
           AND transaction_type='BUY' AND order_status='TRADED'
         ORDER BY created_at ASC`,
        [dhanClientId, securityId, productType]
    );
    const sellLots = await dbcon.query(
        DB,
        `SELECT quantity FROM demo_orders
         WHERE dhan_client_id=? AND security_id=? AND product_type=?
           AND transaction_type='SELL' AND order_status='TRADED'
         ORDER BY created_at ASC`,
        [dhanClientId, securityId, productType]
    );

    const queue = (buyLots || []).map((r) => ({ qty: Number(r.quantity), price: parseFloat(r.price) }));
    let coveredBySells = (sellLots || []).reduce((s, r) => s + Number(r.quantity), 0);
    while (coveredBySells > 0 && queue.length > 0) {
        const lot = queue[0];
        if (lot.qty <= coveredBySells) { coveredBySells -= lot.qty; queue.shift(); }
        else { lot.qty -= coveredBySells; coveredBySells = 0; }
    }

    let remaining = sellQty;
    let totalCost = 0;
    for (const lot of queue) {
        if (remaining <= 0) break;
        const take = Math.min(lot.qty, remaining);
        totalCost += take * lot.price;
        remaining -= take;
    }
    const avgCostBasis = sellQty > 0 ? totalCost / sellQty : 0;
    return { avgCostBasis, totalCost: parseFloat(totalCost.toFixed(2)) };
}

module.exports = { getNetQty, computeAvgCostBasis };
