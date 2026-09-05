
// var Promise = require('bluebird'),
//     mongoose = require("mongoose"),
//     using = Promise.using;

// var dbs = require("/home/ubuntu/config/db").mongodbs;
// var constants = require("/home/ubuntu/config/constants");
// var utility = require("../helpers/utility");

// var env = (process.env.NODE_ENV == 'production') ? 'prod' : 'dev';
// var pools = {};

// var base = {
//     host: 'redoqdev.mongodb.net',
//     user: 'root',
//     password: '2312312',
//     database: undefined
// };
// var mongoClient = exports;

// const clientOption = {
//     // useUnifiedTopology: true,
//     socketTimeoutMS: 30000,
//     // keepAlive: true,
//     //reconnectTries: 30000,
//     maxPoolSize: 50,
//     //useNewUrlParser: true,
//     autoIndex: true
// };

// exports.connection = async () => new Promise(
//     (resolve, reject) => {
//         Object.keys(dbs).forEach(function (d) {
//             var o = Object.assign({}, base);
//             Object.keys(dbs[d]).forEach(function (k) {
//                 o[k] = dbs[d][k];
//             });
//             let qryStr = "mongodb+srv://" + o.user + ":" + o.password + "@" + o.host + "/" + o.database + "?retryWrites=true&w=majority";
//             pools[d] = mongoose.createConnection(qryStr, clientOption);
//             pools[d].on("error", console.error.bind(console, "connection error: "));
//             pools[d].once("open", function () {
//                 //console.log("Connected successfully - " + o.database);
//             });
//             //require("../models/mongo/schema");
//             let schemasModel = require("../models/mongo/schemaModel");
//             for (let k in schemasModel) {
//                 pools[d].model(k, schemasModel[k], k);
//             }
//         });

//         resolve(pools);
//     });

// exports.convertMongoDate = async (req, db, model, params) => {
//     if (!utility.checkEmpty(constants.vals.mongodbconn[db])) {
//         if (!utility.checkEmpty(constants.vals.mongodbconn[db].model(model))) {
//             for (let k in params) {
//                 if (!utility.checkEmpty(constants.vals.mongodbconn[db].model(model).schema.path(k))) {
//                     if (constants.vals.mongodbconn[db].model(model).schema.path(k).instance == 'Date') {
//                         if (utility.checkEmpty(params[k]) || params[k] == '0000-00-00 00:00:00' || params[k] == '0000-00-00') {
//                             params[k] = '';
//                         } else {
//                             params[k] = await utility.carbon.toUtcZone(req, params[k]);
//                         }
//                     }
//                 }
//             }
//         }
//     }
//     return params;
// };

// exports.parseMongoDate = async (req, db, model, paramData) => {

//     if (!utility.checkEmpty(constants.vals.mongodbconn[db])) {
//         if (!utility.checkEmpty(constants.vals.mongodbconn[db].model(model))) {
//             for (let k in paramData) {
//                 if (!utility.checkEmpty(paramData[k]) && !utility.checkEmpty(constants.vals.mongodbconn[db].model(model).schema.path(k))) {
//                     if (constants.vals.mongodbconn[db].model(model).schema.path(k).instance == 'Date') {
//                         let cdate = '';
//                         try {

//                             cdate = utility.carbon.parseZone(req, paramData[k]);
//                         } catch (e) {
//                             cdate = '';
//                         }
//                         if (utility.checkEmpty(cdate) || cdate == 'Invalid date') {
//                             cdate = '';
//                         }
//                         paramData[k] = cdate;
//                     }
//                 }
//             }
//         }
//     }

//     return paramData;
// };

// exports.insertSingle = async (req, database, model, params) => {
//     var result = [];
//     params = await mongoClient.convertMongoDate(req, database, model, params);
//     try {
//         result = await constants.vals.mongodbconn[database].model(model)(params).save();
//         // console.log('insertSingle ', result);
//     } catch (e) {
//         console.log('MDB ERR', e);
//     }
//     if (!utility.checkEmpty(result)) {
//         let strfy = JSON.stringify(result)
//         let strprs = JSON.parse(strfy);
//         result = strprs;
//         return result._id;
//     }
//     return 0;
// };

// exports.findMongo = async (req, database, model, params) => {
//     var result = [];
//     var qry = constants.vals.mongodbconn[database].model(model);

//     if (!utility.checkEmpty(params.find)) {
//         params.find = await mongoClient.convertMongoDate(req, database, model, params.find);
//         qry = qry.find(params.find);
//     }
//     if (!utility.checkEmpty(params.findById)) {
//         qry = qry.findById(params.findById);
//     }
//     //console.log('qry', qry);
//     if (!utility.checkEmpty(params.sort)) {
//         qry = qry.sort(params.sort);
//     }

//     if (params.findone == 1) {
//         params.skip = 0;
//         params.limit = 1;
//     }

//     if (!utility.checkEmpty(params.skip)) {
//         qry = qry.skip(params.skip);
//     }

//     if (!utility.checkEmpty(params.limit)) {
//         qry = qry.limit(params.limit);
//     }



//     if (!utility.checkEmpty(params.select)) {
//         let selObj = {};
//         for (let k in params.select) {
//             selObj[params.select[k]] = 1;
//         }
//         qry = qry.select(selObj);
//     }

//     try {
//         result = await qry.exec();
//         //console.log('------------ ', database, model, result);
//         if (!utility.checkEmpty(params.findById)) {
//             let strfy = JSON.stringify(result);
//             let strprs = JSON.parse(strfy)
//             if (params.dateparse == 0) {
//                 //result = await mongoClient.parseMongoDate(req, database, model, strprs);
//                 result = strprs;
//             } else {
//                 result = await mongoClient.parseMongoDate(req, database, model, strprs);
//             }

//         } else {
//             let rsp = [];
//             for (let k in result) {
//                 //console.log('************* ');
//                 //console.log(result[k]);
//                 let strfy = JSON.stringify(result[k])
//                 let strprs = JSON.parse(strfy);
//                 if (params.dateparse == 0) {
//                     rsp.push(strprs);
//                 } else {
//                     rsp.push(await mongoClient.parseMongoDate(req, database, model, strprs));
//                 }
//             }
//             result = rsp;
//             //console.log(result);
//             if (params.skip == 0 && params.limit == 1) {
//                 if (!utility.checkEmpty(result)) {
//                     result = result[0];
//                 }
//             }

//         }



//     } catch (e) {
//         console.log('MDB ERR', e);
//     }
//     return result;
// };

// exports.updateManyMongo = async (req, database, model, params) => {
//     var result = [];
//     var qry = constants.vals.mongodbconn[database].model(model);
//     if (!utility.checkEmpty(params.find)) {
//         qry = qry.find(params.find);
//     }
//     params.update = await mongoClient.convertMongoDate(req, database, model, params.update);
//     try {
//         result = await qry.updateMany(params.update).exec();
//     } catch (e) {
//         console.log('MDB ERR', e);
//     }
//     return result;
// };