var express = require("express");
var router = express.Router();

/* GET home page. */
router.get("/", function (req, res) {
	res.removeHeader("X-Powered-By");
	res.removeHeader("Server");
	res.render("index", { title: "RedoQ" });
});

module.exports = router;
