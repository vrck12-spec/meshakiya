const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();
app.set('trust proxy', 1); // Railway מעביר דרך proxy — כדי ש-req.ip יהיה כתובת הלקוח האמיתית
const PORT = process.env.PORT || 3000;

// ===== לוח השעות =====
// השעות עברו ממשתנים קבועים כאן למנוע הגדרות (ראו "מנוע השעות" למטה),
// הנשמר במסד הנתונים (טבלת settings) וניתן לעריכה על-ידי מנהלים דרך /api/admin/schedule.
const DEFAULT_CAPACITY = 30;

// ברירת המחדל בהפעלה ראשונה — משחזרת בדיוק את המצב שהיה קבוע בקוד לפני המעבר למנוע ההגדרות:
// שבוע רגיל א׳,ג׳,ד׳,ה׳ אחה"צ 16:00–19:00 בשני סבבים; ב׳ מילואים בלבד 16:00–19:00 סבב יחיד;
// מ-28.09.2026 נוספים לכל הימים הפעילים סבבי בוקר 09:00–14:00 (מורות חיילות), הפסקה 14:00–16:00.
// גרסת מבנה ההגדרות. עולה כשמתווסף שדה חדש שרשומה קיימת במסד הנתונים לא כוללת —
// migrateScheduleSettings() למטה משלימה אותו אוטומטית ברשומות ישנות, בלי לגעת בשאר הנתונים.
const SETTINGS_VERSION = 2;

function buildDefaultScheduleSettings() {
  const afternoon = [
    { id: 'afternoon1', label: '16:00–17:30', display: 'סבב א׳', period: 'אחה"צ' },
    { id: 'afternoon2', label: '17:30–19:00', display: 'סבב ב׳', period: 'אחה"צ' },
  ];
  const reserveOnly = [
    { id: 'reserve', label: '16:00–19:00', display: 'מילואים בלבד — סבב יחיד', reserveOnly: true },
  ];
  return {
    version: SETTINGS_VERSION,
    capacityDefault: DEFAULT_CAPACITY,
    // תבנית שבועית: מפתח = getDay() (0=א׳...4=ה׳). ו׳(5) ו-ש׳(6) תמיד סגורים ואינם חלק מהתבנית.
    weeklyTemplate: {
      0: afternoon.map(s => ({ ...s })),
      1: reserveOnly.map(s => ({ ...s })),
      2: afternoon.map(s => ({ ...s })),
      3: afternoon.map(s => ({ ...s })),
      4: afternoon.map(s => ({ ...s })),
    },
    // חריגים: כל חריג חל על טווח תאריכים (וימים בשבוע, אופציונלי) ומוסיף/מחליף/סוגר סבבים
    exceptions: [
      {
        id: 'morning-2026',
        startDate: '2026-09-28',
        endDate: null, // ללא תאריך סיום — כמו בקוד הקודם
        days: [0, 1, 2, 3, 4],
        type: 'add', // מוסיף סבבים לפני מה שכבר קיים באותו יום (בוקר לפני אחה"צ/מילואים)
        slots: [
          { id: 'morning1', label: '09:00–11:30', display: 'בוקר א׳', period: 'בוקר' },
          { id: 'morning2', label: '11:30–14:00', display: 'בוקר ב׳', period: 'בוקר' },
        ],
        note: 'סבבי בוקר (מורות חיילות), הפסקה 14:00–16:00',
      },
    ],
    banner: {
      enabled: true,
      html:
        '🍂 <strong>חדש! החל מיום ב׳ 28.09 המשחקייה העירונית פתוחה גם בבוקר!</strong><br>\n' +
        '    בימים ב׳–ה׳ (28.09–01.10) המשחקייה תפעל בבוקר בין השעות <strong>09:00–14:00</strong> (בשני סבבים), הפסקה בין 14:00–16:00, ואחה"צ <strong>16:00–19:00</strong> כרגיל. הכניסה בהרשמה מראש בלבד, דרך הטופס שלמטה.\n' +
        '    <div class="notice-contacts">\n' +
        '      <div class="notice-contacts-title">📞 לבירורים ושאלות ניתן לפנות ל:</div>\n' +
        '      <div class="notice-contacts-list">\n' +
        '        <a class="notice-contact" href="tel:0532298181"><span class="name">שלומי</span><span class="phone" dir="ltr">053-2298181</span></a>\n' +
        '        <a class="notice-contact" href="tel:0508675041"><span class="name">מזי</span><span class="phone" dir="ltr">050-8675041</span></a>\n' +
        '      </div>\n' +
        '    </div>',
    },
    updatedAt: null,
    updatedBy: null,
  };
}

// ===== הגדרת שולח מייל =====
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ===== הרשאות ניהול =====
// המנהלים והסיסמאות מוגדרים רק במשתני סביבה ב-Railway (לא בקוד):
// MANAGER1_NAME, MANAGER1_PASSWORD, MANAGER2_NAME, MANAGER2_PASSWORD, AUTH_SECRET
const IS_PRODUCTION = !!process.env.RAILWAY_ENVIRONMENT;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 יום

function getManagers() {
  const managers = [1, 2]
    .map(n => ({ name: process.env[`MANAGER${n}_NAME`], password: process.env[`MANAGER${n}_PASSWORD`] }))
    .filter(m => m.name && m.password);
  // מצב פיתוח מקומי בלבד — סיסמת פיתוח; בשרת (Railway) אין ברירת מחדל והניהול חסום עד שיוגדרו משתנים
  if (!managers.length && !IS_PRODUCTION) return [{ name: 'מפתח מקומי', password: '1234' }];
  return managers;
}

const AUTH_SECRET = process.env.AUTH_SECRET || (IS_PRODUCTION ? null : crypto.randomBytes(32).toString('hex'));

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function safeEqual(a, b) { return crypto.timingSafeEqual(sha256(a), sha256(b)); }

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// טביעת אצבע קצרה של הסיסמה הנוכחית, נשמרת בתוך הטוקן בזמן ההנפקה. כשמנהל מחליף סיסמה
// (למשל אחרי דליפה) הטביעה משתנה ולכן טוקנים ישנים נפסלים מיד ב-verifyToken, בלי צורך ברשימת ביטול.
function managerFingerprint(password) {
  return sha256(password).toString('hex').slice(0, 16);
}

function verifyToken(token) {
  if (!AUTH_SECRET || !token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    // מנהל שהוסר ממשתני הסביבה מאבד גישה מיד, וכך גם מנהל שהסיסמה שלו הוחלפה
    const manager = getManagers().find(m => m.name === payload.name);
    if (!manager || payload.pv !== managerFingerprint(manager.password)) return null;
    return payload;
  } catch { return null; }
}

function requireManager(req, res, next) {
  if (!AUTH_SECRET || !getManagers().length)
    return res.status(503).json({ error: 'הניהול עדיין לא הוגדר בשרת' });
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'נדרשת כניסה' });
  req.user = user;
  next();
}

// הגבלת ניסיונות כניסה: 5 שגויים מאותה כתובת → חסימה ל-15 דקות
const LOGIN_MAX_FAILS = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const loginFails = new Map(); // ip -> { count, until }

// הגבלת קצב על הרשמה ציבורית: מקסימום REGISTER_MAX בקשות מאותה כתובת בתוך חלון הזמן
const REGISTER_MAX = 8;
const REGISTER_WINDOW_MS = 10 * 60 * 1000; // 10 דקות
const registerAttempts = new Map(); // ip -> { count, windowStart }

function checkRegisterRateLimit(ip) {
  const now = Date.now();
  const rec = registerAttempts.get(ip);
  if (!rec || now - rec.windowStart > REGISTER_WINDOW_MS) {
    registerAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  rec.count++;
  return rec.count <= REGISTER_MAX;
}

function isValidIsraeliPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return /^0\d{8,9}$/.test(digits) || /^972\d{8,9}$/.test(digits);
}

// מנעול בזיכרון פר תאריך+סבב — מכריח את "בדיקת מקום פנוי" ו"שמירה" לרוץ ברצף לאותו סבב,
// כדי שבקשות מקבילות לא יעברו את בדיקת המכסה יחד ויחרגו ממנה (ראו server.js: /api/register)
const slotLocks = new Map();
function withSlotLock(date, slot, fn) {
  const key = date + '|' + slot;
  const tail = (slotLocks.get(key) || Promise.resolve()).catch(() => {});
  const run = tail.then(fn);
  slotLocks.set(key, run.catch(() => {}));
  return run;
}

// מזהה הרשמה: זמן במילישניות * 1000 + מספר אקראי (0-999), נשאר בטוח בטווח Number
// וכמעט בלתי אפשרי שיתנגש גם כששתי הרשמות נופלות באותה מילישנייה בדיוק
function generateRegistrationId() {
  return Date.now() * 1000 + crypto.randomInt(1000);
}

// ===== מסד נתונים: PostgreSQL בענן או JSON מקומי =====
let db = null;

async function initDB() {
  if (!process.env.DATABASE_URL) return; // מצב מקומי — משתמש ב-JSON
  const { Pool } = require('pg');
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await db.query(`
    CREATE TABLE IF NOT EXISTS registrations (
      id BIGINT PRIMARY KEY,
      date TEXT NOT NULL,
      slot TEXT NOT NULL,
      parent_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      children JSONB NOT NULL,
      registered_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // הוספת עמודות לטבלה קיימת (אם עדיין לא קיימות)
  await db.query(`
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS email TEXT
  `);
  await db.query(`
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS allergies TEXT
  `);
  // שומר את תווית השעה של הסבב בזמן ההרשמה, כך שרישומי עבר מוצגים תמיד עם השעה שהייתה אז
  // גם אם השעות ישונו בעתיד דרך מסך הניהול. NULL ברשומות ישנות מלפני העמודה — תקין.
  await db.query(`
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS slot_label TEXT
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✅ מסד נתונים PostgreSQL מחובר');
}

// ===== קריאה/כתיבה (JSON מקומי — לפיתוח בלבד) =====
const DATA_FILE = path.join(__dirname, 'registrations.json');
function readJSON() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function writeJSON(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ===== פונקציות נתונים =====
async function getSlotRegistrations(date, slot) {
  if (db) {
    const res = await db.query(
      'SELECT id, parent_name, phone, email, children, allergies, slot_label, registered_at FROM registrations WHERE date=$1 AND slot=$2 ORDER BY id',
      [date, slot]
    );
    return res.rows.map(r => ({
      id: Number(r.id),
      parentName: r.parent_name,
      phone: r.phone,
      email: r.email,
      children: r.children,
      allergies: r.allergies,
      slotLabel: r.slot_label,
      registeredAt: r.registered_at
    }));
  }
  const data = readJSON();
  return data[date]?.[slot] || [];
}

async function addRegistration(date, slot, entry) {
  if (db) {
    await db.query(
      'INSERT INTO registrations (id, date, slot, parent_name, phone, email, children, allergies, slot_label, registered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [entry.id, date, slot, entry.parentName, entry.phone, entry.email || null, JSON.stringify(entry.children), entry.allergies || null, entry.slotLabel || null, entry.registeredAt]
    );
    return;
  }
  const data = readJSON();
  if (!data[date]) data[date] = {};
  if (!data[date][slot]) data[date][slot] = [];
  data[date][slot].push(entry);
  writeJSON(data);
}

async function getAllData() {
  if (db) {
    const res = await db.query('SELECT * FROM registrations ORDER BY date, slot, id');
    const result = {};
    res.rows.forEach(r => {
      if (!result[r.date]) result[r.date] = {};
      if (!result[r.date][r.slot]) result[r.date][r.slot] = [];
      result[r.date][r.slot].push({
        id: Number(r.id),
        parentName: r.parent_name,
        phone: r.phone,
        email: r.email,
        children: r.children,
        allergies: r.allergies,
        slotLabel: r.slot_label,
        registeredAt: r.registered_at
      });
    });
    return result;
  }
  return readJSON();
}

// ===== מנוע השעות =====
// ההגדרות נטענות פעם אחת לזיכרון (מהיר, בלי query על כל בקשה) ונשמרות מחדש בכל עריכה.
let scheduleSettings = null;
const SETTINGS_FILE = path.join(__dirname, 'schedule-settings.json');
const SETTINGS_KEY = 'schedule';

// משלימה שדות חדשים שנוספו למבנה ההגדרות מאז שרשומה זו נשמרה, בלי לגעת בשאר הנתונים (עריכות המנהלים).
// מריצה רק פעם אחת לכל גרסה (version), ולא דורסת ערך קיים אם כבר הוגדר.
function migrateScheduleSettings(settings) {
  let changed = false;
  const version = settings.version || 1;
  if (version < 2) {
    Object.values(settings.weeklyTemplate || {}).forEach(dayArr =>
      (dayArr || []).forEach(s => { if (!s.reserveOnly && s.period === undefined && s.id?.startsWith('afternoon')) { s.period = 'אחה"צ'; changed = true; } })
    );
    (settings.exceptions || []).forEach(ex =>
      (ex.slots || []).forEach(s => { if (s.period === undefined && s.id?.startsWith('morning')) { s.period = 'בוקר'; changed = true; } })
    );
  }
  if (version !== SETTINGS_VERSION) { settings.version = SETTINGS_VERSION; changed = true; }
  return changed;
}

// שמירה "שקטה" של תיקון מיגרציה בלבד — לא נוגעת ב-updatedAt/updatedBy (שמייצגים עריכה אנושית אחרונה)
async function persistScheduleSettings(settings) {
  if (db) {
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
      [SETTINGS_KEY, settings]
    );
  } else {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  }
}

async function loadScheduleSettings() {
  if (db) {
    const res = await db.query('SELECT value FROM settings WHERE key=$1', [SETTINGS_KEY]);
    if (res.rows.length) { scheduleSettings = res.rows[0].value; }
    else {
      scheduleSettings = buildDefaultScheduleSettings();
      await db.query('INSERT INTO settings (key, value) VALUES ($1,$2)', [SETTINGS_KEY, scheduleSettings]);
    }
  } else {
    try { scheduleSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
    catch { scheduleSettings = buildDefaultScheduleSettings(); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(scheduleSettings, null, 2), 'utf8'); }
  }
  if (migrateScheduleSettings(scheduleSettings)) await persistScheduleSettings(scheduleSettings);
}

async function saveScheduleSettings(newSettings, managerName) {
  newSettings.updatedAt = new Date().toISOString();
  newSettings.updatedBy = managerName || null;
  if (db) {
    await db.query(
      'INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
      [SETTINGS_KEY, newSettings]
    );
  } else {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2), 'utf8');
  }
  scheduleSettings = newSettings;
}

// מחשב את הסבבים לתאריך נתון, לפי תבנית שבועית + חריגים (settings ניתן לפרמטר לצורך השוואת גרסה ישנה/חדשה בבדיקות)
function computeSlotsForDate(dateStr, settings = scheduleSettings) {
  const day = new Date(dateStr + 'T12:00:00').getDay();
  if (day === 5 || day === 6) return []; // ו׳ ו-ש׳ תמיד סגורים, לא חלק מהתבנית

  let slots = (settings.weeklyTemplate[day] || []).map(s => ({ ...s }));

  for (const ex of settings.exceptions || []) {
    if (dateStr < ex.startDate) continue;
    if (ex.endDate && dateStr > ex.endDate) continue;
    if (ex.days && !ex.days.includes(day)) continue;
    if (ex.type === 'closed') slots = [];
    else if (ex.type === 'replace') slots = (ex.slots || []).map(s => ({ ...s }));
    else if (ex.type === 'add') slots = [...(ex.slots || []).map(s => ({ ...s })), ...slots];
  }
  return slots;
}

function dateToStr(d) { return d.toISOString().split('T')[0]; }

// גבולות השבוע (א׳-ה׳) שמכיל תאריך נתון
function getWeekBounds(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const sunday = new Date(d); sunday.setDate(d.getDate() - day);
  const thursday = new Date(sunday); thursday.setDate(sunday.getDate() + 4);
  return { sunday: dateToStr(sunday), thursday: dateToStr(thursday) };
}

// טווח הרישום המתגלגל: תמיד עד סוף השבוע הנוכחי (א׳-ה׳); מיום ה׳ בשעה 19:45 נפתח גם השבוע הבא
function getRegistrationEndDate(now) {
  const { thursday } = getWeekBounds(now.dateStr);
  const pastCutoff = now.dateStr > thursday || (now.dateStr === thursday && now.minutes >= 19 * 60 + 45);
  if (!pastCutoff) return thursday;
  const nextSunday = new Date(thursday + 'T12:00:00'); nextSunday.setDate(nextSunday.getDate() + 3);
  return getWeekBounds(dateToStr(nextSunday)).thursday;
}

function countPeople(regs) {
  return regs.reduce((sum, r) => sum + 1 + (r.children || []).length, 0);
}

function hebrewDay(dateStr) {
  const days = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  return 'יום ' + days[new Date(dateStr + 'T12:00:00').getDay()];
}

function hebrewDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

// ===== עזר: זמן נוכחי לפי שעון ישראל (בלי תלות בשעון השרת) =====
function nowInIsrael() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jerusalem',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

// שולף את שעת הסיום (בדקות) מתוך label בפורמט "HH:MM–HH:MM"; מחזיר null לחלונות פתוחים ("...ואילך")
function slotEndMinutes(label) {
  const m = label.match(/^\d{2}:\d{2}–(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function isSlotPast(dateStr, slot) {
  const today = nowInIsrael();
  if (dateStr < today.dateStr) return true;
  if (dateStr > today.dateStr) return false;
  const end = slotEndMinutes(slot.label);
  return end !== null && end <= today.minutes;
}

// ===== שליחת אישור במייל =====
async function sendConfirmationEmail(email, data) {
  if (!resend || !email) return;

  const childrenList = data.children.map(c =>
    `<li>${c.name}${c.age != null ? ` (גיל ${c.age})` : ''}</li>`
  ).join('');

  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #1565c0, #283593); color: white; border-radius: 16px; padding: 24px; text-align: center; margin-bottom: 24px;">
        <div style="font-size: 2.5rem;">🎠</div>
        <h1 style="margin: 10px 0 4px;">משחקיה עירונית 8</h1>
        <p style="opacity: 0.85; margin: 0;">אישור רישום</p>
      </div>

      <div style="background: #f9f9f9; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
        <p style="font-size: 1.1rem; color: #333;">שלום <strong>${data.parentName}</strong>,</p>
        <p style="color: #555;">רישומך למשחקיה העירונית התקבל בהצלחה! 🎉</p>
      </div>

      <div style="background: white; border: 2px solid #e3f2fd; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
        <h2 style="color: #1565c0; margin-top: 0;">פרטי הביקור</h2>
        <p>📅 <strong>${data.dayName} — ${hebrewDate(data.date)}</strong></p>
        <p>🕐 <strong>${data.slotLabel}</strong></p>
        <p>👨‍👩‍👧 <strong>ילדים שנרשמו:</strong></p>
        <ul style="color: #333;">${childrenList}</ul>
        <p>📍 <strong>כתובת:</strong> רח' עליית הנוער 9, מרכז משאבים, קריית שמונה</p>
      </div>

      <div style="background: #fff8e1; border-right: 4px solid #f57c00; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
        <h3 style="color: #e65100; margin-top: 0;">📋 נהלים חשובים</h3>
        <ul style="color: #555; line-height: 1.8;">
          <li>🚫 אסור להכניס שתייה ואוכל למתחם</li>
          <li>👟 חובה על כולם (כולל הורים) להוריד נעליים בכניסה</li>
          <li>👨‍👧 הכניסה בליווי מבוגר בלבד</li>
        </ul>
      </div>

      <p style="text-align: center; color: #aaa; font-size: 0.85rem;">מחכים לכם! 🎠 — צוות משחקיה עירונית 8</p>
    </div>
  `;

  await resend.emails.send({
    from: `משחקיה עירונית 8 <onboarding@resend.dev>`,
    to: email,
    subject: `✅ אישור רישום למשחקיה — ${data.dayName} ${hebrewDate(data.date)}`,
    html,
  });

  console.log(`📧 מייל אישור נשלח ל: ${email}`);
}

// ===== Middleware =====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/countdown', express.static(path.join(__dirname, '..', 'countdown')));

// ===== API =====
app.get('/api/dates', async (req, res) => {
  try {
    const result = [];
    const capacity = scheduleSettings.capacityDefault || DEFAULT_CAPACITY;
    const now = nowInIsrael();
    const todayStr = now.dateStr;
    const endDateStr = getRegistrationEndDate(now);

    for (let d = new Date(todayStr + 'T12:00:00'); dateToStr(d) <= endDateStr; d.setDate(d.getDate() + 1)) {
      const dateStr = dateToStr(d);
      const slots = computeSlotsForDate(dateStr).filter(slot => !isSlotPast(dateStr, slot)); // דלג על חלונות של היום שכבר חלפו
      if (!slots.length) continue;

      const slotsInfo = await Promise.all(slots.map(async slot => {
        const regs = await getSlotRegistrations(dateStr, slot.id);
        const people = countPeople(regs);
        return { ...slot, registered: people, available: capacity - people, full: people >= capacity };
      }));

      result.push({ date: dateStr, dayName: hebrewDay(dateStr), slots: slotsInfo });
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/schedule', (req, res) => {
  res.json({
    banner: scheduleSettings.banner,
    weeklyTemplate: scheduleSettings.weeklyTemplate,
    exceptions: scheduleSettings.exceptions,
    capacityDefault: scheduleSettings.capacityDefault,
    registrationRange: { start: nowInIsrael().dateStr, end: getRegistrationEndDate(nowInIsrael()) },
  });
});

app.post('/api/register', async (req, res) => {
  try {
    if (!checkRegisterRateLimit(req.ip))
      return res.status(429).json({ error: 'יותר מדי בקשות הרשמה מכתובת זו. נסו שוב בעוד כמה דקות' });

    const { date, slot, parentName, phone, email, children, allergies } = req.body;
    if (!date || !slot || !parentName || !phone || !children?.length)
      return res.status(400).json({ error: 'נא למלא את כל השדות הנדרשים' });
    if (!isValidIsraeliPhone(phone))
      return res.status(400).json({ error: 'מספר טלפון לא תקין' });

    const capacity = scheduleSettings.capacityDefault || DEFAULT_CAPACITY;
    const slotDef = computeSlotsForDate(date).find(s => s.id === slot);
    if (!slotDef)
      return res.status(400).json({ error: 'חריץ זמן לא חוקי' });
    if (isSlotPast(date, slotDef))
      return res.status(409).json({ error: 'מצטערים, המועד הזה כבר חלף', expired: true });

    const newPeople = 1 + children.length;

    // בדיקת המקום הפנוי והשמירה רצות בתוך נעילה פר-סבב, כדי שבקשות מקבילות לא יעברו יחד את המכסה
    const result = await withSlotLock(date, slot, async () => {
      const regs = await getSlotRegistrations(date, slot);
      const peopleCount = countPeople(regs);
      if (peopleCount >= capacity)
        return { status: 409, body: { error: `מצטערים, הרישום למועד זה נסגר — הגענו ל-${capacity} אנשים`, full: true } };

      const remaining = capacity - peopleCount;
      if (newPeople > remaining)
        return { status: 409, body: { error: `נותרו רק ${remaining} מקומות (כולל הורים)`, remaining } };

      const entry = { id: generateRegistrationId(), parentName, phone, email: email || null, children, allergies: allergies || null, slotLabel: slotDef.label, registeredAt: new Date().toISOString() };
      await addRegistration(date, slot, entry);
      return { entry, newTotal: peopleCount + newPeople };
    });

    if (result.status) return res.status(result.status).json(result.body);

    const { entry, newTotal } = result;
    const responseData = {
      success: true,
      message: 'הרישום בוצע בהצלחה!',
      confirmationId: entry.id,
      date, dayName: hebrewDay(date),
      slotLabel: slotDef.label,
      childrenCount: children.length,
      totalRegistered: newTotal,
      remainingSpots: capacity - newTotal
    };

    res.json(responseData);

    // שליחת מייל אישור (לא חוסם את התגובה)
    if (email) {
      sendConfirmationEmail(email, {
        parentName, date, dayName: hebrewDay(date),
        slotLabel: slotDef.label, children
      }).catch(err => console.error('שגיאה בשליחת מייל:', err.message));
    }

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/login', (req, res) => {
  if (!AUTH_SECRET || !getManagers().length)
    return res.status(503).json({ error: 'הניהול עדיין לא הוגדר בשרת' });

  const ip = req.ip;
  const now = Date.now();
  const rec = loginFails.get(ip);
  if (rec && rec.until > now) {
    const minutes = Math.ceil((rec.until - now) / 60000);
    return res.status(429).json({ error: `יותר מדי ניסיונות שגויים. נסה שוב בעוד ${minutes} דקות` });
  }

  const password = String(req.body?.password || '');
  // בודקים מול כל המנהלים (בלי לעצור בהתאמה הראשונה) כדי לא לחשוף מידע דרך זמן התגובה
  let user = null;
  for (const m of getManagers()) if (safeEqual(password, m.password) && !user) user = m;

  if (!user) {
    // ניסיונות שגויים ישנים (מעל 15 דקות) או חסימה שפגה — מתחילים ספירה מחדש
    const count = (rec && now - rec.last < LOGIN_BLOCK_MS && rec.until <= rec.last ? rec.count : 0) + 1;
    loginFails.set(ip, { count, last: now, until: count >= LOGIN_MAX_FAILS ? now + LOGIN_BLOCK_MS : 0 });
    return res.status(401).json({ error: 'סיסמה שגויה' });
  }

  loginFails.delete(ip);
  const token = signToken({ name: user.name, role: 'manager', exp: now + TOKEN_TTL_MS, pv: managerFingerprint(user.password) });
  res.json({ token, name: user.name });
});

app.get('/api/me', requireManager, (req, res) => {
  res.json({ name: req.user.name, role: req.user.role });
});

app.get('/api/admin', requireManager, async (req, res) => {
  try { res.json(await getAllData()); }
  catch (e) { res.status(500).json({ error: 'שגיאת שרת' }); }
});

app.delete('/api/admin/registration/:id', requireManager, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (db) {
      await db.query('DELETE FROM registrations WHERE id=$1', [id]);
    } else {
      const data = readJSON();
      Object.keys(data).forEach(date => {
        Object.keys(data[date]).forEach(slot => {
          data[date][slot] = data[date][slot].filter(r => r.id !== id);
        });
      });
      writeJSON(data);
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// בודק תקינות בסיסית של הגדרות שעות: פורמט שעה, סדר, ובלי חפיפות בתוך אותו יום
function validateScheduleSettings(settings) {
  const errors = [];
  const timeRe = /^\d{2}:\d{2}$/;

  function checkSlotList(slots, where) {
    if (!Array.isArray(slots)) { errors.push(`${where}: רשימת סבבים לא תקינה`); return; }
    const ranges = [];
    slots.forEach((s, i) => {
      if (!s.id || typeof s.id !== 'string') { errors.push(`${where}, סבב ${i + 1}: חסר מזהה`); return; }
      const m = String(s.label || '').match(/^(\d{2}:\d{2})–(\d{2}:\d{2})$/);
      if (!m || !timeRe.test(m[1]) || !timeRe.test(m[2])) { errors.push(`${where}, סבב "${s.id}": פורמט שעה לא תקין (נדרש HH:MM–HH:MM)`); return; }
      const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      const start = toMin(m[1]), end = toMin(m[2]);
      if (end <= start) { errors.push(`${where}, סבב "${s.id}": שעת הסיום חייבת להיות אחרי שעת ההתחלה`); return; }
      for (const r of ranges) if (start < r.end && end > r.start) errors.push(`${where}, סבב "${s.id}": חופף לסבב "${r.id}"`);
      ranges.push({ id: s.id, start, end });
    });
  }

  if (!settings.weeklyTemplate || typeof settings.weeklyTemplate !== 'object') errors.push('חסרה תבנית שבועית');
  else for (const day of [0, 1, 2, 3, 4]) checkSlotList(settings.weeklyTemplate[day] || [], `יום ${day}`);

  if (!Array.isArray(settings.exceptions)) errors.push('רשימת החריגים לא תקינה');
  else settings.exceptions.forEach((ex, i) => {
    const where = `חריג ${i + 1} (${ex.note || ex.id || ''})`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ex.startDate || '')) errors.push(`${where}: תאריך התחלה לא תקין`);
    if (ex.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(ex.endDate)) errors.push(`${where}: תאריך סיום לא תקין`);
    if (ex.endDate && ex.endDate < ex.startDate) errors.push(`${where}: תאריך סיום לפני תאריך התחלה`);
    if (!['closed', 'add', 'replace'].includes(ex.type)) errors.push(`${where}: סוג חריג לא תקין`);
    if (ex.type !== 'closed') checkSlotList(ex.slots || [], where);
  });

  if (settings.capacityDefault != null && (!Number.isInteger(settings.capacityDefault) || settings.capacityDefault < 1))
    errors.push('קיבולת ברירת המחדל חייבת להיות מספר שלם חיובי');

  return errors;
}

// בודק חפיפה על התוצאה הממוזגת בפועל (תבנית שבועית + חריגים יחד), לא רק כל רשימה בנפרד —
// כדי לתפוס למשל חריג "add" שמתווסף על סבב קיים באותם ימים בלי שהמנהל שם לב לחפיפה.
// בודק את 120 הימים הקרובים ומדווח פעם אחת לכל צירוף יום-בשבוע+זוג-סבבים חופפים (לא לכל תאריך בטווח).
function validateMergedSlotOverlaps(settings) {
  const errors = [];
  const seen = new Set();
  const timeRe = /^(\d{2}):(\d{2})–(\d{2}):(\d{2})$/;
  const toMin = (h, m) => Number(h) * 60 + Number(m);
  const today = nowInIsrael().dateStr;
  const horizonStart = new Date(today + 'T12:00:00');

  for (let i = 0; i < 120; i++) {
    const d = new Date(horizonStart); d.setDate(d.getDate() + i);
    const dateStr = dateToStr(d);
    const slots = computeSlotsForDate(dateStr, settings);
    const ranges = [];
    for (const s of slots) {
      const m = String(s.label || '').match(timeRe);
      if (!m) continue; // פורמט לא תקין כבר מדווח ב-validateScheduleSettings
      const start = toMin(m[1], m[2]), end = toMin(m[3], m[4]);
      for (const r of ranges) {
        if (start < r.end && end > r.start) {
          const dowKey = d.getDay() + '|' + [r.id, s.id].sort().join('|');
          if (!seen.has(dowKey)) {
            seen.add(dowKey);
            errors.push(`${hebrewDay(dateStr)} (החל מ-${dateStr}): סבב "${r.id}" חופף בפועל לסבב "${s.id}" אחרי מיזוג התבנית השבועית עם החריגים`);
          }
        }
      }
      ranges.push({ id: s.id, start, end });
    }
  }
  return errors;
}

// מוצא סבבים שנעלמים מהתאריכים הקרובים ויש בהם נרשמים — כדי לחסום מחיקה שתסתיר רישומים קיימים
async function findRemovedSlotConflicts(oldSettings, newSettings) {
  const all = await getAllData();
  const today = nowInIsrael().dateStr;
  const horizon = new Date(today + 'T12:00:00'); horizon.setDate(horizon.getDate() + 60);
  const conflicts = [];
  for (let d = new Date(today + 'T12:00:00'); d <= horizon; d.setDate(d.getDate() + 1)) {
    const dateStr = dateToStr(d);
    const oldIds = new Set(computeSlotsForDate(dateStr, oldSettings).map(s => s.id));
    const newIds = new Set(computeSlotsForDate(dateStr, newSettings).map(s => s.id));
    for (const id of oldIds) {
      if (newIds.has(id)) continue;
      const regs = all[dateStr]?.[id];
      if (regs && regs.length) conflicts.push({ date: dateStr, slotId: id, families: regs.length, people: countPeople(regs) });
    }
  }
  return conflicts;
}

app.get('/api/admin/schedule', requireManager, (req, res) => {
  res.json(scheduleSettings);
});

app.put('/api/admin/schedule', requireManager, async (req, res) => {
  try {
    const newSettings = req.body;

    // בדיקת concurrency אופטימית: אם ה-updatedAt שהלקוח טען לא תואם את המצב הנוכחי בשרת,
    // מנהל אחר כבר שמר בינתיים — עוצרים כאן במקום לדרוס בשקט (ראו admin.html: attempt())
    if ((newSettings.updatedAt || null) !== (scheduleSettings.updatedAt || null))
      return res.status(409).json({ error: 'ההגדרות עודכנו בינתיים על ידי מנהל אחר. יש לרענן את הדף ולנסות שוב.', staleUpdate: true });

    const errors = validateScheduleSettings(newSettings);
    if (errors.length) return res.status(400).json({ error: 'הגדרות לא תקינות', details: errors });

    const mergedErrors = validateMergedSlotOverlaps(newSettings);
    if (mergedErrors.length) return res.status(400).json({ error: 'הגדרות לא תקינות', details: mergedErrors });

    const conflicts = await findRemovedSlotConflicts(scheduleSettings, newSettings);
    if (conflicts.length && !req.query.force)
      return res.status(409).json({ error: 'יש נרשמים בסבבים שיימחקו', conflicts });

    await saveScheduleSettings(newSettings, req.user.name);
    // מחזירים את updatedAt החדש כדי שהלקוח יעדכן את זה שבידיו — אחרת השמירה הבאה תיתפס בטעות כ"לא עדכנית"
    res.json({ success: true, updatedAt: newSettings.updatedAt, updatedBy: newSettings.updatedBy });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ===== הפעלה =====
initDB().then(loadScheduleSettings).then(() => {
  app.listen(PORT, () => {
    console.log(`\n🎠 משחקיה עירונית — מערכת רישום`);
    console.log(`✅ השרת פועל על: http://localhost:${PORT}`);
    console.log(db ? '   מצב: PostgreSQL ☁️' : '   מצב: קובץ JSON 💾 (מקומי)\n');
    console.log(process.env.RESEND_API_KEY ? '📧 Resend: מוגדר ✅' : '   מייל: לא מוגדר');
    const managers = getManagers();
    if (!AUTH_SECRET || !managers.length) console.warn('⚠️ ניהול חסום: חסרים משתני סביבה MANAGER1_NAME/PASSWORD, MANAGER2_NAME/PASSWORD, AUTH_SECRET');
    else console.log(`🔐 מנהלים מוגדרים: ${managers.map(m => m.name).join(', ')}`);
    // זיהוי "ייצור" מתבסס רק על RAILWAY_ENVIRONMENT. אם יש מסד נתונים אמיתי מחובר (DATABASE_URL)
    // אבל הסביבה בכל זאת לא זוהתה כ"ייצור", זה כנראה סימן שמנגנון הזיהוי לא מתאים לפלטפורמת הפריסה
    // הנוכחית — מזהירים בקול רם כדי שלא ליפול בשקט על סיסמת ברירת המחדל של פיתוח (1234).
    if (!IS_PRODUCTION && process.env.DATABASE_URL) {
      console.warn('🚨 אזהרה: DATABASE_URL מוגדר (מסד נתונים אמיתי מחובר) אך הסביבה לא זוהתה כ"ייצור" (RAILWAY_ENVIRONMENT לא מוגדר).');
      console.warn('   אם זו סביבה חיה, הניהול עלול להיות פתוח עם סיסמת ברירת המחדל 1234. ודאו RAILWAY_ENVIRONMENT ו/או משתני MANAGER1/2.');
    }
  });
}).catch(e => { console.error('שגיאה באתחול:', e); process.exit(1); });
