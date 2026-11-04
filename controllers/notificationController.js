const path = require('path');
const fs = require('fs');
const apiResponse = require("../vars/apiResponse");
const notificationHelper = require("../helpers/notificationHelper");
const utility = require("../helpers/utility");

const imgDir = path.join(__dirname, "../Assets/notificationImages");
if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

exports.sendNotification = async (req, res) => {
  try {
    const { title, description } = req.body;

    if (!title || !description) {
      return apiResponse.validationErrorWithData(res, "Title and description are required");
    }

    // Build image URL from uploaded file (always HTTPS — FCM requires it)
    let image = '';
    if (req.file) {
      image = `https://${req.get('host')}/notificationImages/${req.file.filename}`;
    }

    const tokens = await notificationHelper.getAllFirebaseTokens();

    if (!tokens.length) {
      return res.json({ status: 1, message: "No valid tokens found", data: { sent: 0, failed: 0, image } });
    }

    await utility.sendNotification(
      tokens,
      'notification',
      '',
      { title, body: description, ...(image ? { imageUrl: image } : {}) }
    );

    return res.json({
      status: 1,
      message: "Sent successfully",
      data: { sent: tokens.length, image },
    });
  } catch (err) {
    console.error("Notification Error:", err);
    return res.json({ status: 0, message: "Failed to send notification" });
  }
};
