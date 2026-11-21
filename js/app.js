// KadrStudio – główny plik: łączy wszystkie części i obsługuje akcje użytkownika.
import { $, $$, h, ic, hydrateIcons, clamp, debounce, isTyping, fmtTime, downloadBlob, uid, deep } from './util.js';
import { db, persistStorage } from './db.js';
import { Store } from './store.js';
import {
  FORMATS, newProject, makeMediaClip, makeTextClip, getTrack, findTrackFor, insertIntoMain, addTrack, normalize,
  splitClip, duplicateClip, projectDuration, clipEnd, repackMain, MIN_DUR,
} from './model.js';
import { TEXT_PRESETS } from './catalog.js';
import { MediaManager } from './media.js';
import { Renderer } from './renderer.js';
import { VideoPool, Player } from './player.js';
import { Stage } from './stage.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { Library } from './library.js';
import { openExport } from './exporter.js';
import { openAutoMontage } from './automontage.js';
import { openRetakes } from './retakes.js';
import { openCaptions } from './captions.js';
import { openSpeechFx } from './speechfx.js';
import { FX_TYPES } from './catalog.js';
import { makeFxClip } from './model.js';
import { toast, modal, confirmBox, contextMenu } from './ui.js';

let AC = null;
const getAudioCtx = () => AC || (AC = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' }));
const isMobile = () => matchMedia('(max-width: 900px)').matches;
const VISUAL_KEYS = ['fit', 'bg', 'bgColor', 'x', 'y', 'scale', 'rotation', 'opacity', 'flipH', 'flipV', 'radius', 'border', 'borderColor', 'shadow', 'shadowColor', 'blend', 'filter', 'chroma'];

class App {
  constructor() {
    hydrateIcons();
    this.store = new Store();
    this.media = new MediaManager(getAudioCtx);
    this.server = null;
    this.exporting = false;
    this.clipboard = null;
    this.pool = new VideoPool(this.media, () => { this.player.dirty = true; });
    this.renderer = new Renderer($('#preview'), { media: this.media, videoOf: (c) => this.pool.get(c.id) });
    this.player = new Player({ store: this.store, media: this.media, renderer: this.renderer, pool: this.pool, getAudioCtx });
    this.stage = new Stage(this);
    this.player.onRender = () => this.stage.drawOverlay();
    this.player.onState = () => this.stage.setPlaying(this.player.playing);
    this.timeline = new Timeline($('#timeline'), this);
    this.inspector = new Inspector($('#inspector'), this);
    this.library = new Library($('#lib-rail'), $('#lib-panel'), this);
    this.autosave = debounce(() => this.save(), 800);
    this.store.on('change', () => this.player.projectChanged());
    this.store.on('select', () => { this.player.dirty = true; this.stage.drawOverlay(); });
    this.store.on('commit', () => { $('#save-state').textContent = 'Zapisywanie…'; this.autosave(); this.updateUndo(); });
    this.store.on('history', () => this.updateUndo());
    this.media.onChange(() => { this.player.dirty = true; });
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => { this.renderer.layoutCache.clear(); this.player.dirty = true; });
    this.bindUI();
    this.bindKeys();
    this.bindDrop();
    this.setupInstall();
    persistStorage();
    this.checkServer();
    this.showStart();
    window.addEventListener('beforeunload', () => { if (this.store.project) this.autosave.flush(); });
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // ------------------------------------------------------------ serwer
  async checkServer() {
    try {
      const r = await fetch('/api/ping', { cache: 'no-store' });
      const j = await r.json();
      if (j && j.app === 'KadrStudio') { this.server = j; this.media.server = j; if (this.store.project) this.library.render(); }
    } catch { this.server = null; }
    if (this.media.useServer && !this.media._migAllDone) {
      this.media.migrateAll().then((n) => { if (n) toast(`Przeniesiono ${n} plików z dysku C: na D: (folder KadrStudio\\Projekty).`, 'ok', 6000); });
    }
    // przycisk „na telefon” – tylko na tym komputerze, gdy jest strona z kodem QR
    if (this.server && this.server.local !== false && !isMobile()) {
      try {
        const r = await fetch('telefon.html', { method: 'HEAD', cache: 'no-store' });
        if (r.ok) $('#btn-phone').classList.remove('hidden');
      } catch { /* brak strony */ }
    }
  }
  get serverLocal() { return !!(this.server && this.server.local !== false); }

  // Instalacja jako aplikacja na telefonie (Android: przycisk „Zainstaluj”, iPhone: instrukcja).
  setupInstall() {
    const card = $('#install-card'), btn = $('#btn-install'), hint = $('#install-hint');
    const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    if (installed) return;
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const phone = ios || /Android|Mobile/i.test(ua);
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      if (!phone) return; // na komputerze jest skrót na pulpicie
      btn.classList.remove('hidden');
      hint.textContent = 'Ikona na ekranie telefonu, otwiera się bez paska przeglądarki i działa nawet bez laptopa.';
      card.classList.remove('hidden');
    });
    window.addEventListener('appinstalled', () => {
      card.classList.add('hidden');
      toast('Zainstalowano! Ikona KadrStudio jest na ekranie telefonu.', 'ok', 6000);
    });
    btn.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      const r = await deferred.userChoice.catch(() => null);
      deferred = null;
      if (r && r.outcome === 'accepted') card.classList.add('hidden');
    });
    if (ios) {
      btn.classList.add('hidden');
      hint.textContent = 'W Safari stuknij „Udostępnij” (kwadrat ze strzałką) → „Do ekranu początkowego”.';
      card.classList.remove('hidden');
    } else if (phone) {
      setTimeout(() => {
        if (deferred) return;
        btn.classList.add('hidden');
        hint.textContent = 'W Chrome stuknij ⋮ (trzy kropki u góry) → „Zainstaluj aplikację” albo „Dodaj do ekranu głównego”.';
        card.classList.remove('hidden');
      }, 4000);
    }
  }

  // ------------------------------------------------------------ ekran startowy i projekty
  async showStart() {
    this.player.pause();
    if (this.store.project) { this.autosave.flush(); await this.save(); }
    $('#editor').classList.add('hidden');
    $('#start').classList.remove('hidden');
    document.title = 'KadrStudio';
    const fc = $('#format-cards');
    if (!fc.children.length) {
      for (const [key, f] of Object.entries(FORMATS)) {
        const ar = f.w / f.h;
        const sw = ar >= 1 ? 64 : 64 * ar, sh = ar >= 1 ? 64 / ar : 64;
        const card = h('button', { class: 'format-card' },
          h('span', { class: 'ratio' }, key),
          h('div', { style: { height: '66px', display: 'grid', placeItems: 'center' } }, h('div', { class: 'shape', style: { width: sw + 'px', height: sh + 'px' } }, ic(f.icon))),
          h('b', null, f.name), h('span', null, f.desc));
        card.addEventListener('click', () => this.createProject(key));
        fc.append(card);
      }
    }
    await this.renderProjectList();
  }
  async renderProjectList() {
    const list = (await db.all('projects')).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const el = $('#project-list');
    $('#proj-count').textContent = list.length ? `(${list.length})` : '';
    if (!list.length) { el.replaceChildren(h('div', { class: 'empty-projects' }, 'Nie masz jeszcze projektów. Wybierz format powyżej, żeby zacząć!')); return; }
    el.replaceChildren(...list.map((p) => {
      const del = h('button', { class: 'icon-btn sm del', title: 'Usuń projekt' }, ic('trash-2'));
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (await confirmBox('Usunąć projekt?', `Projekt „${p.name}” i jego pliki zostaną usunięte z programu (oryginały na dysku zostają).`, 'Usuń', true)) {
          await db.deleteProject(p.id);
          if (this.serverLocal) fetch(`/api/project-delete?project=${encodeURIComponent(p.id)}`, { method: 'POST', headers: { 'X-Kadr': '1' } }).catch(() => {});
          this.renderProjectList();
        }
      });
      const d = new Date(p.updated || Date.now());
      const card = h('div', { class: 'project-card' },
        h('div', { class: 'thumb', style: p.thumb ? { backgroundImage: `url(${p.thumb})` } : null }, p.thumb ? null : ic('film')),
        h('div', { class: 'meta' }, h('b', null, p.name || 'Bez nazwy'), h('span', null, `${p.format || ''} • ${fmtTime(p.duration || 0, 0)} • ${d.toLocaleDateString('pl-PL')} ${d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`)),
        del);
      card.addEventListener('click', () => this.openProject(p.id));
      return card;
    }));
  }
  async createProject(format, prefix = 'Mój film') {
    const n = (await db.all('projects')).length + 1;
    const P = newProject(`${prefix} ${n}`, format);
    await db.put('projects', { id: P.id, name: P.name, format, updated: Date.now(), thumb: null, duration: 0, data: P });
    await this.loadProject(P);
    this.library.show('media');
  }
  async openProject(id) {
    const rec = await db.get('projects', id);
    if (!rec) { toast('Nie znaleziono projektu', 'err'); return; }
    await this.loadProject(rec.data);
  }
  async loadProject(P) {
    this.player.pause();
    this.pool.destroy();
    this.media.clear();
    for (const t of P.tracks) if (!t.kind) t.kind = 'video';
    this.store.load(P);
    this.showEditor();
    if (!this.server) await this.checkServer();
    const recs = await db.mediaOf(P.id);
    this.media.migrated = 0;
    await Promise.all(recs.map((r) => this.media.loadRecord(r)));
    for (const c of P.clips) if (c.kind === 'text') this.loadFont(c);
    this.timeline.fit();
    this.player.dirty = true;
    if (this.media._mig) {
      await this.media._mig;
      if (this.media.migrated) toast(`Przeniesiono pliki projektu na dysk D: (${this.media.migrated}) – mniej zajętego miejsca na C:.`, 'ok', 5000);
    }
  }
  showEditor() {
    $('#start').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    this.updateTitle();
    this.updateUndo();
    $('#save-state').textContent = 'Zapisano';
    this.stage.layout(true);
    this.timeline.render();
    this.inspector.build();
    this.library.show(this.library.tab || 'media');
  }
  updateTitle() {
    const P = this.store.project;
    if (!P) return;
    document.title = `${P.name} – KadrStudio`;
    const inp = $('#project-name');
    if (document.activeElement !== inp) inp.value = P.name;
  }
  async save() {
    const P = this.store.project;
    if (!P) return;
    P.updated = Date.now();
    let thumb = null;
    try { thumb = this.makeThumb(); } catch { /* bez miniatury */ }
    try {
      await db.put('projects', { id: P.id, name: P.name, format: P.format, updated: P.updated, thumb, duration: projectDuration(P), data: JSON.parse(JSON.stringify(P)) });
      $('#save-state').textContent = 'Zapisano';
    } catch (e) {
      $('#save-state').textContent = 'Błąd zapisu!';
      console.error(e);
    }
  }
  makeThumb() {
    const c = $('#preview');
    if (!c.width) return null;
    const t = document.createElement('canvas');
    const s = 260 / Math.max(c.width, c.height);
    t.width = Math.round(c.width * s);
    t.height = Math.round(c.height * s);
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.72);
  }

  // ------------------------------------------------------------ historia
  changed() { this.store.changed(); }
  commit() { if (this.store.project) { normalize(this.store.project); this.store.commit(); } }
  undo() { if (this.store.undo()) toast('Cofnięto', 'info', 1200); }
  redo() { if (this.store.redo()) toast('Ponowiono', 'info', 1200); }
  updateUndo() {
    $('#btn-undo').disabled = !this.store.undoStack.length;
    $('#btn-redo').disabled = !this.store.redoStack.length;
  }

  // ------------------------------------------------------------ import
  pickFiles(accept) {
    this.pickFilesAsync(accept).then((files) => { if (files.length) this.importFiles(files, null); });
  }
  pickFilesAsync(accept) {
    return new Promise((res) => {
      const fi = $('#file-input');
      fi.accept = accept || 'video/*,image/*,audio/*,.mkv,.mov,.avi,.m4a,.mp3,.wav,.ogg,.flac';
      fi.value = '';
      fi.onchange = () => res([...fi.files]);
      fi.oncancel = () => res([]);
      fi.click();
    });
  }
  // „Zrób film automatycznie” z ekranu startowego: wybierz pliki -> nowy projekt -> auto-montaż
  async autoStart(format) {
    const files = await this.pickFilesAsync('video/*,image/*,audio/*,.mov,.mkv,.m4a,.mp3,.wav');
    if (!files.length) return;
    await this.createProject(format, 'Auto-film');
    await this.importFiles(files, null, { noAutoAdd: true, quiet: true });
    if (this.media.list(this.store.project.id).some((m) => m.type !== 'audio')) openAutoMontage(this);
  }
  openAuto() {
    const P = this.store.project;
    if (!P) return;
    this.closeSheets();
    if (!this.media.list(P.id).some((m) => m.type !== 'audio')) {
      toast('Najpierw wybierz filmy lub zdjęcia – resztę zrobię sam.');
      this.pickFilesAsync('video/*,image/*,audio/*').then(async (files) => {
        if (!files.length) return;
        await this.importFiles(files, null, { noAutoAdd: true, quiet: true });
        openAutoMontage(this);
      });
      return;
    }
    openAutoMontage(this);
  }
  openRetakes(clipId) { this.closeSheets(); return openRetakes(this, clipId); }
  openCaptions(clipId) { this.closeSheets(); return openCaptions(this, clipId); }
  openSpeechFx(clipId) { this.closeSheets(); return openSpeechFx(this, clipId); }
  addFx(type, time) {
    const P = this.store.project;
    const c = makeFxClip(null, time != null ? time : this.store.time, type, FX_TYPES[type]);
    P.clips.push(c);
    c.trackId = findTrackFor(P, c, null).id;
    this.store.select(c.id);
    this.commit();
    this.previewRange(Math.max(0, c.start - 0.4), c.start + c.duration + 0.4);
  }
  afterAutoMontage(res, again) {
    this.store.select(null);
    this.commit();
    this.timeline.fit();
    this.player.seek(0);
    this.player.play();
    const info = [`${res.cuts} ujęć`, fmtTime(res.duration, 0), res.bpm ? `rytm ${res.bpm} BPM` : null, ...(res.extra || [])].filter(Boolean).join(' • ');
    toast(`Film gotowy! ${info}`, 'ok', 12000, [
      { label: 'Inna wersja', icon: 'dices', run: () => again() },
      { label: 'Eksportuj', icon: 'download', run: () => openExport(this) },
    ]);
  }
  async importFiles(files, where, opts = {}) {
    const P = this.store.project;
    if (!P) return;
    const autoAdd = !where && P.clips.length === 0 && !opts.noAutoAdd;
    let w = where ? { ...where } : null;
    let ok = 0;
    if (this.library.tab !== 'media' && !where) this.library.show('media');
    for (const f of files) {
      if (!MediaManager.typeOf(f)) { toast(`Pominięto nieobsługiwany plik: ${f.name}`, 'err'); continue; }
      try {
        const m = await this.media.importFile(f, P.id, (msg) => toast(msg, 'info', 6000));
        ok++;
        if (m.converted) toast(`Przekonwertowano „${m.name}”`, 'ok');
        if (w) {
          const c = this.addMedia(m.id, w, true);
          if (c) w = { ...w, time: clipEnd(c), toNew: false, trackId: c.trackId };
        } else if (autoAdd) this.addMedia(m.id, {}, true);
      } catch (e) {
        console.error(e);
        toast(e.message || `Nie udało się dodać ${f.name}`, 'err', 5000);
      }
    }
    if (ok) {
      this.commit();
      if (autoAdd || where) this.timeline.fit();
      if (!autoAdd && !where && !opts.quiet) toast(`Dodano do biblioteki: ${ok}. Kliknij ＋ na miniaturze albo „Auto-montaż”, żeby film złożył się sam.`, 'ok');
    }
  }
  async loadSamples() {
    try {
      const r = await fetch('/api/samples');
      const j = await r.json();
      const files = [];
      for (const name of j.files) {
        const b = await (await fetch('samples/' + encodeURIComponent(name))).blob();
        files.push(new File([b], name, { type: b.type }));
      }
      await this.importFiles(files, null);
    } catch (e) { toast('Nie udało się wczytać przykładów', 'err'); }
  }
  async removeMedia(id) {
    const P = this.store.project;
    const m = this.media.get(id);
    if (!m) return;
    const used = P.clips.filter((c) => c.mediaId === id);
    if (used.length && !(await confirmBox('Usunąć plik?', `„${m.name}” jest użyty na osi czasu (${used.length}×). Te klipy też zostaną usunięte.`, 'Usuń', true))) return;
    if (used.length) { P.clips = P.clips.filter((c) => c.mediaId !== id); this.store.select(null); this.commit(); }
    await this.media.remove(id);
  }

  // ------------------------------------------------------------ dodawanie na oś
  addMedia(mediaId, where = {}, noCommit = false) {
    const P = this.store.project;
    const m = this.media.get(mediaId);
    if (!m || m.status !== 'ready') return null;
    let c;
    if (m.type === 'audio') {
      c = makeMediaClip(P, m, null, where.time != null ? where.time : this.store.time);
      P.clips.push(c);
      const pref = where.trackId && getTrack(P, where.trackId);
      c.trackId = (where.toNew === 'audio' ? addTrack(P, 'audio') : findTrackFor(P, c, pref && pref.kind === 'audio' ? pref.id : null)).id;
    } else {
      let tr = where.trackId ? getTrack(P, where.trackId) : null;
      if (where.toNew === 'visual') tr = addTrack(P, 'video', { top: true });
      if (!tr || tr.kind === 'audio') tr = getTrack(P, 'main');
      c = makeMediaClip(P, m, tr.id, 0);
      P.clips.push(c);
      if (tr.main && P.magnet) insertIntoMain(P, c, where.time != null ? where.time : Infinity);
      else {
        c.start = where.time != null ? where.time : tr.main ? projectDuration(P) : this.store.time;
        c.trackId = findTrackFor(P, c, tr.id).id;
      }
    }
    this.store.select(c.id);
    if (!noCommit) this.commit();
    return c;
  }
  addText(preset = {}, where = {}) {
    const P = this.store.project;
    const t = where.time != null ? where.time : this.store.time;
    const c = makeTextClip(null, t, preset);
    P.clips.push(c);
    const pref = where.trackId && getTrack(P, where.trackId);
    c.trackId = (where.toNew === 'visual' ? addTrack(P, 'text') : findTrackFor(P, c, pref && !pref.main && pref.kind !== 'audio' ? pref.id : null)).id;
    this.loadFont(c);
    this.store.select(c.id);
    this.commit();
    this.closeSheets();
    return c;
  }
  addSticker(ch, where = {}) {
    return this.addText({ text: ch, name: 'Naklejka', font: 'Segoe UI Emoji', weight: 400, size: 260, strokeW: 0, animIn: 'pop', animOut: 'pop', loop: 'wiggle', duration: 2.5, y: -0.12, shadow: 18, shadowColor: '#000000' }, where);
  }
  async addAudioFile(file, time) {
    const P = this.store.project;
    try {
      const m = await this.media.importFile(file, P.id);
      this.addMedia(m.id, { time: time != null ? time : this.store.time });
      toast(`Dodano „${m.name}”`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  dropItem(data, where) {
    if (data.type === 'media') this.addMedia(data.id, where);
    else if (data.type === 'text') this.addText(TEXT_PRESETS[data.i].p, where);
    else if (data.type === 'sticker') this.addSticker(data.ch, where);
  }
  loadFont(c) {
    if (!document.fonts || !c || !c.font) return;
    document.fonts.load(`${c.italic ? 'italic ' : ''}${c.weight || 400} 48px "${c.font}"`, c.text || 'A').then(() => {
      this.renderer.layoutCache.clear();
      this.player.dirty = true;
    }).catch(() => {});
  }

  // ------------------------------------------------------------ edycja
  splitAtPlayhead() {
    const P = this.store.project;
    const t = this.store.time;
    const sel = this.store.selected;
    const targets = sel ? [sel] : P.clips.filter((c) => c.trackId === 'main' && t > c.start + MIN_DUR && t < clipEnd(c) - MIN_DUR);
    let done = 0;
    for (const c of targets) if (splitClip(P, c, t)) done++;
    if (!done) { toast('Ustaw głowicę wewnątrz klipu, żeby go podzielić.'); return; }
    this.commit();
  }
  deleteSelected() {
    const P = this.store.project;
    const c = this.store.selected;
    if (!c) return;
    P.clips = P.clips.filter((x) => x.id !== c.id);
    this.store.select(null);
    this.commit();
  }
  duplicateSelected() {
    const c = this.store.selected;
    if (!c) return;
    const d = duplicateClip(this.store.project, c);
    this.store.select(d.id);
    this.commit();
  }
  copySelected() { const c = this.store.selected; if (c) { this.clipboard = deep(c); toast('Skopiowano klip', 'info', 1200); } }
  paste() {
    const P = this.store.project;
    if (!this.clipboard) return;
    const c = deep(this.clipboard);
    c.id = uid('c');
    c.start = this.store.time;
    P.clips.push(c);
    const tr = getTrack(P, c.trackId);
    if (tr && tr.main && P.magnet) insertIntoMain(P, c, this.store.time + 1e-3);
    else c.trackId = findTrackFor(P, c, tr ? tr.id : null).id;
    this.store.select(c.id);
    this.commit();
  }
  detachAudio() {
    const P = this.store.project;
    const c = this.store.selected;
    const m = c && this.media.get(c.mediaId);
    if (!c || c.kind !== 'video' || !m || !m.hasAudio) { toast('Zaznacz film z dźwiękiem.'); return; }
    const a = { id: uid('c'), trackId: null, kind: 'audio', mediaId: c.mediaId, name: `${c.name} (dźwięk)`, start: c.start, duration: c.duration, in: c.in || 0, speed: c.speed || 1, volume: c.volume == null ? 1 : c.volume, muted: false, aFadeIn: c.aFadeIn || 0, aFadeOut: c.aFadeOut || 0 };
    P.clips.push(a);
    a.trackId = findTrackFor(P, a, null).id;
    c.muted = true;
    this.store.select(a.id);
    this.commit();
    toast('Dźwięk jest teraz osobnym klipem – możesz go przesuwać i przycinać.', 'ok');
  }
  async freezeFrame() {
    const P = this.store.project;
    const c = this.store.selected;
    const t = this.store.time;
    if (!c || c.kind !== 'video' || t < c.start || t >= clipEnd(c)) { toast('Zaznacz film i ustaw głowicę na wybranej klatce.'); return; }
    const v = this.pool.get(c.id);
    if (!v || v.readyState < 2) { toast('Poczekaj, aż klatka się wczyta.'); return; }
    const cv = document.createElement('canvas');
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext('2d').drawImage(v, 0, 0);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.95));
    const m = await this.media.importBlob(blob, `${c.name} – stop-klatka.jpg`, P.id);
    if (t > c.start + MIN_DUR && t < clipEnd(c) - MIN_DUR) splitClip(P, c, t);
    const img = makeMediaClip(P, m, c.trackId, t);
    for (const k of VISUAL_KEYS) if (k in c) img[k] = deep(c[k]);
    img.duration = 2;
    if (c.trackId === 'main' && P.magnet) {
      P.clips.push(img);
      insertIntoMain(P, img, t + 1e-3);
    } else {
      for (const o of P.clips) if (o.trackId === c.trackId && o.start >= t - 1e-6) o.start += 2;
      img.start = t;
      P.clips.push(img);
    }
    this.store.select(img.id);
    this.commit();
    toast('Dodano stop-klatkę (2 s).', 'ok');
  }
  toggleMagnet() {
    const P = this.store.project;
    P.magnet = !P.magnet;
    repackMain(P);
    this.commit();
    toast(P.magnet ? 'Magnes włączony – klipy na głównej ścieżce sklejają się.' : 'Magnes wyłączony – klipy możesz ustawiać dowolnie.', 'info', 2200);
  }
  toggleSnap() { const P = this.store.project; P.snap = !P.snap; this.commit(); }
  applyTransition(type) {
    const c = this.store.selected;
    if (!c || c.kind === 'audio') { toast('Najpierw zaznacz klip na osi czasu.'); return; }
    c.transIn = { type, dur: (c.transIn && c.transIn.dur) || 0.6 };
    if (type !== 'none' && c.transIn.dur > c.duration) c.transIn.dur = Math.max(0.1, c.duration * 0.8);
    this.commit();
    if (type !== 'none') this.previewRange(Math.max(0, c.start - 0.6), c.start + c.transIn.dur + 0.5);
  }
  applyFilter(id) {
    const c = this.store.selected;
    if (!c || (c.kind !== 'video' && c.kind !== 'image')) { toast('Zaznacz film lub zdjęcie na osi czasu.'); return; }
    c.filter = c.filter || {};
    c.filter.preset = id;
    this.commit();
  }
  applyToAll(what) {
    const P = this.store.project;
    const c = this.store.selected;
    if (!c) { toast('Zaznacz klip, którego ustawienie chcesz skopiować.'); return; }
    let n = 0;
    if (what === 'filter') {
      for (const o of P.clips) if ((o.kind === 'video' || o.kind === 'image') && o !== c) { o.filter = deep(c.filter); n++; }
    } else if (what === 'transIn') {
      if (!c.transIn || c.transIn.type === 'none') { toast('Najpierw wybierz przejście dla zaznaczonego klipu.'); return; }
      const list = P.clips.filter((o) => o.trackId === c.trackId).sort((a, b) => a.start - b.start);
      list.forEach((o, i) => { if (i > 0 && o !== c) { o.transIn = deep(c.transIn); n++; } });
    }
    this.commit();
    toast(`Zastosowano do ${n} klipów.`, 'ok');
  }
  previewRange(a, b) {
    this.player.seek(a);
    this.player.play();
    this.player.stopAt = b;
  }
  stepFrames(n) {
    const P = this.store.project;
    if (!P) return;
    this.player.pause();
    const f = 1 / (P.fps || 30);
    this.player.seek(Math.round(this.store.time / f + n) * f);
  }
  jumpEdge(dir) {
    const P = this.store.project;
    const t = this.store.time;
    const pts = [...new Set([0, ...P.clips.flatMap((c) => [c.start, clipEnd(c)])])].sort((a, b) => a - b);
    const p = dir > 0 ? pts.find((x) => x > t + 1e-3) : [...pts].reverse().find((x) => x < t - 1e-3);
    if (p != null) { this.player.pause(); this.player.seek(p); }
  }
  async snapshot() {
    const P = this.store.project;
    if (!P) return;
    const cv = document.createElement('canvas');
    const r = new Renderer(cv, { media: this.media, videoOf: (c) => this.pool.get(c.id), exporting: true });
    r.resize(P, P.width, P.height);
    r.render(P, Math.min(this.store.time, Math.max(0, projectDuration(P) - 0.5 / P.fps)));
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    downloadBlob(blob, `${P.name} – klatka ${fmtTime(this.store.time).replace(':', '-')}.png`);
    toast('Zapisano klatkę jako PNG', 'ok');
  }

  // ------------------------------------------------------------ nagrywanie lektora
  async recordVoice() {
    const P = this.store.project;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) { toast('Ta przeglądarka nie pozwala nagrywać dźwięku.', 'err'); return; }
    this.player.pause();
    const startT = this.store.time;
    const btn = h('button', { class: 'rec-btn', title: 'Start / stop' });
    const time = h('div', { class: 'rec-time' }, '00:00.0');
    const meterBar = h('div');
    const status = h('div', { class: 'muted', style: { fontSize: '13px', textAlign: 'center' } }, `Kliknij czerwony przycisk. Nagranie wstawię w miejscu głowicy (${fmtTime(startT)}). Film będzie leciał bez dźwięku, żebyś mógł mówić do obrazu.`);
    let stream, rec, chunks = [], raf, analyser, t0, recording = false, discard = true;
    const m = modal({ title: 'Nagraj lektora', icon: 'mic', body: [h('div', { class: 'rec-box' }, btn, time, h('div', { class: 'meter' }, meterBar), status)], onClose: () => cleanup() });
    const cleanup = () => {
      cancelAnimationFrame(raf);
      if (rec && rec.state !== 'inactive') { discard = true; rec.stop(); }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      this.player.master.gain.value = 1;
      this.player.pause();
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!analyser) return;
      const d = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(d);
      let mx = 0;
      for (const v of d) mx = Math.max(mx, Math.abs(v - 128));
      meterBar.style.width = Math.min(100, (mx / 128) * 160) + '%';
      if (recording) time.textContent = fmtTime((performance.now() - t0) / 1000);
    };
    btn.addEventListener('click', async () => {
      if (!recording) {
        try {
          stream = stream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        } catch { toast('Brak dostępu do mikrofonu.', 'err'); return; }
        const ac = getAudioCtx();
        await ac.resume();
        analyser = ac.createAnalyser();
        analyser.fftSize = 1024;
        ac.createMediaStreamSource(stream).connect(analyser);
        chunks = [];
        rec = new MediaRecorder(stream);
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = async () => {
          if (discard) return;
          const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
          const n = P.clips.filter((c) => c.kind === 'audio' && /^Lektor/.test(c.name)).length + 1;
          const ext = (rec.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
          m.close();
          try {
            const media = await this.media.importFile(new File([blob], `Lektor ${n}.${ext}`, { type: blob.type }), P.id);
            this.addMedia(media.id, { time: startT });
            toast('Nagranie dodane na oś czasu.', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
        discard = false;
        rec.start(250);
        recording = true;
        t0 = performance.now();
        btn.classList.add('on');
        status.textContent = 'Nagrywam… kliknij, aby zakończyć.';
        this.player.master.gain.value = 0;
        this.player.seek(startT);
        this.player.play();
        loop();
      } else {
        recording = false;
        discard = false;
        rec.stop();
        if (stream) stream.getTracks().forEach((t) => t.stop());
        stream = null;
        this.player.pause();
        this.player.master.gain.value = 1;
      }
    });
  }

  // ------------------------------------------------------------ menu, pomoc, panele
  clipMenu(id, x, y) {
    const c = this.store.clip(id);
    if (!c) return;
    const m = c.mediaId && this.media.get(c.mediaId);
    const t = this.store.time;
    contextMenu(x, y, [
      { label: 'Podziel w miejscu głowicy', icon: 'scissors', key: 'S', run: () => this.splitAtPlayhead(), disabled: !(t > c.start + MIN_DUR && t < clipEnd(c) - MIN_DUR) },
      { label: 'Duplikuj', icon: 'copy-plus', key: 'Ctrl+D', run: () => this.duplicateSelected() },
      { label: 'Kopiuj', icon: 'copy', key: 'Ctrl+C', run: () => this.copySelected() },
      { label: 'Wklej w miejscu głowicy', icon: 'clipboard-paste', key: 'Ctrl+V', run: () => this.paste(), disabled: !this.clipboard },
      '-',
      c.kind === 'video' ? { label: 'Odłącz dźwięk', icon: 'unlink', run: () => this.detachAudio(), disabled: !(m && m.hasAudio) || c.muted } : null,
      c.kind === 'video' ? { label: 'Stop-klatka (2 s)', icon: 'snowflake', run: () => this.freezeFrame() } : null,
      (c.kind === 'video' || c.kind === 'audio') && m && m.hasAudio ? { label: 'Usuń powtórki w tym klipie', icon: 'scissors-line-dashed', run: () => this.openRetakes(c.id) } : null,
      (c.kind === 'video' || c.kind === 'audio') && m && m.hasAudio ? { label: 'Napisy z mowy w tym klipie', icon: 'captions', run: () => this.openCaptions(c.id) } : null,
      (c.kind === 'video' || c.kind === 'audio') && m && m.hasAudio ? { label: 'Efekty z mowy w tym klipie', icon: 'sparkles', run: () => this.openSpeechFx(c.id) } : null,
      c.kind === 'video' || c.kind === 'audio' ? { label: c.muted ? 'Włącz dźwięk' : 'Wycisz', icon: c.muted ? 'volume-2' : 'volume-x', run: () => { c.muted = !c.muted; this.commit(); } } : null,
      c.kind === 'text' ? { label: 'Edytuj tekst', icon: 'pencil', run: () => this.inspector.focusText() } : null,
      { label: 'Ustawienia klipu', icon: 'sliders-horizontal', run: () => this.openInspector() },
      '-',
      { label: 'Usuń', icon: 'trash-2', key: 'Del', run: () => this.deleteSelected() },
    ]);
  }
  showHelp() {
    const rows = [
      ['Spacja', 'Odtwórz / pauza'], ['S', 'Podziel klip w miejscu głowicy'], ['Delete', 'Usuń zaznaczony klip'],
      ['Ctrl + Z / Ctrl + Y', 'Cofnij / ponów'], ['Ctrl + D', 'Duplikuj'], ['Ctrl + C / Ctrl + V', 'Kopiuj / wklej'],
      ['← / →', 'Klatka wstecz / dalej (z Shift: 1 sekunda)'], ['↑ / ↓', 'Poprzednie / następne cięcie'],
      ['Home / End', 'Początek / koniec'], ['+ / −', 'Przybliż / oddal oś czasu'], ['Ctrl + kółko', 'Zoom osi czasu'],
      ['T', 'Dodaj tekst'], ['Esc', 'Odznacz'], ['Ctrl + E', 'Eksport'], ['Alt (przy przesuwaniu)', 'Bez przyciągania do środka'],
    ];
    const m = modal({ title: 'Skróty klawiszowe', icon: 'keyboard', body: [h('div', { class: 'shortcuts' }, rows.flatMap(([k, d]) => [h('span', null, ...k.split(' / ').flatMap((x, i) => [i ? ' / ' : null, h('span', { class: 'kbd' }, x)])), h('span', null, d)]))] });
    m.setFoot(h('button', { class: 'btn primary', onclick: () => m.close() }, 'OK'));
  }
  openInspector() {
    if (isMobile()) { $('#library').classList.remove('open'); $('#inspector').classList.add('open'); this.markNav(); }
  }
  closeSheets() { $('#library').classList.remove('open'); $('#inspector').classList.remove('open'); this.markNav(); }
  markNav() {
    for (const b of $$('#mobile-nav button')) {
      if (!b.dataset.sheet) continue;
      const sheet = $('#' + b.dataset.sheet);
      b.classList.toggle('on', sheet.classList.contains('open') && (!b.dataset.tab || this.library.tab === (b.dataset.tab === 'fx' ? 'filters' : b.dataset.tab)));
    }
  }

  // ------------------------------------------------------------ zdarzenia
  bindUI() {
    $('#btn-home').addEventListener('click', () => this.showStart());
    $('#btn-undo').addEventListener('click', () => this.undo());
    $('#btn-redo').addEventListener('click', () => this.redo());
    $('#btn-help').addEventListener('click', () => this.showHelp());
    $('#btn-export').addEventListener('click', () => openExport(this));
    $('#btn-auto').addEventListener('click', () => this.openAuto());
    $('#btn-phone').addEventListener('click', () => window.open('telefon.html', 'kadr-telefon', 'width=520,height=780'));
    // ekran startowy: auto-film
    let autoFmt = localStorage.getItem('kadr.autoFmt') || '9:16';
    const fmtBtns = $$('#auto-fmt button');
    const markFmt = () => fmtBtns.forEach((b) => b.classList.toggle('on', b.dataset.f === autoFmt));
    fmtBtns.forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); autoFmt = b.dataset.f; localStorage.setItem('kadr.autoFmt', autoFmt); markFmt(); }));
    markFmt();
    $('#auto-go').addEventListener('click', () => this.autoStart(autoFmt));
    const name = $('#project-name');
    name.addEventListener('input', () => { if (this.store.project) { this.store.project.name = name.value || 'Bez nazwy'; document.title = `${name.value} – KadrStudio`; } });
    name.addEventListener('change', () => this.commit());
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
    for (const b of $$('#mobile-nav button')) {
      b.addEventListener('click', () => {
        if (b.dataset.action === 'auto') { this.openAuto(); return; }
        const sheet = $('#' + b.dataset.sheet);
        const tab = b.dataset.tab === 'fx' ? 'filters' : b.dataset.tab;
        const wasOpen = sheet.classList.contains('open') && (!tab || this.library.tab === tab);
        this.closeSheets();
        if (!wasOpen) { if (tab) this.library.show(tab); sheet.classList.add('open'); }
        this.markNav();
      });
    }
    document.addEventListener('pointerdown', (e) => {
      if (!isMobile()) return;
      if (e.target.closest('#library, #inspector, #mobile-nav, .modal-back, .ctx-menu')) return;
      if ($('#library').classList.contains('open') || $('#inspector').classList.contains('open')) this.closeSheets();
    }, true);
    // zmiana wysokości osi czasu
    const sp = $('#tl-splitter');
    const savedH = +localStorage.getItem('kadr.tlh');
    if (savedH) document.documentElement.style.setProperty('--tl-h', savedH + 'px');
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const y0 = e.clientY;
      const h0 = $('#timeline').getBoundingClientRect().height;
      const mv = (ev) => {
        const nh = clamp(h0 - (ev.clientY - y0), 150, innerHeight * 0.7);
        document.documentElement.style.setProperty('--tl-h', nh + 'px');
      };
      const up = () => {
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', up);
        localStorage.setItem('kadr.tlh', Math.round($('#timeline').getBoundingClientRect().height));
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
    });
  }

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if ($('#editor').classList.contains('hidden') || isTyping() || $('#modal-root').children.length) return;
      const k = e.key, ctrl = e.ctrlKey || e.metaKey;
      const P = this.store.project;
      if (!P) return;
      const fps = P.fps || 30;
      let handled = true;
      if (k === ' ') this.player.toggle();
      else if (ctrl && (k === 'z' || k === 'Z')) { if (e.shiftKey) this.redo(); else this.undo(); }
      else if (ctrl && (k === 'y' || k === 'Y')) this.redo();
      else if (ctrl && (k === 'd' || k === 'D')) this.duplicateSelected();
      else if (ctrl && (k === 'c' || k === 'C')) this.copySelected();
      else if (ctrl && (k === 'v' || k === 'V')) this.paste();
      else if (ctrl && (k === 's' || k === 'S')) { this.autosave.flush(); toast('Zapisano', 'ok', 1200); }
      else if (ctrl && (k === 'e' || k === 'E')) openExport(this);
      else if (ctrl && (k === 'b' || k === 'B')) this.splitAtPlayhead();
      else if (ctrl) handled = false;
      else if (k === 's' || k === 'S') this.splitAtPlayhead();
      else if (k === 't' || k === 'T') this.addText({ animIn: 'fade' });
      else if (k === 'Delete' || k === 'Backspace') this.deleteSelected();
      else if (k === 'ArrowLeft') this.stepFrames(e.shiftKey ? -fps : -1);
      else if (k === 'ArrowRight') this.stepFrames(e.shiftKey ? fps : 1);
      else if (k === 'ArrowUp') this.jumpEdge(-1);
      else if (k === 'ArrowDown') this.jumpEdge(1);
      else if (k === 'Home') this.player.seek(0);
      else if (k === 'End') this.player.seek(projectDuration(P));
      else if (k === '+' || k === '=') this.timeline.setZoom(this.timeline.zoom * 1.4);
      else if (k === '-' || k === '_') this.timeline.setZoom(this.timeline.zoom / 1.4);
      else if (k === 'Escape') this.store.select(null);
      else handled = false;
      if (handled) e.preventDefault();
    });
  }

  bindDrop() {
    const ov = $('#drop-overlay');
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e) || !this.store.project || $('#editor').classList.contains('hidden')) return; depth++; ov.classList.remove('hidden'); });
    window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) ov.classList.add('hidden'); });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      depth = 0;
      ov.classList.add('hidden');
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (this.store.project && !$('#editor').classList.contains('hidden')) this.importFiles([...e.dataTransfer.files], null);
    });
    // upuszczenie na oś czasu też chowa nakładkę
    $('#timeline').addEventListener('drop', () => { depth = 0; ov.classList.add('hidden'); }, true);
  }
}

window.kadr = new App();
