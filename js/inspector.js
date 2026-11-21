// Panel właściwości: ustawienia zaznaczonego klipu albo całego projektu.
import { h, ic, clamp, fmtDur, fmtTime } from './util.js';
import { propAt, setPropAt, hasKf, kfAt, toggleKf, setSpeed, maxDuration, FORMATS, repackMain, allKfTimes } from './model.js';
import { FILTERS, TRANSITIONS, MOTIONS, ANIM_IN, ANIM_OUT, LOOPS, BLENDS, FONTS, FX_TYPES } from './catalog.js';
import { clipWords } from './captions.js';
import { transcribe } from './retakes.js';

const KIND = {
  video: { icon: 'film', name: 'Wideo' }, image: { icon: 'image', name: 'Zdjęcie' },
  text: { icon: 'type', name: 'Tekst' }, audio: { icon: 'music', name: 'Dźwięk' },
  fx: { icon: 'zap', name: 'Efekt obrazu' },
};
const TABS = {
  video: [['obraz', 'Obraz'], ['efekty', 'Efekty'], ['anim', 'Animacja'], ['dzwiek', 'Dźwięk'], ['slowa', 'Słowa']],
  image: [['obraz', 'Obraz'], ['efekty', 'Efekty'], ['anim', 'Animacja']],
  text: [['tekst', 'Tekst'], ['styl', 'Styl'], ['anim', 'Animacja']],
};
const POS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const POS_ICON = ['arrow-up-left', 'arrow-up', 'arrow-up-right', 'arrow-left', 'circle-dot', 'arrow-right', 'arrow-down-left', 'arrow-down', 'arrow-down-right'];

function decimals(step) { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; }

export class Inspector {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.store = app.store;
    this.updaters = [];
    this.tabs = {};
    this._tq = 0;
    this.store.on('select', () => this.build());
    this.store.on('load', () => this.build());
    this.store.on('change', () => this.refresh());
    this.store.on('time', () => {
      if (this._tq) return;
      this._tq = setTimeout(() => { this._tq = 0; this.refresh(); }, this.app.player && this.app.player.playing ? 120 : 30);
    });
  }
  C() { return this.store.selected; }
  P() { return this.store.project; }
  lt() { const c = this.C(); return c ? clamp(this.store.time - c.start, 0, c.duration) : 0; }
  tol() { return 0.5 / (this.P().fps || 30); }
  changed() { this.app.changed(); }
  commit() { this.app.commit(); }
  refresh() {
    if (this._builtFor !== (this.store.sel || '__project') ) return this.build();
    for (const u of this.updaters) { try { u(); } catch (e) { console.error(e); } }
  }

  // ------------------------------------------------------------ kontrolki
  range(label, o) {
    const step = o.step || 1;
    const dec = decimals(step);
    const input = h('input', { type: 'range', min: o.min, max: o.max, step });
    const num = h('input', { class: 'num', type: 'number', step });
    const fmt = (v) => (+v).toFixed(dec);
    const setP = () => input.style.setProperty('--p', ((input.value - o.min) / (o.max - o.min)) * 100 + '%');
    input.addEventListener('input', () => { o.set(+input.value); num.value = fmt(input.value); setP(); this.changed(); });
    input.addEventListener('change', () => this.commit());
    num.addEventListener('change', () => {
      const v = +num.value;
      if (!isFinite(v)) return;
      o.set(clamp(v, o.numMin != null ? o.numMin : o.min, o.numMax != null ? o.numMax : o.max));
      this.commit();
    });
    num.addEventListener('keydown', (e) => e.stopPropagation());
    let kfBtn = null;
    if (o.kf) {
      kfBtn = h('button', { class: 'kf-btn', title: 'Klatka kluczowa – ustaw różne wartości w różnych chwilach, a klip się animuje' }, ic('diamond'));
      kfBtn.addEventListener('click', () => { const c = this.C(); if (!c) return; toggleKf(c, o.kf, this.lt(), this.tol()); this.commit(); });
    }
    const upd = () => {
      const v = o.get();
      if (v == null || !isFinite(v)) return;
      if (document.activeElement !== input) input.value = v;
      if (document.activeElement !== num) num.value = fmt(v);
      setP();
      if (kfBtn) {
        const c = this.C();
        kfBtn.classList.toggle('has', hasKf(c, o.kf));
        kfBtn.classList.toggle('on', !!kfAt(c, o.kf, this.lt(), this.tol()));
      }
    };
    this.updaters.push(upd);
    upd();
    return h('div', { class: 'ctl' }, h('label', { title: label }, label), input, h('div', { class: 'row' }, num, kfBtn));
  }
  select(label, o) {
    const s = h('select', { class: 'inp' }, o.options.map(([v, n]) => h('option', { value: v }, n)));
    s.addEventListener('change', () => { o.set(s.value); this.commit(); });
    const upd = () => { const v = o.get(); if (document.activeElement !== s && s.value !== String(v)) s.value = v; };
    this.updaters.push(upd); upd();
    return label ? h('div', { class: 'ctl two' }, h('label', null, label), s) : s;
  }
  color(label, o) {
    const i = h('input', { type: 'color' });
    i.addEventListener('input', () => { o.set(i.value); this.changed(); });
    i.addEventListener('change', () => this.commit());
    const upd = () => { const v = o.get(); if (v && i.value !== v) i.value = v; };
    this.updaters.push(upd); upd();
    return h('div', { class: 'ctl two' }, h('label', null, label), i);
  }
  toggle(label, o) {
    const cb = h('input', { type: 'checkbox' });
    cb.addEventListener('change', () => { o.set(cb.checked); this.commit(); });
    const upd = () => { cb.checked = !!o.get(); };
    this.updaters.push(upd); upd();
    return h('div', { class: 'ctl two' }, h('label', null, label), h('div', { class: 'row' }, h('label', { class: 'switch' }, cb, h('span'))));
  }
  seg(label, o) {
    const wrap = h('div', { class: 'seg' });
    const btns = o.options.map((op) => {
      const b = h('button', { title: op.title || op.label || '' }, op.icon ? ic(op.icon) : null, op.icon ? null : op.label);
      b.addEventListener('click', () => { o.set(op.v); this.commit(); });
      wrap.append(b);
      return [op.v, b];
    });
    const upd = () => { const v = o.get(); for (const [ov, b] of btns) b.classList.toggle('on', ov === v); };
    this.updaters.push(upd); upd();
    return label ? h('div', { class: 'ctl two' }, h('label', null, label), wrap) : wrap;
  }
  chips(o) {
    const wrap = h('div', { class: 'chips' });
    const btns = o.options.map((op) => {
      const b = h('button', null, op.name);
      b.addEventListener('click', () => { o.set(op.id); this.commit(); });
      wrap.append(b);
      return [op.id, b];
    });
    const upd = () => { const v = o.get(); for (const [ov, b] of btns) b.classList.toggle('on', ov === v); };
    this.updaters.push(upd); upd();
    return wrap;
  }
  sec(title, icon, kids, open = true) {
    return h('details', { class: 'sec', open }, h('summary', null, ic(icon), title), h('div', { class: 'sec-body' }, kids));
  }
  btn(label, icon, fn, cls = '') { return h('button', { class: `btn sm ${cls}`, onclick: fn }, icon ? ic(icon) : null, label); }
  when(el, cond) { const upd = () => el.classList.toggle('hidden', !cond()); this.updaters.push(upd); upd(); return el; }

  // pomocnicze dla właściwości klipu
  cp(path, { kf = false, mul = 1 } = {}) {
    const self = this;
    const parts = path.split('.');
    return {
      get() {
        const c = self.C();
        if (!c) return null;
        if (kf) return propAt(c, path, self.lt()) * mul;
        let o = c;
        for (const p of parts) o = o == null ? o : o[p];
        return typeof o === 'number' ? o * mul : o;
      },
      set(v) {
        const c = self.C();
        if (!c) return;
        if (typeof v === 'number') v = v / mul;
        if (kf) { setPropAt(c, path, v, self.lt(), self.tol()); return; }
        let o = c;
        for (const p of parts.slice(0, -1)) o = o[p] || (o[p] = {});
        o[parts[parts.length - 1]] = v;
      },
    };
  }

  // ------------------------------------------------------------ budowanie
  build() {
    this.updaters = [];
    const c = this.C();
    this._builtFor = this.store.sel || '__project';
    if (!this.P()) { this.root.replaceChildren(); return; }
    if (!c) { this.root.replaceChildren(...this.buildProject()); return; }
    const k = KIND[c.kind] || KIND.video;
    const title = h('b');
    const sub = h('span');
    this.updaters.push(() => {
      const cc = this.C();
      if (!cc) return;
      title.textContent = cc.kind === 'text' ? (cc.text || 'Tekst').split('\n')[0] : cc.name || k.name;
      sub.textContent = `${k.name} • ${fmtDur(cc.duration)} • od ${fmtTime(cc.start)}`;
    });
    const head = h('div', { class: 'insp-head' },
      h('div', { class: `badge k-${c.kind}` }, ic(k.icon)),
      h('div', { class: 'ttl' }, title, sub),
      h('button', { class: 'icon-btn sm', title: 'Duplikuj', onclick: () => this.app.duplicateSelected() }, ic('copy-plus')),
      h('button', { class: 'icon-btn sm', title: 'Usuń', onclick: () => this.app.deleteSelected() }, ic('trash-2')),
      h('button', { class: 'icon-btn sm mobile-only', title: 'Zamknij', onclick: () => this.app.closeSheets() }, ic('x')),
    );
    const tabs = TABS[c.kind];
    const body = h('div', { class: 'insp-body' });
    const out = [head];
    if (tabs) {
      let cur = this.tabs[c.kind] || tabs[0][0];
      if (!tabs.some((t) => t[0] === cur)) cur = tabs[0][0];
      const bar = h('div', { class: 'insp-tabs' });
      for (const [id, name] of tabs) {
        const b = h('button', { class: id === cur ? 'on' : '' }, name);
        b.addEventListener('click', () => { this.tabs[c.kind] = id; this.build(); });
        bar.append(b);
      }
      out.push(bar);
      body.append(...this.buildTab(c, cur));
    } else {
      body.append(...(c.kind === 'fx' ? this.buildFx() : this.buildAudio(c)));
    }
    out.push(body);
    this.root.replaceChildren(...out);
    this.refresh();
  }

  buildTab(c, tab) {
    if (c.kind === 'text') {
      if (tab === 'tekst') return this.textMain();
      if (tab === 'styl') return [...this.textStyle(), ...this.transformSec(true)];
      return this.textAnim();
    }
    if (tab === 'obraz') return [this.fitSec(), ...this.transformSec(false), this.lookSec()];
    if (tab === 'efekty') return this.fxSecs();
    if (tab === 'anim') return this.animSecs();
    if (tab === 'slowa') return [this.wordsSec()];
    return this.soundSecs(c);
  }

  // ---------------- słowa (co mówisz w klipie)
  wordsSec() {
    const box = h('div', { class: 'words-box' });
    const info = h('div', { class: 'muted', style: { fontSize: '12px' } });
    let spans = [];
    const fill = () => {
      const c = this.C();
      const m = c && this.app.media.get(c.mediaId);
      if (!m) return;
      if (!m.hasAudio) { box.replaceChildren(h('span', { class: 'muted' }, 'Ten klip nie ma dźwięku.')); info.textContent = ''; return; }
      if (!m.transcript || !m.transcript.segments) {
        const b = h('button', { class: 'btn sm primary' }, ic('audio-lines'), 'Rozpoznaj słowa');
        b.addEventListener('click', async () => {
          b.disabled = true;
          b.lastChild.textContent = 'Słucham…';
          info.textContent = 'Rozpoznaję mowę – za pierwszym razem pobiera się model mowy.';
          try { await transcribe(this.app, m, (t) => { info.textContent = t; }); fill(); } catch (e) { info.textContent = e.message; b.disabled = false; b.lastChild.textContent = 'Spróbuj jeszcze raz'; }
        });
        box.replaceChildren(b);
        info.textContent = 'Program wypisze słowa, które słychać w tym klipie. Kliknięcie słowa przenosi w to miejsce filmu.';
        spans = [];
        return;
      }
      const words = clipWords(c, m.transcript);
      spans = [];
      const kids = [];
      words.forEach((w, i) => {
        if (i && w.t0 - words[i - 1].t1 > 0.8) kids.push(h('span', { class: 'gap' }));
        const s = h('span', { class: w.prob != null && w.prob < 0.5 ? 'low' : '', title: w.prob != null && w.prob < 0.5 ? 'niepewne – sprawdź' : '' }, w.w);
        s.addEventListener('click', () => this.app.player.seek(w.t0 + 0.01));
        s._t0 = w.t0; s._t1 = (words[i + 1] ? Math.min(words[i + 1].t0, w.t1 + 0.3) : w.t1 + 0.3);
        spans.push(s);
        kids.push(s);
      });
      box.replaceChildren(...(kids.length ? kids : [h('span', { class: 'muted' }, 'Nie usłyszałem tu żadnych słów.')]));
      info.textContent = words.length ? `${words.length} słów • kliknij słowo, żeby przejść w to miejsce` : '';
    };
    let lastSig = '';
    this.updaters.push(() => {
      const c = this.C();
      const m = c && this.app.media.get(c.mediaId);
      const sig = c ? `${c.id}|${c.in}|${c.duration}|${c.start}|${c.speed}|${!!(m && m.transcript)}` : '';
      if (sig !== lastSig) { lastSig = sig; fill(); }
      const t = this.store.time;
      for (const s of spans) s.classList.toggle('now', t >= s._t0 && t < s._t1);
    });
    return this.sec('Słowa w tym klipie', 'audio-lines', [
      info, box,
      h('div', { class: 'btn-row' },
        this.btn('Zrób z nich napisy', 'captions', () => this.app.openCaptions(this.store.sel)),
        this.btn('Usuń powtórki', 'scissors-line-dashed', () => this.app.openRetakes(this.store.sel))),
    ]);
  }

  // ---------------- obraz / wideo
  fitSec() {
    return this.sec('Dopasowanie do kadru', 'crop', [
      this.seg('Kadr', { ...this.cp('fit'), options: [{ v: 'cover', label: 'Wypełnij' }, { v: 'contain', label: 'Zmieść' }, { v: 'fill', label: 'Rozciągnij' }] }),
      this.seg('Tło', { ...this.cp('bg'), options: [{ v: 'none', label: 'Brak' }, { v: 'blur', label: 'Rozmyte' }, { v: 'color', label: 'Kolor' }] }),
      this.when(this.color('Kolor tła', this.cp('bgColor')), () => this.C() && this.C().bg === 'color'),
      h('div', { class: 'tip' }, ic('lightbulb'), h('span', null, '„Zmieść” + „Rozmyte” to klasyczny wygląd poziomego filmu w pionowej rolce.')),
    ]);
  }
  transformSec(isText) {
    const posGrid = h('div', { class: 'pos-grid' });
    POS.forEach(([px, py], i) => {
      const b = h('button', { title: 'Ustaw pozycję' }, ic(POS_ICON[i]));
      b.addEventListener('click', () => {
        const c = this.C();
        if (!c) return;
        const lt = this.lt();
        setPropAt(c, 'x', px * (isText ? 0.27 : 0.25), lt, this.tol());
        setPropAt(c, 'y', py * (isText ? 0.33 : 0.25), lt, this.tol());
        this.commit();
      });
      posGrid.append(b);
    });
    const kids = [
      this.range('Pozycja X', { ...this.cp('x', { kf: true, mul: 100 }), min: -100, max: 100, step: 0.5, kf: 'x' }),
      this.range('Pozycja Y', { ...this.cp('y', { kf: true, mul: 100 }), min: -100, max: 100, step: 0.5, kf: 'y' }),
      this.range('Skala %', { ...this.cp('scale', { kf: true, mul: 100 }), min: 5, max: 400, step: 1, numMax: 2000, kf: 'scale' }),
      this.range('Obrót °', { ...this.cp('rotation', { kf: true }), min: -180, max: 180, step: 1, numMin: -3600, numMax: 3600, kf: 'rotation' }),
      this.range('Krycie %', { ...this.cp('opacity', { kf: true, mul: 100 }), min: 0, max: 100, step: 1, kf: 'opacity' }),
      h('div', { class: 'ctl two' }, h('label', null, 'Szybko'), posGrid),
    ];
    if (!isText) {
      kids.push(h('div', { class: 'btn-row' },
        this.btn('Odbij ↔', 'flip-horizontal-2', () => { const c = this.C(); c.flipH = !c.flipH; this.commit(); }),
        this.btn('Odbij ↕', 'flip-vertical-2', () => { const c = this.C(); c.flipV = !c.flipV; this.commit(); }),
        this.btn('Reset', 'rotate-ccw', () => { const c = this.C(); const main = c.trackId === 'main'; Object.assign(c, { x: 0, y: 0, scale: main ? 1 : 0.55, rotation: 0, opacity: 1, flipH: false, flipV: false }); for (const p of ['x', 'y', 'scale', 'rotation', 'opacity']) if (c.keyframes) delete c.keyframes[p]; this.commit(); }),
      ));
    }
    kids.push(this.kfNav());
    return [this.sec('Pozycja i rozmiar', 'move', kids)];
  }
  kfNav() {
    const info = h('span', { class: 'muted', style: { fontSize: '12px', flex: '1' } });
    const go = (dir) => {
      const c = this.C();
      if (!c) return;
      const ts = allKfTimes(c);
      const lt = this.lt();
      const t = dir > 0 ? ts.find((x) => x > lt + 0.01) : [...ts].reverse().find((x) => x < lt - 0.01);
      if (t != null) this.app.player.seek(c.start + t);
    };
    const row = h('div', { class: 'row' }, info,
      h('button', { class: 'icon-btn sm', title: 'Poprzednia klatka kluczowa', onclick: () => go(-1) }, ic('chevron-left')),
      h('button', { class: 'icon-btn sm', title: 'Następna klatka kluczowa', onclick: () => go(1) }, ic('chevron-right')),
      h('button', { class: 'icon-btn sm', title: 'Usuń wszystkie klatki kluczowe', onclick: () => { const c = this.C(); if (c) { for (const p of Object.keys(c.keyframes || {})) { c[p] = propAt(c, p, this.lt()); } c.keyframes = {}; this.commit(); } } }, ic('eraser')),
    );
    this.updaters.push(() => {
      const c = this.C();
      const n = c ? allKfTimes(c).length : 0;
      info.textContent = n ? `◆ klatki kluczowe: ${n}` : '◆ kliknij romb przy suwaku, aby animować';
    });
    return row;
  }
  lookSec() {
    return this.sec('Wygląd', 'square-dashed', [
      this.range('Zaokrąglenie', { ...this.cp('radius'), min: 0, max: 100, step: 1 }),
      this.range('Ramka', { ...this.cp('border'), min: 0, max: 40, step: 1 }),
      this.when(this.color('Kolor ramki', this.cp('borderColor')), () => this.C() && this.C().border > 0),
      this.range('Cień', { ...this.cp('shadow'), min: 0, max: 100, step: 1 }),
      this.when(this.color('Kolor cienia', this.cp('shadowColor')), () => this.C() && this.C().shadow > 0),
      this.select('Mieszanie', { ...this.cp('blend'), options: BLENDS.map((b) => [b.id, b.name]) }),
    ], false);
  }
  fxSecs() {
    const grid = h('div', { class: 'chips' });
    const btns = Object.entries(FILTERS).map(([id, f]) => {
      const b = h('button', null, f.name);
      b.addEventListener('click', () => { const c = this.C(); c.filter = c.filter || {}; c.filter.preset = id; this.commit(); });
      grid.append(b);
      return [id, b];
    });
    this.updaters.push(() => { const c = this.C(); const v = c && c.filter ? c.filter.preset : 'none'; for (const [id, b] of btns) b.classList.toggle('on', id === v); });
    const adj = (label, key, min, max) => this.range(label, { ...this.cp('filter.' + key), min, max, step: 1 });
    return [
      this.sec('Filtr', 'palette', [grid, h('div', { class: 'btn-row' }, this.btn('Ten filtr dla wszystkich klipów', 'copy', () => this.app.applyToAll('filter')))]),
      this.sec('Korekcja kolorów', 'sliders-horizontal', [
        adj('Jasność', 'brightness', -100, 100), adj('Kontrast', 'contrast', -100, 100), adj('Nasycenie', 'saturation', -100, 100),
        adj('Odcień', 'hue', -180, 180), adj('Temperatura', 'temp', -100, 100), adj('Winieta', 'vignette', 0, 100), adj('Rozmycie', 'blur', 0, 30),
        h('div', { class: 'btn-row' }, this.btn('Wyzeruj korekcję', 'rotate-ccw', () => { const c = this.C(); c.filter = { preset: (c.filter && c.filter.preset) || 'none', brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, temp: 0, vignette: 0 }; this.commit(); })),
      ]),
      this.sec('Zielony ekran (green screen)', 'wand-sparkles', [
        this.toggle('Włącz', this.cp('chroma.on')),
        this.color('Kolor do usunięcia', this.cp('chroma.color')),
        this.range('Tolerancja', { ...this.cp('chroma.sim', { mul: 100 }), min: 1, max: 90, step: 1 }),
        this.range('Wygładzenie', { ...this.cp('chroma.smooth', { mul: 100 }), min: 1, max: 50, step: 1 }),
        h('div', { class: 'tip' }, ic('lightbulb'), h('span', null, 'Połóż film z zielonym tłem na ścieżce nakładki (nad innym filmem) i włącz tę opcję.')),
      ], false),
    ];
  }
  transSec() {
    return this.sec('Przejście na początku klipu', 'arrow-right-left', [
      this.select('Rodzaj', { ...this.cp('transIn.type'), options: TRANSITIONS.map((t) => [t.id, t.name]) }),
      this.range('Czas (s)', { ...this.cp('transIn.dur'), min: 0.1, max: 3, step: 0.05 }),
      h('div', { class: 'btn-row' }, this.btn('Dla wszystkich klipów', 'copy', () => this.app.applyToAll('transIn'))),
    ]);
  }
  animSecs() {
    return [
      this.transSec(),
      this.sec('Ruch kamery', 'video', [
        this.chips({ ...this.cp('motion'), options: MOTIONS }),
        this.range('Siła', { ...this.cp('motionAmt', { mul: 100 }), min: 10, max: 300, step: 5 }),
      ]),
      this.sec('Pojawianie i znikanie', 'sunrise', [
        this.range('Pojawianie (s)', { ...this.cp('fadeIn'), min: 0, max: 5, step: 0.05 }),
        this.range('Znikanie (s)', { ...this.cp('fadeOut'), min: 0, max: 5, step: 0.05 }),
      ]),
    ];
  }
  speedSec() {
    const chips = h('div', { class: 'chips' });
    const opts = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
    const set = (s) => {
      const c = this.C();
      const m = this.app.media.get(c.mediaId);
      setSpeed(c, s);
      c.duration = Math.min(c.duration, maxDuration(c, m));
      repackMain(this.P());
    };
    const btns = opts.map((s) => { const b = h('button', null, `${s}×`); b.addEventListener('click', () => { set(s); this.commit(); }); chips.append(b); return [s, b]; });
    this.updaters.push(() => { const c = this.C(); for (const [s, b] of btns) b.classList.toggle('on', c && Math.abs((c.speed || 1) - s) < 1e-3); });
    return this.sec('Prędkość', 'gauge', [
      chips,
      this.range('Prędkość ×', { get: () => (this.C() ? this.C().speed || 1 : 1), set: (v) => set(v), min: 0.1, max: 8, step: 0.05 }),
      h('div', { class: 'tip' }, ic('lightbulb'), h('span', null, 'Zwolnienie (0.5×) daje efekt slow-motion, przyspieszenie – timelapse.')),
    ]);
  }
  soundSecs(c) {
    const m = this.app.media.get(c.mediaId);
    const out = [this.speedSec()];
    if (c.kind === 'video') {
      out.push(this.sec('Dźwięk klipu', 'volume-2', m && m.hasAudio ? [
        this.range('Głośność %', { ...this.cp('volume', { mul: 100 }), min: 0, max: 200, step: 1 }),
        this.toggle('Wycisz', this.cp('muted')),
        this.range('Narastanie (s)', { ...this.cp('aFadeIn'), min: 0, max: 5, step: 0.05 }),
        this.range('Wyciszanie (s)', { ...this.cp('aFadeOut'), min: 0, max: 5, step: 0.05 }),
        h('div', { class: 'btn-row' }, this.btn('Odłącz dźwięk na osobną ścieżkę', 'unlink', () => this.app.detachAudio())),
      ] : [h('div', { class: 'muted' }, 'Ten film nie ma dźwięku.')]));
    }
    return out;
  }

  // ---------------- efekt obrazu (zoom, obrót, trzęsienie…)
  buildFx() {
    return [
      this.sec('Efekt obrazu', 'zap', [
        this.select('Rodzaj', {
          get: () => this.C() && this.C().fx,
          set: (v) => { const c = this.C(); c.fx = v; c.name = FX_TYPES[v].name; },
          options: Object.entries(FX_TYPES).map(([k, f]) => [k, f.name]),
        }),
        this.range('Siła %', { ...this.cp('amt', { mul: 100 }), min: 20, max: 250, step: 5 }),
        this.range('Czas (s)', { ...this.cp('duration'), min: 0.15, max: 5, step: 0.05 }),
        this.seg('Kierunek', { ...this.cp('dir'), options: [{ v: 1, label: 'W prawo' }, { v: -1, label: 'W lewo' }] }),
        h('div', { class: 'tip' }, ic('lightbulb'), h('span', null, 'Efekt działa na główny obraz w czasie trwania tego klipu. Przesuń go na osi czasu, żeby zmienić moment.')),
        h('div', { class: 'btn-row' }, this.btn('Podgląd', 'play', () => { const c = this.C(); this.app.previewRange(Math.max(0, c.start - 0.4), c.start + c.duration + 0.4); })),
      ]),
    ];
  }

  // ---------------- audio
  buildAudio() {
    return [
      this.sec('Dźwięk', 'volume-2', [
        this.range('Głośność %', { ...this.cp('volume', { mul: 100 }), min: 0, max: 200, step: 1 }),
        this.toggle('Wycisz', this.cp('muted')),
        this.range('Narastanie (s)', { ...this.cp('aFadeIn'), min: 0, max: 10, step: 0.1 }),
        this.range('Wyciszanie (s)', { ...this.cp('aFadeOut'), min: 0, max: 10, step: 0.1 }),
        h('div', { class: 'tip' }, ic('lightbulb'), h('span', null, 'Muzykę przytnij przeciągając krawędzie klipu na osi czasu. „S” dzieli klip w miejscu głowicy.')),
      ]),
      this.speedSec(),
      this.wordsSec(),
    ];
  }

  // ---------------- tekst
  textMain() {
    const ta = h('textarea', { class: 'inp', rows: 3, spellcheck: 'false', placeholder: 'Wpisz tekst…' });
    ta.addEventListener('input', () => { const c = this.C(); if (c) { c.text = ta.value; this.changed(); } });
    ta.addEventListener('change', () => this.commit());
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    this.textArea = ta;
    this.updaters.push(() => { const c = this.C(); if (c && document.activeElement !== ta && ta.value !== c.text) ta.value = c.text; });
    const fontSel = this.select('Czcionka', {
      get: () => this.C() && this.C().font,
      set: (v) => { const c = this.C(); c.font = v; this.app.loadFont(c); },
      options: FONTS.map((f) => [f, f]),
    });
    fontSel.querySelectorAll('option').forEach((o) => { o.style.fontFamily = `"${o.value}"`; });
    return [
      this.sec('Treść', 'text-cursor-input', [ta]),
      this.sec('Czcionka', 'case-sensitive', [
        fontSel,
        this.seg('Grubość', { get: () => this.C() && this.C().weight, set: (v) => { this.C().weight = v; this.app.loadFont(this.C()); }, options: [{ v: 400, label: 'Zwykła' }, { v: 700, label: 'Gruba' }, { v: 900, label: 'Czarna' }] }),
        this.range('Rozmiar', { ...this.cp('size'), min: 12, max: 400, step: 1, numMax: 1500 }),
        this.seg('Wyrównanie', { ...this.cp('align'), options: [{ v: 'left', icon: 'align-left', title: 'Do lewej' }, { v: 'center', icon: 'align-center', title: 'Do środka' }, { v: 'right', icon: 'align-right', title: 'Do prawej' }] }),
        this.toggle('Kursywa', this.cp('italic')),
        this.toggle('WIELKIE LITERY', this.cp('upper')),
        this.range('Odstęp liter', { ...this.cp('spacing'), min: -10, max: 60, step: 1 }),
        this.range('Interlinia', { ...this.cp('lineH'), min: 0.7, max: 2.5, step: 0.05 }),
        this.range('Szerokość %', { ...this.cp('maxW', { mul: 100 }), min: 20, max: 100, step: 1 }),
      ]),
    ];
  }
  textStyle() {
    return [
      this.sec('Kolory', 'paintbrush', [
        this.color('Kolor tekstu', this.cp('color')),
        this.range('Obrys', { ...this.cp('strokeW'), min: 0, max: 30, step: 0.5 }),
        this.when(this.color('Kolor obrysu', this.cp('stroke')), () => this.C() && this.C().strokeW > 0),
        this.range('Cień / blask', { ...this.cp('shadow'), min: 0, max: 100, step: 1 }),
        this.when(this.color('Kolor cienia', this.cp('shadowColor')), () => this.C() && this.C().shadow > 0),
      ]),
      this.sec('Tło napisu', 'rectangle-horizontal', [
        this.range('Krycie tła %', { ...this.cp('boxAlpha', { mul: 100 }), min: 0, max: 100, step: 1 }),
        this.when(this.color('Kolor tła', this.cp('boxColor')), () => this.C() && this.C().boxAlpha > 0),
        this.when(this.range('Zaokrąglenie', { ...this.cp('boxRadius'), min: 0, max: 80, step: 1 }), () => this.C() && this.C().boxAlpha > 0),
        this.when(this.range('Margines', { ...this.cp('boxPad', { mul: 100 }), min: 0, max: 100, step: 1 }), () => this.C() && this.C().boxAlpha > 0),
      ], false),
    ];
  }
  textAnim() {
    return [
      this.sec('Wejście', 'log-in', [
        this.chips({ ...this.cp('animIn'), options: ANIM_IN }),
        this.when(this.color('Kolor podświetlenia', this.cp('hl')), () => this.C() && this.C().animIn === 'karaoke'),
      ]),
      this.sec('Wyjście', 'log-out', [this.chips({ ...this.cp('animOut'), options: ANIM_OUT })]),
      this.sec('Czas animacji', 'timer', [this.range('Długość (s)', { ...this.cp('animDur'), min: 0.1, max: 3, step: 0.05 })]),
      this.sec('Ciągły ruch', 'repeat', [this.chips({ ...this.cp('loop'), options: LOOPS })]),
      this.sec('Pojawianie i znikanie', 'sunrise', [
        this.range('Pojawianie (s)', { ...this.cp('fadeIn'), min: 0, max: 5, step: 0.05 }),
        this.range('Znikanie (s)', { ...this.cp('fadeOut'), min: 0, max: 5, step: 0.05 }),
      ], false),
      this.transSec(),
    ];
  }
  focusText() {
    const c = this.C();
    if (!c || c.kind !== 'text') return;
    if (this.tabs.text !== 'tekst') { this.tabs.text = 'tekst'; this.build(); }
    this.app.openInspector();
    setTimeout(() => { if (this.textArea) { this.textArea.focus(); this.textArea.select(); } }, 60);
  }

  // ---------------- projekt
  buildProject() {
    const P = this.P();
    const name = h('input', { class: 'inp', value: P.name, maxlength: 60 });
    name.addEventListener('input', () => { this.P().name = name.value; this.app.updateTitle(); });
    name.addEventListener('change', () => this.commit());
    name.addEventListener('keydown', (e) => e.stopPropagation());
    this.updaters.push(() => { if (document.activeElement !== name) name.value = this.P().name; });
    const info = h('div', { class: 'info-list' });
    this.updaters.push(() => {
      const PP = this.P();
      const dur = PP.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      info.replaceChildren(
        h('span', null, 'Długość'), h('span', null, fmtTime(dur)),
        h('span', null, 'Rozdzielczość'), h('span', null, `${PP.width} × ${PP.height}`),
        h('span', null, 'Klipy'), h('span', null, String(PP.clips.length)),
        h('span', null, 'Ścieżki'), h('span', null, String(PP.tracks.length)),
      );
    });
    return [
      h('div', { class: 'insp-head' }, h('div', { class: 'badge k-project' }, ic('clapperboard')), h('div', { class: 'ttl' }, h('b', null, 'Ustawienia projektu'), h('span', null, 'Zaznacz klip, aby go edytować')),
        h('button', { class: 'icon-btn sm mobile-only', title: 'Zamknij', onclick: () => this.app.closeSheets() }, ic('x'))),
      h('div', { class: 'insp-body' },
        this.sec('Projekt', 'settings', [
          h('div', { class: 'ctl two' }, h('label', null, 'Nazwa'), name),
          this.seg(null, {
            get: () => this.P().format,
            set: (f) => { const PP = this.P(); const F = FORMATS[f]; PP.format = f; PP.width = F.w; PP.height = F.h; },
            options: Object.entries(FORMATS).map(([k, f]) => ({ v: k, label: k, title: `${f.name} – ${f.desc}` })),
          }),
          this.seg('Klatki/s', { get: () => this.P().fps, set: (v) => { this.P().fps = v; }, options: [24, 25, 30, 50, 60].map((v) => ({ v, label: String(v) })) }),
          this.color('Kolor tła', { get: () => this.P().background, set: (v) => { this.P().background = v; } }),
          this.toggle('Magnes', { get: () => this.P().magnet, set: (v) => { this.P().magnet = v; repackMain(this.P()); } }),
          this.toggle('Przyciąganie', { get: () => this.P().snap, set: (v) => { this.P().snap = v; } }),
        ]),
        this.sec('Informacje', 'info', [info]),
        this.sec('Jak zacząć', 'graduation-cap', [
          h('div', { class: 'tip' }, ic('upload'), h('span', null, 'Zaimportuj filmy i zdjęcia (lub przeciągnij je do okna). Plusik na miniaturze dodaje klip na koniec.')),
          h('div', { class: 'tip' }, ic('scissors'), h('span', null, 'Ustaw głowicę i naciśnij S, żeby przeciąć klip. Krawędzie klipu przeciągaj, żeby go skrócić.')),
          h('div', { class: 'tip' }, ic('type'), h('span', null, 'Napisy, naklejki, przejścia i filtry znajdziesz w zakładkach po lewej.')),
          h('div', { class: 'tip' }, ic('download'), h('span', null, 'Gotowe? Kliknij „Eksportuj” – film MP4 trafi do folderu Filmy.')),
          h('div', { class: 'btn-row' }, this.btn('Skróty klawiszowe', 'keyboard', () => this.app.showHelp())),
        ]),
      ),
    ];
  }
}
