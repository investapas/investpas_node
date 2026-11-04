var express = require("express");
var apiMiddleware = require("../middlewares/api");
const { authentication } = require("../middlewares/authentication");
const {
    getStatus,
    approveAutopay,
    confirmAutopay,
    cancelAutopay,
    razorpayWebhook,
} = require("../controllers/TrialController");

var router = express.Router();

router.get("/status", apiMiddleware, authentication, getStatus);
router.post("/approve-autopay", apiMiddleware, authentication, approveAutopay);
router.post("/confirm-autopay", apiMiddleware, authentication, confirmAutopay);
router.post("/cancel-autopay", apiMiddleware, authentication, cancelAutopay);

// Razorpay calls this directly — no app-session auth exists on their side.
// Authenticity comes from the HMAC signature check inside razorpayWebhook
// itself, not from this middleware chain.
router.post("/razorpay-webhook", razorpayWebhook);

module.exports = router;
