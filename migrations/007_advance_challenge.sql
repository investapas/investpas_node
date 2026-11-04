-- Advanced Challenge System

-- Add new columns to user_challenges
ALTER TABLE user_challenges
  ADD COLUMN trading_style ENUM('SCALPER','INTRADAY','SWING','EQUITY','OPTIONS_BUYER','OPTIONS_SELLER') DEFAULT 'SCALPER' AFTER dhan_client_id,
  ADD COLUMN cooldown_minutes INT DEFAULT 5 AFTER max_trades_per_day,
  ADD COLUMN consecutive_loss_limit INT DEFAULT 3 AFTER cooldown_minutes,
  ADD COLUMN max_capital_per_trade_pct INT DEFAULT 25 AFTER consecutive_loss_limit,
  ADD COLUMN risk_per_trade_pct DECIMAL(5,2) DEFAULT 2.50 AFTER max_capital_per_trade_pct,
  ADD COLUMN target_per_trade_pct DECIMAL(5,2) DEFAULT 5.00 AFTER risk_per_trade_pct,
  ADD COLUMN hero_trade_allowed TINYINT(1) DEFAULT 1 AFTER target_per_trade_pct;

-- Session state tracking (cooldown timers, consecutive losses, etc.)
CREATE TABLE IF NOT EXISTS challenge_session_state (
  id INT AUTO_INCREMENT PRIMARY KEY,
  dhan_client_id VARCHAR(50) NOT NULL,
  challenge_id INT NOT NULL,
  trade_date DATE NOT NULL,
  consecutive_losses INT DEFAULT 0,
  last_trade_exit_time DATETIME DEFAULT NULL,
  cooldown_end DATETIME DEFAULT NULL,
  hero_trade_used TINYINT(1) DEFAULT 0,
  daily_stop_triggered TINYINT(1) DEFAULT 0,
  last_quantity INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY idx_session (dhan_client_id, challenge_id, trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
