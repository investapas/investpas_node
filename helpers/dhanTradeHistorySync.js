"use strict";
const axios = require("axios");
const query = require("./query");
const constants = require("../vars/constants");

// Keeps `dhan_trades` (see migrations/015_dhan_trade_history.sql) caught up
// with Dhan's own trade book, so the Journal screen (DhanController.
// getTradeHistory) never has to call Dhan live on every open. Two entry
// points:
//   - backfillTradeHistory: full lookback (default 365 days), paginated
//     until Dhan returns an empty page — used once per user (on Dhan
//     connect, or lazily the first time a never-synced user opens the
//     Journal).
//   - syncTodayTrades: same pagination loop, just for today — used by the
//     3:40 PM IST daily cron in app.js.
// Both are idempotent (upsert on the fill's composite unique key), so
// re-running either for a date range already stored is always safe.

const MAX_PAGES = 50; // Dhan pages are large; this comfortably covers a
// year of even very active intraday trading. A hard cap, not a realistic
// ceiling, so a misbehaving API response can never spin this forever.

function fmtDate(d) {
  return d.toISOString().split("T")[0];
}

async function fetchTradePage(dhanAccessToken, fromDate, toDate, page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await axios.get(
        `https://api.dhan.co/v2/trades/${fromDate}/${toDate}/${page}`,
        { headers: { "access-token": dhanAccessToken, "Accept": "application/json" } }
      );
      return Array.isArray(resp.data) ? resp.data : [];
    } catch (e) {
      const status = e.response?.status;
      if (status === 429 && attempt < 2) {
        console.log(`[TradeHistorySync] 429 on page ${page}, retrying in ${(attempt + 1) * 5}s`);
        await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
        continue;
      }
      console.log("[TradeHistorySync] page fetch error:", e.response?.data || e.message);
      return [];
    }
  }
  return [];
}

function toRow(dhanClientId, trade) {
  const charges = Math.round((
    (trade.sebiTax || 0) +
    (trade.stt || 0) +
    (trade.brokerageCharges || 0) +
    (trade.serviceTax || 0) +
    (trade.exchangeTransactionCharges || 0) +
    (trade.stampDuty || 0)
  ) * 100) / 100;

  const tradeDate = (trade.exchangeTime || "").split(/[ T]/)[0] || null;

  return {
    dhan_client_id: dhanClientId,
    order_id: trade.orderId || "",
    trading_symbol: trade.tradingSymbol || null,
    custom_symbol: trade.customSymbol || null,
    security_id: trade.securityId || "",
    exchange_segment: trade.exchangeSegment || "",
    product_type: trade.productType || null,
    instrument: trade.instrument || null,
    drv_expiry_date: trade.drvExpiryDate || null,
    drv_option_type: trade.drvOptionType || null,
    drv_strike_price: trade.drvStrikePrice || null,
    transaction_type: trade.transactionType === "SELL" ? "SELL" : "BUY",
    traded_quantity: Number(trade.tradedQuantity) || 0,
    traded_price: Number(trade.tradedPrice) || 0,
    charges,
    trade_date: tradeDate,
    exchange_time: (trade.exchangeTime || "").replace("T", " ").slice(0, 19),
  };
}

async function upsertRows(rows) {
  if (!rows.length) return;
  const cols = [
    "dhan_client_id", "order_id", "trading_symbol", "custom_symbol", "security_id",
    "exchange_segment", "product_type", "instrument", "drv_expiry_date",
    "drv_option_type", "drv_strike_price", "transaction_type", "traded_quantity",
    "traded_price", "charges", "trade_date", "exchange_time",
  ];
  const placeholders = rows.map(() => `(${cols.map(() => "?").join(",")})`).join(",");
  const params = [];
  for (const row of rows) for (const c of cols) params.push(row[c]);

  const sql = `
    INSERT INTO dhan_trades (${cols.join(",")})
    VALUES ${placeholders}
    ON DUPLICATE KEY UPDATE charges = VALUES(charges)
  `;
  await query.executeQuery(constants.vals.defaultDB, sql, params);
}

// Fetches+stores every fill for [fromDate, toDate], paging until Dhan
// returns an empty page (or MAX_PAGES is hit). Returns the total rows seen.
async function syncRange(dhanClientId, dhanAccessToken, fromDate, toDate) {
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const trades = await fetchTradePage(dhanAccessToken, fromDate, toDate, page);
    if (!trades.length) break;
    const rows = trades
      .filter(t => t.securityId && t.orderId)
      .map(t => toRow(dhanClientId, t));
    await upsertRows(rows);
    total += trades.length;
  }
  return total;
}

async function markSynced(dhanClientId) {
  await query.updateRecord(
    constants.vals.defaultDB,
    "users",
    `dhan_client_id='${dhanClientId}'`,
    `trade_history_synced_at = NOW()`
  );
}

async function backfillTradeHistory(dhanClientId, dhanAccessToken, { days = 365 } = {}) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  try {
    const total = await syncRange(dhanClientId, dhanAccessToken, fmtDate(from), fmtDate(to));
    await markSynced(dhanClientId);
    console.log(`[TradeHistorySync] backfill done for ${dhanClientId}: ${total} fills`);
    return total;
  } catch (e) {
    console.log(`[TradeHistorySync] backfill failed for ${dhanClientId}:`, e.message);
    return 0;
  }
}

async function syncTodayTrades(dhanClientId, dhanAccessToken) {
  const today = fmtDate(new Date());
  try {
    const total = await syncRange(dhanClientId, dhanAccessToken, today, today);
    await markSynced(dhanClientId);
    return total;
  } catch (e) {
    console.log(`[TradeHistorySync] today sync failed for ${dhanClientId}:`, e.message);
    return 0;
  }
}

module.exports = { backfillTradeHistory, syncTodayTrades };
