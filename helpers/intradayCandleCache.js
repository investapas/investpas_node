const dbcon = require('../config/mysqlClient');
const constants = require('../vars/constants');
const axios = require('axios');
const { getSelfToken } = require('./historicalCache');
const { isHoliday } = require('./nseHolidays');

const DB = constants.vals.defaultDB;
const TABLE = 'market_historical_candles';

let _tableReady = false;
async function _ensureTable() {
    if (_tableReady) return;
    try {
        const rows = await dbcon.query(DB,
            `SELECT TABLE_NAME FROM information_schema.tables
             WHERE table_schema=DATABASE() AND table_name='${TABLE}'`);
        if (!rows?.length) {
            await dbcon.query(DB,
                `CREATE TABLE IF NOT EXISTS ${TABLE} (
                    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    security_id VARCHAR(50) NOT NULL,
                    exchange_segment VARCHAR(50) NOT NULL,
                    instrument VARCHAR(50) NULL,
                    trading_symbol VARCHAR(150) NULL,
                    interval_minutes INT NOT NULL,
                    candle_timestamp BIGINT NOT NULL,
                    candle_datetime DATETIME NULL,
                    open_price DECIMAL(20,8) NOT NULL,
                    high_price DECIMAL(20,8) NOT NULL,
                    low_price DECIMAL(20,8) NOT NULL,
                    close_price DECIMAL(20,8) NOT NULL,
                    volume BIGINT NULL DEFAULT 0,
                    open_interest BIGINT NULL DEFAULT NULL,
                    source VARCHAR(50) NOT NULL DEFAULT 'DHAN',
                    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_market_candle (security_id, exchange_segment, interval_minutes, candle_timestamp),
                    INDEX idx_chart_lookup (security_id, exchange_segment, interval_minutes, candle_timestamp),
                    INDEX idx_candle_datetime (candle_datetime)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, []);
            console.log(`[IntradayCache] Created table ${TABLE}`);
        }
    } catch (e) {
        console.log('[IntradayCache] ensureTable error:', e.message);
    }
    _tableReady = true;
}

// ── IST time handling — TZ-independent (uses getUTC* after shifting the
// instant by +5:30, so this is correct regardless of the server process's
// own TZ env var). India has no DST, so a constant offset is safe. ──────────
function pad2(n) { return String(n).padStart(2, '0'); }

function istPartsFromEpochSeconds(ts) {
    const d = new Date(ts * 1000 + 5.5 * 60 * 60 * 1000);
    return {
        y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(),
        h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
        dow: d.getUTCDay(), // 0=Sun..6=Sat
    };
}

function istDateTimeString(ts) {
    const p = istPartsFromEpochSeconds(ts);
    return `${p.y}-${pad2(p.mo)}-${pad2(p.day)} ${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;
}

// Full IST calendar-day boundaries for a chunk request — Dhan only returns
// candles that actually fall within trading hours regardless of how wide the
// window is, so requesting whole days is simplest and safest.
function chunkFromDateString(epochSec) {
    const p = istPartsFromEpochSeconds(epochSec);
    return `${p.y}-${pad2(p.mo)}-${pad2(p.day)} 00:00:00`;
}
function chunkToDateString(epochSec) {
    const p = istPartsFromEpochSeconds(epochSec);
    return `${p.y}-${pad2(p.mo)}-${pad2(p.day)} 23:59:59`;
}

// ── Fetch one date-range chunk from Dhan and upsert into the DB ────────────
// Never partial-inserts a chunk whose parallel arrays don't line up in
// length. A clean response with zero candles (weekend/holiday range) is a
// SUCCESSFUL empty chunk, not an error.
async function _fetchAndStore(securityId, exchangeSegment, instrument, intervalMinutes, fromDate, toDate, oi, auth) {
    try {
        const resp = await axios.post('https://api.dhan.co/v2/charts/intraday', {
            securityId: String(securityId),
            exchangeSegment,
            instrument,
            interval: String(intervalMinutes),
            oi: !!oi,
            fromDate,
            toDate,
        }, {
            headers: { 'access-token': auth.token, 'client-id': auth.clientId, 'Content-Type': 'application/json' },
            timeout: 20000,
        });

        const d = resp.data;
        if (!d || typeof d !== 'object' || !Array.isArray(d.timestamp)) {
            return { ok: false, rangeError: false, received: 0, inserted: 0, skippedInvalid: 0, message: 'Invalid/empty Dhan response shape' };
        }

        const n = d.timestamp.length;
        const arrays = { open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume };
        for (const [k, v] of Object.entries(arrays)) {
            if (!Array.isArray(v) || v.length !== n) {
                console.log(`[IntradayCache] Array length mismatch for ${securityId} (${intervalMinutes}m): timestamp=${n} ${k}=${Array.isArray(v) ? v.length : 'missing'}`);
                return { ok: false, rangeError: false, received: 0, inserted: 0, skippedInvalid: 0, message: `Array length mismatch on '${k}'` };
            }
        }
        const hasOi = Array.isArray(d.open_interest);
        if (hasOi && d.open_interest.length !== n) {
            console.log(`[IntradayCache] OI array length mismatch for ${securityId} (${intervalMinutes}m)`);
            return { ok: false, rangeError: false, received: 0, inserted: 0, skippedInvalid: 0, message: 'OI array length mismatch' };
        }

        if (n === 0) {
            return { ok: true, rangeError: false, received: 0, inserted: 0, skippedInvalid: 0 };
        }

        const rows = [];
        let skippedInvalid = 0;
        for (let i = 0; i < n; i++) {
            const ts = d.timestamp[i];
            const o = Number(d.open[i]), h = Number(d.high[i]), l = Number(d.low[i]), c = Number(d.close[i]);
            const vol = Number(d.volume[i] || 0);
            const openInterest = hasOi && d.open_interest[i] != null ? Number(d.open_interest[i]) : null;

            const valid = ts && o > 0 && h > 0 && l > 0 && c > 0 &&
                h >= o && h >= c && h >= l && l <= o && l <= c;
            if (!valid) { skippedInvalid++; continue; }

            rows.push([
                String(securityId), exchangeSegment, instrument || null, null,
                intervalMinutes, ts, istDateTimeString(ts),
                o, h, l, c, vol, openInterest, 'DHAN',
            ]);
        }
        if (skippedInvalid > 0) {
            console.log(`[IntradayCache] Skipped ${skippedInvalid} invalid candle(s) for ${securityId} (${intervalMinutes}m), ${fromDate}→${toDate}`);
        }
        if (rows.length === 0) {
            return { ok: true, rangeError: false, received: n, inserted: 0, skippedInvalid };
        }

        const BATCH = 500;
        let inserted = 0;
        for (let i = 0; i < rows.length; i += BATCH) {
            const chunk = rows.slice(i, i + BATCH);
            await dbcon.query(DB,
                `INSERT INTO ${TABLE}
                 (security_id, exchange_segment, instrument, trading_symbol, interval_minutes,
                  candle_timestamp, candle_datetime, open_price, high_price, low_price, close_price,
                  volume, open_interest, source)
                 VALUES ?
                 ON DUPLICATE KEY UPDATE
                    candle_datetime=VALUES(candle_datetime),
                    open_price=VALUES(open_price), high_price=VALUES(high_price),
                    low_price=VALUES(low_price), close_price=VALUES(close_price),
                    volume=VALUES(volume), open_interest=VALUES(open_interest)`,
                [chunk]
            );
            inserted += chunk.length;
        }

        return { ok: true, rangeError: false, received: n, inserted, skippedInvalid };
    } catch (e) {
        const dhanMsg = e.response?.data?.errorMessage || e.response?.data?.message || e.message || 'Unknown error';
        const rangeError = /date|range|days?\b/i.test(String(dhanMsg));
        console.log(`[IntradayCache] Fetch error ${fromDate}→${toDate} for ${securityId} (${intervalMinutes}m):`, dhanMsg);
        return { ok: false, rangeError, received: 0, inserted: 0, skippedInvalid: 0, message: dhanMsg };
    }
}

// Fetches an arbitrary-width [fromSec, toSec] range, internally windowing
// into <=chunkDays-sized requests (walking backward from `toSec`) and
// halving-and-retrying any individual window that fails with a date-range-
// shaped error, down to a 5-day floor before giving up on that slice.
async function _fetchRange(securityId, exchangeSegment, instrument, intervalMinutes, fromSec, toSec, oi, auth, chunkDays) {
    const stats = { chunksAttempted: 0, chunksFailed: 0, recordsReceived: 0, recordsUpserted: 0, recordsSkippedInvalid: 0, failedChunks: [] };
    if (toSec <= fromSec) return stats;

    async function runChunk(winFromSec, winToSec, depth) {
        stats.chunksAttempted++;
        const fromDate = chunkFromDateString(winFromSec);
        const toDate = chunkToDateString(winToSec);
        const result = await _fetchAndStore(securityId, exchangeSegment, instrument, intervalMinutes, fromDate, toDate, oi, auth);
        if (!result.ok) {
            if (result.rangeError && (winToSec - winFromSec) > 5 * 86400 && depth < 4) {
                const midSec = winFromSec + Math.floor((winToSec - winFromSec) / 2);
                await runChunk(winFromSec, midSec, depth + 1);
                await runChunk(midSec + 86400, winToSec, depth + 1);
                return;
            }
            stats.chunksFailed++;
            stats.failedChunks.push({ fromDate, toDate, message: result.message });
            return;
        }
        stats.recordsReceived += result.received;
        stats.recordsUpserted += result.inserted;
        stats.recordsSkippedInvalid += result.skippedInvalid;

        // Sanity check — a full trading day at this interval should be roughly
        // 375 minutes worth of candles times the number of weekdays requested.
        // Weekends/holidays legitimately reduce this, so only warn (don't
        // fail) — this is purely a visibility aid for catching any remaining
        // silent-truncation behavior from Dhan without needing a screenshot.
        const spanDays = Math.max(1, Math.round((winToSec - winFromSec) / 86400));
        const roughWeekdays = Math.max(1, Math.round(spanDays * 5 / 7));
        const expectedMin = Math.floor((roughWeekdays * 375 / intervalMinutes) * 0.3); // 30% floor — generous for holidays
        if (result.received < expectedMin) {
            console.log(`[IntradayCache] ⚠ Low candle count for ${securityId} (${intervalMinutes}m) ${fromDate}→${toDate}: got ${result.received}, expected at least ~${expectedMin} — possible Dhan truncation`);
        }
    }

    let winTo = toSec;
    while (winTo > fromSec) {
        const winFrom = Math.max(fromSec, winTo - chunkDays * 86400);
        await runChunk(winFrom, winTo, 0);
        winTo = winFrom - 86400;
        await new Promise(r => setTimeout(r, 150));
    }
    return stats;
}

// Dhan's charts/intraday endpoint appears to silently return partial data
// for wide-range requests on fine-grained intervals — well below the 90-day
// cap documented for the endpoint overall (observed: a single 30-day 5-minute
// request came back with only ~1 day of real candles, no error). Since a
// silent partial response can't be detected as a failure and retried, the
// only reliable fix is keeping each individual Dhan request narrow to begin
// with, scaled down further for finer intervals (which pack more candles
// into the same date span).
function _defaultChunkDays(intervalMinutes) {
    if (intervalMinutes <= 1)  return 3;
    if (intervalMinutes <= 5)  return 5;
    if (intervalMinutes <= 15) return 10;
    return 20;
}

// ── Concurrency guard — prevents two near-simultaneous "first view" requests
// for the same security+segment+interval from both kicking off a full
// backfill (data stays correct either way via the unique key; this just
// avoids wasting Dhan quota). In-process only, matches this codebase's
// existing no-Redis, boolean/Set-guard precedent (e.g. the trade-sync cron's
// isRunning flag). ───────────────────────────────────────────────────────
const _syncing = new Set();
async function _withSyncLock(key, fn) {
    if (_syncing.has(key)) return { synced: false, message: 'Sync already in progress' };
    _syncing.add(key);
    try { return await fn(); }
    finally { _syncing.delete(key); }
}

exports.syncHistory = async function (securityId, exchangeSegment, instrument, intervalMinutes, opts = {}) {
    const backfillDays = opts.backfillDays || 180;
    const chunkDays = opts.chunkDays || _defaultChunkDays(intervalMinutes);
    const oi = !!opts.oi;
    const key = `${securityId}:${exchangeSegment}:${intervalMinutes}`;

    return _withSyncLock(key, async () => {
        await _ensureTable();
        const auth = await getSelfToken();
        if (!auth) return { synced: false, message: 'No market token' };

        const existing = await dbcon.query(DB,
            `SELECT MAX(candle_timestamp) AS newest, COUNT(*) AS total FROM ${TABLE}
             WHERE security_id=? AND exchange_segment=? AND interval_minutes=?`,
            [securityId, exchangeSegment, intervalMinutes]
        );
        const total = Number(existing?.[0]?.total || 0);
        const newestTs = Number(existing?.[0]?.newest || 0);
        const nowSec = Math.floor(Date.now() / 1000);

        let stats;
        if (total === 0) {
            stats = await _fetchRange(securityId, exchangeSegment, instrument, intervalMinutes,
                nowSec - backfillDays * 86400, nowSec, oi, auth, chunkDays);
            console.log(`[IntradayCache] ${securityId} (${intervalMinutes}m) backfill: ${stats.chunksAttempted} chunks (${stats.chunksFailed} failed), ${stats.recordsUpserted} candles stored`);
        } else if (newestTs + intervalMinutes * 60 < nowSec) {
            stats = await _fetchRange(securityId, exchangeSegment, instrument, intervalMinutes,
                newestTs + intervalMinutes * 60, nowSec, oi, auth, chunkDays);
            if (stats.recordsUpserted > 0) {
                console.log(`[IntradayCache] ${securityId} (${intervalMinutes}m) incremental: ${stats.recordsUpserted} candles stored`);
            }
        } else {
            stats = { chunksAttempted: 0, chunksFailed: 0, recordsReceived: 0, recordsUpserted: 0, recordsSkippedInvalid: 0, failedChunks: [] };
        }

        return { synced: true, total: total + stats.recordsUpserted, stats };
    });
};

// Fast-path used by the controller on a cold viewport — fetches/stores just
// the requested window so the first response isn't empty, without waiting
// for a full 180-day backfill.
exports.syncViewport = async function (securityId, exchangeSegment, instrument, intervalMinutes, fromEpochSec, toEpochSec, opts = {}) {
    const key = `${securityId}:${exchangeSegment}:${intervalMinutes}`;
    return _withSyncLock(key, async () => {
        await _ensureTable();
        const auth = await getSelfToken();
        if (!auth) return { synced: false, message: 'No market token' };
        const stats = await _fetchRange(securityId, exchangeSegment, instrument, intervalMinutes,
            fromEpochSec, toEpochSec, !!opts.oi, auth, opts.chunkDays || _defaultChunkDays(intervalMinutes));
        return { synced: true, stats };
    });
};

exports.getCachedCandles = async function (securityId, exchangeSegment, intervalMinutes, fromEpochSec, toEpochSec) {
    await _ensureTable();
    const rows = await dbcon.query(DB,
        `SELECT candle_timestamp, open_price, high_price, low_price, close_price, volume, open_interest
         FROM ${TABLE}
         WHERE security_id=? AND exchange_segment=? AND interval_minutes=?
           AND candle_timestamp BETWEEN ? AND ?
         ORDER BY candle_timestamp ASC`,
        [securityId, exchangeSegment, intervalMinutes, fromEpochSec, toEpochSec]
    );
    if (!rows?.length) return null;

    const result = { timestamp: [], open: [], high: [], low: [], close: [], volume: [], openInterest: [] };
    for (const r of rows) {
        result.timestamp.push(Number(r.candle_timestamp));
        result.open.push(Number(r.open_price));
        result.high.push(Number(r.high_price));
        result.low.push(Number(r.low_price));
        result.close.push(Number(r.close_price));
        result.volume.push(Number(r.volume));
        result.openInterest.push(r.open_interest != null ? Number(r.open_interest) : null);
    }
    return result;
};

// Trading-hours-aware staleness check — the daily module's "diffDays>1" is
// wrong here since intraday candles arrive every few minutes during market
// hours and nothing changes outside them.
exports.needsSync = async function (securityId, exchangeSegment, intervalMinutes) {
    await _ensureTable();
    const rows = await dbcon.query(DB,
        `SELECT MAX(candle_timestamp) AS newest FROM ${TABLE}
         WHERE security_id=? AND exchange_segment=? AND interval_minutes=?`,
        [securityId, exchangeSegment, intervalMinutes]
    );
    const newest = Number(rows?.[0]?.newest || 0);
    if (!newest) return true;

    const nowSec = Math.floor(Date.now() / 1000);
    const p = istPartsFromEpochSeconds(nowSec);
    const minutesOfDay = p.h * 60 + p.mi;
    const isTradingDay = p.dow !== 0 && p.dow !== 6 &&
        !isHoliday(new Date(p.y, p.mo - 1, p.day));
    const isTradingHours = minutesOfDay >= (9 * 60 + 15) && minutesOfDay <= (15 * 60 + 30);
    if (!isTradingDay || !isTradingHours) return false;

    const staleThresholdSec = Math.max(2 * intervalMinutes, 5) * 60;
    return (nowSec - newest) > staleThresholdSec;
};

exports.resyncHistory = async function (securityId, exchangeSegment, instrument, intervalMinutes) {
    await _ensureTable();
    await dbcon.query(DB,
        `DELETE FROM ${TABLE} WHERE security_id=? AND exchange_segment=? AND interval_minutes=?`,
        [securityId, exchangeSegment, intervalMinutes]
    );
    console.log(`[IntradayCache] Cleared ${securityId} (${intervalMinutes}m) — re-syncing...`);
    return exports.syncHistory(securityId, exchangeSegment, instrument, intervalMinutes);
};
