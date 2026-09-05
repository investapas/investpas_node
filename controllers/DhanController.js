const axios = require('axios');
const jwt = require('jsonwebtoken');
const query = require("../helpers/query");
const constants = require("../vars/constants");

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

    const tokenId = req.body.tokenId;

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
    const dhanAccessToken = dhanData.accessToken;

    const appToken = jwt.sign(
      {
        dhanClientId: dhanClientId
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.json({
      status: true,
      message: "Login successful",
      user: {
        dhanClientId,
        dhanClientName,
        dhanClientUcc: dhanData.dhanClientUcc
      },
      dhanAccessToken: dhanAccessToken,
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

exports.getPortfolio = async (req, res) => {
    try {
        const user = req.user;
        const { dhanAccessToken } = req.body;

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

        const response = await axios.get(
            "https://api.dhan.co/v2/positions",
            {
                headers: {
                    "access-token": dhanAccessToken
                }
            }
        );

        res.json({
            status: true,
            data: response.data
        });
    } catch (error) {
        console.log("DHAN PORTFOLIO ERROR:", error.response?.data || error.message);
        res.json({
            status: false,
            message: error.response?.data || error.message
        });
    }
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
        const data = await query.fetchRecords(
            constants.vals.defaultDB,
            "dhan_scrip_master",
            `
            WHERE DISPLAY_NAME LIKE '%${search}%'
            OR SYMBOL_NAME LIKE '%${search}%'
            LIMIT 20
            `
        );

        const formatted = data.map(item => ({
            securityId: item.SECURITY_ID,
            name: item.DISPLAY_NAME,
            symbol: item.SYMBOL_NAME,
            exchangeSegment: item.SEGMENT,
            exchange: item.EXCH_ID,
            lotSize: item.LOT_SIZE
        }));

        res.json({
            status: true,
            data: formatted
        });
    } catch (error) {
        res.json({
            status: false,
            message: error.message
        });
    }
};

exports.buyOrder = async (req, res) => {
    try {

        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({
                status: false,
                message: "User authentication required"
            });
        }

        const dhanClientId = user.dhanClientId;
        const {
            dhanAccessToken,
            securityId,
            exchangeSegment,
            quantity,
            price,
            orderType,
            index 
        } = req.body;

        const challenge = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );

        if (!challenge || !challenge.id) {
            return res.json({
                status: false,
                message: "No active challenge found"
            });
        }

        const pnlData = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_trade_logs",
            `WHERE dhan_client_id='${dhanClientId}' AND trade_date=CURDATE()`,
            "SUM(pnl) as total"
        );

        const todayPnL = pnlData?.total || 0;
        if (todayPnL <= -challenge.max_loss) {
            return res.json({
                status: false,
                rule: "DAILY_LOSS_LIMIT",
                message: "Daily loss limit reached"
            });
        }

        if (todayPnL >= challenge.max_profit) {
            return res.json({
                status: false,
                rule: "DAILY_PROFIT_TARGET",
                message: "Daily profit target achieved"
            });
        }

        const tradeCount = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_trade_logs",
            `WHERE dhan_client_id='${dhanClientId}' AND trade_date=CURDATE()`,
            "COUNT(*) as total"
        );

        if ((tradeCount?.total || 0) >= challenge.max_trades_per_day) {
            return res.json({
                status: false,
                rule: "MAX_TRADES_LIMIT",
                message: "Maximum trades per day reached"
            });
        }

        let allowedQty = 0;

        if (index === "NIFTY") allowedQty = challenge.nifty_lots;
        if (index === "BANKNIFTY") allowedQty = challenge.banknifty_lots;
        if (index === "FINNIFTY") allowedQty = challenge.finnifty_lots;
        if (index === "MIDCAPNIFTY") allowedQty = challenge.midcapnifty_lots;
        if (index === "SENSEX") allowedQty = challenge.sensex_lots;

        if (quantity > allowedQty) {
            return res.json({
                status: false,
                rule: "QUANTITY_RULE",
                message: `Allowed ${allowedQty}, tried ${quantity}`
            });
        }

        const orderPayload = {
            dhanClientId: user.dhanClientId,
            correlationId: Date.now().toString(),
            transactionType: "BUY",
            exchangeSegment: exchangeSegment,
            productType: "INTRADAY",
            orderType: orderType || "MARKET",
            validity: "DAY",
            securityId: securityId,
            quantity: quantity.toString(),
        };

        if (orderType === "LIMIT") {
            orderPayload.price = price;
        }

        const response = await axios.post(
            "https://sandbox.dhan.co/v2/orders",
            orderPayload,
            {
                headers: {
                    "access-token": dhanAccessToken,
                    "Content-Type": "application/json"
                }
            }
        );

        res.json({
            status: true,
            message: "Order placed successfully",
            data: response.data
        });

    } catch (error) {
        console.log("BUY ORDER ERROR:", error.response?.data || error.message);
        res.json({
            status: false,
            message: error.response?.data || error.message
        });
    }
};