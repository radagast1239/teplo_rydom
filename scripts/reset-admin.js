/**
 * Сброс или создание пароля админа.
 * Запуск из папки проекта: node scripts/reset-admin.js [новый_пароль]
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");

const DB_PATH = path.join(__dirname, "..", "app.db");
const email = (process.env.ADMIN_EMAIL || "traceur95@mail.ru").toLowerCase();
const password = process.argv[2] || process.env.ADMIN_PASSWORD || "AdminTeplo2026!";

const db = new sqlite3.Database(DB_PATH);
const hash = bcrypt.hashSync(password, 10);

db.run(
  `UPDATE admins SET password_hash = ? WHERE lower(email) = ?`,
  [hash, email],
  function (err) {
    if (err) {
      console.error(err.message);
      db.close();
      process.exit(1);
    }
    if (this.changes > 0) {
      console.log("Пароль админа обновлён для:", email);
      db.close();
      return;
    }
    db.run(
      `INSERT INTO admins (email, password_hash, name) VALUES (?, ?, ?)`,
      [email, hash, "Администратор"],
      (e2) => {
        if (e2) console.error(e2.message);
        else console.log("Админ создан:", email);
        db.close();
      }
    );
  }
);
