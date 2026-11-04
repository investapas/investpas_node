const crypto = require("crypto");
const nodemailer = require("nodemailer");
const dbcon = require("../config/mysqlClient");
const constants = require("../vars/constants");
const apiResponse = require("../vars/apiResponse");
const { verifyPhoneToken, issueToken, UserError } = require("./AccountController");

const DB = constants.vals.defaultDB;

// ─────────────────────────────────────────────────────────────────────────────
// New website (investapas-site) — early access sign-up, profile and the
// leads admin. Same behaviour and validation as the site's former
// standalone server.js, but stored in MySQL:
//   users             → name, email, mobile (the account key, shared with app)
//   website_profiles  → trading answers, early-access number, referral,
//                        source/QR campaign, chai code, mentor session, lead CRM
// Login is Firebase phone OTP (same as /account/*); the session is the web JWT.
// ─────────────────────────────────────────────────────────────────────────────

const CHOICES = {
    experience: ['Under 1 year', '1 to 3 years', '3 to 5 years', 'More than 5 years'],
    standing: ['Just starting out', 'Struggling', 'Around breakeven', 'Profitable'],
    capital: ['₹25,000 – ₹50,000', '₹50,000 – ₹1 lakh', '₹1 lakh – ₹3 lakh', '₹3 lakh – ₹5 lakh', 'More than ₹5 lakh'],
    instruments: ['Options', 'Futures', 'Stocks', 'Stocks and F&O'],
    losses: ['Nothing so far', 'Under ₹50,000', '₹50,000 – ₹2 lakh', 'More than ₹2 lakh', 'Prefer not to say'],
    problems: ['Revenge trading', 'Overtrading', 'No stop loss', 'Too much size', "Can't hold winners", 'Other'],
    sessionLang: ['Hindi', 'English'],
    sessionTime: ['Weekday evening', 'Weekend morning', 'Weekend evening'],
};
const LEAD_STATUSES = ['New', 'Contacted', 'Session booked', 'Session done', 'Converted', 'Not interested'];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const clean = (s, max = 120) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const pick = (v, list) => (list.includes(v) ? v : undefined);
const json = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } };
const mask = (p) => (p ? `+91 ${p.slice(0, 2)}XXXXXX${p.slice(-2)}` : '');
const isoOf = (v) => (v ? String(v).replace(' ', 'T') : null);

// ── data access ──────────────────────────────────────────────────────────────
async function loadRow(userId) {
    const rows = await dbcon.query(DB,
        `SELECT u.id, u.full_name, u.email, u.mobile_number, u.created_at AS user_created_at, p.*
         FROM users u LEFT JOIN website_profiles p ON p.user_id = u.id
         WHERE u.id = ? LIMIT 1`, [userId]);
    return rows && rows[0];
}

function isComplete(r) {
    const inst = json(r.instruments, []);
    return !!(r.full_name && r.experience && r.standing && r.capital && inst.length);
}

// Shape the website's JS expects (same as the old server.js publicUser).
function publicUser(r) {
    const name = r.full_name || '';
    return {
        name,
        firstName: name.split(' ')[0],
        email: r.email || '',
        phoneMasked: mask(r.mobile_number),
        waOptIn: !!r.wa_opt_in,
        trading: {
            experience: r.experience || undefined,
            standing: r.standing || undefined,
            capital: r.capital || undefined,
            instruments: json(r.instruments, []),
        },
        losses: r.losses || '',
        problems: json(r.problems, []),
        rules: { rr: r.rules_rr || '', lots: r.rules_lots || '', orders: r.rules_orders || '' },
        session: r.session_requested || r.session_lang || r.session_time ? {
            requested: !!r.session_requested,
            lang: r.session_lang || undefined,
            time: r.session_time || undefined,
            status: r.session_status || undefined,
        } : {},
        earlyNumber: r.early_number || null,
        status: r.status || 'started',
        refCode: r.ref_code,
        chaiCode: r.chai_code || null,
        complete: isComplete(r),
        createdAt: isoOf(r.created_at || r.user_created_at),
    };
}

async function uniqueRefCode() {
    for (let i = 0; i < 5; i++) {
        const code = crypto.randomBytes(4).toString('hex');
        const rows = await dbcon.query(DB, `SELECT 1 FROM website_profiles WHERE ref_code = ? LIMIT 1`, [code]);
        if (!rows || !rows.length) return code;
    }
    return crypto.randomBytes(6).toString('hex');
}

// ── email (best-effort, same SMTP settings as ContactController) ─────────────
function sendEmail(to, subject, text) {
    if (!to || !process.env.SMTP_USER) return;
    nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    }).sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text })
        .catch((e) => console.log('[EarlyAccess] email failed:', e.message));
}

function handleError(res, where, err) {
    if (err instanceof UserError) return apiResponse.validationErrorResponse(res, err.message);
    console.error(`[EarlyAccess] ${where} error:`, err.message);
    return apiResponse.ErrorResponse(res, 'Something went wrong. Please try again.');
}

// ── POST /account/session  { idToken, src, ref, campaign } ───────────────────
// Firebase phone OTP → log in, or create the account on first login (the
// website asks for name/email in the next step, not up front).
exports.session = async (req, res) => {
    try {
        const { uid, mobile } = await verifyPhoneToken(req.body.idToken);

        const found = await dbcon.query(DB, `SELECT id FROM users WHERE mobile_number = ? LIMIT 1`, [mobile]);
        let userId = found && found[0] && found[0].id;
        const isNew = !userId;

        if (isNew) {
            const ins = await dbcon.query(DB,
                `INSERT INTO users (mobile_number, firebase_uid, signup_source, is_active) VALUES (?, ?, 'website', 1)`,
                [mobile, uid]);
            userId = ins.insertId;
        } else {
            await dbcon.query(DB, `UPDATE users SET firebase_uid = ? WHERE id = ?`, [uid, userId]);
        }

        const prof = await dbcon.query(DB, `SELECT user_id, campaign FROM website_profiles WHERE user_id = ? LIMIT 1`, [userId]);
        const campaign = req.body.campaign === 'chai' ? 'chai' : '';
        if (!prof || !prof[0]) {
            let source = clean(req.body.src, 60).replace(/[^\w\-:.]/g, '') || 'website';
            let referredBy = null;
            const ref = clean(req.body.ref, 20);
            if (ref) {
                const r = await dbcon.query(DB, `SELECT user_id FROM website_profiles WHERE ref_code = ? LIMIT 1`, [ref]);
                if (r && r[0] && r[0].user_id !== userId) {
                    referredBy = r[0].user_id;
                    if (source === 'website') source = 'referral';
                }
            }
            await dbcon.query(DB,
                `INSERT INTO website_profiles (user_id, ref_code, referred_by, source, campaign, last_login_at)
                 VALUES (?, ?, ?, ?, ?, NOW())`,
                [userId, await uniqueRefCode(), referredBy, source, campaign]);
        } else {
            await dbcon.query(DB,
                `UPDATE website_profiles SET last_login_at = NOW(),
                        campaign = IF(campaign = '' AND ? = 'chai', 'chai', campaign)
                 WHERE user_id = ?`, [campaign, userId]);
        }

        const row = await loadRow(userId);
        return apiResponse.successResponseWithData(res, 'Logged in.', {
            token: issueToken(userId),
            isNew,
            user: publicUser(row),
        });
    } catch (err) {
        return handleError(res, 'session', err);
    }
};

// ── GET /account/early-profile ───────────────────────────────────────────────
exports.me = async (req, res) => {
    try {
        const row = await loadRow(req.webUser.userId);
        if (!row) return apiResponse.unauthorizedResponse(res, 'Please log in again.');
        if (!row.ref_code) {
            // Account made via the old /account/signup flow — give it a profile.
            await dbcon.query(DB, `INSERT IGNORE INTO website_profiles (user_id, ref_code) VALUES (?, ?)`,
                [row.id, await uniqueRefCode()]);
            return apiResponse.successResponseWithData(res, 'OK', { user: publicUser(await loadRow(row.id)) });
        }
        return apiResponse.successResponseWithData(res, 'OK', { user: publicUser(row) });
    } catch (err) {
        return handleError(res, 'me', err);
    }
};

// ── POST /account/early-profile ──────────────────────────────────────────────
// Partial updates from each step of the website flow (and the profile page).
exports.updateProfile = async (req, res) => {
    try {
        const userId = req.webUser.userId;
        let row = await loadRow(userId);
        if (!row) return apiResponse.unauthorizedResponse(res, 'Please log in again.');
        if (!row.ref_code) {
            await dbcon.query(DB, `INSERT IGNORE INTO website_profiles (user_id, ref_code) VALUES (?, ?)`, [userId, await uniqueRefCode()]);
            row = await loadRow(userId);
        }
        const wasComplete = isComplete(row);
        const b = req.body || {};
        const u = {};   // users columns
        const p = {};   // website_profiles columns

        if (b.name !== undefined) {
            const n = clean(b.name, 80);
            if (n.length < 2) return apiResponse.validationErrorResponse(res, 'Please enter your full name.');
            u.full_name = n;
        }
        if (b.email !== undefined) {
            const em = clean(b.email, 254).toLowerCase();
            if (em && !EMAIL_RE.test(em)) return apiResponse.validationErrorResponse(res, 'Please enter a valid email address.');
            u.email = em;
        }
        if (b.waOptIn !== undefined) {
            p.wa_opt_in = b.waOptIn ? 1 : 0;
            p.wa_opt_in_at = b.waOptIn ? new Date() : null;
        }
        if (b.trading) {
            for (const k of ['experience', 'standing', 'capital']) {
                if (b.trading[k] !== undefined) p[k] = pick(b.trading[k], CHOICES[k]) || null;
            }
            if (Array.isArray(b.trading.instruments)) {
                p.instruments = JSON.stringify(b.trading.instruments.filter((x) => CHOICES.instruments.includes(x)));
            }
        }
        if (b.losses !== undefined) p.losses = pick(b.losses, CHOICES.losses) || '';
        if (Array.isArray(b.problems)) p.problems = JSON.stringify(b.problems.filter((x) => CHOICES.problems.includes(x)).slice(0, 2));
        if (b.problemOther !== undefined) p.problem_other = clean(b.problemOther, 200);
        if (b.rules) {
            p.rules_rr = clean(b.rules.rr, 10);
            p.rules_lots = clean(b.rules.lots, 6);
            p.rules_orders = clean(b.rules.orders, 6);
        }
        if (b.session) {
            if (b.session.requested !== undefined) p.session_requested = b.session.requested ? 1 : 0;
            if (b.session.lang !== undefined) p.session_lang = pick(b.session.lang, CHOICES.sessionLang) || null;
            if (b.session.time !== undefined) p.session_time = pick(b.session.time, CHOICES.sessionTime) || null;
            if (b.session.requested && !row.session_status) {
                p.session_status = 'requested';
                p.session_requested_at = new Date();
            }
        }

        if (Object.keys(u).length) await dbcon.query(DB, `UPDATE users SET ? WHERE id = ?`, [u, userId]);
        if (Object.keys(p).length) await dbcon.query(DB, `UPDATE website_profiles SET ? WHERE user_id = ?`, [p, userId]);

        row = await loadRow(userId);
        let becameEarly = false;
        if (!wasComplete && isComplete(row) && !row.early_number) {
            // Next number on the list; the unique key makes a race retry safely.
            for (let i = 0; i < 5 && !becameEarly; i++) {
                try {
                    await dbcon.query(DB,
                        `UPDATE website_profiles
                         SET early_number = (SELECT n FROM (SELECT COALESCE(MAX(early_number), 0) + 1 AS n FROM website_profiles) t),
                             status = 'early_access'
                         WHERE user_id = ? AND early_number IS NULL`, [userId]);
                    becameEarly = true;
                } catch (e) {
                    if (e.code !== 'ER_DUP_ENTRY') throw e;
                }
            }
        }
        if (row.campaign === 'chai' && isComplete(row) && !row.chai_code) {
            await dbcon.query(DB, `UPDATE website_profiles SET chai_code = ? WHERE user_id = ?`,
                [String(crypto.randomInt(1000, 10000)), userId]);
        }
        row = await loadRow(userId);

        if (becameEarly) {
            const base = process.env.WEBSITE_URL || 'https://investapas.in';
            const inst = json(row.instruments, []);
            sendEmail(process.env.WEBSITE_ADMIN_EMAIL,
                `New early access sign-up #${row.early_number}: ${row.full_name}`,
                `${row.full_name}\n+91 ${row.mobile_number}\n${row.email || '-'}\nSource: ${row.source}${row.campaign ? ' (' + row.campaign + ')' : ''}\n` +
                `Experience: ${row.experience}\nStanding: ${row.standing}\nCapital: ${row.capital}\nTrades: ${inst.join(', ')}\n\nAdmin: ${base}/admin/`);
            if (process.env.WEBSITE_SEND_WELCOME_EMAIL !== 'false' && row.email) {
                sendEmail(row.email, `You're on the Investapas early access list (#${row.early_number})`,
                    `Hi ${row.full_name.split(' ')[0]},\n\nYou're #${row.early_number} on the Investapas early access list.\n\n` +
                    `We'll notify you on WhatsApp and email as soon as beta invites open. Every new trader gets a 30-day free trial.\n\n` +
                    `Your profile: ${base}/profile/\n\nTeam Investapas\nsupport@investapas.in · WhatsApp +91 91114 35830\n\n` +
                    `Investapas is not SEBI-registered and gives no tips or investment advice.`);
            }
        }

        return apiResponse.successResponseWithData(res, 'Saved.', { user: publicUser(row), becameEarly });
    } catch (err) {
        return handleError(res, 'updateProfile', err);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Leads admin (website /admin/). Auth is the same admin JWT used everywhere
// else (middlewares/authentication.js, admin_Id against the `admin` table) —
// log in at the regular /admin/login, not a separate website password.
// ─────────────────────────────────────────────────────────────────────────────

function leadOf(r) {
    const pu = publicUser(r);
    return Object.assign(pu, {
        id: String(r.id),
        phone: r.mobile_number || '',
        source: r.source || 'website',
        campaign: r.campaign || '',
        leadStatus: r.lead_status || 'New',
        notes: json(r.notes, []),
        problemOther: r.problem_other || '',
        referredBy: r.referred_by ? String(r.referred_by) : '',
        createdAt: isoOf(r.created_at) || '',
    });
}

async function allLeads() {
    const rows = (await dbcon.query(DB,
        `SELECT u.id, u.full_name, u.email, u.mobile_number, u.created_at AS user_created_at, p.*
         FROM website_profiles p JOIN users u ON u.id = p.user_id
         ORDER BY p.created_at DESC`, [])) || [];
    return rows.map(leadOf);
}

exports.adminLeads = async (req, res) => {
    try {
        const leads = await allLeads();
        const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
        const by = (f) => leads.reduce((o, u) => { const k = f(u) || '-'; o[k] = (o[k] || 0) + 1; return o; }, {});
        return apiResponse.successResponseWithData(res, 'OK', {
            leads,
            statuses: LEAD_STATUSES,
            stats: {
                total: leads.length,
                today: leads.filter((u) => (u.createdAt || '').startsWith(today)).length,
                complete: leads.filter((u) => u.complete).length,
                sessions: leads.filter((u) => u.session && u.session.requested).length,
                bySource: by((u) => u.source),
                byLead: by((u) => u.leadStatus),
            },
        });
    } catch (err) {
        return handleError(res, 'adminLeads', err);
    }
};

exports.adminUpdateLead = async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const rows = await dbcon.query(DB, `SELECT notes FROM website_profiles WHERE user_id = ? LIMIT 1`, [id]);
        if (!rows || !rows[0]) return apiResponse.notFoundResponse(res, 'Not found');
        const b = req.body || {};
        const set = {};
        if (b.leadStatus && LEAD_STATUSES.includes(b.leadStatus)) set.lead_status = b.leadStatus;
        if (b.note) {
            const notes = json(rows[0].notes, []);
            notes.push({ at: new Date().toISOString(), text: clean(b.note, 500) });
            set.notes = JSON.stringify(notes);
        }
        if (b.sessionStatus) set.session_status = clean(b.sessionStatus, 40);
        if (Object.keys(set).length) await dbcon.query(DB, `UPDATE website_profiles SET ? WHERE user_id = ?`, [set, id]);
        const r = await dbcon.query(DB,
            `SELECT u.id, u.full_name, u.email, u.mobile_number, u.created_at AS user_created_at, p.*
             FROM website_profiles p JOIN users u ON u.id = p.user_id WHERE u.id = ?`, [id]);
        return apiResponse.successResponseWithData(res, 'OK', { lead: leadOf(r[0]) });
    } catch (err) {
        return handleError(res, 'adminUpdateLead', err);
    }
};

exports.adminExportCsv = async (req, res) => {
    try {
        const leads = await allLeads();
        const cols = ['earlyNumber', 'createdAt', 'name', 'phone', 'email', 'waOptIn', 'source', 'campaign', 'experience', 'standing', 'capital',
            'instruments', 'losses', 'problems', 'rules', 'sessionRequested', 'sessionLang', 'sessionTime', 'sessionStatus', 'chaiCode', 'leadStatus', 'notes', 'referredBy'];
        const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const rows = leads.map((u) => {
            const t = u.trading || {}, s = u.session || {}, r = u.rules || {};
            return [u.earlyNumber, u.createdAt, u.name, '+91' + u.phone, u.email, u.waOptIn ? 'yes' : 'no', u.source, u.campaign,
                t.experience, t.standing, t.capital, (t.instruments || []).join('; '), u.losses,
                (u.problems || []).join('; ') + (u.problemOther ? ' (' + u.problemOther + ')' : ''),
                r.rr ? `RR ${r.rr}, lots ${r.lots}, orders ${r.orders}` : '', s.requested ? 'yes' : '', s.lang, s.time, s.status,
                u.chaiCode, u.leadStatus, (u.notes || []).map((n) => n.at.slice(0, 10) + ': ' + n.text).join(' | '), u.referredBy,
            ].map(q).join(',');
        });
        res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="investapas-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
            'cache-control': 'no-store',
        });
        return res.end('﻿' + cols.join(',') + '\n' + rows.join('\n'));
    } catch (err) {
        return handleError(res, 'adminExportCsv', err);
    }
};
