/* Saturday Serve — registration app backed by Supabase.
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
  sel: {}, errors: [], submitError: '', submitting: false,
  doneRegs: [], doneName: '',
  admin: {
    code: sessionStorage.getItem('ss_admin_code') || '',
    authed: false, checking: false, loginError: '',
    tab: 'dash', state: null, open: null, q: '', histOpen: {},
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
const admRemaining = (opt) => Math.max(0, opt.capacity - admConfirmedCount(opt.id));
const admWaitlist = (optId) => admActive()
  .filter((r) => r.confirmed !== optId && (r.p1 === optId || r.p2 === optId))
  .sort((a, b) => {
    const ra = a.wl_rank && a.wl_rank[optId] != null ? a.wl_rank[optId] : null;
    const rb = b.wl_rank && b.wl_rank[optId] != null ? b.wl_rank[optId] : null;
    if (ra != null && rb != null) return ra - rb;
    if (ra != null) return -1;
    if (rb != null) return 1;
    return a.ts - b.ts;
  });
const admWlPos = (optId, regId) => {
  const i = admWaitlist(optId).findIndex((r) => r.id === regId);
  return i < 0 ? null : i + 1;
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
    const res = await rpc('submit_registration', {
      p_name: S.fName.trim(), p_email: S.fEmail.trim(),
      p_mobile: S.fMobile.trim(), p_nric: S.fNric.trim().toUpperCase(),
      p_entries: entries,
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
  try {
    const res = await rpc('admin_action', { p_code: S.admin.code, p_action: action, p: payload || {} });
    if (!res.ok && res.error === 'unauthorized') { S.admin.authed = false; }
    await refreshAdmin();
    await loadPublic();
  } catch (e) {
    S.netError = 'Action failed — could not reach the server.';
  }
  render();
}

function reorderWl(optId, regId, dir) {
  const wl = admWaitlist(optId);
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
    a.download = 'saturday-serve-registrations.csv';
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
      <div class="logo-mark">S</div>
      <div class="logo-name">Saturday Serve</div>
    </div>
    <div class="nav-pills">
      <button class="nav-pill ${onAdmin ? '' : 'on'}" data-act="nav-register">Register</button>
      <button class="nav-pill ${onAdmin ? 'on' : ''}" data-act="nav-admin">Admin</button>
    </div>
  </div></div>
  ${S.netError ? `<div class="net-err">${esc(S.netError)}</div>` : ''}`;
}

function renderForm() {
  const pub = S.pub;
  if (!pub) return '<div class="loading">Loading…</div>';
  const paras = (pub.description || '').split(/\n\s*\n/).map((t) => `<p>${esc(t)}</p>`).join('');

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
      <p class="date-hint">Pick a 1st and 2nd choice — or leave blank to skip this Saturday.</p>
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
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <span style="font-size:14px;"><strong>1st:</strong> ${esc(o1.name)}</span>
            <span class="badge" style="background:${b1.bg};color:${b1.c};">${b1.t}</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <span style="font-size:14px;"><strong>2nd:</strong> ${o2 ? esc(o2.name) : '—'}</span>
            <span class="badge" style="background:${b2.bg};color:${b2.c};">${b2.t}</span>
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
    const badge = (optId, wlKey) => {
      if (r.confirmed === optId) return { t: 'CONFIRMED', bg: '#E7F2E9', c: '#256B43' };
      const pos = r.wl_pos && r.wl_pos[wlKey];
      return { t: `WAITLIST #${pos || '—'}`, bg: '#EEE9F8', c: '#6C4AB0' };
    };
    const b1 = badge(r.p1, 'p1');
    const b2 = r.p2 ? badge(r.p2, 'p2') : { t: '—', bg: '#F0EEE6', c: '#8A8F80' };
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
    <p class="done-note">Your second preference has been retained so that the organisers can consider it if allocations are adjusted later. You will be contacted if a waitlisted spot opens up.</p>
    <button class="btn-ghost" style="margin-top:10px;width:100%;font-size:14px;padding:13px;" data-act="registerAnother">Register another person</button>
  </div>`;
}

/* ---------- admin rendering ---------- */

function personCardHtml(r, extraActions) {
  const o1 = admOpt(r.p1), o2 = r.p2 ? admOpt(r.p2) : null;
  const st = (oid) => r.confirmed === oid ? '✓ confirmed' : (oid ? `waitlist #${admWlPos(oid, r.id) || '—'}` : '');
  const prefLine = `1st: ${esc(shortName(o1 ? o1.name : r.p1))} (${st(r.p1)}) · 2nd: ${o2 ? esc(shortName(o2.name)) : '—'}${o2 ? ` (${st(r.p2)})` : ''}`;
  const other = r.confirmed === r.p1 ? r.p2 : r.p1;
  const otherOpt = other ? admOpt(other) : null;
  const canMove = !!(r.confirmed && otherOpt && admRemaining(otherOpt) > 0);
  return { o1, o2, prefLine, canMove, otherOpt, html: extraActions };
}

function renderAdminDash() {
  const a = A();
  const active = admActive();
  const statWl = active.reduce((n, r) =>
    n + ((r.p1 && r.confirmed !== r.p1) ? 1 : 0) + ((r.p2 && r.confirmed !== r.p2) ? 1 : 0), 0);

  const stats = `
  <div class="stats">
    <div class="stat"><div class="n">${a.registrations.length}</div><div class="l">Registrations</div></div>
    <div class="stat"><div class="n" style="color:#2E5B3F;">${active.filter((r) => r.confirmed).length}</div><div class="l">Confirmed</div></div>
    <div class="stat"><div class="n" style="color:#6C4AB0;">${statWl}</div><div class="l">Waitlist entries</div></div>
    <div class="stat"><div class="n" style="color:#B0691C;">${active.filter((r) => r.dup_flag).length}</div><div class="l">Flagged duplicates</div></div>
  </div>`;

  const dates = a.dates.map((d) => {
    const opts = d.options.map((o) => {
      const conf = admConfirmedCount(o.id);
      const rem = Math.max(0, o.capacity - conf);
      const b = optionBadge(rem);
      const wl = admWaitlist(o.id).length;
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
          <span>Confirmed <strong style="color:#22301F;">${conf} / ${o.capacity}</strong></span>
          <span>Waitlist <strong style="color:#6C4AB0;">${wl}</strong></span>
        </div>
      </div>`;
    }).join('');

    let detail = '';
    if (S.admin.open && S.admin.open.date === d.id) {
      const opt = d.options.find((o) => o.id === S.admin.open.opt);
      if (opt) {
        const rem = admRemaining(opt);
        const confirmed = active.filter((r) => r.confirmed === opt.id).sort((x, y) => x.ts - y.ts);
        const wl = admWaitlist(opt.id);
        const confHtml = confirmed.map((r) => {
          const pc = personCardHtml(r);
          return `
          <div class="person">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div style="font-weight:700;font-size:13.5px;">${esc(r.name)} <span style="font-weight:500;color:#8A8F80;font-size:11.5px;">· NRIC ***${esc(r.nric)}</span></div>
              <div style="font-size:11px;color:#8A8F80;">${fmtTs(r.ts)}</div>
            </div>
            <div style="font-size:12px;color:#6B7263;margin-top:3px;">${esc(r.email)} · ${esc(r.mobile)}</div>
            <div style="font-size:12px;margin-top:5px;color:#586052;">${pc.prefLine}</div>
            <div class="p-actions">
              ${pc.canMove ? `<button class="chip-btn move" data-act="adm-move" data-reg="${r.id}">Move to ${esc(shortName(pc.otherOpt.name))}</button>` : ''}
              <button class="chip-btn" data-act="adm-release" data-reg="${r.id}">Release slot</button>
              <button class="chip-btn danger" data-act="adm-cancel" data-reg="${r.id}" data-name="${esc(r.name)}">Cancel</button>
            </div>
          </div>`;
        }).join('') || '<div style="font-size:13px;color:#8A8F80;padding:8px 0;">No confirmed participants yet.</div>';

        const wlHtml = wl.map((r, i) => {
          const pc = personCardHtml(r);
          return `
          <div class="person wl">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div style="font-weight:700;font-size:13.5px;"><span style="color:#6C4AB0;">#${i + 1}</span> ${esc(r.name)} <span style="font-weight:500;color:#8A8F80;font-size:11.5px;">· NRIC ***${esc(r.nric)}</span></div>
              <div style="font-size:11px;color:#8A8F80;">${fmtTs(r.ts)}</div>
            </div>
            <div style="font-size:12px;color:#6B7263;margin-top:3px;">${esc(r.email)} · ${esc(r.mobile)}</div>
            <div style="font-size:12px;margin-top:5px;color:#586052;">${pc.prefLine}</div>
            <div class="p-actions">
              ${rem > 0 ? `<button class="chip-btn promote" data-act="adm-promote" data-reg="${r.id}" data-opt="${opt.id}">Promote here</button>` : '<span style="font-size:11px;color:#A13B2A;font-weight:600;">Option full — release a slot first</span>'}
              <button class="chip-btn" data-act="adm-wl-up" data-reg="${r.id}" data-opt="${opt.id}">↑</button>
              <button class="chip-btn" data-act="adm-wl-down" data-reg="${r.id}" data-opt="${opt.id}">↓</button>
            </div>
          </div>`;
        }).join('') || '<div style="font-size:13px;color:#8A8F80;padding:8px 0;">Waitlist is empty.</div>';

        detail = `
        <div class="detail">
          <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
            <div class="brico" style="font-weight:700;font-size:17px;">${esc(opt.name)} — ${esc(d.label)}</div>
            <button class="chip-btn" style="border:none;background:#F6F2E8;padding:6px 12px;font-size:12px;" data-act="adm-close">Close ✕</button>
          </div>
          <div class="detail-cols">
            <div class="detail-col">
              <div style="font-size:12px;font-weight:800;letter-spacing:0.06em;color:#256B43;margin-bottom:8px;">CONFIRMED (${confirmed.length} / ${opt.capacity})</div>
              ${confHtml}
            </div>
            <div class="detail-col">
              <div style="font-size:12px;font-weight:800;letter-spacing:0.06em;color:#6C4AB0;margin-bottom:8px;">WAITLIST (${wl.length})</div>
              ${wlHtml}
            </div>
          </div>
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

  return stats + dates;
}

function renderAdminPeople() {
  const a = A();
  const q = (S.admin.q || '').trim().toLowerCase();
  const matches = (r) => !q || [r.name, r.email, r.mobile, r.nric, r.reg_id].some((x) => (x || '').toLowerCase().includes(q));
  const rows = a.registrations.filter(matches).sort((x, y) => y.ts - x.ts);

  const list = rows.map((r) => {
    const o1 = admOpt(r.p1), o2 = r.p2 ? admOpt(r.p2) : null;
    const date = a.dates.find((d) => d.id === r.date_id);
    const st = (oid) => {
      if (r.status !== 'active') return ['—', '#8A8F80'];
      if (r.confirmed === oid) return ['CONFIRMED', '#256B43'];
      return [`WAITLIST #${admWlPos(oid, r.id) || '—'}`, '#6C4AB0'];
    };
    const [s1, c1] = st(r.p1), [s2, c2] = o2 ? st(r.p2) : ['—', '#8A8F80'];
    const other = r.confirmed === r.p1 ? r.p2 : r.p1;
    const otherOpt = other ? admOpt(other) : null;
    const canMove = !!(r.confirmed && otherOpt && admRemaining(otherOpt) > 0);
    const hist = S.admin.histOpen[r.id] ? `
      <div class="hist">${(r.history || []).map((h) =>
        `<div class="hist-row"><span style="color:#8A8F80;">${fmtTs(h.ts)}</span> — ${esc(h.text)}</div>`).join('')}
      </div>` : '';
    return `
    <div class="people-row">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div>
          <span style="font-weight:700;font-size:14.5px;">${esc(r.name)}</span>
          <span style="font-size:11.5px;color:#8A8F80;margin-left:8px;">${esc(r.reg_id)} · ${esc((date ? date.label : r.date_id).replace('Saturday, ', ''))}</span>
          ${r.dup_flag ? '<span class="tag dup">POSSIBLE DUPLICATE</span>' : ''}
          ${r.status === 'cancelled' ? '<span class="tag cancelled">CANCELLED</span>' : ''}
        </div>
        <div style="font-size:11.5px;color:#8A8F80;">${fmtTs(r.ts)}</div>
      </div>
      <div style="font-size:12.5px;color:#6B7263;margin-top:4px;">${esc(r.email)} · ${esc(r.mobile)} · NRIC ***${esc(r.nric)}</div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:9px;font-size:12.5px;">
        <span>1st: <strong>${esc(shortName(o1 ? o1.name : r.p1))}</strong> <span style="color:${c1};font-weight:700;">${s1}</span></span>
        <span>2nd: <strong>${o2 ? esc(shortName(o2.name)) : '—'}</strong> <span style="color:${c2};font-weight:700;">${s2}</span></span>
        <span>Allocated: <strong style="color:#256B43;">${r.confirmed ? esc(shortName(admOpt(r.confirmed)?.name || r.confirmed)) : '—'}</strong></span>
      </div>
      <div class="p-actions" style="margin-top:9px;">
        ${canMove ? `<button class="chip-btn move" data-act="adm-move" data-reg="${r.id}">Move to ${esc(shortName(otherOpt.name))}</button>` : ''}
        ${r.status === 'active' ? `<button class="chip-btn danger" data-act="adm-cancel" data-reg="${r.id}" data-name="${esc(r.name)}">Cancel</button>` : ''}
        <button class="chip-btn" data-act="adm-hist" data-reg="${r.id}">History</button>
      </div>
      ${hist}
    </div>`;
  }).join('');

  return `
  <input class="search-input" data-field="admin-q" value="${esc(S.admin.q)}" placeholder="Search by name, email, mobile, or last 4 NRIC…">
  <div id="people-list">${list || '<div style="font-size:14px;color:#8A8F80;padding:20px 0;">No registrations match your search.</div>'}</div>`;
}

function renderAdminSettings() {
  const a = A();
  const sheetsFormula = `=IMPORTDATA("${EXPORT_URL}?code=${a.export_token}")`;
  const dates = a.dates.map((d) => {
    const opts = d.options.map((o) => `
      <div class="opt-edit-row">
        <input class="name" data-set="opt-name" data-opt="${o.id}" value="${esc(o.name)}">
        <div class="cap-group">
          <span class="cap-label">Capacity</span>
          <input class="cap" data-set="opt-cap" data-opt="${o.id}" type="number" min="0" value="${o.capacity}">
          <span class="cap-usage">${admConfirmedCount(o.id)} confirmed · ${admWaitlist(o.id).length} waitlisted</span>
        </div>
        <button class="btn-x" data-act="set-remove-opt" data-opt="${o.id}" data-name="${esc(o.name)}">✕</button>
      </div>`).join('');
    return `
    <div class="set-card">
      <div class="date-edit-row">
        <input data-set="date-label" data-date="${d.id}" value="${esc(d.label)}">
        <button class="btn-remove-date" data-act="set-remove-date" data-date="${d.id}" data-name="${esc(d.label)}">Remove date</button>
      </div>
      ${opts}
      <button class="btn-dashed" data-act="set-add-opt" data-date="${d.id}">+ Add option</button>
    </div>`;
  }).join('');

  return `
  <div class="set-card">
    <h2>Form content</h2>
    <label class="set-label">FORM TITLE</label>
    <input class="set-input" data-set="config-title" value="${esc(a.config.title)}">
    <label class="set-label">DESCRIPTION (blank line = new paragraph)</label>
    <textarea class="set-input" data-set="config-desc" rows="6">${esc(a.config.description)}</textarea>
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

function render() {
  const app = document.getElementById('app');
  let body = '';
  if (S.view === 'form') body = renderForm();
  else if (S.view === 'review') body = renderReview();
  else if (S.view === 'done') body = renderDone();
  else body = renderAdmin();
  app.innerHTML = renderHeader() + body;
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
    Object.assign(S, { view: 'form', fName: '', fEmail: '', fMobile: '', fNric: '', sel: {}, doneRegs: [], errors: [] });
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

  if (act === 'set-remove-date') {
    if (!window.confirm(`Remove "${el.dataset.name}" and all its registrations?`)) return;
    adminAct('remove_date', { date: el.dataset.date }); return;
  }
  if (act === 'set-add-date') { adminAct('add_date', {}); return; }
  if (act === 'set-add-opt') { adminAct('add_option', { date: el.dataset.date }); return; }
  if (act === 'set-remove-opt') {
    if (!window.confirm(`Remove "${el.dataset.name}"? Registrations referencing it will keep it in history but lose the slot.`)) return;
    adminAct('remove_option', { opt: el.dataset.opt }); return;
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
    S.admin.q = ev.target.value;
    const list = document.getElementById('people-list');
    if (list) {
      const html = renderAdminPeople();
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      list.innerHTML = tmp.querySelector('#people-list').innerHTML;
    }
    return;
  }
  if (f === 'fNric') ev.target.value = ev.target.value.slice(0, 4);
  S[f] = ev.target.value;
});

// Settings inputs: save on change (blur / spinner click)
document.addEventListener('change', (ev) => {
  const setKey = ev.target.dataset.set;
  if (!setKey) return;
  if (setKey === 'config-title') adminAct('set_config', { title: ev.target.value });
  else if (setKey === 'config-desc') adminAct('set_config', { description: ev.target.value });
  else if (setKey === 'date-label') adminAct('set_date_label', { date: ev.target.dataset.date, label: ev.target.value });
  else if (setKey === 'opt-name') adminAct('set_option', { opt: ev.target.dataset.opt, name: ev.target.value });
  else if (setKey === 'opt-cap') adminAct('set_option', { opt: ev.target.dataset.opt, capacity: Math.max(0, parseInt(ev.target.value || '0', 10)) });
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
