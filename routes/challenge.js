var express = require("express");
var apiMiddleware = require("../middlewares/api");
const { authentication } = require("../middlewares/authentication");
const {
    createChallenge,
    getCurrentChallenge,
    checkOrderRules,
    getUsage,
    logTrade,
    checkCooldown,
    quickUnlock,
    completeChallenge,
    getChallengeHistory
} = require("../controllers/ChallengeController");

var router = express.Router();

// Create challenge - requires authentication
router.post("/create", apiMiddleware, authentication, createChallenge);

// Get current challenge - requires authentication
router.get("/current", apiMiddleware, authentication, getCurrentChallenge);

// Check order rules - requires authentication
router.post("/check-order", apiMiddleware, authentication, checkOrderRules);

// Unified usage snapshot for one mode — same counters checkOrderRules uses
router.get("/usage", apiMiddleware, authentication, getUsage);

// Log trade - requires authentication
router.post("/log-trade", apiMiddleware, authentication, logTrade);

// Check cooldown status - requires authentication
router.post("/check-cooldown", apiMiddleware, authentication, checkCooldown);

// Quick unlock - requires authentication
router.post("/quick-unlock", apiMiddleware, authentication, quickUnlock);


router.post("/complete",        apiMiddleware, authentication, completeChallenge);
router.get("/history",          apiMiddleware, authentication, getChallengeHistory);

// Get risk framework (suggested SL/TP) for a trade entry price
router.get("/risk-framework", apiMiddleware, authentication, async (req, res) => {
    try {
        const { dhanClientId } = req.user;
        const price = parseFloat(req.query.price || 0);
        if (!price) return res.json({ status: false, message: 'price required' });

        const query = require("../helpers/query");
        const constants = require("../vars/constants");
        const advChallenge = require("../helpers/advanceChallengeEngine");

        const challenge = await query.fetchSingleRecord(
            constants.vals.defaultDB, 'user_challenges',
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );
        if (!challenge) return res.json({ status: true, data: null });

        const framework = advChallenge.getRiskFramework(challenge, price);
        res.json({ status: true, data: framework });
    } catch (e) {
        res.json({ status: false, message: e.message });
    }
});

module.exports = router;
