# MySQL Docker Setup

ไฟล์นี้ใช้สำหรับสร้าง MySQL database container

## การใช้งาน

### 1. เริ่มต้น MySQL container
```bash
docker-compose up -d mysql
```

### 2. ตรวจสอบสถานะ container
```bash
docker-compose ps
```

### 3. เข้าสู่ MySQL shell
```bash
docker exec -it poc-mysql mysql -u root -p
```

### 4. หยุด container
```bash
docker-compose down
```

### 5. หยุด container และลบ volumes (ข้อมูลจะหายทั้งหมด)
```bash
docker-compose down -v
```

## ข้อมูลการเชื่อมต่อ

- **Host**: localhost
- **Port**: 3306
- **Database**: poc_chart_db
- **User**: poc_user
- **Password**: poc_password
- **Root Password**: rootpassword

## คุณสมบัติ

- ✅ MySQL เวอร์ชันล่าสุด
- ✅ Auto-restart เมื่อ Docker daemon เริ่มต้น
- ✅ Persistent data storage
- ✅ Health check
- ✅ Initial database setup script
- ✅ ตั้งค่า authentication plugin สำหรับความเข้ากันได้

## โครงสร้างไฟล์

- `docker-compose.yml` - การตั้งค่า Docker services
- `mysql-init/init.sql` - Script สำหรับสร้างตารางเริ่มต้น
- `.env.example` - ตัวอย่างไฟล์ environment variables

## การเปลี่ยนแปลงรหัสผ่าน

1. แก้ไขไฟล์ `.env`
2. หยุด container: `docker-compose down -v`
3. เริ่มใหม่: `docker-compose up -d mysql`
