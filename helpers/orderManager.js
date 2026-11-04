const axios = require("axios");
const query = require("../helpers/query");
const constants = require("../vars/constants");

const CANCELLABLE = ["PENDING", "TRANSIT", "OPEN"];
const FINAL_STATUS_MAP = {
    TRADED:    "FILLED",
    CANCELLED: "CANCELLED",
    REJECTED:  "REJECTED",
    EXPIRED:   "EXPIRED",
};

exports.cancelPendingOrders = async (clientId, token) => {

    // Only cancel pending BUY orders — never cancel SELL orders.
    // User must always be able to close (sell) their existing open positions
    // even when blocked from placing new buy trades.
    const orders = await query.fetchRecords(
        constants.vals.defaultDB,
        "pending_orders",
        `WHERE dhan_client_id='${clientId}' AND status='PENDING' AND transaction_type='BUY'`
    );

    console.log(`Found ${orders.length} pending orders for client ${clientId}.`);

    if (!orders || orders.length === 0) return;

    for (const o of orders) {
        try {
            // Check current status from Dhan before attempting cancel
            const statusRes = await axios.get(
                `https://api.dhan.co/v2/orders/${o.order_id}`,
                { headers: { "access-token": token, "Accept": "application/json" } }
            );

            const order = Array.isArray(statusRes.data) ? statusRes.data[0] : statusRes.data;
            const dhanStatus = order?.orderStatus;

            // Already in a final state — just sync the DB, don't try to cancel
            if (FINAL_STATUS_MAP[dhanStatus]) {
                await query.updateRecord(
                    constants.vals.defaultDB,
                    "pending_orders",
                    `id='${o.id}'`,
                    `status='${FINAL_STATUS_MAP[dhanStatus]}'`
                );
                console.log(`↩️  Order ${o.order_id} already ${dhanStatus}, marked as ${FINAL_STATUS_MAP[dhanStatus]}`);
                continue;
            }

            // Still cancellable — proceed
            if (CANCELLABLE.includes(dhanStatus)) {
                await axios.delete(
                    `https://api.dhan.co/v2/orders/${o.order_id}`,
                    { headers: { "access-token": token } }
                );

                await query.updateRecord(
                    constants.vals.defaultDB,
                    "pending_orders",
                    `id='${o.id}'`,
                    `status='CANCELLED'`
                );

                console.log(`🛑 Cancelled order ${o.order_id} (was ${dhanStatus})`);
            } else {
                console.log(`⚠️  Order ${o.order_id} in unknown status: ${dhanStatus}, skipping`);
            }

        } catch (e) {
            console.log(`Cancel error for ${o.order_id}:`, e.response?.data || e.message);
        }
    }
};