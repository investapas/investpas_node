// NSE/BSE trading-holiday list (dates the exchange is closed on an
// otherwise-tradeable weekday). Weekend-only holidays don't need an entry
// here since isTradingDay already excludes Saturdays/Sundays.
//
// MAINTENANCE: this list is year-specific and must be updated annually
// with the official NSE holiday calendar (nseindia.com).
const HOLIDAYS_2026 = [
    '2026-01-26', // Republic Day
    '2026-03-03', // Holi
    '2026-03-26', // Ram Navami
    '2026-03-31', // Mahavir Jayanti
    '2026-04-03', // Good Friday
    '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
    '2026-05-01', // Maharashtra Day
    '2026-05-28', // Bakri Id
    '2026-06-26', // Muharram
    '2026-09-14', // Ganesh Chaturthi
    '2026-10-02', // Mahatma Gandhi Jayanti
    '2026-10-20', // Dussehra
    '2026-11-10', // Diwali-Balipratipada
    '2026-11-24', // Guru Nanak Jayanti
    '2026-12-25', // Christmas
];

const HOLIDAY_SET = new Set(HOLIDAYS_2026);

function toDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function isHoliday(date) {
    return HOLIDAY_SET.has(toDateKey(date));
}

function isTradingDay(date) {
    const day = date.getDay(); // 0=Sun, 6=Sat
    if (day === 0 || day === 6) return false;
    return !isHoliday(date);
}

// Adds [n] trading days to [start] — start itself counts as day 1 if it's
// a trading day (mirrors challenge_days semantics: an N-day challenge
// starting on a trading day should span N actual trading sessions, not
// N raw calendar days).
function addTradingDays(start, n) {
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    let remaining = n;
    if (remaining <= 0) return cursor;
    if (isTradingDay(cursor)) remaining--;
    while (remaining > 0) {
        cursor.setDate(cursor.getDate() + 1);
        if (isTradingDay(cursor)) remaining--;
    }
    return cursor;
}

module.exports = { isHoliday, isTradingDay, addTradingDays };
