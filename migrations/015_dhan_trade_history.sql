-- Migration: Cached Dhan trade history for the Journal screen
-- Journal used to hit Dhan's live GET /v2/trades/{from}/{to}/{page} on every
-- open, one page at a time (never looped past page 0) — for any account
-- with more than one page of trades in the requested range, or whose trades
-- happened to land past page 0, the Journal silently showed "no trades" /
-- Gross Realized ₹0.00 even though the trades existed. Raw trade legs are
-- now synced into this table once (full 12-month backfill on Dhan connect,
-- or on first Journal open for an already-connected user) and once daily
-- (helpers/dhanTradeHistorySync.js's syncTodayTrades, 3:40 PM IST cron in
-- app.js) — the Journal endpoint (DhanController.getTradeHistory) reads
-- from here and FIFO/weighted-avg-matches them locally, never calling Dhan
-- live on a Journal open.

CREATE TABLE IF NOT EXISTS `dhan_trades` (
  `id`                BIGINT        NOT NULL AUTO_INCREMENT,
  `dhan_client_id`    VARCHAR(50)   NOT NULL,
  `order_id`          VARCHAR(50)   NOT NULL,
  `trading_symbol`    VARCHAR(100)  NULL,
  `custom_symbol`     VARCHAR(100)  NULL,
  `security_id`       VARCHAR(20)   NOT NULL,
  `exchange_segment`  VARCHAR(30)   NOT NULL,
  `product_type`      VARCHAR(20)   NULL,
  `instrument`        VARCHAR(20)   NULL,
  `drv_expiry_date`   VARCHAR(20)   NULL,
  `drv_option_type`   VARCHAR(5)    NULL,
  `drv_strike_price`  DECIMAL(15,2) NULL,
  `transaction_type`  ENUM('BUY','SELL') NOT NULL,
  `traded_quantity`   INT           NOT NULL,
  `traded_price`      DECIMAL(15,4) NOT NULL,
  `charges`           DECIMAL(15,2) NOT NULL DEFAULT 0,
  `trade_date`        DATE          NOT NULL,
  `exchange_time`     DATETIME      NOT NULL,
  `created_at`        DATETIME      DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  -- Dhan's trade-book payload has no single stable fill id in the fields
  -- this app already parses (see DhanController.getTradeHistory) — this
  -- composite is what distinguishes one fill from another and makes a
  -- re-run of the same day's sync idempotent (INSERT ... ON DUPLICATE KEY
  -- UPDATE is a no-op for a fill already stored).
  UNIQUE KEY `uq_fill` (`dhan_client_id`, `order_id`, `exchange_time`, `transaction_type`, `traded_quantity`, `traded_price`),
  KEY `idx_client_date` (`dhan_client_id`, `trade_date`),
  KEY `idx_client_security_date` (`dhan_client_id`, `security_id`, `trade_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- NULL = never backfilled yet; DhanController.getTradeHistory does a one-time
-- blocking backfill on first call for such a user (covers everyone who
-- connected Dhan before this feature shipped), then this is kept fresh by
-- the daily 3:40 PM sync.
--
-- Plain ADD COLUMN, not ADD COLUMN IF NOT EXISTS — that syntax needs
-- MySQL 8.0.29+ and threw a syntax error on this project's server version.
-- Safe to run once; re-running on a column that already exists will error
-- (harmless — it means this step is already done).
ALTER TABLE `users`
  ADD COLUMN `trade_history_synced_at` DATETIME NULL;
