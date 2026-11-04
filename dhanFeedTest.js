// Live Market Price Test — with correct exchange segment mapping
require('dotenv').config({ path: './.env' });
const WebSocket = require('ws');
const mysql     = require('mysql2/promise');

const CLIENT_ID    = process.env.DHAN_MARKET_CLIENT_ID;
const ACCESS_TOKEN = process.env.DHAN_MARKET_ACCESS_TOKEN;

// Map exch_id + segment → correct Dhan ExchangeSegment
function getExchangeSegment(exchId, segment) {
    const exch = (exchId || '').toUpperCase();
    const seg  = (segment || '').toUpperCase();
    if (exch === 'BSE' && seg === 'D') return 'BSE_FNO';
    if (exch === 'NSE' && seg === 'D') return 'NSE_FNO';
    if (exch === 'BSE' && seg === 'E') return 'BSE_EQ';
    if (exch === 'NSE' && seg === 'E') return 'NSE_EQ';
    if (seg === 'NSE_FNO') return 'NSE_FNO';
    if (seg === 'BSE_FNO') return 'BSE_FNO';
    if (seg === 'NSE_EQ')  return 'NSE_EQ';
    if (seg === 'BSE_EQ')  return 'BSE_EQ';
    return seg;
}

async function run() {
    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    console.log('='.repeat(65));
    console.log('Dhan Live Price Test — ' + now);
    console.log('='.repeat(65));

    // ── Step 1: Get instruments from DB ───────────────────────────
    console.log('\n[Step1] Fetching 20 instruments from DB...');
    const pool = mysql.createPool({
        host: 'redoq-dev-db-cluster.cluster-cs0kxsrqdtm7.ap-south-1.rds.amazonaws.com',
        user: 'savan.18seq', password: '1qaz!QAZ@WSX',
        database: 'project_investapas', connectionLimit: 3,
    });

    const [rows] = await pool.query(
        `SELECT security_id, display_name, segment, exch_id, sm_expiry_date, strike_price, option_type
         FROM instruments
         WHERE sm_expiry_date > CURDATE()
         ORDER BY sm_expiry_date ASC, display_name ASC
         LIMIT 20`
    );
    await pool.end();

    if (rows.length === 0) {
        console.log('❌ No instruments. Run /dhan/update-instruments first.');
        process.exit(1);
    }

    console.log(`[Step1] ✅ Got ${rows.length} instruments\n`);
    rows.forEach((r, i) => {
        const seg = getExchangeSegment(r.exch_id, r.segment);
        console.log(`  ${String(i+1).padStart(2)}. exch=${r.exch_id} seg=${r.segment}→${seg} id=${r.security_id} ${r.display_name}`);
    });

    // ── Step 2: Build subscription with correct segments ──────────
    const instruments = rows.map(r => ({
        ExchangeSegment: getExchangeSegment(r.exch_id, r.segment),
        SecurityId: r.security_id.toString(),
    }));

    const nameMap = {};
    rows.forEach(r => { nameMap[r.security_id.toString()] = r.display_name; });

    // ── Step 3: Connect and subscribe ────────────────────────────
    console.log('\n[Step2] Connecting to Dhan...');
    const URL = `wss://api-feed.dhan.co?version=2&token=${ACCESS_TOKEN}&clientId=${CLIENT_ID}&authType=2`;
    const ws  = new WebSocket(URL);
    const priceMap = {};
    let updates = 0;

    ws.on('open', () => {
        console.log('[Step2] ✅ Connected');
        ws.send(JSON.stringify({ RequestCode: 15, InstrumentCount: instruments.length, InstrumentList: instruments }));
        console.log(`[Step3] 📤 Subscribed ${instruments.length} instruments\n`);
    });

    ws.on('message', (data) => {
        const buf = Buffer.from(data);
        if (buf.length < 12) return;
        const code  = buf.readUInt8(0);
        const secId = buf.readUInt32LE(4).toString();
        const ltp   = parseFloat(buf.readFloatLE(8).toFixed(2));
        if (code === 2 && ltp > 0) {
            updates++;
            priceMap[secId] = ltp;
            const name = (nameMap[secId] || secId).substring(0, 35).padEnd(35);
            console.log(`[Price] 📈 ${name} ₹${ltp}`);
        }
    });

    ws.on('error', (e) => console.log('[Error]', e.message));
    ws.on('close', (c) => console.log('\nConnection closed:', c));

    // Summary after 20s
    setTimeout(() => {
        console.log('\n' + '='.repeat(65));
        console.log('SUMMARY');
        console.log('='.repeat(65));
        console.log(`Total price updates: ${updates}\n`);
        rows.forEach(r => {
            const id    = r.security_id.toString();
            const seg   = getExchangeSegment(r.exch_id, r.segment);
            const price = priceMap[id];
            const name  = r.display_name.substring(0, 32).padEnd(32);
            console.log(`  ${seg.padEnd(10)} ${name} ${price ? '✅ ₹' + price : '⚪ no price'}`);
        });
        if (updates > 0) {
            console.log('\n✅ Pipeline works! Deploy and prices will show in Flutter.');
        } else {
            console.log('\n⚠️  Still no prices. Instruments may all be OTM/illiquid.');
        }
        ws.close();
        process.exit(0);
    }, 20000);
}

run().catch(e => { console.log('Error:', e.message); process.exit(1); });
