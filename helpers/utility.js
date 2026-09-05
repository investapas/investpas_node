"use strict";
const constants = require("../vars/constants");
const messages = require("../vars/messages");
const methods = require("./methods")
const dbquery = require("./query");

const moment = require('moment-timezone');
const Validator = require('validatorjs');
const axios = require('axios');
const dbQuery = require("../helpers/query");
const _ = require('underscore');
const _s = require("underscore.string");
const useragent = require('useragent');
const base64url = require('base64url');
const crypto = require("crypto");
const db = require('../config/mysqlClient');
const admin = require("../helpers/firebase");
const fs = require("fs");
const path = require("path");
const configPath = path.join(__dirname, "../config/smsConfig.json");

useragent(true);

const utility = exports;

exports.loginAndSendVCA = async (payload) => {
	try {
		// Step 1: Login and get the auth token
		const loginResponse = await axios.get('http://211.171.190.220:16118/api/login', {
			headers: {
				'x-account-id': 'sdk',
				'x-account-pass': 'Innodep1@',
				'x-account-group': 'group1',
				'x-license': 'licVCA',
				'x-vms-id': '191668'
			}
		});

		const authToken = loginResponse.data?.results?.auth_token;
		const apiSerial = loginResponse.data?.results?.api_serial;

		if (!authToken || !apiSerial) {
			throw new Error('Failed to retrieve auth token or api serial');
		}

		console.log('Login Success');

		const testPayload = {
			camera_id: '100002_0',
			event_id: 204,
			event_msg: payload.event_msg,
			event_time: payload.event_time,
			event_status: payload.event_status
		}

		// Step 2: Send VCA Event
		const sendVCAResponse = await axios.post('http://211.171.190.220:16118/api/event/send-vca', testPayload, {
			headers: {
				'x-auth-token': authToken,
				'x-api-serial': apiSerial,
			}
		});

		console.log('Send VCA Response:', sendVCAResponse.data);

		return sendVCAResponse.data;

	} catch (error) {
		console.error('API Error:', error?.response?.data || error.message);
		throw error;
	}
};

exports.sendSMS = async (mobileNo, otp) => {
	try {

		const configData = fs.readFileSync(configPath, "utf-8");
		const config = JSON.parse(configData);

		const payload = {
			key: config.key,
			sender: config.sender,
			text: config.text + otp,
			receiver: mobileNo
		};

		console.log('payload', payload);

		const response = await axios.post('https://direct.smart.bz/api/P2001', payload, {
			headers: {
				'Cookie': 'cookiesession1=678A3E222F2D07AC909D120D7A010170',
			}
		});

		console.log(response);
		console.log("adhsadasjh");
		
		

		console.log('response', response.data);

		return;

	} catch (error) {
		console.log('error sending sms', error);
		throw error;
	}
};

exports.generateOtp = async (length) => {
	const digits = '0123456789';
	let otp = '';
	for (let i = 0; i < length; i++) {
		otp += digits[Math.floor(Math.random() * 10)];
	}
	return otp;
}

exports.sendNotification = async (tokens, route, id, notificationContent) => {
	const message = {
		data: {
			"routs": route || "",
			"id": id.toString() || ""
		},
		notification: notificationContent,
		tokens: tokens
	}
	console.log('message', message);
	admin.messaging().sendEachForMulticast(message)
		.then((response) => {
			console.log('Successfully sent message: ', response.responses[0]);
			if (response.failureCount > 0) {
				const failedTokens = [];
				response.responses.forEach((resp, idx) => {
					if (!resp.success) {
						failedTokens.push(tokens[idx]);
					}
				});
				console.log("List of tokens that failed: ", failedTokens);
			}
		})
		.catch((error) => {
			console.log('Error Sending Message: ', error);
		})
}

// Add data into the authentication log table
exports.addAuthenticationLogs = async (userId, logAction, logStatus, ipAddress) => {
	const data = {
		user_Id: userId,
		auth_log_Action: logAction,
		auth_log_Status: logStatus,
		auth_log_IP: ipAddress,
		created_at: new Date()
	}

	await dbquery.insertSingle(constants.vals.defaultDB, 'authentication_log', data);
	return;
}

// Add data to the api log table
exports.addApiLogs = async (apiLogObj) => {
	await db.query(
		'INSERT INTO api_log (api_log_Endpoint, api_log_Method, api_log_Request, api_log_Response, api_log_StatusCode) VALUES (?, ?, ?, ?, ?)',
		[apiLogObj?.api_log_Endpoint, apiLogObj?.api_log_Method, apiLogObj?.api_log_Request, apiLogObj?.api_log_Response, apiLogObj?.api_log_StatusCode]
	);
}

// Response handler function to encrypt response and add data to the api log table
exports.responseHandler = async (response, apiLogObj, code, res) => {

	// Set api log table data
	apiLogObj.api_log_Response = data?.security_text;
	apiLogObj.api_log_StatusCode = code;

	// Add api log data
	await this.addApiLogs(apiLogObj);

	res.status(code).json(data);
}

exports.getUserAgent = async function (req) {
	var agent = useragent.parse(req.headers['user-agent']);

	if (!utility.checkEmpty(agent) && !utility.checkEmpty(agent.os) && !utility.checkEmpty(agent.os.family)) {
		if (agent.os.family.toUpperCase() == 'IOS') {
			agent.appos = 'IOS';
		} else if (agent.os.family.toUpperCase() == 'ANDROID') {
			agent.appos = 'ANDROID';
		}
	} else {
		agent = {};
	}
	return agent;
}

exports.ucwords = function (str) {
	return (str + '').replace(/^([a-z])|\s+([a-z])/g, function ($1) {
		return $1.toUpperCase();
	});
}

exports.getCurrencyCode = function () {
	var code = "£";
	return code;
}

exports.getCurrencyCountryCode = function (countryCode) {
	var code = "£";
	if (countryCode == '91') {
		code = "₹";
	} else if (countryCode == '92') {
		code = "₨";
	} else if (countryCode == '353') {
		code = "£";
	} else if (countryCode == '44') {
		code = "£";
	} else if (countryCode == '1') {
		code = "$";
	} else if (countryCode == '61') {
		code = "$";
	}
	return code;
}

exports.getCustomerTelCountry = function (countryCode) {
	var code = "United Kingdom";
	if (countryCode == '91') {
		code = "India";
	} else if (countryCode == '92') {
		code = "Pakistan";
	} else if (countryCode == '353') {
		code = "Ireland";
	} else if (countryCode == '44') {
		code = "United Kingdom";
	} else if (countryCode == '1') {
		code = "Canada";
	} else if (countryCode == '61') {
		code = "Australia";
	}
	return code;
}

exports.decimalFormat = function (val) {
	let c = 1
	let res = Math.round(val).toFixed(2);
	if (utility.checkEmpty(res)) {
		return "0.0";
	}
	return res;
}

exports.getGoogleAddressLatLng = async function (req, lat, lng) {
    try {
        // ✅ Step 1: Fetch Google Maps API key from DB (key_Name = 'backend')
        const keyData = await dbQuery.fetchSingleRecord(
            constants.vals.defaultDB,
            'google_map_api_key',
            "WHERE key_Name = 'backend' LIMIT 1",
            'google_map_keys'
        );

        const apikey = keyData?.google_map_keys || constants.vals.google_api;

        // ✅ Step 2: Initialize variables
        var cityName = "";
        var street = "";
        var county = "";
        var town = "";
        var distance = 0;
        var postcode = "";
        var address_uk_Latitude = "";
        var address_uk_Longitude = "";
        var disDetails = "";
        var rsp = "";
        var address = "";
        var route = "";
        var political = "";
        var for_route = "";
        var for_political = "";
        var addres = "";

        // ✅ Step 3: Make Google Geocode API request
        var url_address = "https://maps.google.com/maps/api/geocode/json?sensor=false&key=" + apikey + "&latlng=" + lat + ',' + lng;
        var resp_json_addres = await utility.curl_gapi_file_get_contents(url_address);

        var resp_address = "";
        if (!utility.checkEmpty(resp_json_addres)) {
            resp_address = JSON.parse(resp_json_addres);

            if (resp_address['status'] == 'OK') {

                if (utility.issetNested(resp_address, 'results', '0', 'address_components')) {
                    address = resp_address['results'][0]['address_components'];
                }

                route = ''; political = '';
                for_route = true; for_political = true;

                for (let k in address) {
                    addres = address[k];
                    if (utility.issetNested(addres, 'types', '0') && addres['types'][0] == 'route' && for_route) {
                        for_route = false;
                        route = addres['long_name'];
                    }
                    if (utility.issetNested(addres, 'types', '0') && addres['types'][0] == 'postal_code') {
                        postcode = addres['long_name'];
                    }
                }

                if (utility.issetNested(address, 1, 'long_name')) street = address[1]['long_name'];
                if (utility.issetNested(address, 2, 'long_name')) town = address[2]['long_name'];
                if (!utility.checkEmpty(address[3]) && !utility.checkEmpty(address[3]['long_name'])) county = address[3]['long_name'];
                if (utility.checkEmpty(route) && utility.issetNested(address, 2, 'long_name')) route = address[2]['long_name'];
                street = route;
                if (utility.issetNested(address, 3, 'long_name')) cityName = address[3]['long_name'];

                if (utility.issetNested(resp_address, 'results', 0, 'geometry', 'location', 'lat')) {
                    lat = resp_address['results'][0]['geometry']['location']['lat'];
                }

                if (utility.issetNested(resp_address, 'results', 0, 'geometry', 'location', 'lng')) {
                    lng = resp_address['results'][0]['geometry']['location']['lng'];
                }

                if (utility.checkEmpty(postcode)) {
                    let response = utility.fetchPostcodeAddress(resp_address.results);
                    response.latitude = lat;
                    response.longitude = lng;
                    return response;
                }
            }
        }

        // ✅ Step 4: Default response
        var response = {};
        response['postcode'] = postcode;
        response['city'] = cityName;
        response['street'] = street;
        response.latitude = lat;
        response.longitude = lng;
        return response;

    } catch (error) {
        console.error('Error in getGoogleAddressLatLng:', error);
        return { status: 'error', msg: 'Unable to fetch address details' };
    }
};


exports.fetchPostcodeAddress = function (resp_address_data) {

	var cityName = "";
	var street = "";
	var county = "";
	var town = "";
	var distance = 0;
	var postcode = "";
	var address_uk_Latitude = "";
	var address_uk_Longitude = "";
	var disDetails = "";
	var rsp = "";
	var address = "";
	var route = "";
	var political = "";
	var for_route = "";
	var for_political = "";
	var addres = "";
	var lat = "";
	var lng = "";

	for (let k in resp_address_data) {
		let resp_address = resp_address_data[k];
		let address = {};
		if (utility.issetNested(resp_address, 'address_components')) {
			address = resp_address['address_components'];
		}
		//route = ''; 
		political = '';
		for_route = true; for_political = true;
		for (let k in address) {
			addres = address[k];
			if (utility.issetNested(addres, 'types', '0') && addres['types'][0] == 'route' && for_route) {
				for_route = false;
				route = addres['long_name'];
			}
			if (utility.issetNested(addres, 'types', '0') && addres['types'][0] == 'postal_code' && postcode == '') {
				postcode = addres['long_name'];
			}

			if (utility.issetNested(addres, 'types', '0') && addres['types'][0] == 'postal_town' && cityName == '') {
				cityName = addres['long_name'];
			}
		}
		//console.log('route - ', route);

		if (utility.issetNested(address, 1, 'long_name') && street == '') {
			//street = address[1]['long_name'];
		}

		if (utility.issetNested(address, 2, 'long_name')) {
			town = address[2]['long_name'];
		}

		if (!utility.checkEmpty(address[3]) && !utility.checkEmpty(address[3]['long_name'])) {
			county = address[3]['long_name'];
		}
		if (utility.checkEmpty(route) && utility.issetNested(address, 2, 'long_name')) {
			//route = address[2]['long_name'];
		}


		if (street == '') {
			street = route;
		}
		//console.log('street - ', street);
		if (utility.issetNested(address, 3, 'long_name') && cityName == '') {
			cityName = address[3]['long_name'];
		}
	}


	var response = {};
	response['postcode'] = postcode;
	response['city'] = cityName;
	response['street'] = street;
	response['lat'] = lat;
	response['lng'] = lng;
	return response;
};

exports.randomNumber = function (length) {
	var text = "";
	var possible = "123456789";
	for (var i = 0; i < length; i++) {
		var sup = Math.floor(Math.random() * possible.length);
		text += i > 0 && sup == i ? "0" : possible.charAt(sup);
	}
	return Number(text);
};

exports.randomNumberMinMax = function (min, max, length) {
	var text = "";
	var numArr = []
	for (let i = min; i <= max; i++) {
		numArr.push(i)
	}
	var possible = numArr.join('') + "";
	for (var i = 0; i < length; i++) {
		var sup = Math.floor(Math.random() * possible.length);
		text += i > 0 && sup == i ? "0" : possible.charAt(sup);
	}
	return Number(text);
};

exports.str_random = function (length) {
	var result = '';
	var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	var charactersLength = characters.length;
	for (var i = 0; i < length; i++) {
		result += characters.charAt(Math.floor(Math.random() * charactersLength));
	}
	return result;
};



exports.base64encode = function (str) {
	let encoded = Buffer.from(str).toString('base64');
	return encoded;
};
exports.base64decode = function (str) {
	let encoded = Buffer.from(str, 'base64').toString('ascii');//Buffer.from(str).toString('base64');
	return encoded;
}

exports.base64urlencode = function (str) {
	let encoded = base64url(str);
	return encoded;
};

exports.checkEmpty = function (mixedVar) {
	var key;
	if (typeof mixedVar == 'object') {
		for (key in mixedVar) {
			if (Object.hasOwnProperty.bind(mixedVar)(key)) {
				return false;
			}
		}
		return true;
	} else {
		var undef;

		var i;
		var len;
		var emptyValues = [undef, null, 'null', false, 0, '', '0', '0.00', '0.0', 'empty', undefined, 'undefined'];
		if (typeof mixedVar == 'string') {
			mixedVar = mixedVar.trim();
		}

		for (i = 0, len = emptyValues.length; i < len; i++) {
			if (mixedVar == emptyValues[i]) {
				return true;
			}
		}


	}
	return false;
};

exports.checkEmptyString = function (mixedVar) {
	var undef;
	var key;
	var i;
	var len;
	var emptyValues = [undef, null, 'null', false, 0, '', '0', '0.00', '0.0', 'empty', undefined, 'undefined'];
	if (typeof mixedVar == 'string') {
		mixedVar = mixedVar.trim();
	}
	for (i = 0, len = emptyValues.length; i < len; i++) {
		if (mixedVar == emptyValues[i]) {
			return true;
		}
	}
	return false;
};

exports.isset = function (obj, key) {

	if (_.has(obj, key)) {
		return true;
	} else {
		return false;
	}

};




exports.number_format = function (number, decimals, dec_point, thousands_sep) {
	number = (number + '').replace(/[^0-9+\-Ee.]/g, '');
	var n = !isFinite(+number) ? 0 : +number,
		prec = !isFinite(+decimals) ? 0 : Math.abs(decimals),
		sep = (typeof thousands_sep == 'undefined') ? ',' : thousands_sep,
		dec = (typeof dec_point == 'undefined') ? '.' : dec_point,
		s = '',
		toFixedFix = function (n, prec) {
			var k = Math.pow(10, prec);
			return '' + Math.round(n * k) / k;
		};
	// Fix for IE checkFloat(0.55).toFixed(0) = 0;
	s = (prec ? toFixedFix(n, prec) : '' + Math.round(n)).split('.');
	if (s[0].length > 3) {
		s[0] = s[0].replace(/\B(?=(?:\d{3})+(?!\d))/g, sep);
	}
	if ((s[1] || '').length < prec) {
		s[1] = s[1] || '';
		s[1] += new Array(prec - s[1].length + 1).join('0');
	}
	return s.join(dec);
};

exports.checkInt = function (num) {
	num = parseInt(num);
	if (isNaN(num) || num == "" || num == 0 || num == '0') {
		return 0;
	}
	else {
		return num;
	}
};

exports.checkFloat = function (num) {
	num = parseFloat(num);
	if (isNaN(num) || num == 0.00 || num == "" || num == 0 || num == '0') {
		return 0.00;
	}
	else {
		num = utility.formatTotal(num);
		num = parseFloat(num);
		if (isNaN(num) || num == 0.00 || num == "" || num == 0 || num == '0') {
			return 0.00;
		}
		else {
			return num;
		}
	}
};

exports.formatTotal = function (num) {
	return utility.number_format(Math.round(num * 100) / 100, 2, '.', '');
};

exports.countItems = function (items) {
	var i = 0; var k;

	for (k in items) {
		if (true) {
			i++;
		}
	}
	return i;
};


exports.deg2rad = function (deg) {
	return deg * (Math.PI / 180)
}


exports.carbon = {
	now: function (req) {
		return moment().tz(req.locals.tz).format('YYYY-MM-DD HH:mm:ss');
	},
	parse: function (date) {
		return moment.parseZone(date).format('YYYY-MM-DD HH:mm:ss');
	},
	parseZone: function (req, date) {
		return moment.parseZone(date).tz(req.locals.tz).format('YYYY-MM-DD HH:mm:ss');
	},
	yesterday: function (req) {
		return moment().subtract(1, 'days').tz(req.locals.tz).format('YYYY-MM-DD HH:mm:ss');
	},
	tomorrow: function (req) {
		return moment().add(1, 'days').tz(req.locals.tz).format('YYYY-MM-DD HH:mm:ss');
	},
	format: function (date, frmt) {
		return moment.parseZone(date).format(frmt);
	},
	toUtc: function (date) {
		return moment(date).utcOffset('+0000').format('YYYY-MM-DD HH:mm:ss');
	},
	strtotime: function (req, date) {
		return moment(date).tz(req.locals.tz).valueOf() / 1000;//new Date(date).getTime() / 1000;
	},
	isGreater: function (date1, date2) {
		date1 = moment.parseZone(date1);
		date2 = moment.parseZone(date2);
		if (date1 > date2) {
			return true;
		} else {
			return false;
		}
	},
	isGreaterOrEqual: function (date1, date2) {
		date1 = moment.parseZone(date1);
		date2 = moment.parseZone(date2);
		if (date1 >= date2) {
			return true;
		} else {
			return false;
		}
	},
	isLessOrEqual: function (date1, date2) {
		date1 = moment.parseZone(date1);
		date2 = moment.parseZone(date2);
		if (date1 <= date2) {
			return true;
		} else {
			return false;
		}
	},
	addDay: function (date, day) {
		//return  moment.parseZone(date).add(day,'days').tz(req.locals.tz).format('YYYY-MM-DD HH:mm:ss');
		return moment.parseZone(date).add(day, 'days').format('YYYY-MM-DD HH:mm:ss');
	},
	addMonth: function (date, months) {
		//return  moment.parseZone(date).add(day,'days').tz(req.locals.tz).format('YYYY-MM-DD HH:mm:ss');
		return moment.parseZone(date).add(months, 'months').format('YYYY-MM-DD HH:mm:ss');
	},
	addDayFormat: function (date, day, frmt) {
		//return  moment.parseZone(date).add(day,'days').tz(req.locals.tz).format('YYYY-MM-DD HH:mm:ss');
		return moment.parseZone(date).add(day, 'days').format(frmt);
	},
	subDay: function (date, day) {
		return moment.parseZone(date).subtract(day, 'days').format('YYYY-MM-DD HH:mm:ss');
	},
	addMinutes: function (date, minutes) {
		return moment.parseZone(date).add(minutes, 'minutes').format('YYYY-MM-DD HH:mm:ss');
	},
	addSeconds: function (date, seconds) {
		return moment.parseZone(date).add(seconds, 'seconds').format('YYYY-MM-DD HH:mm:ss');
	},
	diff: function (date1, date2, unit) {
		date1 = moment.parseZone(date1);
		date2 = moment.parseZone(date2);
		return date1.diff(date2, unit, true);
	},
	unix: function (date) {
		return moment.unix(date).format('YYYY-MM-DD HH:mm:ss');;
	},
	timestamp: function (date) {
		return moment.parseZone(date);
	},
	toUtcZone: async function (req, date) {
		return moment(date).utcOffset('+0000');
	},
	dayNumber: (date) => {
		let days = {
			'Monday': '1',
			'Tuesday': '2',
			'Wednesday': '3',
			'Thursday': '4',
			'Friday': '5',
			'Saturday': '6',
			'Sunday': '7'
		}
		let weekNumber = days[moment(date).format('dddd')];
		return weekNumber;
	},
	dayName: (date) => {
		return moment(date).format('dddd');
	}
};


exports.cleanString = function (string) {
	string = string.trim();
	string = string.replace(/ /g, '-');
	string = string.replace(/[^A-Za-z0-9\-]/g, '');
	string = string.replace(/-+/g, '-');
	return string;
};

exports.clearString = function (string) {
	string = string.trim();
	string = string.replace(/ /g, '-');
	string = string.replace(/[^A-Za-z0-9\-]/g, '');
	string = string.replace(/-+/g, '');
	return string;
};

exports.clearPostcodeString = function (string) {
	var str = '';
	if (!utility.checkEmpty(string)) {
		string = string + '';
		string = string.trim();
		string = string.replace(/ /g, '-');
		string = string.replace(/[^A-Za-z0-9\-]/g, '');
		string = string.replace(/-+/g, '');
		string = string.toUpperCase();
		string = string.trim();
		str = string;
	}
	return str;
};

exports.issetNested = function (obj, ...args) {
	return args.reduce((obj, level) => obj && obj[level], obj)
};

exports.objToPluck = function (obj, key, val) {
	var objarr = {};

	for (var k in obj) {
		if (key == '') {
			objarr[k] = obj[k][val];
		} else {
			objarr[obj[k][key]] = obj[k][val];
		}

	}
	return objarr;
};

exports.objToPluckArr = function (obj, val) {
	var objarr = [];
	for (var k in obj) {
		objarr.push(obj[k][val]);

	}
	return objarr;
};

exports.splitIndex = function (input, len) {
	return input.match(new RegExp('.{1,' + len + '}(?=(.{' + len + '})+(?!.))|.{1,' + len + '}', 'g'));
};
exports.objectNext = function (obj, key) {
	var keys = Object.keys(obj), i = keys.indexOf(key);
	return i !== -1 && keys[i + 1] && obj[keys[i + 1]];
};
exports.objectLast = function (obj) {
	var size = 0, key;
	for (key in obj) {
		if (obj.hasOwnProperty(key)) size++;
	}
	return key;
};
exports.objectSize = function (obj) {
	var size = 0, key;
	for (key in obj) {
		if (obj.hasOwnProperty(key)) size++;
	}
	return size;
};

exports.array_count_values = function (arr) {
	var counts = {};
	if (utility.checkEmpty(arr)) {
		return counts;
	}
	var key = "";
	for (var i = 0; i < arr.length; i++) {
		key = arr[i];
		counts[key] = (counts[key]) ? counts[key] + 1 : 1;

	}
	return counts;
};

exports.pretty_url = function (str) {
	str = str.replace(/^\s+|\s+$/g, ''); // trim
	str = str.toLowerCase();

	// remove accents, swap ñ for n, etc
	var from = "àáäâèéëêìíïîòóöôùúüûñç·/_,:;";
	var to = "aaaaeeeeiiiioooouuuunc------";
	for (var i = 0, l = from.length; i < l; i++) {
		str = str.replace(new RegExp(from.charAt(i), 'g'), to.charAt(i));
	}

	str = str.replace(/[^a-z0-9 -]/g, '') // remove invalid chars
		.replace(/\s+/g, '-') // collapse whitespace and replace by -
		.replace(/-+/g, '-'); // collapse dashes


	//store_name = store_name.trim();
	str = str.toLowerCase();
	//store_name = store_name.replace("![^a-z0-9]+!i", "-")
	return str;
};


exports.substr_replace = function (str, replace, start, length) {
	if (start < 0) {
		start = start + str.length;
	}
	length = length !== undefined ? length : str.length;
	if (length < 0) {
		length = length + str.length - start;
	}

	return [
		str.slice(0, start),
		replace.substr(0, length),
		replace.slice(length),
		str.slice(start + length)
	].join('');
};



exports.getMessages = function (msg, fix) {
	var data = '';
	if (!utility.checkEmpty(messages.vals[msg])) {
		data = messages.vals[msg];
	}
	return data;
};

exports.getDistanceFromLatLon = function (lat1, lon1, lat2, lon2, unit) {
	if ((lat1 == lat2) && (lon1 == lon2)) {
		return 0;
	}
	else {
		var radlat1 = Math.PI * lat1 / 180;
		var radlat2 = Math.PI * lat2 / 180;
		var theta = lon1 - lon2;
		var radtheta = Math.PI * theta / 180;
		var dist = Math.sin(radlat1) * Math.sin(radlat2) + Math.cos(radlat1) * Math.cos(radlat2) * Math.cos(radtheta);
		if (dist > 1) {
			dist = 1;
		}
		dist = Math.acos(dist);
		dist = dist * 180 / Math.PI;
		dist = dist * 60 * 1.1515;
		if (unit == "K") { dist = dist * 1.609344 }
		if (unit == "N") { dist = dist * 0.8684 }
		return dist;
	}
}

exports.telFormat = function (num) {
	num = " " + num + " ";
	num = num.replace(/\s/g, '');
	num = parseInt(num);
	return num;
}

exports.strFormat = function (str) {
	str = "" + str + "";
	return str;
};

exports.trimMobile = function (num) {
	if (!utility.checkEmpty(num)) {
		num = " " + num + " ";
		num = num.replace(/\s/g, '');
		num = num.replace("/[^0-9]/", "");
		num = "" + num + "";
		num = num.trim();
		num = num.substr(-10);
	}
	return num;
};

exports.getRand = function () {
	return _.random(1000, 9999);
}


exports.getISOCountryCode = function (req, store_Country) {
	var code = "GB";
	if (!utility.checkEmpty(store_Country)) {
		if (store_Country == 'United Kingdom') {
			code = "GB";
		} else if (store_Country == 'India') {
			code = "IN";
		} else if (store_Country == 'Pakistan') {
			code = "PK";
		}
	}
	return code;
}

exports.getISOCountryCurrency = function (req, store_Country) {
	var code = "GBP";
	if (!utility.checkEmpty(store_Country)) {
		if (store_Country == 'United Kingdom') {
			code = "GBP";
		} else if (store_Country == 'India') {
			code = "INR";
		} else if (store_Country == 'Pakistan') {
			code = "PKR";
		}
	}
	return code;
};

exports.getAppUrl = function (req) {
	var url = req.locals.appUrl;
	url = utility.urlHostname(url);
	url = "https://" + url;
	return url;
};

exports.getUrl = function (req) {
	var url = request.headers.host;
	url = utility.urlHostname(url);
	url = "www." + url;
	return url;
};

exports.getServiceUrl = function (req) {
	var url = req.locals.serviceUrl;
	url = utility.urlHostname(url);
	url = "https://" + url;
	return url;
}

exports.formatUrl = function (url) {
	url = utility.urlHostname(url);
	url = "www." + url;
	return url;
};

exports.urlHostname = function (url) {
	url = url.replace(/https:\/\//g, '');
	url = url.replace(/http:\/\//g, '');
	url = url.replace(/www./g, '');
	return url;
};



exports.validateServerIp = function (ssip) {
	var servers = constants.vals.validDbs;
	if (!_.contains(servers, ssip)) {
		ssip = utility.getStoreServerIp();
	}
	return ssip;
};



exports.getStoreServerIp = function () {
	// to do
	return 'mysql_dine_server_uk';
};

exports.curl_api_content = async (url, method, headers, jsonData) => new Promise(
	(resolve, reject) => {
		try {
			jsonData = JSON.parse(jsonData);
		} catch (e) {
			//console.log("<<<<< <<<< <<<< curl_api_content >>> >>> >>>", e, jsonData)
		}


		request({
			url: url,
			method: method,
			headers: headers,
			json: jsonData,
		}, function (error, response, body) {
			// console.log(response , "<<<<<< <<<< <<< 918")
			if (error) {
				let x = {};
				x['resp'] = response;
				x['err'] = error;
				console.log("<<<<< <<<< <<<< 922 >>> >>> >>>", error)
				reject(error);
				return;
			}
			resolve(body);
		});
	});

exports.run_axios_api = async function (url, httpMethod, header, data) {

	let config = {
		method: httpMethod,
		url: url,
		headers: header
	};
	if (!utility.checkEmpty(data)) {
		config.data = data;
	}

	let val = "";

	await axios(config)
		.then(function (response) {
			//val = JSON.stringify(response.data);
			val = response.data;//JSON.parse(val)
		})
		.catch(function (error) {
			// console.log('1 -------------------');
			// console.log(error.response.status);
			// console.log('2 -------------------');
			// console.log(error.statusText);
			// console.log('3 -------------------');
			// console.log(error.response);
			// console.log('4 -------------------');
			if (error.response) {
				// The request was made and the server responded with a status code
				// that falls out of the range of 2xx
				//console.log(error.response.data);
				val = error.response.data;
				if (utility.checkEmpty(val)) {
					val = error.response.statusText;
				}
				//console.log(error.response.status);
				//console.log(error.response.statusText);
			} else if (error.request) {
				// The request was made but no response was received
				// `error.request` is an instance of XMLHttpRequest in the browser and an instance of
				// http.ClientRequest in node.js
				console.log(error.request);
			} else {
				// Something happened in setting up the request that triggered an Error
				//console.log('Error', error.message);
			}
			//console.log(error.config);
		});

	return val
};

exports.curl_gapi_file_get_contents = async function (url) {

	let config = {
		method: 'get',
		maxBodyLength: Infinity,
		url: url,
		headers: {}
	};

	let val = "";
	await axios.request(config)
		.then((response) => {
			val = JSON.stringify(response.data);
			console.log(JSON.stringify(response.data));
		})
		.catch((error) => {
			console.log(error);
		});
	//console.log('val - ', val);
	return val;
	//return await utility.run_axios_api(url, 'get', {}, {});;
};

exports.getPrettyTime = function (time) {
	time = utility.carbon.format(time, 'hh:mm a dddd Do MMMM YYYY');
	return time;
};


exports.curl_get_contents = async (url) => new Promise(
	(resolve, reject) => {
		let jsonData = {};
		request({
			url: url,
			method: 'GET',
			headers: {
				"Cache-Control": "no-cache",
				"Content-Type": "application/json"
			},
			json: jsonData,
		}, function (error, response, body) {
			if (error) {
				reject(error);
				return;
			}
			resolve(body);
		});
	});

exports.mt_rand = async function (min, max) {

	const argc = arguments.length
	if (argc === 0) {
		min = 0
		max = 2147483647
	} else if (argc === 1) {
		throw new Error('Warning: mt_rand() expects exactly 2 parameters, 1 given')
	} else {
		min = parseInt(min, 10)
		max = parseInt(max, 10)
	}
	return Math.floor(Math.random() * (max - min + 1)) + min
}


exports.convert2HTTPS_URL = async function (url) {
	if (!utility.checkEmpty(url)) {
		var urlArr = url.split("://")
		return "https://" + urlArr[1];
	} else {
		return url;
	}
};


exports.setString = function (str) {
	var rStr = '';
	if (!utility.checkEmpty(str)) {
		rStr = '' + str + '';
	}
	return rStr;
}
exports.checkStr = function (str) {
	var rStr = '';
	if (!utility.checkEmpty(str)) {
		rStr = '' + str + '';
	}
	return rStr;
};
exports.sleep = async function (ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
};


exports.getRandomShuffleArr = async function (arr, n) {
	var result = new Array(n),
		len = arr.length,
		taken = new Array(len);
	if (n > len)
		return arr;
	while (n--) {
		var x = Math.floor(Math.random() * len);
		result[n] = arr[x in taken ? taken[x] : x];
		taken[x] = --len in taken ? taken[len] : len;
	}
	return result;
};

exports.prepareJoinedString = function (str, newId, separator) {
	var objarr = [];
	str = str.split(separator);
	var fstr = {};
	for (let k in str) {
		if (!utility.checkEmpty(str[k])) {
			fstr[str[k]] = str[k];
		}
	}
	fstr[newId] = newId;
	var finaldata = '';
	for (let k in fstr) {
		finaldata += separator + fstr[k];
	}
	finaldata += separator;
	return finaldata;
};

exports.parseValidationFirstError = function (errors) {
	if (utility.checkEmpty(errors)) {
		return 'Invalid Data';
	} else {
		let error = errors[Object.keys(errors)[0]];
		if (utility.checkEmpty(error)) {
			return 'Invalid Data';
		}
		return error[0];
	}
};

exports.parseAppVersion = function (av) {
	if (utility.checkEmpty(av)) {
		return 0;
	} else {
		let v = av;
		let fVersion = v.split('.').reduce((a, b) => parseInt(a) * 100 + parseInt(b), 0);
		fVersion = parseInt(fVersion);
		return fVersion;
	}
};

exports.parseAppNameReq = async function (req, appname) {
	var orderPlatform = "WEB";
	if (!utility.checkEmpty(req.locals.appOs)) {
		orderPlatform = req.locals.appOs.toUpperCase();
	}
	if (orderPlatform == 'WEB') {
		let usragnt = await utility.getUserAgent(req);
		if (!utility.checkEmpty(usragnt.appos)) {
			orderPlatform = usragnt.appos;
			req.locals.appOs = usragnt.appos;
		}
	}
	if (!utility.checkEmpty(appname)) {
		if (appname == 'DineOrder' || appname == 'DineOrderWeb') {
			// req.locals.default_order_device = 'Portal';
			// req.locals.default_terminal = 'DineOrder';



			req.locals.default_order_device = 'DineOrder';
			req.locals.default_terminal = 'Website';

			req.locals.appName = 'DineOrder';
			req.locals.appNameCol = 'Foodfinder';
			req.locals.appNameCache = 'dineorder';
			req.locals.appService = 'dineservice';
			req.locals.appOrderMode = 'DineOrderWeb';
			req.locals.appOrderFrom = 'Portal';

			req.locals.orderSource = 'DINEORDER';
			req.locals.orderPlatform = orderPlatform;

		} else if (appname == 'KuickApp') {
			// req.locals.default_order_device = 'Portal';
			// req.locals.default_terminal = 'KuickApp';



			req.locals.default_order_device = 'DineOrder';
			req.locals.default_terminal = 'Website';

			req.locals.appName = 'DineOrder';
			req.locals.appNameCol = 'Foodfinder';
			req.locals.appNameCache = 'dineorder';
			req.locals.appService = 'kuickAppService';
			req.locals.appOrderMode = 'KuickApp';
			req.locals.appOrderFrom = 'Portal';

			req.locals.orderSource = 'KUICK';
			req.locals.orderPlatform = orderPlatform;

		} else if (appname == 'KuickWeb') {
			// req.locals.default_order_device = 'Portal';
			// req.locals.default_terminal = 'KuickWeb';

			req.locals.default_order_device = 'DineOrder';
			req.locals.default_terminal = 'Website';

			req.locals.appName = 'DineOrder';
			req.locals.appNameCol = 'Foodfinder';
			req.locals.appNameCache = 'dineorder';
			req.locals.appService = 'kuickWebService';
			req.locals.appOrderMode = 'KuickWeb';
			req.locals.appOrderFrom = 'Portal';

			req.locals.orderSource = 'KUICK';
			req.locals.orderPlatform = orderPlatform;

		} else if (appname == 'ProductApp') {
			req.locals.default_order_device = 'Website';
			req.locals.default_terminal = 'Website';
			req.locals.appName = 'Website';
			req.locals.appNameCol = 'Website';
			req.locals.appNameCache = 'website';
			req.locals.appService = 'webservice';
			req.locals.appOrderMode = 'ProductApp';
			req.locals.appOrderFrom = 'Website';
			req.locals.appDevice = 'App';

			req.locals.orderSource = 'PRODUCTAPP';
			req.locals.orderPlatform = orderPlatform;

			if (!utility.checkEmpty(req.headers.pkg)) {
				req.locals.pkgName = req.headers.pkg;
			}

		} else {
			req.locals.default_order_device = 'Website';
			req.locals.default_terminal = 'Website';
			req.locals.appName = 'Website';
			req.locals.appNameCol = 'Website';
			req.locals.appNameCache = 'website';
			req.locals.appService = 'webservice';
			req.locals.appOrderMode = 'ProductWebsite';
			req.locals.appOrderFrom = 'Website';

			req.locals.orderSource = 'WEBSITE';
			req.locals.orderPlatform = orderPlatform;
		}
	}
	req.locals.appSettings = await dbquery.getAppSettings(req, req.locals.appOrderFrom);

};

exports.getPaymentCardType = (number) => {
	if (number.match(new RegExp("^4")) !== null) {
		return "Visa";
	} else if (/^(5[1-5][0-9]{14}|2(22[1-9][0-9]{12}|2[3-9][0-9]{13}|[3-6][0-9]{14}|7[0-1][0-9]{13}|720[0-9]{12}))$/.test(number)) {
		return "Mastercard";
	} else if (number.match(new RegExp("^3[47]")) !== null) {
		return "AMEX";
	} else if (number.match(new RegExp("^(6011|622(12[6-9]|1[3-9][0-9]|[2-8][0-9]{2}|9[0-1][0-9]|92[0-5]|64[4-9])|65)")) !== null) {
		return "Discover";
	} else if (number.match(new RegExp("^36")) !== null) {
		return "Diners";
	} else if (number.match(new RegExp("^30[0-5]")) !== null) {
		return "Diners - Carte Blanche";
	} else if (number.match(new RegExp("^35(2[89]|[3-8][0-9])")) !== null) {
		return "JCB";
	} else if (number.match(new RegExp("^(4026|417500|4508|4844|491(3|7))")) !== null) {
		return "Visa Electron";
	}
	return "Others";
};

exports.genApiAppName = function (req) {
	var xAppname = 'APISERVICE';


	return xAppname;

};

exports.genAuthKey = async function (req, postData) {
	var response = {};
	var xAppname = utility.genApiAppName(req);
	var appsecret = constants.vals.secretKeys[constants.vals.app_env][xAppname];
	//console.log('appsecret - ', xAppname, constants.vals.secretKeys[constants.vals.app_env]);
	//console.log('appsecret - ', appsecret);

	if (utility.checkEmpty(postData)) {
		postData = { 'x-app': xAppname };
	}

	postData = JSON.stringify(postData);

	let signature = crypto.createHmac('sha1', appsecret).update(postData).digest('hex');

	return signature;

};

exports.verifyAuthKey = async function (req, postData, xAppname, xtoken) {
	var isValid = false;
	var appsecret = constants.vals.secretKeys[constants.vals.app_env][xAppname];

	if (utility.checkEmpty(appsecret)) {
		isValid = false;
		return isValid;
	}

	if (utility.checkEmpty(postData)) {
		postData = { 'x-app': xAppname };
	}
	postData = JSON.stringify(postData);

	let signature = crypto.createHmac('sha1', appsecret).update(postData).digest('hex');

	if (signature === xtoken) {
		isValid = true;
	}

	return isValid;
};


exports.successApiResponse = async function (req, res, response) {
	if (!utility.checkEmpty(req.locals.apptech) && req.locals.apptech == 'fpos') {
		response = await utility.nestedObjToStr(req, response);
	}
	return res.status(200).json(response);
};

exports.apiResponse = async function (req, res, response) {
	response = await utility.nestedObjToStr(req, response);

	const params = {
		api_log_Endpoint: req.originalUrl,
		api_log_Method: req.method,
		api_log_Request: JSON.stringify(req?.body),
		api_log_Response: JSON.stringify(response),
		api_log_StatusCode: 200,
		created_at: new Date()
	}

	await dbquery.insertSingle(constants.vals.defaultDB, 'api_log', params);

	return res.status(200).json(response);
};

exports.nestedObjToStr = async function (req, objData) {
	if (utility.checkEmpty(objData)) {
		return objData;
	}
	var resObj = {};
	resObj = await utility.nestedObjToStrRec(req, objData);

	return resObj;
};

exports.nestedObjToStrRec = async function (req, objData) {
	if (utility.checkEmpty(objData)) {
		if (typeof objData == 'object') {
			return objData;
		}
		return '' + objData;
	}

	if (typeof objData == 'object') {
		for (let k in objData) {
			if (!utility.checkEmpty(objData[k])) {

			}
			objData[k] = await utility.nestedObjToStrRec(req, objData[k]);
		}
	} else {
		objData = '' + objData;
	}

	return objData;
};


exports.objToArr = function (obj) {
	return Object.values(obj);
};

exports.sortKeyObj = function (req, obj, sortkey) {
	var sortArr = [];
	for (let k in obj) {
		if (typeof obj[k] == 'object') {
			obj[k]['sortKeyVal'] = k;
			sortArr.push(obj[k]);
		}
	}
	if (!utility.checkEmpty(sortArr)) {
		sortArr.sort((a, b) => a[sortkey] - b[sortkey])

		let newObj = {};
		for (let k in sortArr) {
			newObj[sortArr[k].sortKeyVal] = sortArr[k];
		}
		obj = newObj;
	}
	return obj;
};

exports.capitalizeFirstLetter = function (str) {
	return _s.capitalize(str.toLowerCase());
};
exports.queryStringToObject = function (queryString) {

	queryString = [...new URLSearchParams(queryString)].reduce(
		(a, [k, v]) => ((a[k] = v), a),
		{}
	);
	return queryString;
};




exports.convertMinsToHrsMins = (mins) => {
	let h = Math.floor(mins / 60);
	let m = mins % 60;
	h = h < 10 ? '0' + h : h;
	m = m < 10 ? '0' + m : m;
	return `${h}:${m}`;
};

exports.dayName = function (num) {
	let days = {
		1: 'Monday',
		2: 'Tuesday',
		3: 'Wednesday',
		4: 'Thursday',
		5: 'Friday',
		6: 'Saturday',
		7: 'Sunday'
	};
	let dayNm = '';
	if (!utility.checkEmpty(days[num])) {
		dayNm = days[num];
	}
	return dayNm;
};

exports.getFirstChild = function (arr) {
	if (!utility.checkEmpty(arr)) {
		arr = arr[0];
	}
	return arr;
};

exports.errorCallback = async function (req, error) {
	throw new Error(error.toString());
}


exports.maskCardNumber = function (num1, start, length) {
	const strNum1 = num1.toString();
	const maskedPart = '#'.repeat(length);
	const maskedNum =
		strNum1.slice(0, start) +
		maskedPart +
		strNum1.slice(start + length);
	return maskedNum;
};

exports.getDistrictName = async (lat, lng) => {
    let apikey = '';
    try {
        // ✅ Step 1: Fetch Google Maps API key from DB (key_Name = 'backend')
        const keyData = await dbQuery.fetchSingleRecord(
            constants.vals.defaultDB,
            'google_map_api_key',
            "WHERE key_Name = 'backend' LIMIT 1",
            'google_map_keys'
        );

        apikey = keyData?.google_map_keys || constants.vals.google_api;

        // ✅ Step 2: Build Google Maps Geocode API URL
        const reverseUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apikey}`;
        const reverseRes = await axios.get(reverseUrl);

		console.log(reverseUrl);
		console.log(reverseRes);
		console.log("asjdasdghasdghajsdg");
		
		
		

        // ✅ Step 3: Extract administrative_area_level_1
        for (const result of reverseRes.data.results) {
            const component = result.address_components.find(c =>
                c.types.includes("administrative_area_level_1")
            );
            if (component) return component.long_name;
        }



        // If no district found, return null
        return null;

    } catch (error) {
        console.error('Error in getDistrictName:', error);

        // ✅ Step 4: Log error in google_api_logs table
        try {
            await dbQuery.insertSingle(constants.vals.defaultDB, 'google_api_logs', {
                latitude: lat,
                longitude: lng,
                api_key: apikey,
                status: 'error',
                message: error.message || 'Unknown error'
            });
        } catch (logError) {
            console.error('Error logging Google API error:', logError);
        }

        return null;
    }
};




