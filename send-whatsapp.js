/**
 * שליחת תזכורות WhatsApp לנרשמי המשחקיה
 *
 * הפעלה:
 *   node send-whatsapp.js          ← מצב בדיקה (מדפיס בלבד, לא שולח)
 *   node send-whatsapp.js --send   ← שליחה אמיתית
 *
 * נדרשת סיסמת מנהל במשתנה סביבה (לא לכתוב אותה בקובץ):
 *   PowerShell:  $env:MESHAKIYA_ADMIN_PASSWORD = '...'; node send-whatsapp.js
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const DRY_RUN = !process.argv.includes('--send');
const BASE_URL = 'https://meshakiya-production.up.railway.app';
const API_URL = BASE_URL + '/api/admin';
const DELAY_MS = 3000; // 3 שניות בין הודעה להודעה

const HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function hebrewDay(dateStr) {
  return 'יום ' + HEBREW_DAYS[new Date(dateStr + 'T12:00:00').getDay()];
}

function hebrewDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function buildMessage(parentName, dateStr, slotLabel) {
  const day  = hebrewDay(dateStr);
  const date = hebrewDate(dateStr);
  const time = slotLabel;
  return (
    `שלום ${parentName} 😊\n\n` +
    `תזכורת לרישום שלך למשחקיה העירונית:\n` +
    `📅 ${day}, ${date}\n` +
    `🕐 ${time}\n\n` +
    `מחכים לכם! 🎠`
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatPhone(phone) {
  // מנרמל מספר ישראלי ל-WhatsApp (972XXXXXXXXX@c.us)
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0')) p = '972' + p.slice(1);
  if (!p.startsWith('972')) p = '972' + p;
  return p + '@c.us';
}

async function login() {
  const password = process.env.MESHAKIYA_ADMIN_PASSWORD;
  if (!password) throw new Error('חסר משתנה סביבה MESHAKIYA_ADMIN_PASSWORD (סיסמת מנהל)');
  const res = await fetch(BASE_URL + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`כניסה נכשלה: ${data.error || res.status}`);
  return data.token;
}

async function fetchRegistrations() {
  const token = await login();
  const res = await fetch(API_URL, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error(`שגיאה בשליפת נתונים: ${res.status}`);
  const data = await res.json();
  const todayStr = new Date().toISOString().split('T')[0];

  const list = [];
  for (const [date, slots] of Object.entries(data)) {
    if (date < todayStr) continue; // לא שולחים תזכורות לתאריכים שכבר עברו
    for (const [slotId, regs] of Object.entries(slots)) {
      for (const reg of regs) {
        // slotLabel נשמר בשרת בזמן ההרשמה עצמה — תמיד השעה הנכונה, גם אם השעות שונו אחר כך במסך העריכה
        list.push({ date, slotId, parentName: reg.parentName, phone: reg.phone, slotLabel: reg.slotLabel || slotId });
      }
    }
  }
  return list;
}

async function main() {
  console.log('🔄 שולף נתוני נרשמים...');
  const registrations = await fetchRegistrations();
  console.log(`✅ נמצאו ${registrations.length} נרשמים\n`);

  if (DRY_RUN) {
    console.log('━━━ מצב בדיקה (DRY RUN) — לא נשלח כלום ━━━\n');
    registrations.slice(0, 5).forEach(r => {
      console.log(`📱 ${r.phone} (${formatPhone(r.phone)})`);
      console.log(buildMessage(r.parentName, r.date, r.slotLabel));
      console.log('─'.repeat(40));
    });
    if (registrations.length > 5) {
      console.log(`... ועוד ${registrations.length - 5} נרשמים`);
    }
    console.log('\nכדי לשלח באמת: node send-whatsapp.js --send');
    return;
  }

  // ── שליחה אמיתית ──
  console.log('🚀 מצב שליחה! סורק QR code...\n');

  const client = new Client({ authStrategy: new LocalAuth() });

  client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('\nסרוק את ה-QR code עם WhatsApp בטלפון שלך');
  });

  client.on('ready', async () => {
    console.log('✅ WhatsApp מחובר! מתחיל שליחה...\n');
    let sent = 0, failed = 0;

    for (const reg of registrations) {
      const whatsappId = formatPhone(reg.phone);
      const message   = buildMessage(reg.parentName, reg.date, reg.slotLabel);
      try {
        await client.sendMessage(whatsappId, message);
        sent++;
        console.log(`✅ [${sent}/${registrations.length}] ${reg.parentName} (${reg.phone})`);
      } catch (err) {
        failed++;
        console.error(`❌ נכשל: ${reg.parentName} (${reg.phone}) — ${err.message}`);
      }
      await sleep(DELAY_MS);
    }

    console.log(`\n━━━ סיום ━━━`);
    console.log(`✅ נשלחו: ${sent}`);
    console.log(`❌ נכשלו: ${failed}`);
    await client.destroy();
  });

  client.initialize();
}

main().catch(err => {
  console.error('שגיאה:', err.message);
  process.exit(1);
});
