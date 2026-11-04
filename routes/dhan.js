var express = require("express");
var apiMiddleware = require("../middlewares/api");
const { authentication } = require("../middlewares/authentication");
const router = express.Router();
const {
    generateConsent,
    consumeConsent,
    getPortfolio,
    searchStocks,
    generateMarketToken,
    getStockList,
    buyOrder,
    getIntradayData,
    getOptionChain,
    getOptionDetail,
    getExpiryDates,
    getOrderById,
    getOrderList,
    getTradeHistory,
    getHistoricalData,
    buySuperOrder,
    // dummyBuy,
    cancelSuperOrderLeg,
    // dummySell
    modifySuperOrder,
    modifyOrder,
    cancelOrder,
    syncExpiryDates,
    getFundLimit,
    getRelatedFNO,
    getSuperOrders,
    getMarginCalculator,
    getLotSize,
    getOptionChainExpiryList,
    getCachedHistoricalData,
    resyncHistoricalCache,
    getCachedIntradayData,
    resyncIntradayCache,
    getMarketData,
    getTechnicalIndicators,
    getNewsHeadlines,
} = require("../controllers/DhanController");
const instrumentController = require("../controllers/instrumentController");

var app = express();


// Market data token for Flutter direct WebSocket connection
app.get("/market-token", apiMiddleware, authentication, async (req, res) => {
    try {
        const clientId = process.env.DHAN_MARKET_CLIENT_ID;
        if (!clientId) return res.json({ status: false, message: "DHAN_MARKET_CLIENT_ID not set" });

        const dbQuery   = require("../helpers/query");
        const constants = require("../vars/constants");

        // Try market_data_tokens table (SELF token, generated via PIN+TOTP)
        let token = null, source = 'ENV';
        try {
            const row = await dbQuery.fetchSingleRecord(
                constants.vals.defaultDB, 'market_data_tokens',
                `WHERE dhan_client_id = '${clientId}'`
            );
            if (row && !Array.isArray(row) && row.access_token) {
                token  = row.access_token;
                source = 'market_data_tokens';
            }
        } catch (_) {}

        // Fallback to ENV SELF token (NOT users table — that has PARTNER tokens)
        if (!token) {
            token  = process.env.DHAN_MARKET_ACCESS_TOKEN;
            source = 'ENV';
        }

        if (!token) {
            return res.json({ status: false, message: "No SELF token. Generate from Profile → Refresh Market Token." });
        }

        console.log(`[market-token] source=${source} tokenLen=${token.length}`);
        return res.json({ status: true, data: { clientId, accessToken: token } });
    } catch (e) {
        return res.json({ status: false, message: e.message });
    }
});

// Simple Hello World endpoint for testing
app.get("/hello", (req, res) => {
    return res.status(200).json({
        status: true,
        message: "Hello World - API is working!",
        timestamp: new Date()
    });
});

// Generate consent route - No middleware needed for initial consent
app.options("/generate-consent", (req, res) => res.sendStatus(200));
app.get("/generate-consent", generateConsent);

// update instruments route - No middleware needed for updating instruments
router.get("/update-instruments", instrumentController.updateInstruments);

// Real lot size per major index (NIFTY/BANKNIFTY/FINNIFTY/MIDCAPNIFTY/SENSEX),
// from the instrument master — no user context needed, same as above.
router.get("/index-lot-sizes", instrumentController.getIndexLotSizes);

// Consume consent route - With middleware
app.use("/consume-consent", apiMiddleware, consumeConsent);
app.use("/portfolio", apiMiddleware, authentication, getPortfolio);
app.use("/search-stocks", apiMiddleware,authentication, searchStocks);
app.get("/instruments", apiMiddleware, authentication, getStockList);
app.post("/generate-market-token", apiMiddleware, authentication, generateMarketToken);
app.use("/buy-order", apiMiddleware, authentication, buyOrder);
app.get("/order/:orderId", apiMiddleware, authentication, getOrderById);
app.use("/orders", apiMiddleware, authentication, getOrderList);
app.put("/order/:orderId", apiMiddleware, authentication, modifyOrder);
app.delete("/order/:orderId", apiMiddleware, authentication, cancelOrder);
app.use("/buy-super-order", apiMiddleware, authentication, buySuperOrder);
app.use("/trade-history", apiMiddleware, authentication, getTradeHistory);
app.use("/fund-limit", apiMiddleware, authentication, getFundLimit);
app.use("/margin-calculator", apiMiddleware, authentication, getMarginCalculator);
app.get("/super-orders", apiMiddleware, authentication, getSuperOrders);
app.post("/sync-expiry-dates", apiMiddleware, authentication, syncExpiryDates);
app.put("/super-orders/:orderId", apiMiddleware, authentication, modifySuperOrder);
app.delete("/super-orders/:orderId/:orderLeg", apiMiddleware, authentication, cancelSuperOrderLeg);

// Related F&O
app.get("/related-fno", apiMiddleware, authentication, getRelatedFNO);


app.get("/expiry-dates", apiMiddleware, authentication, getExpiryDates);
app.get("/lot-size",    apiMiddleware, authentication, getLotSize);

// Chart data
app.post("/historical", apiMiddleware, authentication, getHistoricalData);
app.post("/historical-cached", apiMiddleware, authentication, getCachedHistoricalData);
app.post("/historical-resync", apiMiddleware, authentication, resyncHistoricalCache);
app.post("/intraday", apiMiddleware, authentication, getIntradayData);
app.post("/intraday-cached", apiMiddleware, authentication, getCachedIntradayData);
app.post("/intraday-resync", apiMiddleware, authentication, resyncIntradayCache);
app.post("/option-chain", apiMiddleware, authentication, getOptionChain);
app.post("/option-detail", apiMiddleware, authentication, getOptionDetail);
app.post("/option-chain-expiry", apiMiddleware, authentication, getOptionChainExpiryList);

// Market data: top gainers, losers, NIFTY 50, BANKNIFTY
app.get("/market-data", apiMiddleware, authentication, getMarketData);

// Technical indicators (calculated from DB-cached OHLC)
app.post("/technical-indicators", apiMiddleware, authentication, getTechnicalIndicators);

// News headlines from Dhan
app.post("/news-headlines", apiMiddleware, authentication, getNewsHeadlines);

module.exports = app;
