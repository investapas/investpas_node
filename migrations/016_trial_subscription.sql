-- Migration: 30-day free trial + Universal Challenge (PDF Part 2, Change 4)
--
-- IMPORTANT — Autopay is STUBBED, not real. `autopay_status='stub_approved'`
-- means the user tapped "Approve Autopay" in the app; no UPI mandate, no
-- Razorpay subscription, no real money has moved. This is deliberate:
-- Prince flagged an unresolved legal question (Google Play billing policy
-- vs using UPI Autopay directly inside the app) that needs a lawyer's
-- confirmation before any real recurring charge can go live. Swap
-- controllers/TrialController.js's `approveAutopay` for a real gateway
-- call once that's confirmed — the schema/flow here is already shaped for
-- it (plan_price_rupees, first_debit_date) so that swap shouldn't need a
-- new migration.

CREATE TABLE IF NOT EXISTS `user_trials` (
  `id`                  INT           NOT NULL AUTO_INCREMENT,
  `dhan_client_id`      VARCHAR(64)   NOT NULL,
  `plan_type`           VARCHAR(32)   NOT NULL,   -- monthly | quarterly | half_yearly | yearly
  `plan_price_rupees`   INT           NOT NULL,
  `full_name`           VARCHAR(100)  NULL,
  `email`               VARCHAR(100)  NULL,
  `mobile`              VARCHAR(20)   NULL,
  `state`               VARCHAR(50)   NULL,
  `trial_started_at`    DATETIME      NOT NULL,
  `trial_ends_at`       DATETIME      NOT NULL,
  `first_debit_date`    DATE          NOT NULL,
  `autopay_status`      ENUM('pending','stub_approved','cancelled') NOT NULL DEFAULT 'pending',
  `autopay_approved_at` DATETIME      NULL,
  `cancelled_at`        DATETIME      NULL,
  `challenge_id`        INT           NULL,       -- the user_challenges row this trial activated
  `created_at`          DATETIME      DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  -- One trial per Dhan account, ever — a second signup must not get
  -- another free trial (PDF: "Ek mobile number / ek Dhan account = ek hi
  -- baar free trial").
  UNIQUE KEY `uq_trial_account` (`dhan_client_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
