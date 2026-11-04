-- Migration: Add contact_count and last_contacted_at to website_contacts
-- Run this SQL if the table already exists

ALTER TABLE `website_contacts`
  ADD COLUMN `contact_count`      INT      NOT NULL DEFAULT 1 COMMENT 'How many times this person submitted the form' AFTER `same_as_phone`,
  ADD COLUMN `last_contacted_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Timestamp of the most recent submission' AFTER `contact_count`;
