var express = require("express");
var apiMiddleware = require("../middlewares/api");
const { authentication } = require("../middlewares/authentication");
const { addToWishlist, removeFromWishlist, getWishlist } = require("../controllers/WishlistController");

var router = express.Router();

router.get("/", apiMiddleware, authentication, getWishlist);
router.post("/add", apiMiddleware, authentication, addToWishlist);
router.post("/remove", apiMiddleware, authentication, removeFromWishlist);

module.exports = router;
