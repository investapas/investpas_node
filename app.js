const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const logger = require("morgan");
const mysql = require('mysql2');
const _ = require('underscore');
const _s = require("underscore.string");
require("dotenv").config({ path: "./env.env" });
const indexRouter = require("./routes/index");
const userRouter = require("./routes/user");
const dhanRouter = require("./routes/dhan");
const challengeRouter = require("./routes/challenge");
const apiResponse = require("./vars/apiResponse");
const cors = require("cors");
const moment = require("moment");
const dbQuery = require("./helpers/query");
const cron = require('node-cron');
let constants = require("./vars/constants");
const dbcon = require("./config/mysqlClient");
const utility = require("./helpers/utility");
var http = require('http');
const { Server } = require('socket.io');
const { setupSocket } = require('./config/socket');

const app = express();

//don't show the log when it is test
if (process.env.NODE_ENV !== "test") {
	app.use(logger("dev"));
}

var server = http.createServer(app);

const io = new Server(server, {
	cors: { origin: '*' }
});

app.use((req, res, next) => {
	req.io = io;
	next();
});

setupSocket(io);


app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

//To allow cross-origin requests
app.use(cors());

// Make the folder accessible through the URL
app.use('/apiService', express.static(path.join(__dirname, 'Assets', 'Evidence')));
app.use('/userProfile', express.static(path.join(__dirname, 'Assets', 'profilePicture')));

// Simple test endpoint
app.get('/test', (req, res) => {
	res.status(200).json({
		status: true,
		message: 'Test API is working!',
		timestamp: new Date()
	});
});

//Route Prefixes
app.use("/", indexRouter);
app.use("/user/", userRouter);
app.use("/dhan/", dhanRouter);
app.use("/challenge/", challengeRouter);

// app.use(function(req, res) {
//   res.sendFile(__dirname + '/public/index.html');
// });

// throw 404 if URL not found
app.all("*", function (req, res) {
	return apiResponse.notFoundResponse(res, "Page not found");
});

app.use((err, req, res) => {
	if (err.name == "UnauthorizedError") {
		return apiResponse.unauthorizedResponse(res, err.message);
	}
});

// Schedule the cron to run every day at 1:00 AM
cron.schedule('0 1 * * *', async () => {
	try {

		if (utility.checkEmpty(constants.vals.dbconn)) {
			constants.vals.dbconn = await dbcon.connection().catch(e => { console.log(e); })
			console.log("no db");

		} else {
			console.log("already connectde");
		}

		const condition = `recorded_at < (NOW() - INTERVAL 15 DAY)`;

		await dbQuery.deleteRecord(constants.vals.defaultDB, 'patrol_unit_location_history', condition);

	} catch (error) {
		console.error('Error running cron job:', error.message);
	}
});

module.exports = { app, server };