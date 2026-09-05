const jwt = require("jsonwebtoken");
const dbquery = require("../helpers/query");
let constants = require("../vars/constants");
let { notFoundResponse, unauthorizedResponse } = require("../vars/apiResponse");

exports.authentication = async (req, res, next) => {
    try {
        const token = req.headers.authorization;
        if (!token) {
            return unauthorizedResponse(res, "Token missing");
        }
        // Bearer token handle
        const cleanToken = token.replace("Bearer ", "");
        const decoded = jwt.verify(cleanToken, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return unauthorizedResponse(res, "Invalid token");
    }
};

// exports.authentication = async (req, res, next) => {
//     try {
//         const token =  req?.headers?.authorization;

//         if(!token) {
//             return unauthorizedResponse(res, 'Invalid token.');
//         }

//         let condition = `WHERE user_Token = '${token}' AND is_active = 1 AND is_delete = 0`;
//         const userData = await dbquery.fetchSingleRecord(constants.vals.defaultDB, 'user', condition);

//         if (Array.isArray(userData) && userData.length == 0) {
//             return unauthorizedResponse(res, 'Invalid token.');
//         } else {
//             req.userInfo = userData;
//             next();
//         }

//     } catch (error) {
//         throw error;
//     }
// }

exports.patrolUnitAuthentication = async (req, res, next) => {
    try {
        const token = req?.headers?.authorization;

        if (!token) {
            return unauthorizedResponse(res, 'Invalid token.');
        }

        let condition = `WHERE police_officer_Token = '${token}' AND is_active = 1 AND is_delete = 0`;
        const userData = await dbquery.fetchSingleRecord(constants.vals.defaultDB, 'police_officer', condition);

        if (Array.isArray(userData) && userData.length == 0) {
            return unauthorizedResponse(res, 'Invalid token.');
        } else {
            if (userData.police_officer_Role === "Patrol Officer") {
                req.userInfo = userData;
                next();
            } else {
                return unauthorizedResponse(res, 'Invalid token.');
            }
        }

    } catch (error) {
        throw error;
    }
}

exports.policeStationAuthentication = async (req, res, next) => {
    try {
        const token = req?.headers?.authorization;

        if (!token) {
            return unauthorizedResponse(res, 'Invalid token.');
        }

        let condition = `WHERE police_officer_Token = '${token}' AND is_active = 1 AND is_delete = 0`;
        const userData = await dbquery.fetchSingleRecord(constants.vals.defaultDB, 'police_officer', condition);

        if (Array.isArray(userData) && userData.length == 0) {
            return unauthorizedResponse(res, 'Invalid token.');
        } else {
            if (userData.police_officer_Role === "Station Officer") {
                req.userInfo = userData;
                next();
            } else {
                return unauthorizedResponse(res, 'Invalid token.');
            }
        }

    } catch (error) {
        throw error;
    }
}

exports.adminAuthentication = async (req, res, next) => {
    try {
        const token = req?.headers?.authorization;

        if (!token) {
            return unauthorizedResponse(res, 'Invalid token.');
        }

        let condition = `WHERE admin_token_JWT = '${token}' AND is_active = 1 AND is_delete = 0`;
        let selectFields = 'admin_token_Id, admin_Id, admin_token_JWT, admin_token_Firebase'
        const adminTokenData = await dbquery.fetchSingleRecord(constants.vals.defaultDB, 'admin_token', condition, selectFields);

        if (Array.isArray(adminTokenData) && adminTokenData.length == 0) {
            return unauthorizedResponse(res, 'Invalid token.');
        } else {
            let adminCondition = `WHERE admin_Id = ${adminTokenData.admin_Id} AND is_active = 1 AND is_delete = 0`;
            const admin = await dbquery.fetchSingleRecord(constants.vals.defaultDB, 'admin', adminCondition);

            delete adminTokenData.admin_Id;

            const userData = { ...admin, ...adminTokenData };

            if (Array.isArray(admin) && admin.length == 0) {
                return unauthorizedResponse(res, 'Invalid token.');
            } else {
                req.userInfo = userData;
                next();
            }
        }

    } catch (error) {
        throw error;
    }
}