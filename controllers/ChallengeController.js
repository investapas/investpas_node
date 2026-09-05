const query = require("../helpers/query");
const constants = require("../vars/constants");
const utility = require("../helpers/utility");

// CREATE CHALLENGE
exports.createChallenge = async (req, res) => {

    try {

        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({
                status: false,
                message: "User authentication required"
            });
        }

        const dhanClientId = user.dhanClientId;

        const {
            tradingCapital,
            minProfit,
            maxProfit,
            minLoss,
            maxLoss,
            maxTradesPerDay,
            niftyLots,
            bankNiftyLots,
            finNiftyLots,
            midcapNiftyLots,
            sensexLots,
            challengeDays
        } = req.body.inputdata; // ⚠️ no inputdata

        // 🔍 check existing challenge
        const existing = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );

        // ================= UPDATE =================
        if (existing && existing.id) {

            const updateRes = await query.updateRecord(
                constants.vals.defaultDB,
                "user_challenges",
                `id=${existing.id}`,
                `
                trading_capital=${tradingCapital},
                min_profit=${minProfit},
                max_profit=${maxProfit},
                min_loss=${minLoss},
                max_loss=${maxLoss},
                max_trades_per_day=${maxTradesPerDay},
                nifty_lots=${niftyLots},
                banknifty_lots=${bankNiftyLots},
                finnifty_lots=${finNiftyLots},
                midcapnifty_lots=${midcapNiftyLots},
                sensex_lots=${sensexLots},
                challenge_days=${challengeDays},
                challenge_start_date=NOW(),
                challenge_end_date=DATE_ADD(NOW(), INTERVAL ${challengeDays} DAY),
                updated_at=NOW()
                `
            );

            if (!updateRes) {
                return res.json({
                    status: false,
                    message: "Update failed"
                });
            }

            return res.json({
                status: true,
                message: "Challenge updated successfully"
            });

        }

        // ================= INSERT =================
        else {

            const insertRes = await query.insertSingle(
                constants.vals.defaultDB,
                "user_challenges",
                {
                    dhan_client_id: dhanClientId,
                    trading_capital: tradingCapital,
                    min_profit: minProfit,
                    max_profit: maxProfit,
                    min_loss: minLoss,
                    max_loss: maxLoss,
                    max_trades_per_day: maxTradesPerDay,
                    nifty_lots: niftyLots,
                    banknifty_lots: bankNiftyLots,
                    finnifty_lots: finNiftyLots,
                    midcapnifty_lots: midcapNiftyLots,
                    sensex_lots: sensexLots,
                    challenge_days: challengeDays,
                    challenge_start_date: new Date(),
                    challenge_end_date: new Date(Date.now() + challengeDays * 24 * 60 * 60 * 1000),
                    is_active: 1
                }
            );

            if (!insertRes) {
                return res.json({
                    status: false,
                    message: "Insert failed"
                });
            }

            return res.json({
                status: true,
                message: "Challenge created successfully",
                data: {
                    challengeId: insertRes
                }
            });
        }
    } catch (error) {
        res.json({
            status: false,
            message: error.message
        });
    }
};

// GET CURRENT CHALLENGE
exports.getCurrentChallenge = async (req, res) => {

    try {

        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({
                status: false,
                message: "User authentication required"
            });
        }

        const dhanClientId = user.dhanClientId;
        const result = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );

        res.json({
            status: true,
            data: result || null
        });
    } catch (error) {
        res.json({
            status: false,
            message: error.message
        });
    }
};

// CHECK ORDER RULES
exports.checkOrderRules = async (req, res) => {

    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({
                status: false,
                message: "User authentication required"
            });
        }

        const dhanClientId = user.dhanClientId;
        let { index, quantity } = req.body;

        index = index?.toUpperCase();

        // cooldown check
        const cooldown = await query.fetchRecords(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            `WHERE dhan_client_id='${dhanClientId}' AND pause_end > NOW() ORDER BY id DESC LIMIT 1`
        );

        if (cooldown.length) {
            return res.json({
                allowed: false,
                rule: "COOLDOWN_ACTIVE",
                pause_end: cooldown[0].pause_end
            });
        }

        // challenge
        const rules = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );

        if (!rules) return res.json({ allowed: true });

        // pnl
        const pnlData = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_trade_logs",
            `WHERE dhan_client_id='${dhanClientId}' AND trade_date=CURDATE()`,
            "SUM(pnl) as total"
        );

        const todayPnL = pnlData?.total || 0;

        if (todayPnL <= -rules.max_loss) {
            await exports.triggerCooldown(dhanClientId, rules.id, "DAILY_LOSS_LIMIT");
            return res.json({ allowed: false, rule: "DAILY_LOSS_LIMIT" });
        }

        if (todayPnL >= rules.max_profit) {
            await exports.triggerCooldown(dhanClientId, rules.id, "DAILY_PROFIT_TARGET");
            return res.json({ allowed: false, rule: "DAILY_PROFIT_TARGET" });
        }

        // trades
        const tradeCount = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_trade_logs",
            `WHERE dhan_client_id='${dhanClientId}' AND trade_date=CURDATE()`,
            "COUNT(*) as total"
        );

        if ((tradeCount?.total || 0) >= rules.max_trades_per_day) {
            await exports.triggerCooldown(dhanClientId, rules.id, "MAX_TRADES_LIMIT");
            return res.json({ allowed: false, rule: "MAX_TRADES_LIMIT" });
        }

        // quantity
        let allowedQty = {
            NIFTY: rules.nifty_lots,
            BANKNIFTY: rules.banknifty_lots,
            FINNIFTY: rules.finnifty_lots,
            MIDCAPNIFTY: rules.midcapnifty_lots,
            SENSEX: rules.sensex_lots
        }[index] || 0;

        if (quantity > allowedQty) {
            return res.json({
                allowed: false,
                rule: "QUANTITY_RULE",
                message: `Allowed ${allowedQty}`
            });
        }

        res.json({ allowed: true });

    } catch (error) {
        console.log(error);
        res.json({ allowed: false, message: error.message });
    }
};

exports.logTrade = async (req, res) => {

    try {
        const user = req.user;
        if (!user || !user.dhanClientId) {
            return res.json({
                status: false,
                message: "User authentication required"
            });
        }

        const dhanClientId = user.dhanClientId;
        const { index, quantity, pnl } = req.body;

        const challenge = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "user_challenges",
            `WHERE dhan_client_id='${dhanClientId}' AND is_active=1`
        );

        await query.insertSingle(
            constants.vals.defaultDB,
            "challenge_trade_logs",
            {
                dhan_client_id: dhanClientId,
                challenge_id: challenge?.id || null,
                index_name: index,
                quantity,
                pnl,
                trade_date: new Date()
            }
        );

        res.json({
            status: true,
            message: "Trade logged successfully"
        });

    } catch (error) {
        console.log(error);
        res.json({ status: false, message: error.message });
    }
};

exports.checkCooldown = async (req, res) => {

    try {
        const user = req.user;
        const pause = await query.fetchRecords(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            `WHERE dhan_client_id='${user.dhanClientId}' AND pause_end > NOW() ORDER BY id DESC LIMIT 1`
        );

        if (pause.length) {
            return res.json({
                allowed: false,
                pause_end: pause[0].pause_end
            });
        }

        res.json({ allowed: true });

    } catch (error) {
        res.json({ allowed: false, message: error.message });
    }
};

exports.triggerCooldown = async (dhanClientId, challengeId, rule) => {
    try {
        await query.insertSingle(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            {
                dhan_client_id: dhanClientId,
                challenge_id: challengeId,
                rule_triggered: rule,
                pause_start: new Date(),
                pause_end: new Date(Date.now() + 30 * 60 * 1000)
            }
        );

    } catch (error) {
        console.log(error);
    }
};

exports.quickUnlock = async (req, res) => {

    try {
        const user = req.user;
        const pause = await query.fetchSingleRecord(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            `WHERE dhan_client_id='${user.dhanClientId}' AND pause_end > NOW() ORDER BY id DESC`
        );

        if (!pause || !pause.id) {
            return res.json({
                status: false,
                message: "No active cooldown"
            });
        }

        await query.updateRecord(
            constants.vals.defaultDB,
            "challenge_pause_logs",
            `id=${pause.id}`,
            `
            pause_end=NOW(),
            quick_unlock_used=1,
            updated_at=NOW()
            `
        );

        res.json({
            status: true,
            message: "Trading resumed"
        });

    } catch (error) {
        res.json({ status: false, message: error.message });
    }
};
