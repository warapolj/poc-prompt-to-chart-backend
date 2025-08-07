-- นำเข้าข้อมูลจากไฟล์ CSV เข้าสู่ตาราง olympic_medalists
USE poc_chart_db;

LOAD DATA INFILE '/var/lib/mysql-files/olympic_data.csv'
INTO TABLE olympic_medalists
FIELDS TERMINATED BY ','
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(season, year, medal, country_code, country, athletes, games, sport, event_gender, event_name);

-- ตรวจสอบจำนวนข้อมูลที่นำเข้า
SELECT COUNT(*) as total_records FROM olympic_medalists;

-- แสดงข้อมูล 5 แถวแรก
SELECT * FROM olympic_medalists LIMIT 5;

-- สถิติเบื้องต้น
SELECT 
    COUNT(DISTINCT country) as total_countries,
    COUNT(DISTINCT sport) as total_sports,
    COUNT(DISTINCT year) as total_years,
    MIN(year) as first_year,
    MAX(year) as last_year
FROM olympic_medalists;
