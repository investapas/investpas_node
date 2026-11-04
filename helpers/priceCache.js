const dhanFeed = require('./dhanMarketFeed');

// Latest LTP per securityId, populated by the live Dhan WebSocket feed.
const _prices = new Map();

dhanFeed.on('price', ({ securityId, ltp }) => {
    if (securityId != null && ltp != null) {
        _prices.set(String(securityId), Number(ltp));
    }
});

// Returns the cached LTP for a given securityId, or null if not yet received.
function getPrice(securityId) {
    return _prices.get(String(securityId)) ?? null;
}

module.exports = { getPrice };
