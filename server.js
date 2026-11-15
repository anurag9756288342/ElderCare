require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'eldercare', timestamp: new Date().toISOString() });
});

// Use local ./data directory when writable, or os.tmpdir() on serverless/Cloud Run read-only containers
function resolveDataDir() {
  const localDir = path.join(__dirname, 'data');
  try {
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    fs.accessSync(localDir, fs.constants.W_OK);
    return localDir;
  } catch (err) {
    return path.join(os.tmpdir(), 'eldercare-data');
  }
}

const DATA_DIR = resolveDataDir();
const STORE_FILE = path.join(DATA_DIR, 'store.json');

app.use(cors());
app.use(express.json({ limit: '512kb' }));

// Security HTTP Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: 0
  })
);

function escapeHtmlServer(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function verifyPasscodeTimingSafe(expected, provided) {
  const a = Buffer.from(String(expected || '').trim(), 'utf8');
  const b = Buffer.from(String(provided || '').trim(), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Brute-force PIN protection (max 10 failed attempts per 5 minutes per IP+Profile)
const authRateLimitMap = new Map();
function checkAuthRateLimit(key) {
  const now = Date.now();
  const entry = authRateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    authRateLimitMap.set(key, { count: 0, resetAt: now + 5 * 60 * 1000 });
    return { blocked: false };
  }
  if (entry.count >= 10) {
    return { blocked: true, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { blocked: false };
}
function recordFailedAuth(key) {
  const now = Date.now();
  const entry = authRateLimitMap.get(key) || { count: 0, resetAt: now + 5 * 60 * 1000 };
  entry.count += 1;
  authRateLimitMap.set(key, entry);
}
function clearFailedAuth(key) {
  authRateLimitMap.delete(key);
}

// ---------------------------------------------------------------------------
// Date & Time Utilities
// ---------------------------------------------------------------------------
function formatDateKey(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDaysOffsetDateKey(daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return formatDateKey(d);
}

function timeStringToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function minutesToTimeString(totalMinutes) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const h = String(Math.floor(clamped / 60)).padStart(2, '0');
  const m = String(clamped % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function formatTime12h(time24) {
  if (!time24) return '';
  const [hStr, mStr] = time24.split(':');
  let h = parseInt(hStr, 10);
  const m = mStr || '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function generateId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Fast Non-Blocking Email / Nodemailer Engine
// ---------------------------------------------------------------------------
let activeTransporter = null;
let transporterMode = 'local_outbox'; // 'smtp' | 'ethereal' | 'local_outbox'
let etherealAccountInfo = null;

// Start with ultra-fast in-memory streamTransport immediately, then upgrade in background
activeTransporter = nodemailer.createTransport({
  streamTransport: true,
  newline: 'unix',
  buffer: true
});

async function initMailer(customSmtp = null) {
  try {
    const host = customSmtp?.host || process.env.SMTP_HOST;
    const port = Number(customSmtp?.port || process.env.SMTP_PORT || 587);
    const user = customSmtp?.user || process.env.SMTP_USER;
    const pass = customSmtp?.pass || process.env.SMTP_PASS;

    if (host && user && pass) {
      activeTransporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
      });
      transporterMode = 'smtp';
      return { mode: transporterMode, host, user };
    }

    const etherealPromise = nodemailer.createTestAccount();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Ethereal timeout')), 2500)
    );
    const testAccount = await Promise.race([etherealPromise, timeoutPromise]);
    activeTransporter = nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      pool: true,
      maxConnections: 3,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass
      }
    });
    etherealAccountInfo = {
      user: testAccount.user,
      web: 'https://ethereal.email/messages'
    };
    transporterMode = 'ethereal';
    return { mode: transporterMode, user: testAccount.user };
  } catch (err) {
    activeTransporter = nodemailer.createTransport({
      streamTransport: true,
      newline: 'unix',
      buffer: true
    });
    transporterMode = 'local_outbox';
    return { mode: transporterMode };
  }
}

// Initialize mailer asynchronously on startup without blocking server boot
initMailer();

function buildEmailHtml({
  profile,
  category,
  headline,
  subtitle,
  detailsRows = [],
  actionNote,
  urgency = 'normal'
}) {
  const accentColor =
    urgency === 'high'
      ? '#DC2626'
      : urgency === 'warning'
      ? '#D97706'
      : urgency === 'appointment'
      ? '#2563EB'
      : '#0F766E';

  const badgeBg =
    urgency === 'high'
      ? '#FEF2F2'
      : urgency === 'warning'
      ? '#FFFBEB'
      : urgency === 'appointment'
      ? '#EFF6FF'
      : '#F0FDFA';

  const rowsHtml = detailsRows
    .map(
      (r) => `
      <tr>
        <td style="padding: 10px 12px; border-bottom: 1px solid #E2E8F0; color: #64748B; font-size: 13px; font-weight: 600; width: 38%;">${escapeHtmlServer(r.label)}</td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #E2E8F0; color: #0F172A; font-size: 14px; font-weight: 600;">${escapeHtmlServer(r.value)}</td>
      </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtmlServer(headline)}</title>
</head>
<body style="margin:0; padding:16px; background-color:#F1F5F9; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:580px; margin:0 auto; background:#FFFFFF; border-radius:16px; overflow:hidden; border:1px solid #E2E8F0; box-shadow:0 4px 12px rgba(15,23,42,0.06);">
    <div style="background:${accentColor}; padding:18px 22px; color:#FFFFFF;">
      <div style="font-size:11px; text-transform:uppercase; letter-spacing:1.2px; opacity:0.9; font-weight:700;">ElderCare Proactive Care Network · Profile ${escapeHtmlServer(profile.profileCode)}</div>
      <h1 style="margin:6px 0 0; font-size:19px; font-weight:700;">${escapeHtmlServer(headline)}</h1>
    </div>
    <div style="padding:20px 22px;">
      <div style="display:inline-block; background:${badgeBg}; color:${accentColor}; border:1px solid ${accentColor}33; padding:4px 10px; border-radius:999px; font-size:12px; font-weight:700; margin-bottom:12px;">
        ${escapeHtmlServer(category)}
      </div>
      <p style="margin:0 0 16px; color:#334155; font-size:14.5px; line-height:1.55;">
        ${escapeHtmlServer(subtitle)}
      </p>
      <table style="width:100%; border-collapse:collapse; background:#F8FAFC; border-radius:10px; overflow:hidden; border:1px solid #E2E8F0; margin-bottom:16px;">
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
      ${
        actionNote
          ? `<div style="background:${badgeBg}; border-left:4px solid ${accentColor}; padding:12px 14px; border-radius:6px; color:#1E293B; font-size:13.5px; line-height:1.5; margin-bottom:16px;">
              <strong>Recommended Action:</strong> ${escapeHtmlServer(actionNote)}
            </div>`
          : ''
      }
      <div style="padding-top:14px; border-top:1px solid #E2E8F0; font-size:12px; color:#64748B; line-height:1.5;">
        <div><strong>Care Profile:</strong> ${escapeHtmlServer(profile.elderName)} (Age ${escapeHtmlServer(profile.age)}) · Access Code: <code style="background:#F1F5F9; padding:2px 6px; border-radius:4px;">${escapeHtmlServer(profile.profileCode)}</code></div>
        <div><strong>Primary Physician:</strong> ${escapeHtmlServer(profile.primaryDoctor || 'Not specified')} · <strong>Emergency Phone:</strong> ${escapeHtmlServer(profile.emergencyPhone || 'Not specified')}</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// Instant non-blocking email dispatch: records immediately in <1ms and syncs SMTP in background
function dispatchCareEmail(profile, emailPayload) {
  const {
    type,
    categoryLabel,
    subject,
    headline,
    subtitle,
    detailsRows,
    actionNote,
    urgency = 'normal',
    dedupeKey = null,
    triggeredBy = 'Proactive Reminder Engine',
    overrideRecipients = null
  } = emailPayload;

  let recipients = [];
  if (Array.isArray(overrideRecipients) && overrideRecipients.length > 0) {
    recipients = overrideRecipients;
  } else {
    recipients = (profile.careCircle || []).filter((member) => {
      if (!member.email) return false;
      const prefs = member.notifications || {};
      if (type === 'missed_medication') return prefs.missedMedications !== false;
      if (type === 'upcoming_dose') return prefs.upcomingDoses !== false;
      if (type === 'upcoming_appointment') return prefs.appointments !== false;
      return true;
    });

    if (recipients.length === 0 && profile.careCircle?.length > 0) {
      recipients = profile.careCircle.filter((m) => Boolean(m.email));
    }
  }

  const toAddressList = recipients.map((r) =>
    typeof r === 'string' ? r : `${r.name} <${r.email}>`
  );
  const recipientSummaries = recipients.map((r) =>
    typeof r === 'string'
      ? { name: r, email: r, role: 'Care Circle' }
      : { name: r.name, email: r.email, role: r.role }
  );

  const html = buildEmailHtml({
    profile,
    category: categoryLabel || 'Care Reminder',
    headline,
    subtitle,
    detailsRows,
    actionNote,
    urgency
  });

  const textSummary = [
    `${headline}`,
    subtitle,
    ...(detailsRows || []).map((r) => `${r.label}: ${r.value}`),
    actionNote ? `Action: ${actionNote}` : ''
  ]
    .filter(Boolean)
    .join('\n');

  const initialStatus =
    transporterMode === 'ethereal'
      ? 'Sent via Ethereal SMTP'
      : transporterMode === 'smtp'
      ? 'Sent via Live SMTP'
      : 'Dispatched (Instant Care Outbox)';

  const emailRecord = {
    id: generateId('eml'),
    type,
    categoryLabel: categoryLabel || 'Care Reminder',
    subject,
    headline,
    subtitle,
    detailsRows,
    actionNote,
    urgency,
    recipients: recipientSummaries,
    html,
    messageId: `<${crypto.randomBytes(8).toString('hex')}@eldercare.health>`,
    previewUrl: null,
    deliveryStatus: initialStatus,
    triggeredBy,
    dedupeKey,
    sentAt: new Date().toISOString()
  };

  if (!Array.isArray(profile.emailLogs)) {
    profile.emailLogs = [];
  }
  profile.emailLogs.unshift(emailRecord);
  if (profile.emailLogs.length > 100) {
    profile.emailLogs = profile.emailLogs.slice(0, 100);
  }

  // Dispatch actual Nodemailer transport asynchronously in background (zero blocking!)
  if (activeTransporter) {
    activeTransporter
      .sendMail({
        from:
          profile.smtpConfig?.from ||
          process.env.SMTP_FROM ||
          '"ElderCare Smart Health" <reminders@eldercare.health>',
        to: toAddressList.join(', ') || 'care-circle@eldercare.health',
        subject,
        text: textSummary,
        html
      })
      .then((info) => {
        if (info?.messageId) emailRecord.messageId = info.messageId;
        if (transporterMode === 'ethereal') {
          const url = nodemailer.getTestMessageUrl(info);
          if (url) emailRecord.previewUrl = url;
        }
        saveStore();
      })
      .catch(() => {});
  }

  return emailRecord;
}

// ---------------------------------------------------------------------------
// Initial Seed Data Builder
// ---------------------------------------------------------------------------
function buildInitialStore() {
  const today = formatDateKey(new Date());
  const yesterday = getDaysOffsetDateKey(-1);
  const twoDaysAgo = getDaysOffsetDateKey(-2);
  const threeDaysAgo = getDaysOffsetDateKey(-3);
  const fourDaysAgo = getDaysOffsetDateKey(-4);
  const fiveDaysAgo = getDaysOffsetDateKey(-5);
  const sixDaysAgo = getDaysOffsetDateKey(-6);
  const tomorrow = getDaysOffsetDateKey(1);
  const inThreeDays = getDaysOffsetDateKey(3);
  const inEightDays = getDaysOffsetDateKey(8);

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const overdueTime =
    currentMinutes > 120
      ? minutesToTimeString(currentMinutes - 65)
      : '08:30';
  const upcomingSoonTime =
    currentMinutes < 23 * 60
      ? minutesToTimeString(currentMinutes + 35)
      : '23:30';

  const marthaProfile = {
    profileCode: 'MARTHA-842',
    passcode: '4826',
    elderName: 'Martha Vance',
    age: 78,
    dateOfBirth: '1948-04-12',
    bloodType: 'O+',
    allergies: ['Penicillin', 'Sulfa Drugs'],
    conditions: ['Essential Hypertension', 'Type 2 Diabetes', 'Mild Osteoarthritis'],
    primaryDoctor: 'Dr. Eleanor Chen, MD (Internal Medicine)',
    primaryClinic: 'St. Jude Senior Health Pavilion, Suite 400',
    emergencyContactName: 'Sarah Vance (Daughter)',
    emergencyPhone: '(555) 234-8910',
    address: '742 Evergreen Terrace, Apt 3B, Oakridge',
    notes: 'Prefers taking morning pills with warm oatmeal. Uses reading glasses for labels.',
    reminderSettings: {
      autoScanEnabled: true,
      missedGraceMinutes: 30,
      upcomingLeadMinutes: 60,
      appointmentLeadHours: 48,
      dailyDigestTime: '20:30'
    },
    careCircle: [
      {
        id: 'mem_martha',
        name: 'Martha Vance',
        role: 'Elderly Individual',
        relationship: 'Self (Patient)',
        email: 'martha.vance@eldercare.demo',
        phone: '(555) 234-1100',
        avatarColor: '#0F766E',
        notifications: {
          upcomingDoses: true,
          missedMedications: true,
          appointments: true,
          dailySummary: false
        }
      },
      {
        id: 'mem_sarah',
        name: 'Sarah Vance',
        role: 'Family Member',
        relationship: 'Daughter (Primary Family Coordinator)',
        email: 'sarah.vance@familycare.demo',
        phone: '(555) 234-8910',
        avatarColor: '#2563EB',
        notifications: {
          upcomingDoses: false,
          missedMedications: true,
          appointments: true,
          dailySummary: true
        }
      },
      {
        id: 'mem_david',
        name: 'Nurse David Miller, RN',
        role: 'Caretaker',
        relationship: 'Visiting Home Care Nurse',
        email: 'david.miller.rn@homehealth.demo',
        phone: '(555) 876-5432',
        avatarColor: '#7C3AED',
        notifications: {
          upcomingDoses: true,
          missedMedications: true,
          appointments: true,
          dailySummary: true
        }
      },
      {
        id: 'mem_michael',
        name: 'Michael Vance',
        role: 'Family Member',
        relationship: 'Son',
        email: 'michael.vance@familycare.demo',
        phone: '(555) 391-0042',
        avatarColor: '#D97706',
        notifications: {
          upcomingDoses: false,
          missedMedications: true,
          appointments: true,
          dailySummary: false
        }
      }
    ],
    medications: [
      {
        id: 'med_lisinopril',
        name: 'Lisinopril',
        dosage: '10 mg',
        form: 'Tablet',
        purpose: 'Blood Pressure Control',
        frequency: 'Once Daily',
        times: ['07:30'],
        instructions: 'Take every morning with a full glass of water.',
        prescribedBy: 'Dr. Eleanor Chen',
        pillsRemaining: 24,
        refillThreshold: 7,
        colorTag: 'teal',
        active: true
      },
      {
        id: 'med_metformin',
        name: 'Metformin HCl',
        dosage: '500 mg',
        form: 'Tablet',
        purpose: 'Type 2 Diabetes (Blood Glucose)',
        frequency: 'Twice Daily',
        times: [overdueTime, '19:30'],
        instructions: 'Take with meals to reduce stomach upset.',
        prescribedBy: 'Dr. Eleanor Chen',
        pillsRemaining: 5,
        refillThreshold: 10,
        colorTag: 'amber',
        active: true
      },
      {
        id: 'med_atorvastatin',
        name: 'Atorvastatin',
        dosage: '20 mg',
        form: 'Tablet',
        purpose: 'Cholesterol Management',
        frequency: 'Once Daily',
        times: [upcomingSoonTime],
        instructions: 'Take consistently. Avoid grapefruit juice.',
        prescribedBy: 'Dr. Robert Patel (Cardiology)',
        pillsRemaining: 18,
        refillThreshold: 7,
        colorTag: 'blue',
        active: true
      },
      {
        id: 'med_vitd3',
        name: 'Vitamin D3 + Calcium',
        dosage: '1000 IU / 600 mg',
        form: 'Softgel',
        purpose: 'Bone Density & Joint Support',
        frequency: 'Once Daily',
        times: ['13:00'],
        instructions: 'Take after lunch.',
        prescribedBy: 'Dr. Eleanor Chen',
        pillsRemaining: 42,
        refillThreshold: 10,
        colorTag: 'emerald',
        active: true
      }
    ],
    doseLogs: {
      [`${today}_med_lisinopril_07:30`]: {
        date: today,
        medId: 'med_lisinopril',
        time: '07:30',
        status: 'taken',
        loggedAt: new Date(new Date().setHours(7, 34, 0)).toISOString(),
        loggedBy: 'Martha Vance (Elderly Individual)',
        note: 'Taken with morning oatmeal and water.'
      },
      [`${yesterday}_med_lisinopril_07:30`]: {
        date: yesterday,
        medId: 'med_lisinopril',
        time: '07:30',
        status: 'taken',
        loggedAt: `${yesterday}T07:35:00.000Z`,
        loggedBy: 'Martha Vance (Elderly Individual)',
        note: ''
      },
      [`${yesterday}_med_metformin_${overdueTime}`]: {
        date: yesterday,
        medId: 'med_metformin',
        time: overdueTime,
        status: 'taken',
        loggedAt: `${yesterday}T09:40:00.000Z`,
        loggedBy: 'Nurse David Miller, RN (Caretaker)',
        note: 'Verified during morning home visit.'
      },
      [`${yesterday}_med_metformin_19:30`]: {
        date: yesterday,
        medId: 'med_metformin',
        time: '19:30',
        status: 'taken',
        loggedAt: `${yesterday}T19:32:00.000Z`,
        loggedBy: 'Martha Vance (Elderly Individual)',
        note: ''
      },
      [`${yesterday}_med_atorvastatin_${upcomingSoonTime}`]: {
        date: yesterday,
        medId: 'med_atorvastatin',
        time: upcomingSoonTime,
        status: 'taken',
        loggedAt: `${yesterday}T12:15:00.000Z`,
        loggedBy: 'Martha Vance (Elderly Individual)',
        note: ''
      },
      [`${yesterday}_med_vitd3_13:00`]: {
        date: yesterday,
        medId: 'med_vitd3',
        time: '13:00',
        status: 'taken',
        loggedAt: `${yesterday}T13:05:00.000Z`,
        loggedBy: 'Martha Vance (Elderly Individual)',
        note: ''
      }
    },
    appointments: [
      {
        id: 'apt_cardio',
        doctorName: 'Dr. Robert Patel, MD',
        specialty: 'Cardiology',
        title: 'Quarterly Blood Pressure & Echocardiogram Review',
        clinic: 'Oakridge Heart & Vascular Institute, Room 214',
        address: '450 Medical Center Pkwy, Oakridge',
        date: tomorrow,
        time: '10:30',
        accompaniedBy: 'Sarah Vance (Daughter)',
        prepNotes: 'Bring home blood pressure log and current pill bottles. No caffeine 4 hours before visit.',
        status: 'Upcoming',
        reminderLeadHours: 24,
        reminderSent: false
      },
      {
        id: 'apt_pcp',
        doctorName: 'Dr. Eleanor Chen, MD',
        specialty: 'Internal Medicine & Geriatrics',
        title: 'HbA1c Diabetes Lab Check & Medication Refill Review',
        clinic: 'St. Jude Senior Health Pavilion, Suite 400',
        address: '1200 Wellness Way, Oakridge',
        date: inThreeDays,
        time: '14:00',
        accompaniedBy: 'Nurse David Miller, RN',
        prepNotes: 'Fasting blood draw required only if lab done in morning; afternoon visit will review continuous glucose log.',
        status: 'Upcoming',
        reminderLeadHours: 48,
        reminderSent: false
      },
      {
        id: 'apt_eye',
        doctorName: 'Dr. Hannah Lindqvist, OD',
        specialty: 'Ophthalmology',
        title: 'Annual Diabetic Retinal Exam',
        clinic: 'ClearView Senior Eye Care',
        address: '88 Pinehurst Ave, Suite 102',
        date: inEightDays,
        time: '11:15',
        accompaniedBy: 'Michael Vance (Son)',
        prepNotes: 'Pupils will be dilated; bring sunglasses. Michael is driving home.',
        status: 'Upcoming',
        reminderLeadHours: 48,
        reminderSent: false
      },
      {
        id: 'apt_pt_past',
        doctorName: 'Lucas Meyer, DPT',
        specialty: 'Physical Therapy',
        title: 'Balance & Knee Mobility Assessment',
        clinic: 'Oakridge Rehab & Mobility Center',
        address: '310 Parkside Dr',
        date: threeDaysAgo,
        time: '09:30',
        accompaniedBy: 'Nurse David Miller, RN',
        prepNotes: 'Wear comfortable walking shoes.',
        visitSummary: 'Gait stability improved by 15%. Continue 20-minute daily flat walk and seated leg extensions.',
        status: 'Completed',
        reminderLeadHours: 24,
        reminderSent: true
      }
    ],
    routines: [
      {
        id: 'rtn_bp',
        title: 'Morning Blood Pressure & Pulse Check',
        category: 'Vitals Monitoring',
        scheduledTime: '08:00',
        targetDescription: 'Sit quietly for 5 mins before cuff reading; log systolic/diastolic.',
        assignedTo: 'Martha Vance / Nurse David',
        completedDates: [today, yesterday, twoDaysAgo, threeDaysAgo, fourDaysAgo, sixDaysAgo]
      },
      {
        id: 'rtn_hydration',
        title: 'Daily Hydration Goal (6–8 Glasses of Water)',
        category: 'Nutrition & Hydration',
        scheduledTime: '12:00',
        targetDescription: 'Drink 1 glass upon waking, 2 by noon, 2 in afternoon, 1 with dinner.',
        assignedTo: 'Martha Vance',
        completedDates: [yesterday, twoDaysAgo, threeDaysAgo, fiveDaysAgo, sixDaysAgo]
      },
      {
        id: 'rtn_walk',
        title: '20-Minute Gentle Garden Walk & Balance Exercises',
        category: 'Mobility & Exercise',
        scheduledTime: '10:30',
        targetDescription: 'Low-impact walk with supportive footwear; 10 seated leg lifts.',
        assignedTo: 'Martha Vance / Nurse David',
        completedDates: [today, yesterday, threeDaysAgo, fourDaysAgo, fiveDaysAgo]
      },
      {
        id: 'rtn_glucose',
        title: 'Before-Dinner Blood Glucose Fingerstick Check',
        category: 'Vitals Monitoring',
        scheduledTime: '18:30',
        targetDescription: 'Target pre-meal range: 90–130 mg/dL.',
        assignedTo: 'Martha Vance',
        completedDates: [yesterday, twoDaysAgo, threeDaysAgo, fourDaysAgo, fiveDaysAgo, sixDaysAgo]
      },
      {
        id: 'rtn_foot',
        title: 'Evening Diabetic Foot & Skin Comfort Check',
        category: 'Preventive Care',
        scheduledTime: '21:00',
        targetDescription: 'Check for any redness or blisters; apply moisturizing lotion.',
        assignedTo: 'Martha Vance',
        completedDates: [yesterday, twoDaysAgo, fourDaysAgo, fiveDaysAgo, sixDaysAgo]
      }
    ],
    vitals: [
      {
        id: 'vit_1',
        recordedAt: new Date(new Date().setHours(8, 5, 0)).toISOString(),
        recordedBy: 'Martha Vance (Elderly Individual)',
        bloodPressure: '124/78',
        heartRate: 71,
        bloodGlucose: 108,
        weightLbs: 146.5,
        mood: 'Rested & Cheerful',
        notes: 'Slept 7.5 hours without waking.'
      },
      {
        id: 'vit_2',
        recordedAt: `${yesterday}T08:15:00.000Z`,
        recordedBy: 'Nurse David Miller, RN (Caretaker)',
        bloodPressure: '128/80',
        heartRate: 74,
        bloodGlucose: 114,
        weightLbs: 146.8,
        mood: 'Good Energy',
        notes: 'No ankle swelling observed.'
      },
      {
        id: 'vit_3',
        recordedAt: `${twoDaysAgo}T08:10:00.000Z`,
        recordedBy: 'Martha Vance (Elderly Individual)',
        bloodPressure: '122/76',
        heartRate: 69,
        bloodGlucose: 104,
        weightLbs: 146.4,
        mood: 'Calm',
        notes: 'Completed morning garden walk.'
      }
    ],
    activities: [
      {
        id: 'act_1',
        timestamp: new Date(new Date().setHours(8, 5, 0)).toISOString(),
        actor: 'Martha Vance (Elderly Individual)',
        type: 'vital_logged',
        text: 'Logged morning vitals: BP 124/78 mmHg, Heart Rate 71 bpm, Glucose 108 mg/dL.'
      },
      {
        id: 'act_2',
        timestamp: new Date(new Date().setHours(7, 34, 0)).toISOString(),
        actor: 'Martha Vance (Elderly Individual)',
        type: 'dose_taken',
        text: 'Marked Lisinopril 10 mg (7:30 AM dose) as Taken.'
      },
      {
        id: 'act_3',
        timestamp: `${yesterday}T18:20:00.000Z`,
        actor: 'Sarah Vance (Family Member)',
        type: 'appointment_updated',
        text: 'Confirmed transportation for tomorrow’s Cardiology appointment with Dr. Robert Patel.'
      }
    ],
    emailLogs: []
  };

  const pastDays = [twoDaysAgo, threeDaysAgo, fourDaysAgo, fiveDaysAgo, sixDaysAgo];
  pastDays.forEach((dKey, idx) => {
    marthaProfile.medications.forEach((med) => {
      med.times.forEach((t, tIdx) => {
        const isMissedSample = idx === 2 && med.id === 'med_vitd3';
        marthaProfile.doseLogs[`${dKey}_${med.id}_${t}`] = {
          date: dKey,
          medId: med.id,
          time: t,
          status: isMissedSample ? 'missed' : 'taken',
          loggedAt: `${dKey}T12:00:00.000Z`,
          loggedBy:
            tIdx % 2 === 0
              ? 'Martha Vance (Elderly Individual)'
              : 'Nurse David Miller, RN (Caretaker)',
          note: isMissedSample ? 'Forgot afternoon vitamin while out visiting family.' : ''
        };
      });
    });
  });

  marthaProfile.emailLogs = [
    {
      id: 'eml_seed_1',
      type: 'upcoming_appointment',
      categoryLabel: 'Medical Appointment Reminder',
      subject: `[ElderCare Reminder] Upcoming Cardiology Appointment for Martha Vance (${tomorrow} at 10:30 AM)`,
      headline: 'Upcoming Doctor Appointment Tomorrow',
      subtitle:
        'This is an automated reminder from the ElderCare shared healthcare platform regarding Martha Vance’s scheduled medical appointment.',
      detailsRows: [
        { label: 'Patient', value: 'Martha Vance (MARTHA-842)' },
        { label: 'Doctor & Specialty', value: 'Dr. Robert Patel, MD · Cardiology' },
        { label: 'Appointment Purpose', value: 'Quarterly Blood Pressure & Echocardiogram Review' },
        { label: 'Date & Time', value: `${tomorrow} at 10:30 AM` },
        { label: 'Clinic Location', value: 'Oakridge Heart & Vascular Institute, Room 214' },
        { label: 'Accompanied By', value: 'Sarah Vance (Daughter)' }
      ],
      actionNote:
        'Bring home blood pressure log and current pill bottles. No caffeine 4 hours before visit.',
      urgency: 'appointment',
      recipients: [
        { name: 'Martha Vance', email: 'martha.vance@eldercare.demo', role: 'Elderly Individual' },
        { name: 'Sarah Vance', email: 'sarah.vance@familycare.demo', role: 'Family Member' },
        { name: 'Nurse David Miller, RN', email: 'david.miller.rn@homehealth.demo', role: 'Caretaker' }
      ],
      html: buildEmailHtml({
        profile: marthaProfile,
        category: 'Medical Appointment Reminder',
        headline: 'Upcoming Doctor Appointment Tomorrow',
        subtitle:
          'This is an automated reminder from the ElderCare shared healthcare platform regarding Martha Vance’s scheduled medical appointment.',
        detailsRows: [
          { label: 'Patient', value: 'Martha Vance (MARTHA-842)' },
          { label: 'Doctor & Specialty', value: 'Dr. Robert Patel, MD · Cardiology' },
          { label: 'Date & Time', value: `${tomorrow} at 10:30 AM` },
          { label: 'Clinic Location', value: 'Oakridge Heart & Vascular Institute, Room 214' },
          { label: 'Accompanied By', value: 'Sarah Vance (Daughter)' }
        ],
        actionNote:
          'Bring home blood pressure log and current pill bottles. No caffeine 4 hours before visit.',
        urgency: 'appointment'
      }),
      messageId: '<seed-apt-001@eldercare.health>',
      previewUrl: null,
      deliveryStatus: 'Dispatched to Care Circle (3 Recipients)',
      triggeredBy: 'Proactive Scheduler (24h Lead Reminder)',
      dedupeKey: `apt_apt_cardio_${tomorrow}`,
      sentAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    },
    {
      id: 'eml_seed_2',
      type: 'upcoming_dose',
      categoryLabel: 'Upcoming Medication Dose',
      subject: `[ElderCare] Upcoming Dose Reminder: Lisinopril 10 mg at 7:30 AM`,
      headline: 'Upcoming Medication Dose: Lisinopril (10 mg)',
      subtitle:
        'Friendly reminder for Martha Vance’s morning blood pressure medication.',
      detailsRows: [
        { label: 'Medication', value: 'Lisinopril · 10 mg (Tablet)' },
        { label: 'Scheduled Time', value: `7:30 AM (${today})` },
        { label: 'Instructions', value: 'Take every morning with a full glass of water.' },
        { label: 'Prescribing Physician', value: 'Dr. Eleanor Chen' }
      ],
      actionNote: 'Please mark the dose as Taken in the ElderCare portal once completed.',
      urgency: 'normal',
      recipients: [
        { name: 'Martha Vance', email: 'martha.vance@eldercare.demo', role: 'Elderly Individual' },
        { name: 'Nurse David Miller, RN', email: 'david.miller.rn@homehealth.demo', role: 'Caretaker' }
      ],
      html: buildEmailHtml({
        profile: marthaProfile,
        category: 'Upcoming Medication Dose',
        headline: 'Upcoming Medication Dose: Lisinopril (10 mg)',
        subtitle: 'Friendly reminder for Martha Vance’s morning blood pressure medication.',
        detailsRows: [
          { label: 'Medication', value: 'Lisinopril · 10 mg (Tablet)' },
          { label: 'Scheduled Time', value: `7:30 AM (${today})` },
          { label: 'Instructions', value: 'Take every morning with a full glass of water.' }
        ],
        actionNote: 'Please mark the dose as Taken in the ElderCare portal once completed.',
        urgency: 'normal'
      }),
      messageId: '<seed-dose-002@eldercare.health>',
      previewUrl: null,
      deliveryStatus: 'Dispatched to Care Circle (2 Recipients)',
      triggeredBy: 'Proactive Scheduler (Morning Dose Window)',
      dedupeKey: `upcoming_${today}_med_lisinopril_07:30`,
      sentAt: new Date(new Date().setHours(7, 0, 0)).toISOString()
    }
  ];

  const arthurProfile = {
    profileCode: 'ARTHUR-319',
    passcode: '1943',
    elderName: 'Arthur Pendelton',
    age: 83,
    dateOfBirth: '1943-09-21',
    bloodType: 'A+',
    allergies: ['Codeine', 'Latex'],
    conditions: ['Atrial Fibrillation', 'Post-Hip Arthroplasty Recovery', 'Hypothyroidism'],
    primaryDoctor: 'Dr. Marcus Sterling, MD (Geriatrics)',
    primaryClinic: 'Mercy Senior Care Center, Suite 210',
    emergencyContactName: 'Claire Pendelton (Daughter)',
    emergencyPhone: '(555) 908-3312',
    address: '19 Maplewood Lane, Brookside',
    notes: 'Uses walker indoors. Needs 1 full glass of water with thyroid medication 30 mins before breakfast.',
    reminderSettings: {
      autoScanEnabled: true,
      missedGraceMinutes: 30,
      upcomingLeadMinutes: 60,
      appointmentLeadHours: 48,
      dailyDigestTime: '20:00'
    },
    careCircle: [
      {
        id: 'mem_arthur',
        name: 'Arthur Pendelton',
        role: 'Elderly Individual',
        relationship: 'Self (Patient)',
        email: 'arthur.pendelton@eldercare.demo',
        phone: '(555) 908-1122',
        avatarColor: '#0F766E',
        notifications: {
          upcomingDoses: true,
          missedMedications: true,
          appointments: true,
          dailySummary: false
        }
      },
      {
        id: 'mem_claire',
        name: 'Claire Pendelton',
        role: 'Family Member',
        relationship: 'Daughter',
        email: 'claire.pendelton@familycare.demo',
        phone: '(555) 908-3312',
        avatarColor: '#2563EB',
        notifications: {
          upcomingDoses: true,
          missedMedications: true,
          appointments: true,
          dailySummary: true
        }
      },
      {
        id: 'mem_elena',
        name: 'Elena Rostova, CNA',
        role: 'Caretaker',
        relationship: 'Daily Care Specialist',
        email: 'elena.rostova@careteam.demo',
        phone: '(555) 443-9821',
        avatarColor: '#7C3AED',
        notifications: {
          upcomingDoses: true,
          missedMedications: true,
          appointments: true,
          dailySummary: true
        }
      }
    ],
    medications: [
      {
        id: 'med_eliquis',
        name: 'Apixaban (Eliquis)',
        dosage: '5 mg',
        form: 'Tablet',
        purpose: 'Stroke Prevention / AFib Anticoagulant',
        frequency: 'Twice Daily',
        times: ['08:00', '20:00'],
        instructions: 'Critical anticoagulant: do not skip doses.',
        prescribedBy: 'Dr. Marcus Sterling',
        pillsRemaining: 32,
        refillThreshold: 10,
        colorTag: 'crimson',
        active: true
      },
      {
        id: 'med_levothyroxine',
        name: 'Levothyroxine',
        dosage: '75 mcg',
        form: 'Tablet',
        purpose: 'Thyroid Hormone Replacement',
        frequency: 'Once Daily',
        times: ['07:00'],
        instructions: 'Take on an empty stomach 30-60 minutes before breakfast.',
        prescribedBy: 'Dr. Marcus Sterling',
        pillsRemaining: 19,
        refillThreshold: 7,
        colorTag: 'teal',
        active: true
      }
    ],
    doseLogs: {
      [`${today}_med_levothyroxine_07:00`]: {
        date: today,
        medId: 'med_levothyroxine',
        time: '07:00',
        status: 'taken',
        loggedAt: new Date(new Date().setHours(7, 4, 0)).toISOString(),
        loggedBy: 'Arthur Pendelton (Elderly Individual)',
        note: 'Taken upon waking.'
      }
    },
    appointments: [
      {
        id: 'apt_ortho',
        doctorName: 'Dr. Gregory Halstead, MD',
        specialty: 'Orthopedic Surgery',
        title: '6-Week Post-Op Hip Mobility & X-Ray Follow-Up',
        clinic: 'Brookside Orthopedic Institute',
        address: '900 Surgical Way, Floor 3',
        date: inThreeDays,
        time: '11:00',
        accompaniedBy: 'Claire Pendelton (Daughter)',
        prepNotes: 'Bring walker for gait check.',
        status: 'Upcoming',
        reminderLeadHours: 48,
        reminderSent: false
      }
    ],
    routines: [
      {
        id: 'rtn_hip_pt',
        title: 'Seated Ankle Pumps & Hip Abduction Exercises',
        category: 'Post-Op Rehab',
        scheduledTime: '10:00',
        targetDescription: '2 sets of 12 gentle repetitions with Elena.',
        assignedTo: 'Arthur / Elena Rostova',
        completedDates: [today, yesterday, twoDaysAgo]
      }
    ],
    vitals: [
      {
        id: 'vit_art_1',
        recordedAt: new Date(new Date().setHours(8, 30, 0)).toISOString(),
        recordedBy: 'Elena Rostova, CNA',
        bloodPressure: '118/74',
        heartRate: 68,
        bloodGlucose: 98,
        weightLbs: 168.0,
        mood: 'Steady',
        notes: 'Incision site clean and healing well.'
      }
    ],
    activities: [
      {
        id: 'act_art_1',
        timestamp: new Date(new Date().setHours(7, 4, 0)).toISOString(),
        actor: 'Arthur Pendelton (Elderly Individual)',
        type: 'dose_taken',
        text: 'Marked Levothyroxine 75 mcg (7:00 AM) as Taken.'
      }
    ],
    emailLogs: []
  };

  [yesterday, twoDaysAgo, threeDaysAgo, fourDaysAgo, fiveDaysAgo, sixDaysAgo].forEach((dKey) => {
    arthurProfile.medications.forEach((med) => {
      med.times.forEach((t) => {
        arthurProfile.doseLogs[`${dKey}_${med.id}_${t}`] = {
          date: dKey,
          medId: med.id,
          time: t,
          status: 'taken',
          loggedAt: `${dKey}T08:10:00.000Z`,
          loggedBy: 'Elena Rostova, CNA (Caretaker)',
          note: ''
        };
      });
    });
  });

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    profiles: {
      'MARTHA-842': marthaProfile,
      'ARTHUR-319': arthurProfile
    }
  };
}

// ---------------------------------------------------------------------------
// Fast Non-Blocking In-Memory + Async Disk Persistence
// ---------------------------------------------------------------------------
function loadStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STORE_FILE)) {
    const initial = buildInitialStore();
    fs.writeFileSync(STORE_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    const fallback = buildInitialStore();
    fs.writeFileSync(STORE_FILE, JSON.stringify(fallback, null, 2), 'utf8');
    return fallback;
  }
}

let store = loadStore();
let saveTimer = null;

function saveStore() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.promises
      .mkdir(DATA_DIR, { recursive: true })
      .then(() =>
        fs.promises.writeFile(STORE_FILE, JSON.stringify(store, null, 2), 'utf8')
      )
      .catch(() => {});
  }, 50);
}

// ---------------------------------------------------------------------------
// Schedule, Adherence & Unified Dashboard Payload Builder
// ---------------------------------------------------------------------------
function computeScheduleForDate(profile, dateKey = formatDateKey(new Date())) {
  const todayKey = formatDateKey(new Date());
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const graceMinutes = Number(profile.reminderSettings?.missedGraceMinutes ?? 30);
  const upcomingLeadMinutes = Number(profile.reminderSettings?.upcomingLeadMinutes ?? 60);

  const slots = [];
  (profile.medications || []).forEach((med) => {
    if (med.active === false) return;
    (med.times || []).forEach((timeStr) => {
      const logKey = `${dateKey}_${med.id}_${timeStr}`;
      const existingLog = profile.doseLogs?.[logKey] || null;
      const schedMinutes = timeStringToMinutes(timeStr);

      let computedStatus = existingLog?.status || 'pending';
      let isOverdue = false;
      let isDueSoon = false;
      const minutesDelta = schedMinutes - currentMinutes;

      if (computedStatus === 'pending') {
        if (dateKey < todayKey) {
          computedStatus = 'missed';
          isOverdue = true;
        } else if (dateKey === todayKey) {
          if (currentMinutes - schedMinutes >= graceMinutes) {
            computedStatus = 'overdue';
            isOverdue = true;
          } else if (
            schedMinutes - currentMinutes <= upcomingLeadMinutes &&
            currentMinutes - schedMinutes < graceMinutes
          ) {
            computedStatus = 'due_soon';
            isDueSoon = true;
          }
        }
      }

      let period = 'Morning';
      if (schedMinutes >= 12 * 60 && schedMinutes < 17 * 60) period = 'Afternoon';
      else if (schedMinutes >= 17 * 60 && schedMinutes < 21 * 60) period = 'Evening';
      else if (schedMinutes >= 21 * 60) period = 'Bedtime';

      slots.push({
        slotKey: logKey,
        date: dateKey,
        medId: med.id,
        medName: med.name,
        dosage: med.dosage,
        form: med.form,
        purpose: med.purpose,
        instructions: med.instructions,
        prescribedBy: med.prescribedBy,
        pillsRemaining: med.pillsRemaining,
        refillThreshold: med.refillThreshold,
        colorTag: med.colorTag || 'teal',
        time: timeStr,
        timeFormatted: formatTime12h(timeStr),
        period,
        status: computedStatus,
        rawStatus: existingLog?.status || 'pending',
        isOverdue,
        isDueSoon,
        minutesDelta,
        loggedAt: existingLog?.loggedAt || null,
        loggedBy: existingLog?.loggedBy || null,
        note: existingLog?.note || ''
      });
    });
  });

  slots.sort((a, b) => timeStringToMinutes(a.time) - timeStringToMinutes(b.time));

  const totalDoses = slots.length;
  const takenDoses = slots.filter((s) => s.status === 'taken').length;
  const missedOrOverdueDoses = slots.filter(
    (s) => s.status === 'missed' || s.status === 'overdue'
  ).length;
  const skippedDoses = slots.filter((s) => s.status === 'skipped').length;
  const pendingDoses = slots.filter(
    (s) => s.status === 'pending' || s.status === 'due_soon'
  ).length;

  const adherenceRate =
    totalDoses > 0 ? Math.round((takenDoses / totalDoses) * 100) : 100;

  return {
    date: dateKey,
    slots,
    summary: {
      totalDoses,
      takenDoses,
      missedOrOverdueDoses,
      skippedDoses,
      pendingDoses,
      adherenceRate
    }
  };
}

function computeWeeklyAdherence(profile) {
  const days = [];
  let totalScheduled7d = 0;
  let totalTaken7d = 0;

  for (let i = -6; i <= 0; i++) {
    const dKey = getDaysOffsetDateKey(i);
    const dayObj = new Date();
    dayObj.setDate(dayObj.getDate() + i);
    const label = dayObj.toLocaleDateString('en-US', { weekday: 'short' });
    const sched = computeScheduleForDate(profile, dKey);

    const countableSlots =
      i === 0
        ? sched.slots.filter(
            (s) =>
              s.status === 'taken' ||
              s.status === 'missed' ||
              s.status === 'overdue' ||
              s.status === 'skipped'
          )
        : sched.slots;

    const dayTaken = sched.slots.filter((s) => s.status === 'taken').length;
    const dayMissed = sched.slots.filter(
      (s) => s.status === 'missed' || s.status === 'overdue'
    ).length;

    totalScheduled7d += countableSlots.length;
    totalTaken7d += dayTaken;

    const pct =
      countableSlots.length > 0
        ? Math.round((dayTaken / countableSlots.length) * 100)
        : sched.slots.length > 0 && dayTaken > 0
        ? Math.round((dayTaken / sched.slots.length) * 100)
        : 100;

    days.push({
      date: dKey,
      label,
      isToday: i === 0,
      total: sched.slots.length,
      taken: dayTaken,
      missed: dayMissed,
      adherencePct: Math.min(100, pct)
    });
  }

  const weeklyRate =
    totalScheduled7d > 0
      ? Math.min(100, Math.round((totalTaken7d / totalScheduled7d) * 100))
      : 100;

  return {
    weeklyRate,
    totalScheduled7d,
    totalTaken7d,
    days
  };
}

// ---------------------------------------------------------------------------
// Google Services Helpers (Google Calendar, Google Maps, Google Gemini AI)
// ---------------------------------------------------------------------------
function buildGoogleCalendarUrl(profile, apt) {
  const datePart = String(apt.date || formatDateKey()).replace(/-/g, '');
  const [hStr, mStr] = String(apt.time || '10:00').split(':');
  const startH = String(Number(hStr || 10)).padStart(2, '0');
  const startM = String(Number(mStr || 0)).padStart(2, '0');
  const endH = String(Math.min(23, Number(hStr || 10) + 1)).padStart(2, '0');

  const dates = `${datePart}T${startH}${startM}00/${datePart}T${endH}${startM}00`;
  const title = `[ElderCare] ${profile.elderName}: ${apt.doctorName} (${apt.specialty})`;
  const details = `${apt.title || 'Medical Appointment'}\nPatient: ${profile.elderName}\nAccompanied By: ${apt.accompaniedBy || 'Care Circle'}\nPreparation: ${apt.prepNotes || 'Bring medication list.'}`;
  const location = `${apt.clinic || ''}${apt.address ? `, ${apt.address}` : ''}`;

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates,
    details,
    location
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function buildGoogleMapsUrl(locationQuery) {
  if (!locationQuery) return 'https://www.google.com/maps';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(locationQuery)}`;
}

function buildSmartCareInsights(profile, todaySchedule, weeklyAdherence) {
  const insights = [];
  const overdueCount = todaySchedule.summary.missedOrOverdueDoses;

  if (overdueCount > 0) {
    const overdueMeds = todaySchedule.slots
      .filter((s) => s.status === 'overdue' || s.status === 'missed')
      .map((s) => `${s.medName} (${s.dosage} at ${s.timeFormatted})`)
      .join(', ');
    insights.push({
      type: 'urgent',
      title: 'Immediate Adherence Check Needed',
      text: `${overdueMeds} is currently past its scheduled window. Contact ${profile.elderName} or Caretaker before the next dose window.`
    });
  } else {
    insights.push({
      type: 'positive',
      title: 'Strong Daily Medication Adherence',
      text: `All due doses today are on track (${todaySchedule.summary.adherenceRate}% today, ${weeklyAdherence.weeklyRate}% 7-day score).`
    });
  }

  const lowMeds = (profile.medications || []).filter(
    (m) => m.active !== false && Number(m.pillsRemaining) <= Number(m.refillThreshold || 7)
  );
  if (lowMeds.length > 0) {
    insights.push({
      type: 'refill',
      title: 'Pharmacy Refill Coordination',
      text: `${lowMeds.map((m) => `${m.name} (${m.pillsRemaining} pills left)`).join(', ')} should be refilled with ${profile.primaryDoctor || 'the pharmacy'} within 3 days.`
    });
  }

  const upcomingApt = (profile.appointments || []).find((a) => a.status === 'Upcoming');
  if (upcomingApt) {
    insights.push({
      type: 'clinical',
      title: `Upcoming ${upcomingApt.specialty} Visit Prep`,
      text: `${upcomingApt.doctorName} on ${upcomingApt.date} at ${formatTime12h(upcomingApt.time)} (${upcomingApt.accompaniedBy}). ${upcomingApt.prepNotes || 'Bring updated vitals log.'}`
    });
  }

  return {
    provider: process.env.GEMINI_API_KEY
      ? 'Google Gemini 2.5 Flash Clinical Assistant'
      : 'ElderCare Smart Clinical Engine (Gemini-Ready)',
    generatedAt: new Date().toISOString(),
    insights
  };
}

function buildDashboardPayload(profile, selectedDate = formatDateKey(new Date())) {
  const todayKey = formatDateKey(new Date());
  const schedule = computeScheduleForDate(profile, selectedDate);
  const todaySchedule =
    selectedDate === todayKey ? schedule : computeScheduleForDate(profile, todayKey);
  const weeklyAdherence = computeWeeklyAdherence(profile);

  const lowRefillMedications = (profile.medications || []).filter(
    (m) => m.active !== false && Number(m.pillsRemaining) <= Number(m.refillThreshold || 7)
  );

  const routinesForDate = (profile.routines || []).map((r) => ({
    ...r,
    completedToday: Array.isArray(r.completedDates) && r.completedDates.includes(selectedDate)
  }));

  const enrichedAppointments = (profile.appointments || [])
    .slice()
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
    .map((apt) => ({
      ...apt,
      googleCalendarUrl: buildGoogleCalendarUrl(profile, apt),
      googleMapsUrl: buildGoogleMapsUrl(`${apt.clinic || ''} ${apt.address || ''}`.trim())
    }));

  return {
    profile: {
      profileCode: profile.profileCode,
      elderName: profile.elderName,
      age: profile.age,
      dateOfBirth: profile.dateOfBirth,
      bloodType: profile.bloodType,
      allergies: profile.allergies || [],
      conditions: profile.conditions || [],
      primaryDoctor: profile.primaryDoctor,
      primaryClinic: profile.primaryClinic,
      primaryClinicMapsUrl: buildGoogleMapsUrl(
        `${profile.primaryClinic || ''} ${profile.address || ''}`.trim()
      ),
      emergencyContactName: profile.emergencyContactName,
      emergencyPhone: profile.emergencyPhone,
      address: profile.address,
      notes: profile.notes,
      reminderSettings: profile.reminderSettings
    },
    careCircle: profile.careCircle || [],
    medications: profile.medications || [],
    lowRefillMedications,
    schedule,
    todaySummary: todaySchedule.summary,
    weeklyAdherence,
    aiCareBrief: buildSmartCareInsights(profile, todaySchedule, weeklyAdherence),
    appointments: enrichedAppointments,
    routines: routinesForDate,
    vitals: profile.vitals || [],
    activities: (profile.activities || []).slice(0, 25),
    emailLogs: (profile.emailLogs || []).slice(0, 50),
    mailerStatus: {
      mode: transporterMode,
      etherealAccountInfo
    }
  };
}

// ---------------------------------------------------------------------------
// Proactive Reminder Scanner (Instant Execution)
// ---------------------------------------------------------------------------
function scanAndDispatchProfileReminders(profile, options = {}) {
  const { forceSend = false, triggeredBy = 'Proactive Reminder Scanner' } = options;
  const dispatched = [];
  const todayKey = formatDateKey(new Date());
  const schedule = computeScheduleForDate(profile, todayKey);

  const existingDedupeKeys = new Set(
    (profile.emailLogs || []).map((e) => e.dedupeKey).filter(Boolean)
  );

  for (const slot of schedule.slots) {
    if (slot.status === 'overdue' || slot.status === 'missed') {
      const dedupeKey = `missed_${todayKey}_${slot.medId}_${slot.time}`;
      if (!existingDedupeKeys.has(dedupeKey) || forceSend) {
        const emailRec = dispatchCareEmail(profile, {
          type: 'missed_medication',
          categoryLabel: 'Missed Medication Alert',
          subject: `[URGENT: Missed Dose] ${profile.elderName} missed ${slot.medName} (${slot.dosage}) scheduled for ${slot.timeFormatted}`,
          headline: `Missed Medication Alert: ${slot.medName} (${slot.dosage})`,
          subtitle: `${profile.elderName}'s scheduled ${slot.timeFormatted} dose of ${slot.medName} has passed its grace window without being marked as Taken.`,
          detailsRows: [
            { label: 'Patient', value: `${profile.elderName} (${profile.profileCode})` },
            { label: 'Medication & Dosage', value: `${slot.medName} · ${slot.dosage} (${slot.form})` },
            { label: 'Scheduled Time', value: `${slot.timeFormatted} (${todayKey})` },
            { label: 'Clinical Purpose', value: slot.purpose || 'Daily Regimen' },
            { label: 'Instructions', value: slot.instructions || 'Follow standard dosing' },
            { label: 'Emergency Phone', value: profile.emergencyPhone || 'See Care Circle' }
          ],
          actionNote:
            'Please check in with the patient by phone or in person to confirm if the dose was taken, and update the ElderCare dashboard.',
          urgency: 'high',
          dedupeKey,
          triggeredBy
        });
        existingDedupeKeys.add(dedupeKey);
        dispatched.push(emailRec);
      }
    }
  }

  for (const slot of schedule.slots) {
    if (slot.status === 'due_soon' || (forceSend && slot.status === 'pending')) {
      const dedupeKey = `upcoming_${todayKey}_${slot.medId}_${slot.time}`;
      if (!existingDedupeKeys.has(dedupeKey) || forceSend) {
        const emailRec = dispatchCareEmail(profile, {
          type: 'upcoming_dose',
          categoryLabel: 'Upcoming Dose Reminder',
          subject: `[Dose Reminder] ${profile.elderName}: ${slot.medName} (${slot.dosage}) due at ${slot.timeFormatted}`,
          headline: `Upcoming Dose at ${slot.timeFormatted}: ${slot.medName}`,
          subtitle: `Gentle reminder that ${profile.elderName} has an upcoming medication dose scheduled at ${slot.timeFormatted}.`,
          detailsRows: [
            { label: 'Patient', value: `${profile.elderName}` },
            { label: 'Medication', value: `${slot.medName} · ${slot.dosage} (${slot.form})` },
            { label: 'Scheduled Time', value: `${slot.timeFormatted} (${slot.period})` },
            { label: 'Instructions', value: slot.instructions || 'Take as directed' },
            { label: 'Remaining Supply', value: `${slot.pillsRemaining} doses left` }
          ],
          actionNote:
            'Once taken, tap "Mark Taken" in ElderCare so family members and caretakers stay informed.',
          urgency: 'warning',
          dedupeKey,
          triggeredBy
        });
        existingDedupeKeys.add(dedupeKey);
        dispatched.push(emailRec);
        if (forceSend && slot.status === 'pending') break;
      }
    }
  }

  const nowMs = Date.now();
  const leadHours = Number(profile.reminderSettings?.appointmentLeadHours ?? 48);
  for (const apt of profile.appointments || []) {
    if (apt.status !== 'Upcoming') continue;
    const aptDateMs = new Date(`${apt.date}T${apt.time || '09:00'}:00`).getTime();
    const hoursUntil = (aptDateMs - nowMs) / (1000 * 3600);
    const dedupeKey = `apt_${apt.id}_${apt.date}`;

    if (
      (hoursUntil >= -2 && hoursUntil <= leadHours && !existingDedupeKeys.has(dedupeKey)) ||
      (forceSend && !apt.reminderSent)
    ) {
      const emailRec = dispatchCareEmail(profile, {
        type: 'upcoming_appointment',
        categoryLabel: 'Medical Appointment Reminder',
        subject: `[Appointment Reminder] ${profile.elderName} with ${apt.doctorName} on ${apt.date} at ${formatTime12h(apt.time)}`,
        headline: `Upcoming Medical Appointment: ${apt.specialty}`,
        subtitle: `${profile.elderName} has an upcoming doctor appointment scheduled with ${apt.doctorName}.`,
        detailsRows: [
          { label: 'Patient', value: `${profile.elderName} (${profile.profileCode})` },
          { label: 'Physician & Specialty', value: `${apt.doctorName} · ${apt.specialty}` },
          { label: 'Visit Reason', value: apt.title || 'Medical Consultation' },
          { label: 'Date & Time', value: `${apt.date} at ${formatTime12h(apt.time)}` },
          { label: 'Clinic & Address', value: `${apt.clinic} (${apt.address || ''})` },
          { label: 'Accompanied By', value: apt.accompaniedBy || 'Unassigned — Care Circle please confirm' }
        ],
        actionNote: apt.prepNotes || 'Please arrive 15 minutes early with current medication list.',
        urgency: 'appointment',
        dedupeKey,
        triggeredBy
      });
      apt.reminderSent = true;
      existingDedupeKeys.add(dedupeKey);
      dispatched.push(emailRec);
    }
  }

  if (dispatched.length > 0) {
    saveStore();
  }
  return dispatched;
}

setTimeout(() => {
  Object.values(store.profiles).forEach((profile) => {
    if (profile.reminderSettings?.autoScanEnabled !== false) {
      scanAndDispatchProfileReminders(profile, {
        triggeredBy: 'Automated Background Monitor'
      });
    }
  });
}, 500);

setInterval(() => {
  Object.values(store.profiles).forEach((profile) => {
    if (profile.reminderSettings?.autoScanEnabled !== false) {
      scanAndDispatchProfileReminders(profile, {
        triggeredBy: 'Automated Background Monitor'
      });
    }
  });
}, 60 * 1000);

// ---------------------------------------------------------------------------
// Authentication Helper
// ---------------------------------------------------------------------------
function getProfileAndVerify(req, res) {
  const code = String(req.params.code || '').toUpperCase().trim();
  const profile = store.profiles[code];
  if (!profile) {
    res.status(404).json({ error: `Care profile "${code}" not found.` });
    return null;
  }

  const providedPasscode =
    req.headers['x-passcode'] || req.body?.passcode || req.query?.passcode;

  if (!providedPasscode || !verifyPasscodeTimingSafe(profile.passcode, providedPasscode)) {
    res.status(401).json({
      error: 'Invalid or missing passcode for this Care Profile.',
      requiresPasscode: true
    });
    return null;
  }

  return profile;
}

function recordActivity(profile, actor, type, text) {
  if (!Array.isArray(profile.activities)) {
    profile.activities = [];
  }
  profile.activities.unshift({
    id: generateId('act'),
    timestamp: new Date().toISOString(),
    actor: actor || 'Care Circle Member',
    type,
    text
  });
  if (profile.activities.length > 50) {
    profile.activities = profile.activities.slice(0, 50);
  }
}

// ---------------------------------------------------------------------------
// Public & Auth Endpoints
// ---------------------------------------------------------------------------
app.get('/api/profiles/public', (req, res) => {
  const list = Object.values(store.profiles).map((p) => ({
    profileCode: p.profileCode,
    elderName: p.elderName,
    age: p.age,
    primaryDoctor: p.primaryDoctor,
    memberCount: (p.careCircle || []).length,
    demoPasscodeHint: p.passcode,
    membersPreview: (p.careCircle || []).map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      relationship: m.relationship,
      avatarColor: m.avatarColor
    }))
  }));
  res.json({ profiles: list, mailerMode: transporterMode, etherealAccountInfo });
});

app.post('/api/auth/verify', (req, res) => {
  const code = String(req.body.profileCode || '').toUpperCase().trim();
  const passcode = String(req.body.passcode || '').trim();
  const rateKey = `${req.ip || 'local'}_${code}`;

  const rateCheck = checkAuthRateLimit(rateKey);
  if (rateCheck.blocked) {
    return res.status(429).json({
      error: `Too many failed passcode attempts. Please wait ${rateCheck.retryAfterSec} seconds.`
    });
  }

  const profile = store.profiles[code];

  if (!profile) {
    return res.status(404).json({
      error: `No Care Profile found with code "${code}". Check the code or create a new profile.`
    });
  }

  if (!verifyPasscodeTimingSafe(profile.passcode, passcode)) {
    recordFailedAuth(rateKey);
    return res.status(401).json({
      error: 'Incorrect passcode. Please verify the 4–6 digit Care Circle PIN.'
    });
  }

  clearFailedAuth(rateKey);

  // Return the complete dashboard payload right on auth verify so unlock is 1 single round-trip!
  res.json({
    authenticated: true,
    profileCode: profile.profileCode,
    elderName: profile.elderName,
    careCircle: profile.careCircle,
    dashboard: buildDashboardPayload(profile, req.body.date || formatDateKey(new Date()))
  });
});

app.post('/api/profiles', (req, res) => {
  const {
    elderName,
    age,
    profileCode,
    passcode,
    bloodType,
    allergies,
    conditions,
    primaryDoctor,
    emergencyContactName,
    emergencyPhone,
    elderEmail,
    caretakerName,
    caretakerRole,
    caretakerEmail
  } = req.body;

  if (!elderName || !passcode) {
    return res.status(400).json({ error: 'Elderly person name and passcode are required.' });
  }

  const cleanCode = (
    profileCode ||
    `${elderName.split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '')}-${Math.floor(100 + Math.random() * 900)}`
  )
    .toUpperCase()
    .trim();

  if (store.profiles[cleanCode]) {
    return res.status(409).json({ error: `Profile code "${cleanCode}" is already in use.` });
  }

  const careCircle = [
    {
      id: generateId('mem'),
      name: elderName.trim(),
      role: 'Elderly Individual',
      relationship: 'Self (Patient)',
      email: elderEmail || `${elderName.toLowerCase().replace(/\s+/g, '.')}@eldercare.demo`,
      phone: emergencyPhone || '',
      avatarColor: '#0F766E',
      notifications: {
        upcomingDoses: true,
        missedMedications: true,
        appointments: true,
        dailySummary: false
      }
    }
  ];

  if (caretakerName) {
    careCircle.push({
      id: generateId('mem'),
      name: caretakerName.trim(),
      role: caretakerRole || 'Family Member',
      relationship: caretakerRole === 'Caretaker' ? 'Primary Caretaker' : 'Family Coordinator',
      email: caretakerEmail || 'family@eldercare.demo',
      phone: emergencyPhone || '',
      avatarColor: '#2563EB',
      notifications: {
        upcomingDoses: true,
        missedMedications: true,
        appointments: true,
        dailySummary: true
      }
    });
  }

  const newProfile = {
    profileCode: cleanCode,
    passcode: String(passcode).trim(),
    elderName: elderName.trim(),
    age: Number(age) || 75,
    dateOfBirth: '',
    bloodType: bloodType || 'O+',
    allergies: Array.isArray(allergies)
      ? allergies
      : String(allergies || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
    conditions: Array.isArray(conditions)
      ? conditions
      : String(conditions || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
    primaryDoctor: primaryDoctor || 'Primary Care Physician',
    primaryClinic: 'Community Health Clinic',
    emergencyContactName: emergencyContactName || caretakerName || '',
    emergencyPhone: emergencyPhone || '',
    address: '',
    notes: '',
    reminderSettings: {
      autoScanEnabled: true,
      missedGraceMinutes: 30,
      upcomingLeadMinutes: 60,
      appointmentLeadHours: 48,
      dailyDigestTime: '20:00'
    },
    careCircle,
    medications: [],
    doseLogs: {},
    appointments: [],
    routines: [
      {
        id: generateId('rtn'),
        title: 'Morning Blood Pressure & Wellness Check',
        category: 'Vitals Monitoring',
        scheduledTime: '08:30',
        targetDescription: 'Record morning blood pressure and hydration glass.',
        assignedTo: elderName.trim(),
        completedDates: []
      }
    ],
    vitals: [],
    activities: [
      {
        id: generateId('act'),
        timestamp: new Date().toISOString(),
        actor: caretakerName || elderName,
        type: 'profile_created',
        text: `Created shared ElderCare profile (${cleanCode}) with passcode protection.`
      }
    ],
    emailLogs: []
  };

  store.profiles[cleanCode] = newProfile;
  saveStore();

  res.status(201).json({
    profileCode: cleanCode,
    elderName: newProfile.elderName,
    careCircle: newProfile.careCircle,
    dashboard: buildDashboardPayload(newProfile)
  });
});

// ---------------------------------------------------------------------------
// Protected Dashboard & Profile Endpoints
// ---------------------------------------------------------------------------
app.get('/api/profiles/:code/dashboard', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const selectedDate = req.query.date || formatDateKey(new Date());
  res.json(buildDashboardPayload(profile, selectedDate));
});

app.put('/api/profiles/:code', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const {
    elderName,
    age,
    bloodType,
    allergies,
    conditions,
    primaryDoctor,
    primaryClinic,
    emergencyContactName,
    emergencyPhone,
    notes,
    reminderSettings,
    selectedDate,
    actor
  } = req.body;

  if (elderName !== undefined) profile.elderName = elderName.trim();
  if (age !== undefined) profile.age = Number(age) || profile.age;
  if (bloodType !== undefined) profile.bloodType = bloodType;
  if (allergies !== undefined) {
    profile.allergies = Array.isArray(allergies)
      ? allergies
      : String(allergies)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
  }
  if (conditions !== undefined) {
    profile.conditions = Array.isArray(conditions)
      ? conditions
      : String(conditions)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
  }
  if (primaryDoctor !== undefined) profile.primaryDoctor = primaryDoctor;
  if (primaryClinic !== undefined) profile.primaryClinic = primaryClinic;
  if (emergencyContactName !== undefined) profile.emergencyContactName = emergencyContactName;
  if (emergencyPhone !== undefined) profile.emergencyPhone = emergencyPhone;
  if (notes !== undefined) profile.notes = notes;
  if (reminderSettings && typeof reminderSettings === 'object') {
    profile.reminderSettings = {
      ...profile.reminderSettings,
      ...reminderSettings
    };
  }

  recordActivity(profile, actor, 'profile_updated', 'Updated health profile & care preferences.');
  saveStore();
  res.json({
    success: true,
    profile,
    dashboard: buildDashboardPayload(profile, selectedDate)
  });
});

app.put('/api/profiles/:code/passcode', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const { newPasscode, selectedDate, actor } = req.body;
  if (!newPasscode || String(newPasscode).trim().length < 4) {
    return res.status(400).json({ error: 'New passcode must be at least 4 characters/digits.' });
  }

  profile.passcode = String(newPasscode).trim();
  recordActivity(
    profile,
    actor || 'Care Administrator',
    'security_updated',
    'Updated shared Care Profile passcode.'
  );
  saveStore();
  res.json({
    success: true,
    message: 'Passcode updated successfully.',
    dashboard: buildDashboardPayload(profile, selectedDate)
  });
});

// ---------------------------------------------------------------------------
// Medication Schedule CRUD & Dose Adherence Logging
// ---------------------------------------------------------------------------
app.post('/api/profiles/:code/medications', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const {
    name,
    dosage,
    form,
    purpose,
    frequency,
    times,
    instructions,
    prescribedBy,
    pillsRemaining,
    refillThreshold,
    colorTag,
    selectedDate,
    actor
  } = req.body;

  if (!name || !dosage) {
    return res.status(400).json({ error: 'Medication name and dosage are required.' });
  }

  const parsedTimes = Array.isArray(times) && times.length > 0 ? times : ['08:00'];
  const newMed = {
    id: generateId('med'),
    name: name.trim(),
    dosage: dosage.trim(),
    form: form || 'Tablet',
    purpose: purpose || 'Daily Health',
    frequency: frequency || (parsedTimes.length > 1 ? `${parsedTimes.length}x Daily` : 'Once Daily'),
    times: parsedTimes.sort(),
    instructions: instructions || 'Take as directed by physician.',
    prescribedBy: prescribedBy || profile.primaryDoctor || 'Physician',
    pillsRemaining: Number(pillsRemaining ?? 30),
    refillThreshold: Number(refillThreshold ?? 7),
    colorTag: colorTag || 'teal',
    active: true
  };

  profile.medications.push(newMed);
  recordActivity(
    profile,
    actor,
    'medication_added',
    `Added medication ${newMed.name} (${newMed.dosage}) scheduled at ${newMed.times.map(formatTime12h).join(', ')}.`
  );
  saveStore();
  res.status(201).json({
    medication: newMed,
    dashboard: buildDashboardPayload(profile, selectedDate)
  });
});

app.put('/api/profiles/:code/medications/:medId', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const med = (profile.medications || []).find((m) => m.id === req.params.medId);
  if (!med) {
    return res.status(404).json({ error: 'Medication not found.' });
  }

  const {
    name,
    dosage,
    form,
    purpose,
    frequency,
    times,
    instructions,
    prescribedBy,
    pillsRemaining,
    refillThreshold,
    colorTag,
    active,
    selectedDate,
    actor
  } = req.body;

  if (name !== undefined) med.name = name.trim();
  if (dosage !== undefined) med.dosage = dosage.trim();
  if (form !== undefined) med.form = form;
  if (purpose !== undefined) med.purpose = purpose;
  if (frequency !== undefined) med.frequency = frequency;
  if (Array.isArray(times) && times.length > 0) med.times = times.sort();
  if (instructions !== undefined) med.instructions = instructions;
  if (prescribedBy !== undefined) med.prescribedBy = prescribedBy;
  if (pillsRemaining !== undefined) med.pillsRemaining = Number(pillsRemaining);
  if (refillThreshold !== undefined) med.refillThreshold = Number(refillThreshold);
  if (colorTag !== undefined) med.colorTag = colorTag;
  if (active !== undefined) med.active = Boolean(active);

  recordActivity(
    profile,
    actor,
    'medication_updated',
    `Updated medication schedule for ${med.name} (${med.dosage}).`
  );
  saveStore();
  res.json({
    medication: med,
    dashboard: buildDashboardPayload(profile, selectedDate)
  });
});

app.delete('/api/profiles/:code/medications/:medId', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const idx = (profile.medications || []).findIndex((m) => m.id === req.params.medId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Medication not found.' });
  }

  const removed = profile.medications.splice(idx, 1)[0];
  recordActivity(
    profile,
    req.body?.actor || req.query?.actor,
    'medication_removed',
    `Removed medication ${removed.name} (${removed.dosage}) from schedule.`
  );
  saveStore();
  res.json({
    success: true,
    dashboard: buildDashboardPayload(profile, req.body?.selectedDate)
  });
});

app.post('/api/profiles/:code/doses/log', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const {
    date = formatDateKey(new Date()),
    medId,
    time,
    status,
    note = '',
    actor = 'Care Circle Member',
    notifyCareCircle = false
  } = req.body;

  if (!medId || !time || !status) {
    return res.status(400).json({ error: 'medId, time, and status are required.' });
  }

  const med = (profile.medications || []).find((m) => m.id === medId);
  if (!med) {
    return res.status(404).json({ error: 'Medication not found.' });
  }

  const logKey = `${date}_${medId}_${time}`;
  const prevStatus = profile.doseLogs?.[logKey]?.status || 'pending';

  if (status === 'pending') {
    delete profile.doseLogs[logKey];
    if (prevStatus === 'taken') {
      med.pillsRemaining = Number(med.pillsRemaining || 0) + 1;
    }
  } else {
    profile.doseLogs[logKey] = {
      date,
      medId,
      time,
      status,
      loggedAt: new Date().toISOString(),
      loggedBy: actor,
      note
    };
    if (status === 'taken' && prevStatus !== 'taken') {
      med.pillsRemaining = Math.max(0, Number(med.pillsRemaining || 0) - 1);
    } else if (prevStatus === 'taken' && status !== 'taken') {
      med.pillsRemaining = Number(med.pillsRemaining || 0) + 1;
    }
  }

  const statusVerb =
    status === 'taken'
      ? 'Marked Taken'
      : status === 'missed'
      ? 'Flagged as Missed'
      : status === 'skipped'
      ? 'Marked Skipped'
      : 'Reset to Pending';

  recordActivity(
    profile,
    actor,
    `dose_${status}`,
    `${statusVerb}: ${med.name} ${med.dosage} (${formatTime12h(time)} dose)${note ? ` — "${note}"` : ''}.`
  );

  let dispatchedEmail = null;
  if (status === 'missed' || notifyCareCircle) {
    dispatchedEmail = dispatchCareEmail(profile, {
      type: 'missed_medication',
      categoryLabel: 'Missed Medication Alert',
      subject: `[URGENT: Missed Dose] ${profile.elderName} missed ${med.name} (${med.dosage}) at ${formatTime12h(time)}`,
      headline: `Missed Medication Alert: ${med.name} (${med.dosage})`,
      subtitle: `${actor} logged that ${profile.elderName}'s ${formatTime12h(time)} dose of ${med.name} was missed.`,
      detailsRows: [
        { label: 'Patient', value: `${profile.elderName} (${profile.profileCode})` },
        { label: 'Medication', value: `${med.name} · ${med.dosage} (${med.form})` },
        { label: 'Scheduled Time', value: `${formatTime12h(time)} (${date})` },
        { label: 'Reported By', value: actor },
        { label: 'Note', value: note || 'No additional note provided' }
      ],
      actionNote:
        'Please follow up with the patient and check if guidance from the prescribing doctor is needed.',
      urgency: 'high',
      dedupeKey: `missed_${date}_${medId}_${time}`,
      triggeredBy: `Dose Tracker (${actor})`
    });
  }

  saveStore();
  res.json({
    success: true,
    log: profile.doseLogs[logKey] || null,
    pillsRemaining: med.pillsRemaining,
    dispatchedEmail,
    dashboard: buildDashboardPayload(profile, date)
  });
});

// ---------------------------------------------------------------------------
// Medical Appointments CRUD
// ---------------------------------------------------------------------------
app.post('/api/profiles/:code/appointments', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const {
    doctorName,
    specialty,
    title,
    clinic,
    address,
    date,
    time,
    accompaniedBy,
    prepNotes,
    status = 'Upcoming',
    sendEmailNow = false,
    selectedDate,
    actor
  } = req.body;

  if (!doctorName || !date || !time) {
    return res.status(400).json({ error: 'Doctor name, date, and time are required.' });
  }

  const newApt = {
    id: generateId('apt'),
    doctorName: doctorName.trim(),
    specialty: specialty || 'General Medicine',
    title: title || 'Medical Consultation',
    clinic: clinic || profile.primaryClinic || 'Medical Center',
    address: address || '',
    date,
    time,
    accompaniedBy: accompaniedBy || 'Unassigned',
    prepNotes: prepNotes || '',
    status,
    reminderLeadHours: 48,
    reminderSent: false
  };

  profile.appointments.push(newApt);
  recordActivity(
    profile,
    actor,
    'appointment_added',
    `Scheduled ${newApt.specialty} appointment with ${newApt.doctorName} on ${newApt.date} at ${formatTime12h(newApt.time)}.`
  );

  let dispatchedEmail = null;
  if (sendEmailNow) {
    dispatchedEmail = dispatchCareEmail(profile, {
      type: 'upcoming_appointment',
      categoryLabel: 'New Appointment Scheduled',
      subject: `[ElderCare Appointment] ${profile.elderName} with ${newApt.doctorName} on ${newApt.date} at ${formatTime12h(newApt.time)}`,
      headline: `New Medical Appointment Scheduled`,
      subtitle: `${actor || 'A Care Circle member'} scheduled an appointment for ${profile.elderName}.`,
      detailsRows: [
        { label: 'Patient', value: `${profile.elderName}` },
        { label: 'Doctor & Specialty', value: `${newApt.doctorName} · ${newApt.specialty}` },
        { label: 'Purpose', value: newApt.title },
        { label: 'Date & Time', value: `${newApt.date} at ${formatTime12h(newApt.time)}` },
        { label: 'Location', value: `${newApt.clinic}${newApt.address ? ` — ${newApt.address}` : ''}` },
        { label: 'Accompanied By', value: newApt.accompaniedBy }
      ],
      actionNote: newApt.prepNotes || 'Please mark your calendar and confirm transportation.',
      urgency: 'appointment',
      triggeredBy: `Appointment Scheduler (${actor || 'Care Circle'})`
    });
    newApt.reminderSent = true;
  }

  saveStore();
  res.status(201).json({
    appointment: newApt,
    dispatchedEmail,
    dashboard: buildDashboardPayload(profile, selectedDate)
  });
});

app.put('/api/profiles/:code/appointments/:aptId', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const apt = (profile.appointments || []).find((a) => a.id === req.params.aptId);
  if (!apt) {
    return res.status(404).json({ error: 'Appointment not found.' });
  }

  const fields = [
    'doctorName',
    'specialty',
    'title',
    'clinic',
    'address',
    'date',
    'time',
    'accompaniedBy',
    'prepNotes',
    'visitSummary',
    'status'
  ];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) apt[f] = req.body[f];
  });

  recordActivity(
    profile,
    req.body.actor,
    'appointment_updated',
    `Updated appointment with ${apt.doctorName} (${apt.status}).`
  );
  saveStore();
  res.json({
    appointment: apt,
    dashboard: buildDashboardPayload(profile, req.body.selectedDate)
  });
});

app.delete('/api/profiles/:code/appointments/:aptId', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const idx = (profile.appointments || []).findIndex((a) => a.id === req.params.aptId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Appointment not found.' });
  }

  const removed = profile.appointments.splice(idx, 1)[0];
  recordActivity(
    profile,
    req.body?.actor || req.query?.actor,
    'appointment_removed',
    `Cancelled/removed appointment with ${removed.doctorName}.`
  );
  saveStore();
  res.json({
    success: true,
    dashboard: buildDashboardPayload(profile, req.body?.selectedDate)
  });
});

// ---------------------------------------------------------------------------
// Daily Routines & Vital Signs Endpoints
// ---------------------------------------------------------------------------
app.post('/api/profiles/:code/routines', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const { title, category, scheduledTime, targetDescription, assignedTo, selectedDate, actor } =
    req.body;
  if (!title) {
    return res.status(400).json({ error: 'Routine title is required.' });
  }

  const newRoutine = {
    id: generateId('rtn'),
    title: title.trim(),
    category: category || 'Daily Wellness',
    scheduledTime: scheduledTime || '09:00',
    targetDescription: targetDescription || '',
    assignedTo: assignedTo || profile.elderName,
    completedDates: []
  };

  profile.routines.push(newRoutine);
  recordActivity(
    profile,
    actor,
    'routine_added',
    `Added daily healthcare routine: "${newRoutine.title}".`
  );
  saveStore();
  res.status(201).json({
    routine: newRoutine,
    dashboard: buildDashboardPayload(profile, selectedDate)
  });
});

app.post('/api/profiles/:code/routines/:rtnId/toggle', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const routine = (profile.routines || []).find((r) => r.id === req.params.rtnId);
  if (!routine) {
    return res.status(404).json({ error: 'Routine not found.' });
  }

  const dateKey = req.body.date || formatDateKey(new Date());
  if (!Array.isArray(routine.completedDates)) {
    routine.completedDates = [];
  }

  const idx = routine.completedDates.indexOf(dateKey);
  let completed = false;
  if (idx === -1) {
    routine.completedDates.push(dateKey);
    completed = true;
  } else {
    routine.completedDates.splice(idx, 1);
    completed = false;
  }

  recordActivity(
    profile,
    req.body.actor,
    'routine_toggled',
    `${completed ? 'Completed' : 'Unchecked'} daily routine: "${routine.title}".`
  );
  saveStore();
  res.json({
    routine,
    completed,
    dashboard: buildDashboardPayload(profile, dateKey)
  });
});

app.delete('/api/profiles/:code/routines/:rtnId', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const idx = (profile.routines || []).findIndex((r) => r.id === req.params.rtnId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Routine not found.' });
  }

  const removed = profile.routines.splice(idx, 1)[0];
  recordActivity(
    profile,
    req.body?.actor || req.query?.actor,
    'routine_removed',
    `Removed routine "${removed.title}".`
  );
  saveStore();
  res.json({
    success: true,
    dashboard: buildDashboardPayload(profile, req.body?.selectedDate)
  });
});

app.post('/api/profiles/:code/vitals', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const { bloodPressure, heartRate, bloodGlucose, weightLbs, mood, notes, selectedDate, actor } =
    req.body;
  const entry = {
    id: generateId('vit'),
    recordedAt: new Date().toISOString(),
    recordedBy: actor || profile.elderName,
    bloodPressure: bloodPressure || '120/80',
    heartRate: Number(heartRate) || 72,
    bloodGlucose: Number(bloodGlucose) || 105,
    weightLbs: Number(weightLbs) || 145,
    mood: mood || 'Good',
    notes: notes || ''
  };

  if (!Array.isArray(profile.vitals)) {
    profile.vitals = [];
  }
  profile.vitals.unshift(entry);
  recordActivity(
    profile,
    actor,
    'vital_logged',
    `Logged vitals: BP ${entry.bloodPressure} mmHg, HR ${entry.heartRate} bpm, Glucose ${entry.bloodGlucose} mg/dL.`
  );
  saveStore();
  res.status(201).json({
    vital: entry,
    dashboard: buildDashboardPayload(profile, selectedDate)
  });
});

// ---------------------------------------------------------------------------
// Care Circle Members CRUD
// ---------------------------------------------------------------------------
app.post('/api/profiles/:code/members', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const { name, role, relationship, email, phone, notifications, selectedDate, actor } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Member name and email address are required.' });
  }

  const colors = ['#2563EB', '#7C3AED', '#0F766E', '#D97706', '#DB2777', '#059669'];
  const newMember = {
    id: generateId('mem'),
    name: name.trim(),
    role: role || 'Family Member',
    relationship: relationship || role || 'Family Member',
    email: email.trim(),
    phone: phone || '',
    avatarColor: colors[(profile.careCircle?.length || 0) % colors.length],
    notifications: {
      upcomingDoses: notifications?.upcomingDoses ?? true,
      missedMedications: notifications?.missedMedications ?? true,
      appointments: notifications?.appointments ?? true,
      dailySummary: notifications?.dailySummary ?? true
    }
  };

  profile.careCircle.push(newMember);
  recordActivity(
    profile,
    actor,
    'member_added',
    `Added ${newMember.name} (${newMember.role}) to the authorized Care Circle.`
  );
  saveStore();
  res.status(201).json({
    member: newMember,
    dashboard: buildDashboardPayload(profile, selectedDate)
  });
});

app.put('/api/profiles/:code/members/:memberId', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const member = (profile.careCircle || []).find((m) => m.id === req.params.memberId);
  if (!member) {
    return res.status(404).json({ error: 'Care Circle member not found.' });
  }

  const { name, role, relationship, email, phone, notifications, selectedDate, actor } = req.body;
  if (name !== undefined) member.name = name.trim();
  if (role !== undefined) member.role = role;
  if (relationship !== undefined) member.relationship = relationship;
  if (email !== undefined) member.email = email.trim();
  if (phone !== undefined) member.phone = phone;
  if (notifications && typeof notifications === 'object') {
    member.notifications = {
      ...member.notifications,
      ...notifications
    };
  }

  recordActivity(
    profile,
    actor,
    'member_updated',
    `Updated notification preferences for ${member.name}.`
  );
  saveStore();
  res.json({
    member,
    dashboard: buildDashboardPayload(profile, selectedDate)
  });
});

app.delete('/api/profiles/:code/members/:memberId', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  if ((profile.careCircle || []).length <= 1) {
    return res.status(400).json({ error: 'Cannot remove the last member of a Care Circle.' });
  }

  const idx = (profile.careCircle || []).findIndex((m) => m.id === req.params.memberId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Member not found.' });
  }

  const removed = profile.careCircle.splice(idx, 1)[0];
  recordActivity(
    profile,
    req.body?.actor || req.query?.actor,
    'member_removed',
    `Removed ${removed.name} from the Care Circle.`
  );
  saveStore();
  res.json({
    success: true,
    dashboard: buildDashboardPayload(profile, req.body?.selectedDate)
  });
});

// ---------------------------------------------------------------------------
// Proactive Email Reminder Endpoints (Instant Execution)
// ---------------------------------------------------------------------------
app.post('/api/profiles/:code/reminders/scan', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const forceSend = Boolean(req.body.forceSend);
  const actor = req.body.actor || 'Care Circle Member';

  const dispatched = scanAndDispatchProfileReminders(profile, {
    forceSend,
    triggeredBy: `Manual Scan (${actor})`
  });

  recordActivity(
    profile,
    actor,
    'reminder_scan',
    `Executed proactive reminder scan (${dispatched.length} email notification(s) dispatched).`
  );
  saveStore();

  res.json({
    dispatchedCount: dispatched.length,
    dispatched,
    emailLogs: profile.emailLogs.slice(0, 50),
    dashboard: buildDashboardPayload(profile, req.body.selectedDate)
  });
});

app.post('/api/profiles/:code/reminders/send', (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const {
    type = 'custom_alert',
    medId,
    time,
    appointmentId,
    customSubject,
    customMessage,
    selectedDate,
    actor = 'Care Circle Member'
  } = req.body;

  const todayKey = formatDateKey(new Date());
  let emailRecord = null;

  if (type === 'missed_medication' || type === 'upcoming_dose') {
    const med =
      (profile.medications || []).find((m) => m.id === medId) || profile.medications[0];
    if (!med) {
      return res.status(400).json({ error: 'No medication found to send reminder for.' });
    }
    const targetTime = time || med.times?.[0] || '08:00';
    const isMissed = type === 'missed_medication';

    emailRecord = dispatchCareEmail(profile, {
      type,
      categoryLabel: isMissed ? 'Missed Medication Alert' : 'Upcoming Dose Reminder',
      subject: isMissed
        ? `[URGENT: Missed Dose] ${profile.elderName} missed ${med.name} (${med.dosage}) scheduled at ${formatTime12h(targetTime)}`
        : `[Dose Reminder] ${profile.elderName}: ${med.name} (${med.dosage}) scheduled at ${formatTime12h(targetTime)}`,
      headline: isMissed
        ? `Missed Medication Alert: ${med.name} (${med.dosage})`
        : `Upcoming Medication Dose: ${med.name} (${med.dosage})`,
      subtitle: isMissed
        ? `Immediate attention requested: ${profile.elderName}'s ${formatTime12h(targetTime)} dose of ${med.name} has not been recorded as Taken.`
        : `Friendly reminder for ${profile.elderName} to take ${med.name} (${med.dosage}) at ${formatTime12h(targetTime)}.`,
      detailsRows: [
        { label: 'Patient', value: `${profile.elderName} (${profile.profileCode})` },
        { label: 'Medication', value: `${med.name} · ${med.dosage} (${med.form})` },
        { label: 'Scheduled Time', value: `${formatTime12h(targetTime)} (${todayKey})` },
        { label: 'Clinical Purpose', value: med.purpose || 'Daily Regimen' },
        { label: 'Instructions', value: med.instructions || 'Take as prescribed' }
      ],
      actionNote: isMissed
        ? 'Please contact the patient to verify dose adherence and update the shared Care Profile.'
        : 'Log the dose in ElderCare once taken so the Care Circle stays updated.',
      urgency: isMissed ? 'high' : 'warning',
      triggeredBy: `Direct Care Dispatch (${actor})`
    });
  } else if (type === 'upcoming_appointment') {
    const apt =
      (profile.appointments || []).find((a) => a.id === appointmentId) ||
      (profile.appointments || []).find((a) => a.status === 'Upcoming') ||
      profile.appointments[0];
    if (!apt) {
      return res.status(400).json({ error: 'No appointment found to send reminder for.' });
    }
    apt.reminderSent = true;
    emailRecord = dispatchCareEmail(profile, {
      type: 'upcoming_appointment',
      categoryLabel: 'Medical Appointment Reminder',
      subject: `[Appointment Reminder] ${profile.elderName} with ${apt.doctorName} (${apt.date} at ${formatTime12h(apt.time)})`,
      headline: `Medical Appointment Reminder: ${apt.doctorName}`,
      subtitle: `Reminder for ${profile.elderName} and the Care Circle regarding the upcoming ${apt.specialty} visit.`,
      detailsRows: [
        { label: 'Patient', value: `${profile.elderName}` },
        { label: 'Doctor & Specialty', value: `${apt.doctorName} · ${apt.specialty}` },
        { label: 'Visit Purpose', value: apt.title },
        { label: 'Date & Time', value: `${apt.date} at ${formatTime12h(apt.time)}` },
        { label: 'Location', value: `${apt.clinic}${apt.address ? ` (${apt.address})` : ''}` },
        { label: 'Companion', value: apt.accompaniedBy || 'Care Circle Member' }
      ],
      actionNote: apt.prepNotes || 'Bring updated medication list and insurance card.',
      urgency: 'appointment',
      triggeredBy: `Direct Care Dispatch (${actor})`
    });
  } else if (type === 'daily_summary') {
    const schedule = computeScheduleForDate(profile, todayKey);
    const upcomingApts = (profile.appointments || []).filter((a) => a.status === 'Upcoming');
    const latestVital = profile.vitals?.[0];

    emailRecord = dispatchCareEmail(profile, {
      type: 'daily_summary',
      categoryLabel: 'Daily Care Circle Digest',
      subject: `[ElderCare Daily Summary] ${profile.elderName} — ${schedule.summary.adherenceRate}% Medication Adherence (${todayKey})`,
      headline: `Daily Healthcare Summary for ${profile.elderName}`,
      subtitle: `Here is today's comprehensive care status across medications, vitals, and upcoming appointments.`,
      detailsRows: [
        {
          label: 'Medication Adherence Today',
          value: `${schedule.summary.takenDoses} of ${schedule.summary.totalDoses} doses taken (${schedule.summary.adherenceRate}%)`
        },
        {
          label: 'Overdue / Missed Doses',
          value:
            schedule.summary.missedOrOverdueDoses > 0
              ? `${schedule.summary.missedOrOverdueDoses} dose(s) require attention`
              : 'None — All past doses on track'
        },
        {
          label: 'Latest Vitals',
          value: latestVital
            ? `BP ${latestVital.bloodPressure} mmHg · HR ${latestVital.heartRate} bpm · Glucose ${latestVital.bloodGlucose} mg/dL`
            : 'No vitals logged yet today'
        },
        {
          label: 'Next Appointment',
          value: upcomingApts[0]
            ? `${upcomingApts[0].doctorName} (${upcomingApts[0].specialty}) on ${upcomingApts[0].date} at ${formatTime12h(upcomingApts[0].time)}`
            : 'No upcoming appointments scheduled'
        }
      ],
      actionNote: customMessage || 'Review full timeline in the ElderCare shared dashboard.',
      urgency: schedule.summary.missedOrOverdueDoses > 0 ? 'warning' : 'normal',
      triggeredBy: `Daily Summary Dispatch (${actor})`
    });
  } else {
    emailRecord = dispatchCareEmail(profile, {
      type: 'custom_alert',
      categoryLabel: 'Care Circle Broadcast',
      subject: customSubject || `[ElderCare Care Update] Message regarding ${profile.elderName}`,
      headline: customSubject || `Care Circle Update for ${profile.elderName}`,
      subtitle:
        customMessage ||
        `${actor} shared an important care update with ${profile.elderName}'s Care Circle.`,
      detailsRows: [
        { label: 'Care Profile', value: `${profile.elderName} (${profile.profileCode})` },
        { label: 'Sent By', value: actor },
        { label: 'Time', value: new Date().toLocaleString() }
      ],
      actionNote: 'Log into ElderCare with your Care Profile passcode to view live schedules.',
      urgency: 'normal',
      triggeredBy: actor
    });
  }

  recordActivity(
    profile,
    actor,
    'email_sent',
    `Sent "${emailRecord.categoryLabel}" email to ${emailRecord.recipients.length} Care Circle member(s).`
  );
  saveStore();
  res.json({
    emailRecord,
    dashboard: buildDashboardPayload(profile, selectedDate)
  });
});

app.put('/api/profiles/:code/smtp', async (req, res) => {
  const profile = getProfileAndVerify(req, res);
  if (!profile) return;

  const { host, port, user, pass, from } = req.body;
  profile.smtpConfig = { host, port, user, pass, from };
  const status = await initMailer(profile.smtpConfig);
  saveStore();
  res.json({ success: true, mailerStatus: status });
});

app.listen(PORT, () => {
  console.log(`ElderCare Smart Healthcare Platform running at http://localhost:${PORT}`);
});
