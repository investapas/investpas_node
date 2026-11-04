-- Demo trading: expiry auto-square-off configuration
--
-- Documentation only, like every other file in this directory — DemoController.js's
-- ensureTables() seeds these idempotently (INSERT IGNORE) on process start; there is
-- no migration runner in this repo.

INSERT IGNORE INTO demo_settings (setting_key, setting_value) VALUES
('expiry_squareoff_time', '15:15:00'),
('allow_new_orders_on_expiry_day', 'true');
