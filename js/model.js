// Model projektu: formaty, tworzenie klipów, operacje edycyjne, klatki kluczowe.
import { uid, deep, EASE } from './util.js';

export const FORMATS = {
  '9:16': { w: 1080, h: 1920, name: 'Rolka', desc: 'TikTok • Reels • Shorts', icon: 'smartphone' },
  '16:9': { w: 1920, h: 1080, name: 'Film', desc: 'YouTube • poziomo', icon: 'monitor' },
  '1:1': { w: 1080, h: 1080, name: 'Kwadrat', desc: 'Post • Facebook', icon: 'square' },
  '4:5': { w: 1080, h: 1350, name: 'Post', desc: 'Instagram pionowo', icon: 'image' },
  '21:9': { w: 2520, h: 1080, name: 'Kinowy', desc: 'Szeroki ekran', icon: 'clapperboard' },
};

export const MIN_DUR = 0.1;
export const KF_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'];

export function newProject(name = 'Mój film', format = '9:16') {
  const f = FORMATS[format] || FORMATS['9:16'];
  return {
    id: uid('p'), name, format, width: f.w, height: f.h, fps: 30, background: '#000000',
    magnet: true, snap: true, version: 1,
    tracks: [{ id: 'main', kind: 'video', name: 'Główna', main: true }],
    clips: [], created: Date.now(), updated: Date.now(),
  };
}

export const clipEnd = (c) => c.start + c.duration;
export const getTrack = (P, id) => P.tracks.find((t) => t.id === id);
export function trackClips(P, tid) { return P.clips.filter((c) => c.trackId === tid).sort((a, b) => a.start - b.start); }
export function projectDuration(P) { return P ? P.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) : 0; }
export const isVisual = (c) => c.kind !== 'audio' && c.kind !== 'fx';
export const hasMediaTime = (c) => c.kind === 'video' || c.kind === 'audio';

// ---------------------------------------------------------------- klipy
export function makeMediaClip(P, m, trackId, start) {
  const tr = getTrack(P, trackId);
  const main = !!(tr && tr.main);
  const base = { id: uid('c'), trackId, mediaId: m.id, name: m.name, start, in: 0, speed: 1 };
  if (m.type === 'audio') {
    return { ...base, kind: 'audio', duration: m.duration, volume: 1, muted: false, aFadeIn: 0, aFadeOut: 0 };
  }
  const aspectM = (m.width || 16) / (m.height || 9);
  const aspectP = P.width / P.height;
  const similar = Math.abs(Math.log(aspectM / aspectP)) < 0.2;
  return {
    ...base, kind: m.type, duration: m.type === 'image' ? 3 : m.duration,
    x: 0, y: 0, scale: main ? 1 : 0.55, rotation: 0, opacity: 1,
    fadeIn: 0, fadeOut: 0, transIn: { type: 'none', dur: 0.5 }, keyframes: {},
    blend: 'source-over', shadow: main ? 0 : 24, shadowColor: '#000000',
    fit: main ? (similar ? 'cover' : 'contain') : 'contain',
    bg: main && !similar ? 'blur' : 'none', bgColor: '#101018',
    flipH: false, flipV: false, radius: main ? 0 : 8, border: 0, borderColor: '#ffffff',
    filter: { preset: 'none', brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, temp: 0, vignette: 0 },
    chroma: { on: false, color: '#00ff00', sim: 0.3, smooth: 0.1 },
    motion: 'none', motionAmt: 1,
    volume: 1, muted: false, aFadeIn: 0, aFadeOut: 0,
  };
}

export const TEXT_DEFAULTS = {
  text: 'Twój tekst', font: 'Montserrat', weight: 900, size: 96, italic: false, upper: false,
  color: '#ffffff', stroke: '#000000', strokeW: 0,
  boxColor: '#000000', boxAlpha: 0, boxRadius: 14, boxPad: 0.28,
  align: 'center', lineH: 1.15, spacing: 0, maxW: 0.86,
  animIn: 'pop', animOut: 'fade', animDur: 0.45, hl: '#ffd400', loop: 'none',
};

export function makeTextClip(trackId, start, preset = {}) {
  const p = deep(preset);
  delete p.label;
  return {
    id: uid('c'), trackId, kind: 'text', name: 'Tekst', start, duration: 3,
    x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fadeIn: 0, fadeOut: 0,
    transIn: { type: 'none', dur: 0.5 }, keyframes: {}, blend: 'source-over',
    shadow: 0, shadowColor: '#000000',
    ...TEXT_DEFAULTS, ...p,
  };
}

// ---------------------------------------------------------------- ścieżki
export function makeFxClip(trackId, start, type, def) {
  return { id: uid('c'), trackId, kind: 'fx', name: def ? def.name : type, fx: type, amt: 1, start, duration: def ? def.dur : 0.6, dir: 1 };
}

export function isCompatible(tr, clip) {
  if (!tr) return false;
  if (clip.kind === 'fx') return tr.kind === 'fx';
  if (tr.kind === 'fx') return false;
  if (clip.kind === 'audio') return tr.kind === 'audio';
  if (tr.kind === 'audio') return false;
  if (tr.main) return clip.kind === 'video' || clip.kind === 'image';
  return true;
}
const TRACK_NAMES = { video: 'Nakładka', text: 'Tekst', audio: 'Audio', fx: 'Efekty' };
export function addTrack(P, kind, opts = {}) {
  let n = 1;
  const names = new Set(P.tracks.map((t) => t.name));
  while (names.has(`${TRACK_NAMES[kind]} ${n}`)) n++;
  const tr = { id: uid('t'), kind, name: `${TRACK_NAMES[kind]} ${n}` };
  if (kind === 'audio') P.tracks.push(tr);
  else if (opts.top || kind === 'text') {
    P.tracks.unshift(tr);
  } else {
    const mainIdx = P.tracks.findIndex((t) => t.main);
    P.tracks.splice(mainIdx < 0 ? 0 : mainIdx, 0, tr);
  }
  return tr;
}
export function freeOn(P, trackId, start, dur, ignoreId) {
  return !P.clips.some((o) => o.id !== ignoreId && o.trackId === trackId && o.start < start + dur - 1e-4 && start < o.start + o.duration - 1e-4);
}
export function kindForClip(c) { return c.kind === 'audio' ? 'audio' : c.kind === 'text' ? 'text' : c.kind === 'fx' ? 'fx' : 'video'; }
// znajdź ścieżkę bez kolizji (albo utwórz nową)
export function findTrackFor(P, clip, preferId) {
  const pref = getTrack(P, preferId);
  if (pref && isCompatible(pref, clip)) {
    if (pref.main && P.magnet) return pref;
    if (freeOn(P, pref.id, clip.start, clip.duration, clip.id)) return pref;
  }
  const want = kindForClip(clip);
  for (const tr of P.tracks) {
    if (tr.main || tr.kind !== want) continue;
    if (freeOn(P, tr.id, clip.start, clip.duration, clip.id)) return tr;
  }
  return addTrack(P, want);
}
export function insertIntoMain(P, clip, atTime) {
  const others = trackClips(P, 'main').filter((c) => c.id !== clip.id);
  let idx = others.findIndex((o) => atTime < o.start + o.duration / 2);
  if (idx < 0) idx = others.length;
  clip.trackId = 'main';
  clip.start = idx < others.length ? others[idx].start - 1e-3 : (others.length ? clipEnd(others[others.length - 1]) : 0);
  repackMain(P);
}
export function repackMain(P) {
  if (!P.magnet) return;
  let t = 0;
  for (const c of trackClips(P, 'main')) { c.start = t; t += c.duration; }
}
export function cleanupTracks(P) {
  const used = new Set(P.clips.map((c) => c.trackId));
  P.tracks = P.tracks.filter((t) => t.main || used.has(t.id));
  if (!P.tracks.some((t) => t.main)) P.tracks.push({ id: 'main', kind: 'video', name: 'Główna', main: true });
}
export function normalize(P) {
  for (const c of P.clips) {
    if (c.start < 0) c.start = 0;
    if (c.duration < MIN_DUR) c.duration = MIN_DUR;
    c.start = Math.round(c.start * 1e5) / 1e5;
    c.duration = Math.round(c.duration * 1e5) / 1e5;
  }
  repackMain(P);
  cleanupTracks(P);
}
export function maxDuration(c, m) {
  if (hasMediaTime(c) && m && isFinite(m.duration)) return Math.max(MIN_DUR, (m.duration - (c.in || 0)) / (c.speed || 1));
  return Infinity;
}

// ---------------------------------------------------------------- operacje
export function splitClip(P, c, T) {
  const lt = T - c.start;
  if (lt < MIN_DUR || c.duration - lt < MIN_DUR) return null;
  const b = deep(c);
  b.id = uid('c');
  b.start = T;
  b.duration = c.duration - lt;
  if (hasMediaTime(c)) b.in = (c.in || 0) + lt * (c.speed || 1);
  c.duration = lt;
  if (b.transIn) b.transIn = { type: 'none', dur: c.transIn ? c.transIn.dur : 0.5 };
  b.fadeIn = 0; b.aFadeIn = 0;
  c.fadeOut = 0; c.aFadeOut = 0;
  if (c.kind === 'text') { c.animOut = 'none'; b.animIn = 'none'; }
  if (c.keyframes) {
    for (const p of Object.keys(c.keyframes)) {
      const k = c.keyframes[p];
      if (!k || !k.length) continue;
      const v = kfValue(k, lt);
      c.keyframes[p] = [...k.filter((e) => e.t < lt - 1e-4), { t: lt, v }];
      b.keyframes[p] = [{ t: 0, v }, ...k.filter((e) => e.t > lt + 1e-4).map((e) => ({ t: e.t - lt, v: e.v }))];
    }
  }
  P.clips.push(b);
  return b;
}
export function duplicateClip(P, c) {
  const d = deep(c);
  d.id = uid('c');
  d.start = clipEnd(c);
  if (getTrack(P, c.trackId)?.main && P.magnet) {
    // wstaw zaraz za oryginałem, resztę przesuń
    for (const o of P.clips) if (o.trackId === 'main' && o.start > c.start && o.id !== c.id) o.start += c.duration;
    P.clips.push(d);
    repackMain(P);
  } else {
    P.clips.push(d);
    const tr = findTrackFor(P, d, c.trackId);
    d.trackId = tr.id;
  }
  return d;
}
export function setSpeed(c, s) {
  const old = c.speed || 1;
  c.speed = s;
  c.duration = c.duration * old / s;
  if (c.keyframes) for (const k of Object.values(c.keyframes)) for (const e of k) e.t = e.t * old / s;
}
export function shiftKeyframes(c, dt) {
  if (!c.keyframes) return;
  for (const k of Object.values(c.keyframes)) for (const e of k) e.t -= dt;
}

// ---------------------------------------------------------------- klatki kluczowe
export function kfValue(k, lt) {
  if (lt <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (lt >= last.t) return last.v;
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i], b = k[i + 1];
    if (lt >= a.t && lt <= b.t) {
      const u = (lt - a.t) / (b.t - a.t || 1);
      return a.v + (b.v - a.v) * EASE.inOut(u);
    }
  }
  return last.v;
}
export function propAt(c, p, lt) {
  const k = c.keyframes && c.keyframes[p];
  if (!k || !k.length) return c[p];
  return kfValue(k, lt);
}
export function hasKf(c, p) { return !!(c.keyframes && c.keyframes[p] && c.keyframes[p].length); }
export function kfAt(c, p, lt, tol = 0.02) {
  const k = c.keyframes && c.keyframes[p];
  return k ? k.find((e) => Math.abs(e.t - lt) < tol) : null;
}
export function setPropAt(c, p, v, lt, tol = 0.02) {
  const k = c.keyframes && c.keyframes[p];
  if (k && k.length) {
    const f = k.find((e) => Math.abs(e.t - lt) < tol);
    if (f) f.v = v;
    else { k.push({ t: lt, v }); k.sort((a, b) => a.t - b.t); }
  } else c[p] = v;
}
export function toggleKf(c, p, lt, tol = 0.02) {
  if (!c.keyframes) c.keyframes = {};
  const k = c.keyframes[p] || (c.keyframes[p] = []);
  const cur = k.length ? kfValue(k, lt) : c[p];
  const f = k.findIndex((e) => Math.abs(e.t - lt) < tol);
  if (f >= 0) {
    k.splice(f, 1);
    if (!k.length) { delete c.keyframes[p]; c[p] = cur; }
  } else {
    k.push({ t: Math.max(0, lt), v: cur });
    k.sort((a, b) => a.t - b.t);
  }
}
export function allKfTimes(c) {
  const s = new Set();
  if (c.keyframes) for (const k of Object.values(c.keyframes)) for (const e of k) s.add(Math.round(e.t * 1000) / 1000);
  return [...s].sort((a, b) => a - b);
}
