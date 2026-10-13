// ════════════════════════════════════════════════════════════════════
//  Rekenstratego 3.0 — leerlingpagina
// ════════════════════════════════════════════════════════════════════
import * as fb from './firebase.js';
import * as ops from './ops.js';
import {
  pinHash, isValidPin, sameAnswer, milestones, coinsAvailable, UNITS, UNIT_ICON,
  ownersOf, lootOptions, findNeutralCluster, neighbors, shuffle, RESPAWN_LAND,
} from './core.js';
import { MapView } from './mapview.js';

/* ─────────────── helpers ─────────────── */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wait = ms => new Promise(r => setTimeout(r, ms));
const timeStr = ts => ts ? new Date(ts).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : '';
const UNIT_NAME = { maarschalk: 'Maarschalk', generaal: 'Generaal', spion: 'Spion' };
const unitTxt = u => u ? `${UNIT_ICON[u]} ${UNIT_NAME[u]}` : '';

function toast(msg, type = 'info') {
  const d = document.createElement('div'); d.className = 'toast ' + type; d.textContent = msg;
  $('#toasts').appendChild(d); setTimeout(() => d.remove(), 3400);
}
function confetti() {
  const colors = ['#14B87C', '#F7A312', '#4F6BFF', '#FF4D6B', '#9B5BFF'];
  for (let i = 0; i < 26; i++) {
    const s = document.createElement('div'); s.className = 'spark';
    s.style.background = colors[i % colors.length];
    s.style.left = (20 + Math.random() * 60) + 'vw'; s.style.top = (10 + Math.random() * 20) + 'vh';
    s.style.animationDelay = (Math.random() * 0.3) + 's';
    document.body.appendChild(s); setTimeout(() => s.remove(), 1500);
  }
}
const isOpen = id => $('#' + id).classList.contains('open');
const openModal = id => $('#' + id).classList.add('open');
const closeModal = id => { $('#' + id).classList.remove('open'); setTimeout(pump, 50); };
document.addEventListener('click', e => { const c = e.target.closest('[data-close]'); if (c) closeModal(c.closest('.overlay').id); });

/* ─────────────── state ─────────────── */
const LS_LAST = 'rs3:last';
let U = null, CID = null, SID = null;
let META = {}, ROSTER = {}, PUB = {}, MAP = {}, BATTLES = {}, PRIV = {}, QSET = null, SG = null;
let loadedWeek = null, mapView = null, lootView = null;
let queue = [], cur = null, mode = 'answer', revealed = null;
const unsubs = [];
let qsetUnsub = null;
let SEEN = new Set();
const defendHandled = new Set(), resolving = new Set(), unitCache = {};
let respawning = false;

const C = () => ops.cls(CID);
const me = () => ROSTER[SID] || {};
const myPub = () => PUB[SID] || {};
const total = () => QSET?.total || 0;
const nameOf = sid => ROSTER[sid]?.name || '?';

/* ═════════════════ INLOGGEN ═════════════════ */
async function start() {
  try { U = await fb.studentSignIn(); }
  catch (e) { $('#login-msg').textContent = '❌ Kan niet verbinden: ' + e.message; return; }
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LS_LAST) || 'null'); } catch {}
  if (last?.cid && last?.sid) {
    try {
      const s = await fb.read(`${ops.cls(last.cid)}/sessions/${last.sid}/${U.uid}`);
      if (s) return enterGame(last.cid, last.sid);
    } catch {}
    $('#in-code').value = last.code || '';
  }
  $('#in-code').focus();
}

let LOGIN = null; // { cid, code, roster, pinset }
$('#btn-code').onclick = async () => {
  const code = $('#in-code').value.trim();
  if (!/^\d{4}$/.test(code)) return toast('Een klascode heeft 4 cijfers', 'error');
  const btn = $('#btn-code'); btn.disabled = true; btn.textContent = 'Zoeken…';
  try {
    const cid = await fb.findClass(code);
    if (!cid) { $('#login-msg').textContent = '❌ Deze klascode bestaat niet.'; return; }
    const [roster, pinset] = await Promise.all([fb.read(`${ops.cls(cid)}/roster`), fb.read(`${ops.cls(cid)}/pinset`)]);
    LOGIN = { cid, code, roster: roster || {}, pinset: pinset || {} };
    const sel = $('#in-name');
    sel.innerHTML = '<option value="">Kies je naam…</option>' + Object.entries(LOGIN.roster)
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([sid, r]) => `<option value="${esc(sid)}">${esc(r.name)}${LOGIN.pinset[sid] ? ' 🔒' : ' (nieuw)'}</option>`).join('');
    $('#step-code').classList.add('hidden'); $('#step-name').classList.remove('hidden');
    $('#login-msg').textContent = '';
    sel.focus();
  } catch (e) { $('#login-msg').textContent = '❌ Verbindingsfout.'; console.error(e); }
  finally { btn.disabled = false; btn.textContent = 'Verbinden'; }
};
$('#in-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-code').click(); });
$('#in-name').onchange = () => {
  const sid = $('#in-name').value;
  $('#pin-hint').textContent = !sid ? '' : LOGIN.pinset[sid] ? 'Vul je pincode in.' : '🆕 Kies zelf een pincode van 4 cijfers en onthoud hem goed!';
  $('#in-pin').focus();
};
$('#in-pin').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-login').click(); });
$('#btn-back').onclick = () => { $('#step-name').classList.add('hidden'); $('#step-code').classList.remove('hidden'); $('#login-msg').textContent = ''; };
$('#btn-login').onclick = async () => {
  const sid = $('#in-name').value, pin = $('#in-pin').value.trim();
  if (!sid) return toast('Kies eerst je naam', 'error');
  if (!isValidPin(pin)) return toast('Een pincode is 4 cijfers', 'error');
  const btn = $('#btn-login'); btn.disabled = true; btn.textContent = 'Inloggen…';
  try {
    const h = await pinHash(LOGIN.cid, sid, pin);
    await fb.apply(ops.loginUpdates(LOGIN.cid, sid, U.uid, h, !!LOGIN.pinset[sid]));
    localStorage.setItem(LS_LAST, JSON.stringify({ cid: LOGIN.cid, sid, code: LOGIN.code }));
    enterGame(LOGIN.cid, sid);
  } catch (e) {
    console.error(e);
    $('#login-msg').textContent = LOGIN.pinset[sid] ? '❌ Pincode klopt niet.' : '❌ Dat lukte niet. Probeer het nog eens.';
    $('#in-pin').value = '';
  } finally { btn.disabled = false; btn.textContent = 'Start missie'; }
};
$('#btn-logout').onclick = () => { localStorage.removeItem(LS_LAST); location.reload(); };

/* ═════════════════ SPEL STARTEN ═════════════════ */
function enterGame(cid, sid) {
  CID = cid; SID = sid;
  try { SEEN = new Set(JSON.parse(localStorage.getItem(`rs3:seen:${cid}:${sid}`) || '[]')); } catch {}
  $('#scr-login').classList.add('hidden'); $('#scr-game').classList.remove('hidden');

  const L = (path, fn) => unsubs.push(fb.listen(path, fn, err => console.error(path, err)));
  L(`${C()}/meta`, v => {
    META = v || {};
    if (loadedWeek != null && META.week !== loadedWeek) { toast('Er is een nieuwe week gestart! 🎉', 'info'); setTimeout(() => location.reload(), 1500); }
    loadedWeek ??= META.week;
    renderAll();
  });
  L(`${C()}/roster`, v => {
    ROSTER = v || {};
    if (!ROSTER[SID]) { localStorage.removeItem(LS_LAST); location.reload(); return; }
    if (me().sg !== SG) subscribeQuestions(me().sg);
    renderAll();
  });
  L(`${C()}/public`, v => { PUB = v || {}; renderAll(); });
  L(`${C()}/map`, v => { MAP = v || {}; renderAll(); });
  L(`${C()}/battles`, v => { BATTLES = v || {}; renderAll(); });
  L(`${C()}/private/${SID}`, v => { PRIV = v || {}; renderHud(); renderWar(); });
  L('.info/connected', v => { $('#conn').style.display = v === false ? 'block' : 'none'; });
  fb.setupPresence(CID, SID).catch(() => {});
}

function subscribeQuestions(sg) {
  SG = sg;
  qsetUnsub?.();
  qsetUnsub = fb.listen(`${C()}/qsets/${sg}`, v => {
    const changed = JSON.stringify(v?.q) !== JSON.stringify(QSET?.q);
    QSET = v;
    if (changed) { buildQueue(); nextQ(); }
    renderHud();
  });
}

let rafPending = false;
function renderAll() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderHud(); renderWar(); renderMap(); renderLog(); pump();
    if (isOpen('m-loot')) renderLoot();
  });
}

/* ═════════════════ HUD ═════════════════ */
function renderHud() {
  const r = me(), p = myPub(), n = PRIV.n || 0, t = total();
  $('#me-name').textContent = (r.name || '') + (p.revenge ? ' 🔥' : '');
  $('#me-dot').style.background = r.color || '#ccc';
  $('#me-land').textContent = p.land ?? 0;
  $('#me-coins').textContent = coinsAvailable(PRIV, t);
  if (!t) return;
  const ms = milestones(t);
  $('#prog-fill').style.width = Math.min(100, n / t * 100) + '%';
  ms.forEach((m, i) => {
    const f = $('#flag' + (i + 1));
    f.style.left = (m / t * 100) + '%'; f.classList.toggle('hit', n >= m);
  });
  const next = ms.find(m => n < m);
  $('#prog-text').textContent = next == null ? `✅ Alle ${t} sommen gemaakt!` : `${n}/${next} sommen tot je volgende munt 🪙`;
}

/* ═════════════════ SOMMEN ═════════════════ */
function buildQueue() {
  if (!QSET?.q) { queue = []; return; }
  const solved = PRIV.solved || {}, wrong = PRIV.wrong || {};
  const open = shuffle(Object.keys(QSET.q).filter(q => !solved[q]));
  // lastige sommen komen vaker terug
  for (const [q, cnt] of Object.entries(wrong)) {
    if (!open.includes(q)) continue;
    for (let j = 0; j < Math.min(cnt, 2); j++) open.splice(1 + Math.floor(Math.random() * open.length), 0, q);
  }
  queue = open;
}
function nextQ() {
  queue = queue.filter(q => !PRIV.solved?.[q] && QSET?.q?.[q]);
  // niet twee keer dezelfde som achter elkaar
  if (queue.length > 1 && queue[0] === cur) queue.push(queue.shift());
  const has = queue.length > 0;
  $('#q-box').classList.toggle('hidden', !has); $('#done-box').classList.toggle('hidden', has || !QSET);
  if (!has) { cur = null; return; }
  cur = queue[0]; mode = 'answer'; revealed = null;
  $('#q-text').textContent = QSET.q[cur];
  const inp = $('#answ'); inp.value = ''; inp.className = ''; inp.placeholder = 'Antwoord';
  $('#feedback').textContent = ''; $('#feedback').className = '';
  $('#btn-check').textContent = 'Check ✓';
  if (!anyModalOpen()) inp.focus();
}
$('#answ').addEventListener('keydown', e => { if (e.key === 'Enter') check(); });
$('#btn-check').onclick = () => check();

async function check() {
  if (!cur || mode === 'busy') return;
  const inp = $('#answ'), fbk = $('#feedback'), val = inp.value;
  if (!val.trim()) return;

  if (mode === 'copy') {
    if (sameAnswer(val, revealed)) {
      mode = 'busy'; fbk.className = 'ok'; fbk.textContent = '👍 Goed overgetypt! Deze som komt straks terug.';
      const q = queue.shift(); queue.splice(Math.max(1, Math.floor(queue.length * 0.6)), 0, q);
      setTimeout(nextQ, 900);
    } else {
      inp.classList.remove('wrong'); void inp.offsetWidth; inp.classList.add('wrong');
      fbk.className = 'copy'; fbk.textContent = `Kijk goed: het antwoord is ${revealed}`;
    }
    return;
  }

  mode = 'busy';
  const q = cur, before = coinsAvailable(PRIV, total());
  try {
    // Let op: PRIV niet zelf ophogen — Firebase stuurt de nieuwe waarde al via de listener
    // (lokale events komen vóór de bevestiging). Dubbel tellen = volgende som afgekeurd.
    await fb.apply(ops.solveUpdates(CID, SID, q, val, PRIV));
    inp.className = ''; fbk.className = 'ok'; fbk.textContent = '✅ Goed!';
    renderHud();
    const after = coinsAvailable(PRIV, total());
    if (after > before) { confetti(); toast('🪙 Munt verdiend!', 'success'); renderWar(); }
    queue = queue.filter(x => x !== q);
    setTimeout(nextQ, 450);
  } catch (e) {
    // De rules keurden het antwoord af → fout. Teller ophogen, dan mag het antwoord gelezen worden.
    try {
      await fb.apply(ops.wrongUpdates(CID, SID, q, PRIV));
      revealed = await fb.read(`${C()}/answers/${SG}/${q}`);
    } catch (e2) { console.error(e2); }
    if (revealed == null) { mode = 'answer'; toast('Er ging iets mis met opslaan, probeer opnieuw', 'error'); return; }
    mode = 'copy';
    inp.value = ''; inp.className = 'wrong copy'; inp.placeholder = 'Typ het over';
    fbk.className = 'bad'; fbk.innerHTML = `❌ Helaas! Het goede antwoord is <b>${esc(revealed)}</b>. Typ het over:`;
    $('#btn-check').textContent = 'Overtypen ✓';
    inp.focus();
  }
}

/* ═════════════════ WAR ROOM ═════════════════ */
function isEliminated(sid = SID) {
  const p = PUB[sid] || {};
  return (p.land || 0) === 0 && p.status === 'respawned' && !(p.respawnLeft > 0);
}
function renderWar() {
  const coins = coinsAvailable(PRIV, total());
  const btn = $('#btn-attack'), msg = $('#war-msg');
  let can = false;
  if (isEliminated()) msg.textContent = '💀 Je bent uitgeschakeld. Blijf lekker oefenen — volgende week doe je weer mee!';
  else if (!META.warRoomOpen) msg.textContent = '🔒 De War Room is nu dicht. Je juf of meester zet hem open.';
  else if ((myPub().land || 0) === 0) msg.textContent = '⏳ Even wachten op je nieuwe land…';
  else if (coins < 1) {
    const t = total(), next = t ? milestones(t).find(m => (PRIV.n || 0) < m) : null;
    msg.textContent = next ? `Maak sommen om een munt te verdienen (bij ${next} goed).` : 'Je munten zijn op voor deze week.';
  } else { msg.textContent = `Je hebt ${coins} munt${coins > 1 ? 'en' : ''}: één aanval kost één munt.`; can = true; }
  btn.disabled = !can;
  const waiting = Object.values(BATTLES).filter(b => b.att === SID && b.status !== 'done').map(b => nameOf(b.def));
  $('#pending').textContent = waiting.length ? '⏳ Wacht op verdediging van: ' + waiting.join(', ') : '';
}

let SEL_T = null, SEL_U = null;
$('#btn-attack').onclick = () => {
  SEL_T = null; SEL_U = null;
  const hist = PRIV.hist || {};
  const list = Object.entries(ROSTER).filter(([sid]) => sid !== SID)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([sid, r]) => {
      const p = PUB[sid] || {}, land = p.land || 0, used = !!hist[sid];
      if (land <= 0) return '';
      return `<div class="target ${used ? 'used' : ''}" data-t="${esc(sid)}">
        <span><span class="dot" style="background:${esc(r.color)}"></span> ${esc(r.name)}${p.revenge ? ' 🔥' : ''}</span>
        <span class="row" style="gap:6px;"><span class="chip land">⬡ ${land}</span>${used ? '<span class="chip red">al aangevallen</span>' : ''}</span>
      </div>`;
    }).join('');
  $('#targets').innerHTML = list || '<p class="hint">Niemand om aan te vallen.</p>';
  $('#att-units').innerHTML = UNITS.map(u => `<button type="button" class="unit" data-u="${u}"><div class="ic">${UNIT_ICON[u]}</div><div class="nm">${UNIT_NAME[u]}</div></button>`).join('');
  $('#btn-fire').disabled = true;
  openModal('m-attack');
};
$('#targets').onclick = e => {
  const t = e.target.closest('[data-t]'); if (!t || t.classList.contains('used')) return;
  document.querySelectorAll('#targets .target').forEach(x => x.classList.remove('sel'));
  t.classList.add('sel'); SEL_T = t.dataset.t; $('#btn-fire').disabled = !SEL_U;
};
$('#att-units').onclick = e => {
  const u = e.target.closest('[data-u]'); if (!u) return;
  document.querySelectorAll('#att-units .unit').forEach(x => x.classList.remove('sel'));
  u.classList.add('sel'); SEL_U = u.dataset.u; $('#btn-fire').disabled = !SEL_T;
};
$('#btn-fire').onclick = async () => {
  if (!SEL_T || !SEL_U) return;
  const btn = $('#btn-fire'); btn.disabled = true;
  try {
    const { updates, bid } = ops.attackUpdates({ cid: CID, att: SID, def: SEL_T, unit: SEL_U, week: META.week, pubAtt: myPub(), privAtt: PRIV });
    await fb.apply(updates);
    unitCache[bid] = SEL_U;
    toast(`⚔️ Aanval op ${nameOf(SEL_T)} verstuurd!`, 'info');
    closeModal('m-attack');
  } catch (e) {
    console.error(e); toast('Aanval lukte niet (munt op, War Room dicht of al aangevallen)', 'error'); btn.disabled = false;
  }
};

/* ═════════════════ GEBEURTENISSEN (verdedigen, uitslag, buit, respawn) ═════════════════ */
const anyModalOpen = () => [...document.querySelectorAll('.overlay')].some(o => o.classList.contains('open'));
function saveSeen() { try { localStorage.setItem(`rs3:seen:${CID}:${SID}`, JSON.stringify([...SEEN].slice(-300))); } catch {} }

/** Bepaalt wat er nu moet gebeuren. Eén ding tegelijk, in volgorde van belang. */
function pump() {
  if (!SID || !META.week) return;
  const mine = Object.entries(BATTLES).filter(([, b]) => b.att === SID || b.def === SID).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));

  // gevechten afhandelen die al verdedigd zijn (kan door beide deelnemers)
  for (const [bid, b] of mine) if (b.status === 'defended' && !resolving.has(bid)) resolve(bid);

  if (anyModalOpen()) return;

  // 1. verdedigen
  const def = mine.find(([bid, b]) => b.def === SID && b.status === 'open' && !defendHandled.has(bid));
  if (def) return showDefend(def[0], def[1]);
  // 2. uitslagen
  const res = mine.find(([bid, b]) => b.status === 'done' && !SEEN.has(bid));
  if (res) return showResult(res[0], res[1]);
  // 3. buit kiezen
  const loot = mine.find(([, b]) => b.att === SID && b.status === 'done' && b.result === 'att' && b.left > 0 && !b.ff);
  if (loot) return openLoot(loot[0]);
  // 4. respawn
  checkRespawn();
}

async function resolve(bid) {
  resolving.add(bid);
  try {
    const b = BATTLES[bid];
    const attUnit = await fb.read(`${C()}/hidden/${bid}`);
    unitCache[bid] = attUnit;
    const { updates } = ops.resolveUpdates(CID, bid, b, attUnit, PUB[b.def]?.land || 0);
    await fb.apply(updates);
  } catch (e) { /* de ander was ons voor — prima */ }
  setTimeout(() => resolving.delete(bid), 4000);
}

/* ─── verdedigen ─── */
let defTimer = null, DEF = null;
function showDefend(bid, b) {
  DEF = bid;
  $('#def-msg').innerHTML = `<b>${esc(nameOf(b.att))}</b> valt je aan! Kies snel je verdediging:`;
  $('#def-units').innerHTML = UNITS.map(u => `<button type="button" class="unit" data-u="${u}"><div class="ic">${UNIT_ICON[u]}</div><div class="nm">${UNIT_NAME[u]}</div></button>`).join('');
  openModal('m-defend');
  let left = 20;
  const paint = () => {
    $('#def-fill').style.width = (left / 20 * 100) + '%';
    $('#def-fill').className = left <= 5 ? 'crit' : left <= 10 ? 'warn' : '';
    $('#def-num').textContent = left;
  };
  paint(); clearInterval(defTimer);
  defTimer = setInterval(() => {
    left--; paint();
    if (left <= 0) { const u = UNITS[Math.floor(Math.random() * 3)]; toast('⏰ Tijd om! Het lot koos de ' + UNIT_NAME[u], 'info'); defend(u); }
  }, 1000);
}
$('#def-units').onclick = e => { const u = e.target.closest('[data-u]'); if (u) defend(u.dataset.u); };
async function defend(unit) {
  clearInterval(defTimer);
  const bid = DEF; if (!bid) return;
  DEF = null; defendHandled.add(bid);
  try { await fb.apply(ops.defendUpdates(CID, bid, unit)); } catch (e) { console.error(e); }
  closeModal('m-defend');
  // meteen afhandelen
  await wait(150);
  if (BATTLES[bid]?.status === 'defended' && !resolving.has(bid)) resolve(bid);
}

/* ─── uitslag ─── */
async function showResult(bid, b) {
  SEEN.add(bid); saveSeen();
  let au = unitCache[bid];
  if (!au) { try { au = await fb.read(`${C()}/hidden/${bid}`); } catch {} }
  const du = b.defUnit, iAtt = b.att === SID, other = esc(nameOf(iAtt ? b.def : b.att));
  const mineU = iAtt ? au : du, theirU = iAtt ? du : au;
  const vs = `Jouw ${unitTxt(mineU)} tegen ${unitTxt(theirU)}.`;
  let title, msg;
  if (b.result === 'draw') { title = '🤝 Gelijkspel'; msg = `Jullie kozen allebei ${unitTxt(au)}. Niemand wint.`; }
  else if (iAtt && b.result === 'att') { title = '🏆 Gewonnen!'; msg = `${vs}<br>Je verslaat <b>${other}</b>! Kies nu <b>${b.n}</b> hex${b.n > 1 ? 'en' : ''} van ${other}.`; confetti(); }
  else if (iAtt) { title = '🛡️ Verloren'; msg = `${vs}<br><b>${other}</b> hield je tegen.`; }
  else if (b.result === 'def') { title = '🛡️ Verdedigd!'; msg = `${vs}<br>Je hield <b>${other}</b> tegen. Goed gedaan!`; confetti(); }
  else { title = '💥 Verloren'; msg = `${vs}<br><b>${other}</b> pakt ${b.n} hex${b.n > 1 ? 'en' : ''} van jouw land.`; }
  $('#res-title').textContent = title; $('#res-msg').innerHTML = msg;
  openModal('m-result');
}
$('#res-ok').onclick = () => closeModal('m-result');

/* ─── buit kiezen ─── */
let LOOT = null, lootBusy = false;
function openLoot(bid) {
  LOOT = bid;
  openModal('m-loot');
  if (!lootView || lootView.W !== META.W) {
    lootView?.destroy();
    lootView = new MapView($('#loot-map'), META.W, META.H);
    lootView.onClick = pickLoot;
  }
  requestAnimationFrame(() => { lootView.resize(); renderLoot(); });
}
function renderLoot() {
  const b = BATTLES[LOOT];
  if (!b || !(b.left > 0) || b.ff) {
    lootView?.render({ highlight: null, flash: null });
    closeModal('m-loot'); LOOT = null;
    if (b) toast('🏆 Buit binnen!', 'success');
    return;
  }
  const owners = ownersOf(MAP);
  const opt = lootOptions(owners, META.W, META.H, b);
  const ids = new Set([...opt.adjacent, ...opt.free]);
  const dn = esc(nameOf(b.def));
  $('#loot-msg').innerHTML = `Klik nog <b>${b.left}</b> hex${b.left > 1 ? 'en' : ''} van <b>${dn}</b> aan.`;
  $('#loot-hint').textContent = opt.stuck ? `${nameOf(b.def)} heeft geen land meer dat je kunt pakken.`
    : b.left === b.n ? `Je eerste hex mag overal in het land van ${nameOf(b.def)} liggen. Daarna moet elke hex aansluiten op jouw land.`
    : opt.free.length && !opt.adjacent.length ? 'Er sluit niets meer aan: je mag nog één keer ergens anders beginnen.'
    : 'Kies een hex die aansluit op jouw land (de knipperende hexen).';
  $('#btn-forfeit').classList.toggle('hidden', !opt.stuck);
  lootView.render({ owners, roster: ROSTER, pub: PUB, me: SID, highlight: { ids, color: '#F7A312' } });
}
async function pickLoot(hex) {
  if (lootBusy || !LOOT) return;
  const b = BATTLES[LOOT];
  const owners = ownersOf(MAP);
  const opt = lootOptions(owners, META.W, META.H, b);
  if (!opt.adjacent.includes(hex) && !opt.free.includes(hex)) return toast('Die hex mag je niet kiezen', 'error');
  lootBusy = true;
  try {
    await fb.apply(ops.lootStepUpdates(CID, LOOT, b, hex, PUB[b.att], PUB[b.def], !opt.adjacent.includes(hex)));
    lootView.render({ flash: hex });
  } catch (e) { console.error(e); toast('Dat lukte niet, probeer een andere hex', 'error'); }
  finally { lootBusy = false; }
}
$('#btn-forfeit').onclick = async () => {
  try { await fb.apply(ops.forfeitUpdates(CID, LOOT)); } catch (e) { console.error(e); }
};

/* ─── respawn ─── */
async function checkRespawn() {
  const p = myPub();
  if (respawning || p.land == null || !META.W) return;
  const needStart = p.land === 0 && p.status === 'active';
  const needSteps = p.status === 'respawned' && p.respawnLeft > 0;
  if (!needStart && !needSteps) return;
  respawning = true;
  try {
    let pub = { ...p };
    if (needStart) {
      await fb.apply(ops.respawnStartUpdates(CID, SID));
      pub = { ...pub, status: 'respawned', revenge: true, respawnLeft: RESPAWN_LAND };
      $('#res-title').textContent = '💥 Je land is op… maar!';
      $('#res-msg').innerHTML = 'Je krijgt <b>REVENGE MODE 🔥</b>: je begint opnieuw met 3 hexen en je volgende aanval pakt dubbel zoveel land!';
      openModal('m-result');
    }
    const owners = ownersOf(MAP);
    while (pub.respawnLeft > 0) {
      let hex;
      const mineHex = Object.keys(owners).filter(h => owners[h] === SID);
      if (!mineHex.length) hex = findNeutralCluster(owners, META.W, META.H, pub.respawnLeft)[0];
      else {
        const cand = [...new Set(mineHex.flatMap(h => neighbors(h, META.W, META.H)))].filter(h => !owners[h]);
        hex = cand.sort((a, b) => neighbors(b, META.W, META.H).filter(x => !owners[x]).length - neighbors(a, META.W, META.H).filter(x => !owners[x]).length)[0];
      }
      if (!hex) break;
      await fb.apply(ops.respawnStepUpdates(CID, SID, hex, pub));
      owners[hex] = SID;
      pub = { ...pub, respawnLeft: pub.respawnLeft - 1, land: (pub.land || 0) + 1 };
    }
  } catch (e) { console.error('respawn', e); }
  finally { setTimeout(() => { respawning = false; }, 1500); }
}

/* ═════════════════ KAART & LOGBOEK ═════════════════ */
function renderMap() {
  if (!META.W) return;
  if (!mapView || mapView.W !== META.W || mapView.H !== META.H) { mapView?.destroy(); mapView = new MapView($('#map'), META.W, META.H); }
  mapView.render({ owners: ownersOf(MAP), roster: ROSTER, pub: PUB, me: SID });
}
function renderLog() {
  const mine = Object.entries(BATTLES).filter(([, b]) => b.att === SID || b.def === SID).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
  $('#log').innerHTML = mine.map(([bid, b]) => {
    const iAtt = b.att === SID, other = esc(nameOf(iAtt ? b.def : b.att));
    let cls = 'wait', txt;
    if (b.status !== 'done') txt = iAtt ? `🎯 Jij valt ${other} aan — wacht op verdediging` : `⚠️ ${other} valt je aan!`;
    else if (b.result === 'draw') { cls = 'draw'; txt = `🤝 Gelijkspel ${iAtt ? 'tegen' : 'met'} ${other}`; }
    else if ((b.result === 'att') === iAtt) { cls = 'win'; txt = iAtt ? `🏆 Je won van ${other} (+${b.n - (b.left || 0)} land)` : `🛡️ Je hield ${other} tegen`; }
    else { cls = 'loss'; txt = iAtt ? `Je aanval op ${other} mislukte` : `💥 ${other} won van jou (−${b.n} land)`; }
    return `<div class="e ${cls}"><span class="t">[${timeStr(b.ts)}]</span>${txt}</div>`;
  }).join('') || '<div class="hint">Nog geen gevechten deze week.</div>';
}

start();
