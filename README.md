# ElderCare — Smart Interconnected Healthcare Management Platform

**ElderCare** is a connected healthcare management platform designed to help elderly individuals manage their daily medications, doctor appointments, vital signs, and health routines while keeping family members and caretakers informed through a shared, passcode-protected Care Circle and automated email reminders.

---

## Key Capabilities

1. **Secure Passcode-Based Shared Ecosystem**:
   - Elderly individuals, family members, and caretakers access the shared profile using a **Care Profile Code** and **Passcode (PIN)** via a tactile keypad or keyboard input.
   - Switch active viewer identities (`Acting As`) to attribute every dose confirmation, vital reading, or schedule modification to the exact Care Circle member.
   - Built-in **Senior View (`A+`)** toggle that scales typography, touch targets, and contrast for effortless readability.
   - Create unlimited new elderly care profiles or rotate shared passcodes at any time.

2. **Medication Schedule & Adherence Tracking**:
   - Full CRUD management for prescribed medications (dosage, form, clinical purpose, multiple daily times, special instructions, prescribing physician, and pill inventory tracking with low-refill alerts).
   - Interactive daily timeline (`Taken`, `Due Soon`, `Overdue / Missed`, `Skipped`) with 1-click dose logging and 7-day adherence analytics.

3. **Medical Appointments Coordination**:
   - Schedule and track upcoming and completed specialist/primary care visits with preparation notes, clinic locations, and assigned Care Circle companions.

4. **Daily Healthcare Routines & Vital Signs**:
   - Track daily wellness habits (hydration, mobility walks, blood pressure checks, diabetic foot care) and log home vital signs (Blood Pressure, Heart Rate, Blood Glucose, Weight, and Mood).

5. **Proactive Email Reminder Engine (Nodemailer)**:
   - Automated background scanner and on-demand reminder dispatcher for **Missed Medications**, **Upcoming Doses**, **Medical Appointments**, and **Daily Care Digests**.
   - Powered by **Nodemailer** (supports live SMTP via `.env` or runtime configuration, automatic Ethereal test inbox links, and an in-app **HTML Email Reminder Outbox & Preview**).

---

## Pre-Configured Demo Profiles

| Elderly Individual | Care Profile Code | Shared Passcode (PIN) | Care Circle Members |
| :--- | :--- | :--- | :--- |
| **Martha Vance** (Age 78) | `MARTHA-842` | `4826` | Martha Vance (Patient), Sarah Vance (Daughter), Nurse David Miller, RN (Caretaker), Michael Vance (Son) |
| **Arthur Pendelton** (Age 83) | `ARTHUR-319` | `1943` | Arthur Pendelton (Patient), Claire Pendelton (Daughter), Elena Rostova, CNA (Caretaker) |

---

## Running the Platform

```bash
npm install
npm start
```

Then open `http://localhost:3000` in your browser.
