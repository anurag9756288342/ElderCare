/* =========================================================================
   ElderCare — Smart Interconnected Healthcare Management Platform
   High-Speed & Responsive Frontend Controller
   ========================================================================= */

const state = {
  publicProfiles: [],
  activeProfileCode: sessionStorage.getItem('eldercare_profile_code') || '',
  activePasscode: sessionStorage.getItem('eldercare_passcode') || '',
  activeActor: sessionStorage.getItem('eldercare_actor') || 'Martha Vance (Elderly Individual)',
  selectedDate: getTodayDateString(),
  activeTab: 'overview',
  aptFilter: 'all',
  emailFilter: 'all',
  passcodeRevealed: false,
  seniorMode: localStorage.getItem('eldercare_senior_mode') === 'true',
  dashboard: null
};

function getTodayDateString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime12h(time24) {
  if (!time24) return '';
  const [hStr, mStr] = String(time24).split(':');
  let h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return time24;
  const m = mStr || '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function formatDateReadable(dateStr) {
  if (!dateStr) return '';
  const today = getTodayDateString();
  if (dateStr === today) return `Today (${dateStr})`;
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function formatTimestampRelative(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return isoStr;
  return (
    d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit'
    }) +
    ' · ' +
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );
}

function getInitials(name) {
  if (!name) return 'EC';
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}

function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast-item${isError ? ' toast-error' : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3200);
}

// ---------------------------------------------------------------------------
// Fast Single-Round-Trip API Helper
// ---------------------------------------------------------------------------
async function apiRequest(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (state.activePasscode) {
    headers['x-passcode'] = state.activePasscode;
  }

  const res = await fetch(path, {
    ...options,
    headers
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.requiresPasscode) {
      lockProfile(false);
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  // If the server already returned the updated dashboard payload, apply it immediately!
  if (data && data.dashboard) {
    state.dashboard = data.dashboard;
    renderAllSections();
  }

  return data;
}

// ---------------------------------------------------------------------------
// Initialization & Public Profiles Loading
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  applySeniorModeUI();
  bindGlobalEvents();

  const dateInput = document.getElementById('med-schedule-date');
  if (dateInput) dateInput.value = state.selectedDate;

  loadPublicProfiles();

  if (state.activeProfileCode && state.activePasscode) {
    try {
      await fetchDashboardAndRender();
      showAppShell();
    } catch (err) {
      lockProfile(false);
    }
  }
});

async function loadPublicProfiles() {
  try {
    const data = await apiRequest('/api/profiles/public');
    state.publicProfiles = data.profiles || [];
    renderPublicProfilesList();
  } catch (err) {
    console.error('Failed to load public profiles:', err);
  }
}

function renderPublicProfilesList() {
  const container = document.getElementById('public-profiles-list');
  if (!container) return;

  const currentCode = (
    document.getElementById('auth-profile-code')?.value || 'MARTHA-842'
  ).toUpperCase();

  container.innerHTML = state.publicProfiles
    .map((prof) => {
      const isSelected = prof.profileCode === currentCode;
      return `
        <div class="public-profile-card ${isSelected ? 'selected' : ''}" data-select-profile="${escapeHtml(prof.profileCode)}" data-demo-pin="${escapeHtml(prof.demoPasscodeHint || '')}">
          <div class="prof-card-left">
            <div class="prof-avatar">${escapeHtml(getInitials(prof.elderName))}</div>
            <div>
              <div class="prof-card-name">${escapeHtml(prof.elderName)} <span class="prof-card-code">${escapeHtml(prof.profileCode)}</span></div>
              <div class="prof-card-meta">Age ${escapeHtml(prof.age)} · ${escapeHtml(prof.memberCount)} Care Circle Members · PIN: <strong>${escapeHtml(prof.demoPasscodeHint || '4826')}</strong></div>
            </div>
          </div>
          <button type="button" class="btn btn-teal-soft btn-xs" data-instant-unlock="${escapeHtml(prof.profileCode)}" data-instant-pin="${escapeHtml(prof.demoPasscodeHint || '4826')}">
            Quick Unlock →
          </button>
        </div>
      `;
    })
    .join('');

  updateAuthMemberDropdown(currentCode);
}

function updateAuthMemberDropdown(profileCode) {
  const selectEl = document.getElementById('auth-member-select');
  const pinHintEl = document.getElementById('auth-pin-hint');
  if (!selectEl) return;

  const prof = state.publicProfiles.find(
    (p) => p.profileCode.toUpperCase() === String(profileCode).toUpperCase()
  );

  if (prof && pinHintEl) {
    pinHintEl.textContent = `Demo PIN: ${prof.demoPasscodeHint || '4826'}`;
  }

  if (prof && Array.isArray(prof.membersPreview) && prof.membersPreview.length > 0) {
    selectEl.innerHTML = prof.membersPreview
      .map((m) => {
        const val = `${m.name} (${m.role})`;
        return `<option value="${escapeHtml(val)}">${escapeHtml(m.name)} — ${escapeHtml(m.role)}</option>`;
      })
      .join('');
  }
}

// ---------------------------------------------------------------------------
// Single-Round-Trip Authentication & Unlock Flow
// ---------------------------------------------------------------------------
async function attemptUnlock(profileCode, passcode, selectedActor) {
  const errEl = document.getElementById('auth-error-msg');
  if (errEl) errEl.classList.add('hidden');

  try {
    const cleanCode = String(profileCode || '').toUpperCase().trim();
    const cleanPin = String(passcode || '').trim();

    state.activeProfileCode = cleanCode;
    state.activePasscode = cleanPin;
    if (selectedActor) {
      state.activeActor = selectedActor;
    }

    // /api/auth/verify returns the complete dashboard payload in 1 single request!
    await apiRequest('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({
        profileCode: cleanCode,
        passcode: cleanPin,
        date: state.selectedDate
      })
    });

    sessionStorage.setItem('eldercare_profile_code', state.activeProfileCode);
    sessionStorage.setItem('eldercare_passcode', state.activePasscode);
    sessionStorage.setItem('eldercare_actor', state.activeActor);

    showAppShell();
    showToast(`Unlocked ${state.dashboard?.profile?.elderName}'s Care Profile`);
  } catch (err) {
    state.activePasscode = '';
    if (errEl) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } else {
      showToast(err.message, true);
    }
  }
}

function showAppShell() {
  document.getElementById('auth-gate')?.classList.add('hidden');
  document.getElementById('app-shell')?.classList.remove('hidden');
}

function lockProfile(notify = true) {
  state.activePasscode = '';
  sessionStorage.removeItem('eldercare_passcode');
  document.getElementById('app-shell')?.classList.add('hidden');
  document.getElementById('auth-gate')?.classList.remove('hidden');
  const pinInput = document.getElementById('auth-passcode-input');
  if (pinInput) pinInput.value = '';
  loadPublicProfiles();
  if (notify) {
    showToast('Care Profile locked securely.');
  }
}

// ---------------------------------------------------------------------------
// Fetch & Render Full Dashboard
// ---------------------------------------------------------------------------
async function fetchDashboardAndRender() {
  if (!state.activeProfileCode || !state.activePasscode) return;
  const data = await apiRequest(
    `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/dashboard?date=${encodeURIComponent(state.selectedDate)}`
  );
  state.dashboard = data;
  renderAllSections();
}

function renderAllSections() {
  const d = state.dashboard;
  if (!d) return;

  renderHeader(d);
  renderOverviewTab(d);
  renderMedicationsTab(d);
  renderAppointmentsTab(d);
  renderRoutinesAndVitalsTab(d);
  renderCareCircleAndEmailsTab(d);
}

// ---------------------------------------------------------------------------
// Header & Navigation Badges
// ---------------------------------------------------------------------------
function renderHeader(d) {
  const { profile, careCircle, todaySummary, appointments, emailLogs } = d;

  document.getElementById('header-profile-code').textContent = profile.profileCode;
  document.getElementById('header-elder-subtitle').textContent =
    `${profile.elderName} · ${profile.age} yrs · Primary: ${profile.primaryDoctor}`;

  const actorSelect = document.getElementById('active-actor-select');
  if (actorSelect) {
    const options = (careCircle || []).map((m) => `${m.name} (${m.role})`);
    if (!options.includes(state.activeActor) && options.length > 0) {
      state.activeActor = options[0];
      sessionStorage.setItem('eldercare_actor', state.activeActor);
    }
    actorSelect.innerHTML = options
      .map(
        (opt) =>
          `<option value="${escapeHtml(opt)}" ${opt === state.activeActor ? 'selected' : ''}>${escapeHtml(opt)}</option>`
      )
      .join('');
  }

  const emailCount = (emailLogs || []).length;
  document.getElementById('header-email-count').textContent =
    `${emailCount} Reminder Email${emailCount === 1 ? '' : 's'} Sent`;

  const navBadgeMeds = document.getElementById('nav-badge-meds');
  if (navBadgeMeds) {
    const overdueCount = todaySummary?.missedOrOverdueDoses || 0;
    if (overdueCount > 0) {
      navBadgeMeds.textContent = `${overdueCount} Overdue`;
      navBadgeMeds.classList.remove('hidden');
    } else {
      navBadgeMeds.classList.add('hidden');
    }
  }

  const upcomingAptCount = (appointments || []).filter((a) => a.status === 'Upcoming').length;
  const navBadgeApts = document.getElementById('nav-badge-apts');
  if (navBadgeApts) {
    navBadgeApts.textContent = String(upcomingAptCount);
  }

  const navBadgeEmails = document.getElementById('nav-badge-emails');
  if (navBadgeEmails) {
    navBadgeEmails.textContent = String(emailCount);
  }
}

// ---------------------------------------------------------------------------
// Tab 1: Overview & Today's Care
// ---------------------------------------------------------------------------
function renderOverviewTab(d) {
  const {
    profile,
    careCircle,
    schedule,
    todaySummary,
    weeklyAdherence,
    appointments,
    routines,
    vitals,
    activities,
    emailLogs
  } = d;

  document.getElementById('patient-avatar').textContent = getInitials(profile.elderName);
  document.getElementById('overview-elder-name').textContent = profile.elderName;
  document.getElementById('overview-blood-badge').textContent = `Blood Type: ${profile.bloodType || 'O+'}`;
  document.getElementById('overview-age-badge').textContent = `Age ${profile.age}`;
  document.getElementById('overview-primary-doc').textContent = profile.primaryDoctor || 'Not set';
  document.getElementById('overview-emergency').textContent =
    `${profile.emergencyContactName || 'Care Circle'} · ${profile.emergencyPhone || ''}`;

  const allergiesEl = document.getElementById('overview-allergies-list');
  if (allergiesEl) {
    allergiesEl.innerHTML =
      (profile.allergies || []).length > 0
        ? profile.allergies
            .map((a) => `<span class="tag-allergy">${escapeHtml(a)}</span>`)
            .join('')
        : `<span class="clinical-pill">No Known Allergies</span>`;
  }

  const conditionsEl = document.getElementById('overview-conditions-list');
  if (conditionsEl) {
    conditionsEl.innerHTML =
      (profile.conditions || []).length > 0
        ? profile.conditions
            .map((c) => `<span class="tag-condition">${escapeHtml(c)}</span>`)
            .join('')
        : `<span class="clinical-pill">General Senior Wellness</span>`;
  }

  const overdueBanner = document.getElementById('overdue-alert-banner');
  const overdueSlots = (schedule?.slots || []).filter(
    (s) => s.status === 'overdue' || s.status === 'missed'
  );
  if (overdueBanner) {
    if (overdueSlots.length > 0) {
      const firstOverdue = overdueSlots[0];
      overdueBanner.classList.remove('hidden');
      overdueBanner.innerHTML = `
        <div class="overdue-alert-info">
          <h3>Attention Needed: ${overdueSlots.length} Scheduled Medication Dose${overdueSlots.length > 1 ? 's' : ''} Overdue Today</h3>
          <p><strong>${escapeHtml(firstOverdue.medName)} (${escapeHtml(firstOverdue.dosage)})</strong> scheduled for <strong>${escapeHtml(firstOverdue.timeFormatted)}</strong> has not been marked as Taken. Instructions: ${escapeHtml(firstOverdue.instructions)}</p>
        </div>
        <div class="overdue-alert-actions">
          <button type="button" class="btn btn-emerald btn-sm" data-dose-action="taken" data-med-id="${escapeHtml(firstOverdue.medId)}" data-time="${escapeHtml(firstOverdue.time)}" data-date="${escapeHtml(firstOverdue.date)}">
            ✓ Mark ${escapeHtml(firstOverdue.medName)} Taken
          </button>
          <button type="button" class="btn btn-danger-soft btn-sm" data-send-dose-email="missed_medication" data-med-id="${escapeHtml(firstOverdue.medId)}" data-time="${escapeHtml(firstOverdue.time)}">
            ✉ Email Missed-Dose Alert to Care Circle
          </button>
        </div>
      `;
    } else {
      overdueBanner.classList.add('hidden');
    }
  }

  const adhRate = todaySummary?.adherenceRate ?? 100;
  document.getElementById('kpi-today-rate').textContent = `${adhRate}%`;
  document.getElementById('kpi-today-fraction').textContent =
    `${todaySummary?.takenDoses || 0} of ${todaySummary?.totalDoses || 0} doses taken`;
  document.getElementById('kpi-today-bar').style.width = `${adhRate}%`;

  const todayBadge = document.getElementById('kpi-today-badge');
  if (todayBadge) {
    if ((todaySummary?.missedOrOverdueDoses || 0) > 0) {
      todayBadge.textContent = `${todaySummary.missedOrOverdueDoses} Overdue`;
      todayBadge.className = 'status-pill status-crimson';
    } else {
      todayBadge.textContent = 'On Track';
      todayBadge.className = 'status-pill status-emerald';
    }
  }

  document.getElementById('kpi-weekly-rate').textContent = `${weeklyAdherence?.weeklyRate ?? 100}%`;
  document.getElementById('kpi-weekly-sub').textContent =
    `${weeklyAdherence?.totalTaken7d || 0}/${weeklyAdherence?.totalScheduled7d || 0} doses this week`;

  const miniBarsEl = document.getElementById('kpi-mini-bars');
  if (miniBarsEl && weeklyAdherence?.days) {
    miniBarsEl.innerHTML = weeklyAdherence.days
      .map(
        (day) => `
        <div class="mini-bar-col" title="${escapeHtml(day.label)}: ${day.adherencePct}%">
          <div class="mini-bar-fill" style="height: ${Math.max(15, day.adherencePct)}%"></div>
        </div>`
      )
      .join('');
  }

  const upcomingApts = (appointments || []).filter((a) => a.status === 'Upcoming');
  if (upcomingApts.length > 0) {
    const nextApt = upcomingApts[0];
    document.getElementById('kpi-next-apt-title').textContent = nextApt.doctorName;
    document.getElementById('kpi-next-apt-meta').textContent =
      `${formatDateReadable(nextApt.date)} at ${formatTime12h(nextApt.time)} · ${nextApt.specialty}`;
  } else {
    document.getElementById('kpi-next-apt-title').textContent = 'No Upcoming Visits';
    document.getElementById('kpi-next-apt-meta').textContent = 'Click Schedule Appointment to add one';
  }

  document.getElementById('kpi-email-total').textContent = String((emailLogs || []).length);
  const avatarsEl = document.getElementById('kpi-carecircle-avatars');
  if (avatarsEl) {
    avatarsEl.innerHTML = (careCircle || [])
      .map(
        (m) =>
          `<span class="avatar-circle-sm" style="background:${escapeHtml(m.avatarColor || '#0F766E')}" title="${escapeHtml(m.name)} (${escapeHtml(m.role)})">${escapeHtml(getInitials(m.name))}</span>`
      )
      .join('');
  }

  const timelineContainer = document.getElementById('overview-dose-timeline');
  if (timelineContainer) {
    timelineContainer.innerHTML = renderDoseSlotsHTML(schedule?.slots || []);
  }

  // Render Google Gemini & Smart Clinical Care Insights
  const geminiContainer = document.getElementById('overview-gemini-insights');
  const geminiProviderEl = document.getElementById('overview-gemini-provider');
  if (geminiContainer && d.aiCareBrief) {
    if (geminiProviderEl) {
      geminiProviderEl.textContent = d.aiCareBrief.provider;
    }
    geminiContainer.innerHTML = (d.aiCareBrief.insights || [])
      .map((item) => {
        const borderColor =
          item.type === 'urgent'
            ? 'var(--crimson)'
            : item.type === 'refill'
            ? 'var(--amber)'
            : 'var(--brand-primary)';
        return `
          <div class="routine-item-row" style="border-left: 4px solid ${borderColor}; align-items:flex-start; flex-direction:column; gap:3px;">
            <strong style="font-size:0.86rem; color:var(--text-primary);">${escapeHtml(item.title)}</strong>
            <span style="font-size:0.81rem; color:var(--text-secondary);">${escapeHtml(item.text)}</span>
          </div>
        `;
      })
      .join('');
  }

  const routinesContainer = document.getElementById('overview-routines-list');
  if (routinesContainer) {
    routinesContainer.innerHTML = (routines || [])
      .slice(0, 4)
      .map(
        (r) => `
        <div class="routine-item-row ${r.completedToday ? 'completed' : ''}">
          <label class="routine-check-label">
            <input type="checkbox" data-toggle-routine="${escapeHtml(r.id)}" ${r.completedToday ? 'checked' : ''} />
            <span>${escapeHtml(r.title)}</span>
          </label>
          <span class="clinical-pill">${escapeHtml(formatTime12h(r.scheduledTime))}</span>
        </div>`
      )
      .join('');
  }

  const latestVital = (vitals || [])[0];
  const vitalsContainer = document.getElementById('overview-vitals-summary');
  const vitalsTimeEl = document.getElementById('overview-vitals-timestamp');
  if (vitalsContainer) {
    if (latestVital) {
      if (vitalsTimeEl) {
        vitalsTimeEl.textContent = `Last recorded ${formatTimestampRelative(latestVital.recordedAt)} by ${latestVital.recordedBy}`;
      }
      vitalsContainer.innerHTML = `
        <div class="vital-mini-box">
          <div class="vital-mini-label">Blood Pressure</div>
          <div class="vital-mini-val">${escapeHtml(latestVital.bloodPressure)} <small>mmHg</small></div>
        </div>
        <div class="vital-mini-box">
          <div class="vital-mini-label">Heart Rate</div>
          <div class="vital-mini-val">${escapeHtml(latestVital.heartRate)} <small>bpm</small></div>
        </div>
        <div class="vital-mini-box">
          <div class="vital-mini-label">Blood Glucose</div>
          <div class="vital-mini-val">${escapeHtml(latestVital.bloodGlucose)} <small>mg/dL</small></div>
        </div>
        <div class="vital-mini-box">
          <div class="vital-mini-label">Mood / Comfort</div>
          <div class="vital-mini-val" style="font-size:0.95rem; font-family:var(--font-sans);">${escapeHtml(latestVital.mood)}</div>
        </div>
      `;
    } else {
      vitalsContainer.innerHTML = `<p class="card-subtitle">No vital signs recorded yet.</p>`;
    }
  }

  const actContainer = document.getElementById('overview-activity-feed');
  if (actContainer) {
    actContainer.innerHTML = (activities || [])
      .slice(0, 7)
      .map(
        (act) => `
        <div class="activity-item">
          <span class="activity-actor">${escapeHtml(act.actor)}</span>: ${escapeHtml(act.text)}
          <span class="activity-time">${escapeHtml(formatTimestampRelative(act.timestamp))}</span>
        </div>`
      )
      .join('');
  }
}

function renderDoseSlotsHTML(slots) {
  if (!slots || slots.length === 0) {
    return `<p class="card-subtitle">No medication doses scheduled. Click "+ Add Medication" to create a schedule.</p>`;
  }

  return slots
    .map((slot) => {
      let badgeHtml = `<span class="status-pill status-teal">Scheduled</span>`;
      if (slot.status === 'taken') {
        badgeHtml = `<span class="status-pill status-emerald">✓ Taken</span>`;
      } else if (slot.status === 'overdue' || slot.status === 'missed') {
        badgeHtml = `<span class="status-pill status-crimson">! Overdue / Missed</span>`;
      } else if (slot.status === 'due_soon') {
        badgeHtml = `<span class="status-pill status-amber">⏰ Due Soon</span>`;
      } else if (slot.status === 'skipped') {
        badgeHtml = `<span class="status-pill">Skipped</span>`;
      }

      const auditText =
        slot.status === 'taken' && slot.loggedBy
          ? `<div class="dose-audit-note">✓ Recorded Taken by ${escapeHtml(slot.loggedBy)}${slot.note ? ` · "${escapeHtml(slot.note)}"` : ''}</div>`
          : slot.status === 'overdue' || slot.status === 'missed'
          ? `<div class="dose-audit-note" style="color:var(--crimson);">Scheduled for ${escapeHtml(slot.timeFormatted)} — awaiting confirmation or Care Circle alert</div>`
          : '';

      return `
        <div class="dose-slot-card slot-${escapeHtml(slot.status)}">
          <div class="dose-slot-left">
            <div class="dose-time-box">
              <span class="dose-time-val">${escapeHtml(slot.timeFormatted)}</span>
              <span class="dose-period-lbl">${escapeHtml(slot.period)}</span>
            </div>
            <div class="dose-info-main">
              <h3>
                ${escapeHtml(slot.medName)}
                <span class="dose-dosage-tag">${escapeHtml(slot.dosage)} · ${escapeHtml(slot.form)}</span>
                ${badgeHtml}
              </h3>
              <div class="dose-instructions">${escapeHtml(slot.instructions)} · <small>Prescribed by ${escapeHtml(slot.prescribedBy)}</small></div>
              ${auditText}
            </div>
          </div>
          <div class="dose-slot-actions">
            ${
              slot.status !== 'taken'
                ? `<button type="button" class="btn btn-emerald btn-sm" data-dose-action="taken" data-med-id="${escapeHtml(slot.medId)}" data-time="${escapeHtml(slot.time)}" data-date="${escapeHtml(slot.date)}">
                    ✓ Mark Taken
                  </button>`
                : `<button type="button" class="btn btn-ghost btn-xs" data-dose-action="pending" data-med-id="${escapeHtml(slot.medId)}" data-time="${escapeHtml(slot.time)}" data-date="${escapeHtml(slot.date)}">
                    Undo
                  </button>`
            }
            ${
              slot.status !== 'taken'
                ? `<button type="button" class="btn btn-warning-soft btn-xs" data-send-dose-email="${slot.status === 'overdue' || slot.status === 'missed' ? 'missed_medication' : 'upcoming_dose'}" data-med-id="${escapeHtml(slot.medId)}" data-time="${escapeHtml(slot.time)}" title="Send Email Reminder to Care Circle">
                    ✉ Email Alert
                  </button>`
                : ''
            }
            ${
              slot.status !== 'missed' && slot.status !== 'taken'
                ? `<button type="button" class="btn btn-danger-soft btn-xs" data-dose-action="missed" data-med-id="${escapeHtml(slot.medId)}" data-time="${escapeHtml(slot.time)}" data-date="${escapeHtml(slot.date)}" title="Flag as Missed & Email Care Circle">
                    Flag Missed
                  </button>`
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Tab 2: Medications & Adherence
// ---------------------------------------------------------------------------
function renderMedicationsTab(d) {
  const { medications, lowRefillMedications, schedule, weeklyAdherence } = d;

  document.getElementById('med-selected-date-label').textContent = formatDateReadable(
    state.selectedDate
  );

  const refillBanner = document.getElementById('low-refill-banner');
  if (refillBanner) {
    if (lowRefillMedications && lowRefillMedications.length > 0) {
      refillBanner.classList.remove('hidden');
      const names = lowRefillMedications
        .map((m) => `${m.name} (${m.pillsRemaining} pills left)`)
        .join(', ');
      refillBanner.innerHTML = `
        <div>
          <strong>Refill Alert:</strong> Low pill inventory detected for <strong>${escapeHtml(names)}</strong>.
        </div>
        <span class="status-pill status-amber">Order Pharmacy Refill Soon</span>
      `;
    } else {
      refillBanner.classList.add('hidden');
    }
  }

  const slotsContainer = document.getElementById('meds-daily-slots-container');
  if (slotsContainer) {
    slotsContainer.innerHTML = renderDoseSlotsHTML(schedule?.slots || []);
  }

  document.getElementById('meds-weekly-badge').textContent =
    `${weeklyAdherence?.weeklyRate ?? 100}% 7-Day Adherence`;
  const chartBox = document.getElementById('weekly-chart-container');
  if (chartBox && weeklyAdherence?.days) {
    chartBox.innerHTML = weeklyAdherence.days
      .map(
        (day) => `
        <div class="chart-day-col">
          <span class="chart-pct-label">${day.adherencePct}%</span>
          <div class="chart-bar-wrap">
            <div class="chart-bar-inner" style="height: ${Math.max(8, day.adherencePct)}%; background: ${day.adherencePct < 75 ? 'var(--amber)' : ''}"></div>
          </div>
          <span class="chart-day-name">${escapeHtml(day.label)}${day.isToday ? '*' : ''}</span>
        </div>`
      )
      .join('');
  }

  const dirGrid = document.getElementById('medications-directory-grid');
  if (dirGrid) {
    dirGrid.innerHTML = (medications || [])
      .map((med) => {
        const isLow = Number(med.pillsRemaining) <= Number(med.refillThreshold || 7);
        return `
          <div class="med-regimen-card">
            <div>
              <div class="med-card-top">
                <div>
                  <h3 class="med-card-title">${escapeHtml(med.name)}</h3>
                  <span class="clinical-pill">${escapeHtml(med.dosage)} · ${escapeHtml(med.form)} · ${escapeHtml(med.frequency)}</span>
                </div>
                <span class="status-pill ${isLow ? 'status-amber' : 'status-teal'}">
                  ${escapeHtml(med.pillsRemaining)} pills left
                </span>
              </div>
              <div class="med-times-row">
                ${(med.times || [])
                  .map((t) => `<span class="time-chip">⏰ ${escapeHtml(formatTime12h(t))}</span>`)
                  .join('')}
              </div>
              <p class="dose-instructions"><strong>Purpose:</strong> ${escapeHtml(med.purpose)}</p>
              <p class="dose-instructions"><strong>Instructions:</strong> ${escapeHtml(med.instructions)}</p>
              <p class="dose-instructions"><strong>Prescribed By:</strong> ${escapeHtml(med.prescribedBy)}</p>
            </div>
            <div class="med-card-footer">
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button type="button" class="btn btn-secondary btn-xs" data-edit-med="${escapeHtml(med.id)}">
                  Edit Schedule
                </button>
                <button type="button" class="btn btn-teal-soft btn-xs" data-refill-med="${escapeHtml(med.id)}">
                  +30 Refill
                </button>
              </div>
              <button type="button" class="btn btn-danger-soft btn-xs" data-delete-med="${escapeHtml(med.id)}">
                Remove
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

// ---------------------------------------------------------------------------
// Tab 3: Medical Appointments
// ---------------------------------------------------------------------------
function renderAppointmentsTab(d) {
  const { appointments } = d;
  const grid = document.getElementById('appointments-list-grid');
  if (!grid) return;

  const filtered = (appointments || []).filter((apt) => {
    if (state.aptFilter === 'all') return true;
    return apt.status === state.aptFilter;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="card-panel"><p class="card-subtitle">No appointments match the selected filter.</p></div>`;
    return;
  }

  grid.innerHTML = filtered
    .map((apt) => {
      const isCompleted = apt.status === 'Completed';
      return `
        <div class="appointment-card ${isCompleted ? 'apt-completed' : ''}">
          <div>
            <div class="med-card-top" style="margin-bottom:10px;">
              <div>
                <span class="status-pill ${isCompleted ? 'status-emerald' : 'status-blue'}">${escapeHtml(apt.specialty)} · ${escapeHtml(apt.status)}</span>
                <h3 class="med-card-title" style="margin-top:6px;">${escapeHtml(apt.doctorName)}</h3>
                <p class="card-subtitle">${escapeHtml(apt.title)}</p>
              </div>
              ${
                apt.reminderSent
                  ? `<span class="status-pill status-teal" title="Care Circle notified by email">✉ Reminder Sent</span>`
                  : ''
              }
            </div>

            <div class="apt-datetime-banner">
              <span>📅 ${escapeHtml(formatDateReadable(apt.date))}</span>
              <span>🕒 ${escapeHtml(formatTime12h(apt.time))}</span>
            </div>

            <div style="margin: 12px 0; font-size:0.86rem; color:var(--text-secondary);">
              <div>
                <strong>Clinic Location:</strong> ${escapeHtml(apt.clinic)}${apt.address ? ` (${escapeHtml(apt.address)})` : ''}
                ${
                  apt.googleMapsUrl
                    ? ` · <a href="${escapeHtml(apt.googleMapsUrl)}" target="_blank" rel="noopener" class="btn-text-xs">📍 Open in Google Maps ↗</a>`
                    : ''
                }
              </div>
              <div><strong>Accompanied By:</strong> ${escapeHtml(apt.accompaniedBy || 'Care Circle Member')}</div>
            </div>

            ${
              apt.prepNotes
                ? `<div class="apt-prep-box"><strong>Preparation Notes:</strong> ${escapeHtml(apt.prepNotes)}</div>`
                : ''
            }
            ${
              apt.visitSummary
                ? `<div class="apt-prep-box" style="border-left-color:var(--emerald); margin-top:8px;"><strong>Post-Visit Summary:</strong> ${escapeHtml(apt.visitSummary)}</div>`
                : ''
            }
          </div>

          <div class="med-card-footer">
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button type="button" class="btn btn-info-soft btn-xs" data-email-apt="${escapeHtml(apt.id)}">
                ✉ Send Email Reminder
              </button>
              ${
                apt.googleCalendarUrl
                  ? `<a href="${escapeHtml(apt.googleCalendarUrl)}" target="_blank" rel="noopener" class="btn btn-teal-soft btn-xs">
                      📅 Add to Google Calendar
                    </a>`
                  : ''
              }
              ${
                !isCompleted
                  ? `<button type="button" class="btn btn-emerald btn-xs" data-complete-apt="${escapeHtml(apt.id)}">
                      ✓ Mark Completed
                    </button>`
                  : ''
              }
              <button type="button" class="btn btn-secondary btn-xs" data-edit-apt="${escapeHtml(apt.id)}">
                Edit
              </button>
            </div>
            <button type="button" class="btn btn-danger-soft btn-xs" data-delete-apt="${escapeHtml(apt.id)}">
              Cancel
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Tab 4: Daily Healthcare Routines & Vitals
// ---------------------------------------------------------------------------
function renderRoutinesAndVitalsTab(d) {
  const { routines, vitals } = d;

  const completedCount = (routines || []).filter((r) => r.completedToday).length;
  const totalCount = (routines || []).length;
  document.getElementById('routines-progress-pill').textContent =
    `${completedCount} / ${totalCount} Completed Today`;

  const routinesListEl = document.getElementById('routines-full-list');
  if (routinesListEl) {
    routinesListEl.innerHTML = (routines || [])
      .map(
        (r) => `
        <div class="routine-item-row ${r.completedToday ? 'completed' : ''}">
          <div style="flex:1;">
            <label class="routine-check-label">
              <input type="checkbox" data-toggle-routine="${escapeHtml(r.id)}" ${r.completedToday ? 'checked' : ''} />
              <span>${escapeHtml(r.title)}</span>
            </label>
            <div style="font-size:0.8rem; color:var(--text-muted); margin-left:30px;">
              <strong>${escapeHtml(r.category)}</strong> · Target: ${escapeHtml(formatTime12h(r.scheduledTime))} · ${escapeHtml(r.targetDescription)}
            </div>
          </div>
          <button type="button" class="btn btn-danger-soft btn-xs" data-delete-routine="${escapeHtml(r.id)}">
            Remove
          </button>
        </div>`
      )
      .join('');
  }

  const vitalsListEl = document.getElementById('vitals-history-list');
  if (vitalsListEl) {
    vitalsListEl.innerHTML = (vitals || [])
      .map(
        (v) => `
        <div class="vital-log-card">
          <div style="display:flex; justify-content:space-between; font-size:0.78rem; color:var(--text-muted); flex-wrap:wrap; gap:4px;">
            <strong>Recorded by ${escapeHtml(v.recordedBy)}</strong>
            <span>${escapeHtml(formatTimestampRelative(v.recordedAt))}</span>
          </div>
          <div class="vital-metrics-strip">
            <div class="vital-chip">BP: <strong>${escapeHtml(v.bloodPressure)}</strong> mmHg</div>
            <div class="vital-chip">HR: <strong>${escapeHtml(v.heartRate)}</strong> bpm</div>
            <div class="vital-chip">Glucose: <strong>${escapeHtml(v.bloodGlucose)}</strong> mg/dL</div>
            <div class="vital-chip">Weight: <strong>${escapeHtml(v.weightLbs)}</strong> lbs</div>
            <div class="vital-chip">Mood: <strong>${escapeHtml(v.mood)}</strong></div>
          </div>
          ${v.notes ? `<div style="font-size:0.82rem; color:var(--text-secondary);">Note: "${escapeHtml(v.notes)}"</div>` : ''}
        </div>`
      )
      .join('');
  }
}

// ---------------------------------------------------------------------------
// Tab 5: Care Circle, Security & Proactive Email Outbox
// ---------------------------------------------------------------------------
function renderCareCircleAndEmailsTab(d) {
  const { profile, careCircle, emailLogs, mailerStatus } = d;

  document.getElementById('sec-profile-code').textContent = profile.profileCode;
  document.getElementById('sec-passcode-display').textContent = state.passcodeRevealed
    ? state.activePasscode
    : '••••';
  document.getElementById('btn-reveal-sec-passcode').textContent = state.passcodeRevealed
    ? 'Hide'
    : 'Reveal';

  const mailerBadge = document.getElementById('mailer-mode-badge');
  if (mailerBadge) {
    const mode = mailerStatus?.mode || 'active';
    mailerBadge.textContent =
      mode === 'ethereal'
        ? 'Nodemailer Ethereal SMTP Active'
        : mode === 'smtp'
        ? 'Live Custom SMTP Active'
        : 'Proactive Nodemailer Outbox Active';
  }

  document.getElementById('rule-grace-mins').textContent =
    profile.reminderSettings?.missedGraceMinutes ?? 30;
  document.getElementById('rule-upcoming-mins').textContent =
    profile.reminderSettings?.upcomingLeadMinutes ?? 60;
  document.getElementById('rule-apt-hours').textContent =
    profile.reminderSettings?.appointmentLeadHours ?? 48;

  const membersGrid = document.getElementById('care-circle-members-grid');
  if (membersGrid) {
    membersGrid.innerHTML = (careCircle || [])
      .map((m) => {
        const prefs = m.notifications || {};
        return `
          <div class="member-card">
            <div>
              <div class="member-card-header">
                <div class="prof-avatar" style="background:${escapeHtml(m.avatarColor || '#0F766E')}">${escapeHtml(getInitials(m.name))}</div>
                <div>
                  <h3 style="font-size:1rem; font-weight:800;">${escapeHtml(m.name)}</h3>
                  <span class="status-pill status-teal">${escapeHtml(m.role)}</span>
                </div>
              </div>
              <div style="margin-top:10px; font-size:0.83rem; color:var(--text-secondary);">
                <div><strong>Relationship:</strong> ${escapeHtml(m.relationship || m.role)}</div>
                <div><strong>Email:</strong> ${escapeHtml(m.email)}</div>
                ${m.phone ? `<div><strong>Phone:</strong> ${escapeHtml(m.phone)}</div>` : ''}
              </div>
              <div class="member-prefs-list" style="margin-top:10px;">
                <label class="pref-toggle-row">
                  <span>Missed Medication Alerts</span>
                  <input type="checkbox" data-member-pref="${escapeHtml(m.id)}" data-pref-key="missedMedications" ${prefs.missedMedications !== false ? 'checked' : ''} />
                </label>
                <label class="pref-toggle-row">
                  <span>Upcoming Dose Reminders</span>
                  <input type="checkbox" data-member-pref="${escapeHtml(m.id)}" data-pref-key="upcomingDoses" ${prefs.upcomingDoses !== false ? 'checked' : ''} />
                </label>
                <label class="pref-toggle-row">
                  <span>Doctor Appointment Reminders</span>
                  <input type="checkbox" data-member-pref="${escapeHtml(m.id)}" data-pref-key="appointments" ${prefs.appointments !== false ? 'checked' : ''} />
                </label>
              </div>
            </div>
            <div style="display:flex; justify-content:flex-end; padding-top:8px; border-top:1px solid var(--border-light);">
              <button type="button" class="btn btn-danger-soft btn-xs" data-remove-member="${escapeHtml(m.id)}">
                Remove Member
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  const outboxEl = document.getElementById('email-outbox-list');
  if (outboxEl) {
    const filteredEmails = (emailLogs || []).filter((e) => {
      if (state.emailFilter === 'all') return true;
      return e.type === state.emailFilter;
    });

    if (filteredEmails.length === 0) {
      outboxEl.innerHTML = `<p class="card-subtitle">No email reminders match this filter yet. Click "Run Proactive Reminder Scan Now" or any Instant Email button above to dispatch reminders.</p>`;
      return;
    }

    outboxEl.innerHTML = filteredEmails
      .map((eml) => {
        const pillClass =
          eml.urgency === 'high'
            ? 'status-crimson'
            : eml.urgency === 'warning'
            ? 'status-amber'
            : eml.urgency === 'appointment'
            ? 'status-blue'
            : 'status-teal';

        const recList = (eml.recipients || [])
          .map((r) => `${r.name} <${r.email}>`)
          .join(', ');

        return `
          <div class="email-log-item urg-${escapeHtml(eml.urgency || 'normal')}">
            <div style="flex:1; min-width:240px;">
              <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <span class="status-pill ${pillClass}">${escapeHtml(eml.categoryLabel)}</span>
                <span style="font-size:0.76rem; color:var(--text-muted);">${escapeHtml(formatTimestampRelative(eml.sentAt))} · ${escapeHtml(eml.deliveryStatus)}</span>
              </div>
              <div class="email-subject-title">${escapeHtml(eml.subject)}</div>
              <div class="email-recipients-row">
                <strong>Sent To:</strong> ${escapeHtml(recList)}
              </div>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              ${
                eml.previewUrl
                  ? `<a href="${escapeHtml(eml.previewUrl)}" target="_blank" rel="noopener" class="btn btn-secondary btn-xs">Ethereal Inbox ↗</a>`
                  : ''
              }
              <button type="button" class="btn btn-teal-soft btn-sm" data-preview-email="${escapeHtml(eml.id)}">
                View HTML Email
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

// ---------------------------------------------------------------------------
// Senior Comfort Mode (A+ High-Clarity Toggle)
// ---------------------------------------------------------------------------
function applySeniorModeUI() {
  const btn = document.getElementById('btn-senior-mode');
  if (state.seniorMode) {
    document.body.classList.add('senior-comfort-mode');
    if (btn) {
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
    }
  } else {
    document.body.classList.remove('senior-comfort-mode');
    if (btn) {
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
    }
  }
}

// ---------------------------------------------------------------------------
// Modal & Tab Helpers
// ---------------------------------------------------------------------------
function openModal(modalId) {
  const backdrop = document.getElementById('modal-backdrop');
  if (!backdrop) return;
  backdrop.classList.remove('hidden');
  document.querySelectorAll('.modal-dialog').forEach((dlg) => dlg.classList.add('hidden'));
  document.getElementById(modalId)?.classList.remove('hidden');
}

function closeAllModals() {
  document.getElementById('modal-backdrop')?.classList.add('hidden');
  document.querySelectorAll('.modal-dialog').forEach((dlg) => dlg.classList.add('hidden'));
}

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    const isAct = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isAct);
    btn.setAttribute('aria-selected', String(isAct));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function readScheduleAloud() {
  if (!('speechSynthesis' in window)) {
    showToast('Speech synthesis is not supported in this browser.', true);
    return;
  }
  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    showToast('Voice read-aloud stopped.');
    return;
  }
  const d = state.dashboard;
  if (!d) return;
  const slots = d.schedule?.slots || [];
  const pending = slots.filter((s) => s.status !== 'taken');
  const nextApt = (d.appointments || []).find((a) => a.status === 'Upcoming');

  const summaryParts = [
    `Healthcare summary for ${d.profile.elderName}.`,
    `Today's medication adherence is ${d.todaySummary.adherenceRate} percent, with ${d.todaySummary.takenDoses} of ${d.todaySummary.totalDoses} doses marked taken.`
  ];
  if (pending.length > 0) {
    summaryParts.push(
      `Remaining doses today: ${pending.map((s) => `${s.medName} ${s.dosage} at ${s.timeFormatted}`).join(', ')}.`
    );
  }
  if (nextApt) {
    summaryParts.push(
      `Next medical appointment is with ${nextApt.doctorName} for ${nextApt.specialty} on ${nextApt.date} at ${formatTime12h(nextApt.time)}.`
    );
  }

  const utterance = new SpeechSynthesisUtterance(summaryParts.join(' '));
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
  showToast('Reading today’s healthcare schedule aloud...');
}

// ---------------------------------------------------------------------------
// Global Event Bindings & Optimistic Updates
// ---------------------------------------------------------------------------
function bindGlobalEvents() {
  // Escape key closes modals immediately
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
  });

  document.getElementById('auth-unlock-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = document.getElementById('auth-profile-code')?.value;
    const pin = document.getElementById('auth-passcode-input')?.value;
    const actor = document.getElementById('auth-member-select')?.value;
    attemptUnlock(code, pin, actor);
  });

  document.getElementById('btn-quick-demo-unlock')?.addEventListener('click', () => {
    attemptUnlock('MARTHA-842', '4826', 'Martha Vance (Elderly Individual)');
  });

  document.getElementById('auth-profile-code')?.addEventListener('input', (e) => {
    updateAuthMemberDropdown(e.target.value);
  });

  document.getElementById('btn-toggle-pin-visibility')?.addEventListener('click', (e) => {
    const input = document.getElementById('auth-passcode-input');
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      e.target.textContent = 'Hide';
    } else {
      input.type = 'password';
      e.target.textContent = 'Show';
    }
  });

  document.querySelector('.pin-keypad')?.addEventListener('click', (e) => {
    const key = e.target.closest('.pin-key');
    if (!key) return;
    const input = document.getElementById('auth-passcode-input');
    if (!input) return;

    if (key.dataset.digit !== undefined) {
      input.value = (input.value + key.dataset.digit).slice(0, 12);
    } else if (key.dataset.action === 'clear') {
      input.value = '';
    } else if (key.dataset.action === 'fill-demo') {
      const code = (document.getElementById('auth-profile-code')?.value || 'MARTHA-842').toUpperCase();
      const match = state.publicProfiles.find((p) => p.profileCode === code);
      input.value = match?.demoPasscodeHint || '4826';
    }
  });

  document.getElementById('btn-open-create-profile')?.addEventListener('click', () => {
    openModal('modal-create-profile');
  });

  document.getElementById('form-create-profile')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const payload = {
        elderName: document.getElementById('newprof-name').value,
        age: document.getElementById('newprof-age').value,
        profileCode: document.getElementById('newprof-code').value,
        passcode: document.getElementById('newprof-passcode').value,
        elderEmail: document.getElementById('newprof-elder-email').value,
        primaryDoctor: document.getElementById('newprof-doctor').value,
        caretakerName: document.getElementById('newprof-caretaker-name').value,
        caretakerEmail: document.getElementById('newprof-caretaker-email').value
      };
      const res = await apiRequest('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      closeAllModals();
      loadPublicProfiles();
      await attemptUnlock(
        res.profileCode,
        payload.passcode,
        `${res.elderName} (Elderly Individual)`
      );
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('active-actor-select')?.addEventListener('change', (e) => {
    state.activeActor = e.target.value;
    sessionStorage.setItem('eldercare_actor', state.activeActor);
    showToast(`Now acting as: ${state.activeActor}`);
  });

  document.getElementById('btn-senior-mode')?.addEventListener('click', () => {
    state.seniorMode = !state.seniorMode;
    localStorage.setItem('eldercare_senior_mode', String(state.seniorMode));
    applySeniorModeUI();
    showToast(
      state.seniorMode
        ? 'Senior Comfort Large-Text View enabled'
        : 'Standard View restored'
    );
  });

  document.getElementById('btn-read-aloud')?.addEventListener('click', () => {
    readScheduleAloud();
  });

  document.getElementById('btn-header-reminders')?.addEventListener('click', () => {
    switchTab('carecircle');
  });

  document.getElementById('btn-lock-profile')?.addEventListener('click', () => {
    lockProfile(true);
  });

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  document.getElementById('med-schedule-date')?.addEventListener('change', async (e) => {
    if (e.target.value) {
      state.selectedDate = e.target.value;
      await fetchDashboardAndRender();
    }
  });

  document.getElementById('btn-med-date-today')?.addEventListener('click', async () => {
    state.selectedDate = getTodayDateString();
    const dateInput = document.getElementById('med-schedule-date');
    if (dateInput) dateInput.value = state.selectedDate;
    await fetchDashboardAndRender();
  });

  document.getElementById('btn-overview-add-med')?.addEventListener('click', () => openAddMedicationModal());
  document.getElementById('btn-open-add-med')?.addEventListener('click', () => openAddMedicationModal());
  document.getElementById('btn-open-add-apt')?.addEventListener('click', () => openAddAppointmentModal());
  document.getElementById('btn-open-add-routine')?.addEventListener('click', () => openModal('modal-routine'));
  document.getElementById('btn-open-add-vitals')?.addEventListener('click', () => openModal('modal-vitals'));
  document.getElementById('btn-overview-log-vitals')?.addEventListener('click', () => openModal('modal-vitals'));
  document.getElementById('btn-open-add-member')?.addEventListener('click', () => openModal('modal-member'));
  document.getElementById('btn-edit-profile')?.addEventListener('click', () => openEditProfileModal());

  document.getElementById('btn-quick-scan-reminders')?.addEventListener('click', () => runProactiveScan(true));
  document.getElementById('btn-trigger-proactive-scan')?.addEventListener('click', () => runProactiveScan(true));

  document.getElementById('btn-reveal-sec-passcode')?.addEventListener('click', () => {
    state.passcodeRevealed = !state.passcodeRevealed;
    renderCareCircleAndEmailsTab(state.dashboard);
  });

  document.getElementById('form-change-passcode')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPin = document.getElementById('input-new-passcode')?.value?.trim();
    if (!newPin) return;
    try {
      await apiRequest(`/api/profiles/${encodeURIComponent(state.activeProfileCode)}/passcode`, {
        method: 'PUT',
        body: JSON.stringify({
          newPasscode: newPin,
          selectedDate: state.selectedDate,
          actor: state.activeActor
        })
      });
      state.activePasscode = newPin;
      sessionStorage.setItem('eldercare_passcode', newPin);
      document.getElementById('input-new-passcode').value = '';
      showToast('Care Profile Passcode updated!');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('form-medication')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const medId = document.getElementById('med-form-id').value;
    const timesRaw = document.getElementById('med-form-times').value;
    const times = timesRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const payload = {
      name: document.getElementById('med-form-name').value,
      dosage: document.getElementById('med-form-dosage').value,
      form: document.getElementById('med-form-type').value,
      purpose: document.getElementById('med-form-purpose').value,
      frequency: document.getElementById('med-form-frequency').value,
      times: times.length > 0 ? times : ['08:00'],
      prescribedBy: document.getElementById('med-form-doctor').value,
      pillsRemaining: Number(document.getElementById('med-form-pills').value || 30),
      instructions: document.getElementById('med-form-instructions').value,
      selectedDate: state.selectedDate,
      actor: state.activeActor
    };

    closeAllModals();
    try {
      if (medId) {
        await apiRequest(
          `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/medications/${encodeURIComponent(medId)}`,
          { method: 'PUT', body: JSON.stringify(payload) }
        );
        showToast(`Updated medication: ${payload.name}`);
      } else {
        await apiRequest(
          `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/medications`,
          { method: 'POST', body: JSON.stringify(payload) }
        );
        showToast(`Added medication: ${payload.name}`);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('form-appointment')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const aptId = document.getElementById('apt-form-id').value;
    const payload = {
      doctorName: document.getElementById('apt-form-doctor').value,
      specialty: document.getElementById('apt-form-specialty').value,
      title: document.getElementById('apt-form-title').value,
      date: document.getElementById('apt-form-date').value,
      time: document.getElementById('apt-form-time').value,
      clinic: document.getElementById('apt-form-clinic').value,
      accompaniedBy: document.getElementById('apt-form-companion').value,
      prepNotes: document.getElementById('apt-form-notes').value,
      sendEmailNow: document.getElementById('apt-form-send-email').checked,
      selectedDate: state.selectedDate,
      actor: state.activeActor
    };

    closeAllModals();
    try {
      if (aptId) {
        await apiRequest(
          `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/appointments/${encodeURIComponent(aptId)}`,
          { method: 'PUT', body: JSON.stringify(payload) }
        );
        showToast(`Updated appointment with ${payload.doctorName}`);
      } else {
        const res = await apiRequest(
          `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/appointments`,
          { method: 'POST', body: JSON.stringify(payload) }
        );
        showToast(
          res.dispatchedEmail
            ? `Scheduled appointment & emailed Care Circle!`
            : `Scheduled appointment with ${payload.doctorName}`
        );
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('form-routine')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      title: document.getElementById('rtn-form-title').value,
      category: document.getElementById('rtn-form-category').value,
      scheduledTime: document.getElementById('rtn-form-time').value,
      targetDescription: document.getElementById('rtn-form-desc').value,
      selectedDate: state.selectedDate,
      actor: state.activeActor
    };
    document.getElementById('form-routine').reset();
    closeAllModals();
    try {
      await apiRequest(`/api/profiles/${encodeURIComponent(state.activeProfileCode)}/routines`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast('Added daily healthcare routine!');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('form-vitals')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      bloodPressure: document.getElementById('vit-form-bp').value,
      heartRate: document.getElementById('vit-form-hr').value,
      bloodGlucose: document.getElementById('vit-form-glucose').value,
      weightLbs: document.getElementById('vit-form-weight').value,
      mood: document.getElementById('vit-form-mood').value,
      notes: document.getElementById('vit-form-notes').value,
      selectedDate: state.selectedDate,
      actor: state.activeActor
    };
    closeAllModals();
    try {
      await apiRequest(`/api/profiles/${encodeURIComponent(state.activeProfileCode)}/vitals`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast('Vital signs recorded!');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('form-member')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('mem-form-name').value,
      role: document.getElementById('mem-form-role').value,
      email: document.getElementById('mem-form-email').value,
      phone: document.getElementById('mem-form-phone').value,
      relationship: document.getElementById('mem-form-rel').value,
      selectedDate: state.selectedDate,
      actor: state.activeActor
    };
    document.getElementById('form-member').reset();
    closeAllModals();
    try {
      await apiRequest(`/api/profiles/${encodeURIComponent(state.activeProfileCode)}/members`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast('Added new member to Care Circle!');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('form-edit-profile')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      elderName: document.getElementById('prof-form-name').value,
      age: document.getElementById('prof-form-age').value,
      bloodType: document.getElementById('prof-form-blood').value,
      allergies: document.getElementById('prof-form-allergies').value,
      conditions: document.getElementById('prof-form-conditions').value,
      primaryDoctor: document.getElementById('prof-form-doc').value,
      emergencyPhone: document.getElementById('prof-form-emergency').value,
      selectedDate: state.selectedDate,
      actor: state.activeActor
    };
    closeAllModals();
    try {
      await apiRequest(`/api/profiles/${encodeURIComponent(state.activeProfileCode)}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast('Updated Healthcare Profile!');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Delegated Document Clicks
  document.addEventListener('click', async (e) => {
    if (e.target.matches('[data-close-modal]') || e.target.id === 'modal-backdrop') {
      closeAllModals();
      return;
    }

    const gotoTabBtn = e.target.closest('[data-goto-tab]');
    if (gotoTabBtn) {
      switchTab(gotoTabBtn.dataset.gotoTab);
      return;
    }

    const instantBtn = e.target.closest('[data-instant-unlock]');
    if (instantBtn) {
      e.stopPropagation();
      const code = instantBtn.dataset.instantUnlock;
      const pin = instantBtn.dataset.instantPin || '4826';
      await attemptUnlock(code, pin);
      return;
    }

    const profCard = e.target.closest('[data-select-profile]');
    if (profCard) {
      const code = profCard.dataset.selectProfile;
      const pin = profCard.dataset.demoPin;
      const codeInput = document.getElementById('auth-profile-code');
      if (codeInput) codeInput.value = code;
      const pinInput = document.getElementById('auth-passcode-input');
      if (pinInput && pin) pinInput.value = pin;
      renderPublicProfilesList();
      return;
    }

    // Optimistic + Single-Round-Trip Dose Action
    const doseBtn = e.target.closest('[data-dose-action]');
    if (doseBtn) {
      const status = doseBtn.dataset.doseAction;
      const medId = doseBtn.dataset.medId;
      const time = doseBtn.dataset.time;
      const date = doseBtn.dataset.date || state.selectedDate;

      // Instant Optimistic UI update (0ms latency)
      if (state.dashboard?.schedule?.slots) {
        const slot = state.dashboard.schedule.slots.find(
          (s) => s.medId === medId && s.time === time
        );
        if (slot) {
          slot.status = status;
          slot.loggedBy = state.activeActor;
          renderOverviewTab(state.dashboard);
          renderMedicationsTab(state.dashboard);
        }
      }

      try {
        await apiRequest(
          `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/doses/log`,
          {
            method: 'POST',
            body: JSON.stringify({
              date,
              medId,
              time,
              status,
              actor: state.activeActor,
              notifyCareCircle: status === 'missed'
            })
          }
        );
        if (status === 'taken') {
          showToast('Dose marked as Taken!');
        } else if (status === 'missed') {
          showToast('Dose flagged as Missed & Alert Email sent to Care Circle!');
        } else {
          showToast('Dose status updated.');
        }
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }

    const doseEmailBtn = e.target.closest('[data-send-dose-email]');
    if (doseEmailBtn) {
      const type = doseEmailBtn.dataset.sendDoseEmail;
      const medId = doseEmailBtn.dataset.medId;
      const time = doseEmailBtn.dataset.time;
      await sendManualReminderEmail({ type, medId, time });
      return;
    }

    const editMedBtn = e.target.closest('[data-edit-med]');
    if (editMedBtn) {
      const med = (state.dashboard?.medications || []).find(
        (m) => m.id === editMedBtn.dataset.editMed
      );
      if (med) openEditMedicationModal(med);
      return;
    }

    const refillMedBtn = e.target.closest('[data-refill-med]');
    if (refillMedBtn) {
      const med = (state.dashboard?.medications || []).find(
        (m) => m.id === refillMedBtn.dataset.refillMed
      );
      if (med) {
        await apiRequest(
          `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/medications/${encodeURIComponent(med.id)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              pillsRemaining: Number(med.pillsRemaining || 0) + 30,
              selectedDate: state.selectedDate,
              actor: state.activeActor
            })
          }
        );
        showToast(`Added +30 pills to ${med.name} inventory.`);
      }
      return;
    }

    const delMedBtn = e.target.closest('[data-delete-med]');
    if (delMedBtn) {
      try {
        await apiRequest(
          `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/medications/${encodeURIComponent(delMedBtn.dataset.deleteMed)}`,
          {
            method: 'DELETE',
            body: JSON.stringify({
              selectedDate: state.selectedDate,
              actor: state.activeActor
            })
          }
        );
        showToast('Medication removed from schedule.');
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }

    const aptFilterBtn = e.target.closest('[data-apt-filter]');
    if (aptFilterBtn) {
      state.aptFilter = aptFilterBtn.dataset.aptFilter;
      document.querySelectorAll('[data-apt-filter]').forEach((b) =>
        b.classList.toggle('active', b === aptFilterBtn)
      );
      renderAppointmentsTab(state.dashboard);
      return;
    }

    const emlFilterBtn = e.target.closest('[data-email-filter]');
    if (emlFilterBtn) {
      state.emailFilter = emlFilterBtn.dataset.emailFilter;
      document.querySelectorAll('[data-email-filter]').forEach((b) =>
        b.classList.toggle('active', b === emlFilterBtn)
      );
      renderCareCircleAndEmailsTab(state.dashboard);
      return;
    }

    const emailAptBtn = e.target.closest('[data-email-apt]');
    if (emailAptBtn) {
      await sendManualReminderEmail({
        type: 'upcoming_appointment',
        appointmentId: emailAptBtn.dataset.emailApt
      });
      return;
    }

    const completeAptBtn = e.target.closest('[data-complete-apt]');
    if (completeAptBtn) {
      await apiRequest(
        `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/appointments/${encodeURIComponent(completeAptBtn.dataset.completeApt)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            status: 'Completed',
            selectedDate: state.selectedDate,
            actor: state.activeActor
          })
        }
      );
      showToast('Appointment marked as Completed!');
      return;
    }

    const editAptBtn = e.target.closest('[data-edit-apt]');
    if (editAptBtn) {
      const apt = (state.dashboard?.appointments || []).find(
        (a) => a.id === editAptBtn.dataset.editApt
      );
      if (apt) openEditAppointmentModal(apt);
      return;
    }

    const delAptBtn = e.target.closest('[data-delete-apt]');
    if (delAptBtn) {
      await apiRequest(
        `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/appointments/${encodeURIComponent(delAptBtn.dataset.deleteApt)}`,
        {
          method: 'DELETE',
          body: JSON.stringify({
            selectedDate: state.selectedDate,
            actor: state.activeActor
          })
        }
      );
      showToast('Appointment cancelled.');
      return;
    }

    const delRtnBtn = e.target.closest('[data-delete-routine]');
    if (delRtnBtn) {
      await apiRequest(
        `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/routines/${encodeURIComponent(delRtnBtn.dataset.deleteRoutine)}`,
        {
          method: 'DELETE',
          body: JSON.stringify({
            selectedDate: state.selectedDate,
            actor: state.activeActor
          })
        }
      );
      showToast('Routine removed.');
      return;
    }

    const remMemBtn = e.target.closest('[data-remove-member]');
    if (remMemBtn) {
      try {
        await apiRequest(
          `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/members/${encodeURIComponent(remMemBtn.dataset.removeMember)}`,
          {
            method: 'DELETE',
            body: JSON.stringify({
              selectedDate: state.selectedDate,
              actor: state.activeActor
            })
          }
        );
        showToast('Removed member from Care Circle.');
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }

    const quickEmailBtn = e.target.closest('[data-quick-email]');
    if (quickEmailBtn) {
      await sendManualReminderEmail({ type: quickEmailBtn.dataset.quickEmail });
      return;
    }

    const previewBtn = e.target.closest('[data-preview-email]');
    if (previewBtn) {
      const eml = (state.dashboard?.emailLogs || []).find(
        (item) => item.id === previewBtn.dataset.previewEmail
      );
      if (eml) openEmailPreviewModal(eml);
      return;
    }
  });

  // Delegated Checkbox Changes (Optimistic Routine & Notification Toggles)
  document.addEventListener('change', async (e) => {
    const toggleRoutineInput = e.target.closest('[data-toggle-routine]');
    if (toggleRoutineInput) {
      const rtnId = toggleRoutineInput.dataset.toggleRoutine;
      const row = toggleRoutineInput.closest('.routine-item-row');
      if (row) row.classList.toggle('completed', toggleRoutineInput.checked);

      try {
        await apiRequest(
          `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/routines/${encodeURIComponent(rtnId)}/toggle`,
          {
            method: 'POST',
            body: JSON.stringify({
              date: state.selectedDate,
              actor: state.activeActor
            })
          }
        );
        showToast('Daily routine status updated!');
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }

    const memberPrefInput = e.target.closest('[data-member-pref]');
    if (memberPrefInput) {
      const memberId = memberPrefInput.dataset.memberPref;
      const prefKey = memberPrefInput.dataset.prefKey;
      const checked = memberPrefInput.checked;
      try {
        await apiRequest(
          `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/members/${encodeURIComponent(memberId)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              notifications: { [prefKey]: checked },
              selectedDate: state.selectedDate,
              actor: state.activeActor
            })
          }
        );
        showToast('Updated email notification preference!');
      } catch (err) {
        showToast(err.message, true);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Modal Pre-fill Helpers & Instant Email Dispatch
// ---------------------------------------------------------------------------
function openAddMedicationModal() {
  document.getElementById('modal-med-title').textContent = 'Add Medication Schedule';
  document.getElementById('med-form-id').value = '';
  document.getElementById('form-medication').reset();
  document.getElementById('med-form-times').value = '08:00, 20:00';
  document.getElementById('med-form-doctor').value =
    state.dashboard?.profile?.primaryDoctor || 'Dr. Eleanor Chen';
  openModal('modal-medication');
}

function openEditMedicationModal(med) {
  document.getElementById('modal-med-title').textContent = `Edit Medication: ${med.name}`;
  document.getElementById('med-form-id').value = med.id;
  document.getElementById('med-form-name').value = med.name;
  document.getElementById('med-form-dosage').value = med.dosage;
  document.getElementById('med-form-type').value = med.form || 'Tablet';
  document.getElementById('med-form-purpose').value = med.purpose || '';
  document.getElementById('med-form-frequency').value = med.frequency || 'Once Daily';
  document.getElementById('med-form-times').value = (med.times || ['08:00']).join(', ');
  document.getElementById('med-form-doctor').value = med.prescribedBy || '';
  document.getElementById('med-form-pills').value = med.pillsRemaining ?? 30;
  document.getElementById('med-form-instructions').value = med.instructions || '';
  openModal('modal-medication');
}

function openAddAppointmentModal() {
  document.getElementById('modal-apt-title').textContent = 'Schedule Medical Appointment';
  document.getElementById('apt-form-id').value = '';
  document.getElementById('form-appointment').reset();
  document.getElementById('apt-form-date').value = getTodayDateString();
  document.getElementById('apt-form-time').value = '10:30';
  openModal('modal-appointment');
}

function openEditAppointmentModal(apt) {
  document.getElementById('modal-apt-title').textContent = `Edit Appointment: ${apt.doctorName}`;
  document.getElementById('apt-form-id').value = apt.id;
  document.getElementById('apt-form-doctor').value = apt.doctorName;
  document.getElementById('apt-form-specialty').value = apt.specialty;
  document.getElementById('apt-form-title').value = apt.title;
  document.getElementById('apt-form-date').value = apt.date;
  document.getElementById('apt-form-time').value = apt.time;
  document.getElementById('apt-form-clinic').value = apt.clinic || '';
  document.getElementById('apt-form-companion').value = apt.accompaniedBy || '';
  document.getElementById('apt-form-notes').value = apt.prepNotes || '';
  openModal('modal-appointment');
}

function openEditProfileModal() {
  const p = state.dashboard?.profile;
  if (!p) return;
  document.getElementById('prof-form-name').value = p.elderName || '';
  document.getElementById('prof-form-age').value = p.age || 78;
  document.getElementById('prof-form-blood').value = p.bloodType || 'O+';
  document.getElementById('prof-form-allergies').value = (p.allergies || []).join(', ');
  document.getElementById('prof-form-conditions').value = (p.conditions || []).join(', ');
  document.getElementById('prof-form-doc').value = p.primaryDoctor || '';
  document.getElementById('prof-form-emergency').value = p.emergencyPhone || '';
  openModal('modal-edit-profile');
}

function openEmailPreviewModal(eml) {
  document.getElementById('email-preview-badge').textContent = eml.categoryLabel || 'Email Alert';
  document.getElementById('modal-email-title').textContent = eml.subject;
  document.getElementById('email-preview-recipients').textContent = (eml.recipients || [])
    .map((r) => `${r.name} (${r.email})`)
    .join(', ');
  document.getElementById('email-preview-time').textContent = formatTimestampRelative(eml.sentAt);
  document.getElementById('email-preview-status').textContent = eml.deliveryStatus;
  document.getElementById('email-preview-frame').innerHTML = eml.html || '';
  openModal('modal-email-preview');
}

async function runProactiveScan(forceSend = true) {
  try {
    const res = await apiRequest(
      `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/reminders/scan`,
      {
        method: 'POST',
        body: JSON.stringify({
          forceSend,
          selectedDate: state.selectedDate,
          actor: state.activeActor
        })
      }
    );
    showToast(
      `Proactive Scan Complete: ${res.dispatchedCount} email reminder(s) dispatched to Care Circle!`
    );
    if (res.dispatched && res.dispatched.length > 0) {
      openEmailPreviewModal(res.dispatched[0]);
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

async function sendManualReminderEmail(options) {
  try {
    const res = await apiRequest(
      `/api/profiles/${encodeURIComponent(state.activeProfileCode)}/reminders/send`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...options,
          selectedDate: state.selectedDate,
          actor: state.activeActor
        })
      }
    );
    showToast(`Email Sent: "${res.emailRecord.categoryLabel}" dispatched to Care Circle!`);
    openEmailPreviewModal(res.emailRecord);
  } catch (err) {
    showToast(err.message, true);
  }
}
