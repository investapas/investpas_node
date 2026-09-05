const mongoose = require('mongoose');
const Schema = mongoose.Schema;
var moment = require('moment-timezone');
var allModels = require("../config/models/mongo/index");
//const mongodbErrorHandler = require('mongoose-mongodb-errors');
mongoose.pluralize(null);

let mongoDbAllSchema = {};
for (let m in allModels) {
    let commonModels = allModels[m];
    for (let k in commonModels) {
        for (let sk in commonModels[k].model) {
            if (commonModels[k].model[sk].type == 'ObjectId') {
                commonModels[k].model[sk].type = mongoose.Types.ObjectId;
            }
        }
let mschema = new Schema(commonModels[k].model, commonModels[k].options);
        mongoDbAllSchema[k] = mongoose.model(k, mschema, k);
    }
}
exports.models = mongoDbAllSchema;
