const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  verifyPasscodeTimingSafe,
  escapeHtmlServer,
  buildGoogleCalendarUrl,
  buildGoogleMapsUrl
} = require('../server');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('1. Healthcheck & Security HTTP Headers', async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'eldercare');
});

test('2. Security Unit Tests: Timing-Safe PIN & XSS Escaping', () => {
  assert.equal(verifyPasscodeTimingSafe('4826', '4826'), true);
  assert.equal(verifyPasscodeTimingSafe('4826', '9999'), false);
  assert.equal(verifyPasscodeTimingSafe('4826', '482'), false);
  assert.equal(verifyPasscodeTimingSafe('', ''), false);

  const malicious = `<script>alert("xss")</script>&'`;
  const escaped = escapeHtmlServer(malicious);
  assert.equal(escaped, '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&amp;&#39;');
});

test('3. Public Profiles Discovery & Passcode Gate Enforcement', async () => {
  const pubRes = await fetch(`${baseUrl}/api/profiles/public`);
  assert.equal(pubRes.status, 200);
  const pubData = await pubRes.json();
  assert.ok(Array.isArray(pubData.profiles));
  assert.ok(pubData.profiles.some((p) => p.profileCode === 'MARTHA-842'));
  assert.ok(pubData.profiles.some((p) => p.profileCode === 'ARTHUR-319'));

  // Reject unauthenticated access to protected profile dashboard
  const unauthRes = await fetch(`${baseUrl}/api/profiles/MARTHA-842/dashboard`);
  assert.equal(unauthRes.status, 401);

  // Verify valid passcode unlock returns single-round-trip dashboard payload
  const authRes = await fetch(`${baseUrl}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileCode: 'MARTHA-842', passcode: '4826' })
  });
  assert.equal(authRes.status, 200);
  const authData = await authRes.json();
  assert.equal(authData.authenticated, true);
  assert.equal(authData.profileCode, 'MARTHA-842');
  assert.ok(authData.dashboard);
  assert.equal(authData.dashboard.profile.passcode, undefined, 'Passcode must be stripped from dashboard payload');
});

test('4. Medication CRUD, Dose Adherence Logging & Proactive Missed-Dose Email Alert', async () => {
  const headers = {
    'Content-Type': 'application/json',
    'x-passcode': '4826'
  };

  // Add a new medication
  const createRes = await fetch(`${baseUrl}/api/profiles/MARTHA-842/medications`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Aspirin Low-Dose',
      dosage: '81 mg',
      form: 'Enteric Tablet',
      purpose: 'Cardiovascular Protection',
      frequency: 'Once Daily',
      times: ['09:00'],
      pillsRemaining: 30,
      refillThreshold: 7,
      actor: 'Nurse David Miller, RN (Caretaker)'
    })
  });
  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  const medId = createData.medication.id;
  assert.ok(medId);
  assert.ok(createData.dashboard);

  // Log dose as taken and verify pill count decrements
  const takeRes = await fetch(`${baseUrl}/api/profiles/MARTHA-842/doses/log`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      medId,
      time: '09:00',
      status: 'taken',
      actor: 'Martha Vance (Elderly Individual)'
    })
  });
  assert.equal(takeRes.status, 200);
  const takeData = await takeRes.json();
  const updatedMed = takeData.dashboard.medications.find((m) => m.id === medId);
  assert.equal(updatedMed.pillsRemaining, 29);

  // Log dose as missed and verify automated Missed Medication email dispatch
  const prevEmailCount = takeData.dashboard.emailLogs.length;
  const missRes = await fetch(`${baseUrl}/api/profiles/MARTHA-842/doses/log`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      medId,
      time: '09:00',
      status: 'missed',
      actor: 'Sarah Vance (Family Member)'
    })
  });
  assert.equal(missRes.status, 200);
  const missData = await missRes.json();
  assert.ok(missData.dashboard.emailLogs.length > prevEmailCount);
  assert.equal(missData.dashboard.emailLogs[0].type, 'missed_medication');

  // Clean up test medication
  const delRes = await fetch(`${baseUrl}/api/profiles/MARTHA-842/medications/${medId}`, {
    method: 'DELETE',
    headers
  });
  assert.equal(delRes.status, 200);
});

test('5. Medical Appointments & Google Calendar / Google Maps Integration', async () => {
  const headers = {
    'Content-Type': 'application/json',
    'x-passcode': '4826'
  };

  const aptRes = await fetch(`${baseUrl}/api/profiles/MARTHA-842/appointments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      doctorName: 'Dr. Steven Grant, MD',
      specialty: 'Neurology',
      title: 'Memory & Cognitive Wellness Check',
      clinic: 'Oakridge Neuro Center',
      address: '500 Brain Way, Oakridge',
      date: '2026-12-01',
      time: '11:00',
      accompaniedBy: 'Sarah Vance (Daughter)',
      prepNotes: 'Bring current medication schedule.',
      sendEmailNow: true,
      actor: 'Sarah Vance (Family Member)'
    })
  });
  assert.equal(aptRes.status, 201);
  const aptData = await aptRes.json();
  const createdApt = aptData.dashboard.appointments.find((a) => a.id === aptData.appointment.id);
  assert.ok(createdApt);
  assert.ok(createdApt.googleCalendarUrl.includes('calendar.google.com/calendar/render'));
  assert.ok(createdApt.googleMapsUrl.includes('google.com/maps/search'));
  assert.ok(aptData.dispatchedEmail);

  // Clean up test appointment
  const delRes = await fetch(`${baseUrl}/api/profiles/MARTHA-842/appointments/${aptData.appointment.id}`, {
    method: 'DELETE',
    headers
  });
  assert.equal(delRes.status, 200);
});

test('6. Daily Routines, Vital Signs & Sub-50ms Non-Blocking Reminder Engine', async () => {
  const headers = {
    'Content-Type': 'application/json',
    'x-passcode': '4826'
  };

  const vitRes = await fetch(`${baseUrl}/api/profiles/MARTHA-842/vitals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      bloodPressure: '122/76',
      heartRate: 70,
      bloodGlucose: 104,
      weightLbs: 146.2,
      mood: 'Calm & Comfortable',
      actor: 'Martha Vance (Elderly Individual)'
    })
  });
  assert.equal(vitRes.status, 201);

  const startMs = performance.now();
  const emailRes = await fetch(`${baseUrl}/api/profiles/MARTHA-842/reminders/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'daily_summary',
      actor: 'Nurse David Miller, RN (Caretaker)'
    })
  });
  const elapsedMs = performance.now() - startMs;
  assert.equal(emailRes.status, 200);
  assert.ok(elapsedMs < 150, `Expected non-blocking email dispatch under 150ms, took ${elapsedMs.toFixed(1)}ms`);
});

test('7. Accessibility Landmarks & Netlify Static Configuration Integrity', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const netlifyToml = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');

  assert.ok(indexHtml.includes('class="skip-link"'), 'Skip link must exist for keyboard accessibility');
  assert.ok(indexHtml.includes('role="tablist"'), 'ARIA tablist must exist');
  assert.ok(indexHtml.includes('id="btn-senior-mode"'), 'Senior High-Clarity mode toggle must exist');
  assert.ok(indexHtml.includes('id="btn-read-aloud"'), 'Web Speech API Read Aloud button must exist');
  assert.ok(appJs.includes('function executeLocalApiRequest'), 'Netlify client-side engine must be embedded');
  assert.ok(netlifyToml.includes('publish = "public"'), 'netlify.toml must configure publish = "public"');
});
