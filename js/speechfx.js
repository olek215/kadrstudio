// Efekty z mowy: gdy mówisz np. „zaobserwujcie”, program sam dodaje dzwoneczek, obrót obrazu i naklejkę 🔔.
import { h, ic, clamp } from './util.js';
import { makeMediaClip, makeTextClip, makeFxClip, addTrack, getTrack, freeOn } from './model.js';
import { FX_TYPES } from './catalog.js';
import { SOUNDS } from './audio.js';
import { speechClips } from './retakes.js';
import { clipWords } from './captions.js';
import { transcribeAll, speechEngine } from './asr.js';
import { modal, toast } from './ui.js';

// stems: początki słów (odmiana: „zaobserwujcie”, „obserwujcie”, „obserwuj” …); frazy wielowyrazowe ze spacją
export const RULES = [
  { id: 'follow', name: 'Obserwuj / subskrybuj', stems: ['obserwuj', 'zaobserwuj', 'subskryb', 'zasubskryb', 'followuj', 'sub'], sound: 'ding', fx: 'spin', sticker: '🔔' },
  { id: 'like', name: 'Polub / łapka / serduszko', stems: ['polub', 'lajk', 'łapk', 'serduszk', 'serducho'], sound: 'pop', fx: 'zoom', sticker: '❤️' },
  { id: 'comment', name: 'Komentarz', stems: ['komentarz', 'skomentuj', 'napiszcie', 'dajcie znać'], sound: 'click', fx: 'tilt', sticker: '💬' },
  { id: 'share', name: 'Udostępnij / wyślij', stems: ['udostępn', 'wyślij', 'wyślijcie', 'podeślij'], sound: 'whoosh', fx: 'zoom', sticker: '📤' },
  { id: 'hello', name: 'Cześć / siema', stems: ['cześć', 'siema', 'siemka', 'witajcie', 'hejka', 'elo'], sound: 'pop', fx: 'pulse', sticker: '👋' },
  { id: 'wow', name: 'Wow / niesamowite', stems: ['wow', 'łał', 'niesamowit', 'niewiarygodn', 'szok'], sound: 'tada', fx: 'zoom', sticker: '🤯' },
  { id: 'attention', name: 'Uwaga / stop', stems: ['uwaga', 'stop', 'czekaj'], sound: 'beep', fx: 'shake', sticker: '⚠️' },
  { id: 'boom', name: 'Bum / wybuch', stems: ['bum', 'boom', 'wybuch', 'pierdut'], sound: 'boom', fx: 'shake', sticker: '💥' },
  { id: 'money', name: 'Pieniądze', stems: ['pieniąd', 'pieniędz', 'kasa', 'kasy', 'hajs', 'złotych'], sound: 'coin', fx: 'pulse', sticker: '💰' },
  { id: 'secret', name: 'Sekret / tajemnica', stems: ['sekret', 'tajemnic', 'tajny', 'tajna'], sound: 'whoosh', fx: 'zoomhold', sticker: '🤫' },
  { id: 'laugh', name: 'Śmiech', stems: ['haha', 'śmieszn', 'beka'], sound: 'pop', fx: 'shake', sticker: '😂' },
  { id: 'fail', name: 'Porażka / nie wyszło', stems: ['porażk', 'nie wyszło', 'masakra', 'katastrof'], sound: 'fail', fx: 'tilt', sticker: '😬' },
  { id: 'end', name: 'Koniec / do zobaczenia', stems: ['do zobaczenia', 'to wszystko', 'na koniec', 'koniec'], sound: 'tada', fx: 'flash', sticker: '🎬' },
];

const norm = (w) => (w || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function stemMatch(word, stem) {
  if (!word) return false;
  if (stem.length <= 4) return word === stem || (word.startsWith(stem) && word.length <= stem.length + 2);
  if (word.startsWith(stem)) return true;
  // tolerancja jednej pomyłki rozpoznawania mowy dla dłuższych słów
  return stem.length >= 8 && word.length >= stem.length && lev(word.slice(0, stem.length), stem) <= 1;
}

// znajduje słowa-klucze w słowach osi czasu: [{t, rule, word}]
export function findKeywords(words, rules) {
  const hits = [];
  const n = words.map((w) => norm(w.w));
  const lastBy = {};
  let lastAny = -9;
  for (let i = 0; i < words.length; i++) {
    for (const r of rules) {
      let ok = false;
      for (const st of r.stems) {
        if (st.includes(' ')) {
          const parts = st.split(' ');
          ok = parts.every((p, k) => n[i + k] && stemMatch(n[i + k], p));
        } else ok = stemMatch(n[i], st);
        if (ok) break;
      }
      if (!ok) continue;
      const t = words[i].t0;
      if (t - (lastBy[r.id] ?? -9) < 2.5 || t - lastAny < 0.45) break;
      hits.push({ t, rule: r, word: words[i].w });
      lastBy[r.id] = t;
      lastAny = t;
      break;
    }
  }
  return hits;
}

async function soundMedia(app, id) {
  const def = SOUNDS.find((s) => s.id === id);
  if (!def) return null;
  const P = app.store.project;
  const have = app.media.list(P.id).find((m) => m.type === 'audio' && m.name === def.name && m.status === 'ready');
  if (have) return have;
  const f = await app.library.getSynth(def, false);
  return app.media.importFile(f, P.id);
}

export async function applySpeechFx(app, hits, o) {
  const P = app.store.project;
  if (o.replace) P.clips = P.clips.filter((c) => c.auto !== 'speechfx');
  const named = (kind, name) => {
    let tr = P.tracks.find((t) => t.kind === kind && t.name === name);
    if (!tr) { tr = addTrack(P, kind, { top: kind === 'text' }); tr.name = name; }
    return tr;
  };
  const sndCache = {};
  let n = 0;
  hits = [...hits].sort((a, b) => a.t - b.t);
  for (let hi = 0; hi < hits.length; hi++) {
    const hit = hits[hi];
    const r = hit.rule;
    const room = hits[hi + 1] ? Math.max(0.3, hits[hi + 1].t - hit.t - 0.05) : 9; // miejsce do następnego słowa-klucza
    if (o.sounds && r.sound && r.sound !== 'none') {
      const m = sndCache[r.sound] || (sndCache[r.sound] = await soundMedia(app, r.sound));
      if (m) {
        const tr = named('audio', 'Efekty dźwiękowe');
        const c = makeMediaClip(P, m, tr.id, Math.max(0, hit.t - 0.04));
        c.duration = Math.min(m.duration, 1.3, room + 0.04);
        c.volume = o.volume;
        c.aFadeOut = Math.min(0.3, c.duration * 0.3);
        c.auto = 'speechfx';
        if (!freeOn(P, tr.id, c.start, c.duration, c.id)) {
          const nxt = P.clips.filter((x) => x.trackId === tr.id && x.start > c.start).sort((a, b) => a.start - b.start)[0];
          if (nxt) c.duration = Math.max(0.15, nxt.start - c.start);
        }
        P.clips.push(c);
      }
    }
    if (o.motion && r.fx && r.fx !== 'none') {
      const tr = named('fx', 'Efekty');
      const def = FX_TYPES[r.fx];
      const c = makeFxClip(tr.id, hit.t, r.fx, def);
      c.duration = Math.min(c.duration, room);
      c.dir = n % 2 ? -1 : 1;
      c.auto = 'speechfx';
      const nxt = P.clips.filter((x) => x.trackId === tr.id && x.start >= hit.t && x !== c).sort((a, b) => a.start - b.start)[0];
      if (nxt) c.duration = Math.min(c.duration, Math.max(0.15, nxt.start - hit.t));
      if (freeOn(P, tr.id, c.start, c.duration, c.id)) P.clips.push(c);
    }
    if (o.stickers && r.sticker) {
      const tr = named('text', 'Naklejki z mowy');
      const c = makeTextClip(tr.id, hit.t, {
        text: r.sticker, name: 'Naklejka', font: 'Segoe UI Emoji', weight: 400, size: 230, strokeW: 0,
        animIn: 'pop', animOut: 'pop', animDur: 0.25, loop: 'wiggle', shadow: 18, shadowColor: '#000000',
        x: (n % 2 ? 1 : -1) * 0.24, y: -0.24, duration: Math.min(1.4, room),
      });
      c.auto = 'speechfx';
      const nxt = P.clips.filter((x) => x.trackId === tr.id && x.start >= hit.t).sort((a, b) => a.start - b.start)[0];
      if (nxt) c.duration = Math.min(c.duration, Math.max(0.3, nxt.start - hit.t));
      if (freeOn(P, tr.id, c.start, c.duration, c.id)) P.clips.push(c);
    }
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ okno
const LS = 'kadr.speechfx';
export async function openSpeechFx(app, onlyClipId) {
  const P = app.store.project;
  if (!P) return;
  app.player.pause();
  const clips = speechClips(app, onlyClipId);
  if (!clips.length) { toast('Na osi czasu nie ma klipów z mową (filmów z dźwiękiem albo nagrań lektora).', 'err', 5000); return; }
  if (!(await speechEngine(app))) { toast('To urządzenie nie potrafi rozpoznawać mowy.', 'err', 5000); return; }
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } })();
  const rules = RULES.map((r) => ({ ...r, on: saved.off ? !saved.off.includes(r.id) : true, sound: (saved.sound || {})[r.id] || r.sound, fx: (saved.fx || {})[r.id] || r.fx }));
  const o = { sounds: saved.sounds !== false, motion: saved.motion !== false, stickers: saved.stickers !== false, volume: saved.volume || 0.8, replace: true };

  const m = modal({ title: 'Efekty z mowy', icon: 'sparkles', wide: true });
  m.canClose = false;
  const line = h('b', null, 'Przygotowuję…');
  const sub = h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '6px', textAlign: 'center' } });
  m.setBody(h('div', { class: 'am-run' }, h('div', { class: 'am-wand' }, ic('sparkles')), line, sub));
  m.setFoot(h('button', { class: 'btn ghost', onclick: () => { m.canClose = true; m.close(); } }, 'Anuluj'));
  let words = [];
  try {
    await transcribeAll(app, clips.map((c) => app.media.get(c.mediaId)), { line: (t) => { line.textContent = t; }, sub: (t) => { sub.textContent = t; } });
    for (const c of clips) { const md = app.media.get(c.mediaId); if (md && md.transcript) words.push(...clipWords(c, md.transcript)); }
    words.sort((a, b) => a.t0 - b.t0);
  } catch (e) {
    console.error(e);
    m.canClose = true;
    m.close();
    toast(e.message || 'Nie udało się rozpoznać mowy', 'err', 6000);
    return;
  }
  m.canClose = true;
  if (!m.el.isConnected) return;

  const sounds = [['none', '— bez dźwięku —'], ...SOUNDS.map((s) => [s.id, s.name])];
  const fxs = [['none', '— bez ruchu —'], ...Object.entries(FX_TYPES).map(([k, f]) => [k, f.name])];
  const render = () => {
    const active = rules.filter((r) => r.on);
    const hits = findKeywords(words, active);
    const counts = {};
    for (const x of hits) counts[x.rule.id] = (counts[x.rule.id] || 0) + 1;
    const rows = rules.map((r) => {
      const cb = h('input', { type: 'checkbox', checked: r.on });
      cb.addEventListener('change', () => { r.on = cb.checked; render(); });
      const ss = h('select', { class: 'inp' }, sounds.map(([v, nm]) => h('option', { value: v }, nm)));
      ss.value = r.sound;
      ss.addEventListener('change', () => { r.sound = ss.value; });
      const fs = h('select', { class: 'inp' }, fxs.map(([v, nm]) => h('option', { value: v }, nm)));
      fs.value = r.fx;
      fs.addEventListener('change', () => { r.fx = fs.value; });
      const play = h('button', { class: 'icon-btn sm', title: 'Odsłuchaj dźwięk' }, ic('volume-2'));
      play.addEventListener('click', async () => {
        const def = SOUNDS.find((s) => s.id === r.sound);
        if (!def) return;
        const f = await app.library.getSynth(def, false);
        const a = new Audio(URL.createObjectURL(f));
        a.play().catch(() => {});
      });
      return h('div', { class: `sfx-rule${r.on ? '' : ' off'}` },
        h('label', { class: 'switch' }, cb, h('span')),
        h('span', { class: 'sfx-stk' }, r.sticker),
        h('div', { class: 'sfx-name' }, h('b', null, r.name), h('span', null, r.stems.filter((s) => s.length > 3).slice(0, 4).map((s) => `„${s}…”`).join(', '))),
        h('span', { class: `sfx-count${counts[r.id] ? ' yes' : ''}` }, counts[r.id] ? `${counts[r.id]}×` : '—'),
        ss, play, fs);
    });
    const sw = (key, label) => {
      const cb = h('input', { type: 'checkbox', checked: o[key] });
      cb.addEventListener('change', () => { o[key] = cb.checked; });
      return h('label', { class: 'am-check' }, h('span', { class: 'switch' }, cb, h('span')), label);
    };
    const found = hits.map((x) => h('span', { class: 'sfx-hit' }, `${x.rule.sticker} „${x.word}”`));
    m.setTitle(hits.length ? `Znalazłem słowa-klucze: ${hits.length}` : 'Efekty z mowy');
    m.setBody(
      h('div', { class: 'tip' }, ic('lightbulb'), h('span', null, 'Gdy w filmie padnie słowo z listy, program doda dźwięk, ruch obrazu i naklejkę. Wyłącz to, czego nie chcesz, albo zmień dźwięk i ruch.')),
      hits.length ? h('div', { class: 'sfx-hits' }, found) : h('div', { class: 'muted', style: { margin: '6px 0 10px' } }, 'W nagraniu nie ma jeszcze słów z listy (np. „zaobserwujcie”, „polub”, „wow”).'),
      h('div', { class: 'sfx-list' }, rows),
      h('div', { class: 'am-opts', style: { marginTop: '12px' } }, sw('sounds', 'Dźwięki'), sw('motion', 'Ruch obrazu (zoom, obrót…)'), sw('stickers', 'Naklejki')),
    );
    m.setFoot(
      h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', disabled: !hits.length, onclick: () => apply(hits) }, ic('sparkles'), 'Dodaj efekty'),
    );
  };
  const apply = async (hits) => {
    localStorage.setItem(LS, JSON.stringify({ off: rules.filter((r) => !r.on).map((r) => r.id), sound: Object.fromEntries(rules.map((r) => [r.id, r.sound])), fx: Object.fromEntries(rules.map((r) => [r.id, r.fx])), sounds: o.sounds, motion: o.motion, stickers: o.stickers }));
    m.canClose = false;
    m.setBody(h('div', { class: 'am-run' }, h('div', { class: 'am-wand' }, ic('sparkles')), h('b', null, 'Dodaję efekty…')));
    m.setFoot();
    try {
      const n = await applySpeechFx(app, hits, o);
      app.store.select(null);
      app.commit();
      app.timeline.fit();
      m.canClose = true;
      m.close();
      app.previewRange(Math.max(0, hits[0].t - 1), hits[0].t + 3);
      toast(`Dodano efekty w ${n} miejscach. Każdy możesz przesunąć albo usunąć na osi czasu.`, 'ok', 6000);
    } catch (e) {
      console.error(e);
      m.canClose = true;
      m.close();
      toast(e.message || 'Nie udało się dodać efektów', 'err', 6000);
    }
  };
  render();
}
