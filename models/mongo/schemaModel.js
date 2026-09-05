const mongoose = require('mongoose');
const Schema = mongoose.Schema;
var moment = require('moment-timezone');
var allModels = require("../config/models/mongo/index");
//const mongodbErrorHandler = require('mongoose-mongodb-errors');
mongoose.pluralize(null);

let mongoDbAllSchema = {};
//console.log('mongooseModels - ', allModels);

for (let m in allModels) {
    let commonModels = allModels[m];
    for (let k in commonModels) {
        // console.log('schema - ', k);
        let mschema = new Schema(commonModels[k].model, commonModels[k].options);
        mongoDbAllSchema[k] = mschema;// mongoose.model(k, mschema);
    }
}
//console.log('mongoDbAllSchema - ', mongoDbAllSchema);
module.exports = mongoDbAllSchema;
//exports.models = mongoDbAllSchema;
