#!/bin/bash

# สคริปต์สำหรับจัดการ Olympic Medal Database

echo "=== Olympic Medal Database Management ==="
echo ""

case "$1" in
    "connect")
        echo "เชื่อมต่อ MySQL..."
        docker exec -it poc-mysql mysql -u poc_user -ppoc_password poc_chart_db
        ;;
    "connect-root")
        echo "เชื่อมต่อ MySQL ด้วย root..."
        docker exec -it poc-mysql mysql -u root -prootpassword poc_chart_db
        ;;
    "status")
        echo "สถานะ Database:"
        docker exec -it poc-mysql mysql -u root -prootpassword -e "
        USE poc_chart_db;
        SELECT 
            'Total Records' as metric, COUNT(*) as value FROM olympic_medalists
        UNION ALL
        SELECT 
            'Total Countries', COUNT(DISTINCT country) FROM olympic_medalists
        UNION ALL
        SELECT 
            'Total Sports', COUNT(DISTINCT sport) FROM olympic_medalists
        UNION ALL
        SELECT 
            'Year Range', CONCAT(MIN(year), ' - ', MAX(year)) FROM olympic_medalists;
        "
        ;;
    "medals")
        echo "สถิติเหรียญ:"
        docker exec -it poc-mysql mysql -u root -prootpassword -e "
        USE poc_chart_db;
        SELECT medal, COUNT(*) as count 
        FROM olympic_medalists 
        GROUP BY medal 
        ORDER BY count DESC;
        "
        ;;
    "top-countries")
        echo "10 ประเทศที่ได้เหรียญมากที่สุด:"
        docker exec -it poc-mysql mysql -u root -prootpassword -e "
        USE poc_chart_db;
        SELECT country, COUNT(*) as total_medals 
        FROM olympic_medalists 
        WHERE country != ''
        GROUP BY country 
        ORDER BY total_medals DESC 
        LIMIT 10;
        "
        ;;
    "backup")
        echo "สำรองข้อมูล..."
        docker exec poc-mysql mysqldump -u root -prootpassword poc_chart_db olympic_medalists > olympic_backup_$(date +%Y%m%d_%H%M%S).sql
        echo "สำรองข้อมูลเสร็จ"
        ;;
    *)
        echo "การใช้งาน:"
        echo "  $0 connect       - เชื่อมต่อ MySQL ด้วย user"
        echo "  $0 connect-root  - เชื่อมต่อ MySQL ด้วย root"
        echo "  $0 status        - แสดงสถิติฐานข้อมูล"
        echo "  $0 medals        - แสดงสถิติเหรียญ"
        echo "  $0 top-countries - แสดง 10 ประเทศที่ได้เหรียญมากที่สุด"
        echo "  $0 backup        - สำรองข้อมูล"
        ;;
esac
