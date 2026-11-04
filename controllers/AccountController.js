const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const dbcon = require("../config/mysqlClient");
const constants = require("../vars/constants");
const apiResponse = require("../vars/apiResponse");
const firebaseAdmin = require("../helpers/firebase");

// Website phone-OTP runs on its own Firebase project (separate from the
// app's push-notification project in firebase_admin_sdk.json). Verifying an
// ID token only needs the project id — no service-account key.
const WEB_FIREBASE_PROJECT_ID = process.env.WEB_FIREBASE_PROJECT_ID || "investapas-334e3";
const webAuthApp = firebaseAdmin.apps.find((a) => a && a.name === "website-auth")
    || firebaseAdmin.initializeApp({ projectId: WEB_FIREBASE_PROJECT_ID }, "website-auth");
const advChallenge = require("../helpers/advanceChallengeEngine");
const { isTradingDay, addTradingDays } = require("../helpers/nseHolidays");
const { PLAN_PRICES, getRazorpay } = require("./PaymentController");

const DB = constants.vals.defaultDB;

// Website account flow (phone-first):
//   signup (Firebase phone OTP) -> plan -> [Razorpay] -> challenge -> dashboard
// The account lives in `users`, keyed by the verified mobile number.
// dhan_client_id stays NULL until the user connects Dhan from the app.

// Free trial mirrors the app's SelectPlanPage (30 trading days, no payment).
const PLANS = {
    trial: { label: "Free Trial", amountPaise: 0, challengeDays: 30 },
    firstWeek: PLAN_PRICES.firstWeek,
    monthly: PLAN_PRICES.monthly,
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── helpers ─────────────────────────────────────────────────────────────

// Verifies a Firebase ID token from the website's phone-OTP sign-in and
// returns the Indian 10-digit mobile it was issued for.
async function verifyPhoneToken(idToken) {
    if (!idToken) throw new UserError("Please verify your mobile number first.");
    let decoded;
    try {
        decoded = await webAuthApp.auth().verifyIdToken(idToken);
    } catch (e) {
        throw new UserError("OTP session expired. Please verify your number again.");
    }
    const phone = decoded.phone_number || "";
    if (!phone.startsWith("+91") || phone.length !== 13) {
        throw new UserError("Only Indian (+91) mobile numbers are supported.");
    }
    return { uid: decoded.uid, mobile: phone.slice(3) };
}

class UserError extends Error {}

function issueToken(userId) {
    return jwt.sign({ userId, type: "web" }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    });
}

async function getUser(userId) {
    const rows = await dbcon.query(
        DB,
        `SELECT id, full_name, email, mobile_number, dhan_client_id, dhan_client_name, created_at
         FROM users WHERE id=? AND is_active=1 LIMIT 1`,
        [userId]
    );
    return rows && rows[0];
}

// Challenges belong to the account by user_id; app-created ones made before
// the account had a user_id link are still matched through dhan_client_id.
function ownerClause(user) {
    if (user.dhan_client_id) {
        return { sql: "(user_id=? OR dhan_client_id=?)", params: [user.id, user.dhan_client_id] };
    }
    return { sql: "user_id=?", params: [user.id] };
}

async function getActiveChallenge(user) {
    const owner = ownerClause(user);
    const rows = await dbcon.query(
        DB,
        `SELECT * FROM user_challenges WHERE ${owner.sql} AND is_active=1 ORDER BY id DESC LIMIT 1`,
        owner.params
    );
    return rows && rows[0];
}

async function countChallenges(user) {
    const owner = ownerClause(user);
    const rows = await dbcon.query(
        DB,
        `SELECT COUNT(*) AS total FROM user_challenges WHERE ${owner.sql}`,
        owner.params
    );
    return Number((rows && rows[0] && rows[0].total) || 0);
}

// A verified payment that hasn't been turned into a challenge yet — lets the
// user resume at the challenge step instead of paying twice.
async function getUnusedPayment(user, planType) {
    const params = [user.id];
    let planFilter = "";
    if (planType) {
        planFilter = "AND plan_type=?";
        params.push(planType);
    }
    const rows = await dbcon.query(
        DB,
        `SELECT * FROM plan_payments
         WHERE user_id=? ${planFilter} AND status='paid' AND used_for_challenge=0
         ORDER BY id DESC LIMIT 1`,
        params
    );
    return rows && rows[0];
}

// Where the signup flow should resume for this account.
async function nextStepFor(user) {
    if (await getActiveChallenge(user)) return { step: "dashboard" };
    const unused = await getUnusedPayment(user);
    if (unused) return { step: "challenge", planType: unused.plan_type, razorpayOrderId: unused.razorpay_order_id };
    return { step: "plan" };
}

function publicUser(user) {
    return {
        id: user.id,
        fullName: user.full_name || user.dhan_client_name || "",
        email: user.email || "",
        mobileNumber: user.mobile_number || "",
        dhanConnected: !!user.dhan_client_id,
        memberSince: user.created_at,
    };
}

function parseDbDate(value) {
    if (!value) return null;
    return new Date(String(value).replace(" ", "T"));
}

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Trading-day progress: "day X of N", how many sessions are left.
function challengeProgress(c) {
    const total = Number(c.challenge_days || 0);
    const start = parseDbDate(c.challenge_start_date);
    const end = parseDbDate(c.challenge_end_date);
    const today = startOfDay(new Date());

    let elapsed = 0;
    if (start) {
        const cursor = startOfDay(start);
        while (cursor <= today && elapsed < total) {
            if (isTradingDay(cursor)) elapsed++;
            cursor.setDate(cursor.getDate() + 1);
        }
    }
    return {
        totalDays: total,
        daysCompleted: elapsed,
        daysPending: Math.max(total - elapsed, 0),
        isTradingToday: isTradingDay(today),
        hasEnded: !!end && startOfDay(end) < today,
    };
}

function formatChallenge(c) {
    return {
        id: c.id,
        status: c.status || (c.is_active ? "ACTIVE" : "COMPLETED"),
        challengeStatus: c.challenge_status,
        isActive: !!c.is_active,
        tradingCapital: Number(c.trading_capital || 0),
        minProfit: Number(c.min_profit || 0),
        maxProfit: Number(c.max_profit || 0),
        minLoss: Number(c.min_loss || 0),
        maxLoss: Number(c.max_loss || 0),
        maxTradesPerDay: c.max_trades_per_day,
        cooldownMinutes: c.cooldown_minutes,
        lots: {
            nifty: c.nifty_lots || 0,
            bankNifty: c.banknifty_lots || 0,
            finNifty: c.finnifty_lots || 0,
            midcapNifty: c.midcapnifty_lots || 0,
            sensex: c.sensex_lots || 0,
        },
        challengeDays: c.challenge_days,
        startDate: c.challenge_start_date,
        endDate: c.challenge_end_date,
        completedAt: c.completed_at,
        finalPnl: Number(c.final_pnl || 0),
        totalTrades: Number(c.total_trades_count || 0),
        createdAt: c.created_at,
    };
}

function handleError(res, where, err) {
    if (err instanceof UserError) return apiResponse.validationErrorResponse(res, err.message);
    console.error(`[Account] ${where} error:`, err.message);
    return apiResponse.ErrorResponse(res, "Something went wrong. Please try again.");
}

// ── POST /account/signup  { idToken, fullName, email, acceptTerms } ─────
exports.signup = async (req, res) => {
    try {
        const { idToken, fullName, email, acceptTerms } = req.body;

        const name = (fullName || "").trim();
        const mail = (email || "").trim().toLowerCase();
        if (name.length < 2 || name.length > 150) {
            return apiResponse.validationErrorResponse(res, "Please enter your full name.");
        }
        if (!EMAIL_REGEX.test(mail)) {
            return apiResponse.validationErrorResponse(res, "Please enter a valid email address.");
        }
        if (!acceptTerms) {
            return apiResponse.validationErrorResponse(res, "Please accept the Risk Disclosure and Terms.");
        }

        const { uid, mobile } = await verifyPhoneToken(idToken);

        const existing = await dbcon.query(DB, `SELECT id FROM users WHERE mobile_number=? LIMIT 1`, [mobile]);
        if (existing && existing[0]) {
            return apiResponse.validationErrorWithData(res,
                "This mobile number already has an account. Please log in.", { accountExists: true });
        }

        const result = await dbcon.query(
            DB,
            `INSERT INTO users (full_name, email, mobile_number, firebase_uid, signup_source, is_active)
             VALUES (?, ?, ?, ?, 'website', 1)`,
            [name, mail, mobile, uid]
        );

        const user = await getUser(result.insertId);
        return apiResponse.successResponseWithData(res, "Account created.", {
            token: issueToken(user.id),
            user: publicUser(user),
            next: { step: "plan" },
        });
    } catch (err) {
        return handleError(res, "signup", err);
    }
};

// ── POST /account/login  { idToken } ────────────────────────────────────
exports.login = async (req, res) => {
    try {
        const { uid, mobile } = await verifyPhoneToken(req.body.idToken);

        const rows = await dbcon.query(
            DB,
            `SELECT id FROM users WHERE mobile_number=? AND is_active=1 LIMIT 1`,
            [mobile]
        );
        if (!rows || !rows[0]) {
            return apiResponse.validationErrorWithData(res,
                "No account found for this number. Please sign up first.", { accountExists: false });
        }

        await dbcon.query(DB, `UPDATE users SET firebase_uid=? WHERE id=?`, [uid, rows[0].id]);

        const user = await getUser(rows[0].id);
        return apiResponse.successResponseWithData(res, "Logged in.", {
            token: issueToken(user.id),
            user: publicUser(user),
            next: await nextStepFor(user),
        });
    } catch (err) {
        return handleError(res, "login", err);
    }
};

// ── GET /account/me ─────────────────────────────────────────────────────
exports.me = async (req, res) => {
    try {
        const user = await getUser(req.webUser.userId);
        if (!user) return apiResponse.unauthorizedResponse(res, "Account not found. Please log in again.");

        return apiResponse.successResponseWithData(res, "OK", {
            user: publicUser(user),
            next: await nextStepFor(user),
            trialAvailable: (await countChallenges(user)) === 0,
        });
    } catch (err) {
        return handleError(res, "me", err);
    }
};

// ── POST /account/plan  { planType: 'trial' | 'firstWeek' | 'monthly' } ──
// Free trial: nothing to pay, go straight to challenge setup.
// Paid: creates (or reuses) a Razorpay order the page opens checkout with.
exports.selectPlan = async (req, res) => {
    try {
        const user = await getUser(req.webUser.userId);
        if (!user) return apiResponse.unauthorizedResponse(res, "Account not found. Please log in again.");

        const { planType } = req.body;
        const plan = PLANS[planType];
        if (!plan) return apiResponse.validationErrorResponse(res, "Please choose a plan.");

        if (await getActiveChallenge(user)) {
            return apiResponse.validationErrorResponse(res,
                "You already have an active challenge. Finish it before starting a new one.");
        }

        if (planType === "trial") {
            if ((await countChallenges(user)) > 0) {
                return apiResponse.validationErrorResponse(res,
                    "The free trial is only for your first challenge. Please choose a paid plan.");
            }
            return apiResponse.successResponseWithData(res, "Free trial selected.", {
                planType, free: true, next: { step: "challenge", planType },
            });
        }

        const unused = await getUnusedPayment(user, planType);
        if (unused) {
            return apiResponse.successResponseWithData(res, "Plan already paid.", {
                planType, alreadyPaid: true,
                next: { step: "challenge", planType, razorpayOrderId: unused.razorpay_order_id },
            });
        }

        const order = await getRazorpay().orders.create({
            amount: plan.amountPaise,
            currency: "INR",
            receipt: `web_${user.id}_${planType}_${Date.now()}`,
            notes: { userId: String(user.id), planType, source: "website" },
        });

        await dbcon.query(
            DB,
            `INSERT INTO plan_payments (user_id, dhan_client_id, plan_type, amount_paise, razorpay_order_id, status)
             VALUES (?, ?, ?, ?, ?, 'created')`,
            [user.id, user.dhan_client_id || null, planType, plan.amountPaise, order.id]
        );

        return apiResponse.successResponseWithData(res, "Order created.", {
            planType,
            orderId: order.id,
            amount: plan.amountPaise,
            currency: "INR",
            keyId: process.env.RAZORPAY_KEY_ID,
            planLabel: plan.label,
            prefill: { name: user.full_name || "", email: user.email || "", contact: user.mobile_number || "" },
        });
    } catch (err) {
        return handleError(res, "selectPlan", err);
    }
};

// ── POST /account/payment/verify  { razorpay_order_id, razorpay_payment_id, razorpay_signature } ──
exports.verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return apiResponse.validationErrorResponse(res, "Missing payment details.");
        }

        const rows = await dbcon.query(
            DB,
            `SELECT * FROM plan_payments WHERE razorpay_order_id=? AND user_id=? LIMIT 1`,
            [razorpay_order_id, req.webUser.userId]
        );
        const record = rows && rows[0];
        if (!record) return apiResponse.validationErrorResponse(res, "Order not found for this account.");

        const expected = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");

        if (expected !== razorpay_signature) {
            await dbcon.query(
                DB,
                `UPDATE plan_payments SET status='failed', razorpay_payment_id=? WHERE id=?`,
                [razorpay_payment_id, record.id]
            );
            return apiResponse.validationErrorResponse(res, "Payment verification failed.");
        }

        await dbcon.query(
            DB,
            `UPDATE plan_payments SET status='paid', razorpay_payment_id=?, verified_at=NOW() WHERE id=?`,
            [razorpay_payment_id, record.id]
        );

        return apiResponse.successResponseWithData(res, "Payment successful.", {
            next: { step: "challenge", planType: record.plan_type, razorpayOrderId: razorpay_order_id },
        });
    } catch (err) {
        return handleError(res, "verifyPayment", err);
    }
};

// ── POST /account/challenge ─────────────────────────────────────────────
// { planType, razorpayOrderId?, tradingCapital, minProfit, maxProfit,
//   minLoss, maxLoss, maxTradesPerDay, niftyLots, bankNiftyLots,
//   finNiftyLots, midcapNiftyLots, sensexLots }
exports.createChallenge = async (req, res) => {
    try {
        const user = await getUser(req.webUser.userId);
        if (!user) return apiResponse.unauthorizedResponse(res, "Account not found. Please log in again.");

        const b = req.body;
        const plan = PLANS[b.planType];
        if (!plan) return apiResponse.validationErrorResponse(res, "Please choose a plan first.");

        const num = (v) => Number(v) || 0;
        const int = (v) => Math.max(0, Math.floor(Number(v) || 0));
        const rules = {
            tradingCapital: num(b.tradingCapital),
            minProfit: num(b.minProfit),
            maxProfit: num(b.maxProfit),
            minLoss: num(b.minLoss),
            maxLoss: num(b.maxLoss),
            maxTradesPerDay: int(b.maxTradesPerDay),
            niftyLots: int(b.niftyLots),
            bankNiftyLots: int(b.bankNiftyLots),
            finNiftyLots: int(b.finNiftyLots),
            midcapNiftyLots: int(b.midcapNiftyLots),
            sensexLots: int(b.sensexLots),
        };

        if (rules.tradingCapital < 1000) {
            return apiResponse.validationErrorResponse(res, "Trading capital must be at least ₹1,000.");
        }
        if (rules.maxTradesPerDay < 1 || rules.maxTradesPerDay > 50) {
            return apiResponse.validationErrorResponse(res, "Max trades per day must be between 1 and 50.");
        }
        if (rules.maxProfit <= 0 || rules.minProfit > rules.maxProfit) {
            return apiResponse.validationErrorResponse(res, "Set a daily profit target (min must not exceed max).");
        }
        if (rules.maxLoss <= 0 || rules.minLoss > rules.maxLoss) {
            return apiResponse.validationErrorResponse(res, "Set a daily loss limit (min must not exceed max).");
        }
        if (rules.maxLoss > rules.tradingCapital) {
            return apiResponse.validationErrorResponse(res, "Max loss can't be more than your trading capital.");
        }
        const totalLots = rules.niftyLots + rules.bankNiftyLots + rules.finNiftyLots
            + rules.midcapNiftyLots + rules.sensexLots;
        if (totalLots < 1) {
            return apiResponse.validationErrorResponse(res, "Allow at least one lot on one index.");
        }

        if (await getActiveChallenge(user)) {
            return apiResponse.validationErrorResponse(res, "You already have an active challenge.");
        }

        let paymentId = null;
        if (b.planType === "trial") {
            if ((await countChallenges(user)) > 0) {
                return apiResponse.validationErrorResponse(res,
                    "The free trial is only for your first challenge. Please choose a paid plan.");
            }
        } else {
            const rows = await dbcon.query(
                DB,
                `SELECT id FROM plan_payments
                 WHERE user_id=? AND razorpay_order_id=? AND plan_type=? AND status='paid' AND used_for_challenge=0
                 LIMIT 1`,
                [user.id, b.razorpayOrderId || "", b.planType]
            );
            if (!rows || !rows[0]) {
                return apiResponse.validationErrorResponse(res, "Payment not found for this plan. Please pay first.");
            }
            paymentId = rows[0].id;
        }

        const style = "SCALPER";
        const d = advChallenge.getStyleDefaults(style);
        const now = new Date();

        const result = await dbcon.query(
            DB,
            `INSERT INTO user_challenges SET ?`,
            [{
                user_id: user.id,
                dhan_client_id: user.dhan_client_id || null,
                trading_style: style,
                trading_capital: rules.tradingCapital,
                min_profit: rules.minProfit,
                max_profit: rules.maxProfit,
                min_loss: rules.minLoss,
                max_loss: rules.maxLoss,
                max_trades_per_day: rules.maxTradesPerDay,
                cooldown_minutes: d.cooldown_minutes,
                consecutive_loss_limit: d.consecutive_loss_limit,
                max_capital_per_trade_pct: d.max_capital_per_trade_pct,
                risk_per_trade_pct: d.risk_per_trade_pct,
                target_per_trade_pct: d.target_per_trade_pct,
                hero_trade_allowed: d.hero_trade_allowed,
                nifty_lots: rules.niftyLots,
                banknifty_lots: rules.bankNiftyLots,
                finnifty_lots: rules.finNiftyLots,
                midcapnifty_lots: rules.midcapNiftyLots,
                sensex_lots: rules.sensexLots,
                plan_type: b.planType,
                challenge_days: plan.challengeDays,
                challenge_start_date: now,
                challenge_end_date: addTradingDays(now, plan.challengeDays),
                is_active: 1,
                status: "ACTIVE",
            }]
        );

        if (paymentId) {
            await dbcon.query(DB, `UPDATE plan_payments SET used_for_challenge=1 WHERE id=?`, [paymentId]);
        }

        return apiResponse.successResponseWithData(res, "Your challenge is set up.", {
            challengeId: result.insertId,
            next: { step: "dashboard" },
        });
    } catch (err) {
        return handleError(res, "createChallenge", err);
    }
};

// ── GET /account/dashboard ──────────────────────────────────────────────
exports.dashboard = async (req, res) => {
    try {
        const user = await getUser(req.webUser.userId);
        if (!user) return apiResponse.unauthorizedResponse(res, "Account not found. Please log in again.");

        const owner = ownerClause(user);
        const challenges = (await dbcon.query(
            DB,
            `SELECT * FROM user_challenges WHERE ${owner.sql} ORDER BY created_at DESC, id DESC`,
            owner.params
        )) || [];

        const activeRow = challenges.find((c) => c.is_active);
        const current = activeRow
            ? { ...formatChallenge(activeRow), progress: challengeProgress(activeRow) }
            : null;
        const history = challenges.filter((c) => !c.is_active).map(formatChallenge);

        const payments = (await dbcon.query(
            DB,
            `SELECT plan_type, amount_paise, status, created_at, verified_at
             FROM plan_payments WHERE user_id=? AND status='paid' ORDER BY id DESC`,
            [user.id]
        )) || [];

        return apiResponse.successResponseWithData(res, "OK", {
            user: publicUser(user),
            next: await nextStepFor(user),
            trialAvailable: challenges.length === 0,
            current,
            history,
            stats: {
                totalChallenges: challenges.length,
                completed: history.filter((c) => c.status === "COMPLETED").length,
                totalPnl: history.reduce((s, c) => s + c.finalPnl, 0),
            },
            payments: payments.map((p) => ({
                planType: p.plan_type,
                planLabel: (PLANS[p.plan_type] && PLANS[p.plan_type].label) || p.plan_type,
                amountPaise: p.amount_paise,
                paidAt: p.verified_at || p.created_at,
            })),
        });
    } catch (err) {
        return handleError(res, "dashboard", err);
    }
};

// Shared with EarlyAccessController (new website): one Firebase phone check
// and one web-session token format for every website flow.
exports.verifyPhoneToken = verifyPhoneToken;
exports.issueToken = issueToken;
exports.UserError = UserError;
