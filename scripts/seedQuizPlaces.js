"use strict";
// One-time seed for the 9 places from the Quiz Setup Guide package
// (data/quiz_cafes_seed.json) into quiz_places. Safe to re-run — it skips
// any `src` that already exists rather than erroring or duplicating.
//
// Run manually after migrations/018_quiz.sql has been applied:
//   node scripts/seedQuizPlaces.js
require("dotenv").config({ path: "./.env" });
const dbcon = require("../config/mysqlClient");
const query = require("../helpers/query");
const constants = require("../vars/constants");
const places = require("../data/quiz_cafes_seed.json");

const DB = constants.vals.defaultDB;

function randomPin() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

(async () => {
    constants.vals.dbconn = await dbcon.connection();

    for (const p of places) {
        const existing = await query.fetchSingleRecord(DB, "quiz_places", `WHERE src='${p.src}'`);
        if (existing && !Array.isArray(existing)) {
            console.log(`skip (exists): ${p.src}`);
            continue;
        }
        await query.insertSingle(DB, "quiz_places", {
            src: p.src,
            name: p.name,
            area: p.area || null,
            type: p.type,
            offer: p.offer ? 1 : 0,
            drinks: (p.drinks || []).join(",") || "Chai,Coffee",
            daily_cap: p.daily_cap || 15,
            code: p.code || null,
            counter_pin: p.offer ? randomPin() : null,
            active: 1,
        });
        console.log(`seeded: ${p.src}`);
    }

    console.log("Done.");
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
