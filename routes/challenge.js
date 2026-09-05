var express = require("express");
var apiMiddleware = require("../middlewares/api");
const { authentication } = require("../middlewares/authentication");
const {
    createChallenge,
    getCurrentChallenge,
    checkOrderRules,
    logTrade,
    checkCooldown,
    quickUnlock
} = require("../controllers/ChallengeController");

var router = express.Router();

// Create challenge - requires authentication
router.post("/create", apiMiddleware, authentication, createChallenge);

// Get current challenge - requires authentication
router.get("/current", apiMiddleware, authentication, getCurrentChallenge);

// Check order rules - requires authentication
router.post("/check-order", apiMiddleware, authentication, checkOrderRules);

// Log trade - requires authentication
router.post("/log-trade", apiMiddleware, authentication, logTrade);

// Check cooldown status - requires authentication
router.post("/check-cooldown", apiMiddleware, authentication, checkCooldown);

// Quick unlock - requires authentication
router.post("/quick-unlock", apiMiddleware, authentication, quickUnlock);

module.exports = router;
