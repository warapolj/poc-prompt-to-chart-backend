-- สร้างตาราง olympic_medalists
USE poc_chart_db;

DROP TABLE IF EXISTS olympic_medalists;

CREATE TABLE olympic_medalists (
    id INT AUTO_INCREMENT PRIMARY KEY,
    season VARCHAR(20) NOT NULL,
    year INT NOT NULL,
    medal VARCHAR(20) NOT NULL,
    country_code VARCHAR(10) NOT NULL,
    country VARCHAR(100) NOT NULL,
    athletes VARCHAR(255) NOT NULL,
    games VARCHAR(100) NOT NULL,
    sport VARCHAR(100) NOT NULL,
    event_gender VARCHAR(20) NOT NULL,
    event_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_season (season),
    INDEX idx_year (year),
    INDEX idx_medal (medal),
    INDEX idx_country_code (country_code),
    INDEX idx_sport (sport),
    INDEX idx_event_gender (event_gender)
);

-- แสดงโครงสร้างตาราง
DESCRIBE olympic_medalists;
