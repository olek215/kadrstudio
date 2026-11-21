// Biblioteka po lewej: media, napisy, naklejki, dźwięki, przejścia, filtry.
import { h, ic, fmtDur, debounce } from './util.js';
import { TEXT_PRESETS, STICKERS, TRANSITIONS, FILTERS, FX_TYPES } from './catalog.js';
import { SOUNDS, BEATS, synthSound, synthBeat } from './audio.js';
import { filterCss } from './renderer.js';

const TABS = [
  { id: 'media', name: 'Media', icon: 'film' },
  { id: 'text', name: 'Tekst', icon: 'type' },
  { id: 'stickers', name: 'Naklejki', icon: 'smile-plus' },
  { id: 'audio', name: 'Dźwięki', icon: 'music' },
  { id: 'trans', name: 'Przejścia', icon: 'arrow-right-left' },
  { id: 'filters', name: 'Filtry', icon: 'palette' },
];

const TR_ANIM = {
  none: '', fade: 'opacity:0}to{opacity:1', black: 'opacity:0;filter:brightness(0)}50%{opacity:1;filter:brightness(0)}to{opacity:1;filter:none',
  white: 'opacity:0;filter:brightness(3)}50%{opacity:1;filter:brightness(3)}to{opacity:1;filter:none',
  slideleft: 'transform:translateX(100%)}to{transform:none', slideright: 'transform:translateX(-100%)}to{transform:none',
  slideup: 'transform:translateY(100%)}to{transform:none', slidedown: 'transform:translateY(-100%)}to{transform:none',
  zoomin: 'transform:scale(.6);opacity:0}to{transform:none;opacity:1', zoomout: 'transform:scale(1.8);opacity:0}to{transform:none;opacity:1',
  wipeleft: 'clip-path:inset(0 0 0 100%)}to{clip-path:inset(0)', wipeup: 'clip-path:inset(100% 0 0 0)}to{clip-path:inset(0)',
  circle: 'clip-path:circle(0% at 50% 50%)}to{clip-path:circle(75% at 50% 50%)', blur: 'filter:blur(12px);opacity:0}to{filter:none;opacity:1',
  spin: 'transform:rotate(-120deg) scale(.4);opacity:0}to{transform:none;opacity:1',
  glitch: 'transform:translateX(8px);opacity:0}20%{transform:translateX(-6px);opacity:1}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}to{transform:none',
};
let styleInjected = false;
function injectStyles() {
  if (styleInjected) return;
  styleInjected = true;
  let css = '';
  for (const [id, kf] of Object.entries(TR_ANIM)) {
    if (!kf) continue;
    css += `@keyframes tr-${id}{from{${kf}}}.fx-card:hover .tr-b.t-${id},.fx-card.on .tr-b.t-${id}{animation:tr-${id} 1.1s ease-in-out infinite alternate}`;
  }
  css += '.tr-b{opacity:.0}.fx-card:hover .tr-b,.fx-card.on .tr-b{opacity:1}.tr-b.t-none{opacity:0!important}';
  document.head.append(h('style', null, css));
}

export class Library {
  constructor(railEl, panelEl, app) {
    this.rail = railEl;
    this.panel = panelEl;
    this.app = app;
    this.tab = 'media';
    this.synthCache = new Map();
    this.previewAudio = null;
    injectStyles();
    for (const t of TABS) {
      const b = h('button', { 'data-tab': t.id }, ic(t.icon), t.name);
      b.addEventListener('click', () => this.show(t.id));
      this.rail.append(b);
    }
    const rr = debounce(() => { if (this.tab === 'media') this.render(); }, 120);
    app.media.onChange(rr);
    app.store.on('select', () => { if (this.tab === 'filters' || this.tab === 'trans') this.render(); });
    app.store.on('commit', () => { if (this.tab === 'filters' || this.tab === 'trans') this.updateOn(); if (this.tab === 'media') rr(); });
    app.store.on('load', () => this.render());
  }

  show(tab) {
    this.tab = tab;
    for (const b of this.rail.children) b.classList.toggle('on', b.dataset.tab === tab);
    this.render();
  }

  render() {
    if (!this.app.store.project) return;
    const fn = { media: this.renderMedia, text: this.renderText, stickers: this.renderStickers, audio: this.renderAudio, trans: this.renderTrans, filters: this.renderFilters }[this.tab];
    const top = this.panel.scrollTop;
    this.panel.replaceChildren(...fn.call(this).filter(Boolean));
    this.panel.scrollTop = top;
    this.updateOn();
  }

  drag(el, data) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-kadr', JSON.stringify(data));
      e.dataTransfer.effectAllowed = 'copy';
    });
    return el;
  }

  // ------------------------------------------------------------ media
  renderMedia() {
    const A = this.app;
    const list = A.media.list(A.store.project.id);
    const used = new Set(A.store.project.clips.map((c) => c.mediaId));
    const grid = h('div', { class: 'media-grid' });
    for (const m of list) {
      const card = h('div', { class: `media-card${m.status === 'loading' ? ' loading' : ''}${m.status === 'error' ? ' error' : ''}${used.has(m.id) ? ' used' : ''}`, title: `${m.name}\n${m.width ? m.width + '×' + m.height : ''}` },
        h('div', { class: 'thumb', style: m.thumb ? { backgroundImage: `url(${m.thumb})` } : null }, m.thumb || m.status === 'loading' ? null : ic(m.type === 'audio' ? 'audio-waveform' : m.type === 'image' ? 'image' : 'film')),
        h('span', { class: 'type' }, ic(m.type === 'audio' ? 'music' : m.type === 'image' ? 'image' : 'film')),
        m.type !== 'image' && m.duration ? h('span', { class: 'dur' }, fmtDur(m.duration)) : null,
        h('div', { class: 'name' }, m.name),
        m.status === 'ready' ? h('button', { class: 'add', title: 'Dodaj na oś czasu', onclick: (e) => { e.stopPropagation(); A.addMedia(m.id); } }, ic('plus')) : null,
        h('button', { class: 'rm', title: 'Usuń z projektu', onclick: (e) => { e.stopPropagation(); A.removeMedia(m.id); } }, ic('trash-2')),
      );
      if (m.status === 'ready') {
        this.drag(card, { type: 'media', id: m.id });
        card.addEventListener('dblclick', () => A.addMedia(m.id));
      }
      grid.append(card);
    }
    const acts = h('div', { class: 'lib-actions' },
      h('button', { class: 'btn primary', onclick: () => A.pickFiles() }, ic('upload'), 'Importuj'),
      h('button', { class: 'btn', onclick: () => A.recordVoice() }, ic('mic'), 'Lektor'),
    );
    if (A.server) acts.append(h('button', { class: 'btn', title: 'Wczytaj przykładowe filmy do testów', onclick: () => A.loadSamples() }, ic('package-open'), 'Przykłady'));
    return [
      h('button', { class: 'btn block auto-btn big-auto', onclick: () => A.openAuto() }, ic('wand-sparkles'), h('span', null, 'Auto-montaż – film złoży się sam')),
      acts,
      list.length ? null : h('div', { class: 'drop-hint' }, ic('folder-up'), 'Przeciągnij tu filmy, zdjęcia i muzykę', h('br'), h('span', { class: 'muted' }, 'MP4, MOV, WEBM, JPG, PNG, MP3, WAV…')),
      list.length ? h('h3', null, `W projekcie (${list.length})`) : null,
      grid,
    ];
  }

  // ------------------------------------------------------------ tekst
  renderText() {
    const A = this.app;
    const grid = h('div', { class: 'preset-grid' });
    TEXT_PRESETS.forEach((p, i) => {
      const span = h('span', { style: p.css });
      if (p.html) span.innerHTML = p.html; else span.textContent = p.p.text.split('\n')[0];
      const card = h('div', { class: 'text-preset', title: 'Kliknij, aby dodać w miejscu głowicy' }, h('div', null, span, h('small', null, p.label)));
      card.addEventListener('click', () => A.addText(p.p));
      grid.append(this.drag(card, { type: 'text', i }));
    });
    return [
      h('button', { class: 'btn block auto-btn big-auto', onclick: () => A.openCaptions() }, ic('captions'), h('span', null, 'Napisy z mowy – same się wpiszą')),
      h('div', { class: 'lib-actions' }, h('button', { class: 'btn primary', onclick: () => A.addText({ animIn: 'fade' }) }, ic('plus'), 'Zwykły tekst')),
      h('h3', null, 'Gotowe style'),
      grid,
    ];
  }

  renderStickers() {
    const A = this.app;
    const out = [h('div', { class: 'tip' }, ic('lightbulb'), h('span', null, 'Naklejkę możesz potem przesunąć i powiększyć prosto na podglądzie.'))];
    for (const [cat, list] of Object.entries(STICKERS)) {
      out.push(h('h3', null, cat));
      const g = h('div', { class: 'sticker-grid' });
      for (const ch of list) {
        const b = h('div', { class: 'sticker', title: 'Dodaj naklejkę' }, ch);
        b.addEventListener('click', () => A.addSticker(ch));
        g.append(this.drag(b, { type: 'sticker', ch }));
      }
      out.push(g);
    }
    return out;
  }

  // ------------------------------------------------------------ dźwięki
  async getSynth(def, beat) {
    let f = this.synthCache.get(def.id);
    if (!f) { f = beat ? await synthBeat(def) : await synthSound(def); this.synthCache.set(def.id, f); }
    return f;
  }
  async preview(def, beat, btn) {
    if (this.previewAudio) { this.previewAudio.pause(); URL.revokeObjectURL(this.previewAudio.src); const same = this.previewAudio._id === def.id; this.previewAudio = null; this.panel.querySelectorAll('.playing').forEach((b) => b.classList.remove('playing', 'on')); if (same) return; }
    const f = await this.getSynth(def, beat);
    const a = new Audio(URL.createObjectURL(f));
    a._id = def.id;
    this.previewAudio = a;
    btn.classList.add('playing', 'on');
    a.onended = () => { btn.classList.remove('playing', 'on'); if (this.previewAudio === a) this.previewAudio = null; };
    a.play().catch(() => {});
  }
  renderAudio() {
    const A = this.app;
    const item = (def, beat) => {
      const play = h('button', { class: 'icon-btn sm', title: 'Odsłuchaj' }, ic('play'));
      play.addEventListener('click', () => this.preview(def, beat, play));
      const add = h('button', { class: 'icon-btn sm', title: 'Dodaj w miejscu głowicy' }, ic('plus'));
      add.addEventListener('click', async () => { const f = await this.getSynth(def, beat); A.addAudioFile(f, beat ? 0 : null); });
      return h('div', { class: 'sound-item' }, h('div', { class: `ic${beat ? ' beat' : ''}` }, ic(beat ? 'audio-lines' : 'zap')), h('div', { class: 'nm' }, h('b', null, def.name), h('span', null, def.desc)), play, add);
    };
    return [
      h('div', { class: 'lib-actions' }, h('button', { class: 'btn', onclick: () => A.pickFiles('audio/*') }, ic('upload'), 'Własna muzyka'), h('button', { class: 'btn', onclick: () => A.recordVoice() }, ic('mic'), 'Nagraj lektora')),
      h('button', { class: 'btn block auto-btn big-auto', onclick: () => A.openSpeechFx() }, ic('sparkles'), h('span', null, 'Efekty z mowy – dźwięki same się dodadzą')),
      h('div', { class: 'tip' }, ic('shield-check'), h('span', null, 'Bity i efekty są generowane w programie – możesz ich używać bez obaw o prawa autorskie.')),
      h('h3', null, 'Muzyka (bity)'),
      h('div', { class: 'sound-list' }, BEATS.map((b) => item(b, true))),
      h('h3', null, 'Efekty dźwiękowe'),
      h('div', { class: 'sound-list' }, SOUNDS.map((s) => item(s, false))),
    ];
  }

  // ------------------------------------------------------------ przejścia
  renderTrans() {
    const A = this.app;
    const c = A.store.selected;
    const grid = h('div', { class: 'fx-grid' });
    this.onBtns = [];
    for (const t of TRANSITIONS) {
      const card = h('div', { class: 'fx-card', title: t.name }, h('div', { class: 'pv' }, h('div', { class: 'tr-a' }), h('div', { class: `tr-b t-${t.id}` })), h('div', { class: 'lbl' }, t.name));
      card.addEventListener('click', () => A.applyTransition(t.id));
      grid.append(card);
      this.onBtns.push(['trans', t.id, card]);
    }
    const fxGrid = h('div', { class: 'chips' }, Object.entries(FX_TYPES).map(([id, f]) => {
      const b = h('button', { title: 'Dodaj w miejscu głowicy' }, f.name);
      b.addEventListener('click', () => A.addFx(id));
      return b;
    }));
    return [
      h('h3', null, 'Efekty obrazu (w dowolnej chwili)'),
      h('div', { class: 'tip' }, ic('zap'), h('span', null, 'Zoom, obrót, trzęsienie albo błysk w miejscu głowicy – np. na mocne słowo. Program może je dodać sam: „Efekty z mowy”.')),
      fxGrid,
      h('div', { class: 'lib-actions', style: { marginTop: '10px' } }, h('button', { class: 'btn auto-btn', onclick: () => A.openSpeechFx() }, ic('sparkles'), 'Efekty z mowy')),
      h('h3', null, 'Przejścia między klipami'),
      h('div', { class: 'tip' }, ic('lightbulb'), h('span', null, c && c.kind !== 'audio' ? `Przejście zostanie dodane na początku zaznaczonego klipu („${c.kind === 'text' ? c.text.slice(0, 20) : c.name}”).` : 'Zaznacz klip na osi czasu – przejście pojawi się na jego początku.')),
      grid,
      h('div', { class: 'lib-actions', style: { marginTop: '14px' } }, h('button', { class: 'btn', onclick: () => A.applyToAll('transIn') }, ic('copy'), 'Użyj dla wszystkich klipów')),
    ];
  }

  // ------------------------------------------------------------ filtry
  previewSource() {
    const A = this.app;
    const c = A.store.selected;
    const pick = (m) => m && m.thumbs && m.thumbs.length ? m.thumbs[Math.floor(m.thumbs.length / 2)].c : null;
    let src = c && c.mediaId ? pick(A.media.get(c.mediaId)) : null;
    if (!src) for (const m of A.media.list(A.store.project.id)) { src = pick(m); if (src && m.type !== 'audio') break; }
    if (!src) {
      src = h('canvas', { width: 120, height: 120 });
      const g = src.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 120, 120);
      gr.addColorStop(0, '#ff9a3c'); gr.addColorStop(0.5, '#ec4899'); gr.addColorStop(1, '#3b6ff0');
      g.fillStyle = gr; g.fillRect(0, 0, 120, 120);
      g.fillStyle = '#ffe9b0'; g.beginPath(); g.arc(80, 40, 18, 0, 7); g.fill();
      g.fillStyle = '#1b2a4a'; g.beginPath(); g.moveTo(0, 120); g.lineTo(40, 70); g.lineTo(70, 100); g.lineTo(95, 80); g.lineTo(120, 120); g.fill();
    }
    return src;
  }
  renderFilters() {
    const A = this.app;
    const src = this.previewSource();
    const grid = h('div', { class: 'fx-grid' });
    this.onBtns = [];
    for (const [id, f] of Object.entries(FILTERS)) {
      const cv = h('canvas', { width: 120, height: 120 });
      const g = cv.getContext('2d');
      const s = Math.max(120 / src.width, 120 / src.height);
      g.filter = filterCss({ preset: id }) || 'none';
      g.drawImage(src, (120 - src.width * s) / 2, (120 - src.height * s) / 2, src.width * s, src.height * s);
      g.filter = 'none';
      if (f.tint) { g.globalCompositeOperation = 'source-atop'; g.globalAlpha = f.tint[1]; g.fillStyle = f.tint[0]; g.fillRect(0, 0, 120, 120); g.globalAlpha = 1; }
      if (f.vignette) { const gr = g.createRadialGradient(60, 60, 30, 60, 60, 85); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${f.vignette * 0.85})`); g.globalCompositeOperation = 'source-atop'; g.fillStyle = gr; g.fillRect(0, 0, 120, 120); }
      const card = h('div', { class: 'fx-card', title: f.name }, h('div', { class: 'pv' }, cv), h('div', { class: 'lbl' }, f.name));
      card.addEventListener('click', () => A.applyFilter(id));
      grid.append(card);
      this.onBtns.push(['filter', id, card]);
    }
    const c = A.store.selected;
    return [
      h('div', { class: 'tip' }, ic('lightbulb'), h('span', null, c && (c.kind === 'video' || c.kind === 'image') ? 'Kliknij filtr, aby nałożyć go na zaznaczony klip. Dokładne suwaki są w panelu po prawej (Efekty).' : 'Zaznacz film lub zdjęcie na osi czasu, a potem wybierz filtr.')),
      grid,
      h('div', { class: 'lib-actions', style: { marginTop: '14px' } }, h('button', { class: 'btn', onclick: () => A.applyToAll('filter') }, ic('copy'), 'Użyj dla wszystkich klipów')),
    ];
  }

  updateOn() {
    if (!this.onBtns) return;
    const c = this.app.store.selected;
    for (const [kind, id, el] of this.onBtns) {
      if (!el.isConnected) continue;
      const v = kind === 'filter' ? (c && c.filter ? c.filter.preset : null) : (c && c.transIn ? c.transIn.type : null);
      el.classList.toggle('on', v === id);
    }
  }
}
