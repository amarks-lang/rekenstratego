// ════════════════════════════════════════════════════════════════════
//  Rekenstratego 3.0 — core.js
//  Pure spellogica: geen Firebase, geen DOM. Draait in de browser
//  (ES-module) én in Node (voor de tests).
// ════════════════════════════════════════════════════════════════════

/* ─────────────── Spelconstanten ─────────────── */
export const START_LAND = 10;        // hexen per leerling bij de start
export const RESPAWN_LAND = 3;       // hexen bij respawn
export const REJOIN_LAND = 5;        // hexen voor uitgeschakelden bij een nieuwe week
export const LOOT_PCT = 0.25;        // buit bij winst
export const REVENGE_PCT = 0.5;      // buit bij winst in revenge mode
export const MAX_FREE_PICKS = 2;     // eerste keuze + één keer opnieuw beginnen
export const NEUTRAL_SHARE = 0.15;   // deel van de kaart dat neutraal blijft
export const MIN_QUESTIONS = 6;      // minder sommen geeft rare mijlpalen

export const UNITS = ['maarschalk', 'generaal', 'spion'];
export const UNIT_ICON = { maarschalk: '🎖️', generaal: '⚔️', spion: '🕵️' };
export const BEATS = { maarschalk: 'generaal', generaal: 'spion', spion: 'maarschalk' };

export const COLORS = [
  '#FF5D77', '#4F6BFF', '#14B87C', '#F7A312', '#9B5BFF', '#06B6D4',
  '#FB7C32', '#EC4FA8', '#84CC16', '#64748B', '#E11D48', '#2563EB',
  '#059669', '#CA8A04', '#7C3AED', '#0891B2', '#EA580C', '#DB2777',
  '#65A30D', '#475569', '#F43F5E', '#3B82F6', '#10B981', '#A855F7',
];

/* ─────────────── Id's, random, hashing ─────────────── */
const ALPHA = 'abcdefghijkmnopqrstuvwxyz23456789';
export function newId(prefix = '', len = 10) {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let s = prefix;
  for (const b of bytes) s += ALPHA[b % ALPHA.length];
  return s;
}

/** Klascode van 4 cijfers (1000–9999). */
export function newClassCode(rng = Math.random) {
  return String(1000 + Math.floor(rng() * 9000));
}

/** Deterministische RNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function randInt(rng, min, max) { return min + Math.floor(rng() * (max - min + 1)); }
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export async function sha256(str) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/** Pin-hash, gezouten met klas en leerling. */
export function pinHash(cid, sid, pin) { return sha256(`${cid}|${sid}|${pin}`); }
export function isValidPin(pin) { return /^\d{4}$/.test(String(pin)); }

/* ─────────────── Antwoorden ─────────────── */
/**
 * Maakt van een antwoord een vaste vorm, zodat "84", " 84 ", "084" en "84,0"
 * allemaal "84" worden. Wordt gebruikt bij het opslaan én bij het nakijken,
 * omdat de database-rules een exacte string-vergelijking doen.
 */
export function canonAnswer(v) {
  let s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(/,/g, '.');
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) s = String(n);
  }
  return s;
}
export function sameAnswer(a, b) { return canonAnswer(a) === canonAnswer(b); }

/* ─────────────── Munten ─────────────── */
export function milestones(total) {
  return [Math.ceil(total / 3), Math.ceil(total * 2 / 3), total];
}
export function coinsEarned(solved, total) {
  return milestones(total).filter(m => solved >= m).length;
}
/** Munten die nu te besteden zijn. */
export function coinsAvailable(priv, total) {
  const n = priv?.n || 0, bonus = priv?.bonus || 0, attacks = priv?.attacks || 0;
  return Math.max(0, coinsEarned(n, total) + bonus - attacks);
}

/* ─────────────── Gevecht ─────────────── */
export function battleResult(attUnit, defUnit) {
  if (attUnit === defUnit) return 'draw';
  return BEATS[attUnit] === defUnit ? 'att' : 'def';
}
/** Aantal hexen buit: max(1, floor(land × 25%)), of 50% bij revenge. */
export function lootSize(defLand, revenge) {
  return Math.max(1, Math.floor(defLand * (revenge ? REVENGE_PCT : LOOT_PCT)));
}

/* ─────────────── Hex-grid ───────────────
   Flat-top hexen, "odd-q" offset: oneven kolommen zakken een halve hex.
   Id = "r_c". Intern rekenen we met cube-coördinaten.            */
export const hexId = (r, c) => `${r}_${c}`;
export function parseHex(id) { const [r, c] = id.split('_').map(Number); return { r, c }; }

function toCube(r, c) { const x = c, z = r - (c - (c & 1)) / 2; return { x, y: -x - z, z }; }
function fromCube(x, z) { return { r: z + (x - (x & 1)) / 2, c: x }; }
const CUBE_DIRS = [[1, -1, 0], [1, 0, -1], [0, 1, -1], [-1, 1, 0], [-1, 0, 1], [0, -1, 1]];

/** Alle 6 buurposities (ook buiten de kaart); gebruik `neighbors` voor binnen de kaart. */
function rawNeighbors(r, c) {
  const { x, z } = toCube(r, c);
  return CUBE_DIRS.map(([dx, , dz]) => fromCube(x + dx, z + dz));
}
export function inBounds(r, c, W, H) { return r >= 0 && r < H && c >= 0 && c < W; }
export function neighbors(id, W, H) {
  const { r, c } = parseHex(id);
  return rawNeighbors(r, c).filter(p => inBounds(p.r, p.c, W, H)).map(p => hexId(p.r, p.c));
}
export function hexDistance(a, b) {
  const pa = parseHex(a), pb = parseHex(b);
  const A = toCube(pa.r, pa.c), B = toCube(pb.r, pb.c);
  return Math.max(Math.abs(A.x - B.x), Math.abs(A.y - B.y), Math.abs(A.z - B.z));
}
export function allHexes(W, H) {
  const out = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) out.push(hexId(r, c));
  return out;
}
/**
 * Vaste buurlijst voor de database: altijd 6 plekken, 'x' = geen buur.
 * De security rules gebruiken dit om te checken of een gekozen hex aansluit.
 */
export function buildAdjacency(W, H) {
  const adj = {};
  for (const id of allHexes(W, H)) {
    const { r, c } = parseHex(id);
    const list = rawNeighbors(r, c).map(p => inBounds(p.r, p.c, W, H) ? hexId(p.r, p.c) : 'x');
    adj[id] = Object.fromEntries(list.map((v, i) => [String(i), v]));
  }
  return adj;
}
/** Pixelpositie van het midden van een hex (flat-top), voor het tekenen. */
export function hexCenter(id, size) {
  const { r, c } = parseHex(id);
  return { x: size + c * size * 1.5, y: size * Math.sqrt(3) * (r + 0.5 * (c & 1)) + size * Math.sqrt(3) / 2 };
}

/* ─────────────── Kaart ─────────────── */
/** Kaartformaat voor n leerlingen: ±15% neutraal, verhouding past op een scherm. */
export function mapSizeFor(n) {
  const total = Math.ceil(Math.max(n, 2) * START_LAND / (1 - NEUTRAL_SHARE));
  const H = Math.max(6, Math.ceil(Math.sqrt(total / 1.85)));
  const W = Math.max(8, Math.ceil(total / H));
  return { W, H };
}
/** owner-map {hexId: sid} uit de database-vorm {hexId: {o, via}}. */
export function ownersOf(map) {
  const out = {};
  for (const [id, v] of Object.entries(map || {})) if (v && v.o) out[id] = v.o;
  return out;
}
export function landCounts(owners) {
  const out = {};
  for (const sid of Object.values(owners)) out[sid] = (out[sid] || 0) + 1;
  return out;
}

/**
 * Startkaart: leerlingen verspreid geplaatst (farthest-point sampling),
 * daarna om de beurt een compact gebied laten groeien tot START_LAND.
 * Geeft {hexId: sid}.
 */
export function generateMap(W, H, sids, rng = Math.random, land = START_LAND) {
  // Groeien kan iemand insluiten; probeer dan opnieuw en houd de beste poging.
  let best = null, bestShort = Infinity;
  for (let attempt = 0; attempt < 40; attempt++) {
    const owners = tryGenerateMap(W, H, sids, rng, land);
    const counts = landCounts(owners);
    const short = sids.reduce((s, sid) => s + Math.max(0, land - (counts[sid] || 0)), 0);
    if (short === 0) return owners;
    if (short < bestShort) { best = owners; bestShort = short; }
  }
  return best;
}

function tryGenerateMap(W, H, sids, rng, land) {
  const cells = allHexes(W, H);
  const owners = {};
  const order = shuffle(sids, rng);
  // Startplekken: niet op de rand als het kan, en zo ver mogelijk van elkaar
  const inner = cells.filter(id => { const { r, c } = parseHex(id); return r > 0 && c > 0 && r < H - 1 && c < W - 1; });
  const pool = inner.length >= order.length ? inner : cells;
  const starts = [];
  for (let i = 0; i < order.length; i++) {
    let best = null, bestD = -1;
    for (const id of shuffle(pool, rng)) {
      if (starts.includes(id)) continue;
      const d = starts.length ? Math.min(...starts.map(s => hexDistance(s, id))) : 0;
      if (d > bestD) { bestD = d; best = id; }
    }
    starts.push(best);
    owners[best] = order[i];
  }
  // Groeien, round-robin, met voorkeur voor compacte vormen
  const have = Object.fromEntries(order.map(s => [s, 1]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const sid of order) {
      if (have[sid] >= land) continue;
      const frontier = new Map();
      for (const [id, o] of Object.entries(owners)) {
        if (o !== sid) continue;
        for (const nb of neighbors(id, W, H)) {
          if (owners[nb]) continue;
          const own = neighbors(nb, W, H).filter(x => owners[x] === sid).length;
          const foreign = neighbors(nb, W, H).filter(x => owners[x] && owners[x] !== sid).length;
          frontier.set(nb, own * 2 - foreign + rng() * 0.5);
        }
      }
      if (!frontier.size) continue;
      const pick = [...frontier.entries()].sort((a, b) => b[1] - a[1])[0][0];
      owners[pick] = sid; have[sid]++; grew = true;
    }
  }
  return owners;
}

/**
 * Zoekt een samenhangend cluster van `size` neutrale hexen, zo ver mogelijk
 * van anderen (voor respawn en terugkeer na uitschakeling).
 */
export function findNeutralCluster(owners, W, H, size, rng = Math.random) {
  const neutral = allHexes(W, H).filter(id => !owners[id]);
  if (!neutral.length) return [];
  const taken = Object.keys(owners);
  const score = id => {
    const room = neighbors(id, W, H).filter(x => !owners[x]).length;
    const dist = taken.length ? Math.min(...taken.map(t => hexDistance(t, id))) : 0;
    return room * 2 + Math.min(dist, 4) + rng() * 0.5;
  };
  const seed = neutral.map(id => [id, score(id)]).sort((a, b) => b[1] - a[1])[0][0];
  const cluster = [seed];
  while (cluster.length < size) {
    const cand = new Set();
    for (const id of cluster) for (const nb of neighbors(id, W, H)) if (!owners[nb] && !cluster.includes(nb)) cand.add(nb);
    if (!cand.size) break;
    const next = [...cand].map(id => [id, neighbors(id, W, H).filter(x => cluster.includes(x)).length + rng() * 0.5])
      .sort((a, b) => b[1] - a[1])[0][0];
    cluster.push(next);
  }
  return cluster;
}

/**
 * Welke hexen mag de winnaar nu kiezen?
 * - adjacent: hexen van de verliezer die aan het land van de winnaar grenzen
 * - free:     alle hexen van de verliezer (vrije keuze), alleen als dat mag:
 *             bij de eerste keuze, of als er niets aansluit — en zolang fr < MAX_FREE_PICKS
 */
export function lootOptions(owners, W, H, battle) {
  const { att, def } = battle;
  const defHexes = Object.keys(owners).filter(id => owners[id] === def);
  const adjacent = defHexes.filter(id => neighbors(id, W, H).some(nb => owners[nb] === att));
  const first = battle.left === battle.n;
  const canFree = (battle.fr || 0) < MAX_FREE_PICKS && (first || adjacent.length === 0);
  return { adjacent, free: canFree ? defHexes : [], stuck: !adjacent.length && !canFree };
}

/* ─────────────── Sommen-recepten ───────────────
   Een recept = lijst onderdelen, elk met een type en een aantal:
   { parts: [ {type:'tafels', count:15, tafels:[6,7,8]},
              {type:'keerBovenTien', count:10, min:11, max:30, fmin:2, fmax:9} ] }  */
export const RECIPE_TYPES = {
  tafels:        { label: 'Tafels (keersommen)', defaults: { count: 20, tafels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } },
  deel:          { label: 'Deelsommen (tafels)', defaults: { count: 15, tafels: [2, 3, 4, 5, 6, 7, 8, 9] } },
  keerBovenTien: { label: 'Keersommen boven het tiental (14 × 6)', defaults: { count: 15, min: 11, max: 30, fmin: 2, fmax: 9 } },
  plus:          { label: 'Plussommen', defaults: { count: 15, max: 100, overschrijding: 'mix' } },
  min:           { label: 'Minsommen', defaults: { count: 15, max: 100, overschrijding: 'mix' } },
};

function digits(n) { return String(n).split('').reverse().map(Number); }
/** Is er een tiental-/honderdtaloverschrijding bij a + b? */
export function hasCarry(a, b) {
  const da = digits(a), db = digits(b);
  for (let i = 0; i < Math.max(da.length, db.length); i++) if ((da[i] || 0) + (db[i] || 0) >= 10) return true;
  return false;
}
/** Moet je lenen bij a − b? */
export function hasBorrow(a, b) {
  const da = digits(a), db = digits(b);
  for (let i = 0; i < db.length; i++) if ((da[i] || 0) < db[i]) return true;
  return false;
}
function overOk(mode, has) { return mode === 'met' ? has : mode === 'zonder' ? !has : true; }

const GEN = {
  tafels(p, rng) {
    const t = p.tafels[randInt(rng, 0, p.tafels.length - 1)], b = randInt(rng, 1, 10);
    return { q: `${b} × ${t}`, a: String(b * t) };
  },
  deel(p, rng) {
    const t = p.tafels[randInt(rng, 0, p.tafels.length - 1)], b = randInt(rng, 1, 10);
    return { q: `${b * t} : ${t}`, a: String(b) };
  },
  keerBovenTien(p, rng) {
    const a = randInt(rng, p.min, p.max), b = randInt(rng, p.fmin, p.fmax);
    return { q: `${a} × ${b}`, a: String(a * b) };
  },
  plus(p, rng) {
    for (let i = 0; i < 200; i++) {
      const a = randInt(rng, 2, p.max - 2), b = randInt(rng, 2, p.max - a);
      if (overOk(p.overschrijding, hasCarry(a, b))) return { q: `${a} + ${b}`, a: String(a + b) };
    }
    return null;
  },
  min(p, rng) {
    for (let i = 0; i < 200; i++) {
      const a = randInt(rng, 4, p.max), b = randInt(rng, 2, a - 1);
      if (overOk(p.overschrijding, hasBorrow(a, b))) return { q: `${a} − ${b}`, a: String(a - b) };
    }
    return null;
  },
};

/** Genereert een unieke, geschudde sommenlijst [{q, a}] uit een recept. */
export function generateQuestions(recipe, rng = Math.random) {
  const out = [], seen = new Set();
  for (const part of recipe.parts || []) {
    const gen = GEN[part.type];
    if (!gen) throw new Error('Onbekend somtype: ' + part.type);
    const p = { ...RECIPE_TYPES[part.type].defaults, ...part };
    let made = 0;
    for (let tries = 0; made < p.count && tries < p.count * 60; tries++) {
      const s = gen(p, rng);
      if (!s || seen.has(s.q)) continue;
      seen.add(s.q); out.push(s); made++;
    }
  }
  return shuffle(out, rng);
}

/** Kant-en-klare voorbeeldrecepten voor de leerkrachtpagina. */
export const PRESETS = {
  tafels: { name: 'Tafels 1–10', recipe: { parts: [{ type: 'tafels', count: 24, tafels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }] } },
  plus100: { name: 'Plus en min tot 100', recipe: { parts: [{ type: 'plus', count: 12, max: 100 }, { type: 'min', count: 12, max: 100 }] } },
  boventien: { name: 'Keersommen boven het tiental', recipe: { parts: [{ type: 'keerBovenTien', count: 24, min: 11, max: 30, fmin: 2, fmax: 9 }] } },
};
