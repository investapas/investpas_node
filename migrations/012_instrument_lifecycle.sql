-- Migration: Instrument lifecycle (expiry) for instrument master + watchlist
-- • instruments: one row per (exchange_segment, security_id), lifecycle
--   status, never truncated again (history is kept, expired rows are marked).
-- • user_wishlist: stores a snapshot of the contract it was added for, plus
--   an ACTIVE/EXPIRED status — expired items are marked, never deleted.
-- Run ONCE, in order, before deploying the matching backend code.

-- ── instruments ─────────────────────────────────────────────────────────
ALTER TABLE `instruments`
  ADD INDEX `idx_instr_security` (`security_id`);

-- Broker segment for every row (CSV exch_id + segment → Dhan segment).
UPDATE `instruments`
SET `exchange_segment` = CASE
    WHEN `segment` = 'D' AND `exch_id` = 'BSE' THEN 'BSE_FNO'
    WHEN `segment` = 'D' THEN 'NSE_FNO'
    WHEN `segment` = 'E' AND `exch_id` = 'BSE' THEN 'BSE_EQ'
    WHEN `segment` = 'E' THEN 'NSE_EQ'
    WHEN `segment` = 'I' THEN 'IDX_I'
    ELSE `exchange_segment`
  END;

-- Remove duplicate catalog rows (same segment + security id imported more
-- than once — e.g. index rows present in both the NSE and BSE files).
-- Keeps the newest copy. Orders/trades reference security_id, not this id.
DELETE i1 FROM `instruments` i1
  JOIN `instruments` i2
    ON i1.`exchange_segment` = i2.`exchange_segment`
   AND i1.`security_id` = i2.`security_id`
   AND i1.`id` < i2.`id`;

ALTER TABLE `instruments`
  ADD COLUMN `lifecycle_status` ENUM('ACTIVE','EXPIRED','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN `last_seen_at` DATETIME NULL COMMENT 'Last instrument-master sync that listed this contract',
  ADD COLUMN `expired_at`   DATETIME NULL,
  ADD UNIQUE KEY `uq_instr_segment_security` (`exchange_segment`, `security_id`),
  ADD INDEX `idx_instr_lifecycle_expiry` (`lifecycle_status`, `sm_expiry_date`);

-- ── user_wishlist ───────────────────────────────────────────────────────
ALTER TABLE `user_wishlist`
  ADD COLUMN `exchange_segment`  VARCHAR(32)   NULL AFTER `security_id`,
  ADD COLUMN `instrument_type`   VARCHAR(20)   NULL AFTER `exchange_segment`,
  ADD COLUMN `trading_symbol`    VARCHAR(64)   NULL AFTER `instrument_type`,
  ADD COLUMN `display_name`      VARCHAR(150)  NULL AFTER `trading_symbol`,
  ADD COLUMN `underlying_symbol` VARCHAR(50)   NULL AFTER `display_name`,
  ADD COLUMN `expiry_date`       DATE          NULL AFTER `underlying_symbol`,
  ADD COLUMN `strike_price`      DECIMAL(15,5) NULL AFTER `expiry_date`,
  ADD COLUMN `option_type`       VARCHAR(10)   NULL AFTER `strike_price`,
  ADD COLUMN `lot_size`          INT           NULL AFTER `option_type`,
  ADD COLUMN `status` ENUM('ACTIVE','EXPIRED','INACTIVE') NOT NULL DEFAULT 'ACTIVE' AFTER `lot_size`,
  ADD COLUMN `status_changed_at` DATETIME NULL AFTER `status`,
  ADD COLUMN `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Snapshot the contract each existing row currently points at.
UPDATE `user_wishlist` w
  JOIN (SELECT `security_id`, MAX(`id`) AS `id` FROM `instruments`
        WHERE `exchange_segment` IN ('NSE_FNO','BSE_FNO')
        GROUP BY `security_id`) pick ON pick.`security_id` = w.`security_id`
  JOIN `instruments` i ON i.`id` = pick.`id`
SET w.`exchange_segment`  = i.`exchange_segment`,
    w.`instrument_type`   = i.`instrument`,
    w.`trading_symbol`    = i.`symbol_name`,
    w.`display_name`      = i.`display_name`,
    w.`underlying_symbol` = i.`underlying_symbol`,
    w.`expiry_date`       = IF(i.`sm_expiry_date` > '1900-01-01', i.`sm_expiry_date`, NULL),
    w.`strike_price`      = i.`strike_price`,
    w.`option_type`       = i.`option_type`,
    w.`lot_size`          = i.`lot_size`;

-- Identity is (user, segment, security id) — not security id alone.
ALTER TABLE `user_wishlist`
  DROP INDEX `uq_user_stock`,
  ADD UNIQUE KEY `uq_user_segment_security` (`dhan_client_id`, `exchange_segment`, `security_id`),
  ADD INDEX `idx_wishlist_user_status` (`dhan_client_id`, `status`);

-- Expired contracts are marked by the backend's lifecycle sweep on startup
-- (IST-correct), so no date-based UPDATE is needed here.
