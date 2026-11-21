// Silnik renderowania klatki: składa wszystkie ścieżki w jeden obraz.
// Ten sam kod rysuje podgląd i eksport, więc film wygląda tak jak w edytorze.
import { clamp, EASE, hexA, hexToRgb, mulberry32 } from './util.js';
import { propAt } from './model.js';
import { FILTERS } from './catalog.js';

const RAD = Math.PI / 180;

export function srcTime(c, t, m) {
  const s = (c.in || 0) + (t - c.start) * (c.speed || 1);
  const max = m && isFinite(m.duration) ? Math.max(0, m.duration - 0.04) : Infinity;
  return clamp(s, 0, max);
}
export function fadeK(c, lt) {
  let k = 1;
  if (c.fadeIn > 0) k = Math.min(k, lt / c.fadeIn);
  if (c.fadeOut > 0) k = Math.min(k, (c.duration - lt) / c.fadeOut);
  return clamp(k, 0, 1);
}
function motionOf(type, q, lt, amt) {
  const o = { s: 1, dx: 0, dy: 0, r: 0 };
  switch (type) {
    case 'zoomin': o.s = 1 + 0.18 * amt * q; break;
    case 'zoomout': o.s = 1 + 0.18 * amt * (1 - q); break;
    case 'panleft': o.s = 1 + 0.14 * amt; o.dx = (0.5 - q) * 0.12 * amt; break;
    case 'panright': o.s = 1 + 0.14 * amt; o.dx = (q - 0.5) * 0.12 * amt; break;
    case 'panup': o.s = 1 + 0.14 * amt; o.dy = (0.5 - q) * 0.12 * amt; break;
    case 'pandown': o.s = 1 + 0.14 * amt; o.dy = (q - 0.5) * 0.12 * amt; break;
    case 'pulse': o.s = 1 + 0.05 * amt * Math.pow(Math.max(0, Math.cos(lt * Math.PI * 2)), 8); break;
    case 'shake': o.s = 1 + 0.04 * amt; o.dx = 0.007 * amt * Math.sin(lt * 41); o.dy = 0.007 * amt * Math.sin(lt * 33 + 1); o.r = 0.7 * amt * Math.sin(lt * 27); break;
    default: break;
  }
  return o;
}
export function filterCss(f, blurPx) {
  if (!f) return '';
  const pre = FILTERS[f.preset] || FILTERS.none;
  let s = pre.css || '';
  if (f.brightness) s += ` brightness(${1 + f.brightness / 100})`;
  if (f.contrast) s += ` contrast(${1 + f.contrast / 100})`;
  if (f.saturation) s += ` saturate(${1 + f.saturation / 100})`;
  if (f.hue) s += ` hue-rotate(${f.hue}deg)`;
  if (f.blur && blurPx) s += ` blur(${f.blur * blurPx}px)`;
  return s.trim();
}
function lum(hex) { const [r, g, b] = hexToRgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

export class Renderer {
  constructor(canvas, { media, videoOf, exporting = false }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.layer = document.createElement('canvas');
    this.L = this.layer.getContext('2d');
    this.aux = document.createElement('canvas');
    this.A = this.aux.getContext('2d', { willReadFrequently: true });
    this.small = document.createElement('canvas');
    this.S = this.small.getContext('2d');
    this.mctx = document.createElement('canvas').getContext('2d');
    this.media = media;
    this.videoOf = videoOf;
    this.exporting = exporting;
    this.hasLS = 'letterSpacing' in this.ctx;
    this.layoutCache = new Map();
    this.s = 1; this.W = 1080; this.H = 1920; this.U = 1;
  }

  resize(P, cw, ch) {
    cw = Math.max(2, Math.round(cw));
    ch = Math.max(2, Math.round(ch));
    for (const c of [this.canvas, this.layer]) if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const sw = Math.max(8, Math.round(cw / 8)), sh = Math.max(8, Math.round(ch / 8));
    if (this.small.width !== sw || this.small.height !== sh) { this.small.width = sw; this.small.height = sh; }
    this.W = P.width; this.H = P.height;
    this.s = cw / P.width;
    this.U = Math.min(P.width, P.height) / 1080;
  }

  // Co jest widoczne w chwili t (od najniższej ścieżki do najwyższej).
  plan(P, t) {
    const by = new Map();
    for (const c of P.clips) {
      if (c.kind === 'audio') continue;
      let a = by.get(c.trackId);
      if (!a) by.set(c.trackId, (a = []));
      a.push(c);
    }
    const items = [];
    for (let i = P.tracks.length - 1; i >= 0; i--) {
      const tr = P.tracks[i];
      if (tr.kind === 'audio' || tr.kind === 'fx' || tr.hidden) continue;
      const list = by.get(tr.id);
      if (!list) continue;
      let cur = null;
      for (const c of list) if (t >= c.start - 1e-6 && t < c.start + c.duration - 1e-6 && (!cur || c.start > cur.start)) cur = c;
      if (!cur) continue;
      const ti = cur.transIn;
      let p = 1, prev = null;
      if (ti && ti.type && ti.type !== 'none' && ti.dur > 0 && t < cur.start + ti.dur) {
        p = clamp((t - cur.start) / ti.dur, 0, 1);
        for (const c of list) if (c !== cur && Math.abs(c.start + c.duration - cur.start) < 0.05) { prev = c; break; }
      }
      items.push({ tr, cur, prev, p, type: p < 1 ? ti.type : null });
    }
    return items;
  }

  videoNeeds(P, t) {
    const out = [];
    for (const it of this.plan(P, t)) {
      for (const c of [it.cur, it.prev]) {
        if (c && c.kind === 'video') out.push({ clip: c, src: srcTime(c, t, this.media.get(c.mediaId)) });
      }
    }
    return out;
  }

  render(P, t) {
    const ctx = this.ctx, cw = this.canvas.width, ch = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.fillStyle = P.background || '#000';
    ctx.fillRect(0, 0, cw, ch);
    this.W = P.width; this.H = P.height; this.U = Math.min(P.width, P.height) / 1080;
    this.cam = this.camera(P, t);
    const boxes = [];
    for (const it of this.plan(P, t)) {
      if (it.type) this.transition(it, t, boxes);
      else {
        const b = this.drawClip(it.cur, t, null);
        if (b) boxes.push(b);
      }
    }
    if (this.cam.flash > 0.003) this.flat('#ffffff', this.cam.flash);
    return boxes;
  }

  // Efekty kamery z klipów „Efekty” (zoom, obrót, trzęsienie…) – działają na główny obraz.
  camera(P, t) {
    const cam = { s: 1, r: 0, dx: 0, dy: 0, flash: 0 };
    const hidden = new Set(P.tracks.filter((tr) => tr.hidden).map((tr) => tr.id));
    for (const c of P.clips) {
      if (c.kind !== 'fx' || t < c.start || t >= c.start + c.duration || hidden.has(c.trackId)) continue;
      const u = clamp((t - c.start) / Math.max(0.05, c.duration), 0, 1);
      const a = c.amt == null ? 1 : c.amt;
      const bump = Math.sin(Math.PI * u);
      switch (c.fx) {
        case 'zoom': cam.s *= 1 + 0.2 * a * (u < 0.25 ? EASE.out(u / 0.25) : 1 - EASE.inOut((u - 0.25) / 0.75)); break;
        case 'zoomhold': cam.s *= 1 + 0.25 * a * (u < 0.12 ? EASE.out(u / 0.12) : u > 0.9 ? 1 - EASE.inOut((u - 0.9) / 0.1) : 1); break;
        case 'tilt': cam.r += 9 * a * bump * (c.dir || 1); cam.s *= 1 + 0.14 * a * bump; break;
        case 'spin': cam.r += 360 * EASE.inOut(u) * (c.dir || 1); cam.s *= 1 + 0.3 * bump; break;
        case 'shake': {
          const k = (1 - u) * a;
          cam.dx += 0.03 * k * this.W * Math.sin(u * 62);
          cam.dy += 0.025 * k * this.H * Math.sin(u * 47 + 1);
          cam.r += 2.5 * k * Math.sin(u * 35);
          cam.s *= 1 + 0.06 * k;
          break;
        }
        case 'pulse': cam.s *= 1 + 0.09 * a * bump; break;
        case 'flash': cam.flash = Math.max(cam.flash, Math.min(1, 0.85 * a) * Math.pow(1 - u, 2)); break;
        default: break;
      }
    }
    return cam;
  }

  drawClip(c, t, ov) {
    const info = c.kind === 'text' ? this.textLayer(c, t) : this.visualLayer(c, t);
    if (!info) return null;
    const cam = this.cam;
    if (c.trackId === 'main' && cam && (cam.s !== 1 || cam.r || cam.dx || cam.dy)) {
      ov = { ...(ov || {}), scale: ((ov && ov.scale) || 1) * cam.s, rot: ((ov && ov.rot) || 0) + cam.r, dx: ((ov && ov.dx) || 0) + cam.dx, dy: ((ov && ov.dy) || 0) + cam.dy };
    }
    this.composite(c, info, ov);
    return info.box;
  }

  _clearLayer() {
    const L = this.L;
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.globalAlpha = 1;
    L.globalCompositeOperation = 'source-over';
    L.filter = 'none';
    L.clearRect(0, 0, this.layer.width, this.layer.height);
  }

  // ------------------------------------------------------------ obraz / wideo
  visualLayer(c, t) {
    const m = this.media.get(c.mediaId);
    if (!m) return null;
    let img, sw, sh;
    if (c.kind === 'image') {
      img = m.img;
      if (!img) return null;
      sw = m.width; sh = m.height;
    } else {
      const v = this.videoOf(c);
      if (v && v.isFrame) { img = v.img; sw = v.w; sh = v.h; } else if (v && v.readyState >= 2 && v.videoWidth) {
        img = v; sw = v.videoWidth; sh = v.videoHeight;
        if (this.keepFrames) this.remember(c.id, v);
      } else {
        // w trakcie przewijania pokaż ostatnią klatkę zamiast czarnego ekranu
        const lf = this.lastFrames && this.lastFrames.get(c.id);
        if (!lf) return null;
        img = lf.c; sw = lf.w; sh = lf.h;
      }
    }
    if (c.chroma && c.chroma.on) img = this.keyed(img, sw, sh, c.chroma);

    const { W, H, s, U, L } = this;
    const cw = this.layer.width, ch = this.layer.height;
    const lt = t - c.start;
    this._clearLayer();
    const x = propAt(c, 'x', lt), y = propAt(c, 'y', lt), sc = propAt(c, 'scale', lt), rot = propAt(c, 'rotation', lt);
    const mo = motionOf(c.motion, clamp(lt / c.duration, 0, 1), lt, c.motionAmt == null ? 1 : c.motionAmt);
    let bw, bh;
    if (c.fit === 'fill') { bw = W; bh = H; } else {
      const k = c.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
      bw = sw * k; bh = sh * k;
    }
    if (c.bg === 'blur') this.blurBg(img, sw, sh);
    else if (c.bg === 'color') { L.fillStyle = c.bgColor || '#000'; L.fillRect(0, 0, cw, ch); }

    const fs = sc * mo.s;
    const cx = W / 2 + (x + mo.dx) * W, cy = H / 2 + (y + mo.dy) * H, rr = rot + mo.r;
    L.setTransform(s, 0, 0, s, 0, 0);
    L.translate(cx, cy);
    L.rotate(rr * RAD);
    L.scale(fs * (c.flipH ? -1 : 1), fs * (c.flipV ? -1 : 1));
    const f = c.filter || {};
    const pre = FILTERS[f.preset] || FILTERS.none;
    const css = filterCss(f, U * s);
    const r = c.radius > 0 ? (Math.min(bw, bh) / 2) * (c.radius / 100) : 0;
    L.save();
    if (r > 0) { L.beginPath(); L.roundRect(-bw / 2, -bh / 2, bw, bh, r); L.clip(); }
    if (css) L.filter = css;
    L.drawImage(img, -bw / 2, -bh / 2, bw, bh);
    L.filter = 'none';
    const tints = [];
    if (pre.tint) tints.push(pre.tint);
    if (f.temp) tints.push([f.temp > 0 ? '#ff8c1a' : '#1a8cff', (Math.abs(f.temp) / 100) * 0.28]);
    const vig = Math.min(1, (pre.vignette || 0) + (f.vignette || 0) / 100);
    if (tints.length || vig > 0) {
      L.globalCompositeOperation = 'source-atop';
      for (const [col, a] of tints) { L.globalAlpha = a; L.fillStyle = col; L.fillRect(-bw / 2, -bh / 2, bw, bh); }
      if (vig > 0) {
        const vw = Math.min(bw, W / fs), vh = Math.min(bh, H / fs);
        const g = L.createRadialGradient(0, 0, Math.min(vw, vh) * 0.28, 0, 0, Math.hypot(vw, vh) / 2);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, `rgba(0,0,0,${vig * 0.85})`);
        L.globalAlpha = 1;
        L.fillStyle = g;
        L.fillRect(-bw / 2, -bh / 2, bw, bh);
      }
    }
    L.restore();
    if (c.border > 0) {
      L.beginPath();
      L.roundRect(-bw / 2, -bh / 2, bw, bh, r);
      L.lineWidth = (c.border * U) / fs;
      L.strokeStyle = c.borderColor || '#fff';
      L.stroke();
    }
    const alpha = fadeK(c, lt) * clamp(propAt(c, 'opacity', lt), 0, 1);
    return { alpha, blur: 0, box: { id: c.id, cx, cy, w: bw * fs, h: bh * fs, rot: rr } };
  }

  remember(id, v) {
    if (!this.lastFrames) this.lastFrames = new Map();
    let e = this.lastFrames.get(id);
    if (e && e.t === v.currentTime && e.src === v.currentSrc) return;
    const k = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.max(1, Math.round(v.videoWidth * k)), h = Math.max(1, Math.round(v.videoHeight * k));
    if (!e) { e = { c: document.createElement('canvas') }; this.lastFrames.set(id, e); }
    if (e.c.width !== w || e.c.height !== h) { e.c.width = w; e.c.height = h; }
    e.c.getContext('2d').drawImage(v, 0, 0, w, h);
    e.t = v.currentTime; e.src = v.currentSrc; e.w = v.videoWidth; e.h = v.videoHeight;
    if (this.lastFrames.size > 40) this.lastFrames.delete(this.lastFrames.keys().next().value);
  }

  blurBg(img, sw, sh) {
    const S = this.S, sm = this.small, L = this.L;
    const k = Math.max(sm.width / sw, sm.height / sh) * 1.15;
    S.setTransform(1, 0, 0, 1, 0, 0);
    S.filter = 'blur(2px)';
    S.drawImage(img, (sm.width - sw * k) / 2, (sm.height - sh * k) / 2, sw * k, sh * k);
    S.filter = 'none';
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.imageSmoothingEnabled = true;
    L.imageSmoothingQuality = 'high';
    L.filter = 'brightness(0.72) saturate(1.25)';
    L.drawImage(sm, 0, 0, this.layer.width, this.layer.height);
    L.filter = 'none';
  }

  // Zielony ekran: usuwa wybrany kolor (odległość barwy, niezależna od jasności).
  keyed(img, sw, sh, ck) {
    const maxD = this.exporting ? 1920 : 900;
    const k = Math.min(1, maxD / Math.max(sw, sh));
    const aw = Math.max(1, Math.round(sw * k)), ah = Math.max(1, Math.round(sh * k));
    const A = this.A, aux = this.aux;
    if (aux.width !== aw || aux.height !== ah) { aux.width = aw; aux.height = ah; }
    A.clearRect(0, 0, aw, ah);
    A.drawImage(img, 0, 0, aw, ah);
    const id = A.getImageData(0, 0, aw, ah);
    const d = id.data;
    const [kr, kg, kb] = hexToRgb(ck.color);
    const ks = kr + kg + kb + 1;
    const knr = kr / ks, kng = kg / ks, knb = kb / ks;
    const thr = ck.sim == null ? 0.4 : ck.sim;
    const sm = Math.max(0.01, ck.smooth == null ? 0.1 : ck.smooth);
    const ki = kg >= kr && kg >= kb ? 1 : kb >= kr ? 2 : 0;
    const o1 = ki === 0 ? 1 : 0, o2 = ki === 2 ? 1 : 2;
    const spillR = sm * 4;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const sum = r + g + b + 1;
      const dr = r / sum - knr, dg = g / sum - kng, db = b / sum - knb;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      let a = (dist - thr) / sm;
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      if (sum < 60) a = Math.max(a, 1 - sum / 60);
      if (a < 1) d[i + 3] = d[i + 3] * a;
      const sp = (thr + spillR - dist) / spillR;
      if (sp > 0) {
        const cc = d[i + ki], o = Math.max(d[i + o1], d[i + o2]);
        if (cc > o) d[i + ki] = cc - (cc - o) * Math.min(1, sp);
      }
    }
    A.putImageData(id, 0, 0);
    return aux;
  }

  // ------------------------------------------------------------ napisy
  layout(c) {
    const U = this.U, W = this.W;
    const key = `${c.text}|${c.upper}|${c.font}|${c.weight}|${c.italic}|${c.size}|${c.spacing}|${c.maxW}|${c.lineH}|${c.strokeW}|${W}|${U}`;
    let lay = this.layoutCache.get(key);
    if (lay) return lay;
    const M = this.mctx;
    const fsz = (c.size || 80) * U;
    const font = `${c.italic ? 'italic ' : ''}${c.weight || 400} ${fsz}px "${c.font}", "Segoe UI", sans-serif`;
    const ls = `${(c.spacing || 0) * U}px`;
    M.font = font;
    if (this.hasLS) M.letterSpacing = ls;
    const maxW = (c.maxW || 0.86) * W;
    const txt = c.upper ? (c.text || '').toUpperCase() : (c.text || '');
    const lines = [];
    for (const para of txt.split('\n')) {
      const ws = para.split(/\s+/).filter(Boolean);
      let cur = [];
      const flush = () => { const text = cur.join(' '); lines.push({ text, w: text ? M.measureText(text).width : 0, words: cur }); cur = []; };
      for (const w of ws) {
        if (cur.length && M.measureText(cur.join(' ') + ' ' + w).width > maxW) flush();
        cur.push(w);
      }
      flush();
    }
    // pozycje słów (dla animacji słowo po słowie / karaoke) – z odstępem powiększonym o obrys
    const words = [];
    let chars = 0;
    const gap = M.measureText(' ').width + (c.strokeW || 0) * U * 1.1;
    lines.forEach((ln, li) => {
      let x = 0;
      ln.words.forEach((w) => {
        const ww = M.measureText(w).width;
        words.push({ t: w, x, w: ww, li, i: words.length });
        x += ww + gap;
      });
      ln.ww = Math.max(0, x - gap);
      chars += ln.text.length;
    });
    const lh = fsz * (c.lineH || 1.15);
    lay = { font, ls, fsz, lh, lines, words, chars, w: Math.max(1, ...lines.map((l) => l.w)), h: Math.max(1, lines.length) * lh };
    if (this.layoutCache.size > 400) this.layoutCache.clear();
    this.layoutCache.set(key, lay);
    return lay;
  }

  textLayer(c, t) {
    const { W, H, s, U, L } = this;
    const lt = t - c.start, dur = c.duration;
    this._clearLayer();
    const lay = this.layout(c);
    const x = propAt(c, 'x', lt), y = propAt(c, 'y', lt), sc = propAt(c, 'scale', lt), rot = propAt(c, 'rotation', lt);
    const ad = Math.max(0.05, Math.min(c.animDur || 0.4, dur / 2));
    const pin = clamp(lt / ad, 0, 1), pout = clamp((dur - lt) / ad, 0, 1);
    let a = 1, dx = 0, dy = 0, k = 1, blur = 0, r = 0;
    switch (c.animIn) {
      case 'fade': a *= EASE.out(pin); break;
      case 'pop': k *= pin >= 1 ? 1 : Math.max(0.01, EASE.back(pin)); a *= Math.min(1, pin * 3); break;
      case 'zoom': k *= 1 + 1.2 * (1 - EASE.out(pin)); a *= EASE.out(pin); break;
      case 'slideup': dy += (1 - EASE.out(pin)) * 0.08 * H; a *= EASE.out(pin); break;
      case 'slidedown': dy -= (1 - EASE.out(pin)) * 0.08 * H; a *= EASE.out(pin); break;
      case 'slideleft': dx += (1 - EASE.out(pin)) * 0.3 * W; a *= Math.min(1, pin * 2); break;
      case 'slideright': dx -= (1 - EASE.out(pin)) * 0.3 * W; a *= Math.min(1, pin * 2); break;
      case 'bounce': dy -= (1 - EASE.bounce(pin)) * 0.2 * H; a *= Math.min(1, pin * 4); break;
      case 'blur': blur += (1 - EASE.out(pin)) * 26; a *= EASE.out(pin); k *= 1 + 0.12 * (1 - EASE.out(pin)); break;
      case 'spin': r -= (1 - EASE.out(pin)) * 200; k *= Math.max(0.01, EASE.out(pin)); break;
      case 'flicker': if (pin < 1) a *= (Math.floor(lt * 22) % 3 === 0 ? 0.15 : 1) * (0.4 + 0.6 * pin); break;
      default: break;
    }
    if (pout < 1) {
      const q = 1 - pout;
      switch (c.animOut) {
        case 'fade': a *= EASE.out(pout); break;
        case 'pop': k *= Math.max(0.01, EASE.out(pout)); break;
        case 'zoom': k *= 1 + EASE.in(q) * 0.9; a *= pout; break;
        case 'slideup': dy -= EASE.in(q) * 0.08 * H; a *= pout; break;
        case 'slidedown': dy += EASE.in(q) * 0.08 * H; a *= pout; break;
        case 'blur': blur += q * 26; a *= pout; break;
        default: break;
      }
    }
    switch (c.loop) {
      case 'pulse': k *= 1 + 0.06 * Math.sin(lt * Math.PI * 3); break;
      case 'wiggle': r += 6 * Math.sin(lt * Math.PI * 4); break;
      case 'float': dy += 0.012 * H * Math.sin(lt * Math.PI * 1.4); break;
      case 'shake': dx += 5 * U * Math.sin(lt * 63); dy += 4 * U * Math.sin(lt * 51); break;
      case 'spin': r += lt * 90; break;
      default: break;
    }
    a *= fadeK(c, lt) * clamp(propAt(c, 'opacity', lt), 0, 1);

    const cx = W / 2 + x * W + dx, cy = H / 2 + y * H + dy;
    const fsz = lay.fsz, lh = lay.lh, top = -lay.h / 2;
    const pad = c.boxAlpha > 0 ? fsz * (c.boxPad == null ? 0.28 : c.boxPad) : 0;
    const box = { id: c.id, cx, cy, w: (lay.w + pad * 2 + fsz * 0.2) * sc * k, h: (lay.h + pad * 1.2) * sc * k, rot: rot + r };
    if (a <= 0.002 || !lay.chars) return { alpha: 0, box };

    L.setTransform(s, 0, 0, s, 0, 0);
    L.translate(cx, cy);
    L.rotate((rot + r) * RAD);
    L.scale(sc * k, sc * k);
    L.font = lay.font;
    if (this.hasLS) L.letterSpacing = lay.ls;
    L.textBaseline = 'middle';
    L.textAlign = 'left';
    L.lineJoin = 'round';
    L.miterLimit = 2;
    const lineX = (ln, wordMode) => {
      const lw = wordMode ? ln.ww : ln.w;
      return c.align === 'left' ? -lay.w / 2 : c.align === 'right' ? lay.w / 2 - lw : -lw / 2;
    };
    const lineY = (i) => top + i * lh + lh / 2;

    if (c.boxAlpha > 0) {
      L.fillStyle = hexA(c.boxColor, c.boxAlpha);
      const bh = fsz + pad * 1.1;
      lay.lines.forEach((ln, i) => {
        if (!ln.w) return;
        L.beginPath();
        L.roundRect(lineX(ln) - pad, lineY(i) - bh / 2, ln.w + pad * 2, bh, Math.min((c.boxRadius || 0) * U, bh / 2));
        L.fill();
      });
    }
    const stroke = c.strokeW > 0;
    if (stroke) { L.lineWidth = c.strokeW * U * 2; L.strokeStyle = c.stroke || '#000'; }
    const draw = (str, px, py, color) => {
      if (!str) return;
      if (stroke) L.strokeText(str, px, py);
      L.fillStyle = color || c.color;
      L.fillText(str, px, py);
    };

    const mode = c.animIn;
    if (mode === 'typewriter') {
      const tp = clamp(lt / Math.max(0.1, Math.min(c.animDur || 1, dur * 0.9)), 0, 1);
      let left = Math.floor(tp * lay.chars + 1e-4);
      lay.lines.forEach((ln, i) => {
        const str = ln.text.slice(0, Math.max(0, left));
        left -= ln.text.length;
        draw(str, lineX(ln), lineY(i));
      });
    } else if (mode === 'words' || mode === 'karaoke') {
      const n = lay.words.length;
      // dokładne czasy słów z rozpoznawania mowy (napisy automatyczne)
      const wt = c.wt && c.wt.length === n ? c.wt : null;
      if (mode === 'words') {
        const step = Math.min(0.45, (dur * 0.8) / Math.max(1, n));
        for (const w of lay.words) {
          const pw = clamp((lt - (wt ? wt[w.i] : w.i * step)) / (wt ? 0.15 : 0.22), 0, 1);
          if (pw <= 0) continue;
          const kk = Math.max(0.01, EASE.back(pw));
          L.save();
          L.globalAlpha = Math.min(1, pw * 2);
          L.translate(lineX(lay.lines[w.li], true) + w.x + w.w / 2, lineY(w.li));
          L.scale(kk, kk);
          draw(w.t, -w.w / 2, 0);
          L.restore();
        }
      } else {
        const tot = lay.words.reduce((m, w) => m + w.t.length, 0) || 1;
        const span = dur * 0.92;
        let acc = 0;
        for (const w of lay.words) {
          let t0 = (acc / tot) * span, t1 = ((acc + w.t.length) / tot) * span;
          if (wt) { t0 = wt[w.i]; t1 = w.i + 1 < n ? wt[w.i + 1] : dur + 1; }
          acc += w.t.length;
          const active = lt >= t0 && lt < t1, done = lt >= t1;
          let kk = 1;
          if (active) kk = 1 + 0.07 * EASE.out(clamp((lt - t0) / 0.12, 0, 1));
          L.save();
          L.translate(lineX(lay.lines[w.li], true) + w.x + w.w / 2, lineY(w.li));
          L.scale(kk, kk);
          draw(w.t, -w.w / 2, 0, active || done ? c.hl : c.color);
          L.restore();
        }
      }
    } else {
      lay.lines.forEach((ln, i) => draw(ln.text, lineX(ln), lineY(i)));
    }
    return { alpha: a, blur, box };
  }

  // ------------------------------------------------------------ składanie
  composite(c, info, ov) {
    const a = info.alpha * (ov && ov.alpha != null ? ov.alpha : 1);
    if (a <= 0.002) return;
    const ctx = this.ctx, s = this.s, U = this.U, cw = this.canvas.width, ch = this.canvas.height;
    ctx.save();
    ctx.globalAlpha = clamp(a, 0, 1);
    ctx.globalCompositeOperation = c.blend || 'source-over';
    const blur = (info.blur || 0) + ((ov && ov.blur) || 0);
    if (blur > 0.3) ctx.filter = `blur(${blur * U * s}px)`;
    if (c.shadow > 0) {
      const col = c.shadowColor || '#000000';
      ctx.shadowColor = col;
      ctx.shadowBlur = c.shadow * U * s;
      ctx.shadowOffsetY = lum(col) > 0.3 ? 0 : c.shadow * 0.12 * U * s;
    }
    if (ov && ov.clip) { ctx.beginPath(); ov.clip(ctx, cw, ch); ctx.clip(); }
    if (ov && (ov.dx || ov.dy || (ov.scale && ov.scale !== 1) || ov.rot)) {
      ctx.translate(cw / 2 + (ov.dx || 0) * s, ch / 2 + (ov.dy || 0) * s);
      if (ov.rot) ctx.rotate(ov.rot * RAD);
      const k = ov.scale || 1;
      ctx.scale(k, k);
      ctx.translate(-cw / 2, -ch / 2);
    }
    ctx.drawImage(this.layer, 0, 0);
    ctx.restore();
  }

  flat(col, a) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = clamp(a, 0, 1);
    ctx.fillStyle = col;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  }

  transition(it, t, boxes) {
    const { cur: B, prev: A, tr } = it;
    const p = EASE.inOut(it.p);
    const W = this.W, H = this.H;
    let type = it.type;
    if (!A && !tr.main && (type === 'black' || type === 'white')) type = 'fade';
    const draw = (c, ov) => (c ? this.drawClip(c, t, ov) : null);
    let bb = null;
    switch (type) {
      case 'fade': draw(A); bb = draw(B, { alpha: p }); break;
      case 'black':
      case 'white': {
        const col = type === 'black' ? '#000' : '#fff';
        if (p < 0.5) { draw(A); this.flat(col, p * 2); } else { bb = draw(B); this.flat(col, (1 - p) * 2); }
        break;
      }
      case 'slideleft': draw(A, { dx: -p * W }); bb = draw(B, { dx: (1 - p) * W }); break;
      case 'slideright': draw(A, { dx: p * W }); bb = draw(B, { dx: -(1 - p) * W }); break;
      case 'slideup': draw(A, { dy: -p * H }); bb = draw(B, { dy: (1 - p) * H }); break;
      case 'slidedown': draw(A, { dy: p * H }); bb = draw(B, { dy: -(1 - p) * H }); break;
      case 'zoomin': draw(A, { scale: 1 + p * 0.6 }); bb = draw(B, { scale: 0.8 + 0.2 * p, alpha: p }); break;
      case 'zoomout': draw(A, { scale: 1 - p * 0.25 }); bb = draw(B, { scale: 1.5 - 0.5 * p, alpha: p }); break;
      case 'wipeleft': draw(A); bb = draw(B, { clip: (c, cw, ch) => c.rect(cw * (1 - p), 0, cw * p + 1, ch) }); break;
      case 'wipeup': draw(A); bb = draw(B, { clip: (c, cw, ch) => c.rect(0, ch * (1 - p), cw, ch * p + 1) }); break;
      case 'circle': draw(A); bb = draw(B, { clip: (c, cw, ch) => c.arc(cw / 2, ch / 2, (Math.hypot(cw, ch) / 2) * p + 0.5, 0, Math.PI * 2) }); break;
      case 'blur': draw(A, { blur: p * 40 }); bb = draw(B, { alpha: p, blur: (1 - p) * 40 }); break;
      case 'spin': draw(A, { rot: p * 120, scale: 1 - p * 0.5, alpha: 1 - p }); bb = draw(B, { rot: (p - 1) * 120, scale: 0.5 + 0.5 * p, alpha: p }); break;
      case 'glitch':
        if (p < 0.5) draw(A); else bb = draw(B);
        this.glitch(1 - Math.abs(p - 0.5) * 2, t);
        break;
      default: bb = draw(B);
    }
    if (bb) boxes.push(bb);
  }

  glitch(k, t) {
    const ctx = this.ctx, cw = this.canvas.width, ch = this.canvas.height;
    const rnd = mulberry32(Math.floor(t * 24) + 7);
    for (let i = 0; i < 10; i++) {
      const y = Math.floor(rnd() * ch * 0.95);
      const hh = Math.max(2, Math.min(ch - y, Math.floor((rnd() * 0.08 + 0.01) * ch)));
      const dx = (rnd() - 0.5) * cw * 0.2 * k;
      ctx.drawImage(this.canvas, 0, y, cw, hh, dx, y, cw, hh);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.35 * k;
    ctx.fillStyle = '#ff0044';
    ctx.fillRect(0, rnd() * ch, cw, ch * 0.02);
    ctx.fillStyle = '#00e5ff';
    ctx.fillRect(0, rnd() * ch, cw, ch * 0.03);
    ctx.restore();
  }
}
