const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const dbQuery = require('../helpers/query');
const dbcon = require('../config/mysqlClient');
const utility = require('../helpers/utility');
const constants = require('../vars/constants');

const DB = constants.vals.defaultDB;

// ── Shared helper: resolve user ID → dhan_client_id ─────────────────────────
async function _resolveUser(id) {
    const rows = await dbcon.query(DB,
        `SELECT id, dhan_client_id FROM users WHERE id = ? LIMIT 1`, [Number(id)]
    );
    return rows?.[0] || null;
}

function _ok(res, msg, data) {
    return utility.apiResponse(null, res, { status: 'success', msg, data });
}
function _err(res, msg) {
    return utility.apiResponse(null, res, { status: 'error', msg });
}


// ====================================
// ADMIN LOGIN
// ====================================

exports.adminLogin = async (req, res) => {
    try {
        const bodyData = req?.body?.inputdata;

        if (utility.checkEmptyString(bodyData?.email)) return _err(res, 'Email is required');
        if (utility.checkEmptyString(bodyData?.password)) return _err(res, 'Password is required');

        const email = (bodyData.email || '').trim();

        const rows = await dbcon.query(DB,
            `SELECT * FROM admin WHERE email = ? LIMIT 1`, [email]
        );
        const admin = rows?.[0];
        if (!admin) return _err(res, 'Admin not found');

        const isMatch = await bcrypt.compare(bodyData.password, admin.password);
        if (!isMatch) return _err(res, 'Invalid password');

        let permissions = [];
        if (admin.role_id) {
            const roleRows = await dbcon.query(DB,
                `SELECT permissions FROM roles WHERE role_id = ? LIMIT 1`, [admin.role_id]
            );
            const raw = roleRows?.[0]?.permissions;
            if (Array.isArray(raw)) permissions = raw;
            else if (typeof raw === 'string') {
                try { permissions = JSON.parse(raw); } catch (_) {}
            }
        }

        const token = jwt.sign({ admin_Id: admin.id }, process.env.JWT_SECRET, { expiresIn: '1d' });

        await dbcon.query(DB, `UPDATE admin SET token = ? WHERE id = ?`, [token, admin.id]);

        return _ok(res, 'Admin login successful', {
            admin_Id: admin.id,
            name: admin.name,
            email: admin.email,
            token,
            permissions,
        });
    } catch (error) {
        throw error;
    }
};


// ====================================
// GET ALL USERS
// ====================================

exports.getUsers = async (req, res) => {
    try {
        const users = await dbcon.query(DB,
            `SELECT id, dhan_client_id, dhan_client_name, dhan_client_ucc,
                    profile_picture, is_active, created_at
             FROM users ORDER BY id DESC`
        );
        return _ok(res, 'Users fetched successfully', users);
    } catch (error) {
        throw error;
    }
};


// ====================================
// USER DETAILS
// ====================================

exports.userDetails = async (req, res) => {
    try {
        const user = await _resolveUser(req.params.id);
        if (!user) return _err(res, 'User not found');

        const cid = user.dhan_client_id;
        const [fullUser, pendingOrders, tradeLogs, pauseLogs] = await Promise.all([
            dbcon.query(DB, `SELECT * FROM users WHERE id = ? LIMIT 1`, [user.id]),
            dbcon.query(DB, `SELECT * FROM pending_orders WHERE dhan_client_id = ? ORDER BY id DESC`, [cid]),
            dbcon.query(DB, `SELECT * FROM challenge_trade_logs WHERE dhan_client_id = ? ORDER BY id DESC`, [cid]),
            dbcon.query(DB, `SELECT * FROM challenge_pause_logs WHERE dhan_client_id = ? ORDER BY id DESC`, [cid]),
        ]);

        return _ok(res, 'User details fetched successfully', {
            user: fullUser?.[0],
            pendingOrders: pendingOrders || [],
            tradeLogs: tradeLogs || [],
            pauseLogs: pauseLogs || [],
        });
    } catch (error) {
        throw error;
    }
};


// ====================================
// USER CHALLENGES
// ====================================

exports.userChallenges = async (req, res) => {
    try {
        const user = await _resolveUser(req.params.id);
        if (!user) return _err(res, 'User not found');

        const challenges = await dbcon.query(DB,
            `SELECT id, trading_capital, min_profit, max_profit, min_loss, max_loss,
                    challenge_days, challenge_start_date, challenge_end_date,
                    challenge_status, final_pnl, total_trades_count, created_at
             FROM user_challenges
             WHERE dhan_client_id = ? ORDER BY id DESC`,
            [user.dhan_client_id]
        );
        return _ok(res, 'User challenges fetched successfully', challenges);
    } catch (error) {
        throw error;
    }
};


// ====================================
// USER DEMO ORDERS
// ====================================

exports.userDemoOrders = async (req, res) => {
    try {
        const user = await _resolveUser(req.params.id);
        if (!user) return _err(res, 'User not found');

        const orders = await dbcon.query(DB,
            `SELECT * FROM demo_orders WHERE dhan_client_id = ? ORDER BY id DESC`,
            [user.dhan_client_id]
        );
        return _ok(res, 'Demo orders fetched successfully', orders);
    } catch (error) {
        throw error;
    }
};


// ====================================
// USER DEMO WALLET
// ====================================

exports.userDemoWallet = async (req, res) => {
    try {
        const user = await _resolveUser(req.params.id);
        if (!user) return _err(res, 'User not found');

        const wallet = await dbcon.query(DB,
            `SELECT * FROM demo_wallets WHERE dhan_client_id = ?`,
            [user.dhan_client_id]
        );
        return _ok(res, 'Demo wallet fetched successfully', wallet);
    } catch (error) {
        throw error;
    }
};


// ====================================
// USER COIN TRANSACTIONS
// ====================================

exports.userCoinTransactions = async (req, res) => {
    try {
        const user = await _resolveUser(req.params.id);
        if (!user) return _err(res, 'User not found');

        const txns = await dbcon.query(DB,
            `SELECT * FROM coin_transactions WHERE dhan_client_id = ? ORDER BY id DESC`,
            [user.dhan_client_id]
        );
        return _ok(res, 'Coin transactions fetched successfully', txns);
    } catch (error) {
        throw error;
    }
};


// ====================================
// USER COINS
// ====================================

exports.userCoins = async (req, res) => {
    try {
        const user = await _resolveUser(req.params.id);
        if (!user) return _err(res, 'User not found');

        const coins = await dbcon.query(DB,
            `SELECT * FROM user_coins WHERE dhan_client_id = ?`,
            [user.dhan_client_id]
        );
        return _ok(res, 'User coins fetched successfully', coins);
    } catch (error) {
        throw error;
    }
};


// ====================================
// USER WISHLIST
// ====================================

exports.userWishlist = async (req, res) => {
    try {
        const user = await _resolveUser(req.params.id);
        if (!user) return _err(res, 'User not found');

        const wishlist = await dbcon.query(DB,
            `SELECT * FROM user_wishlist WHERE dhan_client_id = ? ORDER BY id DESC`,
            [user.dhan_client_id]
        );
        return _ok(res, 'Wishlist fetched successfully', wishlist);
    } catch (error) {
        throw error;
    }
};


// ====================================
// WEBSITE CONTACTS
// ====================================

exports.websiteContacts = async (req, res) => {
    try {
        const contacts = await dbcon.query(DB,
            `SELECT * FROM website_contacts ORDER BY id DESC`
        );
        return _ok(res, 'Website contacts fetched successfully', contacts);
    } catch (error) {
        throw error;
    }
};


// ====================================
// ADMIN LOGOUT
// ====================================

exports.adminLogout = async (req, res) => {
    try {
        const adminId = req.user?.admin_Id;
        await dbcon.query(DB, `UPDATE admin SET token = '' WHERE id = ?`, [adminId]);
        return _ok(res, 'Logout successful');
    } catch (error) {
        throw error;
    }
};
