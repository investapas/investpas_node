const dbcon = require('../config/mysqlClient');
const constants = require('../vars/constants');
const axios = require('axios');

const DB = constants.vals.defaultDB;

let _tableReady = false;
async function _ensureTable() {
    if (_tableReady) return;
    try {
        const rows = await dbcon.query(DB,
            `SELECT COLUMN_TYPE FROM information_schema.columns
             WHERE table_schema=DATABASE() AND table_name='historical_candles' AND column_name='candle_date'`);
        const colType = rows?.[0]?.COLUMN_TYPE || '';

        if (!colType) {
            // Table doesn't exist — create it
            await dbcon.query(DB,
                `CREATE TABLE IF NOT EXISTS historical_candles (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    security_id VARCHAR(20) NOT NULL,
                    exchange_segment VARCHAR(30) NOT NULL,
                    candle_date DATE NOT NULL,
                    candle_timestamp BIGINT NOT NULL DEFAULT 0,
                    open_price DECIMAL(15,2) NOT NULL,
                    high_price DECIMAL(15,2) NOT NULL,
                    low_price DECIMAL(15,2) NOT NULL,
                    close_price DECIMAL(15,2) NOT NULL,
                    volume BIGINT DEFAULT 0,
                    UNIQUE KEY idx_candle (security_id, candle_date),
                    KEY idx_seg (exchange_segment)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, []);
        } else {
            // Table exists — check if candle_timestamp column exists
            const tsCol = await dbcon.query(DB,
                `SELECT COUNT(*) AS cnt FROM information_schema.columns
                 WHERE table_schema=DATABASE() AND table_name='historical_candles' AND column_name='candle_timestamp'`);
            if (Number(tsCol?.[0]?.cnt || 0) === 0) {
                await dbcon.query(DB,
                    `ALTER TABLE historical_candles ADD COLUMN candle_timestamp BIGINT NOT NULL DEFAULT 0 AFTER candle_date`, []);
            }
        }
    } catch (_) {}
    _tableReady = true;
}

async function _getSelfToken() {
    const clientId = process.env.DHAN_MARKET_CLIENT_ID;
    if (!clientId) return null;
    try {
        const row = await dbcon.query(DB,
            `SELECT access_token FROM market_data_tokens WHERE dhan_client_id=? LIMIT 1`, [clientId]);
        if (row?.[0]?.access_token) return { token: row[0].access_token, clientId };
    } catch (_) {}
    const envToken = process.env.DHAN_MARKET_ACCESS_TOKEN;
    if (envToken) return { token: envToken, clientId };
    return null;
}

function _fmt(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function _fetchAndStore(securityId, exchangeSegment, instrument, fromDate, toDate, auth) {
    try {
        const resp = await axios.post('https://api.dhan.co/v2/charts/historical', {
            securityId: String(securityId),
            exchangeSegment,
            instrument,
            expiryCode: 0,
            fromDate,
            toDate,
        }, {
            headers: { 'access-token': auth.token, 'client-id': auth.clientId, 'Content-Type': 'application/json' },
            timeout: 15000,
        });

        const d = resp.data;
        if (!d?.open?.length) return 0;

        const rows = [];
        for (let i = 0; i < d.open.length; i++) {
            const ts = d.timestamp?.[i];
            if (!ts) continue;
            // Use IST date (UTC+5:30) for the candle_date
            const utcMs = ts * 1000;
            const istMs = utcMs + (5.5 * 60 * 60 * 1000);
            const istDate = new Date(istMs);
            rows.push([
                securityId, exchangeSegment,
                _fmt(istDate), ts,
                d.open[i], d.high[i], d.low[i], d.close[i], d.volume?.[i] || 0,
            ]);
        }

        if (rows.length === 0) return 0;

        const BATCH = 500;
        for (let i = 0; i < rows.length; i += BATCH) {
            const chunk = rows.slice(i, i + BATCH);
            await dbcon.query(DB,
                `INSERT INTO historical_candles
                 (security_id, exchange_segment, candle_date, candle_timestamp, open_price, high_price, low_price, close_price, volume)
                 VALUES ?
                 ON DUPLICATE KEY UPDATE
                    candle_timestamp=VALUES(candle_timestamp),
                    open_price=VALUES(open_price), high_price=VALUES(high_price),
                    low_price=VALUES(low_price), close_price=VALUES(close_price),
                    volume=VALUES(volume)`,
                [chunk]
            );
        }

        return rows.length;
    } catch (e) {
        console.log(`[HistCache] Fetch error ${fromDate}→${toDate}:`, e.message);
        return 0;
    }
}

exports.syncHistory = async function (securityId, exchangeSegment, instrument) {
    await _ensureTable();
    const auth = await _getSelfToken();
    if (!auth) return { synced: false, message: 'No market token' };

    const existing = await dbcon.query(DB,
        `SELECT MIN(candle_date) AS oldest, MAX(candle_date) AS newest, COUNT(*) AS total
         FROM historical_candles WHERE security_id=?`,
        [securityId]
    );
    const newest = existing?.[0]?.newest;
    const total = Number(existing?.[0]?.total || 0);

    const now = new Date();
    let totalSynced = 0;

    if (total === 0) {
        for (let y = 0; y < 6; y++) {
            const to = new Date(now);
            to.setFullYear(to.getFullYear() - y);
            const from = new Date(to);
            from.setFullYear(from.getFullYear() - 1);

            const count = await _fetchAndStore(securityId, exchangeSegment, instrument, _fmt(from), _fmt(to), auth);
            totalSynced += count;
            console.log(`[HistCache] ${securityId} year-${y}: ${_fmt(from)} → ${_fmt(to)} = ${count} candles`);
            if (count === 0 && y > 1) break;
        }
    } else {
        const fromDate = new Date(newest);
        fromDate.setDate(fromDate.getDate() + 1);
        if (fromDate < now) {
            totalSynced = await _fetchAndStore(securityId, exchangeSegment, instrument, _fmt(fromDate), _fmt(now), auth);
            console.log(`[HistCache] ${securityId} update: ${_fmt(fromDate)} → ${_fmt(now)} = ${totalSynced} candles`);
        }
    }

    return { synced: true, total: total + totalSynced };
};

exports.getCachedCandles = async function (securityId) {
    await _ensureTable();

    const rows = await dbcon.query(DB,
        `SELECT candle_date, candle_timestamp, open_price, high_price, low_price, close_price, volume
         FROM historical_candles
         WHERE security_id=?
         ORDER BY candle_date ASC`,
        [securityId]
    );

    if (!rows?.length) return null;

    const result = { timestamp: [], open: [], high: [], low: [], close: [], volume: [] };
    for (const r of rows) {
        // Use stored original Dhan timestamp, fallback to candle_date
        const ts = Number(r.candle_timestamp) > 0
            ? Number(r.candle_timestamp)
            : Math.floor(new Date(r.candle_date + 'T09:15:00+05:30').getTime() / 1000);
        result.timestamp.push(ts);
        result.open.push(Number(r.open_price));
        result.high.push(Number(r.high_price));
        result.low.push(Number(r.low_price));
        result.close.push(Number(r.close_price));
        result.volume.push(Number(r.volume));
    }

    return result;
};

exports.needsSync = async function (securityId) {
    await _ensureTable();
    const rows = await dbcon.query(DB,
        `SELECT MAX(candle_date) AS newest FROM historical_candles WHERE security_id=?`,
        [securityId]
    );
    if (!rows?.[0]?.newest) return true;

    const newest = new Date(rows[0].newest);
    const now = new Date();
    const diffDays = (now - newest) / (1000 * 60 * 60 * 24);
    return diffDays > 1;
};

// Delete all data for a security and re-sync
exports.resyncHistory = async function (securityId, exchangeSegment, instrument) {
    await _ensureTable();
    await dbcon.query(DB, `DELETE FROM historical_candles WHERE security_id=?`, [securityId]);
    console.log(`[HistCache] Cleared ${securityId} — re-syncing...`);
    return exports.syncHistory(securityId, exchangeSegment, instrument);
};

// Delete ALL cached data
exports.clearAll = async function () {
    await _ensureTable();
    await dbcon.query(DB, `TRUNCATE TABLE historical_candles`, []);
    console.log('[HistCache] All data cleared');
};

// Shared SELF market-token auth, reused by helpers/intradayCandleCache.js
exports.getSelfToken = _getSelfToken;
