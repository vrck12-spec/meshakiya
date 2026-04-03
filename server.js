const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_PER_SLOT = 30;

// ===== הגדרת תאריכי חול המועד =====
const START_DATE = '2026-04-05';
const END_DATE   = '2026-04-08';
const ACTIVE_DAYS = [0, 1, 2, 3]; // א׳–ד׳

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
      children JSONB NOT NULL,
      registered_at TIMESTAMPTZ DEFAULT NOW()
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
      'SELECT id, parent_name, phone, children, registered_at FROM registrations WHERE date=$1 AND slot=$2 ORDER BY id',
      [date, slot]
    );
    return res.rows.map(r => ({
      id: Number(r.id),
      parentName: r.parent_name,
      phone: r.phone,
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
      'INSERT INTO registrations (id, date, slot, parent_name, phone, children, registered_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [entry.id, date, slot, entry.parentName, entry.phone, JSON.stringify(entry.children), entry.registeredAt]
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
  const day = new Date(dateStr + 'T12:00:00').getDay();
  if (!ACTIVE_DAYS.includes(day)) return [];
  const slots = [{ id: 'morning', label: '09:00–12:00', display: 'בוקר' }];
  if (day !== 3) slots.push({ id: 'afternoon', label: '15:00–18:00', display: 'אחה"צ' });
  return slots;
}

function hebrewDay(dateStr) {
  const days = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  return 'יום ' + days[new Date(dateStr + 'T12:00:00').getDay()];
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

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const slots = getSlotsForDate(dateStr);
      if (!slots.length) continue;

      const slotsInfo = await Promise.all(slots.map(async slot => {
        const regs = await getSlotRegistrations(dateStr, slot.id);
        return { ...slot, registered: regs.length, available: MAX_PER_SLOT - regs.length, full: regs.length >= MAX_PER_SLOT };
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
    const { date, slot, parentName, phone, children } = req.body;
    if (!date || !slot || !parentName || !phone || !children?.length)
      return res.status(400).json({ error: 'נא למלא את כל השדות הנדרשים' });
    if (!getSlotsForDate(date).find(s => s.id === slot))
      return res.status(400).json({ error: 'חריץ זמן לא חוקי' });

    const regs = await getSlotRegistrations(date, slot);
    if (regs.length >= MAX_PER_SLOT)
      return res.status(409).json({ error: 'מצטערים, הרישום למועד זה נסגר — הגענו ל-30 ילדים', full: true });

    const remaining = MAX_PER_SLOT - regs.length;
    if (children.length > remaining)
      return res.status(409).json({ error: `נותרו רק ${remaining} מקומות`, remaining });

    const entry = { id: Date.now(), parentName, phone, children, registeredAt: new Date().toISOString() };
    await addRegistration(date, slot, entry);

    const newCount = regs.length + 1;
    const slotInfo = getSlotsForDate(date).find(s => s.id === slot);
    res.json({
      success: true,
      message: 'הרישום בוצע בהצלחה!',
      confirmationId: entry.id,
      date, dayName: hebrewDay(date),
      slotLabel: slotInfo?.label,
      childrenCount: children.length,
      totalRegistered: newCount,
      remainingSpots: MAX_PER_SLOT - newCount
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/admin', async (req, res) => {
  try { res.json(await getAllData()); }
  catch (e) { res.status(500).json({ error: 'שגיאת שרת' }); }
});

// ===== הפעלה =====
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🎠 משחקיה עירונית — מערכת רישום`);
    console.log(`✅ השרת פועל על: http://localhost:${PORT}`);
    console.log(db ? '   מצב: PostgreSQL ☁️' : '   מצב: קובץ JSON 💾 (מקומי)\n');
  });
}).catch(e => { console.error('שגיאה באתחול:', e); process.exit(1); });
