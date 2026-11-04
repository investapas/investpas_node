-- Migration: Investapas Quiz (Trading Discipline Test) — public quiz page
-- at GET /quiz, API under /api/quiz/*, admin screens under /admin/quiz/*.
-- See controllers/QuizController.js, controllers/QuizAdminController.js.
--
-- Table names are prefixed `quiz_` (the setup guide used plain `places`,
-- `drink_tokens` etc.) to avoid colliding with anything already in this
-- shared database.

CREATE TABLE IF NOT EXISTS `quiz_places` (
  `src`          VARCHAR(60)  NOT NULL,
  `name`         VARCHAR(120) NOT NULL,
  `area`         VARCHAR(120) NULL,
  `type`         VARCHAR(30)  NOT NULL,
  `offer`        TINYINT(1)   NOT NULL DEFAULT 1,
  `drinks`       VARCHAR(100) NOT NULL DEFAULT 'Chai,Coffee',
  `daily_cap`    SMALLINT     NOT NULL DEFAULT 15,
  `code`         CHAR(3)      NULL,
  `counter_pin`  VARCHAR(10)  NULL,
  `active`       TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at`   DATETIME     DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`src`),
  UNIQUE KEY `uq_quiz_place_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `quiz_visits` (
  `id`         BIGINT      NOT NULL AUTO_INCREMENT,
  `src`        VARCHAR(60) NULL,
  `created_at` DATETIME    DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_quiz_visits_src` (`src`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `quiz_sessions` (
  `id`           CHAR(36)    NOT NULL,
  `src`          VARCHAR(60) NULL,
  `trader_type`  VARCHAR(10) NULL,
  `phone`        VARCHAR(10) NOT NULL,
  `consent`      TINYINT(1)  NOT NULL,
  `answers`      JSON        NOT NULL,
  `correct`      SMALLINT    NOT NULL,
  `score`        SMALLINT    NOT NULL,
  `created_at`   DATETIME    DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_quiz_sessions_src` (`src`, `created_at`),
  KEY `idx_quiz_sessions_phone` (`phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `quiz_drink_tokens` (
  `token`        VARCHAR(12)  NOT NULL,
  `session_id`   CHAR(36)     NULL,
  `phone`        VARCHAR(10)  NOT NULL,
  `src`          VARCHAR(60)  NULL,
  `drink`        VARCHAR(10)  NOT NULL,
  `name`         VARCHAR(120) NOT NULL,
  `email`        VARCHAR(200) NULL,
  `created_at`   DATETIME     DEFAULT CURRENT_TIMESTAMP,
  `redeemed_at`  DATETIME     NULL,
  PRIMARY KEY (`token`),
  UNIQUE KEY `uq_quiz_token_phone` (`phone`),
  KEY `idx_quiz_tokens_src` (`src`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `quiz_mentorship_requests` (
  `id`          BIGINT      NOT NULL AUTO_INCREMENT,
  `session_id`  CHAR(36)    NULL,
  `phone`       VARCHAR(10) NOT NULL,
  `src`         VARCHAR(60) NULL,
  `status`      VARCHAR(20) NOT NULL DEFAULT 'new',
  `created_at`  DATETIME    DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_quiz_mentorship_src` (`src`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Audit trail for "Reveal number" in the admin Players detail view.
CREATE TABLE IF NOT EXISTS `quiz_reveal_log` (
  `id`          BIGINT    NOT NULL AUTO_INCREMENT,
  `admin_id`    INT       NOT NULL,
  `session_id`  CHAR(36)  NOT NULL,
  `created_at`  DATETIME  DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
