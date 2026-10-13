// ════════════════════════════════════════════════════════════════════
//  Rekenstratego 3.0 — mapview.js
//  Tekent de hexkaart op een <canvas>. Gedeeld door leerkracht en leerling.
// ════════════════════════════════════════════════════════════════════
import { allHexes, neighbors, parseHex, isShielded } from './core.js';

const NEUTRAL = '#E7ECF6';
const SQ3 = Math.sqrt(3);

export class MapView {
  /** canvas: HTMLCanvasElement; W, H: kaartformaat in hexen */
  constructor(canvas, W, H) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.W = W; this.H = H;
    this.state = { owners: {}, roster: {}, pub: {}, me: null, highlight: null, flash: null };
    this.onClick = null;
    this._centers = {};
    canvas.addEventListener('click', e => this._click(e));
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
    this.resize();
  }

  destroy() { this._ro.disconnect(); if (this._anim) cancelAnimationFrame(this._anim); this._anim = null; this.state.highlight = null; }

  resize() {
    const cssW = this.cv.clientWidth || 600;
    // flat-top: breedte = size * (1.5*W + 0.5), hoogte = size * √3 * (H + 0.5)
    const size = cssW / (1.5 * this.W + 0.5);
    const cssH = size * SQ3 * (this.H + 0.5);
    const dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.round(cssW * dpr); this.cv.height = Math.round(cssH * dpr);
    this.cv.style.height = cssH + 'px';
    this.size = size; this.dpr = dpr;
    this._centers = {}; this._edgeCache = null;
    for (const id of allHexes(this.W, this.H)) {
      const { r, c } = parseHex(id);
      this._centers[id] = { x: size + c * size * 1.5, y: size * SQ3 * (r + 0.5 * (c & 1)) + size * SQ3 / 2 };
    }
    this.draw();
  }

  /**
   * owners: {hexId: sid}, roster: {sid: {name,color}}, pub: {sid: {revenge,...}}
   * me: sid (krijgt een donkere rand), highlight: {ids: Set, color} (klikbare hexen)
   */
  render(patch) { Object.assign(this.state, patch); this.draw(); }

  _corners(id, shrink = 0) {
    const { x, y } = this._centers[id], s = this.size - shrink;
    return [0, 1, 2, 3, 4, 5].map(i => ({ x: x + s * Math.cos(Math.PI / 3 * i), y: y + s * Math.sin(Math.PI / 3 * i) }));
  }
  _path(pts) {
    const ctx = this.ctx; ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
  }

  draw() {
    const { ctx, size } = this;
    if (!size) return;
    const { owners, roster, pub, me, highlight, flash } = this.state;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);

    // 1. vlakken
    for (const id of Object.keys(this._centers)) {
      const o = owners[id];
      this._path(this._corners(id, 0.6));
      ctx.fillStyle = o ? (roster[o]?.color || '#999') : NEUTRAL;
      ctx.globalAlpha = o ? 0.9 : 1;
      ctx.fill(); ctx.globalAlpha = 1;
    }

    // 2. grenzen tussen gebieden (dikker) — zo zie je fronten en buitenposten
    ctx.lineCap = 'round';
    for (const id of Object.keys(this._centers)) {
      const o = owners[id];
      if (!o) continue;
      const pts = this._corners(id, 0.6);
      for (const nb of this._edgeNeighbors(id)) {
        if (nb.id && owners[nb.id] === o) continue;
        const a = pts[nb.edge], b = pts[(nb.edge + 1) % 6];
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        const mine = o === me;
        ctx.strokeStyle = pub[o]?.revenge ? '#FF4D6B' : mine ? '#1A2142' : 'rgba(26,33,66,0.55)';
        ctx.lineWidth = mine || pub[o]?.revenge ? Math.max(2.5, size * 0.14) : Math.max(1.5, size * 0.08);
        ctx.stroke();
      }
    }

    // 3. klikbare hexen
    if (highlight?.ids?.size) {
      const t = (performance.now() / 600) % (Math.PI * 2);
      for (const id of highlight.ids) {
        if (!this._centers[id]) continue;
        this._path(this._corners(id, size * 0.18));
        ctx.lineWidth = Math.max(2, size * 0.12);
        ctx.strokeStyle = highlight.color || '#F7A312';
        ctx.globalAlpha = 0.65 + 0.35 * Math.sin(t);
        ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    if (flash && this._centers[flash]) {
      this._path(this._corners(flash, size * 0.1));
      ctx.lineWidth = Math.max(3, size * 0.16); ctx.strokeStyle = '#FFFFFF'; ctx.stroke();
    }

    // 4. namen op het grootste aaneengesloten stuk van elk gebied
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const fontPx = Math.max(9, Math.min(14, size * 0.62));
    ctx.font = `800 ${fontPx}px "Instrument Sans", system-ui, sans-serif`;
    for (const [sid, cells] of Object.entries(this._regions(owners))) {
      const r = roster[sid]; if (!r) continue;
      const cx = cells.reduce((a, id) => a + this._centers[id].x, 0) / cells.length;
      const cy = cells.reduce((a, id) => a + this._centers[id].y, 0) / cells.length;
      let label = r.name.length > 10 ? r.name.slice(0, 9) + '…' : r.name;
      if (pub[sid]?.revenge) label += ' 🔥';
      if (isShielded(pub[sid])) label += ' 🛡️';
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(26,33,66,0.7)'; ctx.strokeText(label, cx, cy);
      ctx.fillStyle = '#fff'; ctx.fillText(label, cx, cy);
    }

    // knipperen alleen zolang er iets te kiezen is én de kaart zichtbaar is
    if (highlight?.ids?.size && !this._anim && this.cv.offsetParent !== null) {
      this._anim = requestAnimationFrame(() => { this._anim = null; this.draw(); });
    }
  }

  /** Per rand (0..5) de buurhex die erachter ligt (of null bij de kaartrand). */
  _edgeNeighbors(id) {
    if (!this._edgeCache) this._edgeCache = {};
    if (this._edgeCache[id]) return this._edgeCache[id];
    const c = this._centers[id], s = this.size;
    const out = [0, 1, 2, 3, 4, 5].map(e => {
      const a = Math.PI / 3 * e + Math.PI / 6; // midden van rand e
      const px = c.x + Math.cos(a) * s * SQ3, py = c.y + Math.sin(a) * s * SQ3;
      const nb = neighbors(id, this.W, this.H).find(n => Math.hypot(this._centers[n].x - px, this._centers[n].y - py) < s * 0.5);
      return { edge: e, id: nb || null };
    });
    return (this._edgeCache[id] = out);
  }

  /** {sid: [hexIds van het grootste samenhangende stuk]} */
  _regions(owners) {
    const seen = new Set(), best = {};
    for (const [id, o] of Object.entries(owners)) {
      if (seen.has(id)) continue;
      const comp = [], stack = [id]; seen.add(id);
      while (stack.length) {
        const cur = stack.pop(); comp.push(cur);
        for (const n of neighbors(cur, this.W, this.H)) if (owners[n] === o && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
      if (!best[o] || comp.length > best[o].length) best[o] = comp;
    }
    return best;
  }

  _click(e) {
    if (!this.onClick) return;
    const rect = this.cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bd = Infinity;
    for (const [id, p] of Object.entries(this._centers)) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = id; }
    }
    if (best && bd < this.size) this.onClick(best);
  }

  /** Midden van een hex in CSS-pixels (voor tests en tooltips). */
  centerOf(id) { return this._centers[id]; }
}
