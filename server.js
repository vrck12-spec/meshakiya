const express = require('express');
const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_PER_SLOT = 30;

// ===== הגדרת תאריכי פעילות =====
const START_DATE = '2026-04-26';
const END_DATE   = '2026-05-01';
const ACTIVE_DAYS = [0, 1, 2, 3, 4, 5]; // א׳–ו׳ (כולם פעילים)
const CLOSED_DATES = []; // אין סגירות השבוע

// ===== הגדרת שולח מייל =====
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

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
  // הוספת עמודת מייל לטבלה קיימת (אם עדיין לא קיימת)
  await db.query(`
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS email TEXT
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
      'SELECT id, parent_name, phone, email, children, registered_at FROM registrations WHERE date=$1 AND slot=$2 ORDER BY id',
      [date, slot]
    );
    return res.rows.map(r => ({
      id: Number(r.id),
      parentName: r.parent_name,
      phone: r.phone,
      email: r.email,
      children: r.children,
      registeredAt: r.registered_at
    }));
  }
  const data = readJSON();
  return data[date]?.[slot] || [];
}

async function addRegistration(date, slot, entry) {
  if (db) {
    await db.query(
      'INSERT INTO registrations (id, date, slot, parent_name, phone, email, children, registered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [entry.id, date, slot, entry.parentName, entry.phone, entry.email || null, JSON.stringify(entry.children), entry.registeredAt]
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
        registeredAt: r.registered_at
      });
    });
    return result;
  }
  return readJSON();
}

// ===== עזר: תאריכים וחריצים =====
function getSlotsForDate(dateStr) {
  if (CLOSED_DATES.includes(dateStr)) return [];
  const day = new Date(dateStr + 'T12:00:00').getDay();
  if (!ACTIVE_DAYS.includes(day)) return [];

  const morningSlots = [
    { id: 'morning1', label: '09:00–11:00', display: 'בוקר א׳' },
    { id: 'morning2', label: '11:00–13:00', display: 'בוקר ב׳' },
  ];
  const eveningSlots = [
    { id: 'evening1', label: '16:00–18:00', display: 'אחה"צ א׳' },
    { id: 'evening2', label: '18:00–20:00', display: 'אחה"צ ב׳' },
  ];

  // ו׳ (5): בוקר בלבד
  if (day === 5) return morningSlots;
  // א׳–ה׳ (0–4): אחה"צ + ערב
  return eveningSlots;
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

// ===== API =====
app.get('/api/dates', async (req, res) => {
  try {
    const result = [];
    const start = new Date(START_DATE + 'T12:00:00');
    const end   = new Date(END_DATE   + 'T12:00:00');

    const todayStr = new Date().toISOString().split('T')[0];

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      if (dateStr <= todayStr) continue; // דלג על תאריכי עבר (כולל היום)
      const slots = getSlotsForDate(dateStr);
      if (!slots.length) continue;

      const slotsInfo = await Promise.all(slots.map(async slot => {
        const regs = await getSlotRegistrations(dateStr, slot.id);
        const people = countPeople(regs);
        return { ...slot, registered: people, available: MAX_PER_SLOT - people, full: people >= MAX_PER_SLOT };
      }));

      result.push({ date: dateStr, dayName: hebrewDay(dateStr), slots: slotsInfo });
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { date, slot, parentName, phone, email, children } = req.body;
    if (!date || !slot || !parentName || !phone || !children?.length)
      return res.status(400).json({ error: 'נא למלא את כל השדות הנדרשים' });
    if (!getSlotsForDate(date).find(s => s.id === slot))
      return res.status(400).json({ error: 'חריץ זמן לא חוקי' });

    const regs = await getSlotRegistrations(date, slot);
    const peopleCount = countPeople(regs);
    if (peopleCount >= MAX_PER_SLOT)
      return res.status(409).json({ error: 'מצטערים, הרישום למועד זה נסגר — הגענו ל-30 אנשים', full: true });

    const remaining = MAX_PER_SLOT - peopleCount;
    const newPeople = 1 + children.length;
    if (newPeople > remaining)
      return res.status(409).json({ error: `נותרו רק ${remaining} מקומות (כולל הורים)`, remaining });

    const entry = { id: Date.now(), parentName, phone, email: email || null, children, registeredAt: new Date().toISOString() };
    await addRegistration(date, slot, entry);

    const newTotal = peopleCount + newPeople;
    const slotInfo = getSlotsForDate(date).find(s => s.id === slot);

    const responseData = {
      success: true,
      message: 'הרישום בוצע בהצלחה!',
      confirmationId: entry.id,
      date, dayName: hebrewDay(date),
      slotLabel: slotInfo?.label,
      childrenCount: children.length,
      totalRegistered: newTotal,
      remainingSpots: MAX_PER_SLOT - newTotal
    };

    res.json(responseData);

    // שליחת מייל אישור (לא חוסם את התגובה)
    if (email) {
      sendConfirmationEmail(email, {
        parentName, date, dayName: hebrewDay(date),
        slotLabel: slotInfo?.label, children
      }).catch(err => console.error('שגיאה בשליחת מייל:', err.message));
    }

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/admin', async (req, res) => {
  try { res.json(await getAllData()); }
  catch (e) { res.status(500).json({ error: 'שגיאת שרת' }); }
});

app.delete('/api/admin/registration/:id', async (req, res) => {
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

// ===== הפעלה =====
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🎠 משחקיה עירונית — מערכת רישום`);
    console.log(`✅ השרת פועל על: http://localhost:${PORT}`);
    console.log(db ? '   מצב: PostgreSQL ☁️' : '   מצב: קובץ JSON 💾 (מקומי)\n');
    console.log(process.env.RESEND_API_KEY ? '📧 Resend: מוגדר ✅' : '   מייל: לא מוגדר');
  });
}).catch(e => { console.error('שגיאה באתחול:', e); process.exit(1); });
