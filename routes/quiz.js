var express = require("express");
var apiMiddleware = require("../middlewares/api");
const {
    getPlace,
    logVisit,
    submit,
    claim,
    mentorship,
} = require("../controllers/QuizController");
const {
    counterLogin,
    counterCheck,
    counterMarkServed,
} = require("../controllers/QuizAdminController");

var router = express.Router();

// Public — the quiz webpage itself. No app/admin auth: anyone scanning a
// QR code hits these without a login.
router.get("/place", apiMiddleware, getPlace);
router.post("/visit", apiMiddleware, logVisit);
router.post("/submit", apiMiddleware, submit);
router.post("/claim", apiMiddleware, claim);
router.post("/mentorship", apiMiddleware, mentorship);

// Cafe counter page — staff-facing, gated by each place's own PIN
// (checked inside the handlers themselves), not the admin JWT.
router.post("/counter/login", apiMiddleware, counterLogin);
router.post("/counter/check", apiMiddleware, counterCheck);
router.post("/counter/mark-served", apiMiddleware, counterMarkServed);

module.exports = router;
