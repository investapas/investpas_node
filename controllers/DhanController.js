const axios = require('axios');
const jwt = require('jsonwebtoken');
const query = require("../helpers/query");
const dbcon = require('../config/mysqlClient');
const constants = require("../vars/constants");
const { v4: uuidv4 } = require("uuid");
const { checkUserRules, checkCapitalBeforeTrade, onTradeExit, checkHeroTrade } = require("../helpers/challengeEngine");
const utility = require("../helpers/utility");
const instrumentStatus = require("../helpers/instrumentStatus");
const { backfillTradeHistory } = require("../helpers/dhanTradeHistorySync");
const { buildTradeHistory } = require("../helpers/dhanTradeMatching");

// ── Push notification helper ──────────────────────────────────────────────────
// Fire-and-forget: never awaited so it never delays the API response.
function _notifyUser(dhanClientId, title, body, orderId) {
    (async () => {
        try {
            const row = await query.fetchSingleRecord(
                constants.vals.defaultDB,
                'users',
                `WHERE dhan_client_id='${dhanClientId}'`,
                'firebase_token'
            );
            const token = row?.firebase_token;
            if (!token) return;
            await utility.sendNotification(
                [token],
                'orderPage',
                String(orderId || ''),
                { title, body }
            );
            console.log(`[NOTIF] Sent "${title}" to ${dhanClientId}`);
        } catch (e) {
            console.log('[NOTIF] Failed:', e.message);
        }
    })();
}

// Fetch the user's Dhan access token from DB — used by all GET endpoints
// so Flutter doesn't need to send it in the body.
async function _getDhanToken(dhanClientId) {
    const row = await query.fetchSingleRecord(
        constants.vals.defaultDB,
        'users',
        `WHERE dhan_client_id='${dhanClientId}'`,
        'dhan_access_token'
    );
    return row?.dhan_access_token || null;
}

exports.generateConsent = async (req, res) => {

    try {
        const partnerId = process.env.DHAN_PARTNER_ID;
        const partnerSecret = process.env.DHAN_PARTNER_SECRET;
        
        console.log("=== DHAN GENERATE CONSENT DEBUG ===");
        console.log("Partner ID:", `"${partnerId}"` , `(Length: ${partnerId?.length})`);
        console.log("Partner Secret:", `"${partnerSecret}"`, `(Length: ${partnerSecret?.length})`);
        
        // Set response headers to prevent hanging  
        res.set({
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        // Create axios instance with timeout
        const axiosInstance = axios.create({
            timeout: 10000 // 10 second timeout
        });

        const response = await axiosInstance.get(
            "https://auth.dhan.co/partner/generate-consent",
            {
                headers: {
                    "partner_id": partnerId,
                    "partner_secret": partnerSecret
                }
            }
        );

        console.log("✅ SUCCESS - Response from Dhan:", response.data);
        
        return res.status(200).json({
            status: true,
            message: "Consent generated successfully",
            data: response.data
        });

    } catch (error) {
        console.log("=== DHAN ERROR RESPONSE ===");
        console.log("Status Code:", error.response?.status);
        console.log("Error Data:", error.response?.data);
        console.log("Error Message:", error.message);
        
        return res.status(error.response?.status || 500).json({
            status: false,
            message: error.response?.data?.error || error.message,
            details: error.response?.status
        });
    }
};


exports.consumeConsent = async (req, res) => {
  try {

    const tokenId  = req.body.tokenId;
    const fcmToken = req.body.fcmToken || '';

    const response = await axios.get(
      `https://auth.dhan.co/partner/consume-consent?tokenId=${tokenId}`,
      {
        headers: {
          "partner_id": process.env.DHAN_PARTNER_ID,
          "partner_secret": process.env.DHAN_PARTNER_SECRET
        }
      }
    );

    const dhanData = response.data;

    const dhanClientId = dhanData.dhanClientId;
    const dhanClientName = dhanData.dhanClientName;
    const dhanClientUcc = dhanData.dhanClientUcc;
    const dhanAccessToken = dhanData.accessToken;

    const appToken = jwt.sign(
      { dhanClientId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    console.log("✅ Consent consumed successfully");
    console.log("Dhan Client ID:", dhanClientId);
    console.log("Dhan Client Name:", dhanClientName);
    console.log("Dhan Client UCC:", appToken);
    // ================= DB SAVE =================

    // check user exist
    const existingUser = await query.fetchSingleRecord(
      constants.vals.defaultDB,
      "users",
      `WHERE dhan_client_id='${dhanClientId}'`
    );

    console.log("Dhan Client UCC:", existingUser);

    if (existingUser && existingUser.id) {
      // 🔄 UPDATE
      const updateFields = `
        dhan_client_name='${dhanClientName}',
        dhan_client_ucc='${dhanClientUcc}',
        dhan_access_token='${dhanAccessToken}',
        app_token='${appToken}',
        is_active=1
        ${fcmToken ? `, firebase_token='${fcmToken}'` : ''}
      `;
      await query.updateRecord(
        constants.vals.defaultDB,
        "users",
        `dhan_client_id='${dhanClientId}'`,
        updateFields
      );
    } else {
      // ➕ INSERT

      console.log("Inserting new user into DB with dhanClientId:", dhanClientId);
      const insertData = {
        dhan_client_id:     dhanClientId,
        dhan_client_name:   dhanClientName,
        dhan_client_ucc:    dhanClientUcc,
        dhan_access_token:  dhanAccessToken,
        app_token:          appToken,
        is_active:          1,
      };
      if (fcmToken) insertData.firebase_token = fcmToken;
      await query.insertSingle(constants.vals.defaultDB, "users", insertData);
    }


    console.log("✅ User authenticated and data saved/updated successfully");
    console.log("Dhan Client ID:", dhanClientId);
    console.log("Dhan Client Name:", dhanClientName);
    console.log("Dhan Client UCC:", dhanClientUcc);

    // Fire-and-forget — populates the Journal's trade-history cache for
    // the last 12 months so it isn't empty the first time this user opens
    // it. Never awaited: must not delay login.
    backfillTradeHistory(dhanClientId, dhanAccessToken).catch(e =>
      console.log("[TradeHistorySync] connect-time backfill error:", e.message)
    );

    // ================= RESPONSE =================

    res.json({
      status: true,
      message: "Login successful",
      user: {
        dhanClientId,
        dhanClientName,
        dhanClientUcc
      },
      dhanAccessToken,
      token: appToken
    });

  } catch (error) {
    console.log("DHAN ERROR:", error.response?.data || error.message);

    res.json({
      status: false,
      message: error.response?.data || error.message
    });
  }
};

// exports.getPortfolio = async (req, res) => {
//     try {
//         const user = req.user;
//         const { dhanAccessToken } = req.body;

//         if (!user || !user.dhanClientId) {
//             return res.json({
//                 status: false,
//                 message: "User authentication required"
//             });
//         }

//         if (!dhanAccessToken) {
//             return res.json({
//                 status: false,
//                 message: "Dhan access token required"
//             });
//         }

//         const response = await axios.get(
//             "https://api.dhan.co/v2/positions",
//             {
//                 headers: {
//                     "access-token": dhanAccessToken
//                 }
//             }
//         );

//         res.json({
//             status: true,
//             data: response.data
//         });
//     } catch (error) {
//         console.log("DHAN PORTFOLIO ERROR:", error.response?.data || error.message);
//         res.json({
//             status: false,
//             message: error.response?.data || error.message
//         });
//     }
// };


exports.getPortfolio = async (req, res) => {
    try {
        const user = req.user;

        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const dhanAccessToken = await _getDhanToken(user.dhanClientId);
        if (!dhanAccessToken) {
            return res.json({ status: false, message: "Dhan access token not found. Please re-login." });
        }

        const response = await axios.get(
            "https://api.dhan.co/v2/positions",
            {
                headers: {
                    "access-token": dhanAccessToken,
                    "Accept": "application/json"
                }
            }
        );

        const raw = Array.isArray(response.data) ? response.data : [];

        // Map Dhan field names to what Flutter Position.fromJson expects
        const transformed = raw.map(pos => {
            const netQty = pos.netQty || 0;
            const buyAvg = pos.buyAvg || 0;
            const unrealized = pos.unrealizedProfit || 0;
            const realized = pos.realizedProfit || 0;
            const totalPnl = unrealized + realized;
            // Estimate LTP: buyAvg + unrealized/qty (only for long positions)
            const currentPrice = netQty > 0
                ? buyAvg + (unrealized / netQty)
                : (netQty < 0 ? (pos.sellAvg || 0) - (unrealized / Math.abs(netQty)) : buyAvg);
            const pnlPct = buyAvg > 0 && netQty !== 0
                ? (totalPnl / (buyAvg * Math.abs(netQty))) * 100
                : 0;

            return {
                // Dhan original fields (for PortfolioPosition.fromJson)
                ...pos,
                // Flutter Position.fromJson field aliases
                symbol: pos.tradingSymbol,
                quantity: netQty,
                averagePrice: buyAvg,
                currentPrice: parseFloat(currentPrice.toFixed(2)),
                pnl: parseFloat(totalPnl.toFixed(2)),
                pnlPercentage: parseFloat(pnlPct.toFixed(2)),
            };
        });

        return res.json({
            status: true,
            count: transformed.length,
            data: transformed
        });

    } catch (error) {
        console.log("DHAN PORTFOLIO ERROR:", error.response?.data || error.message);

        return res.json({
            status: false,
            message: error.response?.data?.errorMessage || error.message
        });
    }
};

// exports.searchStocks = async (req, res) => {
//     try {
//         const { search } = req.query;
//         if (!search) {
//             return res.json({
//                 status: true,
//                 data: []
//             });
//         }
//         const data = await query.fetchRecords(
//             constants.vals.defaultDB,
//             "dhan_scrip_master",
//             `
//             WHERE DISPLAY_NAME LIKE '%${search}%'
//             OR SYMBOL_NAME LIKE '%${search}%'
//             LIMIT 20
//             `
//         );

//         const formatted = data.map(item => ({
//             securityId: item.SECURITY_ID,
//             name: item.DISPLAY_NAME,
//             symbol: item.SYMBOL_NAME,
//             exchangeSegment: item.SEGMENT,
//             exchange: item.EXCH_ID,
//             lotSize: item.LOT_SIZE
//         }));

//         res.json({
//             status: true,
//             data: formatted
//         });
//     } catch (error) {
//         res.json({
//             status: false,
//             message: error.message
//         });
//     }
// };


// Map DB exch_id + segment → correct Dhan ExchangeSegment for market feed
const getExchangeSegment = (exchId, segment) => {
    const exch = (exchId || '').toUpperCase();
    const seg  = (segment || '').toUpperCase();
    if (exch === 'BSE' && seg === 'D') return 'BSE_FNO';
    if (exch === 'NSE' && seg === 'D') return 'NSE_FNO';
    if (exch === 'BSE' && seg === 'E') return 'BSE_EQ';
    if (exch === 'NSE' && seg === 'E') return 'NSE_EQ';
    if (seg === 'NSE_FNO') return 'NSE_FNO';
    if (seg === 'BSE_FNO') return 'BSE_FNO';
    if (seg === 'NSE_EQ')  return 'NSE_EQ';
    if (seg === 'BSE_EQ')  return 'BSE_EQ';
    return segment;
};

exports.searchStocks = async (req, res) => {
    try {
        const { search } = req.query;

        if (!search) {
            return res.json({
                status: true,
                data: []
            });
        }

        // Active, tradable contracts only (expiry-day contracts stay listed
        // until market close).
        const active = instrumentStatus.activeDerivativeFilter("instruments");
        const like = `%${search}%`;
        const data = (await dbcon.query(
            constants.vals.defaultDB,
            `SELECT * FROM instruments
             WHERE ${active.sql}
               AND (
                    display_name LIKE ?
                    OR symbol_name LIKE ?
                    OR security_id LIKE ?
                    OR option_type LIKE ?
                    OR strike_price LIKE ?
                    OR DATE(sm_expiry_date) LIKE ?
               )
             ORDER BY sm_expiry_date ASC
             LIMIT 20`,
            [...active.params, like, like, like, like, like, like]
        )) || [];

        const formatted = data.map(item => ({
            securityId: item.security_id,
            name: item.display_name,
            symbol: item.symbol_name,
            exchangeSegment: getExchangeSegment(item.exch_id, item.segment),
            exchange: item.exch_id,
            lotSize: item.lot_size,
            strikePrice: item.strike_price,
            optionType: item.option_type,
            expiry: item.sm_expiry_date
        }));

        return res.json({
            status: true,
            count: formatted.length,
            data: formatted
        });

    } catch (error) {
        return res.json({
            status: false,
            message: error.message
        });
    }
};

exports.getStockList = async (req, res) => {
    try {
        const pageParam = parseInt(req.query.page, 10);
        const page = !isNaN(pageParam) && pageParam > 0 ? pageParam : 1;
        const limit = 10;
        const offset = (page - 1) * limit;

        const active = instrumentStatus.activeDerivativeFilter("instruments");
        const instruments = (await dbcon.query(
            constants.vals.defaultDB,
            `SELECT * FROM instruments WHERE ${active.sql}
             ORDER BY sm_expiry_date ASC, strike_price DESC LIMIT ${limit} OFFSET ${offset}`,
            active.params
        )) || [];

        const totalRows = await dbcon.query(
            constants.vals.defaultDB,
            `SELECT COUNT(*) AS total FROM instruments WHERE ${active.sql}`,
            active.params
        );

        const total = Number(totalRows?.[0]?.total || 0);
        const totalPages = Math.ceil(total / limit);

        const formatted = instruments.map(item => ({
            securityId: item.security_id,
            name: item.display_name,
            symbol: item.symbol_name,
            exchangeSegment: getExchangeSegment(item.exch_id, item.segment),
            exchange: item.exch_id,
            lotSize: item.lot_size,
            strikePrice: item.strike_price,
            optionType: item.option_type,
            expiry: item.sm_expiry_date
        }));

        return res.json({
            status: true,
            page,
            perPage: limit,
            total,
            totalPages,
            count: formatted.length,
            data: formatted
        });

    } catch (error) {
        console.log("INSTRUMENT LIST ERROR:", error.response?.data || error.message);
        return res.json({
            status: false,
            message: error.message
        });
    }
};


exports.getOrderById = async (req, res) => {
    try {
        const user = req.user;
        const { orderId } = req.params;

        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        if (!orderId) {
            return res.json({ status: false, message: "Order ID is required" });
        }

        const dhanAccessToken = await _getDhanToken(user.dhanClientId);
        if (!dhanAccessToken) {
            return res.json({ status: false, message: "Dhan access token not found. Please re-login." });
        }

        // ================= DHAN API =================

        const response = await axios.get(
            `https://api.dhan.co/v2/orders/${orderId}`,
            {
                headers: {
                    "access-token": dhanAccessToken,
                    "Accept": "application/json"
                }
            }
        );

        return res.json({
            status: true,
            message: "Order details fetched successfully",
            data: response.data // 🔥 FULL RAW DATA
        });

    } catch (error) {
        console.log("GET ORDER ERROR:", error.response?.data || error.message);

        return res.json({
            status: false,
            message: error.response?.data?.errorMessage || error.message
        });
    }
};


exports.getOrderList = async (req, res) => {
    try {
        const user = req.user;

        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const dhanAccessToken = await _getDhanToken(user.dhanClientId);
        if (!dhanAccessToken) {
            return res.json({ status: false, message: "Dhan access token not found. Please re-login." });
        }

        // ================= DHAN API =================

        const response = await axios.get(
            "https://api.dhan.co/v2/orders",
            {
                headers: {
                    "access-token": dhanAccessToken,
                    "Accept": "application/json"
                }
            }
        );

        const raw = Array.isArray(response.data) ? response.data : [];

        // Normalize field names so Flutter Order.fromJson works
        const OPEN_STATUSES   = ['TRANSIT', 'PENDING', 'PARTIALLY_FILLED', 'OPEN'];
        const CLOSED_STATUSES = ['TRADED', 'EXECUTED', 'CANCELLED', 'REJECTED'];

        const normalized = raw.map(o => ({
            ...o,
            status: o.orderStatus || o.status || 'PENDING',
            createdAt: o.createTime || o.createdAt || null,
        }));

        // Filter by tab if requested (status=OPEN or status=EXECUTED)
        const filterMode = (req.query.status || '').toUpperCase();
        let filtered = normalized;
        if (filterMode === 'OPEN') {
            filtered = normalized.filter(o => OPEN_STATUSES.includes((o.orderStatus || '').toUpperCase()));
        } else if (filterMode === 'EXECUTED') {
            filtered = normalized.filter(o => CLOSED_STATUSES.includes((o.orderStatus || '').toUpperCase()));
        }

        return res.json({
            status: true,
            count: filtered.length,
            data: filtered
        });

    } catch (error) {
        console.log("GET ORDER LIST ERROR:", error.response?.data || error.message);

        return res.json({
            status: false,
            message: error.response?.data?.errorMessage || error.message
        });
    }
};


exports.getTradeList = async (req, res) => {
    try {
        const user = req.user;
        const { dhanAccessToken } = req.body;

        // ================= VALIDATION =================

        if (!user || !user.dhanClientId) {
            return res.json({
                status: false,
                message: "User authentication required"
            });
        }

        if (!dhanAccessToken) {
            return res.json({
                status: false,
                message: "Dhan access token required"
            });
        }

        // ================= DHAN API =================

        const response = await axios.get(
            "https://api.dhan.co/v2/trades",
            {
                headers: {
                    "access-token": dhanAccessToken,
                    "Accept": "application/json"
                }
            }
        );

        return res.json({
            status: true,
            count: response.data?.length || 0,
            data: response.data // 🔥 full order list
        });

    } catch (error) {
        console.log("GET TRADE LIST ERROR:", error.response?.data || error.message);

        return res.json({
            status: false,
            message: error.response?.data?.errorMessage || error.message
        });
    }
};

// exports.buyOrder = async (req, res) => {
//     try {

//         const user = req.user;
//         if (!user || !user.dhanClientId) {
//             return res.json({
//                 status: false,
//                 message: "User authentication required"
//             });
//         }

//         const dhanClientId = user.dhanClientId;
//         const {
//             dhanAccessToken,
//             securityId,
//             exchangeSegment,
//             quantity,
//             price,
//             orderType,
//             index 
//         } = req.body;

//         const challenge = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "user_challenges",
//             `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
//         );

//         if (!challenge || !challenge.id) {
//             return res.json({
//                 status: false,
//                 message: "No active challenge found"
//             });
//         }

//         const pnlData = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "challenge_trade_logs",
//             `WHERE dhan_client_id='${dhanClientId}' AND trade_date=CURDATE()`,
//             "SUM(pnl) as total"
//         );

//         const todayPnL = pnlData?.total || 0;
//         if (todayPnL <= -challenge.max_loss) {
//             return res.json({
//                 status: false,
//                 rule: "DAILY_LOSS_LIMIT",
//                 message: "Daily loss limit reached"
//             });
//         }

//         if (todayPnL >= challenge.max_profit) {
//             return res.json({
//                 status: false,
//                 rule: "DAILY_PROFIT_TARGET",
//                 message: "Daily profit target achieved"
//             });
//         }

//         const tradeCount = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "challenge_trade_logs",
//             `WHERE dhan_client_id='${dhanClientId}' AND trade_date=CURDATE()`,
//             "COUNT(*) as total"
//         );

//         if ((tradeCount?.total || 0) >= challenge.max_trades_per_day) {
//             return res.json({
//                 status: false,
//                 rule: "MAX_TRADES_LIMIT",
//                 message: "Maximum trades per day reached"
//             });
//         }

//         let allowedQty = 0;

//         if (index === "NIFTY") allowedQty = challenge.nifty_lots;
//         if (index === "BANKNIFTY") allowedQty = challenge.banknifty_lots;
//         if (index === "FINNIFTY") allowedQty = challenge.finnifty_lots;
//         if (index === "MIDCAPNIFTY") allowedQty = challenge.midcapnifty_lots;
//         if (index === "SENSEX") allowedQty = challenge.sensex_lots;

//         if (quantity > allowedQty) {
//             return res.json({
//                 status: false,
//                 rule: "QUANTITY_RULE",
//                 message: `Allowed ${allowedQty}, tried ${quantity}`
//             });
//         }

//         const orderPayload = {
//             dhanClientId: user.dhanClientId,
//             correlationId: Date.now().toString(),
//             transactionType: "BUY",
//             exchangeSegment: exchangeSegment,
//             productType: "INTRADAY",
//             orderType: orderType || "MARKET",
//             validity: "DAY",
//             securityId: securityId,
//             quantity: quantity.toString(),
//         };

//         if (orderType === "LIMIT") {
//             orderPayload.price = price;
//         }

//         const response = await axios.post(
//             "https://sandbox.dhan.co/v2/orders",
//             orderPayload,
//             {
//                 headers: {
//                     "access-token": dhanAccessToken,
//                     "Content-Type": "application/json"
//                 }
//             }
//         );

//         res.json({
//             status: true,
//             message: "Order placed successfully",
//             data: response.data
//         });

//     } catch (error) {
//         console.log("BUY ORDER ERROR:", error.response?.data || error.message);
//         res.json({
//             status: false,
//             message: error.response?.data || error.message
//         });
//     }
// };




// exports.buyOrder = async (req, res) => {
//     try {
//         const user = req.user;

//         if (!user || !user.dhanClientId) {
//             return res.json({
//                 status: false,
//                 message: "User authentication required"
//             });
//         }

//         const dhanClientId = user.dhanClientId;
//         const {
//             dhanAccessToken,
//             transactionType = "BUY",
//             productType = "INTRADAY",
//             securityId,
//             exchangeSegment,
//             quantity,
//             price = 0,
//             triggerPrice = 0,
//             orderType = "MARKET",
//             validity = "DAY",
//             index
//         } = req.body;

//         console.log(req.body);

//         // ================= BASIC VALIDATION =================

//         if (!securityId || !quantity || !exchangeSegment) {
//             return res.json({
//                 status: false,
//                 message: "Missing required fields"
//             });
//         }

//         // ================= INSTRUMENT VALIDATION =================

//         const instrument = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "instruments",
//             `WHERE security_id='${securityId}'`
//         );

//         if (!instrument) {
//             return res.json({
//                 status: false,
//                 message: "Invalid securityId"
//             });
//         }

//         const lotSize = Number(instrument.lot_size || 1);

//         if (quantity % lotSize !== 0) {
//             return res.json({
//                 status: false,
//                 message: `Quantity must be multiple of ${lotSize}`
//             });
//         }

//         // ================= ORDER TYPE VALIDATION =================

//         if (orderType === "LIMIT" && !price) {
//             return res.json({
//                 status: false,
//                 message: "Price required for LIMIT order"
//             });
//         }

//         if (orderType === "STOP_LOSS" && !triggerPrice) {
//             return res.json({
//                 status: false,
//                 message: "Trigger price required for STOP_LOSS"
//             });
//         }

//         // ================= CHALLENGE VALIDATION =================

//         const challenge = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "user_challenges",
//             `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
//         );

//         if (!challenge || !challenge.id) {
//             return res.json({
//                 status: false,
//                 message: "No active challenge found"
//             });
//         }

//         const pnlData = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "challenge_trade_logs",
//             `WHERE dhan_client_id='${dhanClientId}' AND trade_date=CURDATE()`,
//             "SUM(pnl) as total"
//         );

//         const todayPnL = Number(pnlData?.total || 0);

//         if (todayPnL <= -challenge.max_loss) {
//             return res.json({
//                 status: false,
//                 rule: "DAILY_LOSS_LIMIT",
//                 message: "Daily loss limit reached"
//             });
//         }

//         if (todayPnL >= challenge.max_profit) {
//             return res.json({
//                 status: false,
//                 rule: "DAILY_PROFIT_TARGET",
//                 message: "Daily profit target achieved"
//             });
//         }

//         const tradeCount = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "challenge_trade_logs",
//             `WHERE dhan_client_id='${dhanClientId}' AND trade_date=CURDATE()`,
//             "COUNT(*) as total"
//         );

//         if ((Number(tradeCount?.total) || 0) >= challenge.max_trades_per_day) {
//             return res.json({
//                 status: false,
//                 rule: "MAX_TRADES_LIMIT",
//                 message: "Maximum trades per day reached"
//             });
//         }

//         if (index) {
//             let allowedQty = 0;
//             if (index === "NIFTY") allowedQty = challenge.nifty_lots;
//             else if (index === "BANKNIFTY") allowedQty = challenge.banknifty_lots;
//             else if (index === "FINNIFTY") allowedQty = challenge.finnifty_lots;
//             else if (index === "MIDCAPNIFTY") allowedQty = challenge.midcapnifty_lots;
//             else if (index === "SENSEX") allowedQty = challenge.sensex_lots;

//             if (quantity > allowedQty) {
//                 return res.json({
//                     status: false,
//                     rule: "QUANTITY_RULE",
//                     message: `Allowed ${allowedQty}, tried ${quantity}`
//                 });
//             }
//         }

//         // ================= DHAN PAYLOAD =================

//         const orderPayload = {
//             dhanClientId,
//             correlationId: Date.now().toString(),
//             transactionType,
//             exchangeSegment,
//             productType,
//             orderType,
//             validity,
//             securityId,
//             quantity: Number(quantity),
//             disclosedQuantity: 0,
//             price: orderType === "LIMIT" || orderType === "STOP_LOSS" ? Number(price) : 0,
//             triggerPrice: orderType === "STOP_LOSS" ? Number(triggerPrice) : 0,
//             afterMarketOrder: false
//         };

//         console.log("Order Payload:", orderPayload);

//         const response = await axios.post(
//             "https://api.dhan.co/v2/orders",
//             orderPayload,
//             {
//                 headers: {
//                     "access-token": dhanAccessToken,
//                     "Content-Type": "application/json"
//                 }
//             }
//         );

//         console.log("ORDER RESPONSE:", response.data);

//         // ================= STORE TRADE LOG =================

//         // await query.insertSingle(constants.vals.defaultDB, "challenge_trade_logs", {
//         //     dhan_client_id: dhanClientId,
//         //     challenge_id: challenge.id,
//         //     // security_id: securityId,
//         //     // exchange_segment: exchangeSegment,
//         //     // quantity: Number(quantity),
//         //     // price: Number(price),
//         //     trade_type: orderType,
//         //     // transaction_type: transactionType,
//         //     // product_type: productType,
//         //     index_name: index || null,
//         //     quantity: Number(quantity),
//         //     // order_id: response.data?.orderId || response.data?.data?.orderId || null,
//         //     pnl: 0,
//         //     trade_date: new Date().toISOString().slice(0, 10),
//         // });

//         return res.json({
//             status: true,
//             message: "Order placed successfully",
//             data: response.data
//         });

//     } catch (error) {
//         console.log("ORDER ERROR:", error.response?.data || error.message);

//         return res.json({
//             status: false,
//             message: error.response?.data || error.message
//         });
//     }
// };


// exports.buyOrder = async (req, res) => {
//     try {
//         const user = req.user;

//         if (!user || !user.dhan_client_id) {
//             return res.json({ status: false, message: "Auth required" });
//         }

//         const {
//             dhanAccessToken,
//             securityId,
//             exchangeSegment,
//             quantity,
//             price = 0,
//             orderType = "MARKET"
//         } = req.body;

//         if (!securityId || !quantity || !exchangeSegment) {
//             return res.json({ status: false, message: "Missing fields" });
//         }

//         const payload = {
//             dhanClientId: user.dhan_client_id,
//             correlationId: uuidv4(),
//             transactionType: "BUY",
//             exchangeSegment,
//             productType: "INTRADAY",
//             orderType,
//             validity: "DAY",
//             securityId,
//             quantity: Number(quantity),
//             disclosedQuantity: 0,
//             price: orderType === "LIMIT" ? Number(price) : 0,
//             triggerPrice: 0,
//             afterMarketOrder: false
//         };

//         const response = await axios.post(
//             "https://api.dhan.co/v2/orders",
//             payload,
//             {
//                 headers: {
//                     "access-token": dhanAccessToken
//                 }
//             }
//         );

//         return res.json({
//             status: true,
//             message: "Order placed",
//             data: response.data
//         });

//     } catch (err) {
//         return res.json({
//             status: false,
//             message: err.response?.data || err.message
//         });
//     }
// };




// working but sell not wokig proper


exports.buyOrder = async (req, res) => {
    try {
        const user = req.user;

        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "Auth required" });
        }

        const {
            dhanAccessToken,
            securityId,
            tradingSymbol = '',
            exchangeSegment,
            quantity,
            price = 0,
            orderType = "MARKET",
            transactionType, // 👈 from frontend
            validity = "DAY"
        } = req.body;

        // ================= VALIDATION =================
        if (!transactionType || !["BUY", "SELL"].includes(transactionType)) {
            return res.json({ status: false, message: "Invalid transaction type" });
        }

        if (!["DAY", "IOC"].includes(validity)) {
            return res.json({ status: false, message: "Invalid validity" });
        }

        if (!dhanAccessToken) {
            return res.json({ status: false, message: "Access token required" });
        }

        if (!securityId || !quantity || !exchangeSegment) {
            return res.json({ status: false, message: "Missing fields" });
        }

        const qty = Number(quantity);
        const prc = Number(price);

        if (isNaN(qty) || qty <= 0) {
            return res.json({ status: false, message: "Invalid quantity" });
        }

        if (orderType === "LIMIT" && (isNaN(prc) || prc <= 0)) {
            return res.json({ status: false, message: "Invalid price" });
        }

        // ================= INSTRUMENT LIFECYCLE =================
        // Backend is authoritative: an expired contract never reaches Dhan,
        // whatever a stale client still shows.
        const tradable = await instrumentStatus.checkTradable({ securityId, exchangeSegment });
        if (!tradable.ok) {
            return res.json({ status: false, message: tradable.message });
        }

        // ================= RULE CHECK =================
        // SELL orders are always allowed — user must be able to close
        // existing positions even when challenge limit is reached.
        // checkUserRules() is still called for SELL so the "Trading Paused"
        // reminder notification fires if the user is currently blocked.
        const rule = await checkUserRules(user.dhanClientId, transactionType);
        if (rule.blocked && transactionType === "BUY") {
            return res.json({
                status: false,
                message: `Blocked: ${rule.reason}`
            });
        }

        // ================= CAPITAL CHECK (ONLY BUY) =================
        if (transactionType === "BUY") {
            const capCheck = await checkCapitalBeforeTrade(
                user.dhanClientId,
                prc,
                qty,
                securityId,
                tradingSymbol
            );

            if (!capCheck.allowed) {
                return res.json({
                    status: false,
                    message: capCheck.message || capCheck.reason
                });
            }

            // ── Hero-to-Zero check (expiry day low premium options) ──
            const heroCheck = await checkHeroTrade(user.dhanClientId, tradingSymbol || '', prc, qty);
            if (heroCheck.blocked) {
                return res.json({ status: false, message: heroCheck.message });
            }
        }

        // ================= PAYLOAD =================
        // For MARKET orders Dhan accepts price > 0 as "market-with-protection"
        // (slippage guard). Flutter sends the live LTP for this purpose.
        // For pure market orders (no LTP available) price stays 0.
        const payload = {
            dhanClientId: user.dhanClientId,
            transactionType, // 👈 dynamic
            exchangeSegment,
            productType: "INTRADAY",
            orderType,
            validity, // 👈 dynamic — DAY or IOC, from req.body (see validation above)
            securityId,
            quantity: qty,
            disclosedQuantity: 0,
            price: prc,          // 0 for pure market, LTP for protected market, limit price for LIMIT
            triggerPrice: 0,
            afterMarketOrder: false
        };

        console.log("📦 Order Payload:", payload);

        const response = await axios.post(
            "https://api.dhan.co/v2/orders",
            payload,
            { headers: { "access-token": dhanAccessToken } }
        );

        console.log("✅ Order Response:", response.data);   

        // ================= STORE =================
        await query.insertSingle(constants.vals.defaultDB, "pending_orders", {
            dhan_client_id: user.dhanClientId,
            order_id: response.data.orderId,
            order_type: orderType,
            transaction_type: transactionType, // 👈 important
            security_id: securityId,
            quantity: qty,
            price: prc
        });

        _notifyUser(
            user.dhanClientId,
            `${transactionType === 'BUY' ? '🟢 BUY' : '🔴 SELL'} Order Placed`,
            `Qty: ${qty}${prc > 0 ? `  @  ₹${prc}` : '  (Market)'}`,
            response.data.orderId
        );

        return res.json({
            status: true,
            message: `${transactionType} order placed`,
            data: response.data
        });

    } catch (err) {
        console.log("❌ ORDER ERROR:", err.response?.data || err.message);

        return res.json({
            status: false,
            message:
                err.response?.data?.errorMessage ||
                err.response?.data?.message ||
                JSON.stringify(err.response?.data) ||
                err.message
        });
    }
};


// exports.buyOrder = async (req, res) => {
//     try {
//         const user = req.user;

//         const clientId = user.dhanClientId || user.dhan_client_id;

//         if (!clientId) {
//             return res.json({ status: false, message: "Auth required" });
//         }

//         const {
//             dhanAccessToken,
//             securityId,
//             exchangeSegment,
//             quantity,
//             price = 0,
//             orderType = "MARKET",
//             transactionType = "BUY"
//         } = req.body;

//         if (!["BUY", "SELL"].includes(transactionType)) {
//             return res.json({ status: false, message: "Invalid transactionType" });
//         }

//         // 🔒 RULE CHECK
//         const rule = await checkUserRules(clientId);
//         if (rule.blocked) {
//             return res.json({ status: false, message: rule.reason });
//         }

//         // 🔥 LOT SIZE CHECK
//         const instrument = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "instruments",
//             `WHERE security_id='${securityId}'`
//         );

//         const lotSize = Number(instrument?.lot_size || 1);

//         if (quantity % lotSize !== 0) {
//             return res.json({
//                 status: false,
//                 message: `Quantity must be multiple of ${lotSize}`
//             });
//         }

//         // 🔥 SELL VALIDATION
//         if (transactionType === "SELL") {
//             const openPosition = await query.fetchSingleRecord(
//                 constants.vals.defaultDB,
//                 "challenge_trade_logs",
//                 `WHERE dhan_client_id='${clientId}'
//                  AND security_id='${securityId}'
//                  AND status='OPEN'`,
//                 "SUM(quantity) as total"
//             );

//             const availableQty = Number(openPosition?.total || 0);

//             if (availableQty < quantity) {
//                 return res.json({
//                     status: false,
//                     message: `Available qty: ${availableQty}`
//                 });
//             }
//         }

//         const payload = {
//             dhanClientId: clientId,
//             transactionType,
//             exchangeSegment,
//             productType: "INTRADAY",
//             orderType,
//             validity: "DAY",
//             securityId,
//             quantity: Number(quantity),
//             disclosedQuantity: 0,
//             price: orderType === "LIMIT" ? Number(price) : 0,
//             triggerPrice: 0,
//             afterMarketOrder: false
//         };

//         const response = await axios.post(
//             "https://api.dhan.co/v2/orders",
//             payload,
//             { headers: { "access-token": dhanAccessToken } }
//         );

//         // ✅ ONLY SAVE PENDING
//         if (orderType !== "MARKET") {
//             await query.insertSingle(constants.vals.defaultDB, "pending_orders", {
//                 dhan_client_id: clientId,
//                 order_id: response.data.orderId,
//                 order_type: orderType,
//                 security_id: securityId,
//                 quantity,
//                 price
//             });
//         }

//         return res.json({ status: true, message: "Order placed", data: response.data });

//     } catch (err) {
//         return res.json({
//             status: false,
//             message:
//                 err.response?.data?.errorMessage ||
//                 err.response?.data?.message ||
//                 err.message
//         });
//     }
// };



exports.buySuperOrder = async (req, res) => {
    try {
        const user = req.user;

        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "Auth required" });
        }

        const {
            dhanAccessToken,
            securityId,
            tradingSymbol = '',
            exchangeSegment,
            quantity,
            price,
            targetPrice,
            stopLossPrice,
            transactionType // 👈 dynamic
        } = req.body;

        // ================= VALIDATION =================
        if (!transactionType || !["BUY", "SELL"].includes(transactionType)) {
            return res.json({ status: false, message: "Invalid transaction type" });
        }

        if (!dhanAccessToken) {
            return res.json({ status: false, message: "Access token required" });
        }

        if (!securityId || !quantity) {
            return res.json({ status: false, message: "Missing fields" });
        }

        const qty = Number(quantity);
        const prc = Number(price);
        const target = Number(targetPrice || 0);
        const sl = Number(stopLossPrice || 0);

        if (isNaN(qty) || qty <= 0) {
            return res.json({ status: false, message: "Invalid quantity" });
        }

        if (isNaN(prc) || prc <= 0) {
            return res.json({ status: false, message: "Invalid price" });
        }

        // ================= INSTRUMENT LIFECYCLE =================
        const tradable = await instrumentStatus.checkTradable({ securityId, exchangeSegment });
        if (!tradable.ok) {
            return res.json({ status: false, message: tradable.message });
        }

        // ================= RULE CHECK =================
        const rule = await checkUserRules(
            user.dhanClientId,
            transactionType
        );
        if (rule.blocked) {
            return res.json({
                status: false,
                message: `Blocked: ${rule.reason}`
            });
        }

        // ================= CAPITAL CHECK (ONLY BUY) =================
        if (transactionType === "BUY") {
            const capCheck = await checkCapitalBeforeTrade(
                user.dhanClientId,
                prc,
                qty,
                securityId,
                tradingSymbol
            );

            if (!capCheck.allowed) {
                return res.json({
                    status: false,
                    message: capCheck.reason
                });
            }
        }

        // ================= PAYLOAD =================
        const payload = {
            dhanClientId: user.dhanClientId,
            transactionType,
            exchangeSegment,
            productType: "INTRADAY",
            orderType: "LIMIT",
            securityId,
            quantity: qty,
            price: prc,
            targetPrice: target,
            stopLossPrice: sl
        };

        console.log("🚀 Super Order Payload:", payload);

        const response = await axios.post(
            "https://api.dhan.co/v2/super/orders",
            payload,
            { headers: { "access-token": dhanAccessToken } }
        );

        // ================= STORE =================
        await query.insertSingle(constants.vals.defaultDB, "pending_orders", {
            dhan_client_id: user.dhanClientId,
            order_id: response.data.orderId,
            order_type: "SUPER",
            transaction_type: transactionType,
            security_id: securityId,
            quantity: qty,
            price: prc,
            target_price: target,
            stop_loss_price: sl
        });

        _notifyUser(
            user.dhanClientId,
            `${transactionType === 'BUY' ? '🟢 BUY' : '🔴 SELL'} Super Order Placed`,
            `Qty: ${qty}  @  ₹${prc}${target > 0 ? `  |  Target ₹${target}` : ''}${sl > 0 ? `  |  SL ₹${sl}` : ''}`,
            response.data.orderId
        );

        return res.json({
            status: true,
            message: `${transactionType} super order placed`,
            data: response.data
        });

    } catch (err) {
        console.log("❌ SUPER ORDER ERROR:", err.response?.data || err.message);

        return res.json({
            status: false,
            message:
                err.response?.data?.errorMessage ||
                err.response?.data?.message ||
                JSON.stringify(err.response?.data) ||
                err.message
        });
    }
};


// ── Major index scrips for expiry sync ───────────────────────────────────────
const INDEX_SCRIPS = [
    { scrip: 13,  seg: 'IDX_I', symbol: 'NIFTY'       },
    { scrip: 25,  seg: 'IDX_I', symbol: 'BANKNIFTY'   },
    { scrip: 27,  seg: 'IDX_I', symbol: 'FINNIFTY'    },
    { scrip: 442, seg: 'IDX_I', symbol: 'MIDCAPNIFTY' },
    { scrip: 51,  seg: 'IDX_I', symbol: 'SENSEX'      },
];

// ── Sync expiry dates from Dhan API → stored in option_expiry_dates ──────────
// Called by cron and also available as a manual API endpoint.
exports.syncExpiryDates = async (req, res) => {
    try {
        const selfAuth = await _getSelfToken();
        if (!selfAuth) {
            const msg = 'SELF market token not available for expiry sync';
            console.log(`[ExpirySync] ⚠️  ${msg}`);
            if (res) return res.json({ status: false, message: msg });
            return;
        }

        const accessToken = selfAuth.token;
        const clientId    = selfAuth.clientId;
        let totalInserted = 0;

        for (const idx of INDEX_SCRIPS) {
            try {
                const response = await axios.post(
                    'https://api.dhan.co/v2/optionchain/expirylist',
                    { UnderlyingScrip: idx.scrip, UnderlyingSeg: idx.seg },
                    { headers: { 'access-token': accessToken, 'client-id': clientId, 'Content-Type': 'application/json' } }
                );

                const rawDates = response.data?.data || [];
                // IST, with the expiry-day market-close cutoff (was UTC date).
                const futureDates = rawDates.filter(d => !instrumentStatus.isExpiryPassed(d));

                console.log(`[ExpirySync] ${idx.symbol} (${idx.scrip}): ${futureDates.length} future dates`);

                for (const date of futureDates) {
                    await dbcon.query(
                        constants.vals.defaultDB,
                        `INSERT INTO option_expiry_dates (underlying_scrip, underlying_seg, symbol, expiry_date)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE updated_at = NOW()`,
                        [idx.scrip, idx.seg, idx.symbol, date]
                    );
                    totalInserted++;
                }
            } catch (e) {
                console.log(`[ExpirySync] ❌ ${idx.symbol}: ${e.message}`);
            }
        }

        console.log(`[ExpirySync] ✅ Done — ${totalInserted} rows upserted`);
        if (res) return res.json({ status: true, message: `Synced ${totalInserted} expiry records` });

    } catch (error) {
        console.log('[ExpirySync] ERROR:', error.message);
        if (res) return res.json({ status: false, message: error.message });
    }
};

// ── Available expiry dates for a symbol ──────────────────────────────────────
exports.getExpiryDates = async (req, res) => {
    try {
        const { underlyingSymbol } = req.query;
        if (!underlyingSymbol) {
            return res.json({ status: false, message: "underlyingSymbol is required" });
        }

        const sym = underlyingSymbol.toUpperCase();
        // Earliest still-tradable expiry: today until 15:30 IST, then tomorrow.
        const firstActive = instrumentStatus.firstActiveExpiryDate();

        // Step 1: Query from option_expiry_dates (synced from Dhan API)
        const rows = await dbcon.query(
            constants.vals.defaultDB,
            `SELECT DATE_FORMAT(expiry_date, '%Y-%m-%d') as expiry
             FROM option_expiry_dates
             WHERE symbol = ?
               AND expiry_date >= ?
             ORDER BY expiry_date ASC
             LIMIT 20`,
            [sym, firstActive]
        );

        let dates = (rows || []).map(r => r.expiry).filter(Boolean);

        console.log(`[ExpiryDates] symbol=${sym} found=${dates.length} from option_expiry_dates`);

        // Step 2: Fallback — query instruments table
        if (dates.length === 0) {
            const active = instrumentStatus.activeDerivativeFilter("instruments");
            const instrRows = await dbcon.query(
                constants.vals.defaultDB,
                `SELECT DISTINCT DATE_FORMAT(sm_expiry_date, '%Y-%m-%d') as expiry
                 FROM instruments
                 WHERE ${active.sql}
                   AND display_name LIKE ?
                 ORDER BY sm_expiry_date ASC
                 LIMIT 12`,
                [...active.params, `%${underlyingSymbol}%`]
            );
            dates = (instrRows || []).map(r => r.expiry).filter(Boolean);
            console.log(`[ExpiryDates] fallback instruments: found=${dates.length}`);
        }

        // No generated/guessed expiries: a made-up date is a contract that
        // may not exist. Empty means "no listed expiry" — the client shows that.

        return res.json({ status: true, data: dates });
    } catch (error) {
        console.log('[ExpiryDates] ERROR:', error.message);
        return res.json({ status: false, message: error.message });
    }
};

// exports.buySuperOrder = async (req, res) => {
//     try {
//         const user = req.user;

//         const {
//             dhanAccessToken,
//             securityId,
//             exchangeSegment,
//             quantity,
//             price,
//             targetPrice,
//             stopLossPrice
//         } = req.body;

//         const payload = {
//             dhanClientId: user.dhan_client_id,
//             correlationId: uuidv4(),
//             transactionType: "BUY",
//             exchangeSegment,
//             productType: "INTRADAY",
//             orderType: "LIMIT",
//             securityId,
//             quantity,
//             price,
//             targetPrice,
//             stopLossPrice
//         };

//         const response = await axios.post(
//             "https://api.dhan.co/v2/super/orders",
//             payload,
//             {
//                 headers: {
//                     "access-token": dhanAccessToken
//                 }
//             }
//         );

//         res.json({
//             status: true,
//             message: "Super order placed",
//             data: response.data
//         });

//     } catch (err) {
//         res.json({
//             status: false,
//             message: err.response?.data || err.message
//         });
//     }
// };

// exports.buySuperOrder = async (req, res) => {
//     try {
//         const user = req.user;

//         if (!user || !user.dhanClientId) {
//             return res.json({
//                 status: false,
//                 message: "User authentication required"
//             });
//         }

//         const dhanClientId = user.dhanClientId;
//         const {
//             dhanAccessToken,
//             transactionType = "BUY",
//             securityId,
//             exchangeSegment,
//             quantity,
//             price,
//             targetPrice,
//             stopLossPrice,
//             index
//         } = req.body;

//         if (!price || !targetPrice || !stopLossPrice) {
//             return res.json({
//                 status: false,
//                 message: "Price, Target, StopLoss required"
//             });
//         }

//         if (stopLossPrice >= price) {
//             return res.json({
//                 status: false,
//                 message: "StopLoss must be less than entry"
//             });
//         }

//         if (targetPrice <= price) {
//             return res.json({
//                 status: false,
//                 message: "Target must be greater than entry"
//             });
//         }

//         // ================= CHALLENGE VALIDATION =================

//         const challenge = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "user_challenges",
//             `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
//         );

//         if (!challenge || !challenge.id) {
//             return res.json({
//                 status: false,
//                 message: "No active challenge found"
//             });
//         }

//         const pnlData = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "challenge_trade_logs",
//             `WHERE dhan_client_id='${dhanClientId}' AND trade_date=CURDATE()`,
//             "SUM(pnl) as total"
//         );

//         const todayPnL = Number(pnlData?.total || 0);

//         if (todayPnL <= -challenge.max_loss) {
//             return res.json({
//                 status: false,
//                 rule: "DAILY_LOSS_LIMIT",
//                 message: "Daily loss limit reached"
//             });
//         }

//         if (todayPnL >= challenge.max_profit) {
//             return res.json({
//                 status: false,
//                 rule: "DAILY_PROFIT_TARGET",
//                 message: "Daily profit target achieved"
//             });
//         }

//         const tradeCount = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "challenge_trade_logs",
//             `WHERE dhan_client_id='${dhanClientId}' AND trade_date=CURDATE()`,
//             "COUNT(*) as total"
//         );

//         if ((Number(tradeCount?.total) || 0) >= challenge.max_trades_per_day) {
//             return res.json({
//                 status: false,
//                 rule: "MAX_TRADES_LIMIT",
//                 message: "Maximum trades per day reached"
//             });
//         }

//         if (index) {
//             let allowedQty = 0;
//             if (index === "NIFTY") allowedQty = challenge.nifty_lots;
//             else if (index === "BANKNIFTY") allowedQty = challenge.banknifty_lots;
//             else if (index === "FINNIFTY") allowedQty = challenge.finnifty_lots;
//             else if (index === "MIDCAPNIFTY") allowedQty = challenge.midcapnifty_lots;
//             else if (index === "SENSEX") allowedQty = challenge.sensex_lots;

//             if (quantity > allowedQty) {
//                 return res.json({
//                     status: false,
//                     rule: "QUANTITY_RULE",
//                     message: `Allowed ${allowedQty}, tried ${quantity}`
//                 });
//             }
//         }

//         // ================= DHAN PAYLOAD =================

//         const orderPayload = {
//             dhanClientId,
//             correlationId: Date.now().toString(),
//             transactionType,
//             exchangeSegment,
//             productType: "INTRADAY",
//             orderType: "LIMIT",
//             securityId,
//             quantity: Number(quantity),
//             price: Number(price),
//             targetPrice: Number(targetPrice),
//             stopLossPrice: Number(stopLossPrice)
//         };

//         const response = await axios.post(
//             "https://api.dhan.co/v2/super/orders",
//             orderPayload,
//             {
//                 headers: {
//                     "access-token": dhanAccessToken,
//                     "Content-Type": "application/json"
//                 }
//             }
//         );

//         // ================= STORE TRADE LOG =================

//         // await query.insertSingle(constants.vals.defaultDB, "challenge_trade_logs", {
//         //     dhan_client_id: dhanClientId,
//         //     challenge_id: challenge.id,
//         //     // security_id: securityId,
//         //     // exchange_segment: exchangeSegment,
//         //     // quantity: Number(quantity),
//         //     // price: Number(price),
//         //     // target_price: Number(targetPrice),
//         //     // stop_loss_price: Number(stopLossPrice),
//         //     trade_type: "LIMIT",
//         //     // transaction_type: transactionType,
//         //     // product_type: "INTRADAY",
//         //     index_name: index || null,
//         //     quantity: Number(quantity),
//         //     // order_id: response.data?.orderId || response.data?.data?.orderId || null,
//         //     pnl: 0,
//         //     trade_date: new Date().toISOString().slice(0, 10)
//         // });

//         // console.log(response.data);
//         // console.log("dasjjdashdasjdas");

        

//         return res.json({
//             status: true,
//             message: "Super order placed",
//             data: response.data
//         });

//     } catch (error) {
//         return res.json({
//             status: false,
//             message: error.response?.data || error.message
//         });
//     }
// };



// Journal's trade-history source. Used to call Dhan's live
// GET /v2/trades/{from}/{to}/{page} on every single open, one page at a
// time (page defaulted to 0, never looped) — any account with more than a
// page of trades in range, or whose trades for that month simply weren't
// on page 0, silently saw "no trades". Now reads from the `dhan_trades`
// cache (kept warm by helpers/dhanTradeHistorySync.js's daily 3:40 PM IST
// sync + the backfill fired on Dhan connect) and matches legs into
// round-trip trades locally — Dhan is never called from this endpoint.
//
// A user who connected Dhan before this feature existed has
// trade_history_synced_at = NULL; such a user gets one blocking full
// backfill right here, the only time this endpoint is slow, after which
// every later call is a plain DB read.
exports.getTradeHistory = async (req, res) => {
    try {
        const user = req.user;

        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const dhanAccessToken = await _getDhanToken(user.dhanClientId);
        if (!dhanAccessToken) {
            return res.json({ status: false, message: "Dhan access token not found. Please re-login." });
        }

        const { fromDate, toDate, isWeightedAvg } = req.body;

        if (!fromDate || !toDate) {
            return res.json({ status: false, message: "fromDate and toDate are required (YYYY-MM-DD)" });
        }

        const userRow = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "users",
            `WHERE dhan_client_id='${user.dhanClientId}'`,
            "trade_history_synced_at"
        );
        if (!userRow || !userRow.trade_history_synced_at) {
            await backfillTradeHistory(user.dhanClientId, dhanAccessToken);
        }

        const rows = await query.fetchRecords(
            constants.vals.defaultDB,
            "dhan_trades",
            `WHERE dhan_client_id='${user.dhanClientId}' AND trade_date BETWEEN '${fromDate}' AND '${toDate}'`
        ) || [];

        const { data, summary, totalRawTrades } = buildTradeHistory(rows, {
            method: isWeightedAvg ? "weighted" : "fifo",
        });

        return res.json({ status: true, totalRawTrades, summary, data });

    } catch (error) {
        console.log("TRADE HISTORY ERROR:", error.response?.data || error.message);
        return res.json({ status: false, message: error.response?.data || error.message });
    }
};





// exports.dummyBuy = async (req, res) => {
//     try {
//         const user = req.user;

//         const {
//             securityId,
//             quantity,
//             price,
//             clientId
//         } = req.body;

//         if (!user || !user.dhanClientId) {
//             return res.json({ status: false, message: "Auth required" });
//         }

//         if (!securityId || !quantity || !price) {
//             return res.json({ status: false, message: "Missing fields" });
//         }

//         console.log("Dummy Buy Request:", req.body);

//         // =========================================
//         // 🚫 RULE CHECK (EXISTING)
//         // =========================================
//         const rule = await checkUserRules(clientId);
//         if (rule.blocked) {
//             return res.json({ status: false, message: `Blocked: ${rule.reason}` });
//         }

//         // =========================================
//         // 🚫 CAPITAL PRE-CHECK (NEW 🔥)
//         // =========================================
//         const capCheck = await checkCapitalBeforeTrade(clientId, price, quantity);

//         if (!capCheck.allowed) {
//             return res.json({
//                 status: false,
//                 message: capCheck.reason
//             });
//         }

//         // =========================================
//         // ✅ INSERT TRADE
//         // =========================================
//         const orderId = "DUMMY_" + Date.now();

//         await query.insertSingle(
//             constants.vals.defaultDB,
//             "challenge_trade_logs",
//             {
//                 dhan_client_id: clientId,
//                 security_id: securityId,
//                 buy_price: price,
//                 quantity: Number(quantity),
//                 status: "OPEN",
//                 pnl: 0,
//                 trade_date: new Date().toISOString().slice(0, 10)
//             }
//         );

//         return res.json({
//             status: true,
//             message: "Dummy BUY order placed",
//             data: { orderId }
//         });

//     } catch (e) {
//         return res.json({
//             status: false,
//             message: e.message
//         });
//     }
// };

// exports.dummySell = async (req, res) => {
//     try {
//         const user = req.user;

//         const {
//             securityId,
//             sellPrice,
//             clientId
//         } = req.body;

//         if (!user || !user.dhanClientId) {
//             return res.json({ status: false, message: "Auth required" });
//         }

//         if (!securityId || !sellPrice) {
//             return res.json({ status: false, message: "Missing fields" });
//         }

//         // 🔍 FIND OPEN TRADE
//         const openTrade = await query.fetchSingleRecord(
//             constants.vals.defaultDB,
//             "challenge_trade_logs",
//             `WHERE dhan_client_id='${clientId}'
//              AND security_id='${securityId}'
//              AND status='OPEN'
//              ORDER BY id ASC`
//         );

//         if (!openTrade) {
//             return res.json({ status: false, message: "No open trade found" });
//         }

//         // 💰 CALCULATE PNL
//         const pnl =
//             (Number(sellPrice) - Number(openTrade.buy_price)) *
//             Number(openTrade.quantity);

//         // ✅ CLOSE TRADE
//         await query.updateRecord(
//             constants.vals.defaultDB,
//             "challenge_trade_logs",
//             `id='${openTrade.id}'`,
//             `
//             sell_price='${sellPrice}',
//             status='CLOSED',
//             pnl='${pnl}'
//             `
//         );

//         return res.json({
//             status: true,
//             message: "Dummy SELL executed",
//             data: {
//                 pnl
//             }
//         });

//     } catch (e) {
//         return res.json({
//             status: false,
//             message: e.message
//         });
//     }
// };




exports.getMarginCalculator = async (req, res) => {
    try {
        const user = req.user;

        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const { dhanAccessToken, multi, includePosition, includeOrder, scripList, ...singlePayload } = req.body;

        if (!dhanAccessToken) {
            return res.json({ status: false, message: "dhanAccessToken required" });
        }

        const headers = {
            "access-token": dhanAccessToken,
            "Content-Type": "application/json",
            "Accept": "application/json"
        };

        let response;

        if (multi || scripList) {
            // Multi margin calculator
            const multiPayload = {
                dhanClientId: user.dhanClientId,
                includePosition: includePosition ?? true,
                includeOrder: includeOrder ?? true,
                scripList: scripList || []
            };
            response = await axios.post("https://api.dhan.co/v2/margincalculator/multi", multiPayload, { headers });
        } else {
            // Single margin calculator
            response = await axios.post("https://api.dhan.co/v2/margincalculator", singlePayload, { headers });
        }

        console.log("MARGIN CALCULATOR RESPONSE:", response.data);

        return res.json({
            status: true,
            data: response.data
        });

    } catch (error) {
        console.log("MARGIN CALCULATOR ERROR:", error.response?.data || error.message);
        return res.json({ status: false, message: error.response?.data || error.message });
    }
};


exports.getFundLimit = async (req, res) => {
    try {
        const user = req.user;

        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        // Fetch access token from DB — avoids GET body issues and keeps token server-side
        const dbUser = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            'users',
            `WHERE dhan_client_id='${user.dhanClientId}'`,
            'dhan_access_token'
        );

        const dhanAccessToken = dbUser?.dhan_access_token;
        if (!dhanAccessToken) {
            return res.json({ status: false, message: "Dhan access token not found. Please re-login." });
        }

        const response = await axios.get("https://api.dhan.co/v2/fundlimit", {
            headers: {
                "access-token": dhanAccessToken,
                "Content-Type": "application/json"
            }
        });

        return res.json({
            status: true,
            data: response.data
        });

    } catch (error) {
        console.log("FUND LIMIT ERROR:", error.response?.data || error.message);
        return res.json({ status: false, message: error.response?.data || error.message });
    }
};



exports.getSuperOrders = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const dhanAccessToken = await _getDhanToken(user.dhanClientId);
        if (!dhanAccessToken) {
            return res.json({ status: false, message: "Dhan access token not found. Please re-login." });
        }

        const response = await axios.get("https://api.dhan.co/v2/super/orders", {
            headers: { "access-token": dhanAccessToken, "Content-Type": "application/json" }
        });

        return res.json({ status: true, data: response.data });

    } catch (error) {
        console.log("GET SUPER ORDERS ERROR:", error.response?.data || error.message);
        return res.json({ status: false, message: error.response?.data || error.message });
    }
};


exports.modifySuperOrder = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const { orderId } = req.params;
        const {
            orderType,
            legName,
            quantity,
            price,
            targetPrice,
            stopLossPrice,
            trailingJump
        } = req.body;

        if (!orderId) {
            return res.json({ status: false, message: "orderId required" });
        }

        const dhanAccessToken = await _getDhanToken(user.dhanClientId);
        if (!dhanAccessToken) {
            return res.json({ status: false, message: "Dhan access token not found. Please re-login." });
        }

        const orderPayload = {
            dhanClientId: String(user.dhanClientId),
            orderId: String(orderId),
            orderType,
            legName: legName || 'ENTRY_LEG',
            quantity: Number(quantity),
            price: Number(price),
            targetPrice: Number(targetPrice || 0),
            stopLossPrice: Number(stopLossPrice || 0),
            trailingJump: Number(trailingJump || 0)
        };

        console.log("MODIFY SUPER ORDER PAYLOAD:", JSON.stringify(orderPayload, null, 2));

        const response = await axios.put(
            `https://api.dhan.co/v2/super/orders/${orderId}`,
            orderPayload,
            { headers: { "access-token": dhanAccessToken, "Content-Type": "application/json" } }
        );

        console.log("MODIFY SUPER ORDER RESPONSE:", JSON.stringify(response.data, null, 2));

        const d = response.data;
        if (d?.status === 'failure' || d?.errorCode) {
            return res.json({
                status: false,
                message: d.errorMessage || d.message || 'Modify failed',
            });
        }

        _notifyUser(
            user.dhanClientId,
            '📝 Super Order Modified',
            `Order #${orderId} updated  |  Qty: ${quantity}  @  ₹${price}${targetPrice ? `  |  Target ₹${targetPrice}` : ''}${stopLossPrice ? `  |  SL ₹${stopLossPrice}` : ''}`,
            orderId
        );
        return res.json({ status: true, message: "Super order modified successfully", data: d });

    } catch (error) {
        console.log("MODIFY SUPER ORDER ERROR:", error.response?.data || error.message);
        return res.json({ status: false, message: error.response?.data || error.message });
    }
};


exports.cancelSuperOrderLeg = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const { orderId, orderLeg } = req.params;
        const { dhanAccessToken } = req.body;

        if (!dhanAccessToken) {
            return res.json({ status: false, message: "dhanAccessToken required" });
        }

        if (!orderId || !orderLeg) {
            return res.json({ status: false, message: "orderId and orderLeg required" });
        }

        const response = await axios.delete(
            `https://api.dhan.co/v2/super/orders/${orderId}/${orderLeg}`,
            { headers: { "access-token": dhanAccessToken, "Content-Type": "application/json" } }
        );

        console.log("CANCEL SUPER ORDER LEG RESPONSE:", JSON.stringify(response.data, null, 2));

        const d = response.data;
        if (d?.status === 'failure' || d?.errorCode) {
            return res.json({
                status: false,
                message: d.errorMessage || d.message || 'Cancel leg failed',
            });
        }

        _notifyUser(
            user.dhanClientId,
            '🗑️ Super Order Cancelled',
            `Order #${orderId} (${orderLeg}) has been cancelled`,
            orderId
        );
        return res.json({ status: true, message: "Super order leg cancelled successfully", data: d });

    } catch (error) {
        console.log("CANCEL SUPER ORDER LEG ERROR:", error.response?.data || error.message);
        return res.json({ status: false, message: error.response?.data || error.message });
    }
};


exports.modifyOrder = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const { orderId } = req.params;
        const {
            orderType,
            legName,
            quantity,
            price,
            disclosedQuantity,
            triggerPrice,
            validity
        } = req.body;

        // ── Incoming request log ──────────────────────────────────────────────
        console.log("=".repeat(55));
        console.log("📝 [MODIFY ORDER] Incoming Request");
        console.log("  PARAMS  :", JSON.stringify(req.params));
        console.log("  BODY    :", JSON.stringify({
            orderType,
            legName,
            quantity,
            price,
            disclosedQuantity,
            triggerPrice,
            validity
        }, null, 2));
        console.log("=".repeat(55));

        if (!orderId) {
            return res.json({ status: false, message: "orderId required" });
        }

        const dhanAccessToken = await _getDhanToken(user.dhanClientId);
        if (!dhanAccessToken) {
            return res.json({ status: false, message: "Dhan access token not found. Please re-login." });
        }

        const orderPayload = {
            dhanClientId: String(user.dhanClientId),
            orderId: String(orderId),
            orderType,
            legName: legName || 'ENTRY_LEG',
            quantity: Number(quantity),
            price: Number(price),
            disclosedQuantity: Number(disclosedQuantity || 0),
            triggerPrice: Number(triggerPrice || 0),
            validity: validity || 'DAY'
        };

        // ── Payload sent to Dhan ──────────────────────────────────────────────
        console.log("📤 [MODIFY ORDER] Sending to Dhan API:");
        console.log("  URL     :", `PUT https://api.dhan.co/v2/orders/${orderId}`);
        console.log("  PAYLOAD :", JSON.stringify(orderPayload, null, 2));

        const response = await axios.put(
            `https://api.dhan.co/v2/orders/${orderId}`,
            orderPayload,
            { headers: { "access-token": dhanAccessToken, "Content-Type": "application/json" } }
        );

        // ── Dhan response log ─────────────────────────────────────────────────
        console.log("📥 [MODIFY ORDER] Dhan Response:");
        console.log("  HTTP STATUS :", response.status);
        console.log("  BODY        :", JSON.stringify(response.data, null, 2));
        console.log("=".repeat(55));

        // Dhan may return HTTP 200 but with status:"failure" in the body
        const d = response.data;
        if (d?.status === 'failure' || d?.errorCode) {
            console.log("❌ [MODIFY ORDER] Dhan returned failure:", d.errorMessage || d.message);
            return res.json({
                status: false,
                message: d.errorMessage || d.message || 'Modify failed',
            });
        }

        console.log("✅ [MODIFY ORDER] Success — orderId:", orderId);
        _notifyUser(
            user.dhanClientId,
            '📝 Order Modified',
            `Order #${orderId} has been updated  |  Qty: ${quantity}  @  ₹${price}`,
            orderId
        );
        return res.json({ status: true, message: "Order modified successfully", data: d });

    } catch (error) {
        console.log("❌ [MODIFY ORDER] Exception:");
        console.log("  HTTP STATUS :", error.response?.status);
        console.log("  ERROR BODY  :", JSON.stringify(error.response?.data, null, 2));
        console.log("  MESSAGE     :", error.message);
        return res.json({ status: false, message: error.response?.data || error.message });
    }
};


exports.cancelOrder = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const { orderId } = req.params;
        const { dhanAccessToken } = req.body;

        // ── Incoming request log ──────────────────────────────────────────────
        console.log("=".repeat(55));
        console.log("🗑️  [CANCEL ORDER] Incoming Request");
        console.log("  PARAMS  :", JSON.stringify(req.params));
        console.log("  BODY    :", JSON.stringify({
            dhanAccessToken: dhanAccessToken ? `${dhanAccessToken.substring(0, 10)}...` : 'MISSING'
        }, null, 2));
        console.log("=".repeat(55));

        if (!dhanAccessToken) {
            return res.json({ status: false, message: "dhanAccessToken required" });
        }

        if (!orderId) {
            return res.json({ status: false, message: "orderId required" });
        }

        // ── Request sent to Dhan ──────────────────────────────────────────────
        console.log("📤 [CANCEL ORDER] Sending to Dhan API:");
        console.log("  URL :", `DELETE https://api.dhan.co/v2/orders/${orderId}`);

        const response = await axios.delete(
            `https://api.dhan.co/v2/orders/${orderId}`,
            { headers: { "access-token": dhanAccessToken, "Content-Type": "application/json" } }
        );

        // ── Dhan response log ─────────────────────────────────────────────────
        console.log("📥 [CANCEL ORDER] Dhan Response:");
        console.log("  HTTP STATUS :", response.status);
        console.log("  BODY        :", JSON.stringify(response.data, null, 2));
        console.log("=".repeat(55));

        // Dhan may return HTTP 200 but with status:"failure" in the body
        const d = response.data;
        if (d?.status === 'failure' || d?.errorCode) {
            console.log("❌ [CANCEL ORDER] Dhan returned failure:", d.errorMessage || d.message);
            return res.json({
                status: false,
                message: d.errorMessage || d.message || 'Cancel failed',
            });
        }

        console.log("✅ [CANCEL ORDER] Success — orderId:", orderId);
        _notifyUser(
            user.dhanClientId,
            '🗑️ Order Cancelled',
            `Order #${orderId} has been cancelled`,
            orderId
        );
        return res.json({ status: true, message: "Order cancelled successfully", data: d });

    } catch (error) {
        console.log("❌ [CANCEL ORDER] Exception:");
        console.log("  HTTP STATUS :", error.response?.status);
        console.log("  ERROR BODY  :", JSON.stringify(error.response?.data, null, 2));
        console.log("  MESSAGE     :", error.message);
        return res.json({ status: false, message: error.response?.data || error.message });
    }
};



// ── Fetch the SELF market token (same one used for live price WebSocket) ──────
async function _getSelfToken() {
    const clientId = process.env.DHAN_MARKET_CLIENT_ID;
    if (!clientId) return null;
    try {
        const row = await query.fetchSingleRecord(
            constants.vals.defaultDB, 'market_data_tokens',
            `WHERE dhan_client_id = '${clientId}'`
        );
        if (row && !Array.isArray(row) && row.access_token) {
            return { token: row.access_token, clientId };
        }
    } catch (_) {}
    const envToken = process.env.DHAN_MARKET_ACCESS_TOKEN;
    if (envToken) return { token: envToken, clientId };
    return null;
}

// ── Cached Historical Data (from local DB — instant response) ────────────────
exports.getCachedHistoricalData = async (req, res) => {
    try {
        const { securityId, exchangeSegment, instrument } = req.body;
        if (!securityId || !exchangeSegment) {
            return res.json({ status: false, message: "securityId and exchangeSegment required" });
        }

        const histCache = require('../helpers/historicalCache');
        const instr = instrument || (exchangeSegment === 'IDX_I' ? 'INDEX' : exchangeSegment.includes('FNO') ? 'OPTIDX' : 'EQUITY');

        // Serve cached data IMMEDIATELY — don't wait for sync
        const data = await histCache.getCachedCandles(securityId);

        if (data && data.open.length > 0) {
            // Return cached data right away for instant chart render
            res.json({ status: true, data, cached: true, candles: data.open.length });
            // Background sync if stale — client doesn't wait
            histCache.needsSync(securityId).then(needs => {
                if (needs) {
                    histCache.syncHistory(securityId, exchangeSegment, instr)
                        .catch(e => console.log('[HistCache] BG sync error:', e.message));
                }
            }).catch(() => {});
            return;
        }

        // No cache at all — must sync once (first time this stock is viewed)
        await histCache.syncHistory(securityId, exchangeSegment, instr);
        const freshData = await histCache.getCachedCandles(securityId);
        if (!freshData || !freshData.open.length) {
            return res.json({ status: false, message: "No historical data available" });
        }
        return res.json({ status: true, data: freshData, cached: false, candles: freshData.open.length });

    } catch (error) {
        console.log("CACHED HISTORICAL ERROR:", error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ── Clear & Re-sync historical cache ─────────────────────────────────────────
exports.resyncHistoricalCache = async (req, res) => {
    try {
        const { securityId, exchangeSegment, instrument, clearAll } = req.body;
        const histCache = require('../helpers/historicalCache');

        if (clearAll) {
            await histCache.clearAll();
            return res.json({ status: true, message: 'All cached data cleared. Will re-sync on next chart load.' });
        }

        if (!securityId) return res.json({ status: false, message: 'securityId required (or clearAll: true)' });

        const instr = instrument || (exchangeSegment === 'IDX_I' ? 'INDEX' : 'EQUITY');
        const result = await histCache.resyncHistory(securityId, exchangeSegment || 'IDX_I', instr);
        return res.json({ status: true, message: `Re-synced ${result.total} candles`, data: result });
    } catch (e) {
        return res.json({ status: false, message: e.message });
    }
};

// ── Cached Intraday Data (multi-interval, multi-day — from local DB) ─────────
// Distinct from getIntradayData above (which is a live, uncached, today-only
// passthrough) and from getCachedHistoricalData above (which is daily-only,
// one row per day). This serves 1m/5m/15m/etc. candles spanning many days
// from market_historical_candles, backfilling on first view.
exports.getCachedIntradayData = async (req, res) => {
    try {
        const { securityId, exchangeSegment, instrument, interval, fromDate, toDate } = req.body;
        const intervalMinutes = parseInt(interval, 10);
        const fromEpochSec = parseInt(fromDate, 10);
        const toEpochSec = parseInt(toDate, 10);

        if (!securityId || !exchangeSegment || !intervalMinutes || !fromEpochSec || !toEpochSec) {
            return res.json({ status: false, message: "securityId, exchangeSegment, interval, fromDate, toDate (epoch seconds) required" });
        }
        if (toEpochSec <= fromEpochSec) {
            return res.json({ status: false, message: "toDate must be after fromDate" });
        }

        const intradayCache = require('../helpers/intradayCandleCache');
        const instr = instrument || (exchangeSegment === 'IDX_I' ? 'INDEX' : exchangeSegment.includes('FNO') ? 'OPTIDX' : 'EQUITY');

        const data = await intradayCache.getCachedCandles(securityId, exchangeSegment, intervalMinutes, fromEpochSec, toEpochSec);

        if (data && data.timestamp.length > 0) {
            res.json({ status: true, data, cached: true, candles: data.timestamp.length });
            // Background top-up if today's tail is stale — client doesn't wait
            intradayCache.needsSync(securityId, exchangeSegment, intervalMinutes).then(needs => {
                if (needs) {
                    intradayCache.syncHistory(securityId, exchangeSegment, instr, intervalMinutes)
                        .catch(e => console.log('[IntradayCache] BG top-up error:', e.message));
                }
            }).catch(() => {});
            return;
        }

        // Nothing cached for this viewport — fetch just the viewport synchronously
        // so the response isn't empty, then background a full 180-day backfill.
        await intradayCache.syncViewport(securityId, exchangeSegment, instr, intervalMinutes, fromEpochSec, toEpochSec);
        const freshData = await intradayCache.getCachedCandles(securityId, exchangeSegment, intervalMinutes, fromEpochSec, toEpochSec);

        intradayCache.syncHistory(securityId, exchangeSegment, instr, intervalMinutes)
            .catch(e => console.log('[IntradayCache] BG backfill error:', e.message));

        if (!freshData || !freshData.timestamp.length) {
            return res.json({ status: true, data: { timestamp: [], open: [], high: [], low: [], close: [], volume: [], openInterest: [] }, cached: false, candles: 0 });
        }
        return res.json({ status: true, data: freshData, cached: false, candles: freshData.timestamp.length });

    } catch (error) {
        console.log("CACHED INTRADAY ERROR:", error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ── Clear & Re-sync intraday cache for one security+interval ─────────────────
exports.resyncIntradayCache = async (req, res) => {
    try {
        const { securityId, exchangeSegment, instrument, interval } = req.body;
        const intervalMinutes = parseInt(interval, 10);
        if (!securityId || !exchangeSegment || !intervalMinutes) {
            return res.json({ status: false, message: 'securityId, exchangeSegment, interval required' });
        }

        const intradayCache = require('../helpers/intradayCandleCache');
        const instr = instrument || (exchangeSegment === 'IDX_I' ? 'INDEX' : 'EQUITY');
        const result = await intradayCache.resyncHistory(securityId, exchangeSegment, instr, intervalMinutes);
        return res.json({ status: true, message: `Re-synced ${result.stats?.recordsUpserted ?? 0} candles`, data: result });
    } catch (e) {
        return res.json({ status: false, message: e.message });
    }
};

// ── Historical Chart Data ─────────────────────────────────────────────────────
exports.getHistoricalData = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const {
            securityId,
            exchangeSegment,
            instrument,
            expiryCode = 0,
            oi = false,
            fromDate,
            toDate
        } = req.body;

        if (!securityId || !exchangeSegment || !fromDate || !toDate) {
            return res.json({ status: false, message: "securityId, exchangeSegment, fromDate, toDate are required" });
        }

        // Use the SELF market token (always fresh, same as live price WebSocket)
        const selfAuth = await _getSelfToken();
        if (!selfAuth) {
            return res.json({ status: false, message: "Market token not available" });
        }

        const response = await axios.post(
            "https://api.dhan.co/v2/charts/historical",
            { securityId, exchangeSegment, instrument: instrument || "EQUITY", expiryCode, oi, fromDate, toDate },
            {
                headers: {
                    "access-token": selfAuth.token,
                    "client-id": selfAuth.clientId,
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                }
            }
        );

        return res.json({ status: true, data: response.data });

    } catch (error) {
        const dhanError = error.response?.data || error.message;
        console.log("HISTORICAL DATA ERROR:", JSON.stringify(dhanError));
        return res.json({ status: false, message: dhanError });
    }
};


// ── Intraday Chart Data ───────────────────────────────────────────────────────
exports.getIntradayData = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const {
            securityId,
            exchangeSegment,
            instrument,
            interval = "1",
            oi = false,
            fromDate,
            toDate
        } = req.body;

        if (!securityId || !exchangeSegment || !fromDate || !toDate) {
            return res.json({ status: false, message: "securityId, exchangeSegment, fromDate, toDate are required" });
        }

        // Use the SELF market token (always fresh, same as live price WebSocket)
        const selfAuth = await _getSelfToken();
        if (!selfAuth) {
            return res.json({ status: false, message: "Market token not available" });
        }

        const response = await axios.post(
            "https://api.dhan.co/v2/charts/intraday",
            { securityId, exchangeSegment, instrument: instrument || "EQUITY", interval, oi, fromDate, toDate },
            {
                headers: {
                    "access-token": selfAuth.token,
                    "client-id": selfAuth.clientId,
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                }
            }
        );

        return res.json({ status: true, data: response.data });

    } catch (error) {
        const dhanError = error.response?.data || error.message;
        console.log("INTRADAY DATA ERROR:", JSON.stringify(dhanError));
        return res.json({ status: false, message: dhanError });
    }
};


// ── Option Chain ──────────────────────────────────────────────────────────────
exports.getOptionChain = async (req, res) => {
    try {
        const { UnderlyingScrip, UnderlyingSeg, Expiry, dhanAccessToken } = req.body;

        if (!UnderlyingScrip || !UnderlyingSeg || !Expiry) {
            return res.json({ status: false, message: "UnderlyingScrip, UnderlyingSeg, Expiry are required" });
        }

        if (instrumentStatus.isExpiryPassed(Expiry)) {
            return res.json({ status: false, message: `The ${Expiry} expiry has expired. Please pick a current expiry.` });
        }

        // Use SELF market token (same as live price feed); fall back to client-provided token
        const selfAuth = await _getSelfToken();
        const token    = selfAuth?.token || dhanAccessToken;
        const clientId = selfAuth?.clientId || req.user?.dhanClientId;

        if (!token) {
            return res.json({ status: false, message: "Market token not available" });
        }

        const response = await axios.post(
            "https://api.dhan.co/v2/optionchain",
            { UnderlyingScrip, UnderlyingSeg, Expiry },
            {
                headers: {
                    "access-token": token,
                    "client-id": clientId,
                    "Content-Type": "application/json"
                }
            }
        );

        const ocData  = response.data?.data || response.data;
        const lastPrice = ocData?.last_price || 0;
        const oc      = ocData?.oc || {};

        // ── Debug: full raw strike range as returned by Dhan itself ─────────
        const rawStrikes = Object.keys(oc).map(k => parseFloat(k)).sort((a, b) => a - b);
        let atmStrike = null;
        if (lastPrice > 0 && rawStrikes.length > 0) {
            let minDiff = Infinity;
            rawStrikes.forEach((s) => {
                const diff = Math.abs(s - lastPrice);
                if (diff < minDiff) { minDiff = diff; atmStrike = s; }
            });
        }
        console.log(`[OptionChainRangeDebug] Underlying=${UnderlyingScrip} Expiry=${Expiry} ` +
            `lastPrice=${lastPrice} atmStrike=${atmStrike} ` +
            `rawStrikeCount=${rawStrikes.length} rawFirst=${rawStrikes[0]} rawLast=${rawStrikes[rawStrikes.length - 1]} ` +
            `displayedStrikeCount=${rawStrikes.length} displayedFirst=${rawStrikes[0]} displayedLast=${rawStrikes[rawStrikes.length - 1]}`);

        // NOTE: this endpoint previously truncated the response to ATM ± 15
        // strikes ("filteredOc"). Removed — the client must receive the
        // complete strike chain Dhan returns for the selected expiry and
        // scroll through it in full; ATM is used client-side only for
        // highlighting/positioning, never for removing strikes from the data.
        return res.json({
            status: true,
            data: {
                data: { last_price: lastPrice, oc },
                status: "success"
            }
        });

    } catch (error) {
        const errData = error.response?.data;
        const errMsg = typeof errData === 'string' ? errData
            : errData?.errorMessage || errData?.message || JSON.stringify(errData) || error.message;
        console.log("OPTION CHAIN ERROR:", errMsg);
        return res.json({ status: false, message: errMsg });
    }
};

// ── Option Detail (for the option-detail bottom sheet) ───────────────────────
// Dhan's option-chain response (getOptionChain above) only carries last_price,
// oi, previous_close_price, average_price, volume and a single top-of-book
// bid/ask level. This calls Dhan's full Market Quote API
// (POST /v2/marketfeed/quote) instead, which additionally returns real
// OHLC (so day high/low + open are genuine, not invented), last traded
// qty/time, upper/lower circuit limits, and 5-level market depth with an
// orders count per level — none of which exist in the option-chain payload.
// One request fetches BOTH the option leg and (optionally) the underlying,
// batched by exchange segment, since Dhan's quote API accepts multiple
// segments/security IDs in a single call (documented limit: 1000
// instruments/request, 1 request/sec) — reused via the same SELF token
// pattern as getOptionChain/getMarketData, not a new auth path.
exports.getOptionDetail = async (req, res) => {
    try {
        const { securityId, exchangeSegment, underlyingSecurityId, underlyingExchangeSegment } = req.body;

        if (!securityId || !exchangeSegment) {
            return res.json({ status: false, message: "securityId and exchangeSegment are required" });
        }

        const selfAuth = await _getSelfToken();
        if (!selfAuth) {
            return res.json({ status: false, message: "Market token not configured. Generate it via /dhan/generate-market-token." });
        }

        const hdrs = {
            "access-token": selfAuth.token,
            "client-id":    selfAuth.clientId,
            "Accept":       "application/json",
            "Content-Type": "application/json",
        };

        const secIdNum = parseInt(securityId, 10);
        const body = { [exchangeSegment]: [secIdNum] };

        const hasUnderlying = underlyingSecurityId && underlyingExchangeSegment;
        const underlyingIdNum = hasUnderlying ? parseInt(underlyingSecurityId, 10) : null;
        if (hasUnderlying) {
            body[underlyingExchangeSegment] = body[underlyingExchangeSegment] || [];
            if (!body[underlyingExchangeSegment].includes(underlyingIdNum)) {
                body[underlyingExchangeSegment].push(underlyingIdNum);
            }
        }

        const qResp = await axios.post("https://api.dhan.co/v2/marketfeed/quote", body,
            { headers: hdrs, timeout: 15000 });

        const data = qResp.data?.data || qResp.data || {};
        const legQuote = data[exchangeSegment]?.[String(secIdNum)] || null;

        if (!legQuote) {
            return res.json({ status: false, message: "No quote data returned for this contract" });
        }

        const ohlc = legQuote.ohlc || {};
        const depthRaw = legQuote.depth || {};
        const mapLevel = (l) => ({
            price:    parseFloat(l?.price ?? 0),
            quantity: parseInt(l?.quantity ?? 0, 10),
            orders:   parseInt(l?.orders ?? 0, 10),
        });

        // Dhan's quote API's `ohlc.close` is TODAY's own close (converges to
        // last_price once the session settles), NOT the prior trading day's
        // close — confirmed live via getMarketData, where this same
        // assumption made every stock compute to exactly 0% change. Derive
        // previousClose from Dhan's own `net_change` field instead.
        const legLtp = parseFloat(legQuote.last_price ?? 0);
        const legChange = parseFloat(legQuote.net_change ?? 0);
        const legPrevClose = legLtp - legChange;

        const result = {
            securityId:   String(secIdNum),
            exchangeSegment,
            ltp:                legLtp,
            previousClose:      legPrevClose,
            open:               parseFloat(ohlc.open ?? 0),
            high:               parseFloat(ohlc.high ?? 0),
            low:                parseFloat(ohlc.low ?? 0),
            volume:             parseInt(legQuote.volume ?? 0, 10),
            averagePrice:       parseFloat(legQuote.average_price ?? 0),
            lastTradedQuantity: parseInt(legQuote.last_quantity ?? 0, 10),
            lastTradedTime:     legQuote.last_trade_time || null,
            lowerCircuitLimit:  parseFloat(legQuote.lower_circuit_limit ?? 0),
            upperCircuitLimit:  parseFloat(legQuote.upper_circuit_limit ?? 0),
            openInterest:       parseInt(legQuote.oi ?? 0, 10),
            oiDayHigh:          parseInt(legQuote.oi_day_high ?? 0, 10),
            oiDayLow:           parseInt(legQuote.oi_day_low ?? 0, 10),
            depth: {
                buy:  Array.isArray(depthRaw.buy)  ? depthRaw.buy.map(mapLevel)  : [],
                sell: Array.isArray(depthRaw.sell) ? depthRaw.sell.map(mapLevel) : [],
            },
            underlying: null,
        };

        if (hasUnderlying) {
            const uQuote = data[underlyingExchangeSegment]?.[String(underlyingIdNum)] || null;
            if (uQuote) {
                const uLtp = parseFloat(uQuote.last_price ?? 0);
                const uChangeRaw = parseFloat(uQuote.net_change ?? 0);
                const uPrevClose = uLtp - uChangeRaw;
                result.underlying = {
                    securityId: String(underlyingIdNum),
                    exchangeSegment: underlyingExchangeSegment,
                    ltp: uLtp,
                    previousClose: uPrevClose,
                    change: uPrevClose > 0 ? parseFloat((uLtp - uPrevClose).toFixed(2)) : null,
                    changePercent: uPrevClose > 0 ? parseFloat((((uLtp - uPrevClose) / uPrevClose) * 100).toFixed(4)) : null,
                };
            }
        }

        return res.json({ status: true, data: result });

    } catch (error) {
        const errData = error.response?.data;
        const errMsg = typeof errData === 'string' ? errData
            : errData?.errorMessage || errData?.message || JSON.stringify(errData) || error.message;
        console.log("OPTION DETAIL ERROR:", errMsg);
        return res.json({ status: false, message: errMsg });
    }
};

// ── Option Chain Expiry List (uses SELF market token) ────────────────────────
exports.getOptionChainExpiryList = async (req, res) => {
    try {
        const { UnderlyingScrip, UnderlyingSeg } = req.body;

        if (!UnderlyingScrip || !UnderlyingSeg) {
            return res.json({ status: false, message: "UnderlyingScrip and UnderlyingSeg are required" });
        }

        const selfAuth = await _getSelfToken();
        if (!selfAuth) {
            return res.json({ status: false, message: "Market token not available" });
        }

        const response = await axios.post(
            "https://api.dhan.co/v2/optionchain/expirylist",
            { UnderlyingScrip, UnderlyingSeg },
            {
                headers: {
                    "access-token": selfAuth.token,
                    "client-id": selfAuth.clientId,
                    "Content-Type": "application/json"
                }
            }
        );

        // Only selectable (not yet expired) expiries.
        const dates = (response.data?.data || []).filter(d => !instrumentStatus.isExpiryPassed(d));
        return res.json({ status: true, data: dates });
    } catch (error) {
        const errMsg = error.response?.data?.message || error.message;
        console.log("EXPIRY LIST ERROR:", errMsg);
        return res.json({ status: false, message: errMsg });
    }
};

// ── Related F&O instruments (same underlying, nearby strikes) ─────────────────
exports.getRelatedFNO = async (req, res) => {
    try {
        const { underlyingSymbol, expiry, strike } = req.query;

        if (!underlyingSymbol) {
            return res.json({ status: false, message: "underlyingSymbol is required" });
        }

        const strikeNum = parseFloat(strike) || 0;
        const active = instrumentStatus.activeDerivativeFilter("instruments");
        const params = [...active.params, `%${underlyingSymbol}%`];
        let extra = '';
        if (expiry) { extra += ' AND DATE(sm_expiry_date) = ?'; params.push(String(expiry)); }
        if (strike) { extra += ' AND ABS(strike_price - ?) <= 500'; params.push(strikeNum); }
        params.push(strikeNum);

        const rows = await dbcon.query(
            constants.vals.defaultDB,
            `SELECT security_id, display_name, segment, exch_id, lot_size,
                    strike_price, option_type, sm_expiry_date
             FROM instruments
             WHERE ${active.sql}
               AND display_name LIKE ?
               ${extra}
             ORDER BY ABS(strike_price - ?) ASC, option_type ASC
             LIMIT 6`,
            params
        );

        const formatted = (rows || []).map(item => ({
            securityId: item.security_id,
            name: item.display_name,
            exchangeSegment: getExchangeSegment(item.exch_id, item.segment),
            exchange: item.exch_id,
            lotSize: item.lot_size,
            strikePrice: item.strike_price,
            optionType: item.option_type,
            expiry: item.sm_expiry_date,
        }));

        return res.json({ status: true, data: formatted });
    } catch (error) {
        return res.json({ status: false, message: error.message });
    }
};



exports.generateMarketToken = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const { pin, totp } = req.body;

        if (!pin || !totp) {
            return res.json({ status: false, message: "pin and totp are required" });
        }

        const dhanClientId = user.dhanClientId;

        console.log(`[MarketToken] Generating token for clientId=${dhanClientId}`);

        const response = await axios.post(
            `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${dhanClientId}&pin=${pin}&totp=${totp}`,
            {},
            { headers: { 'Content-Type': 'application/json' } }
        );

        const accessToken = response.data?.accessToken || response.data?.access_token || response.data;

        if (!accessToken || typeof accessToken !== 'string') {
            console.log('[MarketToken] Unexpected response:', response.data);
            return res.json({ status: false, message: "Failed to get access token from Dhan" });
        }

        // Store in market_data_tokens table (upsert)
        const existing = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            'market_data_tokens',
            `WHERE dhan_client_id = '${dhanClientId}'`
        );

        if (existing && !Array.isArray(existing) && existing.id) {
            await query.updateRecord(
                constants.vals.defaultDB,
                'market_data_tokens',
                `dhan_client_id = '${dhanClientId}'`,
                `access_token = '${accessToken}', updated_at = NOW()`
            );
        } else {
            await query.insertSingle(constants.vals.defaultDB, 'market_data_tokens', {
                dhan_client_id: dhanClientId,
                access_token: accessToken,
            });
        }

        console.log(`[MarketToken] ✅ Token stored for clientId=${dhanClientId} len=${accessToken.length}`);

        return res.json({
            status: true,
            message: "Market data token generated and saved successfully",
            data: { tokenLength: accessToken.length }
        });

    } catch (error) {
        console.log('[MarketToken] Error:', error.response?.data || error.message);
        return res.json({
            status: false,
            message: error.response?.data?.message || error.response?.data || error.message
        });
    }
};

// ── GET /dhan/lot-size?securityId=72310 ──────────────────────────────────────
// Returns the lot size for a given security from the instruments table.
exports.getLotSize = async (req, res) => {
    try {
        const { securityId } = req.query;
        if (!securityId) return res.json({ status: false, message: 'securityId required' });

        const row = await dbcon.query(
            constants.vals.defaultDB,
            `SELECT lot_size FROM instruments WHERE security_id = ? LIMIT 1`,
            [securityId]
        );

        const lotSize = (Array.isArray(row) && row.length > 0)
            ? Number(row[0].lot_size || 1)
            : 1;

        return res.json({ status: true, data: { lotSize } });
    } catch (e) {
        console.log('[LotSize] ERROR:', e.message);
        return res.json({ status: false, message: e.message });
    }
};


// ── Market Data: Top Gainers, Top Losers, NIFTY 50, BANKNIFTY ────────────────
// In-memory cache (30-second TTL — market data changes fast but requests are frequent)
const _mCache = { data: null, ts: 0 };
const _mCacheTTL = 30 * 1000;

// ── Movers DB fallback ────────────────────────────────────────────────────────
// Dhan's live quote feed is built for market hours — once the session ends
// it stops returning usable data and topGainers/topLosers would otherwise
// just go empty with no explanation. Every successful live computation is
// persisted here; when the live fetch comes back empty, the last persisted
// snapshot is served instead (tagged `stale: true` + `asOf`) rather than
// showing nothing. Table is created manually (see migrations) — this file
// only reads/writes it, never creates it.
const MOVERS_TABLE = 'market_movers_snapshot';

async function _saveMoversSnapshot(topGainers, topLosers) {
    try {
        const now = new Date();
        const rows = [
            ...topGainers.map((s, i) => ({ ...s, type: 'GAINER', rank_order: i })),
            ...topLosers.map((s, i) => ({ ...s, type: 'LOSER', rank_order: i })),
        ];
        if (!rows.length) return;

        // Small table (top 20 + top 20) — replace wholesale rather than
        // accumulating history, this is a "last known good" cache, not an
        // archive. Delete-then-insert is fine here: a reader hitting the
        // brief gap just falls through to the live path same as any other
        // empty-result case, no real consequence.
        await dbcon.query(constants.vals.defaultDB, `DELETE FROM ${MOVERS_TABLE}`, []);
        for (const r of rows) {
            await dbcon.query(
                constants.vals.defaultDB,
                `INSERT INTO ${MOVERS_TABLE}
                 (type, rank_order, security_id, symbol, exchange_segment, instrument_type,
                  indices_json, ltp, previous_close, change_val, change_percent, volume, snapshot_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    r.type, r.rank_order, r.securityId, r.symbol, r.exchangeSegment, r.instrumentType,
                    JSON.stringify(r.indices || []), r.ltp, r.previousClose, r.change, r.changePercent,
                    r.volume || 0, now,
                ]
            );
        }
    } catch (e) {
        console.error('[MarketData] Snapshot save failed:', e.message);
    }
}

async function _loadMoversSnapshot() {
    try {
        const rows = await dbcon.query(
            constants.vals.defaultDB,
            `SELECT * FROM ${MOVERS_TABLE} ORDER BY type, rank_order`,
            []
        );
        if (!rows || !rows.length) return null;

        const toItem = (r) => ({
            securityId:       r.security_id,
            symbol:           r.symbol,
            exchangeSegment:  r.exchange_segment,
            instrumentType:   r.instrument_type,
            indices:          JSON.parse(r.indices_json || '[]'),
            ltp:              parseFloat(r.ltp),
            previousClose:    parseFloat(r.previous_close),
            change:           parseFloat(r.change_val),
            changePercent:    parseFloat(r.change_percent),
            volume:           Number(r.volume),
            tradingSymbol:    r.symbol,
            lastTradedPrice:  parseFloat(r.ltp),
            percentageChange: parseFloat(r.change_percent),
        });

        return {
            topGainers: rows.filter(r => r.type === 'GAINER').map(toItem),
            topLosers:  rows.filter(r => r.type === 'LOSER').map(toItem),
            asOf: rows[0].snapshot_at,
        };
    } catch (e) {
        console.error('[MarketData] Snapshot load failed:', e.message);
        return null;
    }
}

// NSE_EQ instrument master cache — refreshed every 4 hours
const _eqCache = { map: null, reverseMap: null, ts: 0 };
const _eqCacheTTL = 4 * 60 * 60 * 1000;

// NIFTY50 + BANKNIFTY constituent cache — refreshed every 24 hours
const _indexCache = { secIds: null, indices: null, ts: 0 };
const _indexCacheTTL = 24 * 60 * 60 * 1000;

function _prevTradingDayStr(now) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    if (d.getDay() === 0) d.setDate(d.getDate() - 2); // Sunday → Friday
    if (d.getDay() === 6) d.setDate(d.getDate() - 1); // Saturday → Friday
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

exports.getMarketData = async (req, res) => {
    try {
        // Serve from cache if still fresh
        if (_mCache.data && (Date.now() - _mCache.ts) < _mCacheTTL) {
            return res.json({ status: true, data: _mCache.data, cached: true });
        }

        const selfAuth = await _getSelfToken();
        if (!selfAuth) {
            return res.json({ status: false, message: "Market token not configured. Generate it via /dhan/generate-market-token." });
        }

        const hdrs = {
            "access-token": selfAuth.token,
            "client-id":    selfAuth.clientId,
            "Accept":       "application/json",
            "Content-Type": "application/json",
        };

        const now     = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const fromIntra = `${todayStr} 09:15:00`;
        const toIntra   = `${todayStr} 15:30:00`;
        const prevDay   = _prevTradingDayStr(now);

        // ── Step 1: Load NSE_EQ instrument master → build symbol↔secId maps ──────
        // Cached 4 hours. Builds both forward (secId→ticker) and reverse (ticker→secId) maps.
        let secIdToSymbol = {}, symbolToSecId = {};

        if (_eqCache.map && (Date.now() - _eqCache.ts) < _eqCacheTTL) {
            secIdToSymbol = _eqCache.map;
            symbolToSecId = _eqCache.reverseMap;
            console.log('[MarketData] Using cached NSE_EQ instrument master:', Object.keys(secIdToSymbol).length, 'stocks');
        } else {
            console.log('[MarketData] Loading NSE_EQ instrument master...');
            try {
                const csvStream = require('stream');
                const csvParser = require('csv-parser');

                const instResp = await axios.get("https://api.dhan.co/v2/instrument/NSE_EQ", {
                    responseType: 'arraybuffer',
                    timeout: 20000,
                });

                const newMap = {}, newRevMap = {};
                await new Promise((resolve, reject) => {
                    const passThrough = new csvStream.PassThrough();
                    passThrough.end(instResp.data);
                    const seenIds = new Set(), seenSyms = new Set();
                    let total = 0, skipped = 0;

                    passThrough.pipe(csvParser())
                        .on('data', (row) => {
                            total++;
                            const secId    = (row.SECURITY_ID      || '').trim();
                            const seg      = (row.SEGMENT           || '').trim(); // 'E' in NSE_EQ CSV
                            const inst     = (row.INSTRUMENT        || '').trim(); // 'EQUITY'
                            const instType = (row.INSTRUMENT_TYPE   || '').trim(); // 'ES'=equity stock
                            const series   = (row.SERIES            || '').trim(); // 'EQ'=mainboard
                            const ticker   = (row.UNDERLYING_SYMBOL || '').trim(); // NSE ticker symbol

                            // Mainboard equity only: seg='E', inst='EQUITY', instType='ES', series='EQ'
                            if (!secId || seg !== 'E' || inst !== 'EQUITY' || instType !== 'ES' || series !== 'EQ') { skipped++; return; }
                            if (!ticker || seenIds.has(secId) || seenSyms.has(ticker)) { skipped++; return; }

                            seenIds.add(secId); seenSyms.add(ticker);
                            newMap[secId]     = ticker;
                            newRevMap[ticker] = secId;
                        })
                        .on('end', () => {
                            console.log(`[MarketData] NSE_EQ instruments loaded: ${total} rows | Valid EQUITY: ${Object.keys(newMap).length} | Skipped: ${skipped}`);
                            resolve();
                        })
                        .on('error', reject);
                });

                if (Object.keys(newMap).length > 0) {
                    _eqCache.map        = newMap;
                    _eqCache.reverseMap = newRevMap;
                    _eqCache.ts         = Date.now();
                    secIdToSymbol = newMap;
                    symbolToSecId = newRevMap;
                } else if (_eqCache.map) {
                    console.warn('[MarketData] Instrument fetch returned 0 records, using stale cache');
                    secIdToSymbol = _eqCache.map;
                    symbolToSecId = _eqCache.reverseMap || {};
                }
            } catch (instErr) {
                console.error('[MarketData] Instrument master fetch failed:', instErr.message);
                if (_eqCache.map) {
                    console.warn('[MarketData] Using stale instrument cache as fallback');
                    secIdToSymbol = _eqCache.map;
                    symbolToSecId = _eqCache.reverseMap || {};
                }
            }
        }

        // ── Step 2: Fetch NIFTY50 + BANKNIFTY constituents (cached 24 hours) ──────
        // NSE publishes current constituent lists at archives.nseindia.com.
        // We map those ticker symbols to NSE_EQ Security IDs via the instrument master.
        let constituentSecIds = [];   // deduped NSE_EQ secIds for the universe
        let secIdToIndices    = {};   // { "1333": ["NIFTY50", "BANKNIFTY"] }

        if (_indexCache.secIds && (Date.now() - _indexCache.ts) < _indexCacheTTL) {
            constituentSecIds = _indexCache.secIds;
            secIdToIndices    = _indexCache.indices;
            console.log('[MarketData] Using cached index constituents:', constituentSecIds.length, 'unique stocks');
        } else {
            console.log('[MarketData] Loading NIFTY50 + BANKNIFTY constituents...');

            const _fetchConstituents = async (url, indexName) => {
                const csvStream = require('stream');
                const csvParser = require('csv-parser');
                const r = await axios.get(url, {
                    responseType: 'arraybuffer', timeout: 15000,
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                });
                const symbols = [];
                await new Promise((res, rej) => {
                    const p = new csvStream.PassThrough();
                    p.end(r.data);
                    p.pipe(csvParser()).on('data', row => {
                        const sym = (row['Symbol'] || row['SYMBOL'] || '').trim();
                        if (sym) symbols.push(sym);
                    }).on('end', res).on('error', rej);
                });
                console.log(`[MarketData] ${indexName} constituents: ${symbols.length}`);
                return symbols;
            };

            try {
                const [n50, bn] = await Promise.all([
                    _fetchConstituents('https://archives.nseindia.com/content/indices/ind_nifty50list.csv',  'NIFTY50'),
                    _fetchConstituents('https://archives.nseindia.com/content/indices/ind_niftybanklist.csv', 'BANKNIFTY'),
                ]);

                const newSecIdToIndices = {};
                const _addSymbols = (symbols, idxName) => {
                    for (const sym of symbols) {
                        const secId = symbolToSecId[sym];
                        if (!secId) { console.warn(`[MarketData] Missing NSE_EQ mapping: ${sym} (${idxName})`); continue; }
                        if (!newSecIdToIndices[secId]) newSecIdToIndices[secId] = [];
                        if (!newSecIdToIndices[secId].includes(idxName)) newSecIdToIndices[secId].push(idxName);
                    }
                };
                _addSymbols(n50, 'NIFTY50');
                _addSymbols(bn,  'BANKNIFTY');

                const newSecIds = Object.keys(newSecIdToIndices);
                console.log(`[MarketData] Combined unique constituents: ${newSecIds.length}`);
                console.log(`[MarketData] NSE_EQ Security IDs matched: ${newSecIds.length}`);
                console.log(`[MarketData] Missing NSE_EQ mappings: ${(n50.length + bn.length) - newSecIds.length - (bn.filter(s => n50.includes(s)).length)}`);

                if (newSecIds.length > 0) {
                    _indexCache.secIds  = newSecIds;
                    _indexCache.indices = newSecIdToIndices;
                    _indexCache.ts      = Date.now();
                    constituentSecIds = newSecIds;
                    secIdToIndices    = newSecIdToIndices;
                } else if (_indexCache.secIds) {
                    console.warn('[MarketData] Index constituent fetch returned 0, using stale cache');
                    constituentSecIds = _indexCache.secIds;
                    secIdToIndices    = _indexCache.indices;
                }
            } catch (idxErr) {
                console.error('[MarketData] Index constituent fetch failed:', idxErr.message);
                if (_indexCache.secIds) {
                    console.warn('[MarketData] Using stale index cache as fallback');
                    constituentSecIds = _indexCache.secIds;
                    secIdToIndices    = _indexCache.indices;
                }
            }
        }

        console.log('[MarketData] Unique Security IDs in universe:', constituentSecIds.length);

        // ── Step 3: Index intraday + historical (parallel with quote below) ──
        const [niftyIntra, bnIntra, niftyHist, bnHist] = await Promise.all([
            axios.post("https://api.dhan.co/v2/charts/intraday",
                { securityId: "13", exchangeSegment: "IDX_I", instrument: "INDEX", interval: "5", oi: false, fromDate: fromIntra, toDate: toIntra },
                { headers: hdrs, timeout: 12000 }).catch(e => ({ status: 'rejected', reason: e })),
            axios.post("https://api.dhan.co/v2/charts/intraday",
                { securityId: "25", exchangeSegment: "IDX_I", instrument: "INDEX", interval: "5", oi: false, fromDate: fromIntra, toDate: toIntra },
                { headers: hdrs, timeout: 12000 }).catch(e => ({ status: 'rejected', reason: e })),
            axios.post("https://api.dhan.co/v2/charts/historical",
                { securityId: "13", exchangeSegment: "IDX_I", instrument: "INDEX", expiryCode: 0, oi: false, fromDate: prevDay, toDate: prevDay },
                { headers: hdrs, timeout: 12000 }).catch(e => ({ status: 'rejected', reason: e })),
            axios.post("https://api.dhan.co/v2/charts/historical",
                { securityId: "25", exchangeSegment: "IDX_I", instrument: "INDEX", expiryCode: 0, oi: false, fromDate: prevDay, toDate: prevDay },
                { headers: hdrs, timeout: 12000 }).catch(e => ({ status: 'rejected', reason: e })),
        ]);
        const _wrap = (r) => r?.status === 'rejected' ? r : { status: 'fulfilled', value: r };
        const [ni, bni, nh, bnh] = [_wrap(niftyIntra), _wrap(bnIntra), _wrap(niftyHist), _wrap(bnHist)];

        // ── Step 4: Market quote — single request for the ~62-stock universe ──
        // All NIFTY50 + BANKNIFTY constituents fit in one request (far under 1000 limit).
        let topGainers = [], topLosers = [];
        // Surfaced to the client instead of silently returning an empty
        // list on a quote-fetch failure (e.g. an expired shared Dhan
        // market-data token) — previously indistinguishable from "market
        // genuinely has no movers right now".
        let moversError = '';

        if (constituentSecIds.length > 0) {
            try {
                const quoteIds = constituentSecIds.map(id => parseInt(id, 10));
                console.log(`[MarketData] Market quote: ${quoteIds.length} instruments`);

                const qResp = await axios.post("https://api.dhan.co/v2/marketfeed/quote",
                    { "NSE_EQ": quoteIds },
                    { headers: hdrs, timeout: 20000 });

                const quoteData = qResp.data?.data?.["NSE_EQ"]
                               || qResp.data?.["NSE_EQ"]
                               || {};

                console.log('[MarketData] Market quote records:', Object.keys(quoteData).length);

                const valid = [];
                for (const [secId, q] of Object.entries(quoteData)) {
                    const sym     = secIdToSymbol[secId] || '';
                    const indices = secIdToIndices[secId] || [];
                    // Only accept confirmed constituents with valid equity mapping
                    if (!secId || !sym || indices.length === 0) continue;
                    const ltp = parseFloat(q.last_price || 0);
                    // Dhan's quote API's `ohlc.close` is TODAY's own close
                    // (it converges to last_price once the session settles)
                    // — NOT yesterday's close, despite the field name.
                    // Confirmed live: ohlc.close === last_price for every
                    // instrument once market hours end, which made every
                    // stock compute to exactly 0% change. Dhan already
                    // computes the real day-over-day delta itself as
                    // `net_change` — derive prevClose from that instead of
                    // re-deriving it from the wrong field.
                    const change    = parseFloat(q.net_change || 0);
                    const prevClose = ltp - change;
                    if (ltp <= 0 || prevClose <= 0) continue;
                    const changePct = (change / prevClose) * 100;
                    if (!isFinite(changePct)) continue;
                    if (Math.abs(changePct) > 75) continue;           // sanity filter
                    const volume = parseFloat(q.volume || 0);

                    valid.push({
                        securityId:      secId,
                        symbol:          sym,
                        exchangeSegment: 'NSE_EQ',
                        instrumentType:  'EQUITY',
                        indices,
                        ltp:             parseFloat(ltp.toFixed(2)),
                        previousClose:   parseFloat(prevClose.toFixed(2)),
                        change:          parseFloat(change.toFixed(2)),
                        changePercent:   parseFloat(changePct.toFixed(4)),
                        volume,
                        // Legacy fields for Flutter backward-compat
                        tradingSymbol:    sym,
                        lastTradedPrice:  parseFloat(ltp.toFixed(2)),
                        percentageChange: parseFloat(changePct.toFixed(2)),
                    });
                }

                console.log('[MarketData] Valid eligible stocks:', valid.length);
                valid.sort((a, b) => b.changePercent - a.changePercent);
                topGainers = valid.filter(s => s.changePercent > 0).slice(0, 20);
                topLosers  = valid.filter(s => s.changePercent < 0).slice(-20).reverse();
                console.log('[MarketData] Top gainers:', topGainers.length, '| Top losers:', topLosers.length);
            } catch (qErr) {
                const e = qErr.response?.data || qErr.message;
                console.error('[MarketData] Market quote error:', JSON.stringify(e));
                moversError = typeof e === 'object' ? JSON.stringify(e) : String(e);
            }
        }

        // ── Helper: extract OHLC from intraday candle arrays ────────────────
        function extractIntra(result) {
            if (result.status !== 'fulfilled') return null;
            const d = result.value?.data;
            if (!d?.open?.length) return null;
            return {
                open: d.open[0],
                high: Math.max(...d.high),
                low:  Math.min(...d.low),
                ltp:  d.close[d.close.length - 1],
            };
        }

        // ── Helper: extract prev-close from daily historical ─────────────────
        function extractPrevClose(result) {
            if (result.status !== 'fulfilled') return null;
            const d = result.value?.data;
            if (!d?.close?.length) return null;
            return d.close[d.close.length - 1];
        }

        function buildIndex(symbol, secId, intraResult, histResult) {
            const ohlc = extractIntra(intraResult);
            const pc   = extractPrevClose(histResult);
            if (!ohlc) return null;
            const change    = pc ? ohlc.ltp - pc : 0;
            const changePct = pc ? (change / pc) * 100 : 0;
            return {
                securityId: secId,
                symbol,
                ltp:       ohlc.ltp,
                open:      ohlc.open,
                high:      ohlc.high,
                low:       ohlc.low,
                prevClose: pc || 0,
                change:    parseFloat(change.toFixed(2)),
                changePct: parseFloat(changePct.toFixed(2)),
            };
        }

        let stale = false;
        let asOf = null;
        if (topGainers.length > 0 || topLosers.length > 0) {
            // Fire-and-forget — never delays the response for a cache write.
            _saveMoversSnapshot(topGainers, topLosers);
        } else {
            // Live feed came back empty (market closed, token issue, etc.)
            // — fall back to the last time it didn't, instead of showing
            // nothing. Honest about it via `stale`/`asOf` rather than
            // pretending this is live.
            const snapshot = await _loadMoversSnapshot();
            if (snapshot) {
                topGainers = snapshot.topGainers;
                topLosers = snapshot.topLosers;
                stale = true;
                asOf = snapshot.asOf;
            }
        }

        const data = {
            topGainers,
            topLosers,
            moversError,
            stale,
            asOf,
            nifty50:   buildIndex('NIFTY 50',  '13', ni,  nh),
            bankNifty: buildIndex('BANKNIFTY',  '25', bni, bnh),
        };

        _mCache.data = data;
        _mCache.ts   = Date.now();

        return res.json({ status: true, data });

    } catch (error) {
        const errMsg = error.response?.data || error.message;
        console.error('[MarketData] ERROR:', JSON.stringify(errMsg));
        return res.status(500).json({ status: false, message: typeof errMsg === 'object' ? JSON.stringify(errMsg) : errMsg });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Technical Indicator Math Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _techSma(arr, period) {
    if (arr.length < period) return null;
    const slice = arr.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

function _techEma(arr, period) {
    if (arr.length < period) return null;
    const k = 2 / (period + 1);
    let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
    return ema;
}

function _techRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    const src = closes.slice(-(period + 60));
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const d = src[i] - src[i - 1];
        if (d >= 0) avgGain += d; else avgLoss += Math.abs(d);
    }
    avgGain /= period;
    avgLoss /= period;
    for (let i = period + 1; i < src.length; i++) {
        const d = src[i] - src[i - 1];
        avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}

function _techStoch(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
    if (closes.length < kPeriod) return { k: null };
    const kVals = [];
    for (let i = kPeriod - 1; i < closes.length; i++) {
        const hMax = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
        const lMin = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
        kVals.push(hMax === lMin ? 50 : ((closes[i] - lMin) / (hMax - lMin)) * 100);
    }
    const smoothK = kVals.length >= dPeriod
        ? kVals.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod
        : kVals[kVals.length - 1];
    return { k: smoothK };
}

function _techCCI(highs, lows, closes, period = 20) {
    if (closes.length < period) return null;
    const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
    const slice = tp.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const dev  = slice.reduce((acc, v) => acc + Math.abs(v - mean), 0) / period;
    return dev === 0 ? 0 : (tp[tp.length - 1] - mean) / (0.015 * dev);
}

function _techWilliamsR(highs, lows, closes, period = 14) {
    if (closes.length < period) return null;
    const hMax = Math.max(...highs.slice(-period));
    const lMin = Math.min(...lows.slice(-period));
    return hMax === lMin ? -50 : ((hMax - closes[closes.length - 1]) / (hMax - lMin)) * -100;
}

function _techMACD(closes, fast = 12, slow = 26, sigPeriod = 9) {
    if (closes.length < slow + sigPeriod) return { macd: null, signal: null };
    const macdSeries = [];
    for (let i = slow - 1; i < closes.length; i++) {
        const fe = _techEma(closes.slice(0, i + 1), fast);
        const se = _techEma(closes.slice(0, i + 1), slow);
        if (fe != null && se != null) macdSeries.push(fe - se);
    }
    const signalVal = macdSeries.length >= sigPeriod ? _techEma(macdSeries, sigPeriod) : null;
    return { macd: macdSeries[macdSeries.length - 1] ?? null, signal: signalVal };
}

function _techADX(highs, lows, closes, period = 14) {
    if (closes.length < period * 2) return { adx: null, diPlus: null, diMinus: null };
    const tr = [], dmP = [], dmM = [];
    for (let i = 1; i < closes.length; i++) {
        tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
        const up = highs[i] - highs[i-1], dn = lows[i-1] - lows[i];
        dmP.push(up > dn && up > 0 ? up : 0);
        dmM.push(dn > up && dn > 0 ? dn : 0);
    }
    let atr = tr.slice(0, period).reduce((a,b)=>a+b,0);
    let sdP = dmP.slice(0, period).reduce((a,b)=>a+b,0);
    let sdM = dmM.slice(0, period).reduce((a,b)=>a+b,0);
    for (let i = period; i < tr.length; i++) {
        atr = atr - atr/period + tr[i];
        sdP = sdP - sdP/period + dmP[i];
        sdM = sdM - sdM/period + dmM[i];
    }
    if (atr === 0) return { adx: 0, diPlus: 0, diMinus: 0 };
    const diP = (sdP / atr) * 100, diM = (sdM / atr) * 100;
    const adx = Math.abs(diP - diM) / (diP + diM) * 100;
    return { adx, diPlus: diP, diMinus: diM };
}

function _techBB(closes, period = 20, mult = 2) {
    if (closes.length < period) return { upper: null, middle: null, lower: null };
    const slice = closes.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std  = Math.sqrt(slice.reduce((acc, c) => acc + Math.pow(c - mean, 2), 0) / period);
    return { upper: mean + mult * std, middle: mean, lower: mean - mult * std };
}

function _techVWAP(candles, lookback = 20) {
    const src = candles.slice(-lookback);
    let sumPV = 0, sumV = 0;
    for (const c of src) {
        const tp = (c.high + c.low + c.close) / 3;
        sumPV += tp * c.volume;
        sumV  += c.volume;
    }
    return sumV === 0 ? null : sumPV / sumV;
}

function _techPivots(h, l, c) {
    const pp = (h + l + c) / 3;
    return {
        pp,
        r1: 2*pp - l,   r2: pp + (h-l),   r3: h + 2*(pp-l),
        s1: 2*pp - h,   s2: pp - (h-l),   s3: l - 2*(h-pp),
        fibR1: pp + 0.382*(h-l), fibR2: pp + 0.618*(h-l), fibR3: pp + (h-l),
        fibS1: pp - 0.382*(h-l), fibS2: pp - 0.618*(h-l), fibS3: pp - (h-l),
    };
}

function _fmtNum(n) {
    if (n == null || isNaN(n)) return 'N/A';
    return parseFloat(n.toFixed(2)).toLocaleString('en-IN');
}

// ─────────────────────────────────────────────────────────────────────────────
// Technical Indicators Endpoint
// ─────────────────────────────────────────────────────────────────────────────
exports.getTechnicalIndicators = async (req, res) => {
    try {
        const { securityId, exchangeSegment, instrument } = req.body || {};
        if (!securityId) return res.json({ success: false, message: 'securityId required' });

        const histCache = require('../helpers/historicalCache');
        const needsSync = await histCache.needsSync(securityId);
        if (needsSync) {
            const instr = instrument || (exchangeSegment === 'IDX_I' ? 'INDEX' : (exchangeSegment || '').includes('FNO') ? 'OPTIDX' : 'EQUITY');
            await histCache.syncHistory(securityId, exchangeSegment || 'NSE_EQ', instr);
        }
        const cached = await histCache.getCachedCandles(securityId);
        if (!cached || !cached.close || cached.close.length < 30) {
            return res.json({ success: false, message: 'Insufficient historical data' });
        }

        const len = cached.close.length;
        const allCandles = [];
        for (let i = 0; i < len; i++) {
            allCandles.push({ time: cached.timestamp[i], open: cached.open[i], high: cached.high[i], low: cached.low[i], close: cached.close[i], volume: cached.volume[i] });
        }
        const data    = allCandles.slice(-200);
        const closes  = data.map(c => c.close);
        const highs   = data.map(c => c.high);
        const lows    = data.map(c => c.low);
        const lastClose = closes[closes.length - 1];

        // Oscillators
        const rsi   = _techRSI(closes);
        const stoch = _techStoch(highs, lows, closes);
        const cci   = _techCCI(highs, lows, closes);
        const willR = _techWilliamsR(highs, lows, closes);
        const macd  = _techMACD(closes);
        const adxR  = _techADX(highs, lows, closes);
        const mom   = closes.length >= 11 ? closes[closes.length-1] - closes[closes.length-11] : null;
        const roc   = (closes.length >= 13 && closes[closes.length-13] !== 0)
            ? ((closes[closes.length-1] - closes[closes.length-13]) / closes[closes.length-13]) * 100
            : null;

        const oscillators = [
            { name: 'Relative Strength Index (14)',  value: _fmtNum(rsi),           action: rsi == null ? 'Neutral' : rsi < 30 ? 'Buy' : rsi > 70 ? 'Sell' : 'Neutral' },
            { name: 'Stochastic %K (14, 3, 3)',      value: _fmtNum(stoch.k),        action: stoch.k == null ? 'Neutral' : stoch.k < 20 ? 'Buy' : stoch.k > 80 ? 'Sell' : 'Neutral' },
            { name: 'Commodity Channel Index (20)',   value: _fmtNum(cci),            action: cci == null ? 'Neutral' : cci < -100 ? 'Buy' : cci > 100 ? 'Sell' : 'Neutral' },
            { name: 'Williams %R (14)',               value: _fmtNum(willR),          action: willR == null ? 'Neutral' : willR < -80 ? 'Buy' : willR > -20 ? 'Sell' : 'Neutral' },
            { name: 'MACD (12, 26, 9)',               value: _fmtNum(macd.macd),      action: macd.macd == null ? 'Neutral' : (macd.signal != null && macd.macd > macd.signal) ? 'Buy' : (macd.signal != null && macd.macd < macd.signal) ? 'Sell' : 'Neutral' },
            { name: 'Average Directional Index (14)', value: _fmtNum(adxR.adx),       action: adxR.adx == null ? 'Neutral' : adxR.diPlus > adxR.diMinus ? 'Buy' : 'Sell' },
            { name: 'Momentum (10)',                  value: _fmtNum(mom),            action: mom == null ? 'Neutral' : mom > 0 ? 'Buy' : mom < 0 ? 'Sell' : 'Neutral' },
            { name: 'Rate of Change (12)',            value: roc == null ? 'N/A' : _fmtNum(roc) + '%', action: roc == null ? 'Neutral' : roc > 0 ? 'Buy' : roc < 0 ? 'Sell' : 'Neutral' },
        ];

        // Moving Averages
        const sma10  = _techSma(closes, 10);
        const sma20  = _techSma(closes, 20);
        const sma50  = _techSma(closes, 50);
        const sma200 = _techSma(closes, 200);
        const ema10  = _techEma(closes, 10);
        const ema20  = _techEma(closes, 20);
        const ema50  = _techEma(closes, 50);
        const ema200 = _techEma(closes, 200);
        const vwap   = _techVWAP(data);
        const bb     = _techBB(closes);

        const movingAverages = [
            { name: 'SMA (10)',             value: _fmtNum(sma10),   action: sma10  == null ? 'Neutral' : lastClose > sma10  ? 'Buy' : 'Sell' },
            { name: 'SMA (20)',             value: _fmtNum(sma20),   action: sma20  == null ? 'Neutral' : lastClose > sma20  ? 'Buy' : 'Sell' },
            { name: 'SMA (50)',             value: _fmtNum(sma50),   action: sma50  == null ? 'Neutral' : lastClose > sma50  ? 'Buy' : 'Sell' },
            { name: 'SMA (200)',            value: _fmtNum(sma200),  action: sma200 == null ? 'Neutral' : lastClose > sma200 ? 'Buy' : 'Sell' },
            { name: 'EMA (10)',             value: _fmtNum(ema10),   action: ema10  == null ? 'Neutral' : lastClose > ema10  ? 'Buy' : 'Sell' },
            { name: 'EMA (20)',             value: _fmtNum(ema20),   action: ema20  == null ? 'Neutral' : lastClose > ema20  ? 'Buy' : 'Sell' },
            { name: 'EMA (50)',             value: _fmtNum(ema50),   action: ema50  == null ? 'Neutral' : lastClose > ema50  ? 'Buy' : 'Sell' },
            { name: 'EMA (200)',            value: _fmtNum(ema200),  action: ema200 == null ? 'Neutral' : lastClose > ema200 ? 'Buy' : 'Sell' },
            { name: 'VWAP (20)',            value: _fmtNum(vwap),    action: vwap   == null ? 'Neutral' : lastClose > vwap   ? 'Buy' : 'Sell' },
            { name: 'Bollinger Bands (20)', value: _fmtNum(bb.middle), action: bb.lower == null ? 'Neutral' : lastClose < bb.lower ? 'Buy' : lastClose > bb.upper ? 'Sell' : 'Neutral' },
        ];

        // Pivots (based on previous candle)
        const prevC = data.length >= 2 ? data[data.length - 2] : data[data.length - 1];
        const piv   = _techPivots(prevC.high, prevC.low, prevC.close);
        const pAct  = (lvl) => lastClose > lvl ? 'Buy' : 'Sell';
        const pivots = [
            { pivot: 'R3', classic: _fmtNum(piv.r3),  fibonacci: _fmtNum(piv.fibR3), action: pAct(piv.r3)  },
            { pivot: 'R2', classic: _fmtNum(piv.r2),  fibonacci: _fmtNum(piv.fibR2), action: pAct(piv.r2)  },
            { pivot: 'R1', classic: _fmtNum(piv.r1),  fibonacci: _fmtNum(piv.fibR1), action: pAct(piv.r1)  },
            { pivot: 'PP', classic: _fmtNum(piv.pp),  fibonacci: _fmtNum(piv.pp),    action: pAct(piv.pp)  },
            { pivot: 'S1', classic: _fmtNum(piv.s1),  fibonacci: _fmtNum(piv.fibS1), action: pAct(piv.s1)  },
            { pivot: 'S2', classic: _fmtNum(piv.s2),  fibonacci: _fmtNum(piv.fibS2), action: pAct(piv.s2)  },
            { pivot: 'S3', classic: _fmtNum(piv.s3),  fibonacci: _fmtNum(piv.fibS3), action: pAct(piv.s3)  },
        ];

        const allSignals = [...oscillators, ...movingAverages];
        const buy     = allSignals.filter(s => s.action === 'Buy').length;
        const sell    = allSignals.filter(s => s.action === 'Sell').length;
        const neutral = allSignals.filter(s => s.action === 'Neutral').length;

        return res.json({ success: true, oscillators, movingAverages, pivots, summary: { buy, sell, neutral } });

    } catch (error) {
        const msg = error.response?.data || error.message;
        console.error('[TechnicalIndicators] ERROR:', msg);
        return res.status(500).json({ success: false, message: typeof msg === 'object' ? JSON.stringify(msg) : msg });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// News Headlines Endpoint — Google News RSS fallback (Dhan news requires subscription)
// ─────────────────────────────────────────────────────────────────────────────

function _parseGoogleNewsRss(xml, stockSymbol) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
        const block = m[1];

        // Extract text from a tag that may or may not use CDATA
        const getTag = (tag) => {
            const cdataRe = new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>');
            const plainRe = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>');
            const mc = block.match(cdataRe) || block.match(plainRe);
            return mc ? mc[1].trim() : '';
        };

        const decode = (s) => s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"');

        const title   = decode(getTag('title'));
        const pubDate = getTag('pubDate');
        const link    = getTag('link') || getTag('guid');
        const rawDesc = getTag('description');
        const desc    = decode(rawDesc.replace(/<[^>]+>/g, '')).trim().substring(0, 300);

        const srcMatch = block.match(/<source[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/source>/);
        const source   = (srcMatch ? srcMatch[1].trim() : '') || 'Market News';

        let timeStr = pubDate;
        try {
            const d = new Date(pubDate);
            if (!isNaN(d.getTime())) {
                timeStr = d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
            }
        } catch (_) {}

        if (title) items.push({ source, symbol: stockSymbol || '', title, time: timeStr, description: desc, url: link });
    }
    return items.slice(0, 15);
}

exports.getNewsHeadlines = async (req, res) => {
    try {
        const { securityId, symbol } = req.body || {};
        if (!securityId) return res.json({ success: false, message: 'securityId required' });

        // Build search query: use stock symbol/name for Google News RSS
        const query = encodeURIComponent(`${symbol || securityId} stock NSE`);
        const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`;

        const response = await axios.get(rssUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            },
            timeout: 10000,
            responseType: 'text',
        });

        const news = _parseGoogleNewsRss(response.data, symbol || '');
        console.log(`[NewsHeadlines] Google RSS for "${symbol}": ${news.length} items`);
        return res.json({ success: true, news });

    } catch (error) {
        const msg = error.response?.data || error.message;
        console.error('[NewsHeadlines] ERROR:', typeof msg === 'object' ? JSON.stringify(msg) : msg);
        return res.json({ success: false, news: [], message: typeof msg === 'object' ? JSON.stringify(msg) : msg });
    }
};