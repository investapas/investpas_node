const constants = require("../vars/constants");
const dbcon = require("../config/mysqlClient");
const instrumentStatus = require("../helpers/instrumentStatus");

const DB = constants.vals.defaultDB;
const { STATUS } = instrumentStatus;

/*
  user_wishlist — see migrations/012_instrument_lifecycle.sql.
  Each row keeps a snapshot of the contract it was added for (segment,
  instrument type, expiry, strike, CE/PE), so an expired contract is
  detected even if the exchange later recycles its security_id.
  Expired rows are marked status='EXPIRED' — never deleted.
*/

function snapshotFromInstrument(inst) {
    return {
        exchange_segment: inst.exchange_segment,
        instrument_type: inst.instrument,
        trading_symbol: inst.symbol_name,
        display_name: inst.display_name,
        underlying_symbol: inst.underlying_symbol,
        expiry_date: instrumentStatus.toDateKey(inst.sm_expiry_date),
        strike_price: inst.strike_price,
        option_type: inst.option_type,
        lot_size: inst.lot_size,
    };
}

function formatItem(w, inst, st) {
    // Display the instrument row only if it still is the same contract.
    const src = inst || {};
    return {
        securityId: w.security_id,
        name: src.display_name || w.display_name,
        symbol: src.symbol_name || w.trading_symbol,
        exchangeSegment: w.exchange_segment || src.exchange_segment,
        exchange: src.exch_id || (w.exchange_segment || '').split('_')[0] || null,
        instrumentType: w.instrument_type || src.instrument || null,
        lotSize: src.lot_size ?? w.lot_size,
        strikePrice: src.strike_price ?? w.strike_price,
        optionType: src.option_type ?? w.option_type,
        expiry: instrumentStatus.toDateKey(w.expiry_date || src.sm_expiry_date),
        status: st.status,
        isTradable: st.isTradable,
        addedAt: w.created_at,
    };
}

// Status of one watchlist row. The row's own snapshot decides expiry; the
// current master row only counts if it still describes the same contract.
function evaluateRow(w, inst) {
    const sameContract = !!inst && (!w.expiry_date
        || instrumentStatus.toDateKey(inst.sm_expiry_date) === instrumentStatus.toDateKey(w.expiry_date));

    if (!w.instrument_type && !inst) {
        return { st: { status: STATUS.UNKNOWN, isTradable: false, reason: 'Instrument not found' }, inst: null };
    }

    const st = instrumentStatus.getInstrumentStatus({
        instrument: w.instrument_type || (inst && inst.instrument),
        expiry_date: w.expiry_date || (inst && inst.sm_expiry_date),
        // security_id now belongs to a different contract → ours is gone.
        lifecycle_status: inst ? (sameContract ? inst.lifecycle_status : STATUS.EXPIRED) : undefined,
    });
    return { st, inst: sameContract ? inst : null };
}

exports.addToWishlist = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const { securityId, exchangeSegment } = req.body;
        if (!securityId) {
            return res.json({ status: false, message: "securityId is required" });
        }

        const instrument = await instrumentStatus.findInstrument(securityId, exchangeSegment);
        if (!instrument) {
            return res.json({ status: false, message: "Invalid securityId — instrument not found" });
        }

        const st = instrumentStatus.getInstrumentStatus(instrument);
        if (!st.isTradable) {
            return res.json({
                status: false,
                message: `${instrument.display_name || securityId} has expired and can't be added to your watchlist.`,
            });
        }

        const snap = snapshotFromInstrument(instrument);

        // Existing row for this security — possibly an older contract that
        // reused this security_id, or a legacy row without a segment.
        const existingRows = await dbcon.query(
            DB,
            `SELECT id, status, expiry_date FROM user_wishlist
             WHERE dhan_client_id = ? AND security_id = ?
               AND (exchange_segment = ? OR exchange_segment IS NULL)
             ORDER BY id DESC`,
            [user.dhanClientId, String(securityId), snap.exchange_segment]
        );
        const existing = existingRows && existingRows[0];

        if (existing && existing.status === STATUS.ACTIVE
            && instrumentStatus.toDateKey(existing.expiry_date) === snap.expiry_date) {
            return res.json({ status: false, message: "Stock already in wishlist" });
        }

        if (existing) {
            // Re-point the row at the current contract and reactivate it.
            await dbcon.query(
                DB,
                `UPDATE user_wishlist SET ?, status = 'ACTIVE', status_changed_at = NOW(), created_at = NOW()
                 WHERE id = ?`,
                [snap, existing.id]
            );
        } else {
            // Unique (user, segment, security) makes a double tap harmless:
            // the losing insert hits the key and is reported as a duplicate.
            try {
                await dbcon.query(
                    DB,
                    `INSERT INTO user_wishlist SET ?`,
                    [{ dhan_client_id: user.dhanClientId, security_id: String(securityId), status: STATUS.ACTIVE, created_at: new Date(), ...snap }]
                );
            } catch (e) {
                if (e.code === 'ER_DUP_ENTRY') {
                    return res.json({ status: false, message: "Stock already in wishlist" });
                }
                throw e;
            }
        }

        return res.json({
            status: true,
            message: "Stock added to wishlist",
            data: {
                securityId: instrument.security_id,
                name: instrument.display_name,
                symbol: instrument.symbol_name,
                exchangeSegment: instrument.exchange_segment,
                exchange: instrument.exch_id,
                instrumentType: instrument.instrument,
                lotSize: instrument.lot_size,
                strikePrice: instrument.strike_price,
                optionType: instrument.option_type,
                expiry: snap.expiry_date,
                status: STATUS.ACTIVE,
                isTradable: true,
            }
        });
    } catch (error) {
        console.log("ADD WISHLIST ERROR:", error.message);
        return res.json({ status: false, message: error.message });
    }
};

exports.removeFromWishlist = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const { securityId, exchangeSegment } = req.body;
        if (!securityId) {
            return res.json({ status: false, message: "securityId is required" });
        }

        const params = [user.dhanClientId, String(securityId)];
        let segFilter = "";
        if (exchangeSegment) {
            segFilter = "AND (exchange_segment = ? OR exchange_segment IS NULL)";
            params.push(exchangeSegment);
        }

        // Explicit user removal deletes the watchlist row only; trades,
        // orders and P&L are separate tables and are untouched.
        const result = await dbcon.query(
            DB,
            `DELETE FROM user_wishlist WHERE dhan_client_id = ? AND security_id = ? ${segFilter}`,
            params
        );
        if (!result || !result.affectedRows) {
            return res.json({ status: false, message: "Stock not found in wishlist" });
        }

        return res.json({ status: true, message: "Stock removed from wishlist" });
    } catch (error) {
        console.log("REMOVE WISHLIST ERROR:", error.message);
        return res.json({ status: false, message: error.message });
    }
};

// GET /wishlist — the ACTIVE watchlist. Every request re-validates each item;
// anything that has expired since is marked EXPIRED and left out.
exports.getWishlist = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const rows = (await dbcon.query(
            DB,
            `SELECT w.id, w.security_id, w.exchange_segment, w.instrument_type, w.trading_symbol,
                    w.display_name, w.expiry_date, w.strike_price, w.option_type, w.lot_size,
                    w.created_at
             FROM user_wishlist w
             WHERE w.dhan_client_id = ? AND w.status = 'ACTIVE'
             ORDER BY w.created_at DESC`,
            [user.dhanClientId]
        )) || [];

        const active = [];
        const expiredIds = [];
        const inactiveIds = [];

        for (const w of rows) {
            let inst = await instrumentStatus.findInstrument(w.security_id, w.exchange_segment);

            // Legacy row (pre-migration, no snapshot): adopt the current
            // contract as its snapshot so it is tracked from now on.
            if (!w.instrument_type && inst) {
                Object.assign(w, snapshotFromInstrument(inst));
                await dbcon.query(DB, `UPDATE user_wishlist SET ? WHERE id = ?`, [snapshotFromInstrument(inst), w.id]);
            }

            const { st, inst: current } = evaluateRow(w, inst);
            if (st.status === STATUS.ACTIVE) {
                active.push(formatItem(w, current, st));
            } else if (st.status === STATUS.EXPIRED) {
                expiredIds.push(w.id);
                console.log(`[WATCHLIST] Removed expired instrument from active results — ${w.display_name || w.security_id} (expiry ${instrumentStatus.toDateKey(w.expiry_date)}) user=${user.dhanClientId}`);
            } else if (st.status === STATUS.INACTIVE) {
                inactiveIds.push(w.id);
            }
            // UNKNOWN (not in master, no snapshot): kept in the table, not shown —
            // same as the previous INNER JOIN behaviour.
        }

        if (expiredIds.length) {
            await dbcon.query(DB,
                `UPDATE user_wishlist SET status = 'EXPIRED', status_changed_at = NOW() WHERE id IN (?) AND status = 'ACTIVE'`,
                [expiredIds]);
        }
        if (inactiveIds.length) {
            await dbcon.query(DB,
                `UPDATE user_wishlist SET status = 'INACTIVE', status_changed_at = NOW() WHERE id IN (?) AND status = 'ACTIVE'`,
                [inactiveIds]);
        }

        return res.json({
            status: true,
            count: active.length,
            data: active
        });
    } catch (error) {
        console.log("GET WISHLIST ERROR:", error.message);
        return res.json({ status: false, message: error.message });
    }
};
