const apiResponse = require("../vars/apiResponse");
const dbcon = require("../config/mysqlClient");
const constants = require("../vars/constants");

const DB = constants.vals.defaultDB;

exports.getDashboardStats = async (req, res) => {
    try {
        const [activeUsers, challengeUsers, demoUsers, activeChallenges] = await Promise.all([
            dbcon.query(DB, `SELECT COUNT(*) AS total FROM users WHERE is_active = 1`),
            dbcon.query(DB, `SELECT COUNT(DISTINCT dhan_client_id) AS total FROM user_challenges`),
            dbcon.query(DB, `SELECT COUNT(DISTINCT dhan_client_id) AS total FROM demo_wallets`),
            dbcon.query(DB, `SELECT COUNT(*) AS total FROM user_challenges WHERE challenge_status='ACTIVE'`),
        ]);

        return apiResponse.successResponseWithData(res, "Dashboard stats fetched successfully", {
            total_active_users:      activeUsers?.[0]?.total  || 0,
            total_challenge_users:   challengeUsers?.[0]?.total || 0,
            total_demo_users:        demoUsers?.[0]?.total || 0,
            total_active_challenges: activeChallenges?.[0]?.total || 0,
        });
    } catch (error) {
        console.log("Dashboard Stats Error:", error);
        return apiResponse.ErrorResponse(res, error.message);
    }
};
