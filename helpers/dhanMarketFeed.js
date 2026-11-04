const WebSocket = require('ws');
const EventEmitter = require('events');

class DhanMarketFeed extends EventEmitter {
    constructor() {
        super();
        this.ws           = null;
        this.isConnected  = false;
        this._connecting  = false;   // prevent duplicate _connect() calls
        this.subscribedInstruments = [];
        this.reconnectTimer = null;
        this.clientId     = null;
        this.accessToken  = null;
    }

    start(clientId, accessToken) {
        if (this._connecting || this.isConnected) {
            console.log('[DhanFeed][Step4] Already connecting/connected — skipping duplicate start');
            return;
        }
        this.clientId    = clientId;
        this.accessToken = accessToken;
        console.log(`[DhanFeed][Step4] start() called — clientId=${clientId} tokenLen=${accessToken?.length}`);
        this._connect();
    }

    _connect() {
        if (this._connecting) return;
        this._connecting = true;

        if (this.ws) {
            try { this.ws.terminate(); } catch (_) {}
            this.ws = null;
        }


        

        const url = `wss://api-feed.dhan.co?version=2&token=${this.accessToken}&clientId=${this.clientId}&authType=2`;
        console.log('[DhanFeed][Step5] Connecting to Dhan WebSocket...');

        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            // console.log('[DhanFeed][Step6] ✅ Connected to Dhan');
            this._connecting = false;
            this.isConnected = true;

            if (this.subscribedInstruments.length > 0) {
                // console.log(`[DhanFeed][Step7] Re-subscribing ${this.subscribedInstruments.length} pending instruments`);
                this._sendSubscription(this.subscribedInstruments);
            }
        });

        this.ws.on('message', (data) => this._handleMessage(data));

        this.ws.on('close', (code) => {
            console.log(`[DhanFeed] Disconnected (code=${code}) — reconnecting in 30s`);
            this._connecting = false;
            this.isConnected  = false;
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this._connect(), 30000);
        });

        this.ws.on('error', (err) => {
            console.error(`[DhanFeed] ❌ Error: ${err.message}`);
            this._connecting = false;
            // If 429 (rate limit), wait longer before retry
            if (err.message.includes('429')) {
                clearTimeout(this.reconnectTimer);
                console.log('[DhanFeed] 429 rate limit — retrying in 60s');
                this.reconnectTimer = setTimeout(() => this._connect(), 60000);
            }
        });
    }

    subscribe(instruments) {
        const newInstruments = [];
        instruments.forEach(inst => {
            const exists = this.subscribedInstruments.find(
                i => i.SecurityId === inst.SecurityId && i.ExchangeSegment === inst.ExchangeSegment
            );
            if (!exists) {
                this.subscribedInstruments.push(inst);
                newInstruments.push(inst);
            }
        });

        if (newInstruments.length === 0) {
            // console.log('[DhanFeed] Instruments already queued — will send when connected');
        } else {
            // console.log(`[DhanFeed] Queued ${newInstruments.length} new instruments`);
        }

        // Only the new ones — the rest are already subscribed on this socket
        // (a reconnect re-sends the full list from the 'open' handler).
        if (this.isConnected && newInstruments.length) {
            this._sendSubscription(newInstruments);
        } else {
            // console.log('[DhanFeed] Not connected yet — instruments queued, will subscribe on connect');
        }
    }

    // Stops streaming instruments (e.g. contracts that just expired) and
    // drops them from the re-subscribe list used on reconnect.
    unsubscribe(instruments) {
        const key = (i) => `${i.ExchangeSegment}|${String(i.SecurityId)}`;
        const drop = new Set((instruments || []).map(key));
        if (!drop.size) return;
        const removed = this.subscribedInstruments.filter((i) => drop.has(key(i)));
        this.subscribedInstruments = this.subscribedInstruments.filter((i) => !drop.has(key(i)));
        if (removed.length && this.isConnected) this._send(16, removed);
    }

    getSubscribed() {
        return this.subscribedInstruments.slice();
    }

    _sendSubscription(instruments) {
        this._send(15, instruments);
    }

    // RequestCode 15 = subscribe ticker, 16 = unsubscribe ticker.
    // Dhan accepts at most 100 instruments per message.
    _send(requestCode, instruments) {
        if (!instruments.length || !this.ws) return;
        for (let i = 0; i < instruments.length; i += 100) {
            const batch = instruments.slice(i, i + 100);
            this.ws.send(JSON.stringify({
                RequestCode: requestCode,
                InstrumentCount: batch.length,
                InstrumentList: batch
            }));
        }
    }

    _handleMessage(data) {
        if (typeof data === 'string') {
            try { console.log('[DhanFeed] JSON msg:', JSON.parse(data)); } catch (_) {}
            return;
        }

        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length < 12) return;

        const code = buf.readUInt8(0);
        try {
            if (buf.length >= 12) {
                const securityId = buf.readUInt32LE(4).toString();
                const value      = parseFloat(buf.readFloatLE(8).toFixed(2));

                if (code === 2) {
                    // LTP — current price, broadcast to Flutter
                    // console.log(`[DhanFeed][Step8] 📈 LTP — securityId=${securityId} ltp=${value}`);
                    this.emit('price', { securityId, ltp: value });
                } else if (code === 6) {
                    // Prev close — store but do NOT broadcast as price
                    // console.log(`[DhanFeed] 📊 prev_close — securityId=${securityId} close=${value}`);
                }
            }
        } catch (err) {
            console.log('[DhanFeed] Parse error:', err.message);
        }
    }

    reset() {
        clearTimeout(this.reconnectTimer);
        if (this.ws) { try { this.ws.terminate(); } catch (_) {} this.ws = null; }
        this.isConnected  = false;
        this._connecting  = false;
        this.subscribedInstruments = [];
        console.log('[DhanFeed] Reset complete');
    }
}

module.exports = new DhanMarketFeed();
