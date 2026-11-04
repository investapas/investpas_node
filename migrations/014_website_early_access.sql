-- Migration: Website early access (investapas.in new site)
-- The new website (investapas-site) signs people up with Firebase phone OTP
-- into `users` (mobile_number = account key, see 011_phone_accounts.sql) and
-- keeps its early-access / lead data here, one row per user.
-- Run ONCE in phpMyAdmin. Requires 011_phone_accounts.sql to have been run.

CREATE TABLE IF NOT EXISTS `website_profiles` (
  `user_id`              INT           NOT NULL,
  `wa_opt_in`            TINYINT(1)    NOT NULL DEFAULT 0,
  `wa_opt_in_at`         DATETIME      NULL,
  `experience`           VARCHAR(40)   NULL,
  `standing`             VARCHAR(40)   NULL,
  `capital`              VARCHAR(40)   NULL,
  `instruments`          VARCHAR(255)  NULL COMMENT 'JSON array',
  `losses`               VARCHAR(40)   NULL,
  `problems`             VARCHAR(255)  NULL COMMENT 'JSON array, max 2',
  `problem_other`        VARCHAR(200)  NULL,
  `rules_rr`             VARCHAR(10)   NULL,
  `rules_lots`           VARCHAR(6)    NULL,
  `rules_orders`         VARCHAR(6)    NULL,
  `session_requested`    TINYINT(1)    NOT NULL DEFAULT 0,
  `session_lang`         VARCHAR(20)   NULL,
  `session_time`         VARCHAR(30)   NULL,
  `session_status`       VARCHAR(40)   NULL,
  `session_requested_at` DATETIME      NULL,
  `early_number`         INT           NULL COMMENT 'Position on the early access list',
  `status`               VARCHAR(20)   NOT NULL DEFAULT 'started' COMMENT 'started | early_access',
  `ref_code`             VARCHAR(12)   NOT NULL,
  `referred_by`          INT           NULL COMMENT 'users.id of the referrer',
  `source`               VARCHAR(60)   NOT NULL DEFAULT 'website' COMMENT 'website | referral | QR code (?src=)',
  `campaign`             VARCHAR(20)   NOT NULL DEFAULT '',
  `chai_code`            VARCHAR(4)    NULL,
  `lead_status`          VARCHAR(30)   NOT NULL DEFAULT 'New',
  `notes`                TEXT          NULL COMMENT 'JSON array of {at, text}',
  `last_login_at`        DATETIME      NULL,
  `created_at`           DATETIME      DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uq_wp_early_number` (`early_number`),
  UNIQUE KEY `uq_wp_ref_code` (`ref_code`),
  KEY `idx_wp_source` (`source`),
  KEY `idx_wp_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
