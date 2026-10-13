// ════════════════════════════════════════════════════════════════════
//  Rekenstratego 3.0 — ops.js
//  Bouwt de multi-path updates voor elke spelzet. Puur (geen I/O):
//  de pagina's doen   update(ref(db), ops.xxx(...))   en de rules-tests
//  gebruiken exact dezelfde functies.
//  Alle paden zijn relatief aan de database-root.
// ════════════════════════════════════════════════════════════════════
import {
  COLORS, START_LAND, RESPAWN_LAND, REJOIN_LAND, MAX_FREE_PICKS,
  newId, mulberry32, canonAnswer, milestones, battleResult, lootSize,
  mapSizeFor, generateMap, assignColors, buildAdjacency, generateQuestions, findNeutralCluster,
  ownersOf, landCounts, lootOptions, neighbors, ensureNeutral, NEUTRAL_RESERVE,
} from './core.js';

export const ROOT = 'v3';
export const TS = { '.sv': 'timestamp' };
export const cls = cid => `${ROOT}/classes/${cid}`;

/* ═════════════════ LEERKRACHT ═════════════════ */

/** Sommenset (vragen + verborgen antwoorden) voor één sommengroep. */
export function questionSetUpdates(cid, sg, questions) {
  const q = {}, a = {};
  questions.forEach((x, i) => { q['q' + i] = String(x.q); a['q' + i] = canonAnswer(x.a); });
  const [m1, m2, m3] = milestones(questions.length);
  return {
    [`${cls(cid)}/qsets/${sg}`]: { q, m: { 1: m1, 2: m2, 3: m3 }, total: questions.length },
    [`${cls(cid)}/answers/${sg}`]: a,
  };
}

/**
 * Nieuwe klas.
 * students: [{name, sg}]   sgroups: {sgId: {name, recipe}}
 * Geeft { updates, cid, sids }.
 */
export function createClass({ name, code, students, sgroups, seed = Date.now(), cid = newId('k', 10) }) {
  const rng = mulberry32(seed);
  const C = cls(cid);
  const sids = students.map(() => newId('s', 8));
  const { W, H } = mapSizeFor(students.length);
  const owners = generateMap(W, H, sids, rng);
  const land = landCounts(owners);
  const colors = assignColors(owners, W, H, sids);

  const roster = {}, pub = {}, priv = {}, map = {};
  students.forEach((s, i) => {
    const sid = sids[i];
    roster[sid] = { name: String(s.name).trim().slice(0, 40), sg: s.sg, color: colors[sid] };
    pub[sid] = { land: land[sid] || 0, status: 'active', revenge: false, respawnLeft: 0, lost: 0 };
    priv[sid] = { n: 0, attacks: 0, bonus: 0 };
  });
  for (const [hex, sid] of Object.entries(owners)) map[hex] = { o: sid, via: 'init' };

  const qsets = {}, answers = {};
  for (const [sg, def] of Object.entries(sgroups)) {
    const u = questionSetUpdates(cid, sg, generateQuestions(def.recipe, rng));
    qsets[sg] = u[`${C}/qsets/${sg}`];
    answers[sg] = u[`${C}/answers/${sg}`];
  }

  const updates = {
    [`${ROOT}/codes/${code}`]: cid,
    [`${ROOT}/classIndex/${cid}`]: { name, code: Number(code), createdAt: TS },
    [C]: {
      meta: { name, week: 1, code: Number(code), warRoomOpen: false, createdAt: TS, W, H },
      roster, sgroups, qsets, answers, public: pub, private: priv, map, adj: buildAdjacency(W, H),
    },
  };
  return { updates, cid, sids };
}

/** Klas helemaal verwijderen (inclusief code en index). */
export function deleteClassUpdates(cid, code) {
  return { [cls(cid)]: null, [`${ROOT}/classIndex/${cid}`]: null, [`${ROOT}/codes/${code}`]: null };
}

/** Recept van een sommengroep aanpassen (geldt vanaf de volgende nieuwe week). */
export function sgroupUpdates(cid, sg, def) {
  return { [`${cls(cid)}/sgroups/${sg}`]: { name: String(def.name).trim().slice(0, 30), recipe: def.recipe } };
}

/**
 * Sommen van één sommengroep nú opnieuw maken (bijv. recept aangepast bij de start).
 * Leerlingen in die groep beginnen met tellen opnieuw; munten die al besteed zijn blijven besteed.
 */
export function regenerateNowUpdates(cid, klas, sg, seed = Date.now()) {
  const u = questionSetUpdates(cid, sg, generateQuestions(klas.sgroups[sg].recipe, mulberry32(seed)));
  for (const [sid, r] of Object.entries(klas.roster || {})) {
    if (r.sg !== sg) continue;
    Object.assign(u, resetProgress(cid, sid));
  }
  return u;
}
function resetProgress(cid, sid) {
  const P = `${cls(cid)}/private/${sid}`;
  return { [`${P}/n`]: 0, [`${P}/solved`]: null, [`${P}/wrong`]: null, [`${P}/last`]: null };
}

/** Leerling naar een andere sommengroep: telling van deze week begint opnieuw. */
export function moveStudentUpdates(cid, sid, sg) {
  return { [`${cls(cid)}/roster/${sid}/sg`]: sg, ...resetProgress(cid, sid) };
}

export function warRoomUpdates(cid, open) { return { [`${cls(cid)}/meta/warRoomOpen`]: !!open }; }

/** Pincode wissen: leerling kiest bij de volgende login een nieuwe. */
export function pinResetUpdates(cid, sid) {
  const C = cls(cid);
  return { [`${C}/pins/${sid}`]: null, [`${C}/pinset/${sid}`]: null, [`${C}/sessions/${sid}`]: null };
}

export function giveCoinUpdates(cid, sid, priv) {
  return { [`${cls(cid)}/private/${sid}/bonus`]: (priv?.bonus || 0) + 1 };
}

/** Leerling toevoegen midden in het spel: krijgt een vrij plekje met REJOIN_LAND hexen. */
export function addStudentUpdates(cid, klas, { name, sg }, rng = Math.random) {
  const C = cls(cid);
  const sid = newId('s', 8);
  const owners = ownersOf(klas.map);
  const cluster = findNeutralCluster(owners, klas.meta.W, klas.meta.H, REJOIN_LAND, rng);
  for (const hex of cluster) owners[hex] = sid;
  const preset = Object.fromEntries(Object.entries(klas.roster || {}).map(([s, r]) => [s, r.color]));
  const color = assignColors(owners, klas.meta.W, klas.meta.H, [sid], preset)[sid];
  const u = {
    [`${C}/roster/${sid}`]: { name: String(name).trim().slice(0, 40), sg, color },
    [`${C}/public/${sid}`]: { land: cluster.length, status: 'active', revenge: false, respawnLeft: 0, lost: 0 },
    [`${C}/private/${sid}`]: { n: 0, attacks: 0, bonus: 0 },
  };
  for (const hex of cluster) u[`${C}/map/${hex}`] = { o: sid, via: 'init' };
  return { updates: u, sid };
}

/** Leerling verwijderen: alle sporen weg, zijn land wordt neutraal. */
export function removeStudentUpdates(cid, klas, sid) {
  const C = cls(cid);
  const u = {};
  for (const k of ['roster', 'public', 'private', 'pins', 'pinset', 'sessions', 'presence']) u[`${C}/${k}/${sid}`] = null;
  for (const [hex, v] of Object.entries(klas.map || {})) if (v.o === sid) u[`${C}/map/${hex}`] = null;
  for (const [uid, s] of Object.entries(klas.uids || {})) if (s === sid) u[`${C}/uids/${uid}`] = null;
  return u;
}

/**
 * Nieuwe week:
 * - nieuwe sommen uit de recepten
 * - lopende buit wordt automatisch afgerond (best aansluitende hexen)
 * - aanvallen die nooit zijn afgehandeld: munt terug
 * - uitgeschakelden komen terug met REJOIN_LAND hexen
 * - status, revenge en weektellers op nul
 */
export function newWeekUpdates(cid, klas, seed = Date.now()) {
  const rng = mulberry32(seed);
  const C = cls(cid);
  const { W, H } = klas.meta;
  const owners = ownersOf(klas.map);
  const u = {};
  const refunds = {};

  // 1. Lopende gevechten afronden
  for (const b of Object.values(klas.battles || {})) {
    if (b.status !== 'done') { refunds[b.att] = (refunds[b.att] || 0) + 1; continue; }
    if (b.result !== 'att' || !(b.left > 0)) continue;
    let state = { ...b };
    while (state.left > 0) {
      const opt = lootOptions(owners, W, H, state);
      const list = opt.adjacent.length ? opt.adjacent : opt.free;
      if (!list.length) break;
      // voorkeur: hex met de meeste buren van de winnaar
      const hex = list.map(id => [id, neighbors(id, W, H).filter(n => owners[n] === b.att).length])
        .sort((x, y) => y[1] - x[1])[0][0];
      owners[hex] = b.att;
      u[`${C}/map/${hex}`] = { o: b.att, via: 'init' };
      state = { ...state, left: state.left - 1, fr: (state.fr || 0) + (opt.adjacent.includes(hex) ? 0 : 1) };
    }
  }

  // 2. Genoeg neutraal land houden (voor respawns en terugkeerders):
  //    is het te weinig, dan staan de grootste landen randhexen af.
  const land = landCounts(owners);
  const out = Object.keys(klas.roster || {}).filter(sid => !(land[sid] > 0));
  for (const hex of ensureNeutral(owners, W, H, Math.ceil(W * H * NEUTRAL_RESERVE) + out.length * REJOIN_LAND)) {
    u[`${C}/map/${hex}`] = null;
  }

  // 3. Uitgeschakelden terugplaatsen
  for (const sid of out) {
    for (const hex of findNeutralCluster(owners, W, H, REJOIN_LAND, rng)) {
      owners[hex] = sid; u[`${C}/map/${hex}`] = { o: sid, via: 'init' };
    }
  }

  // 4. Per leerling resetten
  const finalLand = landCounts(owners);
  for (const sid of Object.keys(klas.roster || {})) {
    u[`${C}/public/${sid}`] = { land: finalLand[sid] || 0, status: 'active', revenge: false, respawnLeft: 0, lost: 0 };
    u[`${C}/private/${sid}`] = { n: 0, attacks: 0, bonus: refunds[sid] || 0 };
  }

  // 5. Nieuwe sommen
  for (const [sg, def] of Object.entries(klas.sgroups || {})) {
    Object.assign(u, questionSetUpdates(cid, sg, generateQuestions(def.recipe, rng)));
  }

  u[`${C}/battles`] = null;
  u[`${C}/hidden`] = null;
  u[`${C}/meta/week`] = (klas.meta.week || 1) + 1;
  return u;
}

/* ═════════════════ LEERLING ═════════════════ */

/**
 * Inloggen. Als de leerling nog geen pin heeft, wordt deze meteen geclaimd.
 * hash = await pinHash(cid, sid, pin)
 */
export function loginUpdates(cid, sid, uid, hash, hasPin) {
  const C = cls(cid);
  const u = {
    [`${C}/sessions/${sid}/${uid}`]: { h: hash, ts: TS },
    [`${C}/uids/${uid}`]: sid,
  };
  if (!hasPin) { u[`${C}/pins/${sid}`] = hash; u[`${C}/pinset/${sid}`] = true; }
  return u;
}

export function presenceRef(cid, sid) { return `${cls(cid)}/presence/${sid}`; }

/** Goed antwoord. priv = huidige private-node van de leerling. */
export function solveUpdates(cid, sid, qid, answer, priv) {
  const P = `${cls(cid)}/private/${sid}`;
  return {
    [`${P}/solved/${qid}`]: canonAnswer(answer),
    [`${P}/n`]: (priv?.n || 0) + 1,
    [`${P}/last`]: qid,
  };
}

/** Fout antwoord: teller +1. Daarna mag answers/{sg}/{qid} gelezen worden. */
export function wrongUpdates(cid, sid, qid, priv) {
  return { [`${cls(cid)}/private/${sid}/wrong/${qid}`]: (priv?.wrong?.[qid] || 0) + 1 };
}

/**
 * Aanval.  pubAtt = public-node aanvaller, privAtt = private-node aanvaller.
 * Geeft { updates, bid }.
 */
export function attackUpdates({ cid, att, def, unit, week, pubAtt, privAtt, bid = newId('b', 12) }) {
  const C = cls(cid);
  return {
    bid,
    updates: {
      [`${C}/battles/${bid}`]: { att, def, ts: TS, week, status: 'open', rev: pubAtt?.revenge === true },
      [`${C}/hidden/${bid}`]: unit,
      [`${C}/private/${att}/attacks`]: (privAtt?.attacks || 0) + 1,
      [`${C}/private/${att}/hist/${def}`]: true,
      [`${C}/public/${att}/revenge`]: false,
    },
  };
}

/** Stap 1 van de verdediger: soldaat vastleggen. */
export function defendUpdates(cid, bid, defUnit) {
  const B = `${cls(cid)}/battles/${bid}`;
  return { [`${B}/status`]: 'defended', [`${B}/defUnit`]: defUnit };
}

/**
 * Stap 2 (aanvaller óf verdediger): uitslag + buit vastleggen.
 * attUnit = hidden/{bid} (leesbaar na de verdediging), defLand = huidig land verdediger.
 */
export function resolveUpdates(cid, bid, battle, attUnit, defLand, defLost = 0) {
  const B = `${cls(cid)}/battles/${bid}`;
  const result = battleResult(attUnit, battle.defUnit);
  const u = { [`${B}/status`]: 'done', [`${B}/result`]: result };
  if (result === 'att') {
    const n = lootSize(defLand, battle.rev === true);
    u[`${B}/n`] = n; u[`${B}/left`] = n; u[`${B}/fr`] = 0;
    // telt mee voor het schild van de verdediger
    u[`${cls(cid)}/public/${battle.def}/lost`] = (defLost || 0) + 1;
    u[`${cls(cid)}/public/${battle.def}/lb`] = bid;
  }
  return { updates: u, result };
}

/**
 * Eén buit-hex kiezen. free = true als de hex niet aansluit (kost een vrije keuze).
 */
export function lootStepUpdates(cid, bid, battle, hex, pubAtt, pubDef, free) {
  const C = cls(cid);
  if (free && (battle.fr || 0) >= MAX_FREE_PICKS) throw new Error('Geen vrije keuzes meer');
  const B = `${C}/battles/${bid}`;
  const u = {
    [`${C}/map/${hex}`]: { o: battle.att, via: bid },
    [`${B}/left`]: battle.left - 1,
    [`${B}/last`]: hex,
    [`${C}/public/${battle.att}/land`]: (pubAtt?.land || 0) + 1,
    [`${C}/public/${battle.att}/lp`]: bid,
    [`${C}/public/${battle.def}/land`]: (pubDef?.land || 0) - 1,
    [`${C}/public/${battle.def}/lp`]: bid,
  };
  if (free) u[`${B}/fr`] = (battle.fr || 0) + 1;
  return u;
}

/** Resterende buit opgeven (bijv. als de verliezer geen land meer heeft). */
export function forfeitUpdates(cid, bid) {
  const B = `${cls(cid)}/battles/${bid}`;
  return { [`${B}/left`]: 0, [`${B}/ff`]: true };
}

/** Land op 0 en nog niet gerespawnd → respawn starten. */
export function respawnStartUpdates(cid, sid) {
  const P = `${cls(cid)}/public/${sid}`;
  return { [`${P}/status`]: 'respawned', [`${P}/revenge`]: true, [`${P}/respawnLeft`]: RESPAWN_LAND };
}

/** Eén neutrale hex claimen tijdens respawn. */
export function respawnStepUpdates(cid, sid, hex, pub) {
  const C = cls(cid);
  const P = `${C}/public/${sid}`;
  return {
    [`${C}/map/${hex}`]: { o: sid, via: 'respawn' },
    [`${P}/respawnLeft`]: pub.respawnLeft - 1,
    [`${P}/land`]: (pub.land || 0) + 1,
    [`${P}/rh`]: hex,
  };
}

export { START_LAND };
