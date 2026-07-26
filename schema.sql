-- Schéma entraide-feu — exécuté automatiquement au démarrage (CREATE IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS identities (
  hash        CHAR(64) PRIMARY KEY,
  name        VARCHAR(40) DEFAULT NULL,
  profession  ENUM('pompier','policier','soignant') DEFAULT NULL,
  banned      TINYINT(1) NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pings (
  id          CHAR(10) PRIMARY KEY,
  owner_hash  CHAR(64) NOT NULL,
  kind        ENUM('besoin','offre') NOT NULL,
  type        ENUM('humain','materiel','medical','collecte','refuge') NOT NULL,
  title       VARCHAR(80) NOT NULL,
  message     TEXT,
  private_message TEXT,
  lat         DECIMAL(9,6) NOT NULL,
  lng         DECIMAL(9,6) NOT NULL,
  photo       VARCHAR(64) DEFAULT NULL,
  audio       VARCHAR(64) DEFAULT NULL,
  status      ENUM('open','closed') NOT NULL DEFAULT 'open',
  close_code  CHAR(4) NOT NULL,
  hidden      TINYINT(1) NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at   TIMESTAMP NULL DEFAULT NULL,
  KEY idx_created (created_at),
  KEY idx_owner (owner_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ping_updates (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  ping_id     CHAR(10) NOT NULL,
  text        VARCHAR(300) NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ping (ping_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS arrivals (
  ping_id     CHAR(10) NOT NULL,
  helper_hash CHAR(64) NOT NULL,
  eta         VARCHAR(20) DEFAULT NULL,
  phone       VARCHAR(25) DEFAULT NULL,
  lat         DECIMAL(9,6) DEFAULT NULL,  -- position partagée par le dépanneur,
  lng         DECIMAL(9,6) DEFAULT NULL,  -- visible du seul émetteur du ping
  pos_at      TIMESTAMP NULL DEFAULT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ping_id, helper_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE arrivals ADD COLUMN IF NOT EXISTS lat DECIMAL(9,6) DEFAULT NULL;
ALTER TABLE arrivals ADD COLUMN IF NOT EXISTS lng DECIMAL(9,6) DEFAULT NULL;
ALTER TABLE arrivals ADD COLUMN IF NOT EXISTS pos_at TIMESTAMP NULL DEFAULT NULL;

CREATE TABLE IF NOT EXISTS reports (
  ping_id       CHAR(10) NOT NULL,
  reporter_hash CHAR(64) NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ping_id, reporter_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contact_requests (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  ping_id        CHAR(10) NOT NULL,
  requester_hash CHAR(64) NOT NULL,
  status         ENUM('pending','accepted','declined') NOT NULL DEFAULT 'pending',
  phone          VARCHAR(25) DEFAULT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_req (ping_id, requester_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS watchers (
  hash         CHAR(64) PRIMARY KEY,
  subscription TEXT,
  cats         VARCHAR(120) NOT NULL DEFAULT '',
  lat          DECIMAL(9,6) DEFAULT NULL,
  lng          DECIMAL(9,6) DEFAULT NULL,
  radius_km    SMALLINT NOT NULL DEFAULT 20,
  visible      TINYINT(1) NOT NULL DEFAULT 0,
  offer_cats   VARCHAR(120) NOT NULL DEFAULT '',
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS zones (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  label      VARCHAR(80) NOT NULL,
  lat        DECIMAL(9,6) NOT NULL,
  lng        DECIMAL(9,6) NOT NULL,
  radius_m   INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS official_points (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  type       ENUM('refuge','collecte','info') NOT NULL DEFAULT 'refuge',
  label      VARCHAR(100) NOT NULL,
  detail     VARCHAR(300) DEFAULT NULL,
  lat        DECIMAL(9,6) NOT NULL,
  lng        DECIMAL(9,6) NOT NULL,
  source     VARCHAR(120) DEFAULT NULL,
  auto       TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE official_points ADD COLUMN IF NOT EXISTS auto TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS geocode_cache (
  q          VARCHAR(191) PRIMARY KEY,
  lat        DECIMAL(9,6) DEFAULT NULL,
  lng        DECIMAL(9,6) DEFAULT NULL,
  ok         TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stats (
  k VARCHAR(30) PRIMARY KEY,
  v INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO stats (k, v) VALUES ('resolved', 0);
