require("dotenv").config();
const express = require("express");
const path = require("path");
const dns = require("dns");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const nodemailer = require("nodemailer");

/* Railway и др. часто без маршрута к IPv6; Mail.ru отдаёт AAAA → ENETUNREACH на :465 */
if (String(process.env.SMTP_PREFER_IPV4 || "1") !== "0" && typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

const app = express();
const PORT = process.env.PORT || 3000;

function startHttpServer() {
  app.listen(PORT, () => {
    console.log(`Сервер: http://localhost:${PORT}`);
    console.log(`Админка: http://localhost:${PORT}/admin.html`);
    const t = getMailTransport();
    const to = notifyRecipients().join(", ") || "(не задан NOTIFY_EMAIL)";
    const fromOk = !!(process.env.SMTP_FROM || process.env.SMTP_USER);
    if (t && fromOk) {
      console.log(`[mail] Уведомления на: ${to} (SMTP включён)`);
    } else {
      console.log(
        `[mail] Уведомления на: ${to} — без реальной отправки (задайте SMTP_HOST/SMTP_SERVICE, SMTP_USER, SMTP_PASS; см. .env.example)`
      );
    }
  });
}

const JWT_SECRET = process.env.JWT_SECRET || "teplo_ryadom_dev_secret";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "app.db");
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "traceur95@mail.ru";
const ADMIN_SEED_EMAIL = (process.env.ADMIN_EMAIL || "traceur95@mail.ru").toLowerCase();
const MAIL_NOTIFY_CHAT = String(process.env.MAIL_NOTIFY_CHAT || "1") === "1";

function notifyRecipients() {
  return String(NOTIFY_EMAIL || "")
    .split(/[,;]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

let _mailTransport;

function smtpLookup(hostname, _options, callback) {
  if (String(process.env.SMTP_PREFER_IPV4 || "1") === "0") {
    return dns.lookup(hostname, callback);
  }
  dns.lookup(hostname, { family: 4 }, callback);
}

function getMailTransport() {
  if (_mailTransport !== undefined) return _mailTransport;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const host = process.env.SMTP_HOST;
  if (host && user && pass) {
    const port = Number(process.env.SMTP_PORT || 465);
    const envSecure = process.env.SMTP_SECURE;
    const secure =
      envSecure !== undefined
        ? String(envSecure) === "true"
        : port === 465;
    _mailTransport = nodemailer.createTransport({
      host,
      port,
      secure,
      lookup: smtpLookup,
      ...(port === 587 && !secure ? { requireTLS: true } : {}),
      auth: { user, pass },
    });
  } else if (process.env.SMTP_SERVICE && user && pass) {
    _mailTransport = nodemailer.createTransport({
      service: process.env.SMTP_SERVICE,
      lookup: smtpLookup,
      auth: { user, pass },
    });
  } else {
    _mailTransport = null;
  }
  return _mailTransport;
}

/** Уведомления администратору (NOTIFY_EMAIL). Без SMTP — текст в лог сервера. */
async function sendAdminNotify(subject, text) {
  const to = notifyRecipients();
  if (!to.length) {
    console.log(`[mail] NOTIFY_EMAIL пуст — ${subject}\n${text}`);
    return;
  }
  const transporter = getMailTransport();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (transporter && from) {
    try {
      const info = await transporter.sendMail({
        from,
        to: to.join(", "),
        subject,
        text,
      });
      console.log("[mail] отправлено:", subject, info && info.messageId ? info.messageId : "");
    } catch (e) {
      console.error("[mail] ошибка отправки:", e.message);
    }
  } else {
    console.log(
      `[mail] SMTP не настроен — письмо не ушло. Уведомление для ${to.join(", ")}:\n${subject}\n${text}`
    );
  }
}

function sendAdminNotifyLater(subject, text) {
  sendAdminNotify(subject, text).catch(() => {});
}

async function sendRegistrationNotify(user, regStatus) {
  const pending =
    regStatus === "pending"
      ? "\nСтатус: на модерации (нужно одобрение в админке).\n"
      : "\nСтатус: сразу одобрен (вход без проверки).\n";
  const subject = `[Тепло рядом] Новая регистрация: ${user.name}`;
  const text = `Новый пользователь зарегистрировался на сайте.
${pending}
Имя: ${user.name}
Роль: ${user.role === "helper" ? "Помощник" : "Клиент"}
Телефон: ${user.phone}
Email: ${user.email || "—"}
ID в системе: ${user.id}
Дата: ${new Date().toISOString()}
`;
  await sendAdminNotify(subject, text);
}

const db = new sqlite3.Database(DB_PATH);

/* Явный CORS: запросы с Beget / .рф и других доменов к API на Railway */
const allowCrossOrigin = cors({
  origin: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  maxAge: 86400,
});
// Этого достаточно: CORS обрабатывает и preflight OPTIONS для всех маршрутов.
app.use(allowCrossOrigin);
app.use(express.json());
app.get("/health", (_, res) => res.status(200).json({ ok: true }));
app.get("/api/health", (_, res) => res.status(200).json({ ok: true }));

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('client', 'helper')),
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      city TEXT,
      address TEXT,
      bio TEXT,
      notes TEXT,
      skills TEXT,
      availability_start TEXT,
      availability_end TEXT,
      on_duty INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      helper_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      order_date TEXT,
      reschedule_requested_date TEXT,
      reschedule_status TEXT,
      tariff TEXT,
      services TEXT,
      important TEXT,
      cancellation_fee INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(client_id) REFERENCES users(id),
      FOREIGN KEY(helper_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`INSERT OR IGNORE INTO site_settings (key, value) VALUES ('registration_open', '1')`);
  db.run(`INSERT OR IGNORE INTO site_settings (key, value) VALUES ('maintenance_mode', '0')`);
  db.run(
    `INSERT OR IGNORE INTO site_settings (key, value) VALUES ('require_registration_approval', '1')`
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_low INTEGER NOT NULL,
      user_high INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_low, user_high),
      FOREIGN KEY(user_low) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(user_high) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      sender_id INTEGER,
      body TEXT NOT NULL,
      from_staff INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(sender_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cert_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      emoji TEXT,
      from_name TEXT,
      to_name TEXT,
      message TEXT,
      delivery TEXT,
      email TEXT,
      wishlist_name TEXT,
      wishlist_link TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.all(`PRAGMA table_info(users)`, (uErr, uRows) => {
    if (uErr || !uRows) return;
    const uCols = uRows.map((r) => r.name);
    if (!uCols.includes("is_blocked")) {
      db.run(`ALTER TABLE users ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0`);
    }
    if (!uCols.includes("registration_status")) {
      db.run(`ALTER TABLE users ADD COLUMN registration_status TEXT NOT NULL DEFAULT 'approved'`);
      db.run(`UPDATE users SET registration_status = 'approved' WHERE registration_status IS NULL OR TRIM(registration_status) = ''`);
    }
  });

  /* Старт HTTP только после проверки/создания админа — иначе вход «не работает» при быстром запросе.
     На Railway shell и веб-контейнер — разные диски: сброс через reset-admin в shell не виден API.
     Если задан ADMIN_PASSWORD в Variables, при каждом деплое/рестарте хеш в этой БД совпадает с паролем. */
  db.get(`SELECT COUNT(*) AS c FROM admins`, (aErr, aRow) => {
    const syncAdminPasswordFromEnv = (then) => {
      const raw = process.env.ADMIN_PASSWORD;
      if (!raw || !String(raw).trim()) return then();
      let hash;
      try {
        hash = bcrypt.hashSync(String(raw).trim(), 10);
      } catch (e) {
        console.error("[admin] ADMIN_PASSWORD:", e);
        return then();
      }
      db.run(
        `UPDATE admins SET password_hash = ? WHERE lower(email) = ?`,
        [hash, ADMIN_SEED_EMAIL],
        function (uErr) {
          if (uErr) console.error("[admin] sync:", uErr.message);
          else if (this.changes > 0) {
            console.log("[admin] Пароль синхронизирован с ADMIN_PASSWORD (та же БД, что у API)");
          }
          then();
        }
      );
    };

    const go = () => syncAdminPasswordFromEnv(() => startHttpServer());

    if (aErr || !aRow) {
      console.error("[admin] не удалось проверить таблицу admins:", aErr && aErr.message);
      return go();
    }
    if (aRow.c > 0) return go();
    const pwd = process.env.ADMIN_PASSWORD || "AdminTeplo2026!";
    try {
      const hash = bcrypt.hashSync(pwd, 10);
      db.run(
        `INSERT INTO admins (email, password_hash, name) VALUES (?, ?, ?)`,
        [ADMIN_SEED_EMAIL, hash, "Администратор"],
        (insErr) => {
          if (insErr) console.error("[admin] не удалось создать админа:", insErr.message);
          else {
            console.log(`[admin] Создан админ: ${ADMIN_SEED_EMAIL}`);
            console.log("[admin] Пароль: ADMIN_PASSWORD в .env или по умолчанию AdminTeplo2026!");
          }
          go();
        }
      );
    } catch (e) {
      console.error("[admin] ошибка:", e);
      go();
    }
  });

  db.all(`PRAGMA table_info(orders)`, (err, rows) => {
    if (err || !rows) return;
    const cols = rows.map((r) => r.name);
    if (!cols.includes("reschedule_requested_date")) {
      db.run(`ALTER TABLE orders ADD COLUMN reschedule_requested_date TEXT`);
    }
    if (!cols.includes("reschedule_status")) {
      db.run(`ALTER TABLE orders ADD COLUMN reschedule_status TEXT`);
    }
    if (!cols.includes("cancellation_fee")) {
      db.run(`ALTER TABLE orders ADD COLUMN cancellation_fee INTEGER DEFAULT 0`);
    }
  });
});

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function signAdminToken(admin) {
  return jwt.sign(
    { sub: admin.id, admin: true, email: admin.email, name: admin.name || "Админ" },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.admin) {
      return res.status(401).json({ error: "Нужен вход пользователя, не админа" });
    }
    req.user = payload;
    db.get(
      `SELECT is_blocked, registration_status FROM users WHERE id = ?`,
      [payload.sub],
      (err, row) => {
        if (err) return res.status(500).json({ error: "DB error" });
        if (!row) return res.status(401).json({ error: "User not found" });
        if (row.is_blocked) return res.status(403).json({ error: "Аккаунт заблокирован" });
        const rs = row.registration_status || "approved";
        if (rs === "pending") {
          return res.status(403).json({
            error: "Анкета на проверке. После одобрения администратором вы сможете пользоваться кабинетом.",
          });
        }
        if (rs === "rejected") {
          return res.status(403).json({
            error: "Регистрация отклонена администратором. При необходимости свяжитесь с поддержкой.",
          });
        }
        next();
      }
    );
  } catch (_) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function adminAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.admin) return res.status(403).json({ error: "Только для администратора" });
    req.admin = payload;
    next();
  } catch (_) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const { role, name, phone, email, password, profile: profileIn } = req.body || {};
    if (!role || !name || !phone || !password) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (!["client", "helper"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    function mergeProfileRow(userId, then) {
      const prof = profileIn && typeof profileIn === "object" ? profileIn : null;
      if (!prof) return then(null);
      db.run(
        `UPDATE profiles
         SET city = ?, address = ?, bio = ?, notes = ?, skills = ?,
             availability_start = ?, availability_end = ?, on_duty = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [
          prof.city != null ? String(prof.city).trim() || null : null,
          prof.address != null ? String(prof.address).trim().slice(0, 500) || null : null,
          prof.bio != null ? String(prof.bio).trim().slice(0, 4000) || null : null,
          prof.notes != null ? String(prof.notes).trim().slice(0, 4000) || null : null,
          prof.skills != null ? String(prof.skills).trim().slice(0, 2000) || null : null,
          prof.availability_start != null ? String(prof.availability_start).trim() || null : null,
          prof.availability_end != null ? String(prof.availability_end).trim() || null : null,
          prof.on_duty ? 1 : 0,
          userId,
        ],
        (uErr) => {
          if (uErr) console.error("[register] profile:", uErr.message);
          then(uErr);
        }
      );
    }

    db.all(
      `SELECT key, value FROM site_settings WHERE key IN ('registration_open', 'require_registration_approval')`,
      [],
      async (sErr, sRows) => {
        if (sErr) return res.status(500).json({ error: "DB error" });
        const map = {};
        (sRows || []).forEach((r) => {
          map[r.key] = r.value;
        });
        if (map.registration_open === "0") {
          return res.status(403).json({ error: "Регистрация временно закрыта" });
        }
        const needApprove = map.require_registration_approval !== "0";
        const regStatus = needApprove ? "pending" : "approved";

        const hash = await bcrypt.hash(password, 10);
        db.run(
          `INSERT INTO users (role, name, phone, email, password_hash, registration_status) VALUES (?, ?, ?, ?, ?, ?)`,
          [role, name.trim(), phone.trim(), email ? email.trim() : null, hash, regStatus],
          function onInsert(err) {
            if (err) {
              if (String(err.message).includes("UNIQUE")) {
                return res.status(409).json({ error: "Phone or email already used" });
              }
              return res.status(500).json({ error: "DB error" });
            }
            const userId = this.lastID;
            db.run(`INSERT INTO profiles (user_id) VALUES (?)`, [userId], (pErr) => {
              if (pErr) return res.status(500).json({ error: "Profile create error" });
              mergeProfileRow(userId, () => {
                sendRegistrationNotify(
                  {
                    id: userId,
                    role,
                    name: name.trim(),
                    phone: phone.trim(),
                    email: email ? email.trim() : null,
                  },
                  regStatus
                ).catch(() => {});
                if (regStatus === "pending") {
                  return res.json({
                    pendingReview: true,
                    message:
                      "Заявка принята. После одобрения администратором вы сможете войти в личный кабинет.",
                    user: { id: userId, role, name: name.trim() },
                  });
                }
                const token = signToken({ id: userId, role, name: name.trim() });
                return res.json({ token, user: { id: userId, role, name: name.trim() } });
              });
            });
          }
        );
      }
    );
  } catch (_) {
    return res.status(500).json({ error: "Unexpected error" });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }
  db.get(
    `SELECT * FROM users WHERE phone = ? OR email = ?`,
    [identifier.trim(), identifier.trim()],
    async (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(401).json({ error: "Invalid credentials" });

      const ok = await bcrypt.compare(password, row.password_hash);
      if (!ok) return res.status(401).json({ error: "Invalid credentials" });
      if (row.is_blocked) return res.status(403).json({ error: "Аккаунт заблокирован" });
      const rs = row.registration_status || "approved";
      if (rs === "pending") {
        return res.status(403).json({
          error:
            "Анкета на проверке. Вы получите доступ после одобрения администратора (см. письмо или зайдите позже).",
        });
      }
      if (rs === "rejected") {
        return res.status(403).json({ error: "Регистрация отклонена администратором." });
      }

      const token = signToken({ id: row.id, role: row.role, name: row.name });
      return res.json({
        token,
        user: { id: row.id, role: row.role, name: row.name, phone: row.phone, email: row.email }
      });
    }
  );
});

app.get("/api/me", auth, (req, res) => {
  db.get(
    `SELECT u.id, u.role, u.name, u.phone, u.email, u.registration_status, p.city, p.address, p.bio, p.notes, p.skills, p.availability_start, p.availability_end, p.on_duty
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     WHERE u.id = ?`,
    [req.user.sub],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(404).json({ error: "User not found" });
      return res.json({ user: row });
    }
  );
});

app.put("/api/me/profile", auth, (req, res) => {
  const {
    name, city, address, bio, notes, skills,
    availability_start, availability_end, on_duty
  } = req.body || {};

  db.serialize(() => {
    if (name && name.trim()) {
      db.run(`UPDATE users SET name = ? WHERE id = ?`, [name.trim(), req.user.sub]);
    }
    db.run(
      `UPDATE profiles
       SET city = ?, address = ?, bio = ?, notes = ?, skills = ?,
           availability_start = ?, availability_end = ?, on_duty = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`,
      [
        city || null,
        address || null,
        bio || null,
        notes || null,
        skills || null,
        availability_start || null,
        availability_end || null,
        on_duty ? 1 : 0,
        req.user.sub
      ],
      function onUpdate(err) {
        if (err) return res.status(500).json({ error: "Update error" });
        const preview = [
          name && name.trim() ? `имя: ${name.trim()}` : null,
          city != null && String(city).trim() ? `город: ${String(city).trim()}` : null,
          address != null && String(address).trim() ? `адрес: ${String(address).trim().slice(0, 120)}` : null,
          bio != null && String(bio).trim() ? `о себе: ${String(bio).trim().slice(0, 200)}` : null,
          notes != null && String(notes).trim() ? `заметки: ${String(notes).trim().slice(0, 200)}` : null,
          skills != null && String(skills).trim() ? `навыки: ${String(skills).trim().slice(0, 200)}` : null,
          availability_start || availability_end
            ? `доступность: ${availability_start || "?"}–${availability_end || "?"}`
            : null,
          typeof on_duty === "boolean" ? `на линии: ${on_duty ? "да" : "нет"}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        sendAdminNotifyLater(
          `[Тепло рядом] Обновлена анкета (${req.user.role === "helper" ? "помощница" : "клиентка"})`,
          `Пользователь: ${req.user.name || "—"} (id ${req.user.sub})
${preview || "(только служебные поля без текста в превью)"}`
        );
        return res.json({ ok: true });
      }
    );
  });
});

app.get("/api/orders", auth, (req, res) => {
  const where = req.user.role === "helper" ? "helper_id = ?" : "client_id = ?";
  db.all(
    `SELECT
       o.id, o.client_id, o.helper_id, o.status, o.order_date, o.tariff, o.services, o.important,
       o.reschedule_requested_date, o.reschedule_status, o.cancellation_fee,
       c.name AS client_name, h.name AS helper_name
     FROM orders o
     LEFT JOIN users c ON c.id = o.client_id
     LEFT JOIN users h ON h.id = o.helper_id
     WHERE ${where}
     ORDER BY o.id DESC`,
    [req.user.sub],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      return res.json({ orders: rows || [] });
    }
  );
});

app.post("/api/orders", auth, (req, res) => {
  if (req.user.role !== "client") {
    return res.status(403).json({ error: "Only clients can create orders" });
  }
  const { order_date, tariff, services, important } = req.body || {};
  if (!order_date || !tariff) {
    return res.status(400).json({ error: "Missing order_date or tariff" });
  }

  // Выбираем помощницу с учётом лимитов по тарифам на день
  const day = new Date(order_date);
  if (isNaN(day.getTime())) {
    return res.status(400).json({ error: "Bad order_date" });
  }
  const dayStr = day.toISOString().slice(0, 10); // YYYY-MM-DD

  db.all(
    `SELECT u.id AS helper_id
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     WHERE u.role = 'helper'
     ORDER BY COALESCE(p.on_duty, 0) DESC, u.id ASC`,
    [],
    (pickErr, helpers) => {
      if (pickErr) return res.status(500).json({ error: "DB error" });
      if (!helpers || !helpers.length) {
        return res.status(503).json({ error: "Нет доступных помощниц" });
      }

      const helpersIds = helpers.map((h) => h.helper_id);
      const placeholders = helpersIds.map(() => "?").join(",");

      db.all(
        `SELECT helper_id, tariff, COUNT(*) AS n
         FROM orders
         WHERE helper_id IN (${placeholders})
           AND status != 'cancelled'
           AND date(order_date) = date(?)
         GROUP BY helper_id, tariff`,
        [...helpersIds, dayStr],
        (capErr, rows) => {
          if (capErr) return res.status(500).json({ error: "DB error" });

          const capsByHelper = new Map();
          (rows || []).forEach((r) => {
            const hId = r.helper_id;
            const t = String(r.tariff || "");
            const entry = capsByHelper.get(hId) || { basic: 0, midLux: 0 };
            if (t.includes("basic")) entry.basic += r.n;
            else if (t.includes("medium") || t.includes("luxury")) entry.midLux += r.n;
            capsByHelper.set(hId, entry);
          });

          const isBasic = String(tariff).includes("basic");
          const isMidOrLux =
            String(tariff).includes("medium") || String(tariff).includes("luxury");

          let helperId = null;
          for (const h of helpers) {
            const hCaps = capsByHelper.get(h.helper_id) || { basic: 0, midLux: 0 };
            if (isMidOrLux && hCaps.midLux >= 1) continue;
            if (isBasic && hCaps.basic >= 2) continue;
            helperId = h.helper_id;
            break;
          }

          if (helperId == null) {
            return res.status(409).json({
              error:
                "На выбранный день нет свободных помощниц для этого тарифа. Попробуйте другую дату или тариф.",
            });
          }

          db.run(
            `INSERT INTO orders (client_id, helper_id, status, order_date, tariff, services, important)
             VALUES (?, ?, 'active', ?, ?, ?, ?)`,
            [
              req.user.sub,
              helperId,
              order_date,
              tariff,
              services || "",
              important || "",
            ],
            function onInsert(err) {
              if (err) return res.status(500).json({ error: "Create order error" });
              const oid = this.lastID;
              db.get(
                `SELECT name FROM users WHERE id = ?`,
                [req.user.sub],
                (gErr, crow) => {
                  const clientName =
                    crow && crow.name ? crow.name : `id ${req.user.sub}`;
                  sendAdminNotifyLater(
                    `[Тепло рядом] Новый заказ #${oid}`,
                    `Клиент: ${clientName} (id ${req.user.sub})
Номер заказа: ${oid}
Дата встречи: ${order_date}
Тариф: ${tariff}
Услуги: ${services || "—"}
Важное: ${important || "—"}
Помощница (id): ${helperId != null ? helperId : "не назначена"}`
                  );
                }
              );
              return res.json({ ok: true, order_id: oid });
            }
          );
        }
      );
    }
  );
});

app.patch("/api/orders/:id/important", auth, (req, res) => {
  const orderId = Number(req.params.id);
  const { important } = req.body || {};
  db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!order) return res.status(404).json({ error: "Order not found" });
    const canAccess =
      order.client_id === req.user.sub || order.helper_id === req.user.sub;
    if (!canAccess) return res.status(403).json({ error: "Access denied" });
    db.run(
      `UPDATE orders SET important = ? WHERE id = ?`,
      [important || "", orderId],
      (uErr) => {
        if (uErr) return res.status(500).json({ error: "Update error" });
        sendAdminNotifyLater(
          `[Тепло рядом] Важное по заказу #${orderId} обновлено`,
          `Пользователь id ${req.user.sub}
Новый текст блока «Важное»:
${String(important || "").slice(0, 1500)}${String(important || "").length > 1500 ? "\n…" : ""}`
        );
        return res.json({ ok: true });
      }
    );
  });
});

app.patch("/api/orders/:id/reschedule", auth, (req, res) => {
  const orderId = Number(req.params.id);
  const { new_date, comment } = req.body || {};
  if (!new_date) return res.status(400).json({ error: "Missing new_date" });

  db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!order) return res.status(404).json({ error: "Order not found" });
    const canAccess =
      order.client_id === req.user.sub || order.helper_id === req.user.sub;
    if (!canAccess) return res.status(403).json({ error: "Access denied" });

    const mergedImportant = [order.important, comment].filter(Boolean).join(" | ");
    db.run(
      `UPDATE orders
       SET reschedule_requested_date = ?, reschedule_status = 'pending', important = ?
       WHERE id = ?`,
      [new_date, mergedImportant, orderId],
      (uErr) => {
        if (uErr) return res.status(500).json({ error: "Reschedule update error" });
        db.get(
          `SELECT c.name AS cn, h.name AS hn FROM orders o
           LEFT JOIN users c ON c.id = o.client_id LEFT JOIN users h ON h.id = o.helper_id
           WHERE o.id = ?`,
          [orderId],
          (_, names) => {
            sendAdminNotifyLater(
              `[Тепло рядом] Перенос встречи по заказу #${orderId}`,
              `Запрошена новая дата: ${new_date}
Комментарий: ${comment || "—"}
Клиент: ${names && names.cn ? names.cn : "—"}
Помощница: ${names && names.hn ? names.hn : "—"}
Инициатор действия: пользователь id ${req.user.sub}`
            );
          }
        );
        return res.json({ ok: true, status: "pending" });
      }
    );
  });
});

app.patch("/api/orders/:id/cancel", auth, (req, res) => {
  const orderId = Number(req.params.id);
  const { reason } = req.body || {};
  db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!order) return res.status(404).json({ error: "Order not found" });

    const byClient = order.client_id === req.user.sub;
    const byHelper = order.helper_id === req.user.sub;
    if (!byClient && !byHelper) return res.status(403).json({ error: "Access denied" });

    if (byHelper && reason !== "illness") {
      return res.status(400).json({ error: "Helper can cancel only by illness" });
    }

    let fee = 0;
    if (byClient && order.order_date) {
      const start = new Date(order.order_date).getTime();
      const now = Date.now();
      const diffMs = start - now;
      const threeHours = 3 * 60 * 60 * 1000;
      const isSameDay =
        new Date(start).toDateString() === new Date(now).toDateString();
      if (isSameDay && diffMs < threeHours) {
        fee = 1;
      }
    }

    db.run(
      `UPDATE orders SET status = 'cancelled', cancellation_fee = ? WHERE id = ?`,
      [fee, orderId],
      (uErr) => {
        if (uErr) return res.status(500).json({ error: "Cancel error" });
        db.get(
          `SELECT c.name AS cn, h.name AS hn FROM orders o
           LEFT JOIN users c ON c.id = o.client_id LEFT JOIN users h ON h.id = o.helper_id
           WHERE o.id = ?`,
          [orderId],
          (_, names) => {
            const who = byClient ? "клиентка" : "помощница";
            sendAdminNotifyLater(
              `[Тепло рядом] Отмена заказа #${orderId}`,
              `Отменил(а): ${who} (id ${req.user.sub})
Комиссия за отмену: ${fee ? "да (по правилам)" : "нет"}
Причина (помощница): ${reason || "—"}
Клиент: ${names && names.cn ? names.cn : "—"}
Помощница: ${names && names.hn ? names.hn : "—"}`
            );
          }
        );
        return res.json({ ok: true, cancellation_fee: fee });
      }
    );
  });
});

/* ── Chat (клиент ↔ помощница; сообщения от админа — с меткой from_staff) ── */
function chatThreadParticipant(threadId, userId, cb) {
  db.get(
    `SELECT user_low, user_high FROM chat_threads WHERE id = ?`,
    [threadId],
    (e, row) => {
      if (e || !row) return cb(false);
      cb(row.user_low === userId || row.user_high === userId);
    }
  );
}

app.post("/api/chat/open", auth, (req, res) => {
  const peerId = Number((req.body || {}).peer_id);
  if (!Number.isFinite(peerId) || peerId === req.user.sub) {
    return res.status(400).json({ error: "Укажите корректный peer_id собеседника" });
  }
  db.get(
    `SELECT id, registration_status FROM users WHERE id = ?`,
    [peerId],
    (e, peer) => {
      if (e) return res.status(500).json({ error: "DB error" });
      if (!peer) return res.status(404).json({ error: "Пользователь не найден" });
      if ((peer.registration_status || "approved") !== "approved") {
        return res.status(403).json({ error: "Собеседник пока недоступен для переписки" });
      }
      const low = Math.min(peerId, req.user.sub);
      const high = Math.max(peerId, req.user.sub);
      db.get(
        `SELECT id FROM chat_threads WHERE user_low = ? AND user_high = ?`,
        [low, high],
        (e2, row) => {
          if (e2) return res.status(500).json({ error: "DB error" });
          if (row) return res.json({ thread_id: row.id });
          db.run(
            `INSERT INTO chat_threads (user_low, user_high) VALUES (?, ?)`,
            [low, high],
            function (insErr) {
              if (insErr) return res.status(500).json({ error: "DB error" });
              return res.json({ thread_id: this.lastID });
            }
          );
        }
      );
    }
  );
});

app.get("/api/chat/threads", auth, (req, res) => {
  const uid = req.user.sub;
  db.all(
    `SELECT t.id, t.user_low, t.user_high, t.updated_at,
       (SELECT body FROM chat_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_preview
     FROM chat_threads t
     WHERE t.user_low = ? OR t.user_high = ?
     ORDER BY datetime(t.updated_at) DESC, t.id DESC`,
    [uid, uid],
    (err, threads) => {
      if (err) return res.status(500).json({ error: "DB error" });
      const list = threads || [];
      if (!list.length) return res.json({ threads: [] });
      const idSet = new Set();
      list.forEach((t) => {
        idSet.add(t.user_low);
        idSet.add(t.user_high);
      });
      const ids = [...idSet];
      const ph = ids.map(() => "?").join(",");
      db.all(
        `SELECT id, name, role, phone FROM users WHERE id IN (${ph})`,
        ids,
        (e2, users) => {
          if (e2) return res.status(500).json({ error: "DB error" });
          const byId = {};
          (users || []).forEach((u) => {
            byId[u.id] = u;
          });
          const enriched = list.map((t) => {
            const peerId = t.user_low === uid ? t.user_high : t.user_low;
            const u = byId[peerId] || {};
            return {
              id: t.id,
              peer_id: peerId,
              peer_name: u.name || "—",
              peer_role: u.role,
              peer_phone: u.phone,
              last_preview: t.last_preview || "",
              updated_at: t.updated_at,
            };
          });
          return res.json({ threads: enriched });
        }
      );
    }
  );
});

app.get("/api/chat/threads/:id/messages", auth, (req, res) => {
  const threadId = Number(req.params.id);
  if (!Number.isFinite(threadId)) return res.status(400).json({ error: "Bad id" });
  chatThreadParticipant(threadId, req.user.sub, (ok) => {
    if (!ok) return res.status(403).json({ error: "Нет доступа к переписке" });
    db.all(
      `SELECT m.id, m.sender_id, m.body, m.from_staff, m.created_at,
        COALESCE(u.name, '') AS sender_name
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.sender_id AND m.from_staff = 0
       WHERE m.thread_id = ?
       ORDER BY m.id ASC`,
      [threadId],
      (e, rows) => {
        if (e) return res.status(500).json({ error: "DB error" });
        const messages = (rows || []).map((r) => ({
          id: r.id,
          body: r.body,
          created_at: r.created_at,
          from_staff: !!r.from_staff,
          sender_name: r.from_staff ? "Администратор" : r.sender_name || "Участник",
          is_mine: !r.from_staff && r.sender_id === req.user.sub,
        }));
        return res.json({ messages });
      }
    );
  });
});

app.post("/api/chat/threads/:id/messages", auth, (req, res) => {
  const threadId = Number(req.params.id);
  const body = (req.body || {}).body;
  if (!Number.isFinite(threadId) || !body || !String(body).trim()) {
    return res.status(400).json({ error: "Укажите текст сообщения" });
  }
  chatThreadParticipant(threadId, req.user.sub, (ok) => {
    if (!ok) return res.status(403).json({ error: "Нет доступа к переписке" });
    const trimmed = String(body).trim();
    db.run(
      `INSERT INTO chat_messages (thread_id, sender_id, body, from_staff) VALUES (?, ?, ?, 0)`,
      [threadId, req.user.sub, trimmed],
      function (insErr) {
        if (insErr) return res.status(500).json({ error: "DB error" });
        db.run(`UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?`, [threadId]);
        if (MAIL_NOTIFY_CHAT) {
          db.get(
            `SELECT u1.name AS n1, u2.name AS n2, u1.id AS id1, u2.id AS id2
             FROM chat_threads t
             JOIN users u1 ON u1.id = t.user_low
             JOIN users u2 ON u2.id = t.user_high
             WHERE t.id = ?`,
            [threadId],
            (_, trow) => {
              db.get(`SELECT name FROM users WHERE id = ?`, [req.user.sub], (___, srow) => {
                const fromName = srow && srow.name ? srow.name : `id ${req.user.sub}`;
                const pair =
                  trow && trow.n1 && trow.n2
                    ? `${trow.n1} (id ${trow.id1}) ↔ ${trow.n2} (id ${trow.id2})`
                    : `thread ${threadId}`;
                sendAdminNotifyLater(
                  `[Тепло рядом] Сообщение в чате #${threadId}`,
                  `Диалог: ${pair}
От: ${fromName}
Текст:
${trimmed.slice(0, 2000)}${trimmed.length > 2000 ? "\n…" : ""}`
                );
              });
            }
          );
        }
        return res.json({ ok: true, id: this.lastID });
      }
    );
  });
});

/* ── Admin API ── */
app.post("/api/admin/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Укажите email и пароль" });
  }
  const em = String(email).trim().toLowerCase();
  db.get(`SELECT * FROM admins WHERE lower(email) = ?`, [em], async (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row) return res.status(401).json({ error: "Неверный email или пароль" });

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: "Неверный email или пароль" });

    const token = signAdminToken({ id: row.id, email: row.email, name: row.name });
    return res.json({
      token,
      admin: { id: row.id, email: row.email, name: row.name || "Админ" },
    });
  });
});

app.get("/api/admin/me", adminAuth, (req, res) => {
  return res.json({ admin: { id: req.admin.sub, email: req.admin.email, name: req.admin.name } });
});

app.get("/api/admin/stats", adminAuth, (_, res) => {
  db.serialize(() => {
    db.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'client'`, [], (e1, c) => {
      if (e1) return res.status(500).json({ error: "DB error" });
      db.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'helper'`, [], (e2, h) => {
        if (e2) return res.status(500).json({ error: "DB error" });
        db.get(`SELECT COUNT(*) AS n FROM orders`, [], (e3, o) => {
          if (e3) return res.status(500).json({ error: "DB error" });
          db.get(`SELECT COUNT(*) AS n FROM users WHERE is_blocked = 1`, [], (e4, b) => {
            if (e4) return res.status(500).json({ error: "DB error" });
            db.get(
              `SELECT COUNT(*) AS n FROM users WHERE registration_status = 'pending'`,
              [],
              (e5, p) => {
                if (e5) return res.status(500).json({ error: "DB error" });
                return res.json({
                  clients: c.n,
                  helpers: h.n,
                  orders: o.n,
                  blocked: b.n,
                  pending_registrations: p.n,
                });
              }
            );
          });
        });
      });
    });
  });
});

app.get("/api/admin/profiles", adminAuth, (_, res) => {
  db.all(
    `SELECT
       u.id AS user_id,
       u.role,
       u.name,
       u.phone,
       u.email,
       u.created_at,
       u.is_blocked,
       u.registration_status,
       p.city,
       p.address,
       p.bio,
       p.notes,
       p.skills,
       p.availability_start,
       p.availability_end,
       p.on_duty,
       p.updated_at AS profile_updated_at
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     ORDER BY u.id DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      return res.json({ profiles: rows || [] });
    }
  );
});

app.get("/api/admin/orders", adminAuth, (_, res) => {
  db.all(
    `SELECT
       o.id,
       o.status,
       o.order_date,
       o.tariff,
       o.services,
       o.important,
       o.reschedule_requested_date,
       o.reschedule_status,
       o.cancellation_fee,
       o.created_at,
       c.id AS client_id,
       c.name AS client_name,
       c.phone AS client_phone,
       h.id AS helper_id,
       h.name AS helper_name
     FROM orders o
     LEFT JOIN users c ON c.id = o.client_id
     LEFT JOIN users h ON h.id = o.helper_id
     ORDER BY o.id DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      return res.json({ orders: rows || [] });
    }
  );
});

app.patch("/api/admin/users/:id", adminAuth, (req, res) => {
  const userId = Number(req.params.id);
  const { is_blocked, registration_status } = req.body || {};
  if (!Number.isFinite(userId)) return res.status(400).json({ error: "Bad id" });

  const sets = [];
  const vals = [];
  if (typeof is_blocked === "boolean") {
    sets.push("is_blocked = ?");
    vals.push(is_blocked ? 1 : 0);
  }
  if (registration_status !== undefined && registration_status !== null) {
    const rs = String(registration_status).toLowerCase();
    if (!["pending", "approved", "rejected"].includes(rs)) {
      return res.status(400).json({ error: "registration_status: pending | approved | rejected" });
    }
    sets.push("registration_status = ?");
    vals.push(rs);
  }
  if (!sets.length) {
    return res.status(400).json({ error: "Передайте is_blocked и/или registration_status" });
  }
  vals.push(userId);
  db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, vals, function (uErr) {
    if (uErr) return res.status(500).json({ error: "Update error" });
    if (this.changes === 0) return res.status(404).json({ error: "User not found" });
    const lines = [];
    if (registration_status !== undefined && registration_status !== null) {
      lines.push(`Статус регистрации: ${String(registration_status).toLowerCase()}`);
    }
    if (typeof is_blocked === "boolean") {
      lines.push(is_blocked ? "Аккаунт заблокирован" : "Блокировка снята");
    }
    if (lines.length) {
      db.get(`SELECT name, phone, email, role FROM users WHERE id = ?`, [userId], (_, u) => {
        sendAdminNotifyLater(
          `[Тепло рядом] Действие админа: пользователь #${userId}`,
          `${lines.join("\n")}
Пользователь: ${u && u.name ? u.name : "—"} (${u && u.role === "helper" ? "помощница" : "клиентка"})
Телефон: ${u && u.phone ? u.phone : "—"}
Email: ${u && u.email ? u.email : "—"}`
        );
      });
    }
    return res.json({ ok: true });
  });
});

app.patch("/api/admin/orders/:id", adminAuth, (req, res) => {
  const orderId = Number(req.params.id);
  const { status, reschedule_status } = req.body || {};
  if (!Number.isFinite(orderId)) return res.status(400).json({ error: "Bad id" });

  const updates = [];
  const vals = [];
  if (status && typeof status === "string") {
    updates.push("status = ?");
    vals.push(status);
  }
  if (reschedule_status !== undefined && reschedule_status !== null) {
    updates.push("reschedule_status = ?");
    vals.push(String(reschedule_status));
  }
  if (!updates.length) {
    return res.status(400).json({ error: "Укажите status и/или reschedule_status" });
  }
  vals.push(orderId);
  db.run(`UPDATE orders SET ${updates.join(", ")} WHERE id = ?`, vals, function (uErr) {
    if (uErr) return res.status(500).json({ error: "Update error" });
    if (this.changes === 0) return res.status(404).json({ error: "Order not found" });
    const parts = [];
    if (status && typeof status === "string") parts.push(`status → ${status}`);
    if (reschedule_status !== undefined && reschedule_status !== null) {
      parts.push(`reschedule_status → ${String(reschedule_status)}`);
    }
    if (parts.length) {
      db.get(
        `SELECT o.id, o.order_date, c.name AS cn, h.name AS hn FROM orders o
         LEFT JOIN users c ON c.id = o.client_id LEFT JOIN users h ON h.id = o.helper_id
         WHERE o.id = ?`,
        [orderId],
        (_, orow) => {
          sendAdminNotifyLater(
            `[Тепло рядом] Заказ #${orderId} изменён в админке`,
            `${parts.join("\n")}
Клиент: ${orow && orow.cn ? orow.cn : "—"}
Помощница: ${orow && orow.hn ? orow.hn : "—"}
Дата встречи: ${orow && orow.order_date ? orow.order_date : "—"}`
          );
        }
      );
    }
    return res.json({ ok: true });
  });
});

app.get("/api/admin/settings", adminAuth, (_, res) => {
  db.all(`SELECT key, value FROM site_settings ORDER BY key`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    const map = {};
    (rows || []).forEach((r) => {
      map[r.key] = r.value;
    });
    return res.json({ settings: map });
  });
});

app.put("/api/admin/settings", adminAuth, (req, res) => {
  const { settings } = req.body || {};
  if (!settings || typeof settings !== "object") {
    return res.status(400).json({ error: "Передайте объект settings { ключ: значение }" });
  }
  const allowed = ["registration_open", "maintenance_mode", "require_registration_approval"];
  const entries = Object.entries(settings).filter(([k]) => allowed.includes(k));
  if (!entries.length) return res.status(400).json({ error: "Нет допустимых ключей" });

  let pending = entries.length;
  let hadErr = null;
  entries.forEach(([k, v]) => {
    db.run(`INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)`, [k, String(v)], (e) => {
      if (e) hadErr = e;
      pending -= 1;
      if (pending === 0) {
        if (hadErr) return res.status(500).json({ error: "DB error" });
        return res.json({ ok: true });
      }
    });
  });
});

app.get("/api/admin/chat/threads", adminAuth, (_, res) => {
  db.all(
    `SELECT t.id, t.user_low, t.user_high, t.updated_at,
       u1.name AS name_low, u2.name AS name_high,
       u1.phone AS phone_low, u2.phone AS phone_high,
       (SELECT body FROM chat_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_preview
     FROM chat_threads t
     JOIN users u1 ON u1.id = t.user_low
     JOIN users u2 ON u2.id = t.user_high
     ORDER BY datetime(t.updated_at) DESC, t.id DESC`,
    [],
    (e, rows) => {
      if (e) return res.status(500).json({ error: "DB error" });
      return res.json({ threads: rows || [] });
    }
  );
});

app.get("/api/admin/chat/threads/:id/messages", adminAuth, (req, res) => {
  const threadId = Number(req.params.id);
  if (!Number.isFinite(threadId)) return res.status(400).json({ error: "Bad id" });
  db.all(
    `SELECT m.id, m.sender_id, m.body, m.from_staff, m.created_at,
       CASE WHEN m.from_staff = 1 THEN 'Администратор' ELSE COALESCE(u.name, '') END AS sender_name
     FROM chat_messages m
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.thread_id = ?
     ORDER BY m.id ASC`,
    [threadId],
    (e, rows) => {
      if (e) return res.status(500).json({ error: "DB error" });
      return res.json({ messages: rows || [] });
    }
  );
});

app.post("/api/admin/chat/threads/:id/messages", adminAuth, (req, res) => {
  const threadId = Number(req.params.id);
  const body = (req.body || {}).body;
  if (!Number.isFinite(threadId) || !body || !String(body).trim()) {
    return res.status(400).json({ error: "Укажите текст сообщения" });
  }
  db.run(
    `INSERT INTO chat_messages (thread_id, sender_id, body, from_staff) VALUES (?, NULL, ?, 1)`,
    [threadId, String(body).trim()],
    function (insErr) {
      if (insErr) return res.status(500).json({ error: "DB error" });
      db.run(`UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?`, [threadId]);
      return res.json({ ok: true, id: this.lastID });
    }
  );
});

/* ── Certificates API (подарочные сертификаты) ── */
app.post("/api/certificates", (req, res) => {
  try {
    const {
      cert_name,
      amount,
      emoji,
      from_name,
      to_name,
      message,
      delivery,
      email,
      wishlist_name,
      wishlist_link,
    } = req.body || {};
    const price = Number(amount);
    if (!cert_name || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: "Некорректные данные сертификата" });
    }
    db.run(
      `INSERT INTO certificates
       (cert_name, amount, emoji, from_name, to_name, message, delivery, email, wishlist_name, wishlist_link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(cert_name).trim(),
        Math.round(price),
        emoji != null ? String(emoji).trim() || null : null,
        from_name != null ? String(from_name).trim() || null : null,
        to_name != null ? String(to_name).trim() || null : null,
        message != null ? String(message).trim() || null : null,
        delivery != null ? String(delivery).trim() || null : null,
        email != null ? String(email).trim() || null : null,
        wishlist_name != null ? String(wishlist_name).trim() || null : null,
        wishlist_link != null ? String(wishlist_link).trim() || null : null,
      ],
      function (err) {
        if (err) {
          console.error("[cert] insert:", err.message);
          return res.status(500).json({ error: "DB error" });
        }
        const id = this.lastID;
        sendAdminNotifyLater(
          "[Тепло рядом] Новый подарочный сертификат #" + id,
          `Название: ${String(cert_name).trim()}
Сумма: ${Math.round(price)} ₽
От кого: ${from_name || "—"}
Кому: ${to_name || "—"}
Способ вручения: ${delivery || "—"}
Email получателя: ${email || "—"}
Вишлист: ${wishlist_name || "—"}${wishlist_link ? " (" + wishlist_link + ")" : ""}`
        );
        return res.json({ ok: true, certificate_id: id });
      }
    );
  } catch (_) {
    return res.status(500).json({ error: "Unexpected error" });
  }
});

/* Статика после всех /api/* — иначе в редких конфигурациях запросы к API могут отдавать 404 */
app.use(express.static(__dirname));

app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* listen вызывается из колбэка после сидирования админа (см. db.serialize выше) */

