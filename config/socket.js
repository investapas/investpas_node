const dhanFeed  = require('../helpers/dhanMarketFeed');
const dbQuery   = require('../helpers/query');
const constants = require('../vars/constants');
const dbcon     = require('../config/mysqlClient');
const utility   = require('../helpers/utility');
const instrumentStatus = require('../helpers/instrumentStatus');

async function getMarketToken() {
    const clientId = process.env.DHAN_MARKET_CLIENT_ID;

    // console.log('[Socket][Token] Step 1 — clientId from env:', clientId || '❌ NOT SET');

    if (!clientId) {
        // console.log('[Socket][Token] ❌ DHAN_MARKET_CLIENT_ID not set in .env');
        return { clientId: null, token: null };
    }

    try {
        // Step 2: Init DB connection if needed
        // console.log('[Socket][Token] Step 2 — checking DB connection...');
        if (utility.checkEmpty(constants.vals.dbconn)) {
            // console.log('[Socket][Token] Step 2 — DB not ready, initializing...');
            constants.vals.dbconn = await dbcon.connection();
            // console.log('[Socket][Token] Step 2 ✅ DB connected');
        } else {
            // console.log('[Socket][Token] Step 2 ✅ DB already connected');
        }

        // Step 3: Try market_data_tokens table
        // console.log('[Socket][Token] Step 3 — querying market_data_tokens table...');
        let marketToken = null;
        try {
            marketToken = await dbQuery.fetchSingleRecord(
                constants.vals.defaultDB,
                'market_data_tokens',
                `WHERE dhan_client_id = '${clientId}'`
            );
            // console.log('[Socket][Token] Step 3 — market_data_tokens result:',
            //     marketToken ? (Array.isArray(marketToken) ? 'empty []' : `found (token len=${marketToken.access_token?.length || 0})`) : 'null');
        } catch (e) {
            console.log('[Socket][Token] Step 3 ⚠️  market_data_tokens query failed (table may not exist):', e.message);
        }

        if (marketToken && !Array.isArray(marketToken) && marketToken.access_token) {
            // console.log('[Socket][Token] Step 3 ✅ Token from market_data_tokens table (SELF token)');
            return { clientId, token: marketToken.access_token, source: 'market_data_tokens' };
        }
        // console.log('[Socket][Token] Step 3 — market_data_tokens empty, skipping users table (PARTNER tokens not valid for market feed)');

        // Step 4: ENV SELF token only (not users table — that has PARTNER tokens)
        const envToken = process.env.DHAN_MARKET_ACCESS_TOKEN;
        // console.log('[Socket][Token] Step 4 — ENV SELF token len:', envToken ? envToken.length : 0);
        if (envToken) {
            console.log('[Socket][Token] Step 4 ⚠️  Using ENV SELF token');
            return { clientId, token: envToken, source: 'ENV' };
        }

        // console.log('[Socket][Token] ❌ No token found anywhere');
        return { clientId: null, token: null };

    } catch (e) {
        // console.log('[Socket][Token] ❌ Fatal error:', e.message);
        const envToken = process.env.DHAN_MARKET_ACCESS_TOKEN;
        console.log('[Socket][Token] Using ENV fallback after error, token len:', envToken ? envToken.length : 0);
        return { clientId, token: envToken || null, source: 'ENV' };
    }
}

function setupSocket(io) {

    // console.log('[Socket] ===== setupSocket called =====');

    getMarketToken().then(({ clientId, token, source }) => {
        console.log('[Socket] getMarketToken resolved:');
        console.log('  clientId :', clientId);
        console.log('  source   :', source);
        console.log('  tokenLen :', token ? token.length : 0);

        if (clientId && token) {
            // console.log('[Socket] Starting DhanFeed...');
            dhanFeed.start(clientId, token);
        } else {
            console.log('[Socket] ❌ No credentials — DhanFeed NOT started');
        }
    }).catch(e => {
        console.log('[Socket] ❌ getMarketToken() threw:', e.message);
    });

    dhanFeed.on('price', (data) => {
        io.to('market').emit('priceUpdate', data);
    });

    io.on('connection', (socket) => {
        // console.log('[Socket] Client connected:', socket.id);

        socket.on('subscribeMarket', async (data) => {
            socket.join('market');
            // console.log(`[Socket] ${socket.id} joined market room`);

            const { instruments } = data || {};
            if (instruments && Array.isArray(instruments) && instruments.length > 0) {
                // Never stream expired contracts, even if a stale client asks.
                let allowed = instruments;
                try {
                    allowed = await instrumentStatus.filterSubscribable(instruments);
                } catch (e) {
                    console.log('[Socket] ⚠️  subscribe filter failed, subscribing as requested:', e.message);
                }
                if (allowed.length) dhanFeed.subscribe(allowed);
            } else {
                console.log('[Socket] ⚠️  No instruments in subscribeMarket');
            }
        });

        socket.on('unsubscribeMarket', () => socket.leave('market'));

        socket.on('disconnect', () => {
            console.log('[Socket] Client disconnected:', socket.id);
        });
    });
}

module.exports = { setupSocket };
