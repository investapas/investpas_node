var express = require("express");
var apiMiddleware = require("../middlewares/api");
const { authentication } = require("../middlewares/authentication");
const {
    generateConsent,
    consumeConsent,
    getPortfolio,
    searchStocks,
    buyOrder,
} = require("../controllers/DhanController");

var app = express();

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

// Consume consent route - With middleware
app.use("/consume-consent", apiMiddleware, consumeConsent);
app.use("/portfolio", apiMiddleware, authentication, getPortfolio);
app.use("/search-stocks", apiMiddleware,authentication, searchStocks);
app.use("/buy-order", apiMiddleware, authentication, buyOrder);
module.exports = app;
