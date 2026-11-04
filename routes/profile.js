var express = require("express");
var apiMiddleware = require("../middlewares/api");
const { authentication } = require("../middlewares/authentication");
const {
    updateProfilePicture, removeProfilePicture, getProfile, updateFcmToken,
    getPinStatus, setPin, verifyPin, toggleBiometric,
} = require("../controllers/ProfileController");
const FileManager = require("../helpers/file_manager");

var router = express.Router();

router.get("/", apiMiddleware, authentication, getProfile);

router.post(
    "/update-picture",
    apiMiddleware,
    authentication,
    FileManager.userUploadProfilePicture("/profilePicture").single("profile_picture"),
    updateProfilePicture
);

router.delete("/remove-picture", apiMiddleware, authentication, removeProfilePicture);

router.put("/fcm-token",   apiMiddleware, authentication, updateFcmToken);

// ── App PIN & biometric ───────────────────────────────────────────────────────
router.get("/pin-status",  apiMiddleware, authentication, getPinStatus);
router.post("/set-pin",    apiMiddleware, authentication, setPin);
router.post("/verify-pin", apiMiddleware, authentication, verifyPin);
router.put("/biometric",   apiMiddleware, authentication, toggleBiometric);

module.exports = router;
