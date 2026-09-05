
"use strict";
const express = require("express");
const _s = require("underscore.string");
const moment = require('moment-timezone');

const constants = require("../vars/constants");
const utility = require("../helpers/utility");
const methods = require("../helpers/methods");
const dbcon = require("../config/mysqlClient");
const mongodbconn = require("../config/mongoClient");

const dbquery = require("../helpers/query");



var router = express.Router();


router.use(async function (req, res, next) {
	res.removeHeader("X-Powered-By");
	res.removeHeader("Server");

	if (utility.checkEmpty(constants.vals.service_name)) {
		constants.vals.service_name = 'apiservice';
	}

	req.locals = {};

	if (utility.checkEmpty(constants.vals.dbconn)) {
		constants.vals.dbconn = await dbcon.connection().catch(e => { console.log(e); })
		console.log("no db");

	} else {
		console.log("already connectde");

	}


	//console.log(' process.versions.node - ', process.versions.node);


	if (utility.checkEmpty(constants.vals.mongodbconn)) {
		//constants.vals.mongodbconn = await mongodbconn.connection().catch(e => { console.log('Mongo Connection Error - ', e); })
	} else {
		//console.log(constants.vals.mongodbconn);
	}
	//constants.cache={};
	if (utility.checkEmpty(constants.cache)) { constants.cache = {}; }



	req.locals.appName = 'appName';
	req.locals.appService = 'apiservice';
	req.locals.appDevice = 'Web';
	req.locals.appFEVersion = '0';

	req.locals.orderPlatform = 'WEB';

	req.locals.appSettings = {};


	let appOs = req.headers.appos;
	if (utility.checkEmpty(appOs)) {
		appOs = 'Web';
	}
	req.locals.appOs = appOs;

	let appPkg = req.headers.pkg;
	if (utility.checkEmpty(appPkg)) {
		appPkg = '';
	}

	req.locals.pkgName = appPkg;


	let apilog = {};
	apilog['apilog_Product'] = req.locals.appService + '-nodeJs';
	let ipAdd = "";
	try {
		ipAdd = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
		if (!utility.checkEmpty(req.headers['x-forwarded-for'])) {
			let ipAddArr = req.headers['x-forwarded-for'].split(',');
			if (!utility.checkEmpty(ipAddArr) && ipAddArr.length > 0 && !utility.checkEmpty(ipAddArr[0])) {
				ipAdd = ipAddArr[0];
			}
		} else {
			ipAdd = req.socket.remoteAddress;
		}
	} catch (e) {
		ipAdd = 0;
	}


	req.locals.clientIp = ipAdd;//.substr(7, 20); 
	apilog['apilog_Request_Method'] = req.method;
	apilog['apilog_Ip'] = req.locals.clientIp;

	let logorigin = req.headers['x-requested-with'];
	if (utility.checkEmpty(logorigin)) {
		if (!utility.checkEmpty(req.headers.origin)) {
			logorigin = req.headers.origin;
		} else {
			logorigin = req.headers.host;
		}
	}

	apilog['apilog_Request_Origin'] = logorigin;
	var urlString = req.originalUrl;
	apilog['apilog_Request_Url'] = urlString;
	var fullUrl = req.protocol + '://' + req.get('host') + urlString;
	apilog['apilog_Full_Url'] = fullUrl;
	apilog['apilog_Request_Headers'] = JSON.stringify(req.headers);
	apilog['apilog_Request_Body'] = JSON.stringify(req.body);
	req.locals.tz = constants.vals.tz;
	let now = utility.carbon.now(req);
	req.locals.now = now;
	//dbquery.insertSingle(constants.vals.commonDB, 'apilog', apilog);

	let data_apilog = Object.assign({}, apilog);
	data_apilog['apilog_Request_Headers'] = req.headers;
	data_apilog['apilog_Request_Body'] = req.body;
	data_apilog['created_at'] = req.locals.now;
	try {
		if (!_s.include(urlString, 'external/cart/wp3dsrequestframe')) {
			let logData = {};
			logData.group = 'apilog';
			logData.obj = data_apilog;
			//await utility.putCwLog(req, logData);
			//constants.vals.mongodbconn[constants.vals.commonDB].model("apilog")(data_apilog).save();//
			//console.log('urlString - ', urlString);
		}

	} catch (e) {
		console.log('MDB ERR', e);
	}

	let apiOrigin = logorigin.split('.');


	if (req.method == 'POST' || req.method == 'GET') {

		let wrl = req.headers.origin;
		req.locals.serviceUrl = req.headers.host
		if (utility.checkEmpty(wrl)) {
			wrl = req.headers.host;
		}

		req.locals.appUrl = wrl;




		req.locals.appFEVersion = {};
		req.locals.appFEVersion[appOs] = 0;
		if (!utility.checkEmpty(req.headers.av) && !utility.checkEmpty(appOs)) {
			req.locals.appFEVersion[appOs] = utility.parseAppVersion(req.headers.av);
		}



		//req.locals.appSettings = await dbquery.getAppSettings(req, req.locals.appOrderFrom);
		if (_s.include(req.url, 'api/external')) {
			next();
		} else {

			req.locals.storeSettings = {};


			moment.tz.setDefault(constants.vals.defaultTimezone);
			let now = utility.carbon.now(req);
			req.locals.now = now;
			req.locals.tz = constants.vals.defaultTimezon;
			next();
		}


	} else if ((req.route.method).includes('OPTIONS')) {
		return response('Success', 200);
	} else {
		return next();
	}



})

module.exports = router;


