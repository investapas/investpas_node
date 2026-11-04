"use strict";

// Turns raw trade legs (one row per fill, BUY or SELL) into the same
// per-date/per-security summary shape the Journal screen has always
// consumed (see the old inline version this replaced, in
// DhanController.getTradeHistory) — so the Flutter side needs no changes.
//
// Two matching methods, selected per-call (mirrors the Journal's existing
// "Weighted Avg / FIFO" toggle, which used to be purely cosmetic — every
// call actually used the 'weighted' formula below regardless of the
// toggle):
//
//  - 'weighted': day-average netting. avgBuyPrice/avgSellPrice across all
//    of a security's legs that day; closedQty = min(totalBuyQty,
//    totalSellQty); grossPnL = (avgSellPrice - avgBuyPrice) * closedQty.
//    Cheap, but blurs together fills made at very different prices.
//  - 'fifo': proper lot matching. Legs are processed in chronological
//    order against two FIFO queues (open BUY lots, open SELL lots) — a
//    BUY leg first closes out any open SELL lots (covering a short) before
//    opening a new BUY lot with whatever quantity is left, and vice versa.
//    Every match's P&L is (sellPrice - buyPrice) * matchedQty, which is
//    correct whichever side opened the position first.
//
// Both only match within a single calendar day — intentional, not a
// shortcap: every challenge rule in this app (NIFTY lots, SL-per-order,
// cooldowns) assumes INTRADAY product type, so a position is expected to
// be squared off same-day. A leg still open at day's end stays in its
// queue and simply contributes to an "OPEN"/"PARTIAL" status, not a
// fabricated cross-day match.

function roundMoney(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function dayKey(exchangeTime) {
  return (exchangeTime || "").toString().split(/[ T]/)[0] || "unknown";
}

function legSortTime(leg) {
  return new Date(leg.exchangeTime).getTime() || 0;
}

function toLeg(row) {
  return {
    orderId: row.order_id,
    tradedQuantity: Number(row.traded_quantity),
    tradedPrice: Number(row.traded_price),
    exchangeTime: row.exchange_time instanceof Date
      ? row.exchange_time.toISOString()
      : String(row.exchange_time),
    charges: Number(row.charges) || 0,
    transactionType: row.transaction_type,
  };
}

function matchWeighted(buys, sells) {
  const totalBuyQty = buys.reduce((s, t) => s + t.tradedQuantity, 0);
  const totalSellQty = sells.reduce((s, t) => s + t.tradedQuantity, 0);
  const avgBuyPrice = totalBuyQty > 0
    ? buys.reduce((s, t) => s + t.tradedPrice * t.tradedQuantity, 0) / totalBuyQty
    : 0;
  const avgSellPrice = totalSellQty > 0
    ? sells.reduce((s, t) => s + t.tradedPrice * t.tradedQuantity, 0) / totalSellQty
    : 0;
  const closedQty = Math.min(totalBuyQty, totalSellQty);
  const grossPnL = closedQty > 0
    ? roundMoney((avgSellPrice - avgBuyPrice) * closedQty)
    : null;
  return {
    totalBuyQty,
    totalSellQty,
    avgBuyPrice: roundMoney(avgBuyPrice),
    avgSellPrice: roundMoney(avgSellPrice),
    grossPnL,
  };
}

function matchFifo(buys, sells) {
  const legs = [...buys.map(l => ({ ...l, side: "BUY" })), ...sells.map(l => ({ ...l, side: "SELL" }))]
    .sort((a, b) => legSortTime(a) - legSortTime(b));

  const openBuyLots = []; // { price, qty }
  const openSellLots = [];
  let grossPnL = 0;
  let closedQty = 0;

  for (const leg of legs) {
    let remaining = leg.tradedQuantity;
    const matchQueue = leg.side === "BUY" ? openSellLots : openBuyLots;

    while (remaining > 0 && matchQueue.length > 0) {
      const lot = matchQueue[0];
      const matchQty = Math.min(remaining, lot.qty);
      const sellPrice = leg.side === "BUY" ? lot.price : leg.tradedPrice;
      const buyPrice = leg.side === "BUY" ? leg.tradedPrice : lot.price;
      grossPnL += (sellPrice - buyPrice) * matchQty;
      closedQty += matchQty;
      remaining -= matchQty;
      lot.qty -= matchQty;
      if (lot.qty === 0) matchQueue.shift();
    }

    if (remaining > 0) {
      const openQueue = leg.side === "BUY" ? openBuyLots : openSellLots;
      openQueue.push({ price: leg.tradedPrice, qty: remaining });
    }
  }

  const totalBuyQty = buys.reduce((s, t) => s + t.tradedQuantity, 0);
  const totalSellQty = sells.reduce((s, t) => s + t.tradedQuantity, 0);
  const avgBuyPrice = totalBuyQty > 0
    ? buys.reduce((s, t) => s + t.tradedPrice * t.tradedQuantity, 0) / totalBuyQty
    : 0;
  const avgSellPrice = totalSellQty > 0
    ? sells.reduce((s, t) => s + t.tradedPrice * t.tradedQuantity, 0) / totalSellQty
    : 0;

  return {
    totalBuyQty,
    totalSellQty,
    avgBuyPrice: roundMoney(avgBuyPrice),
    avgSellPrice: roundMoney(avgSellPrice),
    grossPnL: closedQty > 0 ? roundMoney(grossPnL) : null,
  };
}

/**
 * @param {Array} rows - raw `dhan_trades` DB rows (any date range)
 * @param {{method?: 'fifo'|'weighted'}} opts
 * @returns {{data: Object, summary: Array, totalRawTrades: number}}
 */
function buildTradeHistory(rows, opts = {}) {
  const method = opts.method === "weighted" ? "weighted" : "fifo";
  const matcher = method === "weighted" ? matchWeighted : matchFifo;

  // date → securityId → { meta, buys[], sells[] }
  const byDate = {};
  for (const row of rows) {
    const date = dayKey(row.exchange_time) !== "unknown"
      ? (row.trade_date instanceof Date
          ? row.trade_date.toISOString().split("T")[0]
          : String(row.trade_date).split("T")[0])
      : "unknown";
    if (!byDate[date]) byDate[date] = {};

    const sid = row.security_id;
    if (!byDate[date][sid]) {
      byDate[date][sid] = {
        customSymbol: row.custom_symbol || row.trading_symbol || "",
        securityId: sid,
        exchangeSegment: row.exchange_segment,
        productType: row.product_type,
        instrument: row.instrument,
        drvExpiryDate: row.drv_expiry_date,
        drvOptionType: row.drv_option_type,
        drvStrikePrice: row.drv_strike_price,
        buys: [],
        sells: [],
      };
    }

    const leg = toLeg(row);
    if (row.transaction_type === "BUY") byDate[date][sid].buys.push(leg);
    else byDate[date][sid].sells.push(leg);
  }

  const result = {};
  for (const [date, securities] of Object.entries(byDate)) {
    result[date] = [];
    for (const data of Object.values(securities)) {
      const { totalBuyQty, totalSellQty, avgBuyPrice, avgSellPrice, grossPnL } =
        matcher(data.buys, data.sells);

      const totalCharges = roundMoney(
        [...data.buys, ...data.sells].reduce((s, t) => s + t.charges, 0)
      );
      const netPnL = grossPnL !== null ? roundMoney(grossPnL - totalCharges) : null;

      let status = "OPEN";
      if (totalSellQty >= totalBuyQty && totalBuyQty > 0) status = "COMPLETED";
      else if (totalSellQty > 0) status = "PARTIAL";

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
        avgBuyPrice,
        avgSellPrice,
        status,
        grossPnL,
        totalCharges,
        netPnL,
        buyOrders: data.buys,
        sellOrders: data.sells,
      });
    }

    result[date].sort((a, b) => {
      const aTime = a.buyOrders[0]?.exchangeTime || a.sellOrders[0]?.exchangeTime || "";
      const bTime = b.buyOrders[0]?.exchangeTime || b.sellOrders[0]?.exchangeTime || "";
      return aTime.localeCompare(bTime);
    });
  }

  const sorted = Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => b.localeCompare(a))
  );

  const summary = Object.entries(sorted).map(([date, rowsForDate]) => ({
    date,
    totalTrades: rowsForDate.length,
    grossPnL: roundMoney(rowsForDate.reduce((s, r) => s + (r.grossPnL || 0), 0)),
    totalCharges: roundMoney(rowsForDate.reduce((s, r) => s + (r.totalCharges || 0), 0)),
    netPnL: roundMoney(rowsForDate.reduce((s, r) => s + (r.netPnL || 0), 0)),
  }));

  return { data: sorted, summary, totalRawTrades: rows.length };
}

module.exports = { buildTradeHistory };
