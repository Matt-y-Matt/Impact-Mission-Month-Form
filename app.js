/* Mission Month — registration app backed by Supabase.
   All data access goes through SECURITY DEFINER RPCs; admin RPCs require a passcode. */
'use strict';

const SUPABASE_URL = 'https://xjxktvnspmgvgixvqiji.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqeGt0dm5zcG1ndmdpeHZxaWppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxODcwNDUsImV4cCI6MjEwMTc2MzA0NX0.3rAlqjvu21qCFMCHJtMcfVdyDP-3gGQGg5ASymRJToc';
const EXPORT_URL = SUPABASE_URL + '/functions/v1/export-csv';
const ALMOST_FULL_AT = 3;

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

const S = {
  view: 'form', // form | review | done | admin
  pub: null,
  netError: '',
  fName: '', fEmail: '', fMobile: '', fNric: '',
  extra: {}, // answers to the admin-defined questions, keyed by field id
  sel: {}, errors: [], submitError: '', submitting: false,
  doneRegs: [], doneName: '',
  admin: {
    code: sessionStorage.getItem('ss_admin_code') || '',
    authed: false, checking: false, loginError: '',
    tab: 'dash', state: null, open: null, backupOpen: null, q: '', histOpen: {},
    moveOut: null, // { opt, mode: 'rehome' | 'capacity', picks: {regId: optId|''}, error }
    prefEdit: {}, // regId -> { p1, p2, error } while their choices are being edited
  },
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtTs = (ts) => {
  const d = new Date(Number(ts));
  return d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short' }) + ' ' +
         d.toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' });
};

const shortName = (name) => (name || '—').split(' — ')[0];

// "Lifenet 3 · BLS" — the custom-field answers for one registration, in form order.
const extraLine = (r) => (A()?.fields || [])
  .map((f) => (r.extra && r.extra[f.id]) ? esc(r.extra[f.id]) : null)
  .filter(Boolean).join(' · ');

// Renders **bold** markers in admin-editable copy. Escapes first, so the
// only markup that survives is the <strong> we add here.
const richText = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

/* The description supports three shapes, all typed as plain text:
     blank line      -> new paragraph (a full gap)
     single newline  -> next line, tight against the one above
     lines from "- " -> a tight bullet list                                */
function descHtml(text) {
  return (text || '').split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    // "-" and "•" only: "*" would collide with the **bold** markers.
    if (lines.every((l) => /^[-•]\s+/.test(l))) {
      return `<ul class="hero-list">${lines
        .map((l) => `<li>${richText(l.replace(/^[-•]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map(richText).join('<br>')}</p>`;
  }).join('');
}

/* ---------- public data ---------- */

async function loadPublic() {
  try {
    S.pub = await rpc('get_public_state');
    S.netError = '';
  } catch (e) {
    S.netError = 'Could not reach the server. Please check your connection and refresh.';
  }
}

const pubOpt = (id) => {
  for (const d of S.pub?.dates || []) for (const o of d.options) if (o.id === id) return o;
  return null;
};
const remaining = (o) => Math.max(0, o.capacity - o.confirmed);

/* ---------- admin data helpers (mirror server ordering) ---------- */

const A = () => S.admin.state;
const admOpt = (id) => {
  for (const d of A()?.dates || []) for (const o of d.options) if (o.id === id) return o;
  return null;
};
const admActive = () => (A()?.registrations || []).filter((r) => r.status === 'active');
const admConfirmedCount = (optId) => admActive().filter((r) => r.confirmed === optId).length;
const admRemaining = (opt) => (!opt || opt.removed) ? 0 : Math.max(0, opt.capacity - admConfirmedCount(opt.id));
// Retired options stay in the payload so old registrations and history still
// show a name — but they must not appear anywhere you can pick or edit.
const liveOpts = (d) => ((d && d.options) || []).filter((o) => !o.removed);
const admDate = (dateId) => (A()?.dates || []).find((d) => d.id === dateId);

/* Lowering a capacity below the number already confirmed doesn't throw anyone
   out — that would silently un-invite someone who has been told they're in.
   The last people to sign up are the ones over the line, and they stay put and
   get flagged until an admin decides where they go. */
const admOverBy = (opt) => Math.max(0, admConfirmedCount(opt.id) - opt.capacity);
const admOverflow = (opt) => {
  const n = admOverBy(opt);
  if (!n) return [];
  return admActive().filter((r) => r.confirmed === opt.id)
    .sort((a, b) => a.ts - b.ts).slice(-n);
};
const admOverCapacity = () => (A()?.dates || [])
  .flatMap((d) => liveOpts(d).map((o) => ({ date: d, opt: o, over: admOverBy(o) })))
  .filter((x) => x.over > 0);

// Everyone who would be left pointing at this option if it disappeared.
const admAttached = (optId) => admActive()
  .filter((r) => r.confirmed === optId || r.p1 === optId || r.p2 === optId)
  .sort((a, b) => a.ts - b.ts);

/* Deleting is instant — it has to be, or people keep signing up for something
   that isn't happening. Finding everyone a new place involves phone calls, so it
   happens afterwards, at whatever pace suits. These are the people still waiting
   on that. (A dead 2nd choice needs no decision and is cleared on deletion.) */
const admPending = (optId) => admActive()
  .filter((r) => r.confirmed === optId || r.p1 === optId)
  .sort((a, b) => a.ts - b.ts);
const admRetiredPending = () => (A()?.dates || [])
  .flatMap((d) => (d.options || []).filter((o) => o.removed)
    .map((o) => ({ date: d, opt: o, people: admPending(o.id) })))
  .filter((x) => x.people.length);

/* Where to put someone by default when their option is going away. Their
   current spot if it survives, else a preference of theirs with room, else
   wherever there is the most space. */
function defaultDest(r, excludeId) {
  const live = liveOpts(admDate(r.date_id)).filter((o) => o.id !== excludeId);
  if (live.some((o) => o.id === r.confirmed)) return r.confirmed;
  const pref = live.find((o) => (o.id === r.p1 || o.id === r.p2) && admRemaining(o) > 0);
  if (pref) return pref.id;
  const roomy = live.filter((o) => admRemaining(o) > 0)
    .sort((a, b) => admRemaining(b) - admRemaining(a))[0];
  return roomy ? roomy.id : '';
}
/* Who is actually queueing for an option: the people whose FIRST choice it is
   and who aren't in it. A 2nd choice is interest, not a place in a queue —
   counting it made every option look besieged when nobody was waiting. */
const byQueue = (optId) => (a, b) => {
  const ra = a.wl_rank && a.wl_rank[optId] != null ? a.wl_rank[optId] : null;
  const rb = b.wl_rank && b.wl_rank[optId] != null ? b.wl_rank[optId] : null;
  if (ra != null && rb != null) return ra - rb;
  if (ra != null) return -1;
  if (rb != null) return 1;
  return a.ts - b.ts;
};
const admWaiting = (optId) => admActive()
  .filter((r) => r.p1 === optId && r.confirmed !== optId).sort(byQueue(optId));
const admBackup = (optId) => admActive()
  .filter((r) => r.p2 === optId && r.confirmed !== optId).sort((a, b) => a.ts - b.ts);
const admWlPos = (optId, regId) => {
  const i = admWaiting(optId).findIndex((r) => r.id === regId);
  return i < 0 ? null : i + 1;
};
// One row per person per Saturday, so rows overcount people. Email is the key —
// the same email can't register twice for one date.
const admPeople = () => new Set(admActive().map((r) => (r.email || '').trim().toLowerCase()));

/* ---------- where someone stands (the thing admins actually read) ---------- */

const admMovedOn = (r) => {
  const h = (r.history || []).filter((x) => /^Admin (moved|placed)/.test(x.text || '')).pop();
  return h ? new Date(Number(h.ts)).toLocaleDateString('en-SG', { day: 'numeric', month: 'short' }) : null;
};

/* Four states, and — for the two that need explaining — why they're in it.
   "Waiting for 1st" covers both a full option at sign-up and a deliberate
   admin move; the note is what tells them apart. */
function placement(r) {
  if (r.status !== 'active') return { kind: 'cancelled', label: 'CANCELLED', c: '#8A8F80', bg: '#F0EEE6', note: '' };
  if (!r.confirmed) {
    return { kind: 'none', label: 'NOT PLACED', c: '#A13B2A', bg: '#F9E7E2',
      note: 'Slot was released — they are not in any team for this Saturday.' };
  }
  const confOpt = admOpt(r.confirmed);
  if (confOpt && confOpt.removed) {
    return { kind: 'gone', label: 'OPTION REMOVED', c: '#A13B2A', bg: '#F9E7E2',
      note: `"${confOpt.name}" was removed — they have no place yet.` };
  }
  const p1Opt = admOpt(r.p1);
  if (p1Opt && p1Opt.removed) {
    return { kind: 'gone1st', label: 'CHOICE REMOVED', c: '#9A5B14', bg: '#FBEEDD',
      note: `"${p1Opt.name}" was their 1st choice and was removed. They are serving in ${
        shortName(confOpt ? confOpt.name : r.confirmed)} — confirm that or move them.` };
  }
  if (r.confirmed === r.p1) return { kind: 'first', label: '1ST CHOICE', c: '#256B43', bg: '#E7F2E9', note: '' };
  if (r.confirmed !== r.p2) {
    return { kind: 'other', label: 'NOT A CHOICE', c: '#9A5B14', bg: '#FBEEDD',
      note: `They are serving in ${shortName(confOpt ? confOpt.name : r.confirmed)}, which is not one of their choices any more.` };
  }
  const day = admMovedOn(r);
  return { kind: 'waiting', label: 'WAITING FOR 1ST', c: '#9A5B14', bg: '#FBEEDD',
    note: r.placed_by_admin
      ? `Team balancing — an admin moved them here${day ? ` on ${day}` : ''}.`
      : '1st choice was full when they signed up.' };
}

// Their 1st choice has room again AND nobody deliberately put them elsewhere.
// Without the second half, every balancing move would immediately nag us to undo it.
const canPlaceInFirst = (r) => {
  if (r.status !== 'active' || r.confirmed === r.p1 || r.placed_by_admin) return false;
  const o = admOpt(r.p1);
  return !!o && admRemaining(o) > 0;
};

/* ---------- form logic ---------- */

function pick(dateId, optId, rank) {
  const cur = { ...(S.sel[dateId] || {}) };
  const other = rank === 'p1' ? 'p2' : 'p1';
  if (cur[rank] === optId) cur[rank] = null;
  else { cur[rank] = optId; if (cur[other] === optId) cur[other] = null; }
  S.sel[dateId] = cur;
  S.errors = []; S.submitError = '';
  render();
}

function validate() {
  const errs = [];
  if (!S.fName.trim()) errs.push('Enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(S.fEmail.trim())) errs.push('Enter a valid email address.');
  if (!/^[\d\s+\-]{8,15}$/.test(S.fMobile.trim())) errs.push('Enter a valid mobile number.');
  if (!/^[a-zA-Z0-9]{4}$/.test(S.fNric.trim())) errs.push('NRIC field must be exactly 4 characters (e.g. 123A).');
  for (const f of S.pub.fields || []) {
    const v = (S.extra[f.id] || '').trim();
    if (f.required && !v) errs.push(`${f.label} is required.`);
    else if (f.type === 'select' && v && !(f.options || []).includes(v)) {
      errs.push(`${f.label}: choose one of the listed options.`);
    }
  }
  const picked = S.pub.dates.filter((d) => { const c = S.sel[d.id]; return c && (c.p1 || c.p2); });
  if (!picked.length) errs.push('Select preferences for at least one Saturday.');
  for (const d of picked) {
    const c = S.sel[d.id];
    if (!c.p1 || !c.p2) {
      if (d.options.length >= 2) errs.push(`${d.label}: choose both a 1st and 2nd preference.`);
      else if (!c.p1) errs.push(`${d.label}: choose a 1st preference.`);
      continue;
    }
    const r1 = remaining(pubOpt(c.p1)), r2 = remaining(pubOpt(c.p2));
    if (r1 === 0 && r2 === 0) errs.push(`${d.label}: both selected options are full. Please change either preference to an option with available capacity before submitting.`);
  }
  return errs;
}

async function doSubmit() {
  if (S.submitting) return;
  S.submitting = true; S.submitError = ''; render();
  const entries = S.pub.dates
    .filter((d) => { const c = S.sel[d.id]; return c && c.p1; })
    .map((d) => ({ date_id: d.id, p1: S.sel[d.id].p1, p2: S.sel[d.id].p2 || null }));
  try {
    const extra = {};
    for (const f of S.pub.fields || []) {
      const v = (S.extra[f.id] || '').trim();
      if (v) extra[f.id] = v;
    }
    const res = await rpc('submit_registration', {
      p_name: S.fName.trim(), p_email: S.fEmail.trim(),
      p_mobile: S.fMobile.trim(), p_nric: S.fNric.trim().toUpperCase(),
      p_entries: entries, p_extra: extra,
    });
    if (!res.ok) {
      S.submitError = res.error || 'Submission failed. Please try again.';
      await loadPublic();
    } else {
      S.doneRegs = res.regs;
      S.doneName = S.fName.trim().split(' ')[0];
      S.view = 'done';
      S.sel = {}; S.submitError = '';
      await loadPublic();
    }
  } catch (e) {
    S.submitError = 'Could not reach the server — your registration was NOT submitted. Please try again.';
  }
  S.submitting = false;
  render();
}

/* ---------- admin actions ---------- */

async function adminLogin(code) {
  S.admin.checking = true; S.admin.loginError = ''; render();
  try {
    const ok = await rpc('admin_check', { p_code: code });
    if (ok === true) {
      S.admin.code = code; S.admin.authed = true;
      sessionStorage.setItem('ss_admin_code', code);
      await refreshAdmin();
    } else {
      S.admin.loginError = 'Incorrect passcode.';
    }
  } catch (e) {
    S.admin.loginError = 'Could not reach the server.';
  }
  S.admin.checking = false;
  render();
}

async function refreshAdmin() {
  try {
    const res = await rpc('admin_get_state', { p_code: S.admin.code });
    if (res.ok) { S.admin.state = res; S.netError = ''; }
    else { S.admin.authed = false; S.admin.state = null; }
  } catch (e) {
    S.netError = 'Could not reach the server. Please refresh.';
  }
}

async function adminAct(action, payload) {
  const res = await adminActRes(action, payload);
  render();
  return res;
}

// Same call, but hands back the server's reply so a panel can show why it refused.
async function adminActRes(action, payload) {
  try {
    const res = await rpc('admin_action', { p_code: S.admin.code, p_action: action, p: payload || {} });
    if (!res.ok && res.error === 'unauthorized') { S.admin.authed = false; }
    await refreshAdmin();
    await loadPublic();
    return res;
  } catch (e) {
    S.netError = 'Action failed — could not reach the server.';
    return { ok: false, error: 'Could not reach the server.' };
  }
}

function reorderWl(optId, regId, dir) {
  const wl = admWaiting(optId);
  const i = wl.findIndex((r) => r.id === regId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= wl.length) return;
  const order = wl.map((r) => r.id);
  [order[i], order[j]] = [order[j], order[i]];
  adminAct('reorder_wl', { opt: optId, order, moved: regId });
}

async function downloadCsv() {
  try {
    const csv = await rpc('export_csv', { p_token: A().export_token });
    if (csv == null) return;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mission-month-registrations.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    S.netError = 'CSV export failed — could not reach the server.';
    render();
  }
}

/* ---------- rendering ---------- */

function optionBadge(rem) {
  if (rem <= 0) return { t: 'FULL — WAITLIST', bg: '#F9E7E2', c: '#A13B2A', bar: '#C96F4A' };
  if (rem <= ALMOST_FULL_AT) return { t: 'ALMOST FULL', bg: '#FBEEDD', c: '#9A5B14', bar: '#D99A4E' };
  return { t: 'AVAILABLE', bg: '#E7F2E9', c: '#256B43', bar: '#2E5B3F' };
}

function renderHeader() {
  const onAdmin = S.view === 'admin';
  return `
  <div class="topbar"><div class="topbar-inner">
    <div class="logo-row">
      <div class="logo-mark"><img class="logo-img" src="/favicon.png" alt=""></div>
      <div class="logo-name">Mission Month</div>
    </div>
    <div class="nav-pills">
      <button class="nav-pill ${onAdmin ? '' : 'on'}" data-act="nav-register">Register</button>
      <button class="nav-pill ${onAdmin ? 'on' : ''}" data-act="nav-admin">Admin</button>
    </div>
  </div></div>
  ${S.netError ? `<div class="net-err">${esc(S.netError)}</div>` : ''}`;
}

// Admin-defined questions, rendered alongside the four built-in particulars.
function renderExtraFields(fields) {
  return fields.map((f) => {
    const val = S.extra[f.id] || '';
    const optional = f.required ? '' : ' <span class="opt-tag">(optional)</span>';
    const control = f.type === 'select'
      ? `<select data-xfield="${esc(f.id)}">
           <option value=""${val ? '' : ' selected'}>Select…</option>
           ${(f.options || []).map((o) =>
             `<option value="${esc(o)}"${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('')}
         </select>`
      : `<input data-xfield="${esc(f.id)}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}">`;
    return `<div class="field"><label>${esc(f.label)}${optional}</label>${control}</div>`;
  }).join('');
}

function renderForm() {
  const pub = S.pub;
  if (!pub) return '<div class="loading">Loading…</div>';
  const paras = descHtml(pub.description);

  const dates = pub.dates.map((d) => {
    const sel = S.sel[d.id] || {};
    const opts = d.options.map((o) => {
      const rem = remaining(o);
      const b = optionBadge(rem);
      const pct = Math.min(100, Math.round(o.confirmed / Math.max(1, o.capacity) * 100));
      const isP1 = sel.p1 === o.id, isP2 = sel.p2 === o.id;
      const border = isP1 ? '2px solid #2E5B3F' : (isP2 ? '2px solid #C96F4A' : '1px solid #E3E0D5');
      const bg = isP1 ? '#F3F8F3' : (isP2 ? '#FBF3EE' : '#fff');
      const remainColor = rem <= 0 ? '#A13B2A' : (rem <= ALMOST_FULL_AT ? '#9A5B14' : '#256B43');
      return `
      <div class="opt-card" style="border:${border};background:${bg};">
        <div class="opt-top">
          <div class="opt-name">${esc(o.name)}</div>
          <span class="badge" style="background:${b.bg};color:${b.c};">${b.t}</span>
        </div>
        ${o.blurb ? `<p class="opt-blurb">${richText(o.blurb)}</p>` : ''}
        <div>
          <div class="meter"><div style="width:${pct}%;background:${b.bar};"></div></div>
          <div class="meter-row">
            <span>${o.confirmed} / ${o.capacity} filled</span>
            <span style="font-weight:600;color:${remainColor};">${rem <= 0 ? 'Waitlist available' : `${rem} ${rem === 1 ? 'place' : 'places'} remaining`}</span>
          </div>
        </div>
        <div class="pref-btns">
          <button class="pref-btn p1 ${isP1 ? 'on' : ''}" data-act="pick" data-date="${d.id}" data-opt="${o.id}" data-rank="p1">1st choice</button>
          <button class="pref-btn p2 ${isP2 ? 'on' : ''}" data-act="pick" data-date="${d.id}" data-opt="${o.id}" data-rank="p2">2nd choice</button>
        </div>
      </div>`;
    }).join('');

    const allFull = d.options.every((o) => remaining(o) <= 0);
    const o1 = sel.p1 ? pubOpt(sel.p1) : null, o2 = sel.p2 ? pubOpt(sel.p2) : null;
    let warn = '', tone = null;
    if (o1 && o2 && remaining(o1) <= 0 && remaining(o2) <= 0) {
      warn = 'Both selected options are full. Please change either your first or second preference to an option with available capacity before submitting.'; tone = 'error';
    } else if ((o1 && remaining(o1) <= 0) || (o2 && remaining(o2) <= 0)) {
      warn = 'One of your choices is currently full. You may keep it as a preference — you will be placed on its waitlist — but you must also have at least one choice that currently has availability.'; tone = 'warn';
    }
    const toneMap = { warn: ['#FBEEDD', '#F0D5AE', '#9A5B14'], error: ['#F9E7E2', '#EBC5BB', '#A13B2A'] };
    let selText = 'Skipping this date', selColor = '#8A8F80';
    if (o1 && o2) { selText = '1st + 2nd selected ✓'; selColor = '#256B43'; }
    else if (o1 || o2) { selText = 'Select one more preference'; selColor = '#9A5B14'; }

    return `
    <div class="date-card">
      <div class="date-head">
        <h2>${esc(d.label)}</h2>
        <span class="date-sel" style="color:${selColor};">${selText}</span>
      </div>
      <p class="date-hint">${richText(d.subtitle || 'Pick a 1st and 2nd choice — or leave blank to skip this Saturday.')}</p>
      ${allFull ? '<div class="all-full">All options for this date are currently full.</div>' : ''}
      <div class="opt-grid">${opts}</div>
      ${warn ? `<div class="date-warn" style="background:${toneMap[tone][0]};border-color:${toneMap[tone][1]};color:${toneMap[tone][2]};">${warn}</div>` : ''}
    </div>`;
  }).join('');

  const errs = S.errors.length ? `
    <div class="err-box">
      <div class="err-title">Please fix the following before continuing:</div>
      ${S.errors.map((e) => `<div class="err-item">• ${esc(e)}</div>`).join('')}
    </div>` : '';

  return `
  <div class="wrap fade-up">
    <div class="hero">
      <div class="blob1"></div><div class="blob2"></div>
      <h1>${esc(pub.title)}</h1>
      ${paras}
      <div class="hero-chips">
        <span class="hero-chip">✔ One confirmed slot per Saturday</span>
        <span class="hero-chip">Backup choice kept on waitlist</span>
      </div>
    </div>
    <div class="card">
      <h2>Your details</h2>
      <p class="sub">We only ask for the last 4 characters of your NRIC — never the full number.</p>
      <div class="fields">
        <div class="field"><label>FULL NAME</label><input data-field="fName" value="${esc(S.fName)}" placeholder="e.g. Tan Wei Ling"></div>
        <div class="field"><label>EMAIL ADDRESS</label><input data-field="fEmail" value="${esc(S.fEmail)}" placeholder="you@example.com" type="email"></div>
        <div class="field"><label>MOBILE NUMBER</label><input data-field="fMobile" value="${esc(S.fMobile)}" placeholder="e.g. 9123 4567" type="tel"></div>
        <div class="field"><label>LAST 4 DIGITS/CHARACTERS OF NRIC</label><input data-field="fNric" class="nric" value="${esc(S.fNric)}" placeholder="e.g. 123A" maxlength="4"></div>
        ${renderExtraFields(pub.fields || [])}
      </div>
    </div>
    ${dates}
    ${errs}
    <button class="cta" data-act="goReview">Review my registration →</button>
    <p class="fine">Availability is only finalised when your submission is processed.</p>
  </div>`;
}

function renderReview() {
  const rows = S.pub.dates
    .filter((d) => { const c = S.sel[d.id]; return c && c.p1; })
    .map((d) => {
      const c = S.sel[d.id];
      const o1 = pubOpt(c.p1), o2 = c.p2 ? pubOpt(c.p2) : null;
      const r1 = remaining(o1), r2 = o2 ? remaining(o2) : 0;
      const mk = (rem) => rem > 0
        ? { t: 'AVAILABLE', bg: '#E7F2E9', c: '#256B43' }
        : { t: 'FULL — WAITLIST', bg: '#F9E7E2', c: '#A13B2A' };
      const b1 = mk(r1), b2 = o2 ? mk(r2) : { t: '—', bg: '#F0EEE6', c: '#8A8F80' };
      const expConf = r1 > 0 ? o1.name : (o2 && r2 > 0 ? o2.name : null);
      const expWl = expConf === o1.name ? (o2 ? o2.name : null) : o1.name;
      return `
      <div class="review-card">
        <div class="brico" style="font-weight:700;font-size:17px;margin-bottom:12px;">${esc(d.label)}</div>
        <div style="display:flex;flex-direction:column;gap:9px;">
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <span style="font-size:14px;"><strong>1st:</strong> ${esc(o1.name)}</span>
              <span class="badge" style="background:${b1.bg};color:${b1.c};">${b1.t}</span>
            </div>
            ${o1.blurb ? `<p class="opt-blurb review">${richText(o1.blurb)}</p>` : ''}
          </div>
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <span style="font-size:14px;"><strong>2nd:</strong> ${o2 ? esc(o2.name) : '—'}</span>
              <span class="badge" style="background:${b2.bg};color:${b2.c};">${b2.t}</span>
            </div>
            ${o2 && o2.blurb ? `<p class="opt-blurb review">${richText(o2.blurb)}</p>` : ''}
          </div>
        </div>
        <div class="review-expect">${expConf ? `Expected: Confirmed — ${esc(expConf)}${expWl ? ` · Waitlisted — ${esc(expWl)}` : ''}` : 'Both options currently full'}</div>
      </div>`;
    }).join('');

  return `
  <div class="wrap wrap-narrow fade-up">
    <h1 style="margin:0 0 6px;font-weight:800;font-size:28px;">Review before you submit</h1>
    <p style="margin:0 0 20px;font-size:14px;color:#6B7263;line-height:1.6;">Check your choices below. Availability is finalised only when your submission is processed — if a slot is taken while you review, we will allocate you by the latest availability.</p>
    <div class="review-card" style="padding:18px 20px;">
      <div style="font-weight:700;font-size:15px;margin-bottom:6px;">${esc(S.fName)}</div>
      <div style="font-size:13.5px;color:#6B7263;">${esc([S.fEmail, S.fMobile, 'NRIC ***' + S.fNric.toUpperCase()].join(' · '))}</div>
      ${(S.pub.fields || []).filter((f) => (S.extra[f.id] || '').trim()).map((f) =>
        `<div style="font-size:13.5px;color:#6B7263;margin-top:4px;">${esc(f.label)} <strong style="color:#22301F;">${esc(S.extra[f.id])}</strong></div>`).join('')}
    </div>
    ${rows}
    ${S.submitError ? `<div class="submit-err">${esc(S.submitError)}</div>` : ''}
    <div class="btn-row">
      <button class="btn-ghost" data-act="backToForm">← Edit choices</button>
      <button class="btn-main" data-act="doSubmit" ${S.submitting ? 'disabled' : ''}>${S.submitting ? 'Submitting…' : 'Confirm &amp; submit'}</button>
    </div>
  </div>`;
}

function renderDone() {
  const rows = S.doneRegs.map((r) => {
    const gotFirst = r.confirmed === r.p1;
    const pos = r.wl_pos && r.wl_pos.p1;
    // Got their 1st choice? Then the 2nd is a backup we hold, not a queue they
    // are stuck in — telling them "waitlisted" for it would only worry them.
    const b1 = gotFirst
      ? { t: 'CONFIRMED', bg: '#E7F2E9', c: '#256B43' }
      : { t: `WAITLIST #${pos || '—'}`, bg: '#EEE9F8', c: '#6C4AB0' };
    const b2 = !r.p2 ? { t: '—', bg: '#F0EEE6', c: '#8A8F80' }
      : gotFirst ? { t: 'BACKUP CHOICE', bg: '#F0EEE6', c: '#6B7263' }
      : { t: 'CONFIRMED', bg: '#E7F2E9', c: '#256B43' };
    return `
    <div class="review-card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
        <div class="brico" style="font-weight:700;font-size:17px;">${esc(r.date_label)}</div>
        <div style="font-size:12px;color:#8A8F80;font-weight:600;letter-spacing:0.05em;">${esc(r.reg_id)}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:14px;">
          <span><strong>1st preference:</strong> ${esc(r.p1_name)}</span>
          <span class="badge" style="background:${b1.bg};color:${b1.c};">${b1.t}</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:14px;">
          <span><strong>2nd preference:</strong> ${r.p2_name ? esc(r.p2_name) : '—'}</span>
          <span class="badge" style="background:${b2.bg};color:${b2.c};">${b2.t}</span>
        </div>
      </div>
      <div class="done-confirm">Confirmed allocation: ${esc(r.confirmed_name)}</div>
    </div>`;
  }).join('');

  return `
  <div class="wrap wrap-narrow fade-up">
    <div style="text-align:center;margin-bottom:22px;">
      <div class="done-check">✓</div>
      <h1 style="margin:0 0 6px;font-weight:800;font-size:28px;">Registration successful</h1>
      <p style="margin:0;font-size:14px;color:#6B7263;">Thank you, ${esc(S.doneName)} — see you in September!</p>
    </div>
    ${rows}
    <p class="done-note">${S.doneRegs.some((r) => r.confirmed !== r.p1)
      ? 'Where your first choice was already full we have confirmed your second choice and kept you on the waitlist for your first — we will contact you if a place opens up.'
      : 'You are in your first choice for every Saturday above. Your second choices are kept as backups in case the organisers need to rebalance teams.'}</p>
    <button class="btn-ghost" style="margin-top:10px;width:100%;font-size:14px;padding:13px;" data-act="registerAnother">Register another person</button>
  </div>`;
}

/* ---------- admin rendering ---------- */

// The two lines every person card shows: their choices, and where they landed.
function personCardHtml(r) {
  const o1 = admOpt(r.p1), o2 = r.p2 ? admOpt(r.p2) : null;
  const pl = placement(r);
  const prefLine = `1st: ${esc(shortName(o1 ? o1.name : r.p1))} · 2nd: ${o2 ? esc(shortName(o2.name)) : '—'}`;
  const other = r.confirmed === r.p1 ? r.p2 : r.p1;
  const otherOpt = other ? admOpt(other) : null;
  const canMove = !!(r.confirmed && otherOpt && admRemaining(otherOpt) > 0);
  const moveLabel = otherOpt
    ? (other === r.p1 ? `↩ Back to 1st: ${shortName(otherOpt.name)}` : `Move to 2nd: ${shortName(otherOpt.name)}`)
    : '';
  return { o1, o2, pl, prefLine, canMove, otherOpt, moveLabel };
}

/* One panel, two triggers: an option being retired, and an option whose limit
   was lowered below the people already in it. Both end the same way — every
   affected person needs somewhere to be, or an explicit "leave them unplaced"
   so an admin knows to call them. */
function renderMovePanel() {
  const mo = S.admin.moveOut;
  const opt = admOpt(mo.opt);
  if (!opt) return '';
  const date = (A().dates || []).find((d) => (d.options || []).some((o) => o.id === opt.id));
  if (!date) return '';
  const live = liveOpts(date).filter((o) => o.id !== opt.id);
  const people = mo.mode === 'rehome' ? admPending(opt.id) : admOverflow(opt);

  const rows = people.map((r) => {
    const pick = mo.picks[r.id] === undefined ? defaultDest(r, opt.id) : mo.picks[r.id];
    const at = r.confirmed ? admOpt(r.confirmed) : null;
    const lost = r.confirmed === opt.id; // was actually serving in the removed option
    // p1 is required, so someone with no surviving second choice must be given one
    const mustPick = mo.mode === 'rehome' && r.p1 === opt.id && !r.p2;
    return `
    <div class="move-row">
      <div class="move-who">
        <strong>${esc(r.name)}</strong>
        <span class="move-meta">${esc(r.mobile)} · ${esc(r.email)}</span>
        <span class="move-meta">${mo.mode === 'rehome'
          ? (lost ? 'Was serving in the removed option — has no place right now'
                  : `Was their 1st choice · currently serving in ${esc(shortName(at ? at.name : '—'))}`)
          : `Signed up ${fmtTs(r.ts)} — last in, so first over the line`}</span>
      </div>
      <select class="mini-select" data-set="move-dest" data-reg="${r.id}">
        ${live.map((o) => `<option value="${o.id}"${pick === o.id ? ' selected' : ''}>${esc(shortName(o.name))} — ${admRemaining(o)} left</option>`).join('')}
        ${mustPick ? '' : `<option value=""${pick === '' ? ' selected' : ''}>Leave unplaced — I'll call them</option>`}
      </select>
    </div>`;
  }).join('') || '<p class="hint">Nobody is affected.</p>';

  const clash = movePanelClash();
  return `
  <div class="move-panel">
    <div class="move-head">${mo.mode === 'rehome'
      ? `"${esc(opt.name)}" was removed — where do these ${people.length} ${people.length === 1 ? 'person goes' : 'people go'}?`
      : `"${esc(opt.name)}" holds ${admConfirmedCount(opt.id)} people but the limit is now ${opt.capacity}`}</div>
    <p class="move-sub">${mo.mode === 'rehome'
      ? 'Nobody was dropped when you removed it. Take your time — call them first if you want, and do these one at a time. Whatever you pick becomes their 1st choice, so they are not left queueing for something that no longer exists.'
      : 'Nobody has been removed — these are the latest sign-ups, so they are the ones over the line. Move them or leave them unplaced and call them.'}</p>
    ${rows}
    ${clash.length ? `<div class="move-clash">Not enough room in ${esc(clash.join(', '))}. Pick somewhere else or raise that capacity first.</div>` : ''}
    ${mo.error ? `<div class="move-clash">${esc(mo.error)}</div>` : ''}
    <div class="p-actions" style="margin-top:12px;">
      <button class="chip-btn promote" data-act="move-confirm" ${clash.length ? 'disabled' : ''}>${
        mo.mode === 'rehome' ? `Reassign ${people.length === 1 ? 'this person' : `these ${people.length}`}` : `Move ${people.length} out`}</button>
      <button class="chip-btn" data-act="move-cancel">Cancel</button>
    </div>
  </div>`;
}

// Would these picks overfill anything? Counts the places the same moves free up.
function movePanelClash() {
  const mo = S.admin.moveOut;
  const opt = admOpt(mo.opt);
  const people = mo.mode === 'rehome' ? admPending(mo.opt) : admOverflow(opt);
  const delta = {};
  for (const r of people) {
    const dest = mo.picks[r.id] === undefined ? defaultDest(r, mo.opt) : mo.picks[r.id];
    if (r.confirmed && r.confirmed !== dest) delta[r.confirmed] = (delta[r.confirmed] || 0) - 1;
    if (dest && r.confirmed !== dest) delta[dest] = (delta[dest] || 0) + 1;
  }
  return Object.keys(delta).filter((id) => {
    const o = admOpt(id);
    return delta[id] > 0 && o && admRemaining(o) < delta[id];
  }).map((id) => `${shortName(admOpt(id).name)} (needs ${delta[id]}, has ${admRemaining(admOpt(id))})`);
}

const placeBadge = (pl) => `<span class="badge" style="background:${pl.bg};color:${pl.c};">${pl.label}</span>`;
const placeNote = (pl) => pl.note ? `<div class="place-note" style="color:${pl.c};">${esc(pl.note)}</div>` : '';

function renderAdminDash() {
  const a = A();
  const active = admActive();
  const placedElsewhere = active.filter((r) => placement(r).kind === 'waiting');
  const unplaced = active.filter((r) => placement(r).kind === 'none');
  const movable = active.filter(canPlaceInFirst);

  const stats = `
  <div class="stats">
    <div class="stat"><div class="n">${admPeople().size}</div><div class="l">People signed up</div></div>
    <div class="stat"><div class="n" style="color:#2E5B3F;">${active.filter((r) => r.confirmed).length}</div><div class="l">Saturday places taken</div></div>
    <div class="stat"><div class="n" style="color:#9A5B14;">${placedElsewhere.length}</div><div class="l">Not in their 1st choice</div></div>
    <div class="stat"><div class="n" style="color:#2E5B3F;">${movable.length}</div><div class="l">Can be placed now</div></div>
    <div class="stat"><div class="n" style="color:#B0691C;">${active.filter((r) => r.dup_flag).length}</div><div class="l">Flagged duplicates</div></div>
  </div>`;

  // Only rows the system bumped show up here. A move we made on purpose is not
  // a problem to fix, so it never nags — it just carries its note.
  const banner = (movable.length || unplaced.length) ? `
  <div class="banner">
    <div class="banner-head">${movable.length
      ? `${movable.length} ${movable.length === 1 ? 'person can' : 'people can'} now go into their 1st choice`
      : `${unplaced.length} ${unplaced.length === 1 ? 'person needs' : 'people need'} placing`}</div>
    <p class="banner-sub">Their 1st choice was full when they signed up and has room again. Anyone you moved for team balancing is left alone.</p>
    ${movable.concat(unplaced.filter((r) => !movable.includes(r))).map((r) => {
      const o1 = admOpt(r.p1);
      const date = a.dates.find((d) => d.id === r.date_id);
      const room = o1 && admRemaining(o1) > 0;
      return `
      <div class="banner-row">
        <div>
          <strong>${esc(r.name)}</strong>
          <span class="banner-meta">${esc((date ? date.label : r.date_id).replace('Saturday, ', ''))} · wants ${esc(shortName(o1 ? o1.name : r.p1))}</span>
        </div>
        ${room
          ? `<button class="chip-btn promote" data-act="adm-promote" data-reg="${r.id}" data-opt="${esc(r.p1)}">Place in 1st choice</button>`
          : '<span class="banner-meta">1st choice full</span>'}
      </div>`;
    }).join('')}
  </div>` : '';

  const dates = a.dates.map((d) => {
    const opts = liveOpts(d).map((o) => {
      const conf = admConfirmedCount(o.id);
      const rem = Math.max(0, o.capacity - conf);
      // Volunteers see "FULL — WAITLIST"; we just need to know it's full.
      const b = Object.assign({}, optionBadge(rem), rem <= 0 ? { t: 'FULL' } : {});
      const wl = admWaiting(o.id).length;
      const pct = Math.min(100, Math.round(conf / Math.max(1, o.capacity) * 100));
      const open = S.admin.open && S.admin.open.opt === o.id;
      return `
      <div class="adm-opt ${open ? 'open' : ''}" data-act="adm-open" data-date="${d.id}" data-opt="${o.id}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">
          <div style="font-weight:700;font-size:14.5px;">${esc(o.name)}</div>
          <span class="badge" style="background:${b.bg};color:${b.c};padding:2px 9px;font-size:10px;">${b.t}</span>
        </div>
        <div class="meter"><div style="width:${pct}%;background:${b.bar};"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:12.5px;color:#6B7263;">
          <span>Serving <strong style="color:#22301F;">${conf} / ${o.capacity}</strong></span>
          <span>Waiting <strong style="color:${wl ? '#9A5B14' : '#8A8F80'};">${wl}</strong></span>
        </div>
      </div>`;
    }).join('');

    let detail = '';
    if (S.admin.open && S.admin.open.date === d.id) {
      const opt = d.options.find((o) => o.id === S.admin.open.opt);
      if (opt) {
        const rem = admRemaining(opt);
        const serving = active.filter((r) => r.confirmed === opt.id).sort((x, y) => x.ts - y.ts);
        const waiting = admWaiting(opt.id);
        const backup = admBackup(opt.id);

        // Shared top of every person card in the detail panel.
        const who = (r) => `
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <div style="font-weight:700;font-size:13.5px;">${esc(r.name)} <span style="font-weight:500;color:#8A8F80;font-size:11.5px;">· NRIC ***${esc(r.nric)}</span></div>
            <div style="font-size:11px;color:#8A8F80;">${fmtTs(r.ts)}</div>
          </div>
          <div style="font-size:12px;color:#6B7263;margin-top:3px;">${esc(r.email)} · ${esc(r.mobile)}</div>
          ${extraLine(r) ? `<div style="font-size:12px;color:#2E5B3F;margin-top:3px;font-weight:600;">${extraLine(r)}</div>` : ''}`;

        const servingHtml = serving.map((r) => {
          const pc = personCardHtml(r);
          return `
          <div class="person">
            ${who(r)}
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;">
              ${placeBadge(pc.pl)}<span style="font-size:12px;color:#586052;">${pc.prefLine}</span>
            </div>
            ${placeNote(pc.pl)}
            <div class="p-actions">
              ${pc.canMove ? `<button class="chip-btn move" data-act="adm-move" data-reg="${r.id}">${esc(pc.moveLabel)}</button>` : ''}
              <button class="chip-btn" data-act="adm-release" data-reg="${r.id}">Release slot</button>
              <button class="chip-btn danger" data-act="adm-cancel" data-reg="${r.id}" data-name="${esc(r.name)}">Cancel</button>
            </div>
          </div>`;
        }).join('') || '<div style="font-size:13px;color:#8A8F80;padding:8px 0;">Nobody serving here yet.</div>';

        const waitingHtml = waiting.map((r, i) => {
          const pc = personCardHtml(r);
          const at = r.confirmed ? admOpt(r.confirmed) : null;
          return `
          <div class="person wl">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div style="font-weight:700;font-size:13.5px;"><span style="color:#9A5B14;">#${i + 1}</span> ${esc(r.name)} <span style="font-weight:500;color:#8A8F80;font-size:11.5px;">· NRIC ***${esc(r.nric)}</span></div>
              <div style="font-size:11px;color:#8A8F80;">${fmtTs(r.ts)}</div>
            </div>
            <div style="font-size:12px;color:#6B7263;margin-top:3px;">${esc(r.email)} · ${esc(r.mobile)}</div>
            ${extraLine(r) ? `<div style="font-size:12px;color:#2E5B3F;margin-top:3px;font-weight:600;">${extraLine(r)}</div>` : ''}
            <div style="font-size:12px;margin-top:5px;color:#586052;">Currently in: <strong>${at ? esc(shortName(at.name)) : 'nothing — not placed'}</strong></div>
            ${placeNote(pc.pl)}
            <div class="p-actions">
              ${rem > 0 ? `<button class="chip-btn promote" data-act="adm-promote" data-reg="${r.id}" data-opt="${opt.id}">Place here</button>` : '<span style="font-size:11px;color:#A13B2A;font-weight:600;">Full — release a slot first</span>'}
              <button class="chip-btn" data-act="adm-wl-up" data-reg="${r.id}" data-opt="${opt.id}">↑</button>
              <button class="chip-btn" data-act="adm-wl-down" data-reg="${r.id}" data-opt="${opt.id}">↓</button>
            </div>
          </div>`;
        }).join('') || '<div style="font-size:13px;color:#8A8F80;padding:8px 0;">Nobody is waiting for this one.</div>';

        const backupOpen = S.admin.backupOpen === opt.id;
        const backupHtml = backup.map((r) => {
          const at = r.confirmed ? admOpt(r.confirmed) : null;
          return `
          <div class="person backup">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div style="font-weight:700;font-size:13px;">${esc(r.name)}</div>
              <div style="font-size:11px;color:#8A8F80;">${esc(r.email)}</div>
            </div>
            <div style="font-size:12px;color:#6B7263;margin-top:3px;">Serving in <strong>${at ? esc(shortName(at.name)) : '— not placed'}</strong> · listed this as their 2nd choice</div>
            ${rem > 0 ? `<div class="p-actions"><button class="chip-btn" data-act="adm-promote" data-reg="${r.id}" data-opt="${opt.id}">Move here instead</button></div>` : ''}
          </div>`;
        }).join('');

        detail = `
        <div class="detail">
          <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
            <div class="brico" style="font-weight:700;font-size:17px;">${esc(opt.name)} — ${esc(d.label)}</div>
            <button class="chip-btn" style="border:none;background:#F6F2E8;padding:6px 12px;font-size:12px;" data-act="adm-close">Close ✕</button>
          </div>
          <div class="detail-cols">
            <div class="detail-col">
              <div class="col-head" style="color:#256B43;">SERVING HERE (${serving.length} / ${opt.capacity})</div>
              ${servingHtml}
            </div>
            <div class="detail-col">
              <div class="col-head" style="color:#9A5B14;">WAITING FOR THIS SPOT (${waiting.length})</div>
              <p class="col-hint">Chose this first, didn't get in.</p>
              ${waitingHtml}
            </div>
          </div>
          ${backup.length ? `
          <div class="backup-block">
            <button class="backup-toggle" data-act="adm-backup" data-opt="${opt.id}">
              ${backupOpen ? '▾' : '▸'} Backup interest (${backup.length}) — happy where they are, listed this second
            </button>
            ${backupOpen ? backupHtml : ''}
          </div>` : ''}
        </div>`;
      }
    }

    return `
    <div style="margin-bottom:26px;">
      <h2 style="margin:0 0 12px;font-weight:700;font-size:19px;">${esc(d.label)}</h2>
      <div class="adm-grid">${opts}</div>
      ${detail}
    </div>`;
  }).join('');

  const pending = admRetiredPending();
  const pendingBanner = pending.map((x) => `
  <div class="banner over">
    <div class="banner-head">${x.people.length} ${x.people.length === 1 ? 'person needs' : 'people need'} a new place — "${esc(x.opt.name)}" was removed</div>
    <p class="banner-sub">${esc(x.date.label)}. Nobody was dropped and nobody new can sign up for it. Reassign them whenever you're ready — one at a time is fine.</p>
    <div class="banner-row">
      <div>${x.people.map((r) => esc(r.name)).join(' · ')}</div>
      <button class="chip-btn promote" data-act="move-open" data-opt="${x.opt.id}" data-mode="rehome">Reassign ${x.people.length}</button>
    </div>
    ${S.admin.moveOut && S.admin.moveOut.mode === 'rehome' && S.admin.moveOut.opt === x.opt.id ? renderMovePanel() : ''}
  </div>`).join('');

  const over = admOverCapacity();
  const overBanner = over.length ? `
  <div class="banner over">
    <div class="banner-head">${over.reduce((n, x) => n + x.over, 0)} ${over.reduce((n, x) => n + x.over, 0) === 1 ? 'person is' : 'people are'} over the limit</div>
    <p class="banner-sub">A capacity was lowered below the number already confirmed. Nobody has been removed — sort out where they go, or put the limit back up.</p>
    ${over.map((x) => `
      <div class="banner-row">
        <div>
          <strong>${esc(x.opt.name)}</strong>
          <span class="banner-meta">${esc(x.date.label.replace('Saturday, ', ''))} · ${admConfirmedCount(x.opt.id)} in, limit ${x.opt.capacity}</span>
        </div>
        <button class="chip-btn promote" data-act="move-open" data-opt="${x.opt.id}" data-mode="capacity">Move ${x.over} out</button>
      </div>`).join('')}
    ${S.admin.moveOut && S.admin.moveOut.mode === 'capacity' ? renderMovePanel() : ''}
  </div>` : '';

  return stats + pendingBanner + overBanner + banner + dates;
}

/* One card per PERSON, with their Saturdays inside it. A row per registration
   made six volunteers look like seventeen sign-ups. */
function admGroupPeople() {
  const a = A();
  const order = new Map(a.dates.map((d, i) => [d.id, i]));
  const people = new Map();
  for (const r of a.registrations) {
    const key = (r.email || '').trim().toLowerCase() || r.id;
    if (!people.has(key)) people.set(key, { key, regs: [], last: 0, dup: false });
    const p = people.get(key);
    p.regs.push(r);
    if (r.dup_flag) p.dup = true;
    if (r.ts >= p.last) { p.last = r.ts; p.name = r.name; p.email = r.email; p.mobile = r.mobile; p.nric = r.nric; p.extraOf = r; }
  }
  for (const p of people.values()) {
    p.regs.sort((x, y) => (order.get(x.date_id) ?? 99) - (order.get(y.date_id) ?? 99));
    p.active = p.regs.filter((r) => r.status === 'active');
  }
  return [...people.values()].sort((x, y) => y.last - x.last);
}

/* Changing what someone ASKED FOR, as opposed to where they were put. Needed
   most after an option is removed — everyone who had it as a backup is left with
   none, and there was no way to give them one — but it equally covers "they rang
   and changed their mind" and "we tapped the wrong option at sign-up". */
function renderPrefEdit(r) {
  const pe = S.admin.prefEdit[r.id];
  if (!pe) return '';
  const opts = liveOpts(admDate(r.date_id));
  const list = (sel) => opts.map((o) =>
    `<option value="${o.id}"${sel === o.id ? ' selected' : ''}>${esc(shortName(o.name))} — ${admRemaining(o)} left</option>`).join('');
  const same = pe.p1 && pe.p1 === pe.p2;
  return `
  <div class="pref-edit">
    <div class="pref-edit-row">
      <label>1st choice
        <select class="mini-select" data-set="pref-p1" data-reg="${r.id}">${list(pe.p1)}</select>
      </label>
      <label>2nd choice
        <select class="mini-select" data-set="pref-p2" data-reg="${r.id}">
          <option value=""${pe.p2 ? '' : ' selected'}>None</option>${list(pe.p2)}
        </select>
      </label>
    </div>
    <p class="hint" style="margin:8px 0 0;">This changes what they asked for, not where they are serving — that stays put until you move them.</p>
    ${same ? '<div class="move-clash">1st and 2nd choice must be different.</div>' : ''}
    ${pe.error ? `<div class="move-clash">${esc(pe.error)}</div>` : ''}
    <div class="p-actions">
      <button class="chip-btn promote" data-act="pref-save" data-reg="${r.id}" ${same ? 'disabled' : ''}>Save choices</button>
      <button class="chip-btn" data-act="pref-cancel" data-reg="${r.id}">Cancel</button>
    </div>
  </div>`;
}

function renderAdminPeople() {
  const a = A();
  const q = (S.admin.q || '').trim().toLowerCase();
  const hit = (p) => !q || [p.name, p.email, p.mobile, p.nric].concat(p.regs.map((r) => r.reg_id))
    .some((x) => (x || '').toLowerCase().includes(q));
  const people = admGroupPeople().filter(hit);

  const list = people.map((p) => {
    const rows = p.regs.map((r) => {
      const pc = personCardHtml(r);
      const date = a.dates.find((d) => d.id === r.date_id);
      const at = r.confirmed ? admOpt(r.confirmed) : null;
      const hist = S.admin.histOpen[r.id] ? `
        <div class="hist">${(r.history || []).map((h) =>
          `<div class="hist-row"><span style="color:#8A8F80;">${fmtTs(h.ts)}</span> — ${esc(h.text)}</div>`).join('')}
        </div>` : '';
      return `
      <div class="sat-row">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;">
          <div style="font-weight:700;font-size:13.5px;">${esc((date ? date.label : r.date_id).replace('Saturday, ', ''))}
            <span style="font-weight:500;font-size:11.5px;color:#8A8F80;margin-left:6px;">${esc(r.reg_id)}</span></div>
          ${placeBadge(pc.pl)}
        </div>
        <div style="font-size:12.5px;color:#586052;margin-top:5px;">
          Serving in <strong style="color:#256B43;">${at ? esc(shortName(at.name)) : '— not placed'}</strong>
          <span style="color:#8A8F80;"> · ${pc.prefLine}</span>
        </div>
        ${placeNote(pc.pl)}
        <div class="p-actions">
          ${canPlaceInFirst(r) ? `<button class="chip-btn promote" data-act="adm-promote" data-reg="${r.id}" data-opt="${esc(r.p1)}">Place in 1st choice</button>` : ''}
          ${pc.canMove ? `<button class="chip-btn move" data-act="adm-move" data-reg="${r.id}">${esc(pc.moveLabel)}</button>` : ''}
          ${r.status === 'active' ? `<button class="chip-btn" data-act="pref-edit" data-reg="${r.id}">Edit choices</button>` : ''}
          ${r.status === 'active' ? `<button class="chip-btn danger" data-act="adm-cancel" data-reg="${r.id}" data-name="${esc(r.name)}">Cancel</button>` : ''}
          <button class="chip-btn" data-act="adm-hist" data-reg="${r.id}">History</button>
        </div>
        ${renderPrefEdit(r)}
        ${hist}
      </div>`;
    }).join('');

    const n = p.active.length;
    return `
    <div class="people-row">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div>
          <span style="font-weight:700;font-size:15px;">${esc(p.name)}</span>
          <span class="tag sats">${n} ${n === 1 ? 'SATURDAY' : 'SATURDAYS'}</span>
          ${p.dup ? '<span class="tag dup">POSSIBLE DUPLICATE</span>' : ''}
        </div>
        <div style="font-size:11.5px;color:#8A8F80;">Signed up ${fmtTs(p.last)}</div>
      </div>
      <div style="font-size:12.5px;color:#6B7263;margin-top:4px;">${esc(p.email)} · ${esc(p.mobile)} · NRIC ***${esc(p.nric)}</div>
      ${extraLine(p.extraOf) ? `<div style="font-size:12.5px;color:#2E5B3F;margin-top:3px;font-weight:600;">${extraLine(p.extraOf)}</div>` : ''}
      ${rows}
    </div>`;
  }).join('');

  return `
  <input class="search-input" data-field="admin-q" value="${esc(S.admin.q)}" placeholder="Search by name, email, mobile, or last 4 NRIC…">
  <div class="people-count">${people.length} ${people.length === 1 ? 'person' : 'people'}${q ? ' matching your search' : ' signed up'}</div>
  <div id="people-list">${list || '<div style="font-size:14px;color:#8A8F80;padding:20px 0;">No registrations match your search.</div>'}</div>`;
}

function renderAdminSettings() {
  const a = A();
  const sheetsFormula = `=IMPORTDATA("${EXPORT_URL}?code=${a.export_token}")`;
  const dates = a.dates.map((d) => {
    const opts = liveOpts(d).map((o) => {
      const over = admOverBy(o);
      return `
      <div class="opt-edit-row">
        <input class="name" data-set="opt-name" data-opt="${o.id}" value="${esc(o.name)}">
        <div class="cap-group">
          <span class="cap-label">Capacity</span>
          <input class="cap" data-set="opt-cap" data-opt="${o.id}" type="number" min="0" value="${o.capacity}">
          <span class="cap-usage">${admConfirmedCount(o.id)} serving · ${admWaiting(o.id).length} waiting</span>
        </div>
        <button class="btn-x" data-act="set-remove-opt" data-opt="${o.id}" data-name="${esc(o.name)}">✕</button>
      </div>
      <textarea class="set-input opt-blurb-input" rows="2" data-set="opt-blurb" data-opt="${o.id}"
        placeholder="One or two sentences: what they'll actually do, and the detail that makes someone choose it. **stars** for bold.">${esc(o.blurb || '')}</textarea>
      ${over ? `<div class="cap-over">${over} ${over === 1 ? 'person is' : 'people are'} over this limit — nobody was removed. Sort it out on the Dashboard.</div>` : ''}`;
    }).join('');
    return `
    <div class="set-card">
      <div class="date-edit-row">
        <input data-set="date-label" data-date="${d.id}" value="${esc(d.label)}">
        <button class="btn-remove-date" data-act="set-remove-date" data-date="${d.id}" data-name="${esc(d.label)}">Remove date</button>
      </div>
      <label class="set-label">LINE UNDER THIS DATE (wrap words in **stars** to bold them)</label>
      <input class="set-input" data-set="date-subtitle" data-date="${d.id}" value="${esc(d.subtitle || '')}">
      ${opts}
      <button class="btn-dashed" data-act="set-add-opt" data-date="${d.id}">+ Add option</button>
    </div>`;
  }).join('');

  const fields = (a.fields || []).map((f, i, arr) => `
    <div class="field-edit">
      <div class="date-edit-row" style="margin-bottom:10px;">
        <input data-set="field-label" data-fid="${esc(f.id)}" value="${esc(f.label)}">
        <button class="chip-btn" data-act="field-move" data-fid="${esc(f.id)}" data-dir="up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="chip-btn" data-act="field-move" data-fid="${esc(f.id)}" data-dir="down" ${i === arr.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn-remove-date" data-act="field-remove" data-fid="${esc(f.id)}" data-name="${esc(f.label)}">Remove</button>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
        <label style="font-size:12.5px;color:#586052;font-weight:600;display:flex;align-items:center;gap:6px;">
          Answer type
          <select class="mini-select" data-set="field-type" data-fid="${esc(f.id)}">
            <option value="text"${f.type === 'text' ? ' selected' : ''}>Typed answer</option>
            <option value="select"${f.type === 'select' ? ' selected' : ''}>Dropdown</option>
          </select>
        </label>
        <label style="font-size:12.5px;color:#586052;font-weight:600;display:flex;align-items:center;gap:6px;">
          <input type="checkbox" data-set="field-required" data-fid="${esc(f.id)}"${f.required ? ' checked' : ''}>
          Required
        </label>
      </div>
      ${f.type === 'select'
        ? `<label class="set-label">DROPDOWN CHOICES (one per line)</label>
           <textarea class="set-input" rows="${Math.max(3, (f.options || []).length)}" data-set="field-options" data-fid="${esc(f.id)}">${esc((f.options || []).join('\n'))}</textarea>`
        : `<label class="set-label">HINT TEXT SHOWN IN THE BOX (optional)</label>
           <input class="set-input" data-set="field-placeholder" data-fid="${esc(f.id)}" value="${esc(f.placeholder || '')}">`}
    </div>`).join('');

  return `
  <div class="set-card">
    <h2>Registration questions</h2>
    <p class="hint" style="margin:0 0 14px;">Name, email, mobile and NRIC are always asked — they identify people and catch duplicates.
    Add your own questions below; they appear in the "Your details" box and get their own column in the CSV export.</p>
    ${fields || '<p class="hint" style="margin:0 0 12px;">No extra questions yet.</p>'}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;">
      <button class="btn-dashed" data-act="field-add" data-type="text">+ Add typed question</button>
      <button class="btn-dashed" data-act="field-add" data-type="select">+ Add dropdown question</button>
    </div>
  </div>

  <div class="set-card">
    <h2>Form content</h2>
    <label class="set-label">FORM TITLE</label>
    <input class="set-input" data-set="config-title" value="${esc(a.config.title)}">
    <label class="set-label">DESCRIPTION</label>
    <textarea class="set-input" style="margin-bottom:8px;" data-set="config-desc" rows="8">${esc(a.config.description)}</textarea>
    <p class="hint" style="margin:0;">Blank line = new paragraph &nbsp;·&nbsp; single line break = next line, kept close
    &nbsp;·&nbsp; start lines with <strong>-</strong> for a tight bullet list &nbsp;·&nbsp; <strong>**stars**</strong> = bold</p>
  </div>
  ${dates}
  <button class="btn-dashed wide" data-act="set-add-date">+ Add date</button>

  <div class="set-card" style="margin-top:16px;">
    <h2>Export data</h2>
    <p class="hint" style="margin:0 0 12px;">Download all registrations (including cancelled ones) as a spreadsheet-ready CSV.</p>
    <button class="btn-main" style="flex:none;padding:12px 22px;font-size:14px;" data-act="export-csv">⬇ Download CSV</button>
    <h2 style="margin-top:22px;">Connect Google Sheets</h2>
    <p class="hint" style="margin:0 0 10px;">Paste this formula into cell <strong>A1</strong> of a Google Sheet. The sheet will pull the latest registrations automatically (Google refreshes it roughly every hour; delete and re-paste the formula to force a refresh):</p>
    <div class="code-box" id="sheets-formula">${esc(sheetsFormula)}</div>
    <button class="chip-btn" data-act="copy-formula">Copy formula</button>
    <p class="hint" style="margin-top:10px;">This link contains a private export code — only share it with people who should see registrant data.</p>
  </div>

  <div class="set-card">
    <h2>Admin passcode</h2>
    <p class="hint" style="margin:0 0 10px;">Used to open this admin area. Minimum 8 characters.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <input class="set-input" style="flex:1;min-width:220px;margin-bottom:0;" id="new-passcode" type="text" placeholder="New passcode">
      <button class="btn-main" style="flex:none;padding:12px 22px;font-size:14px;" data-act="set-passcode">Change passcode</button>
    </div>
  </div>`;
}

function renderAdmin() {
  const ad = S.admin;
  if (!ad.authed) {
    return `
    <div class="login-card fade-up">
      <h1 style="margin:0 0 6px;font-weight:800;font-size:24px;">Admin access</h1>
      <p style="margin:0 0 18px;font-size:13.5px;color:#6B7263;">Enter the organiser passcode to continue.</p>
      <input class="set-input" id="admin-code" type="password" placeholder="Passcode" ${ad.checking ? 'disabled' : ''}>
      <button class="cta" style="margin-top:4px;" data-act="admin-login" ${ad.checking ? 'disabled' : ''}>${ad.checking ? 'Checking…' : 'Open admin'}</button>
      ${ad.loginError ? `<div class="login-err">${esc(ad.loginError)}</div>` : ''}
    </div>`;
  }
  if (!ad.state) return '<div class="loading">Loading…</div>';
  const tab = (id, label) => `<button class="admin-tab ${ad.tab === id ? 'on' : ''}" data-act="adm-tab" data-tab="${id}">${label}</button>`;
  let body = '';
  if (ad.tab === 'dash') body = renderAdminDash();
  else if (ad.tab === 'people') body = renderAdminPeople();
  else body = renderAdminSettings();
  return `
  <div class="wrap wrap-wide fade-up">
    <div class="admin-tabs">${tab('dash', 'Dashboard')}${tab('people', 'Participants')}${tab('settings', 'Settings')}</div>
    ${body}
  </div>`;
}

/* ---------- DOM morphing ----------
   Replacing innerHTML on every click rebuilt the whole page: the fade-in
   animation replayed, scroll jumped and focus was lost. Instead we patch the
   existing DOM in place and touch only what actually changed. */

const FORM_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1 };

function syncAttrs(oldEl, newEl) {
  for (const a of Array.from(oldEl.attributes)) {
    if (!newEl.hasAttribute(a.name)) oldEl.removeAttribute(a.name);
  }
  for (const a of Array.from(newEl.attributes)) {
    if (oldEl.getAttribute(a.name) !== a.value) oldEl.setAttribute(a.name, a.value);
  }
}

function syncFormValue(oldEl, newEl) {
  // Never fight the person typing — only push values into unfocused controls.
  if (oldEl === document.activeElement) return;
  if (oldEl.tagName === 'INPUT') {
    if (oldEl.type === 'checkbox' || oldEl.type === 'radio') {
      oldEl.checked = newEl.hasAttribute('checked');
    } else {
      const v = newEl.getAttribute('value') ?? '';
      if (oldEl.value !== v) oldEl.value = v;
    }
  } else if (oldEl.tagName === 'TEXTAREA') {
    if (oldEl.value !== newEl.textContent) oldEl.value = newEl.textContent;
  } else if (oldEl.tagName === 'SELECT') {
    const sel = Array.from(newEl.options).find((o) => o.hasAttribute('selected'));
    const v = sel ? sel.value : '';
    if (oldEl.value !== v) oldEl.value = v;
  }
}

function morphNode(oldNode, newNode, parent) {
  if (oldNode.nodeType !== newNode.nodeType || oldNode.nodeName !== newNode.nodeName) {
    parent.replaceChild(newNode, oldNode);
    return;
  }
  if (oldNode.nodeType === Node.TEXT_NODE || oldNode.nodeType === Node.COMMENT_NODE) {
    if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
    return;
  }
  if (oldNode.nodeType !== Node.ELEMENT_NODE) return;
  syncAttrs(oldNode, newNode);
  morphChildren(oldNode, newNode);
  if (FORM_TAGS[oldNode.tagName]) syncFormValue(oldNode, newNode);
}

function morphChildren(oldParent, newParent) {
  const oldKids = Array.from(oldParent.childNodes);
  const newKids = Array.from(newParent.childNodes);
  const n = Math.max(oldKids.length, newKids.length);
  for (let i = 0; i < n; i++) {
    const o = oldKids[i], nk = newKids[i];
    if (!nk) { oldParent.removeChild(o); continue; }
    if (!o) { oldParent.appendChild(nk); continue; }
    morphNode(o, nk, oldParent);
  }
}

let lastView = '';

function render() {
  const app = document.getElementById('app');
  let body = '';
  if (S.view === 'form') body = renderForm();
  else if (S.view === 'review') body = renderReview();
  else if (S.view === 'done') body = renderDone();
  else body = renderAdmin();
  const next = document.createElement('div');
  next.innerHTML = renderHeader() + body;
  // Moving between form/review/done/admin should still fade in, so rebuild
  // there. Within a view we patch, which is what keeps clicks from stuttering.
  if (S.view !== lastView) { app.textContent = ''; lastView = S.view; }
  morphChildren(app, next);
}

/* ---------- events (delegated) ---------- */

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  if (act === 'nav-register') { S.view = 'form'; S.submitError = ''; render(); return; }
  if (act === 'nav-admin') {
    S.view = 'admin';
    if (S.admin.code && !S.admin.authed) { render(); adminLogin(S.admin.code); return; }
    if (S.admin.authed && !S.admin.state) { render(); await refreshAdmin(); }
    render(); return;
  }
  if (act === 'pick') { pick(el.dataset.date, el.dataset.opt, el.dataset.rank); return; }
  if (act === 'goReview') {
    const errs = validate();
    if (errs.length) { S.errors = errs; render(); window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }
    else { S.errors = []; S.view = 'review'; S.submitError = ''; render(); window.scrollTo(0, 0); }
    return;
  }
  if (act === 'backToForm') { S.view = 'form'; S.submitError = ''; await loadPublic(); render(); return; }
  if (act === 'doSubmit') { doSubmit(); return; }
  if (act === 'registerAnother') {
    Object.assign(S, { view: 'form', fName: '', fEmail: '', fMobile: '', fNric: '', extra: {}, sel: {}, doneRegs: [], errors: [] });
    await loadPublic(); render(); window.scrollTo(0, 0); return;
  }

  if (act === 'admin-login') {
    const code = document.getElementById('admin-code').value;
    adminLogin(code); return;
  }
  if (act === 'adm-tab') { S.admin.tab = el.dataset.tab; render(); return; }
  if (act === 'adm-open') {
    if (ev.target.closest('.p-actions') || ev.target.closest('.chip-btn')) return;
    S.admin.open = { date: el.dataset.date, opt: el.dataset.opt }; render(); return;
  }
  if (act === 'adm-close') { S.admin.open = null; render(); return; }
  if (act === 'adm-backup') {
    S.admin.backupOpen = S.admin.backupOpen === el.dataset.opt ? null : el.dataset.opt;
    render(); return;
  }
  if (act === 'adm-move') { adminAct('move', { reg: el.dataset.reg }); return; }
  if (act === 'adm-release') { adminAct('release', { reg: el.dataset.reg }); return; }
  if (act === 'adm-cancel') {
    if (!window.confirm(`Cancel ${el.dataset.name}'s registration for this date?`)) return;
    adminAct('cancel', { reg: el.dataset.reg }); return;
  }
  if (act === 'adm-promote') { adminAct('promote', { reg: el.dataset.reg, opt: el.dataset.opt }); return; }
  if (act === 'adm-wl-up') { reorderWl(el.dataset.opt, el.dataset.reg, -1); return; }
  if (act === 'adm-wl-down') { reorderWl(el.dataset.opt, el.dataset.reg, +1); return; }
  if (act === 'adm-hist') { S.admin.histOpen[el.dataset.reg] = !S.admin.histOpen[el.dataset.reg]; render(); return; }
  if (act === 'pref-edit') {
    const r = admActive().find((x) => x.id === el.dataset.reg);
    if (!r) return;
    S.admin.prefEdit[r.id] = { p1: r.p1, p2: r.p2 || '', error: '' };
    render(); return;
  }
  if (act === 'pref-cancel') { delete S.admin.prefEdit[el.dataset.reg]; render(); return; }
  if (act === 'pref-save') {
    const pe = S.admin.prefEdit[el.dataset.reg];
    if (!pe || pe.p1 === pe.p2) return;
    const res = await adminActRes('set_prefs', { reg: el.dataset.reg, p1: pe.p1, p2: pe.p2 || null });
    if (res.ok) delete S.admin.prefEdit[el.dataset.reg];
    else S.admin.prefEdit[el.dataset.reg] = Object.assign({}, pe, { error: res.error || 'Could not save those choices.' });
    render(); return;
  }

  if (act === 'set-remove-date') {
    if (!window.confirm(`Remove "${el.dataset.name}" and all its registrations?`)) return;
    adminAct('remove_date', { date: el.dataset.date }); return;
  }
  if (act === 'field-add') { adminAct('add_field', { type: el.dataset.type }); return; }
  if (act === 'field-remove') {
    if (!window.confirm(`Remove the question "${el.dataset.name}"? People already registered keep their answer on record, but it stops being asked and leaves the CSV.`)) return;
    adminAct('remove_field', { field: el.dataset.fid }); return;
  }
  if (act === 'field-move') { adminAct('move_field', { field: el.dataset.fid, dir: el.dataset.dir }); return; }
  if (act === 'set-add-date') { adminAct('add_date', {}); return; }
  if (act === 'set-add-opt') { adminAct('add_option', { date: el.dataset.date }); return; }
  if (act === 'set-remove-opt') {
    // Removing is the urgent half — it stops anyone else signing up for it.
    // Finding these people a new place is the unhurried half, and it happens on
    // the Dashboard afterwards.
    const pending = admPending(el.dataset.opt).length;
    const msg = pending
      ? `Remove "${el.dataset.name}" now?\n\nNobody else will be able to sign up for it. The ${pending} ${pending === 1 ? 'person' : 'people'} already on it are NOT dropped — they move to the Dashboard for you to reassign whenever you're ready.`
      : `Remove "${el.dataset.name}"? Nobody has chosen it, so nothing else changes.`;
    if (!window.confirm(msg)) return;
    const res = await adminActRes('remove_option', { opt: el.dataset.opt });
    if (res.ok && res.pending) { S.admin.tab = 'dash'; S.admin.moveOut = { opt: el.dataset.opt, mode: 'rehome', picks: {}, error: '' }; }
    render(); return;
  }
  if (act === 'move-open') {
    S.admin.moveOut = { opt: el.dataset.opt, mode: el.dataset.mode, picks: {}, error: '' };
    render(); return;
  }
  if (act === 'move-cancel') { S.admin.moveOut = null; render(); return; }
  if (act === 'move-confirm') {
    const mo = S.admin.moveOut;
    const opt = admOpt(mo.opt);
    const people = mo.mode === 'rehome' ? admPending(mo.opt) : admOverflow(opt);
    const moves = people.map((r) => ({
      reg: r.id,
      to: mo.picks[r.id] === undefined ? defaultDest(r, mo.opt) : mo.picks[r.id],
    }));
    const res = mo.mode === 'rehome'
      ? await adminActRes('rehome', { opt: mo.opt, moves })
      : await adminActRes('reassign', { moves, reason: `Limit for ${opt.name} lowered to ${opt.capacity}` });
    if (res.ok) {
      S.admin.moveOut = null;
      if (S.admin.open && S.admin.open.opt === mo.opt) S.admin.open = null;
    } else {
      S.admin.moveOut = Object.assign({}, mo, { error: res.error || 'Could not apply those moves.' });
    }
    render(); return;
  }
  if (act === 'export-csv') { downloadCsv(); return; }
  if (act === 'copy-formula') {
    const txt = document.getElementById('sheets-formula').textContent;
    try { await navigator.clipboard.writeText(txt); el.textContent = 'Copied ✓'; setTimeout(() => { el.textContent = 'Copy formula'; }, 1500); } catch (e) {}
    return;
  }
  if (act === 'set-passcode') {
    const val = document.getElementById('new-passcode').value.trim();
    if (val.length < 8) { alert('Passcode must be at least 8 characters.'); return; }
    if (!window.confirm('Change the admin passcode? Everyone using the old passcode will be signed out.')) return;
    const res = await rpc('admin_action', { p_code: S.admin.code, p_action: 'set_passcode', p: { passcode: val } });
    if (res.ok) {
      S.admin.code = val; sessionStorage.setItem('ss_admin_code', val);
      alert('Passcode changed.');
      await refreshAdmin(); render();
    } else { alert(res.error || 'Could not change passcode.'); }
    return;
  }
});

// Text inputs: update state without re-render (form fields, search)
document.addEventListener('input', (ev) => {
  const f = ev.target.dataset.field;
  if (!f) return;
  if (f === 'admin-q') {
    // Morphing keeps the caret in the search box, so a normal render is fine.
    S.admin.q = ev.target.value;
    render();
    return;
  }
  if (f === 'fNric') ev.target.value = ev.target.value.slice(0, 4);
  S[f] = ev.target.value;
});

// Custom-field answers: text inputs fire input, dropdowns fire change
document.addEventListener('input', (ev) => {
  const x = ev.target.dataset.xfield;
  if (x) S.extra[x] = ev.target.value;
});

// Settings inputs: save on change (blur / spinner click)
document.addEventListener('change', (ev) => {
  const x = ev.target.dataset.xfield;
  if (x) { S.extra[x] = ev.target.value; return; }
  const setKey = ev.target.dataset.set;
  if (!setKey) return;
  if (setKey === 'pref-p1' || setKey === 'pref-p2') {
    const pe = S.admin.prefEdit[ev.target.dataset.reg];
    if (!pe) return;
    pe[setKey === 'pref-p1' ? 'p1' : 'p2'] = ev.target.value;
    pe.error = '';
    render();
    return;
  }
  if (setKey === 'move-dest') {
    if (!S.admin.moveOut) return;
    S.admin.moveOut.picks[ev.target.dataset.reg] = ev.target.value;
    S.admin.moveOut.error = '';
    render();
    return;
  }
  if (setKey === 'config-title') adminAct('set_config', { title: ev.target.value });
  else if (setKey === 'config-desc') adminAct('set_config', { description: ev.target.value });
  else if (setKey === 'date-label') adminAct('set_date_label', { date: ev.target.dataset.date, label: ev.target.value });
  else if (setKey === 'date-subtitle') adminAct('set_date_subtitle', { date: ev.target.dataset.date, subtitle: ev.target.value });
  else if (setKey === 'opt-name') adminAct('set_option', { opt: ev.target.dataset.opt, name: ev.target.value });
  else if (setKey === 'opt-blurb') adminAct('set_option', { opt: ev.target.dataset.opt, blurb: ev.target.value });
  else if (setKey === 'opt-cap') {
    const cap = Math.max(0, parseInt(ev.target.value || '0', 10));
    const o = admOpt(ev.target.dataset.opt);
    const have = o ? admConfirmedCount(o.id) : 0;
    if (o && cap < have && !window.confirm(
      `${o.name} already has ${have} people confirmed. Setting the limit to ${cap} leaves ${have - cap} over the line.\n\n` +
      'Nobody is removed automatically — they stay where they are and the Dashboard will flag them so you can call them and move them.\n\nContinue?')) {
      ev.target.value = o.capacity;
      return;
    }
    adminAct('set_option', { opt: ev.target.dataset.opt, capacity: cap });
  }
  else if (setKey === 'field-label') adminAct('set_field', { field: ev.target.dataset.fid, label: ev.target.value });
  else if (setKey === 'field-type') adminAct('set_field', { field: ev.target.dataset.fid, type: ev.target.value });
  else if (setKey === 'field-required') adminAct('set_field', { field: ev.target.dataset.fid, required: ev.target.checked });
  else if (setKey === 'field-placeholder') adminAct('set_field', { field: ev.target.dataset.fid, placeholder: ev.target.value });
  else if (setKey === 'field-options') adminAct('set_field', { field: ev.target.dataset.fid, options_text: ev.target.value });
});

// Enter key submits the admin login
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'admin-code') adminLogin(ev.target.value);
});

// Refresh availability every 30s while on the form (skip while typing)
setInterval(async () => {
  if (S.view !== 'form') return;
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  const before = JSON.stringify(S.pub);
  await loadPublic();
  if (JSON.stringify(S.pub) !== before) render();
}, 30000);

(async () => {
  await loadPublic();
  render();
})();
