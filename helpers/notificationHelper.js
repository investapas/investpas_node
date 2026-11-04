const dbQuery = require("./query");
const constants = require("../vars/constants");

const DB = constants.vals.defaultDB;

exports.getAllFirebaseTokens = async () => {
  const users = await dbQuery.executeQuery(DB,
    `SELECT firebase_token FROM users
     WHERE firebase_token IS NOT NULL AND firebase_token != '' AND is_active = 1`
  );
  return (users || []).map(u => u.firebase_token).filter(Boolean);
};
