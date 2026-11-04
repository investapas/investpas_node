-- Migration: Add app PIN and biometric fields to users table
ALTER TABLE `users`
  ADD COLUMN `app_pin_hash`       VARCHAR(255) DEFAULT NULL  COMMENT 'bcrypt hash of 4-digit app PIN',
  ADD COLUMN `biometric_enabled`  TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = biometric unlock enabled';
