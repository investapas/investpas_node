-- AI Trading Bot System Tables

CREATE TABLE IF NOT EXISTS bot_settings (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    dhan_client_id  VARCHAR(50) NOT NULL,
    symbol          VARCHAR(50) NOT NULL DEFAULT 'BANKNIFTY',
    exchange_segment VARCHAR(30) NOT NULL DEFAULT 'NSE_FNO',
    risk_mode       ENUM('CONSERVATIVE','BALANCED','AGGRESSIVE') NOT NULL DEFAULT 'BALANCED',
    profit_target   DECIMAL(12,2) NOT NULL DEFAULT 5000.00,
    loss_limit      DECIMAL(12,2) NOT NULL DEFAULT 2000.00,
    max_open_trades INT NOT NULL DEFAULT 3,
    fixed_quantity  INT NOT NULL DEFAULT 1,
    confidence_threshold INT NOT NULL DEFAULT 80,
    auto_start      TINYINT(1) NOT NULL DEFAULT 0,
    auto_stop       TINYINT(1) NOT NULL DEFAULT 1,
    is_active       TINYINT(1) NOT NULL DEFAULT 0,
    status          ENUM('STOPPED','RUNNING','PAUSED','ERROR') NOT NULL DEFAULT 'STOPPED',
    started_at      DATETIME DEFAULT NULL,
    stopped_at      DATETIME DEFAULT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY idx_user_active (dhan_client_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bot_trades (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    bot_setting_id  INT NOT NULL,
    dhan_client_id  VARCHAR(50) NOT NULL,
    symbol          VARCHAR(100) NOT NULL,
    security_id     VARCHAR(20) DEFAULT NULL,
    exchange_segment VARCHAR(30) NOT NULL,
    direction       ENUM('BUY_CALL','BUY_PUT','BUY','SELL') NOT NULL,
    entry_price     DECIMAL(12,2) NOT NULL,
    exit_price      DECIMAL(12,2) DEFAULT NULL,
    quantity        INT NOT NULL,
    stop_loss       DECIMAL(12,2) DEFAULT NULL,
    target_price    DECIMAL(12,2) DEFAULT NULL,
    status          ENUM('OPEN','CLOSED','SL_HIT','TP_HIT','FORCE_CLOSED') NOT NULL DEFAULT 'OPEN',
    pnl             DECIMAL(12,2) DEFAULT 0.00,
    confidence      INT DEFAULT 0,
    open_time       DATETIME DEFAULT CURRENT_TIMESTAMP,
    close_time      DATETIME DEFAULT NULL,
    close_reason    VARCHAR(100) DEFAULT NULL,
    decision_id     INT DEFAULT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_bot_user (dhan_client_id),
    KEY idx_bot_status (status),
    KEY idx_bot_setting (bot_setting_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_decision_logs (
    id                      INT AUTO_INCREMENT PRIMARY KEY,
    bot_setting_id          INT DEFAULT NULL,
    dhan_client_id          VARCHAR(50) NOT NULL,
    symbol                  VARCHAR(100) NOT NULL,
    action                  VARCHAR(30) NOT NULL,
    confidence              INT DEFAULT 0,
    reason                  TEXT DEFAULT NULL,
    stop_loss               DECIMAL(12,2) DEFAULT NULL,
    target_price            DECIMAL(12,2) DEFAULT NULL,
    risk_score              INT DEFAULT 0,
    technical_analysis_json JSON DEFAULT NULL,
    option_chain_json       JSON DEFAULT NULL,
    news_sentiment_json     JSON DEFAULT NULL,
    market_data_json        JSON DEFAULT NULL,
    ai_prompt               TEXT DEFAULT NULL,
    ai_response             TEXT DEFAULT NULL,
    executed                TINYINT(1) DEFAULT 0,
    trade_id                INT DEFAULT NULL,
    created_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_decision_user (dhan_client_id),
    KEY idx_decision_bot (bot_setting_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bot_daily_stats (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    bot_setting_id  INT NOT NULL,
    dhan_client_id  VARCHAR(50) NOT NULL,
    trade_date      DATE NOT NULL,
    total_trades    INT DEFAULT 0,
    winning_trades  INT DEFAULT 0,
    losing_trades   INT DEFAULT 0,
    total_pnl       DECIMAL(12,2) DEFAULT 0.00,
    max_drawdown    DECIMAL(12,2) DEFAULT 0.00,
    peak_pnl        DECIMAL(12,2) DEFAULT 0.00,
    status          ENUM('ACTIVE','TARGET_HIT','LOSS_HIT','STOPPED') DEFAULT 'ACTIVE',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY idx_bot_date (bot_setting_id, trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS market_snapshots (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    symbol          VARCHAR(50) NOT NULL,
    ltp             DECIMAL(12,2) DEFAULT NULL,
    open_price      DECIMAL(12,2) DEFAULT NULL,
    high_price      DECIMAL(12,2) DEFAULT NULL,
    low_price       DECIMAL(12,2) DEFAULT NULL,
    close_price     DECIMAL(12,2) DEFAULT NULL,
    volume          BIGINT DEFAULT NULL,
    oi              BIGINT DEFAULT NULL,
    pcr             DECIMAL(6,3) DEFAULT NULL,
    max_pain        DECIMAL(12,2) DEFAULT NULL,
    iv              DECIMAL(8,3) DEFAULT NULL,
    vix             DECIMAL(8,3) DEFAULT NULL,
    snapshot_time   DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_snap_symbol (symbol, snapshot_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bot_strategy_scores (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    symbol          VARCHAR(50) NOT NULL,
    strategy_name   VARCHAR(100) NOT NULL,
    timeframe       VARCHAR(20) DEFAULT 'INTRADAY',
    total_signals   INT DEFAULT 0,
    winning_signals INT DEFAULT 0,
    avg_pnl         DECIMAL(12,2) DEFAULT 0.00,
    sharpe_ratio    DECIMAL(8,4) DEFAULT 0.00,
    profit_factor   DECIMAL(8,4) DEFAULT 0.00,
    max_drawdown    DECIMAL(12,2) DEFAULT 0.00,
    score           DECIMAL(8,4) DEFAULT 0.00,
    eval_period     VARCHAR(20) DEFAULT 'WEEKLY',
    evaluated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_strat_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
