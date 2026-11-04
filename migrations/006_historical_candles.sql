CREATE TABLE IF NOT EXISTS historical_candles (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    security_id     VARCHAR(20) NOT NULL,
    exchange_segment VARCHAR(30) NOT NULL,
    candle_date     DATE NOT NULL,
    open_price      DECIMAL(15,2) NOT NULL,
    high_price      DECIMAL(15,2) NOT NULL,
    low_price       DECIMAL(15,2) NOT NULL,
    close_price     DECIMAL(15,2) NOT NULL,
    volume          BIGINT DEFAULT 0,
    UNIQUE KEY idx_candle (security_id, candle_date),
    KEY idx_seg (exchange_segment)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
