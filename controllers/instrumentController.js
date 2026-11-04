const axios = require("axios");
const csv = require("csv-parser");
const stream = require("stream");
const dbcon = require("../config/mysqlClient");
const constants = require("../vars/constants");
const utility = require("../helpers/utility");
const instrumentStatus = require("../helpers/instrumentStatus");

const BATCH_SIZE = 1000;
const SEGMENT_FILES = ["NSE_FNO", "BSE_FNO"];
// A real Dhan F&O file has tens of thousands of rows; anything far below this
// is a truncated/failed download and must not be used to deactivate contracts.
const MIN_ROWS_PER_FILE = 1000;

// 🔥 HELPER (clean values)
const clean = (val) => {
    if (!val || val === "NA") return null;
    return val;
};

const toFloat = (val) => {
    const num = parseFloat(val);
    return isNaN(num) ? 0 : num;
};

const toInt = (val) => {
    const num = parseInt(val);
    return isNaN(num) ? 0 : num;
};

const COLUMNS = [
    "exch_id", "segment", "security_id", "isin", "instrument",
    "underlying_security_id", "underlying_symbol", "symbol_name", "display_name",
    "instrument_type", "series", "lot_size", "sm_expiry_date", "strike_price",
    "option_type", "tick_size", "expiry_flag", "bracket_flag", "cover_flag",
    "asm_gsm_flag", "asm_gsm_category", "buy_sell_indicator", "buy_co_min_margin_per",
    "buy_co_sl_range_max_perc", "buy_co_sl_range_min_perc", "buy_bo_min_margin_per",
    "buy_bo_profit_range_max_perc", "buy_bo_profit_range_min_perc", "mtf_leverage",
    "sm_upper_limit", "sm_lower_limit", "exchange_segment",
];

// Every catalog field is refreshed from the latest file; a contract listed
// again is ACTIVE again (covers a security_id the exchange has recycled).
const UPSERT_SQL = `
    INSERT INTO instruments (${COLUMNS.join(", ")}, lifecycle_status, last_seen_at)
    VALUES ?
    ON DUPLICATE KEY UPDATE
        ${COLUMNS.filter((c) => c !== "exchange_segment" && c !== "security_id")
            .map((c) => `${c} = VALUES(${c})`).join(",\n        ")},
        lifecycle_status = 'ACTIVE',
        expired_at = NULL,
        last_seen_at = VALUES(last_seen_at),
        updated_at = NOW()`;

function toRow(row) {
    return [
        clean(row.EXCH_ID),
        clean(row.SEGMENT),
        clean(row.SECURITY_ID),
        clean(row.ISIN),
        clean(row.INSTRUMENT),
        clean(row.UNDERLYING_SECURITY_ID),
        clean(row.UNDERLYING_SYMBOL),
        clean(row.SYMBOL_NAME),
        clean(row.DISPLAY_NAME),
        clean(row.INSTRUMENT_TYPE),
        clean(row.SERIES),
        toInt(row.LOT_SIZE),
        clean(row.SM_EXPIRY_DATE),
        toFloat(row.STRIKE_PRICE),
        clean(row.OPTION_TYPE),
        toFloat(row.TICK_SIZE),
        clean(row.EXPIRY_FLAG),
        clean(row.BRACKET_FLAG),
        clean(row.COVER_FLAG),
        clean(row.ASM_GSM_FLAG),
        clean(row.ASM_GSM_CATEGORY),
        clean(row.BUY_SELL_INDICATOR),
        toFloat(row.BUY_CO_MIN_MARGIN_PER),
        toFloat(row.BUY_CO_SL_RANGE_MAX_PERC),
        toFloat(row.BUY_CO_SL_RANGE_MIN_PERC),
        toFloat(row.BUY_BO_MIN_MARGIN_PER),
        toFloat(row.BUY_BO_PROFIT_RANGE_MAX_PERC),
        toFloat(row.BUY_BO_PROFIT_RANGE_MIN_PERC),
        toFloat(row.MTF_LEVERAGE),
        toFloat(row.SM_UPPER_LIMIT),
        toFloat(row.SM_LOWER_LIMIT),
        instrumentStatus.toExchangeSegment(row.EXCH_ID, row.SEGMENT),
    ];
}

// Downloads and parses one Dhan instrument file. Nothing is written here,
// so a failed download can never leave the table half-empty.
async function downloadInstrumentFile(segment) {
    const url = `https://api.dhan.co/v2/instrument/${segment}`;
    console.log("[INSTRUMENT_SYNC] Fetching:", url);

    const response = await axios.get(url, { responseType: "arraybuffer", timeout: 180000 });
    const bufferStream = new stream.PassThrough();
    bufferStream.end(response.data);

    return new Promise((resolve, reject) => {
        const rows = [];
        bufferStream
            .pipe(csv())
            .on("data", (row) => {
                if (row.SECURITY_ID) rows.push(toRow(row));
            })
            .on("end", () => resolve(rows))
            .on("error", reject);
    });
}

let _syncRunning = false;

// Instrument master sync:
//   download all files → upsert (new contracts ACTIVE, recycled ids updated)
//   → contracts no longer listed become EXPIRED/INACTIVE (never deleted)
//   → lifecycle sweep (watchlist, pending demo orders, live feed).
async function syncInstrumentMaster() {
    if (_syncRunning) {
        console.log("[INSTRUMENT_SYNC] Already running — skipped");
        return { status: false, message: "Instrument sync already running" };
    }
    _syncRunning = true;

    try {
        if (utility.checkEmpty(constants.vals.dbconn)) {
            constants.vals.dbconn = await dbcon.connection();
        }

        const files = {};
        for (const seg of SEGMENT_FILES) {
            files[seg] = await downloadInstrumentFile(seg);
            console.log(`[INSTRUMENT_SYNC] ${seg}: ${files[seg].length} rows downloaded`);
            if (files[seg].length < MIN_ROWS_PER_FILE) {
                throw new Error(`${seg} file looks incomplete (${files[seg].length} rows) — master left unchanged`);
            }
        }

        // DB clock for "seen in this sync", so the comparison below never
        // mixes the Node and MySQL timezones.
        const nowRows = await dbcon.query(constants.vals.defaultDB, "SELECT NOW() AS t", []);
        const syncTime = nowRows[0].t;

        let upserted = 0;
        for (const seg of SEGMENT_FILES) {
            const rows = files[seg];
            for (let i = 0; i < rows.length; i += BATCH_SIZE) {
                const chunk = rows.slice(i, i + BATCH_SIZE).map((r) => [...r, "ACTIVE", syncTime]);
                await dbcon.query(constants.vals.defaultDB, UPSERT_SQL, [chunk]);
                upserted += chunk.length;
            }
        }

        // Contracts the broker no longer lists: past expiry → EXPIRED,
        // otherwise INACTIVE (delisted). Rows are kept for history.
        const derivPh = instrumentStatus.DERIVATIVE_INSTRUMENTS.map(() => "?").join(",");
        const cutoff = instrumentStatus.firstActiveExpiryDate();
        const gone = await dbcon.query(
            constants.vals.defaultDB,
            `UPDATE instruments
             SET lifecycle_status = IF(instrument IN (${derivPh}) AND sm_expiry_date > '1900-01-01' AND sm_expiry_date < ?, 'EXPIRED', 'INACTIVE'),
                 expired_at = IF(instrument IN (${derivPh}) AND sm_expiry_date > '1900-01-01' AND sm_expiry_date < ?, NOW(), expired_at)
             WHERE lifecycle_status = 'ACTIVE'
               AND exchange_segment IN ('NSE_FNO', 'BSE_FNO', 'IDX_I')
               AND (last_seen_at IS NULL OR last_seen_at < ?)`,
            [...instrumentStatus.DERIVATIVE_INSTRUMENTS, cutoff, ...instrumentStatus.DERIVATIVE_INSTRUMENTS, cutoff, syncTime]
        );

        console.log(`[INSTRUMENT_SYNC] Updated instrument master — upserted=${upserted} ` +
            `noLongerListed=${(gone && gone.affectedRows) || 0}`);

        const sweep = await instrumentStatus.sweepExpired();
        return { status: true, message: "Instrument master updated", upserted, noLongerListed: (gone && gone.affectedRows) || 0, sweep };
    } catch (error) {
        console.log("[INSTRUMENT_SYNC] Failed:", error.message);
        return { status: false, message: error.message };
    } finally {
        _syncRunning = false;
    }
}

exports.syncInstrumentMaster = syncInstrumentMaster;

exports.updateInstruments = async (req, res) => {
    const result = await syncInstrumentMaster();
    return res.json(result);
};

exports.runInstrumentCron = async () => {
    console.log("Instrument Cron Started");
    // A failed sync leaves the existing master untouched; the rest of the
    // daily cron (expiry dates, candles) still runs.
    const result = await syncInstrumentMaster();
    console.log(result.status ? "Instrument Cron Completed" : `Instrument Cron Failed: ${result.message}`);
};

// GET /dhan/index-lot-sizes — real current lot size per major index's
// derivatives, read from this same instrument master (not Dhan's live
// API, no per-request cost). An index itself has no lot size (it isn't a
// tradeable contract) — several Flutter screens were hardcoding "1" for
// the index's own MarketItem as a placeholder, which rendered as a wrong,
// confusing "1 qty/lot = 1" next to the index name. This looks up the
// nearest active future for each index and returns its real lot size;
// a symbol with no match is simply left out of the response rather than
// guessed, so the app can fall back to showing nothing instead of a wrong
// number.
const INDEX_LOT_SIZE_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCAPNIFTY', 'SENSEX'];

exports.getIndexLotSizes = async (req, res) => {
    try {
        const data = {};
        for (const symbol of INDEX_LOT_SIZE_SYMBOLS) {
            const rows = await dbcon.query(
                constants.vals.defaultDB,
                `SELECT lot_size FROM instruments
                 WHERE underlying_symbol = ?
                   AND instrument = 'FUTIDX'
                   AND lifecycle_status = 'ACTIVE'
                 ORDER BY sm_expiry_date ASC
                 LIMIT 1`,
                [symbol]
            );
            const lotSize = rows && rows[0] ? Number(rows[0].lot_size) : 0;
            if (lotSize > 0) data[symbol] = lotSize;
        }
        return res.json({ status: true, data });
    } catch (error) {
        return res.json({ status: false, message: error.message });
    }
};
