-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: localhost
-- Generation Time: Nov 04, 2026 at 03:42 PM
-- Server version: 8.0.43-0ubuntu0.22.04.1
-- PHP Version: 8.4.11

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `project_investapas`
--

-- --------------------------------------------------------

--
-- Table structure for table `admin`
--

CREATE TABLE `admin` (
  `id` int NOT NULL,
  `name` varchar(100) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `role_id` int NOT NULL,
  `token` text,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `admin`
--

-- --------------------------------------------------------

--
-- Table structure for table `ai_coaching_logs`
--

CREATE TABLE `ai_coaching_logs` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `challenge_id` int DEFAULT NULL,
  `message` text NOT NULL,
  `behavior_data_json` json DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `ai_decision_logs`
--

CREATE TABLE `ai_decision_logs` (
  `id` int NOT NULL,
  `bot_setting_id` int DEFAULT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `symbol` varchar(100) NOT NULL,
  `action` varchar(30) NOT NULL,
  `confidence` int DEFAULT '0',
  `reason` text,
  `stop_loss` decimal(12,2) DEFAULT NULL,
  `target_price` decimal(12,2) DEFAULT NULL,
  `risk_score` int DEFAULT '0',
  `technical_analysis_json` json DEFAULT NULL,
  `option_chain_json` json DEFAULT NULL,
  `news_sentiment_json` json DEFAULT NULL,
  `market_data_json` json DEFAULT NULL,
  `ai_prompt` text,
  `ai_response` text,
  `executed` tinyint(1) DEFAULT '0',
  `trade_id` int DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `ai_decision_logs`
--

-- --------------------------------------------------------

--
-- Table structure for table `api_log`
--

CREATE TABLE `api_log` (
  `id` int NOT NULL,
  `api_log_Endpoint` varchar(255) DEFAULT NULL,
  `api_log_Method` varchar(20) DEFAULT NULL,
  `api_log_Request` longtext,
  `api_log_Response` longtext,
  `api_log_StatusCode` int DEFAULT NULL,
  `created_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `api_log`
--

-- --------------------------------------------------------

--
-- Table structure for table `bot_daily_stats`
--

CREATE TABLE `bot_daily_stats` (
  `id` int NOT NULL,
  `bot_setting_id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `trade_date` date NOT NULL,
  `total_trades` int DEFAULT '0',
  `winning_trades` int DEFAULT '0',
  `losing_trades` int DEFAULT '0',
  `total_pnl` decimal(12,2) DEFAULT '0.00',
  `max_drawdown` decimal(12,2) DEFAULT '0.00',
  `peak_pnl` decimal(12,2) DEFAULT '0.00',
  `status` enum('ACTIVE','TARGET_HIT','LOSS_HIT','STOPPED') DEFAULT 'ACTIVE',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `bot_settings`
--

CREATE TABLE `bot_settings` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `symbol` varchar(50) NOT NULL DEFAULT 'BANKNIFTY',
  `exchange_segment` varchar(30) NOT NULL DEFAULT 'NSE_FNO',
  `risk_mode` enum('CONSERVATIVE','BALANCED','AGGRESSIVE') NOT NULL DEFAULT 'BALANCED',
  `profit_target` decimal(12,2) NOT NULL DEFAULT '5000.00',
  `loss_limit` decimal(12,2) NOT NULL DEFAULT '2000.00',
  `max_open_trades` int NOT NULL DEFAULT '3',
  `fixed_quantity` int NOT NULL DEFAULT '1',
  `confidence_threshold` int NOT NULL DEFAULT '80',
  `auto_start` tinyint(1) NOT NULL DEFAULT '0',
  `auto_stop` tinyint(1) NOT NULL DEFAULT '1',
  `is_active` tinyint(1) NOT NULL DEFAULT '0',
  `status` enum('STOPPED','RUNNING','PAUSED','ERROR') NOT NULL DEFAULT 'STOPPED',
  `started_at` datetime DEFAULT NULL,
  `stopped_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `bot_strategy_scores`
--

CREATE TABLE `bot_strategy_scores` (
  `id` int NOT NULL,
  `symbol` varchar(50) NOT NULL,
  `strategy_name` varchar(100) NOT NULL,
  `timeframe` varchar(20) DEFAULT 'INTRADAY',
  `total_signals` int DEFAULT '0',
  `winning_signals` int DEFAULT '0',
  `avg_pnl` decimal(12,2) DEFAULT '0.00',
  `sharpe_ratio` decimal(8,4) DEFAULT '0.0000',
  `profit_factor` decimal(8,4) DEFAULT '0.0000',
  `max_drawdown` decimal(12,2) DEFAULT '0.00',
  `score` decimal(8,4) DEFAULT '0.0000',
  `eval_period` varchar(20) DEFAULT 'WEEKLY',
  `evaluated_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `bot_trades`
--

CREATE TABLE `bot_trades` (
  `id` int NOT NULL,
  `bot_setting_id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `symbol` varchar(100) NOT NULL,
  `security_id` varchar(20) DEFAULT NULL,
  `exchange_segment` varchar(30) NOT NULL,
  `direction` enum('BUY_CALL','BUY_PUT','BUY','SELL') NOT NULL,
  `entry_price` decimal(12,2) NOT NULL,
  `exit_price` decimal(12,2) DEFAULT NULL,
  `quantity` int NOT NULL,
  `stop_loss` decimal(12,2) DEFAULT NULL,
  `target_price` decimal(12,2) DEFAULT NULL,
  `status` enum('OPEN','CLOSED','SL_HIT','TP_HIT','FORCE_CLOSED') NOT NULL DEFAULT 'OPEN',
  `pnl` decimal(12,2) DEFAULT '0.00',
  `confidence` int DEFAULT '0',
  `open_time` datetime DEFAULT CURRENT_TIMESTAMP,
  `close_time` datetime DEFAULT NULL,
  `close_reason` varchar(100) DEFAULT NULL,
  `decision_id` int DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `challenge_discipline_history`
--

CREATE TABLE `challenge_discipline_history` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `challenge_id` int NOT NULL,
  `trade_date` date NOT NULL,
  `score` int NOT NULL,
  `grade` varchar(2) NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `challenge_discipline_history`
--

-- --------------------------------------------------------

--
-- Table structure for table `challenge_pause_logs`
--

CREATE TABLE `challenge_pause_logs` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `challenge_id` int DEFAULT NULL,
  `rule_triggered` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `pause_start` datetime DEFAULT NULL,
  `pause_end` datetime DEFAULT NULL,
  `quick_unlock_used` tinyint(1) DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `unlock_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `coins_spent` int DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `challenge_pause_logs`
--

-- --------------------------------------------------------

--
-- Table structure for table `challenge_session_state`
--

CREATE TABLE `challenge_session_state` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `challenge_id` int NOT NULL,
  `trade_date` date NOT NULL,
  `consecutive_losses` int DEFAULT '0',
  `last_trade_exit_time` datetime DEFAULT NULL,
  `cooldown_end` datetime DEFAULT NULL,
  `hero_trade_used` tinyint(1) DEFAULT '0',
  `daily_stop_triggered` tinyint(1) DEFAULT '0',
  `last_quantity` int DEFAULT '0',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `last_buy_time` datetime DEFAULT NULL,
  `last_buy_security_id` varchar(20) DEFAULT NULL,
  `last_buy_price` decimal(12,2) DEFAULT NULL,
  `peak_pnl_today` decimal(12,2) DEFAULT '0.00',
  `avg_quantity` decimal(12,2) DEFAULT '0.00'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `challenge_suggestions`
--

CREATE TABLE `challenge_suggestions` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `challenge_id` int NOT NULL,
  `suggestion_type` enum('INCREASE_CAPITAL','REDUCE_COOLDOWN','LOOSEN_LIMITS','TIGHTEN_LIMITS') NOT NULL,
  `current_value` int NOT NULL,
  `suggested_value` int NOT NULL,
  `field_name` varchar(50) NOT NULL,
  `message` text NOT NULL,
  `status` enum('PENDING','ACCEPTED','REJECTED') DEFAULT 'PENDING',
  `streak_days` int DEFAULT '0',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `resolved_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `challenge_suggestions`
--

-- --------------------------------------------------------

--
-- Table structure for table `challenge_trade_logs`
--

CREATE TABLE `challenge_trade_logs` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `challenge_id` int DEFAULT NULL,
  `security_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `trading_symbol` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `exchange_segment` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `product_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `order_source` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'MANUAL',
  `buy_price` decimal(12,4) DEFAULT NULL,
  `sell_price` decimal(12,4) DEFAULT NULL,
  `buy_order_id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `sell_order_id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `buy_executed_at` datetime DEFAULT NULL,
  `sell_executed_at` datetime DEFAULT NULL,
  `status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'OPEN',
  `trade_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `index_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `quantity` int DEFAULT NULL,
  `pnl` decimal(12,2) DEFAULT NULL,
  `trade_date` date DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `coin_transactions`
--

CREATE TABLE `coin_transactions` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `type` enum('PURCHASE','SPEND') NOT NULL,
  `amount` int NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `reference_id` int DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `coin_transactions`
--

-- --------------------------------------------------------

--
-- Table structure for table `demo_orders`
--

CREATE TABLE `demo_orders` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `security_id` varchar(20) NOT NULL,
  `trading_symbol` varchar(100) NOT NULL,
  `exchange_segment` varchar(30) NOT NULL,
  `transaction_type` varchar(10) NOT NULL,
  `order_type` varchar(20) NOT NULL DEFAULT 'MARKET',
  `quantity` int NOT NULL,
  `price` decimal(12,2) NOT NULL,
  `order_status` varchar(20) NOT NULL DEFAULT 'TRADED',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `target_price` decimal(12,2) DEFAULT '0.00',
  `stop_loss_price` decimal(12,2) DEFAULT '0.00',
  `trailing_jump` decimal(8,2) DEFAULT '0.00',
  `pnl` decimal(12,2) DEFAULT '0.00',
  `product_type` varchar(20) NOT NULL DEFAULT 'INTRADAY',
  `executed_price` decimal(12,2) DEFAULT NULL,
  `executed_at` datetime DEFAULT NULL,
  `square_off_reason` varchar(50) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `demo_orders`
--

-- --------------------------------------------------------

--
-- Table structure for table `demo_settings`
--

CREATE TABLE `demo_settings` (
  `setting_key` varchar(50) NOT NULL,
  `setting_value` varchar(255) NOT NULL,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `demo_settings`
--

-- --------------------------------------------------------

--
-- Table structure for table `demo_wallets`
--

CREATE TABLE `demo_wallets` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `total_granted_coins` decimal(15,2) DEFAULT '0.00',
  `is_first_activation` tinyint(1) DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `demo_wallets`
--

-- --------------------------------------------------------

--
-- Table structure for table `dhan_scrip_master`
--

CREATE TABLE `dhan_scrip_master` (
  `id` int NOT NULL,
  `EXCH_ID` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `SEGMENT` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `SECURITY_ID` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ISIN` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `INSTRUMENT` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `UNDERLYING_SECURITY_ID` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `UNDERLYING_SYMBOL` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `SYMBOL_NAME` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `DISPLAY_NAME` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `INSTRUMENT_TYPE` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `SERIES` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `LOT_SIZE` int DEFAULT NULL,
  `SM_EXPIRY_DATE` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `STRIKE_PRICE` decimal(15,2) DEFAULT NULL,
  `OPTION_TYPE` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `TICK_SIZE` decimal(10,5) DEFAULT NULL,
  `EXPIRY_FLAG` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `BRACKET_FLAG` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COVER_FLAG` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ASM_GSM_FLAG` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ASM_GSM_CATEGORY` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `BUY_SELL_INDICATOR` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `BUY_CO_MIN_MARGIN_PER` decimal(10,2) DEFAULT NULL,
  `BUY_CO_SL_RANGE_MAX_PERC` decimal(10,2) DEFAULT NULL,
  `BUY_CO_SL_RANGE_MIN_PERC` decimal(10,2) DEFAULT NULL,
  `BUY_BO_MIN_MARGIN_PER` decimal(10,2) DEFAULT NULL,
  `BUY_BO_PROFIT_RANGE_MAX_PERC` decimal(10,2) DEFAULT NULL,
  `BUY_BO_PROFIT_RANGE_MIN_PERC` decimal(10,2) DEFAULT NULL,
  `MTF_LEVERAGE` decimal(10,2) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `dhan_trades`
--

CREATE TABLE `dhan_trades` (
  `id` bigint NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `order_id` varchar(50) NOT NULL,
  `trading_symbol` varchar(100) DEFAULT NULL,
  `custom_symbol` varchar(100) DEFAULT NULL,
  `security_id` varchar(20) NOT NULL,
  `exchange_segment` varchar(30) NOT NULL,
  `product_type` varchar(20) DEFAULT NULL,
  `instrument` varchar(20) DEFAULT NULL,
  `drv_expiry_date` varchar(20) DEFAULT NULL,
  `drv_option_type` varchar(5) DEFAULT NULL,
  `drv_strike_price` decimal(15,2) DEFAULT NULL,
  `transaction_type` enum('BUY','SELL') NOT NULL,
  `traded_quantity` int NOT NULL,
  `traded_price` decimal(15,4) NOT NULL,
  `charges` decimal(15,2) NOT NULL DEFAULT '0.00',
  `trade_date` date NOT NULL,
  `exchange_time` datetime NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `dhan_trades`
--

-- --------------------------------------------------------

--
-- Table structure for table `historical_candles`
--

CREATE TABLE `historical_candles` (
  `id` bigint NOT NULL,
  `security_id` varchar(20) NOT NULL,
  `exchange_segment` varchar(30) NOT NULL,
  `candle_date` date NOT NULL,
  `candle_timestamp` bigint NOT NULL DEFAULT '0',
  `open_price` decimal(15,2) NOT NULL,
  `high_price` decimal(15,2) NOT NULL,
  `low_price` decimal(15,2) NOT NULL,
  `close_price` decimal(15,2) NOT NULL,
  `volume` bigint DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `historical_candles`
--

-- --------------------------------------------------------

--
-- Table structure for table `instruments`
--

CREATE TABLE `instruments` (
  `id` int NOT NULL,
  `exch_id` varchar(10) DEFAULT NULL,
  `segment` varchar(10) DEFAULT NULL,
  `security_id` varchar(50) DEFAULT NULL,
  `isin` varchar(50) DEFAULT NULL,
  `instrument` varchar(50) DEFAULT NULL,
  `underlying_security_id` varchar(50) DEFAULT NULL,
  `underlying_symbol` varchar(50) DEFAULT NULL,
  `symbol_name` varchar(50) DEFAULT NULL,
  `display_name` varchar(150) DEFAULT NULL,
  `instrument_type` varchar(50) DEFAULT NULL,
  `series` varchar(20) DEFAULT NULL,
  `lot_size` int DEFAULT NULL,
  `sm_expiry_date` date DEFAULT NULL,
  `strike_price` decimal(15,5) DEFAULT NULL,
  `option_type` varchar(10) DEFAULT NULL,
  `tick_size` decimal(10,5) DEFAULT NULL,
  `expiry_flag` varchar(5) DEFAULT NULL,
  `bracket_flag` varchar(5) DEFAULT NULL,
  `cover_flag` varchar(5) DEFAULT NULL,
  `asm_gsm_flag` varchar(5) DEFAULT NULL,
  `asm_gsm_category` varchar(10) DEFAULT NULL,
  `buy_sell_indicator` varchar(5) DEFAULT NULL,
  `buy_co_min_margin_per` decimal(10,5) DEFAULT NULL,
  `buy_co_sl_range_max_perc` decimal(10,5) DEFAULT NULL,
  `buy_co_sl_range_min_perc` decimal(10,5) DEFAULT NULL,
  `buy_bo_min_margin_per` decimal(10,5) DEFAULT NULL,
  `buy_bo_profit_range_max_perc` decimal(10,5) DEFAULT NULL,
  `buy_bo_profit_range_min_perc` decimal(10,5) DEFAULT NULL,
  `mtf_leverage` decimal(10,5) DEFAULT NULL,
  `sm_upper_limit` decimal(15,5) DEFAULT NULL,
  `sm_lower_limit` decimal(15,5) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `exchange_segment` varchar(32) DEFAULT NULL,
  `trading_symbol` varchar(64) DEFAULT NULL,
  `lifecycle_status` enum('ACTIVE','EXPIRED','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `last_seen_at` datetime DEFAULT NULL,
  `expired_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `instruments`
--

-- --------------------------------------------------------

--
-- Table structure for table `market_data_tokens`
--

CREATE TABLE `market_data_tokens` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `access_token` text NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_active` tinyint(1) NOT NULL DEFAULT '1'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `market_data_tokens`
--

-- --------------------------------------------------------

--
-- Table structure for table `market_historical_candles`
--

CREATE TABLE `market_historical_candles` (
  `id` bigint UNSIGNED NOT NULL,
  `security_id` varchar(50) NOT NULL,
  `exchange_segment` varchar(50) NOT NULL,
  `instrument` varchar(50) DEFAULT NULL,
  `trading_symbol` varchar(150) DEFAULT NULL,
  `interval_minutes` int NOT NULL,
  `candle_timestamp` bigint NOT NULL,
  `candle_datetime` datetime DEFAULT NULL,
  `open_price` decimal(20,8) NOT NULL,
  `high_price` decimal(20,8) NOT NULL,
  `low_price` decimal(20,8) NOT NULL,
  `close_price` decimal(20,8) NOT NULL,
  `volume` bigint DEFAULT '0',
  `open_interest` bigint DEFAULT NULL,
  `source` varchar(50) NOT NULL DEFAULT 'DHAN',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `market_historical_candles`
--

-- --------------------------------------------------------

--
-- Table structure for table `market_movers_snapshot`
--

CREATE TABLE `market_movers_snapshot` (
  `id` int NOT NULL,
  `type` enum('GAINER','LOSER') NOT NULL,
  `rank_order` int NOT NULL,
  `security_id` varchar(20) NOT NULL,
  `symbol` varchar(50) NOT NULL,
  `exchange_segment` varchar(20) NOT NULL DEFAULT 'NSE_EQ',
  `instrument_type` varchar(20) NOT NULL DEFAULT 'EQUITY',
  `indices_json` varchar(255) NOT NULL DEFAULT '[]',
  `ltp` decimal(12,2) NOT NULL,
  `previous_close` decimal(12,2) NOT NULL,
  `change_val` decimal(12,2) NOT NULL,
  `change_percent` decimal(8,4) NOT NULL,
  `volume` bigint DEFAULT '0',
  `snapshot_at` datetime NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `market_movers_snapshot`
--

-- --------------------------------------------------------

--
-- Table structure for table `market_snapshots`
--

CREATE TABLE `market_snapshots` (
  `id` int NOT NULL,
  `symbol` varchar(50) NOT NULL,
  `ltp` decimal(12,2) DEFAULT NULL,
  `open_price` decimal(12,2) DEFAULT NULL,
  `high_price` decimal(12,2) DEFAULT NULL,
  `low_price` decimal(12,2) DEFAULT NULL,
  `close_price` decimal(12,2) DEFAULT NULL,
  `volume` bigint DEFAULT NULL,
  `oi` bigint DEFAULT NULL,
  `pcr` decimal(6,3) DEFAULT NULL,
  `max_pain` decimal(12,2) DEFAULT NULL,
  `iv` decimal(8,3) DEFAULT NULL,
  `vix` decimal(8,3) DEFAULT NULL,
  `snapshot_time` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `option_expiry_dates`
--

CREATE TABLE `option_expiry_dates` (
  `id` int NOT NULL,
  `underlying_scrip` int NOT NULL,
  `underlying_seg` varchar(20) NOT NULL DEFAULT 'IDX_I',
  `symbol` varchar(30) NOT NULL,
  `expiry_date` date NOT NULL,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `option_expiry_dates`
--

-- --------------------------------------------------------

--
-- Table structure for table `otm_trade_log`
--

CREATE TABLE `otm_trade_log` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `trading_symbol` varchar(150) NOT NULL,
  `premium` decimal(12,2) NOT NULL,
  `trade_date` date NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `pending_orders`
--

CREATE TABLE `pending_orders` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) DEFAULT NULL,
  `order_id` varchar(100) DEFAULT NULL,
  `order_type` enum('LIMIT','SUPER') DEFAULT NULL,
  `transaction_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'BUY',
  `security_id` varchar(50) DEFAULT NULL,
  `quantity` int DEFAULT NULL,
  `price` decimal(10,2) DEFAULT NULL,
  `target_price` decimal(10,2) DEFAULT NULL,
  `stop_loss_price` decimal(10,2) DEFAULT NULL,
  `status` enum('PENDING','CANCELLED','EXECUTED') DEFAULT 'PENDING',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `plan_payments`
--

CREATE TABLE `plan_payments` (
  `id` int NOT NULL,
  `user_id` int DEFAULT NULL,
  `dhan_client_id` varchar(64) DEFAULT NULL,
  `plan_type` varchar(32) NOT NULL,
  `amount_paise` int NOT NULL,
  `razorpay_order_id` varchar(64) NOT NULL,
  `razorpay_payment_id` varchar(64) DEFAULT NULL,
  `status` enum('created','paid','failed') NOT NULL DEFAULT 'created',
  `used_for_challenge` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `verified_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `plan_payments`
--

-- --------------------------------------------------------

--
-- Table structure for table `quiz_drink_tokens`
--

CREATE TABLE `quiz_drink_tokens` (
  `token` varchar(12) NOT NULL,
  `session_id` char(36) DEFAULT NULL,
  `phone` varchar(10) NOT NULL,
  `src` varchar(60) DEFAULT NULL,
  `drink` varchar(10) NOT NULL,
  `name` varchar(120) NOT NULL,
  `email` varchar(200) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `redeemed_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `quiz_mentorship_requests`
--

CREATE TABLE `quiz_mentorship_requests` (
  `id` bigint NOT NULL,
  `session_id` char(36) DEFAULT NULL,
  `phone` varchar(10) NOT NULL,
  `src` varchar(60) DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'new',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `quiz_mentorship_requests`
--

-- --------------------------------------------------------

--
-- Table structure for table `quiz_places`
--

CREATE TABLE `quiz_places` (
  `src` varchar(60) NOT NULL,
  `name` varchar(120) NOT NULL,
  `area` varchar(120) DEFAULT NULL,
  `type` varchar(30) NOT NULL,
  `offer` tinyint(1) NOT NULL DEFAULT '1',
  `drinks` varchar(100) NOT NULL DEFAULT 'Chai,Coffee',
  `daily_cap` smallint NOT NULL DEFAULT '15',
  `code` char(3) DEFAULT NULL,
  `counter_pin` varchar(10) DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `quiz_places`
--

-- --------------------------------------------------------

--
-- Table structure for table `quiz_reveal_log`
--

CREATE TABLE `quiz_reveal_log` (
  `id` bigint NOT NULL,
  `admin_id` int NOT NULL,
  `session_id` char(36) NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `quiz_sessions`
--

CREATE TABLE `quiz_sessions` (
  `id` char(36) NOT NULL,
  `src` varchar(60) DEFAULT NULL,
  `trader_type` varchar(10) DEFAULT NULL,
  `phone` varchar(10) NOT NULL,
  `consent` tinyint(1) NOT NULL,
  `answers` json NOT NULL,
  `correct` smallint NOT NULL,
  `score` smallint NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `quiz_sessions`
--

-- --------------------------------------------------------

--
-- Table structure for table `quiz_visits`
--

CREATE TABLE `quiz_visits` (
  `id` bigint NOT NULL,
  `src` varchar(60) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `quiz_visits`
--

-- --------------------------------------------------------

--
-- Table structure for table `razorpay_plan_cache`
--

CREATE TABLE `razorpay_plan_cache` (
  `plan_type` varchar(32) NOT NULL,
  `razorpay_plan_id` varchar(64) NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `razorpay_plan_cache`
--

-- --------------------------------------------------------

--
-- Table structure for table `roles`
--

CREATE TABLE `roles` (
  `role_id` int NOT NULL,
  `role_name` varchar(100) NOT NULL,
  `permissions` json DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `roles`
--

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) DEFAULT NULL,
  `dhan_client_name` varchar(100) DEFAULT NULL,
  `dhan_client_ucc` varchar(50) DEFAULT NULL,
  `full_name` varchar(150) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `mobile_number` varchar(15) DEFAULT NULL,
  `firebase_uid` varchar(128) DEFAULT NULL,
  `signup_source` varchar(20) NOT NULL DEFAULT 'app',
  `dhan_access_token` text,
  `app_token` text,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `profile_picture` varchar(255) DEFAULT NULL,
  `firebase_token` varchar(500) DEFAULT NULL,
  `app_pin_hash` varchar(255) DEFAULT NULL COMMENT 'bcrypt hash of 4-digit app PIN',
  `biometric_enabled` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = biometric unlock enabled',
  `trade_history_synced_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `users`
--

-- --------------------------------------------------------

--
-- Table structure for table `user_challenges`
--

CREATE TABLE `user_challenges` (
  `id` int NOT NULL,
  `user_id` int DEFAULT NULL,
  `dhan_client_id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `trading_style` enum('SCALPER','INTRADAY','SWING','EQUITY','OPTIONS_BUYER','OPTIONS_SELLER') COLLATE utf8mb4_general_ci DEFAULT 'SCALPER',
  `trading_capital` decimal(12,2) DEFAULT NULL,
  `min_profit` decimal(12,2) DEFAULT NULL,
  `max_profit` decimal(12,2) DEFAULT NULL,
  `min_loss` decimal(12,2) DEFAULT NULL,
  `max_loss` decimal(12,2) DEFAULT NULL,
  `max_trades_per_day` int DEFAULT NULL,
  `cooldown_minutes` int DEFAULT '5',
  `consecutive_loss_limit` int DEFAULT '3',
  `max_capital_per_trade_pct` int DEFAULT '25',
  `risk_per_trade_pct` decimal(5,2) DEFAULT '2.50',
  `target_per_trade_pct` decimal(5,2) DEFAULT '5.00',
  `hero_trade_allowed` tinyint(1) DEFAULT '1',
  `nifty_lots` int DEFAULT NULL,
  `banknifty_lots` int DEFAULT NULL,
  `finnifty_lots` int DEFAULT NULL,
  `midcapnifty_lots` int DEFAULT NULL,
  `sensex_lots` int DEFAULT NULL,
  `challenge_days` int DEFAULT NULL,
  `plan_type` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `challenge_start_date` datetime DEFAULT NULL,
  `challenge_end_date` datetime DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `challenge_status` enum('ACTIVE','BLOCKED','COMPLETED') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'ACTIVE',
  `completed_at` datetime DEFAULT NULL,
  `final_pnl` decimal(10,2) DEFAULT '0.00',
  `total_trades_count` int DEFAULT '0',
  `last_pnl_alert_date` date DEFAULT NULL COMMENT 'Date the live P&L max_loss/max_profit alert was last sent',
  `last_pnl_alert_reason` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'MAX LOSS HIT or TARGET ACHIEVED - last live P&L alert sent',
  `holding_period_intent` enum('SHORT','MEDIUM','LONG') COLLATE utf8mb4_general_ci DEFAULT 'SHORT'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `user_challenges`
--

-- --------------------------------------------------------

--
-- Table structure for table `user_coins`
--

CREATE TABLE `user_coins` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `balance` int DEFAULT '0',
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `user_coins`
--

-- --------------------------------------------------------

--
-- Table structure for table `user_trials`
--

CREATE TABLE `user_trials` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(64) NOT NULL,
  `plan_type` varchar(32) NOT NULL,
  `plan_price_rupees` int NOT NULL,
  `full_name` varchar(100) DEFAULT NULL,
  `email` varchar(100) DEFAULT NULL,
  `mobile` varchar(20) DEFAULT NULL,
  `state` varchar(50) DEFAULT NULL,
  `trial_started_at` datetime NOT NULL,
  `trial_ends_at` datetime NOT NULL,
  `first_debit_date` date NOT NULL,
  `autopay_status` enum('pending','created','approved','failed','cancelled') NOT NULL DEFAULT 'pending',
  `razorpay_plan_id` varchar(64) DEFAULT NULL,
  `razorpay_subscription_id` varchar(64) DEFAULT NULL,
  `autopay_approved_at` datetime DEFAULT NULL,
  `cancelled_at` datetime DEFAULT NULL,
  `challenge_id` int DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_wishlist`
--

CREATE TABLE `user_wishlist` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(100) NOT NULL,
  `security_id` varchar(50) NOT NULL,
  `exchange_segment` varchar(32) DEFAULT NULL,
  `instrument_type` varchar(20) DEFAULT NULL,
  `trading_symbol` varchar(64) DEFAULT NULL,
  `display_name` varchar(150) DEFAULT NULL,
  `underlying_symbol` varchar(50) DEFAULT NULL,
  `expiry_date` date DEFAULT NULL,
  `strike_price` decimal(15,5) DEFAULT NULL,
  `option_type` varchar(10) DEFAULT NULL,
  `lot_size` int DEFAULT NULL,
  `status` enum('ACTIVE','EXPIRED','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `status_changed_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `user_wishlist`
--

-- --------------------------------------------------------

--
-- Table structure for table `wallet_topups`
--

CREATE TABLE `wallet_topups` (
  `id` int NOT NULL,
  `dhan_client_id` varchar(50) NOT NULL,
  `amount_rupees` int NOT NULL,
  `razorpay_order_id` varchar(64) NOT NULL,
  `razorpay_payment_id` varchar(64) DEFAULT NULL,
  `status` enum('created','paid','failed') NOT NULL DEFAULT 'created',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `verified_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `wallet_topups`
--

-- --------------------------------------------------------

--
-- Table structure for table `website_contacts`
--

CREATE TABLE `website_contacts` (
  `id` int NOT NULL,
  `first_name` varchar(100) NOT NULL,
  `last_name` varchar(100) NOT NULL,
  `email` varchar(255) NOT NULL,
  `phone_number` varchar(20) NOT NULL,
  `whatsapp_number` varchar(20) NOT NULL,
  `same_as_phone` tinyint(1) NOT NULL DEFAULT '0',
  `contact_count` int NOT NULL DEFAULT '1',
  `last_contacted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `website_contacts`
--

-- --------------------------------------------------------

--
-- Table structure for table `website_profiles`
--

CREATE TABLE `website_profiles` (
  `user_id` int NOT NULL,
  `wa_opt_in` tinyint(1) NOT NULL DEFAULT '0',
  `wa_opt_in_at` datetime DEFAULT NULL,
  `experience` varchar(40) DEFAULT NULL,
  `standing` varchar(40) DEFAULT NULL,
  `capital` varchar(40) DEFAULT NULL,
  `instruments` varchar(255) DEFAULT NULL,
  `losses` varchar(40) DEFAULT NULL,
  `problems` varchar(255) DEFAULT NULL,
  `problem_other` varchar(200) DEFAULT NULL,
  `rules_rr` varchar(10) DEFAULT NULL,
  `rules_lots` varchar(6) DEFAULT NULL,
  `rules_orders` varchar(6) DEFAULT NULL,
  `session_requested` tinyint(1) NOT NULL DEFAULT '0',
  `session_lang` varchar(20) DEFAULT NULL,
  `session_time` varchar(30) DEFAULT NULL,
  `session_status` varchar(40) DEFAULT NULL,
  `session_requested_at` datetime DEFAULT NULL,
  `early_number` int DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'started',
  `ref_code` varchar(12) NOT NULL,
  `referred_by` int DEFAULT NULL,
  `source` varchar(60) NOT NULL DEFAULT 'website',
  `campaign` varchar(20) NOT NULL DEFAULT '',
  `chai_code` varchar(4) DEFAULT NULL,
  `lead_status` varchar(30) NOT NULL DEFAULT 'New',
  `notes` text,
  `last_login_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `website_profiles`
--

-- --------------------------------------------------------

--
-- Table structure for table `website_signups`
--

CREATE TABLE `website_signups` (
  `id` int NOT NULL,
  `first_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `last_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mobile_number` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `trading_capital` decimal(12,2) DEFAULT NULL,
  `min_profit` decimal(12,2) DEFAULT NULL,
  `max_profit` decimal(12,2) DEFAULT NULL,
  `min_loss` decimal(12,2) DEFAULT NULL,
  `max_loss` decimal(12,2) DEFAULT NULL,
  `max_trades_per_day` int DEFAULT NULL,
  `nifty_lots` int NOT NULL DEFAULT '0',
  `banknifty_lots` int NOT NULL DEFAULT '0',
  `finnifty_lots` int NOT NULL DEFAULT '0',
  `midcapnifty_lots` int NOT NULL DEFAULT '0',
  `sensex_lots` int NOT NULL DEFAULT '0',
  `plan_type` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'firstWeek | monthly',
  `amount_paise` int DEFAULT NULL,
  `razorpay_order_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `razorpay_payment_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payment_status` enum('pending','created','paid','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `verified_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `website_signups`
--

--
-- Indexes for dumped tables
--

--
-- Indexes for table `admin`
--
ALTER TABLE `admin`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`),
  ADD KEY `role_id` (`role_id`);

--
-- Indexes for table `ai_coaching_logs`
--
ALTER TABLE `ai_coaching_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_coach` (`dhan_client_id`,`created_at`);

--
-- Indexes for table `ai_decision_logs`
--
ALTER TABLE `ai_decision_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_decision_user` (`dhan_client_id`),
  ADD KEY `idx_decision_bot` (`bot_setting_id`);

--
-- Indexes for table `api_log`
--
ALTER TABLE `api_log`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `bot_daily_stats`
--
ALTER TABLE `bot_daily_stats`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_bot_date` (`bot_setting_id`,`trade_date`);

--
-- Indexes for table `bot_settings`
--
ALTER TABLE `bot_settings`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_user_active` (`dhan_client_id`,`is_active`);

--
-- Indexes for table `bot_strategy_scores`
--
ALTER TABLE `bot_strategy_scores`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_strat_symbol` (`symbol`);

--
-- Indexes for table `bot_trades`
--
ALTER TABLE `bot_trades`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_bot_user` (`dhan_client_id`),
  ADD KEY `idx_bot_status` (`status`),
  ADD KEY `idx_bot_setting` (`bot_setting_id`);

--
-- Indexes for table `challenge_discipline_history`
--
ALTER TABLE `challenge_discipline_history`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_hist` (`dhan_client_id`,`challenge_id`,`trade_date`);

--
-- Indexes for table `challenge_pause_logs`
--
ALTER TABLE `challenge_pause_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`dhan_client_id`);

--
-- Indexes for table `challenge_session_state`
--
ALTER TABLE `challenge_session_state`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_session` (`dhan_client_id`,`challenge_id`,`trade_date`);

--
-- Indexes for table `challenge_suggestions`
--
ALTER TABLE `challenge_suggestions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_sugg` (`dhan_client_id`,`status`);

--
-- Indexes for table `challenge_trade_logs`
--
ALTER TABLE `challenge_trade_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`dhan_client_id`);

--
-- Indexes for table `coin_transactions`
--
ALTER TABLE `coin_transactions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client` (`dhan_client_id`);

--
-- Indexes for table `demo_orders`
--
ALTER TABLE `demo_orders`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client` (`dhan_client_id`),
  ADD KEY `idx_pending` (`order_status`,`order_type`);

--
-- Indexes for table `demo_settings`
--
ALTER TABLE `demo_settings`
  ADD PRIMARY KEY (`setting_key`);

--
-- Indexes for table `demo_wallets`
--
ALTER TABLE `demo_wallets`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `dhan_client_id` (`dhan_client_id`);

--
-- Indexes for table `dhan_scrip_master`
--
ALTER TABLE `dhan_scrip_master`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `dhan_trades`
--
ALTER TABLE `dhan_trades`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_fill` (`dhan_client_id`,`order_id`,`exchange_time`,`transaction_type`,`traded_quantity`,`traded_price`),
  ADD KEY `idx_client_date` (`dhan_client_id`,`trade_date`),
  ADD KEY `idx_client_security_date` (`dhan_client_id`,`security_id`,`trade_date`);

--
-- Indexes for table `historical_candles`
--
ALTER TABLE `historical_candles`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_candle` (`security_id`,`candle_date`),
  ADD KEY `idx_seg` (`exchange_segment`);

--
-- Indexes for table `instruments`
--
ALTER TABLE `instruments`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_instr_segment_security` (`exchange_segment`,`security_id`),
  ADD KEY `idx_instr_security` (`security_id`),
  ADD KEY `idx_instr_lifecycle_expiry` (`lifecycle_status`,`sm_expiry_date`);

--
-- Indexes for table `market_data_tokens`
--
ALTER TABLE `market_data_tokens`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_client` (`dhan_client_id`);

--
-- Indexes for table `market_historical_candles`
--
ALTER TABLE `market_historical_candles`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_market_candle` (`security_id`,`exchange_segment`,`interval_minutes`,`candle_timestamp`),
  ADD KEY `idx_chart_lookup` (`security_id`,`exchange_segment`,`interval_minutes`,`candle_timestamp`),
  ADD KEY `idx_candle_datetime` (`candle_datetime`);

--
-- Indexes for table `market_movers_snapshot`
--
ALTER TABLE `market_movers_snapshot`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_type_rank` (`type`,`rank_order`);

--
-- Indexes for table `market_snapshots`
--
ALTER TABLE `market_snapshots`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_snap_symbol` (`symbol`,`snapshot_time`);

--
-- Indexes for table `option_expiry_dates`
--
ALTER TABLE `option_expiry_dates`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_expiry` (`underlying_scrip`,`expiry_date`);

--
-- Indexes for table `otm_trade_log`
--
ALTER TABLE `otm_trade_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_otm` (`dhan_client_id`,`trade_date`);

--
-- Indexes for table `pending_orders`
--
ALTER TABLE `pending_orders`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `plan_payments`
--
ALTER TABLE `plan_payments`
  ADD PRIMARY KEY (`id`),
  ADD KEY `dhan_client_id` (`dhan_client_id`),
  ADD KEY `razorpay_order_id` (`razorpay_order_id`),
  ADD KEY `idx_plan_payments_user_id` (`user_id`);

--
-- Indexes for table `quiz_drink_tokens`
--
ALTER TABLE `quiz_drink_tokens`
  ADD PRIMARY KEY (`token`),
  ADD UNIQUE KEY `uq_quiz_token_phone` (`phone`),
  ADD KEY `idx_quiz_tokens_src` (`src`,`created_at`);

--
-- Indexes for table `quiz_mentorship_requests`
--
ALTER TABLE `quiz_mentorship_requests`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_quiz_mentorship_src` (`src`,`created_at`);

--
-- Indexes for table `quiz_places`
--
ALTER TABLE `quiz_places`
  ADD PRIMARY KEY (`src`),
  ADD UNIQUE KEY `uq_quiz_place_code` (`code`);

--
-- Indexes for table `quiz_reveal_log`
--
ALTER TABLE `quiz_reveal_log`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `quiz_sessions`
--
ALTER TABLE `quiz_sessions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_quiz_sessions_src` (`src`,`created_at`),
  ADD KEY `idx_quiz_sessions_phone` (`phone`);

--
-- Indexes for table `quiz_visits`
--
ALTER TABLE `quiz_visits`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_quiz_visits_src` (`src`,`created_at`);

--
-- Indexes for table `razorpay_plan_cache`
--
ALTER TABLE `razorpay_plan_cache`
  ADD PRIMARY KEY (`plan_type`);

--
-- Indexes for table `roles`
--
ALTER TABLE `roles`
  ADD PRIMARY KEY (`role_id`),
  ADD UNIQUE KEY `role_name` (`role_name`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_dhan_client` (`dhan_client_id`),
  ADD UNIQUE KEY `uniq_users_mobile` (`mobile_number`),
  ADD KEY `idx_users_firebase_uid` (`firebase_uid`);

--
-- Indexes for table `user_challenges`
--
ALTER TABLE `user_challenges`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_dhan_client_id` (`dhan_client_id`),
  ADD KEY `idx_user_challenges_user_id` (`user_id`);

--
-- Indexes for table `user_coins`
--
ALTER TABLE `user_coins`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `dhan_client_id` (`dhan_client_id`);

--
-- Indexes for table `user_trials`
--
ALTER TABLE `user_trials`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_trial_account` (`dhan_client_id`);

--
-- Indexes for table `user_wishlist`
--
ALTER TABLE `user_wishlist`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_user_segment_security` (`dhan_client_id`,`exchange_segment`,`security_id`),
  ADD KEY `idx_wishlist_user_status` (`dhan_client_id`,`status`);

--
-- Indexes for table `wallet_topups`
--
ALTER TABLE `wallet_topups`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_topup_order` (`razorpay_order_id`),
  ADD KEY `idx_topup_client` (`dhan_client_id`);

--
-- Indexes for table `website_contacts`
--
ALTER TABLE `website_contacts`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `website_profiles`
--
ALTER TABLE `website_profiles`
  ADD PRIMARY KEY (`user_id`),
  ADD UNIQUE KEY `uq_wp_ref_code` (`ref_code`),
  ADD UNIQUE KEY `uq_wp_early_number` (`early_number`),
  ADD KEY `idx_wp_source` (`source`),
  ADD KEY `idx_wp_created` (`created_at`);

--
-- Indexes for table `website_signups`
--
ALTER TABLE `website_signups`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_email` (`email`),
  ADD KEY `idx_mobile` (`mobile_number`),
  ADD KEY `idx_order` (`razorpay_order_id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `admin`
--
ALTER TABLE `admin`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `ai_coaching_logs`
--
ALTER TABLE `ai_coaching_logs`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `ai_decision_logs`
--
ALTER TABLE `ai_decision_logs`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=293;

--
-- AUTO_INCREMENT for table `api_log`
--
ALTER TABLE `api_log`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2137;

--
-- AUTO_INCREMENT for table `bot_daily_stats`
--
ALTER TABLE `bot_daily_stats`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4145;

--
-- AUTO_INCREMENT for table `bot_settings`
--
ALTER TABLE `bot_settings`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `bot_strategy_scores`
--
ALTER TABLE `bot_strategy_scores`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `bot_trades`
--
ALTER TABLE `bot_trades`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `challenge_discipline_history`
--
ALTER TABLE `challenge_discipline_history`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=224;

--
-- AUTO_INCREMENT for table `challenge_pause_logs`
--
ALTER TABLE `challenge_pause_logs`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=62;

--
-- AUTO_INCREMENT for table `challenge_session_state`
--
ALTER TABLE `challenge_session_state`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `challenge_suggestions`
--
ALTER TABLE `challenge_suggestions`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=25;

--
-- AUTO_INCREMENT for table `challenge_trade_logs`
--
ALTER TABLE `challenge_trade_logs`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=82;

--
-- AUTO_INCREMENT for table `coin_transactions`
--
ALTER TABLE `coin_transactions`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=38;

--
-- AUTO_INCREMENT for table `demo_orders`
--
ALTER TABLE `demo_orders`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=337;

--
-- AUTO_INCREMENT for table `demo_wallets`
--
ALTER TABLE `demo_wallets`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=15;

--
-- AUTO_INCREMENT for table `dhan_scrip_master`
--
ALTER TABLE `dhan_scrip_master`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `dhan_trades`
--
ALTER TABLE `dhan_trades`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1168;

--
-- AUTO_INCREMENT for table `historical_candles`
--
ALTER TABLE `historical_candles`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7827;

--
-- AUTO_INCREMENT for table `instruments`
--
ALTER TABLE `instruments`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3499389;

--
-- AUTO_INCREMENT for table `market_data_tokens`
--
ALTER TABLE `market_data_tokens`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `market_historical_candles`
--
ALTER TABLE `market_historical_candles`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=189236;

--
-- AUTO_INCREMENT for table `market_movers_snapshot`
--
ALTER TABLE `market_movers_snapshot`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1180;

--
-- AUTO_INCREMENT for table `market_snapshots`
--
ALTER TABLE `market_snapshots`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `option_expiry_dates`
--
ALTER TABLE `option_expiry_dates`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7384;

--
-- AUTO_INCREMENT for table `otm_trade_log`
--
ALTER TABLE `otm_trade_log`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `pending_orders`
--
ALTER TABLE `pending_orders`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=102;

--
-- AUTO_INCREMENT for table `plan_payments`
--
ALTER TABLE `plan_payments`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=11;

--
-- AUTO_INCREMENT for table `quiz_mentorship_requests`
--
ALTER TABLE `quiz_mentorship_requests`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `quiz_reveal_log`
--
ALTER TABLE `quiz_reveal_log`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `quiz_visits`
--
ALTER TABLE `quiz_visits`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `roles`
--
ALTER TABLE `roles`
  MODIFY `role_id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=25;

--
-- AUTO_INCREMENT for table `user_challenges`
--
ALTER TABLE `user_challenges`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=50;

--
-- AUTO_INCREMENT for table `user_coins`
--
ALTER TABLE `user_coins`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=26;

--
-- AUTO_INCREMENT for table `user_trials`
--
ALTER TABLE `user_trials`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- AUTO_INCREMENT for table `user_wishlist`
--
ALTER TABLE `user_wishlist`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=36;

--
-- AUTO_INCREMENT for table `wallet_topups`
--
ALTER TABLE `wallet_topups`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `website_contacts`
--
ALTER TABLE `website_contacts`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=13;

--
-- AUTO_INCREMENT for table `website_signups`
--
ALTER TABLE `website_signups`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `admin`
--
ALTER TABLE `admin`
  ADD CONSTRAINT `admin_ibfk_1` FOREIGN KEY (`role_id`) REFERENCES `roles` (`role_id`);
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
