-- Migration: Add per-day dedup tracking for live P&L (max profit/loss) alerts
ALTER TABLE `user_challenges`
  ADD COLUMN `last_pnl_alert_date`   DATE        DEFAULT NULL COMMENT 'Date the live P&L max_loss/max_profit alert was last sent',
  ADD COLUMN `last_pnl_alert_reason` VARCHAR(20) DEFAULT NULL COMMENT 'MAX LOSS HIT or TARGET ACHIEVED - last live P&L alert sent';
