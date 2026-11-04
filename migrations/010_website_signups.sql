-- Migration: Create website_signups table
-- Captures the website's "Join Beta" flow: lead info (Form A) -> custom
-- challenge config + plan choice (Form B) -> Razorpay payment.
-- Run this SQL on your MySQL database

CREATE TABLE IF NOT EXISTS `website_signups` (
  `id`                   INT           NOT NULL AUTO_INCREMENT,
  `first_name`           VARCHAR(100)  NOT NULL,
  `last_name`            VARCHAR(100)  NOT NULL,
  `email`                VARCHAR(255)  NOT NULL,
  `mobile_number`        VARCHAR(20)   NOT NULL,

  -- Custom challenge config (Form B) — mirrors user_challenges fields
  `trading_capital`      DECIMAL(12,2) NULL,
  `min_profit`           DECIMAL(12,2) NULL,
  `max_profit`           DECIMAL(12,2) NULL,
  `min_loss`             DECIMAL(12,2) NULL,
  `max_loss`             DECIMAL(12,2) NULL,
  `max_trades_per_day`   INT           NULL,
  `nifty_lots`           INT           NOT NULL DEFAULT 0,
  `banknifty_lots`       INT           NOT NULL DEFAULT 0,
  `finnifty_lots`        INT           NOT NULL DEFAULT 0,
  `midcapnifty_lots`     INT           NOT NULL DEFAULT 0,
  `sensex_lots`          INT           NOT NULL DEFAULT 0,

  -- Plan + payment (mirrors plan_payments)
  `plan_type`            VARCHAR(32)   NULL COMMENT 'firstWeek | monthly',
  `amount_paise`         INT           NULL,
  `razorpay_order_id`    VARCHAR(64)   NULL,
  `razorpay_payment_id`  VARCHAR(64)   NULL,
  `payment_status`       ENUM('pending','created','paid','failed') NOT NULL DEFAULT 'pending',

  `created_at`           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `verified_at`          DATETIME      NULL,

  PRIMARY KEY (`id`),
  INDEX `idx_email`  (`email`),
  INDEX `idx_mobile` (`mobile_number`),
  INDEX `idx_order`  (`razorpay_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
