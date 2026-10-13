// ════════════════════════════════════════════════════════════════════
//  Rekenstratego 3.0 — leerkrachtpagina
// ════════════════════════════════════════════════════════════════════
import * as fb from './firebase.js';
import * as ops from './ops.js';
import {
  RECIPE_TYPES, PRESETS, MIN_QUESTIONS, UNIT_ICON, generateQuestions, mulberry32, newClassCode,
  coinsAvailable, ownersOf, mapSizeFor,
} from './core.js';
import { MapView } from './mapview.js';

/* ─────────────── helpers ─────────────── */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const timeStr = ts => ts ? new Date(ts).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : '';
const dayStr = ts => ts ? new Date(ts).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' }) : '';

export function toast(msg, type = 'info') {
  const d = document.createElement('div'); d.className = 'toast ' + type; d.textContent = msg;
  $('#toasts').appendChild(d); setTimeout(() => d.remove(), 3600);
}
function show(name) {
  for (const s of ['login', 'classes', 'wizard', 'dash']) $('#scr-' + s).classList.toggle('hidden', s !== name);
  window.scrollTo(0, 0);
}
const openModal = id => $('#' + id).classList.add('open');
const closeModal = id => $('#' + id).classList.remove('open');
document.addEventListener('click', e => {
  const c = e.target.closest('[data-close]'); if (c) c.closest('.overlay').classList.remove('open');
  const g = e.target.closest('[data-go]'); if (g) go(g.dataset.go);
});
document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); }));

async function safe(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, 'success'); return r; }
  catch (e) {
    console.error(e);
    toast(/permission/i.test(e.message) ? 'Geen toestemming (rules)' : 'Mislukt: ' + e.message, 'error');
    throw e;
  }
}

/* ─────────────── state ─────────────── */
let USER = null, CID = null, KLAS = null, unsub = null, MAP = null, SEL = null;

function go(where) {
  if (where === 'classes') { stopClass(); history.replaceState(null, '', '#'); loadClasses(); }
}

/* ═════════════════ INLOGGEN ═════════════════ */
async function start() {
  const u = await fb.currentUser();
  if (u && !u.isAnonymous) { USER = u; return afterLogin(); }
  show('login');
}
$('#btn-login').onclick = async () => {
  try { USER = await fb.teacherSignIn(); afterLogin(); }
  catch (e) { $('#login-msg').textContent = 'Inloggen mislukt: ' + e.message; }
};
$('#btn-logout').onclick = async () => { stopClass(); await fb.logout(); USER = null; show('login'); };

async function afterLogin() {
  $('#who').textContent = USER.email || '';
  const m = location.hash.match(/k=([a-z0-9]+)/);
  if (m) return openClass(m[1]);
  loadClasses();
}

/* ═════════════════ KLASSEN ═════════════════ */
async function loadClasses() {
  show('classes');
  let idx;
  try { idx = (await fb.read(`${fb.ROOT}/classIndex`)) || {}; }
  catch (e) {
    show('login');
    let diag = '';
    try {
      const t = await USER.getIdTokenResult();
      diag = `<br><span class="mono" style="font-size:0.7rem;">${esc(e.message)} · provider=${esc(t.claims.firebase?.sign_in_provider)} · email_verified=${esc(t.claims.email_verified)}</span>`;
    } catch {}
    $('#login-msg').innerHTML = `Het account <b>${esc(USER?.email)}</b> heeft geen toegang tot het commandocentrum.${diag}
      <br><button class="btn-ghost btn-mini" id="btn-relog">Ander account</button>`;
    $('#btn-relog').onclick = async () => { await fb.logout(); USER = null; $('#login-msg').textContent = ''; };
    return;
  }
  const list = Object.entries(idx).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  $('#klas-list').innerHTML = list.map(([cid, k]) => `
    <div class="card klas-card" data-cid="${esc(cid)}">
      <div class="eyebrow">▌ Klascode ${esc(k.code)}</div>
      <h3 style="margin:0 0 4px;">${esc(k.name)}</h3>
      <div class="hint">Aangemaakt ${esc(dayStr(k.createdAt))}</div>
    </div>`).join('') + `
    <div class="card klas-card" id="new-klas" style="display:flex;align-items:center;justify-content:center;min-height:110px;border-style:dashed;">
      <b style="color:var(--sky);">+ Nieuwe klas</b>
    </div>`;
  document.querySelectorAll('[data-cid]').forEach(el => el.onclick = () => openClass(el.dataset.cid));
  $('#new-klas').onclick = startWizard;
}

/* ═════════════════ RECEPT-EDITOR (wizard + sommengroepen) ═════════════════ */
function defaultPart(type = 'tafels') { return { type, ...structuredClone(RECIPE_TYPES[type].defaults) }; }

function partParams(p, gi, pi) {
  const at = `data-g="${gi}" data-p="${pi}"`;
  if (p.type === 'tafels' || p.type === 'deel') {
    return `tafels: ` + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(t =>
      `<button type="button" class="tchip ${p.tafels.includes(t) ? 'on' : ''}" data-act="tafel" data-t="${t}" ${at}>${t}</button>`).join('');
  }
  if (p.type === 'keerBovenTien') {
    return `getal <input class="small" type="number" min="11" max="99" value="${p.min}" data-f="min" ${at}>
      t/m <input class="small" type="number" min="11" max="99" value="${p.max}" data-f="max" ${at}>
      × <input class="small" type="number" min="2" max="9" value="${p.fmin}" data-f="fmin" ${at}>
      t/m <input class="small" type="number" min="2" max="9" value="${p.fmax}" data-f="fmax" ${at}>`;
  }
  // plus / min
  return `tot <select class="small" data-f="max" ${at}>${[20, 100, 1000].map(v => `<option ${p.max === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <select class="small" data-f="overschrijding" ${at}>
      ${[['mix', 'met én zonder overschrijding'], ['zonder', 'zonder overschrijding'], ['met', 'met overschrijding']]
        .map(([v, l]) => `<option value="${v}" ${p.overschrijding === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select>`;
}

function groupHTML(g, gi, opt) {
  const parts = g.recipe.parts.map((p, pi) => `
    <div class="part">
      <select class="small" data-f="type" data-g="${gi}" data-p="${pi}">
        ${Object.entries(RECIPE_TYPES).map(([k, t]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
      </select>
      <input class="small" type="number" min="1" max="60" value="${p.count}" data-f="count" data-g="${gi}" data-p="${pi}" title="aantal">
      <span class="hint">stuks</span>
      <div class="params">${partParams(p, gi, pi)}</div>
      <div class="spacer"></div>
      ${g.recipe.parts.length > 1 ? `<button type="button" class="btn-ghost btn-mini" data-act="del-part" data-g="${gi}" data-p="${pi}">✕</button>` : ''}
    </div>`).join('');
  return `
    <div class="sg-card">
      <div class="row">
        <input data-f="name" data-g="${gi}" value="${esc(g.name)}" placeholder="Naam sommengroep (bijv. 6a)" maxlength="30" style="flex:1; min-width:180px;">
        <select class="small" data-f="preset" data-g="${gi}">
          <option value="">Startpunt kiezen…</option>
          ${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')}
        </select>
        ${opt.canDelete(g) ? `<button type="button" class="btn-ghost btn-mini" data-act="del-group" data-g="${gi}">Verwijder groep</button>` : ''}
      </div>
      ${parts}
      <button type="button" class="btn-line btn-mini" data-act="add-part" data-g="${gi}">+ Onderdeel</button>
      ${opt.extra ? opt.extra(g, gi) : ''}
      <div class="preview" data-preview="${gi}"></div>
    </div>`;
}

/** Eenvoudige, herbruikbare editor. groups wordt in-place aangepast. */
function recipeEditor(container, groups, opt) {
  const render = () => { container.innerHTML = groups.map((g, gi) => groupHTML(g, gi, opt)).join(''); previews(); opt.onChange?.(); };
  const previews = () => groups.forEach((g, gi) => {
    const el = container.querySelector(`[data-preview="${gi}"]`); if (!el) return;
    const qs = generateQuestions(g.recipe, mulberry32(7));
    const few = qs.length < MIN_QUESTIONS;
    el.classList.toggle('bad', few);
    el.textContent = few ? `⚠ Maar ${qs.length} sommen — minimaal ${MIN_QUESTIONS}.`
      : `✓ ${qs.length} sommen per week · bijv. ${qs.slice(0, 5).map(q => q.q).join('  ·  ')}`;
  });
  const P = el => groups[int(el.dataset.g)].recipe.parts[int(el.dataset.p)];
  container.oninput = e => {
    const el = e.target, f = el.dataset.f; if (!f) return;
    const g = groups[int(el.dataset.g)];
    if (f === 'name') g.name = el.value;
    else if (f === 'names') g.names = el.value;
    else if (f === 'count') P(el).count = clamp(int(el.value, 1), 1, 60);
    else if (['min', 'max', 'fmin', 'fmax'].includes(f) && P(el).type === 'keerBovenTien') {
      const lim = f.startsWith('f') ? [2, 9] : [11, 99];
      P(el)[f] = clamp(int(el.value, lim[0]), lim[0], lim[1]);
    } else return;
    previews(); opt.onChange?.();
  };
  container.onchange = e => {
    const el = e.target, f = el.dataset.f; if (!f) return;
    const g = groups[int(el.dataset.g)];
    if (f === 'preset' && el.value) { g.recipe = structuredClone(PRESETS[el.value].recipe); return render(); }
    if (f === 'type') { const old = P(el); g.recipe.parts[int(el.dataset.p)] = { ...defaultPart(el.value), count: old.count }; return render(); }
    if (f === 'max' && P(el).type !== 'keerBovenTien') { P(el).max = int(el.value, 100); previews(); }
    if (f === 'overschrijding') { P(el).overschrijding = el.value; previews(); }
  };
  container.onclick = e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const g = groups[int(el.dataset.g)];
    switch (el.dataset.act) {
      case 'tafel': {
        const p = P(el), t = int(el.dataset.t);
        p.tafels = p.tafels.includes(t) ? p.tafels.filter(x => x !== t) : [...p.tafels, t].sort((a, b) => a - b);
        if (!p.tafels.length) p.tafels = [t];
        return render();
      }
      case 'add-part': g.recipe.parts.push(defaultPart('tafels')); return render();
      case 'del-part': g.recipe.parts.splice(int(el.dataset.p), 1); return render();
      case 'del-group': groups.splice(int(el.dataset.g), 1); return render();
    }
  };
  render();
  return { render };
}

function nextSgId(existing) {
  let i = 1; while (existing.includes('g' + i)) i++; return 'g' + i;
}

/* ═════════════════ WIZARD ═════════════════ */
let WZ = null;
function startWizard() {
  WZ = { groups: [
    { id: 'g1', name: 'Groep 1', recipe: structuredClone(PRESETS.tafels.recipe), names: '' },
  ] };
  $('#wz-name').value = '';
  show('wizard');
  WZ.editor = recipeEditor($('#wz-groups'), WZ.groups, {
    canDelete: () => WZ.groups.length > 1,
    extra: (g, gi) => `
      <label class="lbl">Leerlingen in deze groep <span style="text-transform:none;font-weight:600;">(één naam per regel)</span></label>
      <textarea data-f="names" data-g="${gi}" placeholder="Anna&#10;Bram&#10;Cas">${esc(g.names)}</textarea>`,
    onChange: wizardSummary,
  });
}
const parseNames = txt => String(txt || '').split(/\r?\n|,|;/).map(s => s.trim()).filter(Boolean);
function wizardSummary() {
  const n = WZ.groups.reduce((a, g) => a + parseNames(g.names).length, 0);
  const { W, H } = mapSizeFor(n);
  $('#wz-summary').textContent = n ? `${n} leerlingen · kaart ${W}×${H}` : 'Nog geen leerlingen';
}
$('#wz-add-group').onclick = () => {
  WZ.groups.push({ id: nextSgId(WZ.groups.map(g => g.id)), name: 'Groep ' + (WZ.groups.length + 1), recipe: structuredClone(PRESETS.tafels.recipe), names: '' });
  WZ.editor.render();
};
$('#wz-create').onclick = async () => {
  const name = $('#wz-name').value.trim();
  if (!name) return toast('Geef de klas een naam', 'error');
  const students = [], sgroups = {};
  for (const g of WZ.groups) {
    if (!g.name.trim()) return toast('Elke sommengroep heeft een naam nodig', 'error');
    if (generateQuestions(g.recipe, mulberry32(1)).length < MIN_QUESTIONS) return toast(`"${g.name}" heeft te weinig sommen`, 'error');
    const names = parseNames(g.names);
    if (!names.length) continue;
    sgroups[g.id] = { name: g.name.trim(), recipe: g.recipe };
    names.forEach(n => students.push({ name: n, sg: g.id }));
  }
  if (students.length < 2) return toast('Minstens 2 leerlingen nodig', 'error');
  const dup = students.map(s => s.name.toLowerCase()).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) return toast('Dubbele naam: ' + dup[0] + ' — maak ze uniek (bijv. met achternaamletter)', 'error');

  const btn = $('#wz-create'); btn.disabled = true; btn.textContent = 'Bezig…';
  try {
    for (let tries = 0; tries < 15; tries++) {
      const code = newClassCode();
      if (await fb.read(`${fb.ROOT}/codes/${code}`)) continue;
      const { updates, cid } = ops.createClass({ name, code, students, sgroups });
      try { await fb.apply(updates); } catch { continue; } // code net bezet → opnieuw
      toast(`Klas aangemaakt — klascode ${code}`, 'success');
      return openClass(cid);
    }
    toast('Geen vrije klascode gevonden, probeer opnieuw', 'error');
  } catch (e) { toast('Aanmaken mislukt: ' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '🚀 Klas aanmaken'; }
};

/* ═════════════════ DASHBOARD ═════════════════ */
function stopClass() { unsub?.(); unsub = null; MAP?.destroy(); MAP = null; CID = null; KLAS = null; }

function openClass(cid) {
  stopClass();
  CID = cid;
  history.replaceState(null, '', '#k=' + cid);
  show('dash');
  let raf = null;
  unsub = fb.listen(ops.cls(cid), val => {
    if (!val) { toast('Deze klas bestaat niet (meer)', 'error'); return go('classes'); }
    KLAS = val;
    if (!raf) raf = requestAnimationFrame(() => { raf = null; renderDash(); });
  }, err => { toast('Geen toegang tot deze klas', 'error'); console.error(err); go('classes'); });
}

function studentInfo(sid) {
  const r = KLAS.roster[sid], pub = KLAS.public?.[sid] || {}, priv = KLAS.private?.[sid] || {};
  const total = KLAS.qsets?.[r.sg]?.total || 0;
  const wrong = Object.values(priv.wrong || {}).reduce((a, b) => a + b, 0);
  const land = pub.land || 0;
  const status = land === 0 && pub.status === 'respawned' && !(pub.respawnLeft > 0) ? ['💀', 'uitgeschakeld']
    : land === 0 && pub.status !== 'respawned' ? ['⏳', 'wacht op respawn']
    : pub.revenge ? ['🔥', 'revenge'] : pub.status === 'respawned' ? ['♻️', 'gerespawnd'] : ['', 'actief'];
  return { r, pub, priv, total, wrong, land, status, coins: coinsAvailable(priv, total), n: priv.n || 0,
    online: !!KLAS.presence?.[sid], hasPin: !!KLAS.pinset?.[sid] };
}

function renderDash() {
  if (!KLAS) return;
  const k = KLAS, meta = k.meta || {};
  $('#d-name').textContent = meta.name || '';
  $('#d-eyebrow').textContent = `▌ Week ${meta.week || 1}`;
  $('#d-code').textContent = meta.code || '····';
  $('#d-online').textContent = Object.keys(k.presence || {}).length;
  const battles = Object.entries(k.battles || {});
  $('#d-open').textContent = battles.filter(([, b]) => b.status !== 'done').length;
  $('#d-war').checked = !!meta.warRoomOpen;
  $('#d-war-lbl').textContent = meta.warRoomOpen ? 'War Room open' : 'War Room dicht';

  // kaart
  if (!MAP || MAP.W !== meta.W || MAP.H !== meta.H) { MAP?.destroy(); MAP = new MapView($('#d-map'), meta.W, meta.H); }
  MAP.render({ owners: ownersOf(k.map), roster: k.roster || {}, pub: k.public || {} });

  // logboek
  const name = sid => esc(k.roster?.[sid]?.name || '?');
  const feed = battles.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)).map(([bid, b]) => {
    const au = UNIT_ICON[k.hidden?.[bid]] || '', du = UNIT_ICON[b.defUnit] || '';
    let cls = 'wait', txt;
    if (b.status === 'open') txt = `🎯 ${name(b.att)} valt ${name(b.def)} aan ${au} — wacht op verdediging`;
    else if (b.status === 'defended') txt = `⏳ ${name(b.att)} ${au} vs ${name(b.def)} ${du} — nog niet afgehandeld`;
    else if (b.result === 'att') {
      cls = 'win';
      const rest = b.left > 0 ? ` · nog ${b.left} te kiezen` : b.ff ? ' · rest opgegeven' : '';
      txt = `⚔️ ${name(b.att)} ${au} verslaat ${name(b.def)} ${du} · buit ${b.n}${b.rev ? ' (revenge)' : ''}${rest}`;
    } else if (b.result === 'def') { cls = 'loss'; txt = `🛡️ ${name(b.def)} ${du} houdt ${name(b.att)} ${au} tegen`; }
    else { cls = 'draw'; txt = `🤝 ${name(b.att)} vs ${name(b.def)}: gelijkspel ${au}`; }
    return `<div class="e ${cls}"><span class="t">[${timeStr(b.ts)}]</span>${txt}</div>`;
  }).join('');
  $('#d-feed').innerHTML = feed || '<div class="hint">Nog geen gevechten deze week.</div>';

  // leerlingen per sommengroep
  const bySg = {};
  for (const sid of Object.keys(k.roster || {})) (bySg[k.roster[sid].sg] ||= []).push(sid);
  $('#d-students').innerHTML = Object.entries(k.sgroups || {}).map(([sg, def]) => {
    const sids = (bySg[sg] || []).sort((a, b) => k.roster[a].name.localeCompare(k.roster[b].name));
    const total = k.qsets?.[sg]?.total || 0;
    return `
      <div class="sg-head"><h3>${esc(def.name)}</h3><span class="hint">${sids.length} leerlingen · ${total} sommen</span></div>
      ${sids.length ? `<table class="list"><thead><tr>
        <th></th><th>Naam</th><th>Land</th><th>Sommen</th><th>Fout</th><th>Munten</th><th>Aanvallen</th><th>Status</th></tr></thead><tbody>
        ${sids.map(sid => {
          const s = studentInfo(sid);
          return `<tr class="click" data-sid="${esc(sid)}">
            <td><span class="dot" style="background:${esc(s.r.color)}"></span></td>
            <td><b>${esc(s.r.name)}</b> ${s.online ? '<span class="online-dot" title="online"></span>' : ''}
              ${s.hasPin ? '' : '<span class="chip sky" style="padding:1px 7px;font-size:0.65rem;">nieuw</span>'}</td>
            <td><span class="chip land">⬡ ${s.land}</span></td>
            <td><div class="row" style="gap:6px;flex-wrap:nowrap;"><div class="bar" style="flex:1"><i style="width:${s.total ? Math.min(100, s.n / s.total * 100) : 0}%"></i></div><span class="mono" style="font-size:0.72rem;">${s.n}/${s.total}</span></div></td>
            <td class="mono">${s.wrong || ''}</td>
            <td><span class="chip gold">🪙 ${s.coins}</span></td>
            <td class="mono">${s.priv.attacks || 0}</td>
            <td>${s.status[0]} <span class="hint">${s.status[1]}</span></td>
          </tr>`;
        }).join('')}</tbody></table>` : '<p class="hint">Nog geen leerlingen in deze groep.</p>'}`;
  }).join('');
  document.querySelectorAll('#d-students [data-sid]').forEach(tr => tr.onclick = () => openStudent(tr.dataset.sid));
  if (SEL && $('#m-student').classList.contains('open')) fillStudent();
}

/* ─── War Room ─── */
$('#d-war').onchange = e => safe(() => fb.apply(ops.warRoomUpdates(CID, e.target.checked)),
  e.target.checked ? 'War Room is open ⚔️' : 'War Room is dicht 🔒');

/* ─── Leerling-details ─── */
function openStudent(sid) { SEL = sid; fillStudent(); openModal('m-student'); }
function fillStudent() {
  if (!KLAS.roster?.[SEL]) { closeModal('m-student'); return; }
  const s = studentInfo(SEL), k = KLAS;
  $('#ms-name').textContent = s.r.name;
  $('#ms-dot').style.background = s.r.color;
  const hist = Object.keys(s.priv.hist || {}).map(x => k.roster?.[x]?.name || '?');
  const qs = k.qsets?.[s.r.sg]?.q || {};
  const worst = Object.entries(s.priv.wrong || {}).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([q, c]) => `${esc(qs[q] || q)} <span style="color:var(--alert)">×${c}</span>${s.priv.solved?.[q] ? ' ✓' : ''}`);
  $('#ms-details').innerHTML = `
    <div class="kv"><b>Land</b><span>⬡ ${s.land}</span></div>
    <div class="kv"><b>Sommen deze week</b><span>${s.n} / ${s.total} goed · ${s.wrong} keer fout</span></div>
    ${worst.length ? `<div class="kv"><b>Lastigste sommen</b><span class="err-list" style="text-align:right;">${worst.join('<br>')}</span></div>` : ''}
    <div class="kv"><b>Munten</b><span>🪙 ${s.coins}${s.priv.bonus ? ` (waarvan ${s.priv.bonus} van jou)` : ''}</span></div>
    <div class="kv"><b>Aanvallen</b><span>${s.priv.attacks || 0} → ${hist.length ? esc(hist.join(', ')) : 'niemand'}</span></div>
    <div class="kv"><b>Status</b><span>${s.status[0]} ${s.status[1]}</span></div>
    <div class="kv"><b>Pincode</b><span>${s.hasPin ? '🔒 ingesteld' : 'nog niet gekozen'}</span></div>
    <div class="kv"><b>Online</b><span>${s.online ? '🟢 ja' : '⚪ nee'}</span></div>`;
  $('#ms-sg').innerHTML = Object.entries(k.sgroups || {}).map(([sg, d]) =>
    `<option value="${esc(sg)}" ${sg === s.r.sg ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
}
$('#ms-pin').onclick = () => {
  const n = KLAS.roster[SEL].name;
  if (!confirm(`Pincode van ${n} wissen? ${n} kiest bij de volgende login een nieuwe.`)) return;
  safe(() => fb.apply(ops.pinResetUpdates(CID, SEL)), `Pincode van ${n} gewist`);
};
$('#ms-coin').onclick = () => safe(() => fb.apply(ops.giveCoinUpdates(CID, SEL, KLAS.private?.[SEL])), `+1 munt voor ${KLAS.roster[SEL].name}`);
$('#ms-move').onclick = () => {
  const sg = $('#ms-sg').value, r = KLAS.roster[SEL];
  if (sg === r.sg) return;
  if (!confirm(`${r.name} naar "${KLAS.sgroups[sg].name}"? De sommen-telling van deze week begint dan opnieuw.`)) return;
  safe(() => fb.apply(ops.moveStudentUpdates(CID, SEL, sg)), 'Verplaatst');
};
$('#ms-remove').onclick = () => {
  const n = KLAS.roster[SEL].name;
  if (!confirm(`${n} helemaal verwijderen? Het land wordt neutraal. Dit kan niet ongedaan worden.`)) return;
  safe(() => fb.apply(ops.removeStudentUpdates(CID, KLAS, SEL)), `${n} verwijderd`).then(() => closeModal('m-student'));
};

/* ─── Nieuwe week ─── */
$('#d-week').onclick = () => {
  const b = Object.values(KLAS.battles || {});
  const refunds = b.filter(x => x.status !== 'done').length;
  const loot = b.filter(x => x.status === 'done' && x.result === 'att' && x.left > 0).reduce((a, x) => a + x.left, 0);
  const owners = ownersOf(KLAS.map);
  const out = Object.keys(KLAS.roster || {}).filter(sid => !Object.values(owners).includes(sid)).map(s => KLAS.roster[s].name);
  $('#mw-body').innerHTML = `
    <p>Dit gebeurt er:</p>
    <ul class="hint" style="font-size:0.88rem;">
      <li>Elke sommengroep krijgt <b>nieuwe sommen</b> uit het recept.</li>
      <li>Munten, aanvallen en de sommen-telling gaan terug naar 0. <b>Land blijft</b>.</li>
      ${refunds ? `<li>${refunds} aanval(len) zijn niet afgehandeld → aanvaller krijgt de munt terug.</li>` : ''}
      ${loot ? `<li>${loot} buit-hex(en) nog niet gekozen → worden automatisch gekozen.</li>` : ''}
      ${out.length ? `<li>Terug in het spel met 5 hexen: <b>${esc(out.join(', '))}</b>.</li>` : ''}
      <li>Revenge en respawn worden gereset. De klascode blijft <b>${esc(KLAS.meta.code)}</b>.</li>
    </ul>`;
  openModal('m-week');
};
$('#mw-go').onclick = async () => {
  await safe(() => fb.apply(ops.newWeekUpdates(CID, KLAS)), `Week ${(KLAS.meta.week || 1) + 1} gestart 🎉`);
  closeModal('m-week');
};

/* ─── Sommengroepen ─── */
let SGE = null;
$('#d-sgroups').onclick = () => {
  const groups = Object.entries(KLAS.sgroups || {}).map(([id, d]) => ({ id, name: d.name, recipe: structuredClone(d.recipe), existing: true }));
  const used = new Set(Object.values(KLAS.roster || {}).map(r => r.sg));
  SGE = { groups };
  SGE.editor = recipeEditor($('#msg-groups'), groups, {
    canDelete: g => !used.has(g.id),
    extra: (g, gi) => g.existing ? `<div class="row" style="margin-top:8px;"><div class="spacer"></div>
      <button type="button" class="btn-warn btn-mini" data-regen="${esc(g.id)}">Nu opnieuw maken</button></div>` : '',
  });
  openModal('m-sgroups');
};
$('#msg-groups').addEventListener('click', e => {
  const b = e.target.closest('[data-regen]'); if (!b) return;
  const sg = b.dataset.regen, g = SGE.groups.find(x => x.id === sg);
  if (!confirm(`Sommen van "${g.name}" nú opnieuw maken met dit recept? De leerlingen in deze groep beginnen opnieuw met tellen.`)) return;
  const klas = { ...KLAS, sgroups: { ...KLAS.sgroups, [sg]: { name: g.name, recipe: g.recipe } } };
  safe(() => fb.apply({ ...ops.sgroupUpdates(CID, sg, g), ...ops.regenerateNowUpdates(CID, klas, sg) }), 'Nieuwe sommen staan klaar');
});
$('#msg-add').onclick = () => {
  SGE.groups.push({ id: nextSgId(SGE.groups.map(g => g.id)), name: 'Nieuwe groep', recipe: structuredClone(PRESETS.tafels.recipe) });
  SGE.editor.render();
};
$('#msg-save').onclick = async () => {
  const u = {};
  for (const g of SGE.groups) {
    if (!g.name.trim()) return toast('Elke sommengroep heeft een naam nodig', 'error');
    if (generateQuestions(g.recipe, mulberry32(1)).length < MIN_QUESTIONS) return toast(`"${g.name}" heeft te weinig sommen`, 'error');
    Object.assign(u, ops.sgroupUpdates(CID, g.id, g));
    // nieuwe groep: meteen een sommenset, zodat leerlingen erin kunnen
    if (!KLAS.sgroups?.[g.id]) Object.assign(u, ops.questionSetUpdates(CID, g.id, generateQuestions(g.recipe)));
  }
  for (const id of Object.keys(KLAS.sgroups || {})) if (!SGE.groups.find(g => g.id === id)) {
    u[`${ops.cls(CID)}/sgroups/${id}`] = null; u[`${ops.cls(CID)}/qsets/${id}`] = null; u[`${ops.cls(CID)}/answers/${id}`] = null;
  }
  await safe(() => fb.apply(u), 'Sommengroepen opgeslagen');
  closeModal('m-sgroups');
};

/* ─── Leerling toevoegen ─── */
$('#d-add').onclick = () => {
  $('#ma-name').value = '';
  $('#ma-sg').innerHTML = Object.entries(KLAS.sgroups || {}).map(([sg, d]) => `<option value="${esc(sg)}">${esc(d.name)}</option>`).join('');
  openModal('m-add'); $('#ma-name').focus();
};
$('#ma-go').onclick = async () => {
  const name = $('#ma-name').value.trim();
  if (!name) return toast('Vul een naam in', 'error');
  if (Object.values(KLAS.roster || {}).some(r => r.name.toLowerCase() === name.toLowerCase())) return toast('Die naam bestaat al in deze klas', 'error');
  const { updates } = ops.addStudentUpdates(CID, KLAS, { name, sg: $('#ma-sg').value });
  await safe(() => fb.apply(updates), `${name} toegevoegd`);
  closeModal('m-add');
};

/* ─── Klas verwijderen ─── */
$('#d-delete').onclick = async () => {
  const n = KLAS.meta.name;
  const typed = prompt(`Typ de naam van de klas om hem definitief te verwijderen:\n\n${n}`);
  if (typed === null) return;
  if (typed.trim() !== n) return toast('Naam klopt niet — niets verwijderd', 'error');
  const cid = CID, code = KLAS.meta.code;
  stopClass();
  await safe(() => fb.apply(ops.deleteClassUpdates(cid, code)), 'Klas verwijderd');
  go('classes');
};

start();
