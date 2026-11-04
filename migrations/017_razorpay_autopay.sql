-- Migration: Real Razorpay UPI Autopay for the 30-day trial (replaces the
-- stub from migration 016 — see controllers/TrialController.js and
-- helpers/razorpaySubscriptions.js).
--
-- Activation still only ever happens from Razorpay's server webhook
-- (subscription.authenticated), never from the app's own checkout success
-- callback — the callback can be faked or interrupted, the webhook can't.
-- See POST /trial/razorpay-webhook.

ALTER TABLE `user_trials`
  MODIFY COLUMN `autopay_status` ENUM('pending','created','approved','failed','cancelled') NOT NULL DEFAULT 'pending';

ALTER TABLE `user_trials`
  ADD COLUMN `razorpay_plan_id` VARCHAR(64) NULL AFTER `autopay_status`;

ALTER TABLE `user_trials`
  ADD COLUMN `razorpay_subscription_id` VARCHAR(64) NULL AFTER `razorpay_plan_id`;

-- One Razorpay Plan per plan_type, created lazily on first use and reused
-- after — Razorpay has no "find or create" for Plans, so without this
-- cache every trial signup would create a new duplicate Plan object.
CREATE TABLE IF NOT EXISTS `razorpay_plan_cache` (
  `plan_type`         VARCHAR(32)  NOT NULL,
  `razorpay_plan_id`  VARCHAR(64)  NOT NULL,
  `created_at`         DATETIME     DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`plan_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
