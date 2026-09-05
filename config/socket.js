const dbQuery = require("../helpers/query");
let constants = require("../vars/constants");
const mysql = require('mysql2/promise');
const { dbs, dbs_login } = require("../vars/db");

function setupSocket(io) {

    const db = mysql.createPool({
        host: dbs.mysql_bpr.read,
        user: dbs_login.apiservice.user,
        password: dbs_login.apiservice.password,
        database: dbs.mysql_bpr.database
    });

    io.on('connection', (socket) => {
        console.log('Client connected:', socket.id);

        socket.on('joinPoliceStation', async (stationId) => {
            socket.join(`station_${stationId}`);
            console.log(`Client ${socket.id} joined room station_${stationId}`);

            const [rows] = await db.query(
                `SELECT patrol_unit_Id, police_station_Id, patrol_unit_Name, patrol_unit_Latitude, patrol_unit_Longitude 
       FROM patrol_unit 
       WHERE police_station_Id = ? AND is_active = 1 AND is_delete = 0`,
                [stationId]
            );

            socket.emit('allPatrolUnits', rows);
        });

        socket.on('disconnect', () => {
            console.log('Client disconnected:', socket.id);
        });
    });
}

module.exports = { setupSocket };
