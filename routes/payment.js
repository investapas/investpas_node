var express = require("express");
var apiMiddleware = require("../middlewares/api");
const { authentication } = require("../middlewares/authentication");
const { createOrder, verifyPayment, getPaymentHistory } = require("../controllers/PaymentController");

var router = express.Router();

router.post("/create-order", apiMiddleware, authentication, createOrder);
router.post("/verify", apiMiddleware, authentication, verifyPayment);
router.get("/history", apiMiddleware, authentication, getPaymentHistory);

module.exports = router;
