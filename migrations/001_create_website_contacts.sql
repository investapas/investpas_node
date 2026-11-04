-- Migration: Create website_contacts table
-- Run this SQL on your MySQL database

CREATE TABLE IF NOT EXISTS `website_contacts` (
  `id`               INT           NOT NULL AUTO_INCREMENT,
  `first_name`       VARCHAR(100)  NOT NULL,
  `last_name`        VARCHAR(100)  NOT NULL,
  `email`            VARCHAR(255)  NOT NULL,
  `phone_number`     VARCHAR(20)   NOT NULL,
  `whatsapp_number`  VARCHAR(20)   NOT NULL,
  `same_as_phone`       TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 = WhatsApp same as phone',
  `contact_count`       INT           NOT NULL DEFAULT 1 COMMENT 'How many times this person submitted the form',
  `last_contacted_at`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Timestamp of the most recent submission',
  `created_at`          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_email`   (`email`),
  INDEX `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
