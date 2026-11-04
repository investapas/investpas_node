// ─────────────────────────────────────────────────────────────────────────────
// Instrument lifecycle — the single source of truth for whether an
// instrument is ACTIVE (tradable / watchlist / search / live-feed eligible),
// EXPIRED, INACTIVE or UNKNOWN.
//
// Rules
//   • Only derivatives (options/futures) expire. Equities, ETFs and indices
//     are never EXPIRED — a closed market or a missing price does not make an
//     instrument inactive.
//   • A derivative trades until market close (15:30 IST) on its expiry date;
//     from then on it is EXPIRED.
//   • All dates are evaluated in Asia/Kolkata, computed here in Node and
//     passed to SQL as parameters — never MySQL CURDATE(), whose timezone is
//     the DB server's, and never the device clock.
// ─────────────────────────────────────────────────────────────────────────────
const dbcon = require('../config/mysqlClient');
const constants = require('../vars/constants');
const utility = require('./utility');
const { MARKET_CLOSE_MINUTES_IST } = require('./marketSession');

const DB = constants.vals.defaultDB;

// Socket events and crons can run before any HTTP request has opened the
// pool (same guard app.js uses in every cron).
async function ensureDb() {
    if (utility.checkEmpty(constants.vals.dbconn)) {
        constants.vals.dbconn = await dbcon.connection();
    }
}
const TZ = 'Asia/Kolkata';

const STATUS = Object.freeze({
    ACTIVE: 'ACTIVE',
    EXPIRED: 'EXPIRED',
    INACTIVE: 'INACTIVE',
    UNKNOWN: 'UNKNOWN',
});

// Dhan INSTRUMENT codes that carry a contract expiry.
const DERIVATIVE_INSTRUMENTS = ['OPTIDX', 'OPTSTK', 'FUTIDX', 'FUTSTK', 'OPTCUR', 'FUTCUR', 'OPTFUT', 'FUTCOM'];
const DERIVATIVE_SET = new Set(DERIVATIVE_INSTRUMENTS);

// Segments whose instruments live in the `instruments` master (only the
// F&O CSVs are imported). Equity/index segments can't be validated against
// the master and are treated as non-expiring.
const MASTER_SEGMENTS = new Set(['NSE_FNO', 'BSE_FNO']);

// ── IST clock ───────────────────────────────────────────────────────────────
const _dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const _timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function istDateKey(now = new Date()) {
    return _dateFmt.format(now); // YYYY-MM-DD
}

function istMinutes(now = new Date()) {
    const [h, m] = _timeFmt.format(now).split(':').map(Number);
    return h * 60 + m;
}

function addDays(dateKey, n) {
    const d = new Date(`${dateKey}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

// Earliest expiry date that is still tradable right now: today until
// market close, tomorrow after it. Use as `sm_expiry_date >= ?`.
function firstActiveExpiryDate(now = new Date()) {
    const today = istDateKey(now);
    return istMinutes(now) >= MARKET_CLOSE_MINUTES_IST ? addDays(today, 1) : today;
}

// Normalises a DB/API expiry value ('2026-10-06', '2026-10-06 00:00:00',
// a Date) to 'YYYY-MM-DD'. Dhan uses '0001-01-01' for "no expiry".
function toDateKey(value) {
    if (!value) return null;
    if (value instanceof Date) {
        if (isNaN(value)) return null;
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        value = `${y}-${m}-${d}`;
    }
    const key = String(value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key <= '1900-01-01') return null;
    return key;
}

function isDerivative(instrumentType) {
    return DERIVATIVE_SET.has(String(instrumentType || '').toUpperCase());
}

function isExpiryPassed(expiry, now = new Date()) {
    const key = toDateKey(expiry);
    if (!key) return false;
    return key < firstActiveExpiryDate(now);
}

// ── Status ──────────────────────────────────────────────────────────────────
// Accepts an `instruments` row, a `user_wishlist` snapshot row, or an API
// shaped object ({ instrumentType, expiry, lifecycleStatus }).
function getInstrumentStatus(inst, now = new Date()) {
    if (!inst) return { status: STATUS.UNKNOWN, isTradable: false, reason: 'Instrument not found' };

    const type = inst.instrument || inst.instrument_type || inst.instrumentType;
    const expiry = inst.sm_expiry_date ?? inst.expiry_date ?? inst.expiry;
    const lifecycle = inst.lifecycle_status || inst.lifecycleStatus;

    if (isDerivative(type)) {
        if (isExpiryPassed(expiry, now)) {
            return { status: STATUS.EXPIRED, isTradable: false, reason: 'Contract expired' };
        }
        if (!toDateKey(expiry)) {
            return { status: STATUS.UNKNOWN, isTradable: false, reason: 'Contract expiry unknown' };
        }
    }
    if (lifecycle === STATUS.EXPIRED) {
        return { status: STATUS.EXPIRED, isTradable: false, reason: 'Contract expired' };
    }
    if (lifecycle === STATUS.INACTIVE) {
        return { status: STATUS.INACTIVE, isTradable: false, reason: 'No longer listed by the exchange' };
    }
    return { status: STATUS.ACTIVE, isTradable: true, reason: null };
}

// ── Segment mapping ─────────────────────────────────────────────────────────
// instruments.exch_id + instruments.segment (CSV codes) → Dhan ExchangeSegment.
function toExchangeSegment(exchId, segment) {
    const exch = String(exchId || '').toUpperCase();
    const seg = String(segment || '').toUpperCase();
    if (seg === 'D') return exch === 'BSE' ? 'BSE_FNO' : 'NSE_FNO';
    if (seg === 'E') return exch === 'BSE' ? 'BSE_EQ' : 'NSE_EQ';
    if (seg === 'I') return 'IDX_I';
    return seg || null;
}

// ── Lookups ─────────────────────────────────────────────────────────────────
// One row per (exchange_segment, security_id) — the master's unique key.
// Without a segment, prefers the ACTIVE row (an index id can exist on
// both NSE and BSE).
async function findInstrument(securityId, exchangeSegment) {
    if (!securityId) return null;
    await ensureDb();
    const params = [String(securityId)];
    let segFilter = '';
    if (exchangeSegment) {
        segFilter = 'AND exchange_segment = ?';
        params.push(String(exchangeSegment));
    }
    const rows = await dbcon.query(
        DB,
        `SELECT * FROM instruments WHERE security_id = ? ${segFilter}
         ORDER BY lifecycle_status = 'ACTIVE' DESC, sm_expiry_date DESC LIMIT 1`,
        params
    );
    return (rows && rows[0]) || null;
}

// Order-time gate. Backend is authoritative: an expired/inactive contract is
// rejected even if a stale client still shows it.
// A contract that isn't in the master yet (e.g. a strike the exchange added
// after today's 08:30 sync) is allowed through — it can't be expired.
async function checkTradable({ securityId, exchangeSegment }) {
    const inst = await findInstrument(securityId, exchangeSegment);
    if (!inst) {
        if (MASTER_SEGMENTS.has(String(exchangeSegment || ''))) {
            console.log(`[ORDER_VALIDATION] securityId=${securityId} segment=${exchangeSegment} not in instrument master — allowing`);
        }
        return { ok: true, status: STATUS.UNKNOWN, instrument: null };
    }
    const st = getInstrumentStatus(inst);
    if (!st.isTradable) {
        const label = inst.display_name || inst.symbol_name || securityId;
        console.log(`[ORDER_VALIDATION] Rejected order — ${label} (securityId=${securityId}) is ${st.status}: ${st.reason}`);
        const message = st.status === STATUS.EXPIRED
            ? `${label} has expired. New orders are not allowed for this contract.`
            : `${label} is not available for trading (${st.reason}).`;
        return { ok: false, status: st.status, message, instrument: inst };
    }
    return { ok: true, status: st.status, instrument: inst };
}

// Live-feed gate: drops instruments the master knows to be expired/inactive.
// Unknown instruments (equity, index, not-yet-synced strikes) pass through.
async function filterSubscribable(instruments) {
    const list = (instruments || []).filter((i) => i && i.SecurityId != null);
    const fno = list.filter((i) => MASTER_SEGMENTS.has(String(i.ExchangeSegment)));
    if (!fno.length) return list;

    const ids = [...new Set(fno.map((i) => String(i.SecurityId)))];
    await ensureDb();
    const rows = await dbcon.query(
        DB,
        `SELECT security_id, exchange_segment, instrument, sm_expiry_date, lifecycle_status
         FROM instruments WHERE security_id IN (?) AND exchange_segment IN ('NSE_FNO','BSE_FNO')`,
        [ids]
    );
    const blocked = new Set();
    for (const r of rows || []) {
        if (!getInstrumentStatus(r).isTradable) blocked.add(`${r.exchange_segment}|${r.security_id}`);
    }
    if (!blocked.size) return list;
    return list.filter((i) => !blocked.has(`${i.ExchangeSegment}|${String(i.SecurityId)}`));
}

// SQL fragment for "currently tradable derivative" on an `instruments` alias.
function activeDerivativeFilter(alias = 'instruments', now = new Date()) {
    const a = alias;
    return {
        sql: `${a}.lifecycle_status = 'ACTIVE' AND ${a}.instrument IN (${DERIVATIVE_INSTRUMENTS.map(() => '?').join(',')}) AND ${a}.sm_expiry_date >= ?`,
        params: [...DERIVATIVE_INSTRUMENTS, firstActiveExpiryDate(now)],
    };
}

// ── Lifecycle sweep ─────────────────────────────────────────────────────────
// Idempotent. Runs after market close, at midnight, after the instrument
// sync and at startup. Never deletes anything.
async function sweepExpired(now = new Date()) {
    await ensureDb();
    const cutoff = firstActiveExpiryDate(now);
    const derivPh = DERIVATIVE_INSTRUMENTS.map(() => '?').join(',');
    const result = { instruments: 0, watchlist: 0, pendingOrders: 0, unsubscribed: 0 };

    // 1. Instrument master: derivatives past expiry → EXPIRED.
    const inst = await dbcon.query(
        DB,
        `UPDATE instruments SET lifecycle_status = 'EXPIRED', expired_at = NOW()
         WHERE lifecycle_status = 'ACTIVE' AND instrument IN (${derivPh})
           AND sm_expiry_date IS NOT NULL AND sm_expiry_date > '1900-01-01' AND sm_expiry_date < ?`,
        [...DERIVATIVE_INSTRUMENTS, cutoff]
    );
    result.instruments = (inst && inst.affectedRows) || 0;

    // 2. Watchlist: judged on the contract snapshot stored on the row, so a
    //    recycled security_id can't keep an old contract alive.
    const wl = await dbcon.query(
        DB,
        `UPDATE user_wishlist SET status = 'EXPIRED', status_changed_at = NOW()
         WHERE status = 'ACTIVE' AND instrument_type IN (${derivPh})
           AND expiry_date IS NOT NULL AND expiry_date < ?`,
        [...DERIVATIVE_INSTRUMENTS, cutoff]
    );
    result.watchlist = (wl && wl.affectedRows) || 0;

    // 3. Demo pending LIMIT orders on expired contracts: close them out so
    //    the fill engine can't execute them against a stale cached price.
    try {
        const po = await dbcon.query(
            DB,
            `UPDATE demo_orders o
             JOIN instruments i ON i.security_id = o.security_id AND i.exchange_segment = o.exchange_segment
             SET o.order_status = 'EXPIRED', o.updated_at = NOW()
             WHERE o.order_status = 'PENDING' AND i.instrument IN (${derivPh})
               AND i.sm_expiry_date IS NOT NULL AND i.sm_expiry_date > '1900-01-01' AND i.sm_expiry_date < ?`,
            [...DERIVATIVE_INSTRUMENTS, cutoff]
        );
        result.pendingOrders = (po && po.affectedRows) || 0;
    } catch (e) {
        // demo_orders is created lazily by DemoController — may not exist yet.
        if (!/doesn't exist/i.test(e.message)) throw e;
    }

    // 4. Shared live feed: stop streaming expired contracts.
    try {
        const feed = require('./dhanMarketFeed');
        const subscribed = feed.getSubscribed();
        const keep = await filterSubscribable(subscribed);
        const keepKeys = new Set(keep.map((i) => `${i.ExchangeSegment}|${String(i.SecurityId)}`));
        const drop = subscribed.filter((i) => !keepKeys.has(`${i.ExchangeSegment}|${String(i.SecurityId)}`));
        if (drop.length) feed.unsubscribe(drop);
        result.unsubscribed = drop.length;
    } catch (e) {
        console.log('[INSTRUMENT_EXPIRY] feed prune failed:', e.message);
    }

    if (result.instruments || result.watchlist || result.pendingOrders || result.unsubscribed) {
        console.log(`[INSTRUMENT_EXPIRY] cutoff=${cutoff} instruments→EXPIRED=${result.instruments} ` +
            `watchlist→EXPIRED=${result.watchlist} demoPending→EXPIRED=${result.pendingOrders} ` +
            `feedUnsubscribed=${result.unsubscribed}`);
    }
    return result;
}

module.exports = {
    STATUS,
    DERIVATIVE_INSTRUMENTS,
    MASTER_SEGMENTS,
    istDateKey,
    istMinutes,
    firstActiveExpiryDate,
    toDateKey,
    isDerivative,
    isExpiryPassed,
    getInstrumentStatus,
    toExchangeSegment,
    findInstrument,
    checkTradable,
    filterSubscribable,
    activeDerivativeFilter,
    sweepExpired,
};
