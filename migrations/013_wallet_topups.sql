-- Migration: Paid unlock-balance top-ups
-- The unlock balance (user_coins.balance, whole rupees) used to be credited by
-- POST /wallet/add-coins with no payment. Top-ups now go through Razorpay:
-- /wallet/topup/order creates a row here, /wallet/topup/verify flips it to
-- 'paid' exactly once and only then credits user_coins.
-- WalletController also creates this table on first use; running this once in
-- phpMyAdmin is equivalent and safe.

CREATE TABLE IF NOT EXISTS `wallet_topups` (
  `id`                  INT          NOT NULL AUTO_INCREMENT,
  `dhan_client_id`      VARCHAR(50)  NOT NULL,
  `amount_rupees`       INT          NOT NULL,
  `razorpay_order_id`   VARCHAR(64)  NOT NULL,
  `razorpay_payment_id` VARCHAR(64)  NULL,
  `status`              ENUM('created','paid','failed') NOT NULL DEFAULT 'created',
  `created_at`          DATETIME     DEFAULT CURRENT_TIMESTAMP,
  `verified_at`         DATETIME     NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_topup_order` (`razorpay_order_id`),
  KEY `idx_topup_client` (`dhan_client_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
