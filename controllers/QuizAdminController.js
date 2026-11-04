"use strict";
// Investapas Quiz — admin screens (Dashboard, Players, Places & QR codes)
// and the cafe counter page. Admin endpoints sit behind the existing admin
// JWT (authMiddleware.authentication, same as every other /admin/* route)
// and follow this repo's existing admin response convention
// (utility.apiResponse / {status,msg,data}) rather than the public quiz
// API's convention (see QuizController.js's header comment for why those
// differ).
//
// The counter page (cafe staff, not admin users) uses its own lightweight
// per-place PIN instead of the admin JWT — see counterLogin/counterCheck/
// counterMarkServed below.
const dbcon = require("../config/mysqlClient");
const query = require("../helpers/query");
const utility = require("../helpers/utility");
const constants = require("../vars/constants");
const QRCode = require("qrcode");

const DB = constants.vals.defaultDB;
let _questionsCache = null;
function questionsById() {
    if (_questionsCache) return _questionsCache;
    const data = require("../data/quiz_questions.json");
    _questionsCache = {};
    for (const q of data.questions) _questionsCache[q.id] = q;
    return _questionsCache;
}

function _ok(res, msg, data) {
    return utility.apiResponse(null, res, { status: "success", msg, data });
}
function _err(res, msg) {
    return utility.apiResponse(null, res, { status: "error", msg });
}

function _fromDate(range) {
    const now = new Date();
    if (range === "7d") return new Date(now.getTime() - 7 * 86400000);
    if (range === "30d") return new Date(now.getTime() - 30 * 86400000);
    if (range === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
    return new Date(2000, 0, 1); // "all"
}
function _sqlDate(d) {
    return d.toISOString().slice(0, 19).replace("T", " ");
}

// ── Dashboard ────────────────────────────────────────────────────────────
// GET /admin/quiz/dashboard?range=today|7d|30d|all
exports.dashboard = async (req, res) => {
    try {
        const from = _sqlDate(_fromDate(req.query.range));

        const places = await query.fetchRecords(DB, "quiz_places", `ORDER BY name`) || [];
        const rows = [];
        let totals = { scans: 0, completed: 0, drinksGiven: 0, served: 0, mentorship: 0 };

        for (const p of places) {
            const [scansR, completedR, avgR, givenR, servedR, mentorR] = await Promise.all([
                dbcon.query(DB, `SELECT COUNT(*) c FROM quiz_visits WHERE src=? AND created_at>=?`, [p.src, from]),
                dbcon.query(DB, `SELECT COUNT(*) c FROM quiz_sessions WHERE src=? AND created_at>=?`, [p.src, from]),
                dbcon.query(DB, `SELECT ROUND(AVG(score)) a FROM quiz_sessions WHERE src=? AND created_at>=?`, [p.src, from]),
                dbcon.query(DB, `SELECT COUNT(*) c FROM quiz_drink_tokens WHERE src=? AND created_at>=?`, [p.src, from]),
                dbcon.query(DB, `SELECT COUNT(*) c FROM quiz_drink_tokens WHERE src=? AND redeemed_at>=?`, [p.src, from]),
                dbcon.query(DB, `SELECT COUNT(*) c FROM quiz_mentorship_requests WHERE src=? AND created_at>=?`, [p.src, from]),
            ]);
            const scans = scansR?.[0]?.c || 0;
            const completed = completedR?.[0]?.c || 0;
            const drinksGiven = givenR?.[0]?.c || 0;
            const served = servedR?.[0]?.c || 0;
            const mentorship = mentorR?.[0]?.c || 0;
            totals.scans += scans; totals.completed += completed;
            totals.drinksGiven += drinksGiven; totals.served += served; totals.mentorship += mentorship;
            rows.push({
                src: p.src, name: p.name, area: p.area, type: p.type,
                scans, completed,
                completionRate: scans > 0 ? Math.round((completed / scans) * 100) : 0,
                avgScore: avgR?.[0]?.a || 0,
                drinksGiven, served, mentorship,
            });
        }
        rows.sort((a, b) => b.completed - a.completed);

        return _ok(res, "Dashboard", {
            tiles: {
                scans: totals.scans,
                completed: totals.completed,
                completionRate: totals.scans > 0 ? Math.round((totals.completed / totals.scans) * 100) : 0,
                drinksGiven: totals.drinksGiven,
                served: totals.served,
                mentorship: totals.mentorship,
            },
            places: rows,
        });
    } catch (error) {
        console.error("[QuizAdmin] dashboard error:", error.message);
        return _err(res, error.message);
    }
};

// ── Players ──────────────────────────────────────────────────────────────
function maskPhone(phone) {
    if (!phone || phone.length < 10) return phone;
    return `+91 ${phone.slice(0, 2)}xxx x${phone.slice(-4)}`;
}

function _playersFilter(q) {
    const parts = [];
    if (q.src) parts.push(`s.src='${String(q.src).replace(/'/g, "")}'`);
    if (q.from) parts.push(`s.created_at >= '${_sqlDate(new Date(q.from))}'`);
    if (q.to) parts.push(`s.created_at <= '${_sqlDate(new Date(q.to))}'`);
    if (q.search) {
        const term = String(q.search).replace(/'/g, "");
        parts.push(`(t.name LIKE '%${term}%' OR s.phone LIKE '%${term}%')`);
    }
    return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}

function resultType(correct) {
    if (correct === 7) return "Market Monk";
    if (correct >= 5) return "Disciplined Sniper";
    if (correct >= 3) return "Emotional Trader";
    return "Impulsive Trader";
}

// GET /admin/quiz/players?src=&from=&to=&search=&page=&pageSize=
exports.players = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(100, parseInt(req.query.pageSize) || 25);
        const where = _playersFilter(req.query);

        const rows = await dbcon.query(DB, `
            SELECT s.id, s.src, s.trader_type, s.phone, s.correct, s.score, s.created_at,
                   t.token, t.name AS token_name, t.drink, t.redeemed_at,
                   (SELECT COUNT(*) FROM quiz_mentorship_requests m WHERE m.session_id = s.id) AS mentorship_count,
                   p.name AS place_name, p.offer AS place_offer
            FROM quiz_sessions s
            LEFT JOIN quiz_drink_tokens t ON t.session_id = s.id
            LEFT JOIN quiz_places p ON p.src = s.src
            ${where}
            ORDER BY s.created_at DESC
            LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
        `, []);

        const countRows = await dbcon.query(DB, `
            SELECT COUNT(*) c FROM quiz_sessions s
            LEFT JOIN quiz_drink_tokens t ON t.session_id = s.id
            ${where}
        `, []);

        const players = (rows || []).map(r => ({
            sessionId: r.id,
            when: r.created_at,
            name: r.token_name || null,
            whatsappMasked: maskPhone(r.phone),
            place: r.place_name || r.src,
            traderType: r.trader_type,
            score: r.correct,
            scoreOutOf: 7,
            resultType: resultType(r.correct),
            freeDrinkStatus: !r.place_offer ? "no offer"
                : !r.token ? "not claimed"
                : r.redeemed_at ? "served" : "not served yet",
            mentorship: r.mentorship_count > 0,
        }));

        return _ok(res, "Players", {
            players,
            total: countRows?.[0]?.c || 0,
            page, pageSize,
        });
    } catch (error) {
        console.error("[QuizAdmin] players error:", error.message);
        return _err(res, error.message);
    }
};

// GET /admin/quiz/players/:sessionId
exports.playerDetail = async (req, res) => {
    try {
        const session = await query.fetchSingleRecord(DB, "quiz_sessions", `WHERE id='${req.params.sessionId}'`);
        if (!session || Array.isArray(session)) return _err(res, "Not found");

        const token = await query.fetchSingleRecord(DB, "quiz_drink_tokens", `WHERE session_id='${session.id}'`);
        const mentorship = await query.fetchSingleRecord(DB, "quiz_mentorship_requests", `WHERE session_id='${session.id}'`);
        const bank = questionsById();

        const answers = (typeof session.answers === "string" ? JSON.parse(session.answers) : session.answers) || [];
        const questionDetail = answers.map(a => {
            const q = bank[a.id];
            return {
                id: a.id,
                question: q?.q || "",
                picked: a.picked,
                pickedText: a.picked >= 0 && q ? q.o[a.picked] : (a.picked === -1 ? "Time ran out" : null),
                correctIndex: q?.c,
                correctText: q?.o?.[q.c],
                why: q?.why,
            };
        });

        return _ok(res, "Player detail", {
            sessionId: session.id,
            when: session.created_at,
            phoneMasked: maskPhone(session.phone),
            traderType: session.trader_type,
            score: session.correct,
            resultType: resultType(session.correct),
            answers: questionDetail,
            token: (token && !Array.isArray(token)) ? {
                token: token.token, drink: token.drink, name: token.name,
                issuedAt: token.created_at, servedAt: token.redeemed_at,
            } : null,
            mentorshipStatus: (mentorship && !Array.isArray(mentorship)) ? mentorship.status : null,
        });
    } catch (error) {
        console.error("[QuizAdmin] playerDetail error:", error.message);
        return _err(res, error.message);
    }
};

// POST /admin/quiz/players/:sessionId/reveal
exports.revealNumber = async (req, res) => {
    try {
        const session = await query.fetchSingleRecord(DB, "quiz_sessions", `WHERE id='${req.params.sessionId}'`);
        if (!session || Array.isArray(session)) return _err(res, "Not found");

        await query.insertSingle(DB, "quiz_reveal_log", {
            admin_id: req.user.admin_Id,
            session_id: session.id,
        });

        return _ok(res, "Revealed", { phone: session.phone });
    } catch (error) {
        console.error("[QuizAdmin] revealNumber error:", error.message);
        return _err(res, error.message);
    }
};

// GET /admin/quiz/players/export?... (same filters as players())
exports.exportPlayersCsv = async (req, res) => {
    try {
        const where = _playersFilter(req.query);
        const rows = await dbcon.query(DB, `
            SELECT s.id, s.src, s.trader_type, s.phone, s.correct, s.score, s.created_at,
                   t.token, t.name AS token_name, t.drink, t.redeemed_at,
                   p.name AS place_name, p.offer AS place_offer
            FROM quiz_sessions s
            LEFT JOIN quiz_drink_tokens t ON t.session_id = s.id
            LEFT JOIN quiz_places p ON p.src = s.src
            ${where}
            ORDER BY s.created_at DESC
        `, []);

        const header = ["When", "Name", "Phone", "Place", "Trader Type", "Score", "Result", "Drink Status", "Token"];
        const lines = [header.join(",")];
        for (const r of (rows || [])) {
            const status = !r.place_offer ? "no offer" : !r.token ? "not claimed" : r.redeemed_at ? "served" : "not served yet";
            const line = [
                r.created_at, r.token_name || "", r.phone, r.place_name || r.src,
                r.trader_type || "", r.correct, resultType(r.correct), status, r.token || "",
            ].map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
            lines.push(line);
        }

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", "attachment; filename=quiz-players.csv");
        return res.send(lines.join("\n"));
    } catch (error) {
        console.error("[QuizAdmin] exportPlayersCsv error:", error.message);
        return _err(res, error.message);
    }
};

// ── Places & QR codes ────────────────────────────────────────────────────
function slugify(s) {
    return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// `query.fetchSingleRecord` returns `[]` (a truthy value) when nothing
// matches, not null/undefined — so every lookup result needs this check,
// not a plain truthiness check, or "not found" reads as "found".
function _found(row) {
    return !!row && !Array.isArray(row);
}

async function uniqueSlug(base) {
    let slug = base, n = 2;
    while (_found(await query.fetchSingleRecord(DB, "quiz_places", `WHERE src='${slug}'`))) {
        slug = `${base}-${n++}`;
    }
    return slug;
}

async function uniqueCode(nameInitials) {
    let code = nameInitials.slice(0, 3).toUpperCase().padEnd(3, "X");
    let n = 0;
    while (_found(await query.fetchSingleRecord(DB, "quiz_places", `WHERE code='${code}'`))) {
        n++;
        code = (nameInitials.slice(0, 2).toUpperCase() + n).padEnd(3, "X").slice(0, 3);
        if (n > 50) { code = Math.random().toString(36).slice(2, 5).toUpperCase(); break; }
    }
    return code;
}

function randomPin() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

const QUIZ_BASE_URL = process.env.QUIZ_BASE_URL || "https://investapas.in/quiz";

// GET /admin/quiz/places
exports.places = async (req, res) => {
    try {
        const places = await query.fetchRecords(DB, "quiz_places", `ORDER BY created_at DESC`) || [];
        const data = [];
        for (const p of places) {
            const [scansR, completedR, servedR] = await Promise.all([
                dbcon.query(DB, `SELECT COUNT(*) c FROM quiz_visits WHERE src=?`, [p.src]),
                dbcon.query(DB, `SELECT COUNT(*) c FROM quiz_sessions WHERE src=?`, [p.src]),
                dbcon.query(DB, `SELECT COUNT(*) c FROM quiz_drink_tokens WHERE src=? AND redeemed_at IS NOT NULL`, [p.src]),
            ]);
            data.push({
                src: p.src, name: p.name, area: p.area, type: p.type,
                offer: !!p.offer, drinks: (p.drinks || "").split(",").filter(Boolean),
                dailyCap: p.daily_cap, code: p.code, counterPin: p.counter_pin,
                active: !!p.active,
                link: `${QUIZ_BASE_URL}?src=${p.src}`,
                scans: scansR?.[0]?.c || 0, completed: completedR?.[0]?.c || 0, served: servedR?.[0]?.c || 0,
            });
        }
        return _ok(res, "Places", data);
    } catch (error) {
        console.error("[QuizAdmin] places error:", error.message);
        return _err(res, error.message);
    }
};

// POST /admin/quiz/places
// body: { name, area, type, offer, drinks:[...], dailyCap, code? }
exports.addPlace = async (req, res) => {
    try {
        const { name, area, type, offer, drinks, dailyCap, code } = req.body || {};
        if (!name || !name.trim()) return _err(res, "Place name is required");
        if (!type) return _err(res, "Type is required");

        const src = await uniqueSlug(slugify(`${name}-${area || ""}`) || slugify(name));
        const finalCode = code && /^[A-Za-z]{3}$/.test(code)
            ? code.toUpperCase()
            : await uniqueCode(name.replace(/[^a-zA-Z]/g, "") || "QZ");
        const pin = randomPin();

        await query.insertSingle(DB, "quiz_places", {
            src, name: name.trim(), area: area || null, type,
            offer: offer === false ? 0 : 1,
            drinks: Array.isArray(drinks) && drinks.length ? drinks.join(",") : "Chai,Coffee",
            daily_cap: Number.isFinite(Number(dailyCap)) ? Number(dailyCap) : 15,
            code: finalCode, counter_pin: pin, active: 1,
        });

        return _ok(res, "Place added", {
            src, code: finalCode, counterPin: pin, link: `${QUIZ_BASE_URL}?src=${src}`,
        });
    } catch (error) {
        console.error("[QuizAdmin] addPlace error:", error.message);
        return _err(res, error.message);
    }
};

// PUT /admin/quiz/places/:src
exports.updatePlace = async (req, res) => {
    try {
        const src = req.params.src;
        const existing = await query.fetchSingleRecord(DB, "quiz_places", `WHERE src='${src}'`);
        if (!existing || Array.isArray(existing)) return _err(res, "Place not found");

        const { name, area, type, offer, drinks, dailyCap } = req.body || {};
        const fields = [];
        if (name) fields.push(`name='${name.replace(/'/g, "")}'`);
        if (area !== undefined) fields.push(`area='${(area || "").replace(/'/g, "")}'`);
        if (type) fields.push(`type='${type.replace(/'/g, "")}'`);
        if (offer !== undefined) fields.push(`offer=${offer ? 1 : 0}`);
        if (Array.isArray(drinks)) fields.push(`drinks='${drinks.join(",")}'`);
        if (dailyCap !== undefined) fields.push(`daily_cap=${Number(dailyCap) || 15}`);
        if (!fields.length) return _err(res, "Nothing to update");

        await query.updateRecord(DB, "quiz_places", `src='${src}'`, fields.join(", "));
        return _ok(res, "Place updated", { src });
    } catch (error) {
        console.error("[QuizAdmin] updatePlace error:", error.message);
        return _err(res, error.message);
    }
};

// POST /admin/quiz/places/:src/deactivate
exports.deactivatePlace = async (req, res) => {
    try {
        await query.updateRecord(DB, "quiz_places", `src='${req.params.src}'`, `active=0`);
        return _ok(res, "Place deactivated", { src: req.params.src });
    } catch (error) {
        console.error("[QuizAdmin] deactivatePlace error:", error.message);
        return _err(res, error.message);
    }
};

// GET /admin/quiz/places/:src/qr.png  and  /qr.svg
// error correction M, black on white, quiet zone — per spec.
exports.placeQr = async (req, res) => {
    try {
        const src = req.params.src;
        const place = await query.fetchSingleRecord(DB, "quiz_places", `WHERE src='${src}'`);
        if (!place || Array.isArray(place)) return res.status(404).json({ message: "Place not found" });

        const link = `${QUIZ_BASE_URL}?src=${src}`;
        const format = req.params.format;
        const opts = { errorCorrectionLevel: "M", margin: 2, color: { dark: "#000000", light: "#ffffff" } };

        if (format === "svg") {
            const svg = await QRCode.toString(link, { ...opts, type: "svg" });
            res.setHeader("Content-Type", "image/svg+xml");
            res.setHeader("Content-Disposition", `attachment; filename=${src}.svg`);
            return res.send(svg);
        }
        const buffer = await QRCode.toBuffer(link, { ...opts, type: "png", width: 1200 });
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `attachment; filename=${src}.png`);
        return res.send(buffer);
    } catch (error) {
        console.error("[QuizAdmin] placeQr error:", error.message);
        return res.status(500).json({ message: error.message });
    }
};

// ── Counter page (cafe staff — PIN-gated, not the admin JWT) ────────────
// POST /api/quiz/counter/login { src, pin }
exports.counterLogin = async (req, res) => {
    try {
        const { src, pin } = req.body || {};
        const place = await query.fetchSingleRecord(DB, "quiz_places", `WHERE src='${(src || "").replace(/'/g, "")}' AND active=1`);
        if (!place || Array.isArray(place) || String(place.counter_pin) !== String(pin || "")) {
            return res.status(401).json({ message: "Invalid PIN" });
        }
        return res.json({ name: place.name });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// POST /api/quiz/counter/check { src, pin, token }
exports.counterCheck = async (req, res) => {
    try {
        const { src, pin, token } = req.body || {};
        const place = await query.fetchSingleRecord(DB, "quiz_places", `WHERE src='${(src || "").replace(/'/g, "")}' AND active=1`);
        if (!place || Array.isArray(place) || String(place.counter_pin) !== String(pin || "")) {
            return res.status(401).json({ message: "Invalid PIN" });
        }

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const t = await query.fetchSingleRecord(
            DB, "quiz_drink_tokens",
            `WHERE token='${(token || "").replace(/'/g, "")}' AND src='${place.src}' AND created_at >= '${_sqlDate(today)}'`
        );
        if (!t || Array.isArray(t)) {
            return res.json({ result: "not_found" });
        }
        if (t.redeemed_at) {
            return res.json({ result: "already_served", servedAt: t.redeemed_at });
        }
        return res.json({ result: "valid", name: t.name, drink: t.drink, issuedAt: t.created_at });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// POST /api/quiz/counter/mark-served { src, pin, token }
exports.counterMarkServed = async (req, res) => {
    try {
        const { src, pin, token } = req.body || {};
        const place = await query.fetchSingleRecord(DB, "quiz_places", `WHERE src='${(src || "").replace(/'/g, "")}' AND active=1`);
        if (!place || Array.isArray(place) || String(place.counter_pin) !== String(pin || "")) {
            return res.status(401).json({ message: "Invalid PIN" });
        }
        const t = await query.fetchSingleRecord(
            DB, "quiz_drink_tokens", `WHERE token='${(token || "").replace(/'/g, "")}' AND src='${place.src}'`
        );
        if (!t || Array.isArray(t)) return res.status(404).json({ message: "Token not found" });
        if (t.redeemed_at) return res.json({ status: true, alreadyServed: true });

        await query.updateRecord(DB, "quiz_drink_tokens", `token='${t.token}'`, `redeemed_at=NOW()`);
        return res.json({ status: true });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};
