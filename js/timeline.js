// Oś czasu: ścieżki, klipy, przeciąganie, przycinanie, przyciąganie, zoom, upuszczanie z biblioteki.
import { h, ic, clamp, fmtTime } from './util.js';
import {
  projectDuration, getTrack, isCompatible, insertIntoMain, repackMain, findTrackFor, addTrack, freeOn,
  maxDuration, MIN_DUR, hasMediaTime, allKfTimes, kindForClip,
} from './model.js';

const ROW_H = { main: 62, video: 46, text: 32, audio: 40, fx: 26 };
const KIND_ICON = { video: 'film', image: 'image', text: 'type', audio: 'music', fx: 'zap' };

export class Timeline {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.store = app.store;
    this.zoom = 60;
    this.clipEls = new Map();
    this.rowEls = new Map();
    this.drag = null;
    this._q = 0;
    this._move = this._move.bind(this);
    this._up = this._up.bind(this);
    this.build();
    this.store.on('change', () => this.queue());
    this.store.on('select', () => this.queue());
    this.store.on('time', () => this.updatePlayhead());
    this.store.on('load', () => { this.clipEls.clear(); for (const r of this.rowEls.values()) r.row.remove(); this.rowEls.clear(); });
    app.media.onChange(() => this.queue());
    new ResizeObserver(() => this.queue()).observe(this.root);
  }

  get headW() { return parseFloat(getComputedStyle(this.root).getPropertyValue('--headw')) || 132; }
  queue() { if (!this._q) this._q = requestAnimationFrame(() => { this._q = 0; this.render(); }); }

  build() {
    const A = this.app;
    const btn = (icon, title, fn) => h('button', { class: 'icon-btn sm', title, onclick: fn }, ic(icon));
    this.bSplit = btn('scissors', 'Podziel w miejscu głowicy (S)', () => A.splitAtPlayhead());
    this.bDel = btn('trash-2', 'Usuń zaznaczony klip (Delete)', () => A.deleteSelected());
    this.bDup = btn('copy-plus', 'Duplikuj (Ctrl+D)', () => A.duplicateSelected());
    this.bDetach = btn('unlink', 'Odłącz dźwięk od wideo', () => A.detachAudio());
    this.bFreeze = btn('snowflake', 'Stop-klatka (zamroź obraz na 2 s)', () => A.freezeFrame());
    this.bRetakes = h('button', { class: 'btn sm auto-btn tl-retakes', title: 'Usuń powtórki – gdy coś mówisz kilka razy pod rząd, zostawię najlepszą wersję, a resztę wytnę', onclick: () => A.openRetakes() }, ic('scissors-line-dashed'), h('span', null, 'Powtórki'));
    this.bCaptions = h('button', { class: 'btn sm auto-btn tl-retakes', title: 'Napisy z mowy – program sam rozpozna słowa i wstawi napisy', onclick: () => A.openCaptions() }, ic('captions'), h('span', null, 'Napisy'));
    this.bSpeechFx = h('button', { class: 'btn sm auto-btn tl-retakes', title: 'Efekty z mowy – gdy powiesz np. „zaobserwujcie”, doda dźwięk, ruch obrazu i naklejkę', onclick: () => A.openSpeechFx() }, ic('sparkles'), h('span', null, 'Efekty'));
    this.bMagnet = btn('magnet', 'Magnes – klipy na głównej ścieżce sklejają się bez przerw', () => A.toggleMagnet());
    this.bSnap = btn('crosshair', 'Przyciąganie do krawędzi i głowicy', () => A.toggleSnap());
    this.zoomRange = h('input', { type: 'range', min: 0, max: 100, step: 0.5, title: 'Powiększenie osi czasu' });
    this.zoomRange.addEventListener('input', () => this.setZoom(4 * Math.pow(200, this.zoomRange.value / 100)));
    const tb = h('div', { class: 'tl-toolbar' },
      this.bSplit, this.bDel, this.bDup, this.bDetach, this.bFreeze,
      h('span', { class: 'sep' }), this.bRetakes, this.bCaptions, this.bSpeechFx,
      h('span', { class: 'sep' }), this.bMagnet, this.bSnap,
      h('span', { class: 'sep' }),
      btn('type', 'Dodaj tekst w miejscu głowicy', () => A.addText()),
      btn('mic', 'Nagraj lektora', () => A.recordVoice()),
      h('div', { class: 'spacer' }),
      btn('zoom-out', 'Oddal', () => this.setZoom(this.zoom / 1.5)),
      this.zoomRange,
      btn('zoom-in', 'Przybliż', () => this.setZoom(this.zoom * 1.5)),
      btn('scan', 'Dopasuj do okna', () => this.fit()),
    );
    this.corner = h('div', { class: 'tl-corner' }, '00:00.0');
    this.rulerCanvas = h('canvas');
    this.rulerEl = h('div', { class: 'tl-ruler' }, this.rulerCanvas);
    this.rows = h('div', { class: 'tl-rows' });
    this.playhead = h('div', { class: 'tl-playhead' }, h('div', { class: 'knob' }));
    this.snapEl = h('div', { class: 'tl-snap hidden' });
    this.emptyEl = h('div', { class: 'tl-empty' }, 'Przeciągnij tu filmy, zdjęcia lub muzykę z biblioteki po lewej.');
    this.inner = h('div', { class: 'tl-inner' }, h('div', { class: 'tl-rulerrow' }, this.corner, this.rulerEl), this.rows, this.playhead, this.snapEl, this.emptyEl);
    this.scroll = h('div', { class: 'tl-scroll' }, this.inner);
    this.root.replaceChildren(tb, this.scroll);

    this.scroll.addEventListener('scroll', () => { this.drawRuler(); this.updatePlayhead(); });
    this.rulerEl.addEventListener('pointerdown', (e) => { e.preventDefault(); this.startScrub(e, true); });
    this.playhead.querySelector('.knob').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.startScrub(e, true); });
    this.rows.addEventListener('pointerdown', (e) => this.onDown(e));
    this.rows.addEventListener('contextmenu', (e) => {
      const el = e.target.closest('.tl-clip');
      if (!el) return;
      e.preventDefault();
      this.store.select(el.dataset.id);
      A.clipMenu(el.dataset.id, e.clientX, e.clientY);
    });
    this.rows.addEventListener('dblclick', (e) => { if (e.target.closest('.tl-clip')) A.openInspector(); });
    this.scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0022), e.clientX);
      } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.scroll.scrollHeight <= this.scroll.clientHeight + 2) {
        e.preventDefault();
        this.scroll.scrollLeft += e.deltaY;
      }
    }, { passive: false });
    // upuszczanie z biblioteki i z dysku
    this.scroll.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      this.hotRow(e.target.closest('.tl-row'));
    });
    this.scroll.addEventListener('dragleave', (e) => { if (!this.scroll.contains(e.relatedTarget)) this.hotRow(null); });
    this.scroll.addEventListener('drop', (e) => this.onDrop(e));
  }

  // ------------------------------------------------------------ rysowanie
  render() {
    const P = this.store.project;
    if (!P) return;
    const headW = this.headW;
    const dur = projectDuration(P);
    const viewW = Math.max(100, this.scroll.clientWidth - headW);
    this.contentW = Math.max(viewW, (dur + Math.max(8, dur * 0.3)) * this.zoom);
    this.inner.style.width = headW + this.contentW + 'px';
    this.rulerEl.style.width = this.contentW + 'px';
    this.emptyEl.classList.toggle('hidden', P.clips.length > 0);

    const order = [{ key: 'drop-v', drop: 'visual' }];
    for (const tr of P.tracks) order.push({ key: tr.id, tr });
    order.push({ key: 'drop-a', drop: 'audio' });
    const seen = new Set();
    for (const it of order) {
      seen.add(it.key);
      let r = this.rowEls.get(it.key);
      if (!r) { r = this.makeRow(it); this.rowEls.set(it.key, r); }
      if (it.tr) this.updateRow(r, it.tr);
      r.lane.style.width = this.contentW + 'px';
      this.rows.append(r.row);
    }
    for (const [k, r] of this.rowEls) if (!seen.has(k)) { r.row.remove(); this.rowEls.delete(k); }

    const live = new Set();
    for (const c of P.clips) {
      live.add(c.id);
      let el = this.clipEls.get(c.id);
      if (!el) { el = this.makeClipEl(c); this.clipEls.set(c.id, el); }
      const r = this.rowEls.get(c.trackId);
      if (!r) continue;
      if (el.parentNode !== r.lane) r.lane.append(el);
      this.updateClipEl(el, c, r.tr);
    }
    for (const [id, el] of this.clipEls) if (!live.has(id)) { el.remove(); this.clipEls.delete(id); }
    this.drawRuler();
    this.updatePlayhead();
    this.updateButtons();
    const v = (Math.log(this.zoom / 4) / Math.log(200)) * 100;
    if (document.activeElement !== this.zoomRange) this.zoomRange.value = v;
    this.zoomRange.style.setProperty('--p', v + '%');
  }

  makeRow(it) {
    if (it.drop) {
      const lane = h('div', { class: 'tl-lane' }, it.drop === 'audio' ? '＋ upuść tu dźwięk, aby dodać nową ścieżkę audio' : '＋ upuść tu klip, aby dodać nową nakładkę');
      const row = h('div', { class: 'tl-row drop', 'data-drop': it.drop }, h('div', { class: 'tl-head' }), lane);
      return { row, lane, drop: it.drop };
    }
    const nm = h('div', { class: 'nm' });
    const eye = h('button', { class: 'icon-btn', title: 'Pokaż / ukryj ścieżkę' });
    const vol = h('button', { class: 'icon-btn', title: 'Wycisz ścieżkę' });
    const head = h('div', { class: 'tl-head' }, nm, eye, vol);
    const lane = h('div', { class: 'tl-lane' });
    const row = h('div', { class: 'tl-row' }, head, lane);
    const r = { row, lane, head, nm, eye, vol, tr: it.tr };
    eye.addEventListener('click', () => { const tr = getTrack(this.store.project, r.tr.id); if (tr) { tr.hidden = !tr.hidden; this.app.commit(); } });
    vol.addEventListener('click', () => { const tr = getTrack(this.store.project, r.tr.id); if (tr) { tr.muted = !tr.muted; this.app.commit(); } });
    return r;
  }

  updateRow(r, tr) {
    r.tr = tr;
    r.row.dataset.track = tr.id;
    r.row.className = `tl-row k-${tr.kind}${tr.main ? ' main' : ''}${tr.hidden ? ' hidden-track' : ''}`;
    const sig = `${tr.name}|${tr.kind}|${tr.hidden}|${tr.muted}|${tr.main}`;
    if (r._sig === sig) return;
    r._sig = sig;
    r.nm.replaceChildren(ic(tr.main ? 'clapperboard' : tr.kind === 'text' ? 'type' : tr.kind === 'audio' ? 'music' : tr.kind === 'fx' ? 'zap' : 'layers'), h('span', null, tr.name));
    r.eye.classList.toggle('hidden', tr.kind === 'audio');
    r.eye.replaceChildren(ic(tr.hidden ? 'eye-off' : 'eye'));
    r.eye.classList.toggle('off', !!tr.hidden);
    r.vol.classList.toggle('hidden', tr.kind === 'text' || tr.kind === 'fx');
    r.vol.replaceChildren(ic(tr.muted ? 'volume-x' : 'volume-2'));
    r.vol.classList.toggle('off', !!tr.muted);
  }

  makeClipEl(c) {
    const el = h('div', { class: 'tl-clip', 'data-id': c.id });
    el._lbl = h('div', { class: 'lbl' });
    el._decor = h('div');
    el.append(el._decor, el._lbl, h('div', { class: 'hd l' }), h('div', { class: 'hd r' }));
    return el;
  }

  updateClipEl(el, c, tr) {
    const m = c.mediaId ? this.app.media.get(c.mediaId) : null;
    const sel = c.id === this.store.sel;
    el.className = `tl-clip k-${c.kind}${sel ? ' sel' : ''}`;
    const w = Math.max(3, c.duration * this.zoom);
    el.style.left = c.start * this.zoom + 'px';
    el.style.width = w + 'px';
    const rowH = tr.main ? ROW_H.main : ROW_H[tr.kind] || 46;

    const lsig = [c.name, c.text, c.speed, c.kind, c.muted, c.chroma && c.chroma.on, c.filter && c.filter.preset, m && m.status].join('|');
    if (el._lsig !== lsig) {
      el._lsig = lsig;
      const kids = [ic(KIND_ICON[c.kind] || 'film')];
      kids.push(h('span', null, c.kind === 'text' ? (c.text || '').replace(/\n/g, ' ') : c.name || ''));
      if (c.kind === 'fx') kids.length = 1, kids.push(h('span', null, c.name || 'Efekt'));
      if (c.speed && c.speed !== 1) kids.push(h('span', { class: 'bdg' }, `${+c.speed.toFixed(2)}×`));
      if (c.muted) kids.push(ic('volume-x'));
      if ((c.filter && c.filter.preset && c.filter.preset !== 'none') || (c.chroma && c.chroma.on)) kids.push(ic('sparkles'));
      if (m && m.status === 'error') kids.push(h('span', { class: 'bdg' }, 'brak pliku'));
      el._lbl.replaceChildren(...kids);
    }
    const tsig = [this.zoom, c.duration, c.in, c.speed, m && m.thumbs && m.thumbs.length, m && m.peaks && m.peaks.length, rowH].join('|');
    if (el._tsig !== tsig) { el._tsig = tsig; this.drawClipCanvas(el, c, m, w, rowH); }
    const kft = allKfTimes(c);
    const dsig = [this.zoom, c.transIn && c.transIn.type, c.transIn && c.transIn.dur, c.fadeIn, c.fadeOut, c.aFadeIn, c.aFadeOut, kft.join(',')].join('|');
    if (el._dsig !== dsig) {
      el._dsig = dsig;
      const d = [];
      if (c.transIn && c.transIn.type !== 'none' && c.transIn.dur > 0) d.push(h('div', { class: 'trn', style: { width: c.transIn.dur * this.zoom + 'px' } }));
      const fi = c.kind === 'audio' ? c.aFadeIn : c.fadeIn, fo = c.kind === 'audio' ? c.aFadeOut : c.fadeOut;
      if (fi > 0) d.push(h('div', { class: 'fd in', style: { width: fi * this.zoom + 'px' } }));
      if (fo > 0) d.push(h('div', { class: 'fd out', style: { width: fo * this.zoom + 'px' } }));
      for (const t of kft) d.push(h('div', { class: 'kfm', style: { left: t * this.zoom + 'px' } }));
      el._decor.replaceChildren(...d);
    }
  }

  drawClipCanvas(el, c, m, w, H) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cwpx = Math.max(1, Math.min(4096, Math.ceil(w * dpr)));
    const k = cwpx / w;
    if ((c.kind === 'video' || c.kind === 'image') && m && m.thumbs && m.thumbs.length) {
      const cv = el._th || (el._th = el.insertBefore(h('canvas', { class: 'th' }), el.firstChild));
      cv.width = cwpx; cv.height = Math.ceil(H * dpr); cv.style.width = w + 'px';
      const g = cv.getContext('2d');
      const th0 = m.thumbs[0].c;
      const tw = Math.max(12, (H * th0.width) / th0.height);
      const n = m.thumbs.length;
      for (let x = 0; x < w; x += tw) {
        let src = th0;
        if (c.kind === 'video' && n > 1 && m.duration) {
          const st = (c.in || 0) + ((x + tw / 2) / this.zoom) * (c.speed || 1);
          src = m.thumbs[clamp(Math.round((st / m.duration) * n - 0.5), 0, n - 1)].c;
        }
        g.drawImage(src, x * k, 0, tw * k, H * dpr);
      }
    } else if (el._th && !(m && m.thumbs)) { el._th.remove(); el._th = null; }
    if ((c.kind === 'audio' || c.kind === 'video') && m && m.peaks) {
      const cv = el._wv || (el._wv = el.insertBefore(h('canvas', { class: 'wv' }), el._decor));
      const hh = c.kind === 'audio' ? H : Math.round(H * 0.34);
      cv.width = cwpx; cv.height = Math.ceil(hh * dpr); cv.style.width = w + 'px';
      const g = cv.getContext('2d');
      g.fillStyle = c.kind === 'audio' ? 'rgba(140,255,180,.85)' : 'rgba(190,210,255,.8)';
      const ph = cv.height;
      const pk = m.peaks;
      for (let px = 0; px < cwpx; px += 2) {
        const st = (c.in || 0) + (px / k / this.zoom) * (c.speed || 1);
        const a = pk[Math.min(pk.length - 1, Math.floor(st * 50))] || 0;
        const bh = Math.max(1, a * ph * (c.kind === 'audio' ? 0.9 : 1) * Math.min(1.6, c.volume == null ? 1 : c.volume));
        if (c.kind === 'audio') g.fillRect(px, (ph - bh) / 2, 1.5, bh); else g.fillRect(px, ph - bh, 1.5, bh);
      }
    }
  }

  drawRuler() {
    const headW = this.headW;
    const cv = this.rulerCanvas;
    const w = Math.max(10, this.scroll.clientWidth - headW);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(26 * dpr); cv.style.width = w + 'px'; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, 26);
    const sl = this.scroll.scrollLeft, z = this.zoom;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * z >= 70) || 600;
    const minor = major / 5;
    const t0 = sl / z, t1 = (sl + w) / z;
    g.font = '600 10px Inter, sans-serif';
    for (let i = Math.floor(t0 / minor); i * minor <= t1; i++) {
      const t = i * minor;
      const x = Math.round(t * z - sl) + 0.5;
      const isMaj = i % 5 === 0;
      g.fillStyle = isMaj ? '#5f5f80' : '#34344a';
      g.fillRect(x, isMaj ? 13 : 19, 1, isMaj ? 13 : 7);
      if (isMaj) {
        g.fillStyle = '#8d8da6';
        g.fillText(major < 1 ? `${+t.toFixed(2)}s` : fmtTime(t, 0), x + 4, 11);
      }
    }
  }

  updatePlayhead() {
    const P = this.store.project;
    if (!P) return;
    const t = this.store.time;
    const x = t * this.zoom;
    const sl = this.scroll.scrollLeft;
    this.playhead.style.left = this.headW + x + 'px';
    this.playhead.style.visibility = x < sl - 1 ? 'hidden' : 'visible';
    this.corner.textContent = fmtTime(t);
    if (this.app.player && this.app.player.playing && !this.drag) {
      const viewW = this.scroll.clientWidth - this.headW;
      if (x > sl + viewW - 30 || x < sl) this.scroll.scrollLeft = Math.max(0, x - 40);
    }
  }

  updateButtons() {
    const P = this.store.project;
    const c = this.store.selected;
    const t = this.store.time;
    const under = c ? (t > c.start + MIN_DUR && t < c.start + c.duration - MIN_DUR) : P.clips.some((x) => x.trackId === 'main' && t > x.start && t < x.start + x.duration);
    this.bSplit.disabled = !under;
    this.bDel.disabled = !c;
    this.bDup.disabled = !c;
    const m = c && c.mediaId && this.app.media.get(c.mediaId);
    this.bDetach.disabled = !(c && c.kind === 'video' && m && m.hasAudio && !c.muted);
    this.bFreeze.disabled = !(c && c.kind === 'video' && t >= c.start && t < c.start + c.duration);
    this.bMagnet.classList.toggle('on', !!P.magnet);
    this.bSnap.classList.toggle('on', !!P.snap);
  }

  setZoom(z, anchorX) {
    z = clamp(z, 4, 800);
    const rect = this.scroll.getBoundingClientRect();
    const ax = anchorX != null ? anchorX - rect.left - this.headW : this.store.time * this.zoom - this.scroll.scrollLeft;
    const tAt = (this.scroll.scrollLeft + ax) / this.zoom;
    this.zoom = z;
    this.render();
    this.scroll.scrollLeft = Math.max(0, tAt * z - ax);
    this.drawRuler();
  }
  fit() {
    const P = this.store.project;
    const dur = projectDuration(P) || 10;
    const w = this.scroll.clientWidth - this.headW - 30;
    this.setZoom(Math.max(4, w / dur));
    this.scroll.scrollLeft = 0;
  }

  // ------------------------------------------------------------ interakcje
  laneLeft() { return this.rulerEl.getBoundingClientRect().left; }
  timeAt(clientX) { return Math.max(0, (clientX - this.laneLeft()) / this.zoom); }

  startScrub(e, allowTouchDrag) {
    const P = this.store.project;
    if (!P) return;
    const seekAt = (ev) => this.app.player.seek(this.timeAt(ev.clientX));
    if (e.pointerType === 'touch' && !allowTouchDrag) {
      const x0 = e.clientX, y0 = e.clientY;
      const up = (ev) => { window.removeEventListener('pointerup', up); if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 10) seekAt(ev); };
      window.addEventListener('pointerup', up);
      return;
    }
    if (this.app.player.playing) this.app.player.pause();
    seekAt(e);
    const mv = (ev) => seekAt(ev);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const clipEl = e.target.closest('.tl-clip');
    if (!clipEl) {
      if (!e.target.closest('.tl-lane')) return;
      this.store.select(null);
      this.startScrub(e, false);
      return;
    }
    const c = this.store.clip(clipEl.dataset.id);
    if (!c) return;
    if (e.pointerType === 'touch' && c.id !== this.store.sel) {
      // dotyk: najpierw zaznacz (przesuwanie palcem przewija oś)
      const x0 = e.clientX, y0 = e.clientY;
      const up = (ev) => { window.removeEventListener('pointerup', up); if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 10) this.store.select(c.id); };
      window.addEventListener('pointerup', up);
      return;
    }
    e.preventDefault();
    this.store.select(c.id);
    const mode = e.target.classList.contains('l') ? 'trimL' : e.target.classList.contains('r') ? 'trimR' : 'move';
    this.drag = {
      mode, id: c.id, x0: e.clientX, y0: e.clientY, moved: false,
      grab: this.timeAt(e.clientX) - c.start,
      orig: { start: c.start, duration: c.duration, in: c.in || 0, trackId: c.trackId, kf: c.keyframes ? JSON.stringify(c.keyframes) : null },
    };
    window.addEventListener('pointermove', this._move);
    window.addEventListener('pointerup', this._up);
    window.addEventListener('pointercancel', this._up);
  }

  snapPoints(id) {
    const pts = [0, this.store.time];
    for (const c of this.store.project.clips) if (c.id !== id) pts.push(c.start, c.start + c.duration);
    return pts;
  }
  snapRange(start, dur, id) {
    const thr = 9 / this.zoom;
    let best = null, bd = thr;
    for (const p of this.snapPoints(id)) {
      const d1 = Math.abs(p - start);
      if (d1 < bd) { bd = d1; best = { t: p, x: p }; }
      const d2 = Math.abs(p - (start + dur));
      if (d2 < bd) { bd = d2; best = { t: p - dur, x: p }; }
    }
    return best || { t: start, x: null };
  }
  snapPoint(t, id) {
    const thr = 9 / this.zoom;
    let best = null, bd = thr;
    for (const p of this.snapPoints(id)) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
    return best;
  }
  showSnap(t) {
    if (t == null) { this.snapEl.classList.add('hidden'); return; }
    this.snapEl.classList.remove('hidden');
    this.snapEl.style.left = this.headW + t * this.zoom + 'px';
  }
  hotRow(row) {
    if (this._hot && this._hot !== row) this._hot.classList.remove('hot');
    this._hot = row;
    if (row) row.classList.add('hot');
  }

  _move(e) {
    const d = this.drag;
    if (!d) return;
    const P = this.store.project;
    const c = this.store.clip(d.id);
    if (!c) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    if (!d.moved) { d.moved = true; if (this.app.player.playing) this.app.player.pause(); }
    // przewijanie przy krawędzi
    const sr = this.scroll.getBoundingClientRect();
    if (e.clientX > sr.right - 30) this.scroll.scrollLeft += 12;
    else if (e.clientX < sr.left + this.headW + 20) this.scroll.scrollLeft -= 12;
    const pt = this.timeAt(e.clientX);
    let snapX = null;
    const m = c.mediaId ? this.app.media.get(c.mediaId) : null;
    if (d.mode === 'move') {
      const rowEl = document.elementFromPoint(e.clientX, e.clientY);
      const row = rowEl && rowEl.closest('.tl-row');
      let target = getTrack(P, c.trackId);
      d.toNew = null;
      if (row && row.dataset.drop) {
        if ((row.dataset.drop === 'audio') === (c.kind === 'audio')) d.toNew = row.dataset.drop;
      } else if (row && row.dataset.track) {
        const tr = getTrack(P, row.dataset.track);
        if (tr && isCompatible(tr, c)) target = tr;
      }
      this.hotRow(d.toNew ? row : null);
      if (target.main && P.magnet && !d.toNew) {
        insertIntoMain(P, c, pt);
      } else {
        let ns = Math.max(0, pt - d.grab);
        if (P.snap) { const r = this.snapRange(ns, c.duration, c.id); ns = r.t; snapX = r.x; }
        c.start = Math.max(0, ns);
        c.trackId = target.id;
        repackMain(P);
      }
    } else if (d.mode === 'trimL') {
      let ns = d.orig.start + dx / this.zoom;
      if (P.snap) { const s = this.snapPoint(ns, c.id); if (s != null) { ns = s; snapX = s; } }
      let delta = ns - d.orig.start;
      delta = Math.min(delta, d.orig.duration - MIN_DUR);
      if (hasMediaTime(c)) delta = Math.max(delta, -d.orig.in / (c.speed || 1));
      delta = Math.max(delta, -d.orig.start);
      c.start = d.orig.start + delta;
      c.duration = d.orig.duration - delta;
      if (hasMediaTime(c)) c.in = d.orig.in + delta * (c.speed || 1);
      if (d.orig.kf) {
        c.keyframes = JSON.parse(d.orig.kf);
        for (const k of Object.values(c.keyframes)) for (const kf of k) kf.t -= delta;
      }
      repackMain(P);
    } else {
      let ne = d.orig.start + d.orig.duration + dx / this.zoom;
      if (P.snap) { const s = this.snapPoint(ne, c.id); if (s != null) { ne = s; snapX = s; } }
      c.duration = clamp(ne - d.orig.start, MIN_DUR, maxDuration(c, m));
      repackMain(P);
    }
    this.showSnap(snapX);
    this.store.changed();
  }

  _up() {
    window.removeEventListener('pointermove', this._move);
    window.removeEventListener('pointerup', this._up);
    window.removeEventListener('pointercancel', this._up);
    const d = this.drag;
    this.drag = null;
    this.showSnap(null);
    this.hotRow(null);
    if (!d || !d.moved) return;
    const P = this.store.project;
    const c = this.store.clip(d.id);
    if (c && d.mode === 'move') {
      if (d.toNew) {
        const kind = kindForClip(c);
        const tr = addTrack(P, kind, { top: true });
        c.trackId = tr.id;
      } else {
        const tr = getTrack(P, c.trackId);
        if (!(tr && tr.main && P.magnet) && !freeOn(P, c.trackId, c.start, c.duration, c.id)) {
          c.trackId = findTrackFor(P, c, null).id;
        }
      }
    }
    this.app.commit();
  }

  onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    this.hotRow(null);
    const P = this.store.project;
    if (!P) return;
    const row = e.target.closest('.tl-row');
    const time = this.timeAt(e.clientX);
    let trackId = row && row.dataset.track ? row.dataset.track : null;
    const toNew = row && row.dataset.drop ? row.dataset.drop : null;
    const raw = e.dataTransfer.getData('application/x-kadr');
    if (raw) {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      this.app.dropItem(data, { trackId, toNew, time });
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length) this.app.importFiles([...e.dataTransfer.files], { trackId, toNew, time });
  }
}
