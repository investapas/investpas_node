const express = require("express");
const router = express.Router();
const { authentication } = require("../middlewares/authentication");
const FileManager = require("../helpers/file_manager");
const { sendNotification } = require("../controllers/notificationController");

router.post(
  "/send",
  authentication,
  FileManager.userUploadProfilePicture("/notificationImages").single("image"),
  sendNotification
);

module.exports = router;
