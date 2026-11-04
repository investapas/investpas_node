const dbcon = require('../config/mysqlClient');
const constants = require('../vars/constants');
const utility = require('./utility');
const query = require('./query');

const DB = constants.vals.defaultDB;

let _migrated = false;
async function _ensureMigration() {
    if (_migrated) return;
    try {
        await dbcon.query(DB,
            `CREATE TABLE IF NOT EXISTS challenge_discipline_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                dhan_client_id VARCHAR(50) NOT NULL,
                challenge_id INT NOT NULL,
                trade_date DATE NOT NULL,
                score INT NOT NULL,
                grade VARCHAR(2) NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY idx_hist (dhan_client_id, challenge_id, trade_date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, []);

        await dbcon.query(DB,
            `CREATE TABLE IF NOT EXISTS challenge_suggestions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                dhan_client_id VARCHAR(50) NOT NULL,
                challenge_id INT NOT NULL,
                suggestion_type ENUM('INCREASE_CAPITAL','REDUCE_COOLDOWN','LOOSEN_LIMITS','TIGHTEN_LIMITS') NOT NULL,
                current_value INT NOT NULL,
                suggested_value INT NOT NULL,
                field_name VARCHAR(50) NOT NULL,
                message TEXT NOT NULL,
                status ENUM('PENDING','ACCEPTED','REJECTED') DEFAULT 'PENDING',
                streak_days INT DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                resolved_at DATETIME DEFAULT NULL,
                KEY idx_sugg (dhan_client_id, status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, []);
    } catch (_) {}
    _migrated = true;
}

// Called by midnight cron — snapshot today's discipline score into history
exports.snapshotDailyScore = async function (dhanClientId, challengeId) {
    await _ensureMigration();
    try {
        const advChallenge = require('./advanceChallengeEngine');
        const result = await advChallenge.calculateDisciplineScore(dhanClientId, challengeId);

        await dbcon.query(DB,
            `INSERT INTO challenge_discipline_history (dhan_client_id, challenge_id, trade_date, score, grade)
             VALUES (?, ?, CURDATE(), ?, ?)
             ON DUPLICATE KEY UPDATE score=VALUES(score), grade=VALUES(grade)`,
            [dhanClientId, challengeId, result.score, result.grade]);
    } catch (e) {
        console.log('[Adaptive] snapshot error:', e.message);
    }
};

// Evaluate if user qualifies for a "loosen rules" suggestion (good streak)
// or needs a "tighten rules" suggestion (bad streak)
exports.evaluateAdaptiveSuggestion = async function (dhanClientId, challenge) {
    await _ensureMigration();
    try {
        // Don't re-suggest if a pending suggestion already exists
        const pending = await dbcon.query(DB,
            `SELECT id FROM challenge_suggestions
             WHERE dhan_client_id=? AND challenge_id=? AND status='PENDING' LIMIT 1`,
            [dhanClientId, challenge.id]);
        if (pending?.[0]) return null;

        // Get last 10 days of discipline history
        const history = await dbcon.query(DB,
            `SELECT score, grade, trade_date FROM challenge_discipline_history
             WHERE dhan_client_id=? AND challenge_id=?
             ORDER BY trade_date DESC LIMIT 10`,
            [dhanClientId, challenge.id]);

        if (!history || history.length < 5) return null; // need at least 5 days of data

        // Check for good streak: last N days all >= 80
        let goodStreak = 0;
        for (const h of history) {
            if (Number(h.score) >= 80) goodStreak++;
            else break;
        }

        // Check for bad streak: last N days all < 60
        let badStreak = 0;
        for (const h of history) {
            if (Number(h.score) < 60) badStreak++;
            else break;
        }

        const currentCapPct = Number(challenge.max_capital_per_trade_pct || 25);
        const currentCooldown = Number(challenge.cooldown_minutes || 5);

        // GOOD STREAK (5+ days, score >= 80) → suggest loosening
        if (goodStreak >= 5 && currentCapPct < 40) {
            const suggestedPct = Math.min(40, currentCapPct + 5);
            const message = `You maintained discipline for ${goodStreak} sessions. Increase allowed capital per trade from ${currentCapPct}% to ${suggestedPct}%?`;

            const insertRes = await dbcon.query(DB,
                `INSERT INTO challenge_suggestions
                 (dhan_client_id, challenge_id, suggestion_type, current_value, suggested_value, field_name, message, streak_days)
                 VALUES (?, ?, 'INCREASE_CAPITAL', ?, ?, 'max_capital_per_trade_pct', ?, ?)`,
                [dhanClientId, challenge.id, currentCapPct, suggestedPct, message, goodStreak]);

            await _notify(dhanClientId, '🎯 Discipline Milestone Reached', message);
            console.log(`[Adaptive] ${dhanClientId} good streak=${goodStreak} → suggestion #${insertRes?.insertId}`);
            return { type: 'INCREASE_CAPITAL', message, streak: goodStreak };
        }

        // BAD STREAK (3+ days, score < 60) → suggest tightening
        if (badStreak >= 3 && currentCooldown < 15) {
            const suggestedCooldown = Math.min(15, currentCooldown + 5);
            const message = `Your discipline score has been low for ${badStreak} sessions. Increase cooldown from ${currentCooldown} to ${suggestedCooldown} minutes to help reset your trading rhythm?`;

            const insertRes = await dbcon.query(DB,
                `INSERT INTO challenge_suggestions
                 (dhan_client_id, challenge_id, suggestion_type, current_value, suggested_value, field_name, message, streak_days)
                 VALUES (?, ?, 'TIGHTEN_LIMITS', ?, ?, 'cooldown_minutes', ?, ?)`,
                [dhanClientId, challenge.id, currentCooldown, suggestedCooldown, message, badStreak]);

            await _notify(dhanClientId, '⚠️ Discipline Check-In', message);
            console.log(`[Adaptive] ${dhanClientId} bad streak=${badStreak} → suggestion #${insertRes?.insertId}`);
            return { type: 'TIGHTEN_LIMITS', message, streak: badStreak };
        }

        return null;
    } catch (e) {
        console.log('[Adaptive] evaluate error:', e.message);
        return null;
    }
};

// Get pending suggestion for a user
exports.getPendingSuggestion = async function (dhanClientId, challengeId) {
    await _ensureMigration();
    const rows = await dbcon.query(DB,
        `SELECT * FROM challenge_suggestions
         WHERE dhan_client_id=? AND challenge_id=? AND status='PENDING'
         ORDER BY id DESC LIMIT 1`,
        [dhanClientId, challengeId]);
    return rows?.[0] || null;
};

// User accepts or rejects a suggestion — ONLY this applies the change (never automatic)
exports.resolveSuggestion = async function (dhanClientId, suggestionId, accept) {
    await _ensureMigration();
    const rows = await dbcon.query(DB,
        `SELECT * FROM challenge_suggestions WHERE id=? AND dhan_client_id=? AND status='PENDING' LIMIT 1`,
        [suggestionId, dhanClientId]);
    const suggestion = rows?.[0];
    if (!suggestion) return { success: false, message: 'Suggestion not found or already resolved' };

    await dbcon.query(DB,
        `UPDATE challenge_suggestions SET status=?, resolved_at=NOW() WHERE id=?`,
        [accept ? 'ACCEPTED' : 'REJECTED', suggestionId]);

    if (accept) {
        await dbcon.query(DB,
            `UPDATE user_challenges SET ${suggestion.field_name}=? WHERE dhan_client_id=? AND is_active=1`,
            [suggestion.suggested_value, dhanClientId]);
        console.log(`[Adaptive] ${dhanClientId} ACCEPTED suggestion: ${suggestion.field_name} → ${suggestion.suggested_value}`);
    } else {
        console.log(`[Adaptive] ${dhanClientId} REJECTED suggestion #${suggestionId}`);
    }

    return { success: true, applied: accept };
};

async function _notify(dhanClientId, title, body) {
    try {
        const row = await query.fetchSingleRecord(DB, 'users', `WHERE dhan_client_id='${dhanClientId}'`, 'firebase_token');
        const token = row?.firebase_token;
        if (!token) return;
        await utility.sendNotification([token], 'challengeBlocked', '', { title, body });
    } catch (_) {}
}
