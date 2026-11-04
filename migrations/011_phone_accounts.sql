-- Migration: Phone-first accounts (website signup / login)
-- The website now creates the account: a `users` row keyed by a Firebase-
-- verified mobile number. dhan_client_id becomes optional — it gets filled
-- in later when the user connects Dhan from the app. Challenges and plan
-- payments are linked by users.id (user_id) so they work before Dhan is
-- connected.
-- Run this SQL on your MySQL database (once).

-- ── users ───────────────────────────────────────────────────────────────
ALTER TABLE `users`
  MODIFY COLUMN `dhan_client_id` VARCHAR(50) NULL,
  ADD COLUMN `full_name`      VARCHAR(150) DEFAULT NULL AFTER `dhan_client_ucc`,
  ADD COLUMN `email`          VARCHAR(255) DEFAULT NULL AFTER `full_name`,
  ADD COLUMN `mobile_number`  VARCHAR(15)  DEFAULT NULL AFTER `email` COMMENT '10-digit Indian mobile, Firebase-verified',
  ADD COLUMN `firebase_uid`   VARCHAR(128) DEFAULT NULL AFTER `mobile_number`,
  ADD COLUMN `signup_source`  VARCHAR(20)  NOT NULL DEFAULT 'app' AFTER `firebase_uid` COMMENT 'app | website',
  ADD UNIQUE KEY `uniq_users_mobile` (`mobile_number`),
  ADD KEY `idx_users_firebase_uid` (`firebase_uid`);

-- ── user_challenges ─────────────────────────────────────────────────────
ALTER TABLE `user_challenges`
  MODIFY COLUMN `dhan_client_id` VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  ADD COLUMN `user_id` INT DEFAULT NULL AFTER `id`,
  ADD KEY `idx_user_challenges_user_id` (`user_id`);

-- Backfill user_id for challenges created from the app.
UPDATE `user_challenges` uc
  JOIN `users` u ON u.dhan_client_id = uc.dhan_client_id
  SET uc.user_id = u.id
  WHERE uc.user_id IS NULL;

-- ── plan_payments ───────────────────────────────────────────────────────
-- Same shape PaymentController.ensureTable() creates, so this works whether
-- or not the table already exists.
CREATE TABLE IF NOT EXISTS `plan_payments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `dhan_client_id` VARCHAR(64) NOT NULL,
  `plan_type` VARCHAR(32) NOT NULL,
  `amount_paise` INT NOT NULL,
  `razorpay_order_id` VARCHAR(64) NOT NULL,
  `razorpay_payment_id` VARCHAR(64) NULL,
  `status` ENUM('created','paid','failed') NOT NULL DEFAULT 'created',
  `used_for_challenge` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `verified_at` DATETIME NULL,
  INDEX (`dhan_client_id`),
  INDEX (`razorpay_order_id`)
);

ALTER TABLE `plan_payments`
  MODIFY COLUMN `dhan_client_id` VARCHAR(64) NULL,
  ADD COLUMN `user_id` INT DEFAULT NULL AFTER `id`,
  ADD KEY `idx_plan_payments_user_id` (`user_id`);

UPDATE `plan_payments` pp
  JOIN `users` u ON u.dhan_client_id = pp.dhan_client_id
  SET pp.user_id = u.id
  WHERE pp.user_id IS NULL;
