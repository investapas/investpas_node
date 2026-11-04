// ─────────────────────────────────────────────────────────────────────────────
// IST market-session helpers for Demo Trading auto square-off.
// ─────────────────────────────────────────────────────────────────────────────
const dbcon = require('../config/mysqlClient');
const constants = require('../vars/constants');
const { isTradingDay: isTradingDayDate } = require('./nseHolidays');

const DB = constants.vals.defaultDB;

// NSE/BSE equity-derivative session close (IST). F&O contracts stop trading
// at this time on their expiry day — helpers/instrumentStatus.js uses it as
// the expiry cutoff, so there is one definition of "market close".
const MARKET_CLOSE_MINUTES_IST = 15 * 60 + 30;

// Same conversion pattern as helpers/advanceChallengeEngine.js:285
function getIstNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function minutesSinceMidnightIst(istDate) {
    const d = istDate || getIstNow();
    return d.getHours() * 60 + d.getMinutes();
}

function isTradingDay(istDate) {
    const d = istDate || getIstNow();
    return isTradingDayDate(d);
}

function parseHHMMSSToMinutes(hhmmss) {
    const parts = String(hhmmss || '').split(':').map(Number);
    if (parts.length < 2 || parts.some((p) => Number.isNaN(p))) return null;
    return parts[0] * 60 + parts[1];
}

// Earliest this trigger is ever allowed to fire, regardless of what's
// configured in demo_settings — 15:00 IST. A pending LIMIT order (or an
// open position) getting squared off mid-session because this setting was
// ever set wrong, left over from testing, or corrupted is a far worse
// failure than a late square-off would be: it looked exactly like "limit
// orders expire immediately on placement" when reproduced, because any
// value below this floor makes isPastSquareoffTime() true all day long.
// This makes that entire failure class structurally impossible rather than
// relying on the config always being correct.
const MIN_SQUAREOFF_TRIGGER_MINUTES = 15 * 60; // 15:00 IST

// Reads the configurable squareoff trigger time from demo_settings
// (same key-value table/pattern as coin_pack_price etc.).
// Default '15:20:00' — 10 minutes before the existing 15:30 market-close
// reference already hardcoded at controllers/DhanController.js:3019-3020.
async function getIntradaySquareoffMinutes() {
    try {
        const rows = await dbcon.query(
            DB,
            `SELECT setting_value FROM demo_settings WHERE setting_key='intraday_squareoff_time'`,
            []
        );
        const val = rows?.[0]?.setting_value;
        const mins = parseHHMMSSToMinutes(val);
        const resolved = mins != null ? mins : parseHHMMSSToMinutes('15:20:00');
        return Math.max(resolved, MIN_SQUAREOFF_TRIGGER_MINUTES);
    } catch (_) {
        return parseHHMMSSToMinutes('15:20:00');
    }
}

// True once IST time has reached the configured squareoff trigger, on a
// trading day. Callers should call this once per cron tick (cheap: one
// small query, cached implicitly by the 3s cron cadence).
async function isPastSquareoffTime() {
    const ist = getIstNow();
    if (!isTradingDay(ist)) return false;
    const triggerMins = await getIntradaySquareoffMinutes();
    return minutesSinceMidnightIst(ist) >= triggerMins;
}

// Same floor logic as MIN_SQUAREOFF_TRIGGER_MINUTES, 15 min earlier so this
// still runs slightly before the INTRADAY sweep when both are at their
// floor — 14:45 IST.
const MIN_EXPIRY_SQUAREOFF_TRIGGER_MINUTES = 14 * 60 + 45;

// Same pattern as getIntradaySquareoffMinutes, separate key — DELIVERY
// expiry square-off runs slightly before the INTRADAY EOD sweep so expiry
// exits settle first. Default '15:15:00'.
async function getExpirySquareoffMinutes() {
    try {
        const rows = await dbcon.query(
            DB,
            `SELECT setting_value FROM demo_settings WHERE setting_key='expiry_squareoff_time'`,
            []
        );
        const val = rows?.[0]?.setting_value;
        const mins = parseHHMMSSToMinutes(val);
        const resolved = mins != null ? mins : parseHHMMSSToMinutes('15:15:00');
        return Math.max(resolved, MIN_EXPIRY_SQUAREOFF_TRIGGER_MINUTES);
    } catch (_) {
        return parseHHMMSSToMinutes('15:15:00');
    }
}

async function isPastExpirySquareoffTime() {
    const ist = getIstNow();
    if (!isTradingDay(ist)) return false;
    const triggerMins = await getExpirySquareoffMinutes();
    return minutesSinceMidnightIst(ist) >= triggerMins;
}

module.exports = {
    MARKET_CLOSE_MINUTES_IST,
    getIstNow,
    minutesSinceMidnightIst,
    isTradingDay,
    getIntradaySquareoffMinutes,
    isPastSquareoffTime,
    getExpirySquareoffMinutes,
    isPastExpirySquareoffTime,
};
