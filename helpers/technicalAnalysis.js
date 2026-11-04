const TI = require('technicalindicators');

function _arr(data) { return Array.isArray(data) ? data : []; }

exports.calculateAll = function (candles) {
    if (!candles || candles.length < 50) return null;

    const closes = _arr(candles.map(c => c.close));
    const highs  = _arr(candles.map(c => c.high));
    const lows   = _arr(candles.map(c => c.low));
    const vols   = _arr(candles.map(c => c.volume || 0));
    const last   = closes[closes.length - 1];

    // --- Trend: EMAs ---
    const ema9   = TI.EMA.calculate({ period: 9,   values: closes });
    const ema20  = TI.EMA.calculate({ period: 20,  values: closes });
    const ema50  = TI.EMA.calculate({ period: 50,  values: closes });

    const e9  = ema9[ema9.length - 1]   || 0;
    const e20 = ema20[ema20.length - 1]  || 0;
    const e50 = ema50[ema50.length - 1]  || 0;

    let trend = 'NEUTRAL';
    if (last > e9 && e9 > e20 && e20 > e50) trend = 'STRONG_BULLISH';
    else if (last > e20 && e20 > e50) trend = 'BULLISH';
    else if (last < e9 && e9 < e20 && e20 < e50) trend = 'STRONG_BEARISH';
    else if (last < e20 && e20 < e50) trend = 'BEARISH';

    // --- Momentum: RSI ---
    const rsiVals = TI.RSI.calculate({ period: 14, values: closes });
    const rsi = rsiVals[rsiVals.length - 1] || 50;

    // --- Momentum: MACD ---
    const macdVals = TI.MACD.calculate({
        values: closes,
        fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
        SimpleMAOscillator: false, SimpleMASignal: false,
    });
    const macd = macdVals[macdVals.length - 1] || { MACD: 0, signal: 0, histogram: 0 };

    // --- Momentum: Stochastic RSI ---
    const stochRSI = TI.StochasticRSI.calculate({
        values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3,
    });
    const stoch = stochRSI[stochRSI.length - 1] || { k: 50, d: 50 };

    // --- Volatility: ATR ---
    const atrVals = TI.ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    const atr = atrVals[atrVals.length - 1] || 0;

    // --- Volatility: Bollinger Bands ---
    const bbVals = TI.BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
    const bb = bbVals[bbVals.length - 1] || { upper: 0, middle: 0, lower: 0 };

    // --- Volume Analysis ---
    const avgVol   = vols.slice(-20).reduce((s, v) => s + v, 0) / 20;
    const lastVol  = vols[vols.length - 1] || 0;
    const relativeVolume = avgVol > 0 ? lastVol / avgVol : 1;
    const volumeSpike = relativeVolume > 1.5;

    // --- Support / Resistance (simple pivot) ---
    const recentHighs = highs.slice(-20);
    const recentLows  = lows.slice(-20);
    const resistance  = Math.max(...recentHighs);
    const support     = Math.min(...recentLows);

    const nearResistance = last >= resistance * 0.998;
    const nearSupport    = last <= support * 1.002;
    const breakout       = last > resistance;
    const breakdown      = last < support;

    // --- Signal Score (-100 to +100) ---
    let score = 0;

    // Trend
    if (trend === 'STRONG_BULLISH') score += 25;
    else if (trend === 'BULLISH') score += 15;
    else if (trend === 'STRONG_BEARISH') score -= 25;
    else if (trend === 'BEARISH') score -= 15;

    // RSI
    if (rsi < 30) score += 15;
    else if (rsi < 40) score += 5;
    else if (rsi > 70) score -= 15;
    else if (rsi > 60) score -= 5;

    // MACD
    if (macd.histogram > 0 && macd.MACD > macd.signal) score += 15;
    else if (macd.histogram < 0 && macd.MACD < macd.signal) score -= 15;

    // Stochastic RSI
    if (stoch.k < 20 && stoch.k > stoch.d) score += 10;
    else if (stoch.k > 80 && stoch.k < stoch.d) score -= 10;

    // Bollinger
    if (last <= bb.lower) score += 10;
    else if (last >= bb.upper) score -= 10;

    // Breakout / Breakdown
    if (breakout && volumeSpike) score += 15;
    else if (breakdown && volumeSpike) score -= 15;

    // Volume confirmation
    if (volumeSpike && score > 0) score += 5;
    else if (volumeSpike && score < 0) score -= 5;

    score = Math.max(-100, Math.min(100, score));

    return {
        price: last,
        trend,
        ema: { ema9: +e9.toFixed(2), ema20: +e20.toFixed(2), ema50: +e50.toFixed(2) },
        rsi: +rsi.toFixed(2),
        macd: {
            value:     +(macd.MACD || 0).toFixed(2),
            signal:    +(macd.signal || 0).toFixed(2),
            histogram: +(macd.histogram || 0).toFixed(2),
        },
        stochRSI: { k: +(stoch.k || 0).toFixed(2), d: +(stoch.d || 0).toFixed(2) },
        atr: +atr.toFixed(2),
        bollingerBands: {
            upper:  +bb.upper.toFixed(2),
            middle: +bb.middle.toFixed(2),
            lower:  +bb.lower.toFixed(2),
        },
        volume: { current: lastVol, avg20: +avgVol.toFixed(0), relative: +relativeVolume.toFixed(2), spike: volumeSpike },
        priceAction: { support: +support.toFixed(2), resistance: +resistance.toFixed(2), breakout, breakdown, nearSupport, nearResistance },
        score,
    };
};
