"use strict";
// Investapas Quiz — public API consumed directly by the quiz webpage
// (site/index.html, served at GET /quiz — see routes/quiz.js). Unlike the
// rest of this backend (which always returns HTTP 200 with a status flag),
// these endpoints follow the quiz page's own contract: non-2xx status +
// {"message": "..."} on error, since that's what the page's fetch wrapper
// already expects (see api() in index.html) — matching the original Quiz
// Setup Guide spec exactly, not the convention used elsewhere in this repo.
//
// WHATSAPP SENDING IS NOT WIRED UP YET — see helpers/quizWhatsapp.js. The
// quiz page already shows the result/token text inline as a WhatsApp-style
// preview bubble regardless, so skipping this doesn't break the player
// experience; it just means the real WhatsApp messages aren't sent until
// an AiSensy account + approved templates exist and WHATSAPP_API_KEY is
// set.
const { v4: uuidv4 } = require("uuid");
const query = require("../helpers/query");
const constants = require("../vars/constants");
const whatsapp = require("../helpers/quizWhatsapp");

const DB = constants.vals.defaultDB;
const QUESTIONS_PER_GAME = 7;
const PHONE_RE = /^[6-9]\d{9}$/;

let _questionsById = null;
function questionsById() {
    if (_questionsById) return _questionsById;
    const data = require("../data/quiz_questions.json");
    _questionsById = {};
    for (const q of data.questions) _questionsById[q.id] = q;
    return _questionsById;
}

function fail(res, status, message) {
    return res.status(status).json({ message });
}

function resultType(correct) {
    if (correct === QUESTIONS_PER_GAME) return "Market Monk";
    if (correct >= 5) return "Disciplined Sniper";
    if (correct >= 3) return "Emotional Trader";
    return "Impulsive Trader";
}

// ── Simple per-phone / per-IP rate limiting (in-memory — fine for this
// traffic volume; resets on deploy, which is an acceptable trade-off) ──
const _submitByPhone = new Map(); // phone -> [timestamps]
const _submitByIp = new Map();    // ip -> [timestamps]
function _rateLimited(map, key, max, windowMs) {
    const now = Date.now();
    const hits = (map.get(key) || []).filter(t => now - t < windowMs);
    hits.push(now);
    map.set(key, hits);
    return hits.length > max;
}

// GET /api/quiz/place?src=cafe-casa
exports.getPlace = async (req, res) => {
    try {
        const src = (req.query.src || "").toString().trim().toLowerCase();
        if (!src) return fail(res, 400, "src is required");

        const place = await query.fetchSingleRecord(
            DB, "quiz_places", `WHERE src='${src}' AND active=1`
        );
        if (!place || Array.isArray(place)) {
            return fail(res, 404, "Place not found");
        }

        return res.json({
            name: place.name,
            offer: !!place.offer,
            drinks: (place.drinks || "").split(",").map(d => d.trim()).filter(Boolean),
            code: place.code || null,
        });
    } catch (error) {
        console.error("[Quiz] getPlace error:", error.message);
        return fail(res, 500, "Something went wrong");
    }
};

// POST /api/quiz/visit { src }
exports.logVisit = async (req, res) => {
    try {
        const src = (req.body?.src || "").toString().trim().toLowerCase() || null;
        await query.insertSingle(DB, "quiz_visits", { src });
        return res.status(204).send();
    } catch (error) {
        console.error("[Quiz] logVisit error:", error.message);
        return res.status(204).send(); // never block the page over a logging failure
    }
};

// POST /api/quiz/submit { src, traderType, phone, consent, answers:[{id,picked}] }
exports.submit = async (req, res) => {
    try {
        const { src, traderType, phone, consent, answers } = req.body || {};
        if (!PHONE_RE.test(phone || "")) {
            return fail(res, 400, "Please enter a valid 10-digit WhatsApp number.");
        }
        if (consent !== true) {
            return fail(res, 400, "Consent is required to send your score on WhatsApp.");
        }
        if (!Array.isArray(answers) || !answers.length) {
            return fail(res, 400, "No answers submitted");
        }

        const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
        if (_rateLimited(_submitByPhone, phone, 5, 24 * 60 * 60 * 1000)) {
            return fail(res, 429, "Too many attempts from this number today. Please try again tomorrow.");
        }
        if (_rateLimited(_submitByIp, ip, 20, 60 * 60 * 1000)) {
            return fail(res, 429, "Too many attempts. Please try again later.");
        }

        // Score here, never trust the client — each answer's `picked`
        // index is checked against questions.json's own correct index.
        const bank = questionsById();
        let correct = 0;
        const scoredAnswers = [];
        for (const a of answers) {
            const q = bank[a?.id];
            const picked = Number.isInteger(a?.picked) ? a.picked : -1;
            const isCorrect = !!q && picked === q.c;
            if (isCorrect) correct++;
            scoredAnswers.push({ id: a?.id, picked });
        }
        const score = Math.round((correct / QUESTIONS_PER_GAME) * 100);

        const sessionId = uuidv4();
        await query.insertSingle(DB, "quiz_sessions", {
            id: sessionId,
            src: (src || "").toString().trim().toLowerCase() || null,
            trader_type: traderType || null,
            phone,
            consent: 1,
            answers: JSON.stringify(scoredAnswers),
            correct,
            score,
        });

        // Fire-and-forget — never block the response on WhatsApp delivery.
        whatsapp.sendQuizResult({ phone, correct, score, type: resultType(correct) })
            .catch(e => console.log("[Quiz] WhatsApp result send skipped/failed:", e.message));

        return res.json({ sessionId, correct, score });
    } catch (error) {
        console.error("[Quiz] submit error:", error.message);
        return fail(res, 500, "Something went wrong. Please try again.");
    }
};

// POST /api/quiz/claim { sessionId, src, phone, name, email, drink }
exports.claim = async (req, res) => {
    try {
        const { sessionId, src, phone, name, email, drink } = req.body || {};
        if (!PHONE_RE.test(phone || "")) return fail(res, 400, "Invalid phone number");
        if (!name || !name.toString().trim()) return fail(res, 400, "Name is required");

        const place = await query.fetchSingleRecord(
            DB, "quiz_places", `WHERE src='${(src || "").toString().trim().toLowerCase()}' AND active=1`
        );
        if (!place || Array.isArray(place) || !place.offer || !place.code) {
            return fail(res, 400, "This place has no active drink offer");
        }
        const allowedDrinks = (place.drinks || "").split(",").map(d => d.trim());
        if (!allowedDrinks.includes(drink)) {
            return fail(res, 400, "That drink is not offered at this place");
        }

        const existing = await query.fetchSingleRecord(
            DB, "quiz_drink_tokens", `WHERE phone='${phone}'`
        );
        if (existing && !Array.isArray(existing)) {
            return fail(res, 409, "This number has already claimed a free drink.");
        }

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const givenToday = await query.fetchRecords(
            DB, "quiz_drink_tokens",
            `WHERE src='${place.src}' AND created_at >= '${today.toISOString().slice(0, 19).replace("T", " ")}'`
        ) || [];
        if (givenToday.length >= place.daily_cap) {
            return fail(res, 429, `Today's free drink limit at ${place.name} has been reached. Please try again tomorrow.`);
        }

        let token;
        for (let attempt = 0; attempt < 5; attempt++) {
            const candidate = `${place.code}-${1000 + Math.floor(Math.random() * 9000)}`;
            const clash = await query.fetchSingleRecord(DB, "quiz_drink_tokens", `WHERE token='${candidate}'`);
            if (!clash || Array.isArray(clash)) { token = candidate; break; }
        }
        if (!token) return fail(res, 500, "Could not generate a token, please try again");

        await query.insertSingle(DB, "quiz_drink_tokens", {
            token,
            session_id: sessionId || null,
            phone,
            src: place.src,
            drink,
            name: name.toString().trim(),
            email: email || null,
        });

        whatsapp.sendDrinkToken({ phone, name, drink, placeName: place.name, token })
            .catch(e => console.log("[Quiz] WhatsApp token send skipped/failed:", e.message));

        return res.json({ token });
    } catch (error) {
        console.error("[Quiz] claim error:", error.message);
        return fail(res, 500, "Something went wrong. Please try again.");
    }
};

// POST /api/quiz/mentorship { sessionId, phone, src }
exports.mentorship = async (req, res) => {
    try {
        const { sessionId, phone, src } = req.body || {};
        if (!PHONE_RE.test(phone || "")) return fail(res, 400, "Invalid phone number");

        await query.insertSingle(DB, "quiz_mentorship_requests", {
            session_id: sessionId || null,
            phone,
            src: (src || "").toString().trim().toLowerCase() || null,
        });

        whatsapp.sendMentorshipConfirmed({ phone })
            .catch(e => console.log("[Quiz] WhatsApp mentorship send skipped/failed:", e.message));
        // TODO once WhatsApp/notifications are wired: alert Prince and Sankalp per the spec.

        return res.json({});
    } catch (error) {
        console.error("[Quiz] mentorship error:", error.message);
        return fail(res, 500, "Something went wrong. Please try again.");
    }
};
