let Promise = require('bluebird'),
    mysql = require('mysql2'),
    using = Promise.using;

let dbs = require("../vars/db").dbs;
let dbs_login = require("../vars/db").dbs_login;
let constants = require("../vars/constants");
let utility = require("../helpers/utility");

let env = (process.env.NODE_ENV == 'production') ? 'prod' : 'dev';
let pools = {};
let base = {
    //host: 'redoq-dev-db-vpc.cs0kxsrqdtm7.ap-south-1.rds.amazonaws.com',
    host: 'redoq.amazonaws.com',
    user: 'root',
    password: 'aaaaa',
    database: undefined,
    connectionLimit: 50,
    multipleStatements: true,
    dateStrings: true,
    //debug: true,
    //acquireTimeout: 30000,
    typeCast: function (field, next) {
        if (field.type == "BIT" && field.length == 1) {
            var bit = field.string();
            return (bit === null) ? null : bit.charCodeAt(0);
        }
        return next();
    }
};


exports.connection = async () => new Promise(
    (resolve, reject) => {
        if (!utility.checkEmpty(dbs)) {
            Object.keys(dbs).forEach(function (d) {
                let o = Object.assign({}, base);
                o['database'] = dbs[d].database;
                if (!utility.checkEmpty(constants.vals.service_name) && !utility.checkEmpty(dbs_login[constants.vals.service_name])) {
                    o['user'] = dbs_login[constants.vals.service_name].user;
                    o['password'] = dbs_login[constants.vals.service_name].password;
                }
                let readPool = o;
                let writePool = o;

                readPool.host = dbs[d].read;
                writePool.host = dbs[d].write;
                console.log("dbsd", dbs[d],"readPool", readPool, "writePool", writePool);
                pools[d] = {};
                pools[d].read = mysql.createPool(readPool);
                pools[d].write = mysql.createPool(writePool);
            });
        }
        resolve(pools);
    });

exports.query = async (database, qry, params) => new Promise(
    (resolve, reject) => {


        const handler = (error, result) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(result);
        }

        let checkVer = 'v1';
        let queryType = 'write';

        // qry = qry.trim();
        qry = typeof qry === 'string' ? qry.trim() : '';

        if (!utility.checkEmpty(qry)) {
            let fWord = qry.split(" ");
            if (!utility.checkEmpty(fWord)) {
                if (fWord[0].toLowerCase() == 'select') {
                    queryType = 'read';
                }
            }
        }
        queryType = 'write';
        let connectionObj = constants.vals.dbconn[database];

        // console.log("dbconn object:", constants.vals.dbconn);
        // console.log("database:", database);
        // console.log("queryType:", queryType);
        // console.log("connection ob", connectionObj);


        if (!utility.checkEmpty(constants.vals.dbconn) && !utility.checkEmpty(constants.vals.dbconn[database]) && !utility.checkEmpty(constants.vals.dbconn[database][queryType])) {
            checkVer = 'v2';
            connectionObj = constants.vals.dbconn[database][queryType];
        }

        try {
            connectionObj.getConnection(function (err, connection) {
                if (err) {
                    console.error('++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
                    console.error(mysql.format(qry, params));
                    console.error('------------------------------------------------------------------------------------------------');
                    console.error('runQry-cannot getConnection ERROR: ' + database, err);
                    reject(err);
                }
                connection.query(qry, params, function (err, result) {
                    if (database == 'mysql_test') {
                        let querylog = {};
                        querylog.querylog_Product = 'serv-nodejs';
                        querylog.querylog_Database = database;
                        querylog.querylog_Stmt = qry;
                        querylog.querylog_Params = params;
                        querylog.querylog_Query = mysql.format(qry, params);
                        try {
                            //constants.vals.mongodbconn[constants.vals.commonDB].model("querylog")(querylog).save();
                        } catch (e) {
                            console.log('MDB ERR', e);
                        }
                    }
                    connection.release();
                    if (err) {
                        console.error('++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
                        console.error(mysql.format(qry, params));
                        console.error('------------------------------------------------------------------------------------------------');
                        console.error('runQry-cannot Query ERROR:' + database, err);
                        reject(err);
                    }

                    resolve(result);
                });
            });
        } catch (err) {
            console.log('Connection error ', database, err);
        }
    });

// const mysql = require('mysql2/promise');

// // Create a pool with promise-based API
// const pool = mysql.createPool({
//     host: 'localhost',
//     user: 'root',
//     password: '',
//     database: 'project_investapas',
//     waitForConnections: true,
//     connectionLimit: 10,
//     queueLimit: 0
// });

// async function testConnection() {
//     try {
//         console.log('Database connected successfully.');
//     } catch (error) {
//         console.error('Error while connecting to the database:', error);
//     }
// }

// // Run the test function
// testConnection();

// module.exports = pool;

