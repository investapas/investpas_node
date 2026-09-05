var express = require("express");
var apiMiddleware = require("../middlewares/api");
const { userPhoneVerify, userOtpVerify } = require("../controllers/UserController");

var app = express();

// User phone number verify route
app.use("/verify_phone_no", apiMiddleware, userPhoneVerify);

// User otp verify route
app.use("/verify_otp", apiMiddleware, userOtpVerify);

module.exports = app;
