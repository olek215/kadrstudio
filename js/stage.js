// Podgląd: dopasowanie płótna, ramka zaznaczenia, przesuwanie / skalowanie / obracanie myszą i palcami.
import { $, h, clamp, fmtTime, setIcon } from './util.js';
import { propAt, setPropAt, projectDuration } from './model.js';

const RAD = Math.PI / 180;

export class Stage {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.viewport = $('#viewport');
    this.wrap = $('#canvas-wrap');
    this.canvas = $('#preview');
    this.overlay = $('#overlay');
    this.octx = this.overlay.getContext('2d');
    this.quality = localStorage.getItem('kadr.quality') || 'auto';
    this.safe = localStorage.getItem('kadr.safe') === '1';
    this.grid = localStorage.getItem('kadr.grid') === '1';
    this.drag = null;
    this.guides = { x: false, y: false };
    this.pointers = new Map();
    this.cssW = 1; this.cssH = 1;

    $('#preview-quality').value = this.quality;
    $('#preview-quality').addEventListener('change', (e) => { this.quality = e.target.value; localStorage.setItem('kadr.quality', this.quality); this.layout(true); });
    const tg = (id, key) => {
      const b = $(id);
      b.classList.toggle('on', this[key]);
      b.addEventListener('click', () => { this[key] = !this[key]; b.classList.toggle('on', this[key]); localStorage.setItem('kadr.' + key, this[key] ? '1' : '0'); this.drawOverlay(); });
    };
    tg('#btn-safe', 'safe');
    tg('#btn-grid', 'grid');
    $('#btn-fullscreen').addEventListener('click', () => {
      const st = this.viewport.closest('.stage');
      if (document.fullscreenElement) document.exitFullscreen(); else st.requestFullscreen && st.requestFullscreen().catch(() => {});
    });
    document.addEventListener('fullscreenchange', () => setTimeout(() => this.layout(true), 60));
    $('#btn-snapshot').addEventListener('click', () => app.snapshot());

    // transport
    $('#btn-play').addEventListener('click', () => app.player.toggle());
    $('#btn-start').addEventListener('click', () => app.player.seek(0));
    $('#btn-end').addEventListener('click', () => app.player.seek(projectDuration(this.store.project)));
    $('#btn-prev').addEventListener('click', () => app.stepFrames(-1));
    $('#btn-next').addEventListener('click', () => app.stepFrames(1));
    const loopBtn = $('#btn-loop');
    loopBtn.addEventListener('click', () => { app.player.loop = !app.player.loop; loopBtn.classList.toggle('on', app.player.loop); });
    this.store.on('time', (t) => { $('#tc-now').textContent = fmtTime(t); });
    this.store.on('change', () => {
      const P = this.store.project;
      if (!P) return;
      $('#tc-dur').textContent = fmtTime(projectDuration(P));
      $('#empty-hint').classList.toggle('hidden', P.clips.length > 0);
      $('#fmt-chip').textContent = `${P.format} • ${P.width}×${P.height} • ${P.fps} kl/s`;
      if (this._dims !== `${P.width}x${P.height}`) this.layout(true);
    });

    new ResizeObserver(() => this.layout()).observe(this.viewport);
    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.onMove(e));
    this.overlay.addEventListener('pointerup', (e) => this.onUp(e));
    this.overlay.addEventListener('pointercancel', (e) => this.onUp(e));
    this.overlay.addEventListener('dblclick', () => { const c = this.store.selected; if (c && c.kind === 'text') app.inspector.focusText(); });
    this.overlay.addEventListener('wheel', (e) => {
      const c = this.store.selected;
      if (!c || c.kind === 'audio') return;
      e.preventDefault();
      const lt = this.lt(c);
      setPropAt(c, 'scale', clamp(propAt(c, 'scale', lt) * Math.exp(-e.deltaY * 0.0012), 0.05, 20), lt, this.tol());
      app.changed();
      clearTimeout(this._wt);
      this._wt = setTimeout(() => app.commit(), 400);
    }, { passive: false });
  }

  setPlaying(p) { setIcon($('#btn-play'), p ? 'pause' : 'play'); }
  lt(c) { return clamp(this.store.time - c.start, 0, c.duration); }
  tol() { return 0.5 / (this.store.project.fps || 30); }

  layout(force) {
    const P = this.store.project;
    if (!P) return;
    const vw = Math.max(50, this.viewport.clientWidth - 24), vh = Math.max(50, this.viewport.clientHeight - 24);
    const ar = P.width / P.height;
    let cw = vw, ch = vw / ar;
    if (ch > vh) { ch = vh; cw = vh * ar; }
    cw = Math.floor(cw); ch = Math.floor(ch);
    const key = `${cw}x${ch}|${P.width}x${P.height}|${this.quality}`;
    if (!force && key === this._key) return;
    this._key = key;
    this._dims = `${P.width}x${P.height}`;
    this.cssW = cw; this.cssH = ch;
    this.wrap.style.width = cw + 'px';
    this.wrap.style.height = ch + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let pw;
    if (this.quality === 'full') pw = P.width;
    else if (this.quality === 'low') pw = Math.min(P.width, cw * dpr * 0.5);
    else pw = Math.min(P.width, cw * dpr);
    this.app.renderer.resize(P, pw, pw / ar);
    this.overlay.width = Math.round(cw * dpr);
    this.overlay.height = Math.round(ch * dpr);
    this.app.player.dirty = true;
  }

  // współrzędne projektu z pozycji wskaźnika
  toP(e) {
    const r = this.overlay.getBoundingClientRect();
    const P = this.store.project;
    return { x: ((e.clientX - r.left) / r.width) * P.width, y: ((e.clientY - r.top) / r.height) * P.height };
  }
  boxCorners(b) {
    const c = Math.cos(b.rot * RAD), s = Math.sin(b.rot * RAD);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const x = (sx * b.w) / 2, y = (sy * b.h) / 2;
      return { x: b.cx + x * c - y * s, y: b.cy + x * s + y * c };
    });
  }
  inBox(b, p) {
    const c = Math.cos(-b.rot * RAD), s = Math.sin(-b.rot * RAD);
    const dx = p.x - b.cx, dy = p.y - b.cy;
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
  }
  handleAt(b, p) {
    const P = this.store.project;
    const k = P.width / this.cssW;
    const r = 14 * k;
    const cs = this.boxCorners(b);
    for (const q of cs) if (Math.hypot(q.x - p.x, q.y - p.y) < r) return 'scale';
    const rh = this.rotHandle(b);
    if (Math.hypot(rh.x - p.x, rh.y - p.y) < r) return 'rotate';
    return null;
  }
  rotHandle(b) {
    const P = this.store.project;
    const k = P.width / this.cssW;
    const d = b.h / 2 + 28 * k;
    return { x: b.cx + Math.sin(b.rot * RAD) * d, y: b.cy - Math.cos(b.rot * RAD) * d };
  }

  onDown(e) {
    const P = this.store.project;
    if (!P) return;
    this.overlay.setPointerCapture(e.pointerId);
    const p = this.toP(e);
    this.pointers.set(e.pointerId, p);
    const boxes = this.app.player.boxes || [];
    const sel = this.store.selected;
    if (this.pointers.size === 2 && sel && this.drag) {
      // gest dwoma palcami: skala + obrót
      const [a, b] = [...this.pointers.values()];
      const lt = this.lt(sel);
      this.drag = { mode: 'pinch', id: sel.id, d0: Math.hypot(a.x - b.x, a.y - b.y), a0: Math.atan2(b.y - a.y, b.x - a.x), s0: propAt(sel, 'scale', lt), r0: propAt(sel, 'rotation', lt) };
      return;
    }
    if (sel) {
      const b = boxes.find((x) => x.id === sel.id);
      if (b) {
        const hnd = this.handleAt(b, p);
        if (hnd) { this.beginDrag(hnd, sel, b, p); return; }
      }
    }
    // klik w środek zaznaczonego ma pierwszeństwo, potem najwyższy element
    let hit = sel && boxes.find((x) => x.id === sel.id && this.inBox(x, p));
    if (!hit) for (let i = boxes.length - 1; i >= 0; i--) if (this.inBox(boxes[i], p)) { hit = boxes[i]; break; }
    if (!hit) { this.store.select(null); this.drawOverlay(); return; }
    this.store.select(hit.id);
    const c = this.store.clip(hit.id);
    this.beginDrag('move', c, hit, p);
  }
  beginDrag(mode, c, b, p) {
    const lt = this.lt(c);
    if (this.app.player.playing) this.app.player.pause();
    this.drag = { mode, id: c.id, p0: p, cx: b.cx, cy: b.cy, x0: propAt(c, 'x', lt), y0: propAt(c, 'y', lt), s0: propAt(c, 'scale', lt), r0: propAt(c, 'rotation', lt), d0: Math.hypot(p.x - b.cx, p.y - b.cy) || 1, a0: Math.atan2(p.y - b.cy, p.x - b.cx), moved: false };
  }
  onMove(e) {
    const P = this.store.project;
    if (!P) return;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, this.toP(e));
    const d = this.drag;
    if (!d) { this.hover(e); return; }
    const c = this.store.clip(d.id);
    if (!c) return;
    const p = this.toP(e);
    const lt = this.lt(c);
    const tol = this.tol();
    d.moved = true;
    this.guides = { x: false, y: false };
    if (d.mode === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      setPropAt(c, 'scale', clamp(d.s0 * (dist / (d.d0 || 1)), 0.05, 20), lt, tol);
      setPropAt(c, 'rotation', d.r0 + (ang - d.a0) / RAD, lt, tol);
    } else if (d.mode === 'move') {
      let nx = d.x0 + (p.x - d.p0.x) / P.width, ny = d.y0 + (p.y - d.p0.y) / P.height;
      if (!e.altKey) {
        if (Math.abs(nx) < 0.012) { nx = 0; this.guides.x = true; }
        if (Math.abs(ny) < 0.012) { ny = 0; this.guides.y = true; }
      }
      setPropAt(c, 'x', nx, lt, tol);
      setPropAt(c, 'y', ny, lt, tol);
    } else if (d.mode === 'scale') {
      const dist = Math.hypot(p.x - d.cx, p.y - d.cy);
      setPropAt(c, 'scale', clamp(d.s0 * (dist / d.d0), 0.05, 20), lt, tol);
    } else if (d.mode === 'rotate') {
      let r = d.r0 + (Math.atan2(p.y - d.cy, p.x - d.cx) - d.a0) / RAD;
      if (!e.altKey) for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(r - s) < 4) r = s;
      setPropAt(c, 'rotation', r, lt, tol);
    }
    this.app.changed();
  }
  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.drag && this.drag.mode === 'pinch' && this.pointers.size === 1) return;
    const d = this.drag;
    this.drag = null;
    this.guides = { x: false, y: false };
    if (d && d.moved) this.app.commit();
    this.drawOverlay();
  }
  hover(e) {
    const sel = this.store.selected;
    let cur = 'default';
    if (sel) {
      const b = (this.app.player.boxes || []).find((x) => x.id === sel.id);
      if (b) {
        const p = this.toP(e);
        const hnd = this.handleAt(b, p);
        cur = hnd === 'scale' ? 'nwse-resize' : hnd === 'rotate' ? 'grab' : this.inBox(b, p) ? 'move' : 'default';
      }
    }
    this.overlay.style.cursor = cur;
  }

  drawOverlay() {
    const P = this.store.project;
    const g = this.octx;
    const W = this.overlay.width, H = this.overlay.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!P) return;
    const k = W / P.width;
    const dpr = W / this.cssW;
    if (this.grid) {
      g.strokeStyle = 'rgba(255,255,255,.28)';
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 1; i < 3; i++) { g.moveTo((W * i) / 3, 0); g.lineTo((W * i) / 3, H); g.moveTo(0, (H * i) / 3); g.lineTo(W, (H * i) / 3); }
      g.stroke();
    }
    if (this.safe) {
      g.fillStyle = 'rgba(255, 61, 127, .14)';
      g.strokeStyle = 'rgba(255, 61, 127, .5)';
      g.setLineDash([5 * dpr, 4 * dpr]);
      const vertical = P.height > P.width;
      const zones = vertical ? [[0, 0, 1, 0.1], [0, 0.78, 1, 0.22], [0.84, 0.35, 0.16, 0.43]] : [[0, 0, 1, 0.08], [0, 0.88, 1, 0.12]];
      for (const [x, y, w, h2] of zones) { g.fillRect(x * W, y * H, w * W, h2 * H); g.strokeRect(x * W + 0.5, y * H + 0.5, w * W, h2 * H); }
      g.setLineDash([]);
      g.fillStyle = 'rgba(255,255,255,.75)';
      g.font = `600 ${11 * dpr}px Inter, sans-serif`;
      g.fillText('strefa przycisków aplikacji', 8 * dpr, (vertical ? 0.78 : 0.88) * H + 16 * dpr);
    }
    if (this.guides.x) { g.fillStyle = '#facc15'; g.fillRect(W / 2 - dpr / 2, 0, dpr, H); }
    if (this.guides.y) { g.fillStyle = '#facc15'; g.fillRect(0, H / 2 - dpr / 2, W, dpr); }
    const sel = this.store.selected;
    if (!sel) return;
    const b = (this.app.player.boxes || []).find((x) => x.id === sel.id);
    if (!b) return;
    const cs = this.boxCorners(b).map((q) => ({ x: q.x * k, y: q.y * k }));
    g.lineWidth = 1.5 * dpr;
    g.strokeStyle = '#a78bfa';
    g.shadowColor = 'rgba(0,0,0,.6)';
    g.shadowBlur = 4 * dpr;
    g.beginPath();
    cs.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.closePath();
    g.stroke();
    g.shadowBlur = 0;
    const rh = this.rotHandle(b);
    const top = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 };
    g.beginPath(); g.moveTo(top.x, top.y); g.lineTo(rh.x * k, rh.y * k); g.stroke();
    g.fillStyle = '#fff';
    for (const q of cs) { g.beginPath(); g.rect(q.x - 5 * dpr, q.y - 5 * dpr, 10 * dpr, 10 * dpr); g.fill(); g.stroke(); }
    g.beginPath(); g.arc(rh.x * k, rh.y * k, 6 * dpr, 0, Math.PI * 2); g.fill(); g.stroke();
  }
}
