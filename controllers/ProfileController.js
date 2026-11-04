const query    = require("../helpers/query");
const constants = require("../vars/constants");
const path     = require("path");
const fs       = require("fs");
const bcrypt   = require("bcrypt");
const dbcon    = require("../config/mysqlClient");

const SALT_ROUNDS = 10;

// Ensure profilePicture folder always exists
const profilePicDir = path.join(__dirname, "../Assets/profilePicture");
if (!fs.existsSync(profilePicDir)) {
    fs.mkdirSync(profilePicDir, { recursive: true });
}

exports.updateProfilePicture = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const fileName = req.body?.profile_picture?.[0];
        if (!fileName) {
            return res.json({ status: false, message: "No image uploaded" });
        }

        // Delete old picture if exists
        const existing = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "users",
            `WHERE dhan_client_id = '${user.dhanClientId}'`
        );

        if (existing && !Array.isArray(existing) && existing.profile_picture) {
            const oldPath = path.join(__dirname, "../Assets/profilePicture", existing.profile_picture);
            if (fs.existsSync(oldPath)) {
                fs.unlinkSync(oldPath);
            }
        }

        await query.updateRecord(
            constants.vals.defaultDB,
            "users",
            `dhan_client_id = '${user.dhanClientId}'`,
            `profile_picture = '${fileName}', updated_at = NOW()`
        );

        const imageUrl = `${req.protocol}://${req.get("host")}/userProfile/${fileName}`;

        return res.json({
            status: true,
            message: "Profile picture updated successfully",
            data: { profilePicture: imageUrl }
        });

    } catch (error) {
        console.log("UPDATE PROFILE PICTURE ERROR:", error.message);
        return res.json({ status: false, message: error.message });
    }
};

exports.removeProfilePicture = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const existing = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "users",
            `WHERE dhan_client_id = '${user.dhanClientId}'`
        );

        if (existing && !Array.isArray(existing) && existing.profile_picture) {
            const oldPath = path.join(__dirname, "../Assets/profilePicture", existing.profile_picture);
            if (fs.existsSync(oldPath)) {
                fs.unlinkSync(oldPath);
            }
        }

        await query.updateRecord(
            constants.vals.defaultDB,
            "users",
            `dhan_client_id = '${user.dhanClientId}'`,
            `profile_picture = NULL, updated_at = NOW()`
        );

        return res.json({ status: true, message: "Profile picture removed" });

    } catch (error) {
        console.log("REMOVE PROFILE PICTURE ERROR:", error.message);
        return res.json({ status: false, message: error.message });
    }
};

exports.getProfile = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const userData = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "users",
            `WHERE dhan_client_id = '${user.dhanClientId}'`
        );

        if (!userData || Array.isArray(userData)) {
            return res.json({ status: false, message: "User not found" });
        }

        const profilePicture = userData.profile_picture
            ? `${req.protocol}://${req.get("host")}/userProfile/${userData.profile_picture}`
            : null;

        return res.json({
            status: true,
            data: {
                dhanClientId: userData.dhan_client_id,
                name: userData.dhan_client_name,
                ucc: userData.dhan_client_ucc,
                profilePicture
            }
        });

    } catch (error) {
        console.log("GET PROFILE ERROR:", error.message);
        return res.json({ status: false, message: error.message });
    }
};

// PUT /profile/fcm-token  — update FCM push token for logged-in user
exports.updateFcmToken = async (req, res) => {
    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({ status: false, message: "User authentication required" });
        }

        const { fcmToken } = req.body;
        if (!fcmToken) {
            return res.json({ status: false, message: "fcmToken is required" });
        }

        console.log(`[FCM] Updating token for ${user.dhanClientId} — token: ${fcmToken.substring(0, 20)}...`);

        await query.updateRecord(
            constants.vals.defaultDB,
            "users",
            `dhan_client_id = '${user.dhanClientId}'`,
            `firebase_token = '${fcmToken}', updated_at = NOW()`
        );

        return res.json({ status: true, message: "FCM token updated" });
    } catch (error) {
        console.log("UPDATE FCM TOKEN ERROR:", error.message);
        return res.json({ status: false, message: error.message });
    }
};

// ── GET /profile/pin-status ───────────────────────────────────────────────────
exports.getPinStatus = async (req, res) => {
    try {
        const user = req.user;
        const row = await query.fetchSingleRecord(
            constants.vals.defaultDB, 'users',
            `WHERE dhan_client_id='${user.dhanClientId}'`,
            'app_pin_hash, biometric_enabled'
        );
        return res.json({
            status: true,
            hasPinSet:        !!(row?.app_pin_hash),
            biometricEnabled: !!(row?.biometric_enabled),
        });
    } catch (e) {
        return res.json({ status: false, message: e.message });
    }
};

// ── POST /profile/set-pin ─────────────────────────────────────────────────────
exports.setPin = async (req, res) => {
    try {
        const user = req.user;
        const { pin } = req.body;

        if (!pin || !/^\d{4}$/.test(pin)) {
            return res.json({ status: false, message: 'PIN must be exactly 4 digits.' });
        }

        const hash = await bcrypt.hash(pin, SALT_ROUNDS);

        await dbcon.query(
            constants.vals.defaultDB,
            `UPDATE users SET app_pin_hash = ? WHERE dhan_client_id = ?`,
            [hash, user.dhanClientId]
        );

        return res.json({ status: true, message: 'PIN set successfully.' });
    } catch (e) {
        return res.json({ status: false, message: e.message });
    }
};

// ── POST /profile/verify-pin ──────────────────────────────────────────────────
exports.verifyPin = async (req, res) => {
    try {
        const user = req.user;
        const { pin } = req.body;

        if (!pin || !/^\d{4}$/.test(pin)) {
            return res.json({ status: false, message: 'PIN must be exactly 4 digits.' });
        }

        const row = await query.fetchSingleRecord(
            constants.vals.defaultDB, 'users',
            `WHERE dhan_client_id='${user.dhanClientId}'`,
            'app_pin_hash'
        );

        if (!row?.app_pin_hash) {
            return res.json({ status: false, message: 'No PIN set. Please set a PIN first.' });
        }

        const match = await bcrypt.compare(pin, row.app_pin_hash);
        if (!match) {
            return res.json({ status: false, message: 'Incorrect PIN. Please try again.' });
        }

        return res.json({ status: true, message: 'PIN verified.' });
    } catch (e) {
        return res.json({ status: false, message: e.message });
    }
};

// ── PUT /profile/biometric ────────────────────────────────────────────────────
exports.toggleBiometric = async (req, res) => {
    try {
        const user = req.user;
        const { enabled } = req.body;

        if (typeof enabled === 'undefined') {
            return res.json({ status: false, message: 'enabled (true/false) is required.' });
        }

        await dbcon.query(
            constants.vals.defaultDB,
            `UPDATE users SET biometric_enabled = ? WHERE dhan_client_id = ?`,
            [enabled ? 1 : 0, user.dhanClientId]
        );

        return res.json({
            status: true,
            message: `Biometric ${enabled ? 'enabled' : 'disabled'}.`,
            biometricEnabled: !!enabled,
        });
    } catch (e) {
        return res.json({ status: false, message: e.message });
    }
};
