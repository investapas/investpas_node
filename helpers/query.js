"use strict";
const constants = require("../vars/constants");
const messages = require("../vars/messages");
const mysql = require('mysql2');
const dbcon = require("../config/mysqlClient");
const _ = require('underscore');
const utility = require("../helpers/utility");
const dbquery = exports;

// query samples
exports.insertSingle = async function (db, table, params) {
	let content = await dbcon.query(db, "INSERT INTO ?? SET ?;", [table, params]).catch(console.log);
	if (!utility.checkEmpty(content)) {
		content = content.insertId;
	}
	return content;
};

exports.insertMultiple = async function (db, table, multiParams) {
	let query = [];
	let prm = "";
	let rsql = "";
	let content = "";
	for (let k in multiParams) {
		query.push(mysql.format('INSERT INTO ?? SET ?', [table, multiParams[k]]));
	}
	query = query.join(';');
	if (!utility.checkEmpty(query)) {
		content = await dbcon.query(db, query, []).catch(console.log);
	}
	return content;
};

exports.insertOrUpdate = async function (req, db, device, update) {
	let content = await dbcon.query(constants.vals.commonDB, "INSERT INTO ?? SET ? ON DUPLICATE KEY UPDATE ? , updated_at = ? ", [db, device, req.locals.now]).catch(console.log);
	return content;
}

exports.fetchSingleRecord = async function (db, table, condition, fields) {
	let content = await dbcon.query(db, `SELECT ${fields || '*'} FROM ?? ${condition || ''};`, [table]).catch(console.log);
	if (!utility.checkEmpty(content)) {
		content = content[0];
	}
	return content;
};

exports.fetchRecords = async function (db, table, condition, fields) {
	let content = await dbcon.query(db, `SELECT ${fields || '*'} FROM ?? ${condition || ''};`, [table]).catch(console.log);
	if (!utility.checkEmpty(content)) {
		content = content;
	}
	console.log(`SELECT ${fields || '*'} FROM ${table} ${condition || ''}`)
	return content;
};

exports.getPoliceRequests = async function (db, userId, status) {

	let content = await dbcon.query(db, `SELECT pr.police_request_Id, pr.police_request_type, pr.police_request_Reason, pr.police_request_latitude, pr.police_request_longitude, pr.camera_Id, pr.police_request_Address, pr.police_request_Status, pr.created_at, ev.evidence_Type, ev.evidence_FilePath FROM police_request AS pr LEFT JOIN evidence AS ev ON pr.police_request_Id = ev.police_request_Id WHERE pr.police_request_Status = ? AND pr.user_Id = ? AND pr.is_active = 1 AND pr.is_delete = 0 ORDER BY pr.police_request_Id DESC;`, [status, userId]).catch(console.log);

	if (!utility.checkEmpty(content)) {
		content = content;
	}
	const groupedData = {};

	for (const item of content) {
		let { police_request_Id, evidence_Type, evidence_FilePath, ...restData } = item;

		// If the police_request_Id doesn't exist in the groupedData, create it
		if (!groupedData[police_request_Id]) {
			groupedData[police_request_Id] = {
				police_request_Id,
				...restData,
				evidence: []
			};
		}

		if (evidence_Type == 'Image') {
			evidence_FilePath = constants.vals.frontEndFilePath + 'image/' + evidence_FilePath;
		} else if (evidence_Type == 'Audio') {
			evidence_FilePath = constants.vals.frontEndFilePath + 'audio/' + evidence_FilePath;
		} else if (evidence_Type == 'Video') {
			evidence_FilePath = constants.vals.frontEndFilePath + 'video/' + evidence_FilePath;
		}

		// Push the evidence into the respective police_request_Id
		groupedData[police_request_Id].evidence.push({ evidence_Type, evidence_FilePath });
	}

	// Convert the groupedData object into an array and return it
	return Object.values(groupedData).reverse();
};

exports.getPoliceRequestListForAdmin = async function (db, condition, limit, offset) {

	let content = await dbcon.query(db, `SELECT pr.police_request_Id, pr.police_request_type, pr.police_request_Reason, pr.police_request_latitude, pr.police_request_longitude, pr.police_request_Status, pr.camera_Id, pr.police_request_Address, pr.created_at, ev.evidence_Type, ev.evidence_FilePath FROM police_request AS pr LEFT JOIN evidence AS ev ON pr.police_request_Id = ev.police_request_Id WHERE pr.is_active = 1 AND pr.is_delete = 0 ${condition};`).catch(console.log);
	// let content = await dbcon.query(db, `SELECT pr.police_request_Id, pr.police_request_type, pr.police_request_Reason, pr.police_request_latitude, pr.police_request_longitude, pr.police_request_Status, pr.camera_Id, pr.police_request_Address, pr.created_at, ev.evidence_Type, ev.evidence_FilePath FROM police_request AS pr LEFT JOIN evidence AS ev ON pr.police_request_Id = ev.police_request_Id WHERE pr.is_active = 1 AND pr.is_delete = 0 ${condition} LIMIT ${limit} OFFSET ${offset};`).catch(console.log);

	// console.log('query', `SELECT pr.police_request_Id, pr.police_request_type, pr.police_request_Reason, pr.police_request_latitude, pr.police_request_longitude, pr.police_request_Status, pr.camera_Id, pr.police_request_Address, pr.created_at, ev.evidence_Type, ev.evidence_FilePath FROM police_request AS pr LEFT JOIN evidence AS ev ON pr.police_request_Id = ev.police_request_Id WHERE pr.is_active = 1 AND pr.is_delete = 0 ${condition} LIMIT ${limit} OFFSET ${offset}`)

	if (!utility.checkEmpty(content)) {
		content = content;
	}
	const groupedData = {};

	for (const item of content) {
		let { police_request_Id, evidence_Type, evidence_FilePath, ...restData } = item;

		// If the police_request_Id doesn't exist in the groupedData, create it
		if (!groupedData[police_request_Id]) {
			groupedData[police_request_Id] = {
				police_request_Id,
				...restData,
				evidence: []
			};
		}

		if (evidence_Type == 'Image') {
			evidence_FilePath = constants.vals.frontEndFilePath + 'image/' + evidence_FilePath;
		} else if (evidence_Type == 'Audio') {
			evidence_FilePath = constants.vals.frontEndFilePath + 'audio/' + evidence_FilePath;
		} else if (evidence_Type == 'Video') {
			evidence_FilePath = constants.vals.frontEndFilePath + 'video/' + evidence_FilePath;
		}

		// Push the evidence into the respective police_request_Id
		groupedData[police_request_Id].evidence.push({ evidence_Type, evidence_FilePath });
	}

	// Convert the groupedData object into an array and return it
	return Object.values(groupedData).reverse();
};

exports.getPoliceRequestsOfToday = async function (db, condition, latitude, longitude, radius) {

	let content = await dbcon.query(db, `SELECT pr.police_request_Id, pr.police_request_type, pr.police_request_Reason, pr.police_request_latitude, pr.police_request_longitude, pr.user_Id, pr.police_request_Status, pr.camera_Id, pr.police_request_Address, pr.assigned_patrol_Id, pr.created_at, ev.evidence_Type, ev.evidence_FilePath, (
        6371 * ACOS(
            COS(RADIANS(${latitude})) * 
            COS(RADIANS(pr.police_request_Latitude)) * 
            COS(RADIANS(pr.police_request_Longitude) - RADIANS(${longitude})) + 
            SIN(RADIANS(${latitude})) * 
            SIN(RADIANS(pr.police_request_Latitude))
        )
    ) AS distance_km FROM police_request AS pr LEFT JOIN evidence AS ev ON pr.police_request_Id = ev.police_request_Id WHERE pr.is_active = 1 AND pr.is_delete = 0 ${condition} HAVING distance_km <= ?;`, [radius]).catch(console.log);

	if (!utility.checkEmpty(content)) {
		content = content;
	}

	const groupedData = {};

	for (const item of content) {
		let { police_request_Id, evidence_Type, evidence_FilePath, ...restData } = item;

		// If the police_request_Id doesn't exist in the groupedData, create it
		if (!groupedData[police_request_Id]) {
			groupedData[police_request_Id] = {
				police_request_Id,
				...restData,
				evidence: []
			};
		}

		if (evidence_Type == 'Image') {
			evidence_FilePath = constants.vals.frontEndFilePath + 'image/' + evidence_FilePath;
		} else if (evidence_Type == 'Audio') {
			evidence_FilePath = constants.vals.frontEndFilePath + 'audio/' + evidence_FilePath;
		} else if (evidence_Type == 'Video') {
			evidence_FilePath = constants.vals.frontEndFilePath + 'video/' + evidence_FilePath;
		}

		// Push the evidence into the respective police_request_Id
		groupedData[police_request_Id].evidence.push({ evidence_Type, evidence_FilePath });
	}

	// Convert the groupedData object into an array and return it
	return Object.values(groupedData);
};

exports.updateRecord = async function (db, table, condition, newValue) {
	let content = await dbcon.query(db, `UPDATE ?? SET ${newValue} WHERE ${condition};`, [table]).catch(console.log);
	return content;
};

exports.fetchNearestPoliceStation = async function (db, table, latitude, longitude, radius) {
	let content = await dbcon.query(db, `SELECT 
	police_station_Id,
    (
        6371 * ACOS(
            COS(RADIANS(${latitude})) * 
            COS(RADIANS(police_station_Latitude)) * 
            COS(RADIANS(police_station_Longitude) - RADIANS(${longitude})) + 
            SIN(RADIANS(${latitude})) * 
            SIN(RADIANS(police_station_Latitude))
        )
    ) AS distance_km
	FROM ?? 
	HAVING distance_km <= ${radius}`, [table]).catch(console.log);

	if (!utility.checkEmpty(content)) {
		content = content[0];
	}

	return content;
};

exports.fetchNearestPatrolUnit = async function (db, table, latitude, longitude, radius, condition) {
	let content = await dbcon.query(db, `SELECT 
	patrol_unit_Id,
	patrol_unit_Name,
	patrol_unit_Latitude,
	patrol_unit_Longitude,
    (
        6371 * ACOS(
            COS(RADIANS(${latitude})) * 
            COS(RADIANS(patrol_unit_Latitude)) * 
            COS(RADIANS(patrol_unit_Longitude) - RADIANS(${longitude})) + 
            SIN(RADIANS(${latitude})) * 
            SIN(RADIANS(patrol_unit_Latitude))
        )
    ) AS distance_km
	FROM ??
	WHERE ${condition}
	HAVING distance_km <= ${radius}`, [table]).catch(console.log);

	if (!utility.checkEmpty(content)) {
		content = content;
	}

	return content;
};

exports.deleteRecord = async function (db, table, condition) {
	let content = await dbcon.query(db, `DELETE FROM ?? WHERE ${condition};`, [table]).catch(console.log);
	return content;
}

exports.getNearestCamera = async function (db, latitude, longitude, radius) {

	let content = await dbcon.query(db, `SELECT camera_info_Id, camera_Id, camera_info_event_Id,
       (
         6371000 * acos(
           cos(radians(${latitude})) *
           cos(radians(camera_info_Latitude)) *
           cos(radians(camera_info_Longitude) - radians(${longitude})) +
           sin(radians(${latitude})) *
           sin(radians(camera_info_Latitude))
         )
       ) AS distance_in_meters
FROM camera_info
HAVING distance_in_meters <= ?
ORDER BY distance_in_meters;`, [radius]).catch(console.log);

	if (!utility.checkEmpty(content)) {
		content = content;
	}

	return content;
}




