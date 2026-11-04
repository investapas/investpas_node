-- Intraday multi-interval candle cache (1m/5m/15m/25m/1H/...), served from
-- helpers/intradayCandleCache.js. Separate from historical_candles (daily-only,
-- one row per security per day) — this table holds many rows per day per
-- security+interval, which the daily table's unique key cannot represent.
--
-- Documentation only — this project has no migration runner; the table is
-- actually created idempotently at runtime by intradayCandleCache.js's
-- _ensureTable() (same pattern as historical_candles / historicalCache.js).

CREATE TABLE IF NOT EXISTS market_historical_candles (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    security_id VARCHAR(50) NOT NULL,
    exchange_segment VARCHAR(50) NOT NULL,
    instrument VARCHAR(50) NULL,
    trading_symbol VARCHAR(150) NULL,

    interval_minutes INT NOT NULL,
    candle_timestamp BIGINT NOT NULL,      -- epoch seconds, source of truth for all queries
    candle_datetime DATETIME NULL,         -- IST display/debug only, never filtered on

    open_price DECIMAL(20,8) NOT NULL,
    high_price DECIMAL(20,8) NOT NULL,
    low_price DECIMAL(20,8) NOT NULL,
    close_price DECIMAL(20,8) NOT NULL,

    volume BIGINT NULL DEFAULT 0,
    open_interest BIGINT NULL DEFAULT NULL,

    source VARCHAR(50) NOT NULL DEFAULT 'DHAN',

    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY unique_market_candle (security_id, exchange_segment, interval_minutes, candle_timestamp),
    INDEX idx_chart_lookup (security_id, exchange_segment, interval_minutes, candle_timestamp),
    INDEX idx_candle_datetime (candle_datetime)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
