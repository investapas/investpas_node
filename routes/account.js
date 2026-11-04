var express = require("express");
var apiMiddleware = require("../middlewares/api");
const { webAuthentication, authentication } = require("../middlewares/authentication");
const {
    signup,
    login,
    me,
    selectPlan,
    verifyPayment,
    createChallenge,
    dashboard,
} = require("../controllers/AccountController");

const early = require("../controllers/EarlyAccessController");

var router = express.Router();

// ── New website (investapas-site): early access + leads admin ─────────────
// Firebase phone OTP → session (creates the account on first login).
router.post("/session", apiMiddleware, early.session);
router.get("/early-profile", apiMiddleware, webAuthentication, early.me);
router.post("/early-profile", apiMiddleware, webAuthentication, early.updateProfile);
// Leads admin — logs in via the shared /admin/login (admin.routes.js), not
// a separate website password.
router.get("/admin/leads", apiMiddleware, authentication, early.adminLeads);
router.post("/admin/leads/:id", apiMiddleware, authentication, early.adminUpdateLead);
router.get("/admin/export.csv", apiMiddleware, authentication, early.adminExportCsv);

// Website account (phone-first). signup/login take a Firebase phone-OTP
// ID token; everything else takes the web session token they return.
router.post("/signup", apiMiddleware, signup);
router.post("/login", apiMiddleware, login);

router.get("/me", apiMiddleware, webAuthentication, me);
router.post("/plan", apiMiddleware, webAuthentication, selectPlan);
router.post("/payment/verify", apiMiddleware, webAuthentication, verifyPayment);
router.post("/challenge", apiMiddleware, webAuthentication, createChallenge);
router.get("/dashboard", apiMiddleware, webAuthentication, dashboard);

module.exports = router;
