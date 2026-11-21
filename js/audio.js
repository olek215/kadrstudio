// Dźwięk: planowanie odtwarzania (podgląd i eksport), zapis WAV, syntezator efektów i bitów.
import { clamp } from './util.js';

export function audioGainAt(c, lt) {
  const vol = c.volume == null ? 1 : c.volume;
  let k = 1;
  if (c.aFadeIn > 0) k = Math.min(k, lt / c.aFadeIn);
  if (c.aFadeOut > 0) k = Math.min(k, (c.duration - lt) / c.aFadeOut);
  return vol * clamp(k, 0, 1);
}

// Planuje wszystkie dźwięki z przedziału [fromT, toT] osi czasu tak, by zagrały od chwili `when` w ctx.
export function scheduleAudio(ctx, dest, P, media, fromT, toT, when) {
  const nodes = [];
  const tracks = new Map(P.tracks.map((t) => [t.id, t]));
  for (const c of P.clips) {
    if (c.kind !== 'video' && c.kind !== 'audio') continue;
    const tr = tracks.get(c.trackId);
    if (!tr || tr.muted || c.muted || (c.volume == null ? 1 : c.volume) <= 0) continue;
    const m = media.get(c.mediaId);
    if (!m || !m.audio) continue;
    const cs = c.start, ce = c.start + c.duration;
    const a = Math.max(cs, fromT), b = Math.min(ce, toT);
    if (b - a < 0.005) continue;
    const speed = c.speed || 1;
    const offset = (c.in || 0) + (a - cs) * speed;
    if (offset >= m.audio.duration) continue;
    const T = (tt) => when + (tt - fromT);
    const src = ctx.createBufferSource();
    src.buffer = m.audio;
    src.playbackRate.value = speed;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(dest);
    g.gain.setValueAtTime(audioGainAt(c, a - cs), T(a));
    if (c.aFadeIn > 0 && a < cs + c.aFadeIn) {
      const e = Math.min(cs + c.aFadeIn, ce);
      g.gain.linearRampToValueAtTime(audioGainAt(c, e - cs), T(e));
    }
    if (c.aFadeOut > 0) {
      const fs = ce - c.aFadeOut;
      if (fs > a && fs > cs + (c.aFadeIn || 0)) g.gain.setValueAtTime(audioGainAt(c, fs - cs), T(fs));
      g.gain.linearRampToValueAtTime(0, T(ce));
    }
    src.start(Math.max(T(a), ctx.currentTime), offset, (b - a) * speed);
    nodes.push(src);
  }
  return nodes;
}

export function audioBufferToWav(buf) {
  const nch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
  const bytes = 44 + n * nch * 2;
  const ab = new ArrayBuffer(bytes);
  const dv = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nch, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * nch * 2, true); dv.setUint16(32, nch * 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, n * nch * 2, true);
  const chs = [];
  for (let c = 0; c < nch; c++) chs.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const v = clamp(chs[c][i], -1, 1);
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// ------------------------------------------------------------------ syntezator
let NOISE = new WeakMap();
function noiseBuf(ctx) {
  let b = NOISE.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    NOISE.set(ctx, b);
  }
  return b;
}
function env(param, t0, a, peak, d) {
  param.setValueAtTime(0.0001, t0);
  param.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
  param.exponentialRampToValueAtTime(0.0001, t0 + a + d);
}
function tone(ctx, out, { type = 'sine', f, f2, t0, a = 0.005, d = 0.3, peak = 0.5, glide }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + (glide || a + d));
  const g = ctx.createGain();
  env(g.gain, t0, a, peak, d);
  o.connect(g).connect(out);
  o.start(t0);
  o.stop(t0 + a + d + 0.05);
}
function hiss(ctx, out, { t0, a = 0.003, d = 0.2, peak = 0.4, type = 'highpass', f = 1000, f2, q = 0.8 }) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf(ctx);
  const fl = ctx.createBiquadFilter();
  fl.type = type;
  fl.frequency.setValueAtTime(f, t0);
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t0 + a + d);
  fl.Q.value = q;
  const g = ctx.createGain();
  env(g.gain, t0, a, peak, d);
  s.connect(fl).connect(g).connect(out);
  s.start(t0, Math.random() * 1.5);
  s.stop(t0 + a + d + 0.05);
}
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);

export const SOUNDS = [
  { id: 'whoosh', name: 'Świst', desc: 'przejście', dur: 1.0, gen: (c, o) => hiss(c, o, { t0: 0.02, a: 0.38, d: 0.55, peak: 0.9, type: 'bandpass', f: 280, f2: 3800, q: 1.6 }) },
  { id: 'swipe', name: 'Szybki świst', desc: 'cięcie', dur: 0.45, gen: (c, o) => hiss(c, o, { t0: 0.01, a: 0.08, d: 0.3, peak: 0.7, type: 'bandpass', f: 1500, f2: 7000, q: 1 }) },
  { id: 'pop', name: 'Pyk', desc: 'pojawienie się', dur: 0.3, gen: (c, o) => tone(c, o, { f: 950, f2: 160, t0: 0.005, a: 0.004, d: 0.16, peak: 0.9, glide: 0.1 }) },
  { id: 'ding', name: 'Dzyń', desc: 'dzwoneczek', dur: 1.8, gen: (c, o) => { tone(c, o, { f: 1318, t0: 0.01, d: 1.6, peak: 0.45 }); tone(c, o, { f: 1318 * 2.76, t0: 0.01, d: 0.6, peak: 0.18 }); tone(c, o, { f: 1318 * 5.4, t0: 0.01, d: 0.25, peak: 0.08 }); } },
  { id: 'boom', name: 'Bum', desc: 'mocne uderzenie', dur: 2.0, gen: (c, o) => { tone(c, o, { f: 120, f2: 30, t0: 0.01, a: 0.005, d: 1.7, peak: 1, glide: 0.9 }); hiss(c, o, { t0: 0.01, d: 0.7, peak: 0.6, type: 'lowpass', f: 900, f2: 120 }); } },
  { id: 'click', name: 'Klik', desc: 'przycisk', dur: 0.12, gen: (c, o) => { tone(c, o, { type: 'square', f: 2400, t0: 0.005, d: 0.025, peak: 0.25 }); hiss(c, o, { t0: 0.005, d: 0.02, peak: 0.3, f: 4000 }); } },
  { id: 'beep', name: 'Piip', desc: 'cenzura', dur: 0.8, gen: (c, o) => { const os = c.createOscillator(); os.frequency.value = 1000; const g = c.createGain(); g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.45, 0.01); g.gain.setValueAtTime(0.45, 0.72); g.gain.linearRampToValueAtTime(0, 0.74); os.connect(g).connect(o); os.start(0); os.stop(0.78); } },
  { id: 'rise', name: 'Narastanie', desc: 'napięcie', dur: 2.6, gen: (c, o) => { const os = c.createOscillator(); os.type = 'sawtooth'; os.frequency.setValueAtTime(160, 0); os.frequency.exponentialRampToValueAtTime(1900, 2.4); const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(600, 0); lp.frequency.exponentialRampToValueAtTime(6000, 2.4); const g = c.createGain(); g.gain.setValueAtTime(0.0001, 0); g.gain.exponentialRampToValueAtTime(0.35, 2.35); g.gain.linearRampToValueAtTime(0, 2.45); os.connect(lp).connect(g).connect(o); os.start(0); os.stop(2.5); hiss(c, o, { t0: 0, a: 2.3, d: 0.1, peak: 0.25, type: 'bandpass', f: 500, f2: 8000, q: 2 }); } },
  { id: 'coin', name: 'Moneta', desc: 'punkt / nagroda', dur: 0.6, gen: (c, o) => { tone(c, o, { type: 'square', f: 988, t0: 0.005, d: 0.07, peak: 0.2 }); tone(c, o, { type: 'square', f: 1319, t0: 0.08, d: 0.42, peak: 0.2 }); } },
  { id: 'tada', name: 'Ta-da!', desc: 'sukces', dur: 2.0, gen: (c, o) => { [72, 76, 79, 84].forEach((n, i) => tone(c, o, { type: 'triangle', f: NOTE(n), t0: 0.02 + i * 0.07, d: 1.6, peak: 0.22 })); tone(c, o, { type: 'sawtooth', f: NOTE(60), t0: 0.3, d: 1.2, peak: 0.08 }); } },
  { id: 'fail', name: 'Porażka', desc: 'smutne wa-wa', dur: 2.2, gen: (c, o) => { const notes = [[392, 0, 0.3], [370, 0.35, 0.3], [349, 0.7, 0.3], [330, 1.05, 1.0]]; for (const [f, t0, d] of notes) { const os = c.createOscillator(); os.type = 'sawtooth'; os.frequency.setValueAtTime(f, t0); if (d > 0.5) { const lfo = c.createOscillator(); lfo.frequency.value = 6; const lg = c.createGain(); lg.gain.value = 8; lfo.connect(lg).connect(os.frequency); lfo.start(t0); lfo.stop(t0 + d + 0.1); } const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200; const g = c.createGain(); env(g.gain, t0, 0.02, 0.3, d); os.connect(lp).connect(g).connect(o); os.start(t0); os.stop(t0 + d + 0.1); } } },
  { id: 'heart', name: 'Bicie serca', desc: 'napięcie', dur: 1.4, gen: (c, o) => { tone(c, o, { f: 70, f2: 45, t0: 0.02, d: 0.18, peak: 1 }); tone(c, o, { f: 65, f2: 42, t0: 0.27, d: 0.22, peak: 0.8 }); } },
  { id: 'shutter', name: 'Migawka', desc: 'zdjęcie', dur: 0.4, gen: (c, o) => { hiss(c, o, { t0: 0.01, d: 0.04, peak: 0.6, f: 2500, type: 'bandpass', q: 0.7 }); hiss(c, o, { t0: 0.11, d: 0.07, peak: 0.5, f: 1800, type: 'bandpass', q: 0.7 }); } },
  { id: 'applause', name: 'Brawa', desc: 'oklaski', dur: 3.5, gen: (c, o) => { for (let i = 0; i < 260; i++) { const t0 = Math.random() * 3.0; hiss(c, o, { t0, d: 0.03 + Math.random() * 0.03, peak: 0.12 + Math.random() * 0.15 * (1 - t0 / 3.2), type: 'bandpass', f: 1000 + Math.random() * 2200, q: 1.2 }); } } },
];

// --------------------------------------------------------------- bity (muzyka bez praw autorskich)
function kick(c, o, t) { tone(c, o, { f: 150, f2: 45, t0: t, a: 0.002, d: 0.32, peak: 0.95, glide: 0.11 }); }
function snare(c, o, t, peak = 0.45) { hiss(c, o, { t0: t, d: 0.17, peak, f: 1300 }); tone(c, o, { type: 'triangle', f: 200, f2: 150, t0: t, d: 0.1, peak: 0.35 }); }
function clap(c, o, t) { for (let i = 0; i < 3; i++) hiss(c, o, { t0: t + i * 0.011, d: i === 2 ? 0.14 : 0.02, peak: 0.4, type: 'bandpass', f: 1500, q: 1.1 }); }
function hat(c, o, t, open = false, peak = 0.16) { hiss(c, o, { t0: t, d: open ? 0.22 : 0.04, peak, f: 7500 }); }
function synthNote(c, o, t, f, d, { type = 'sawtooth', peak = 0.2, cut = 900 } = {}) {
  const os = c.createOscillator(); os.type = type; os.frequency.value = f;
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(cut * 2.5, t); lp.frequency.exponentialRampToValueAtTime(cut, t + d);
  const g = c.createGain(); env(g.gain, t, 0.01, peak, d);
  os.connect(lp).connect(g).connect(o); os.start(t); os.stop(t + d + 0.05);
}
function chord(c, o, t, notes, d, opts) { for (const n of notes) synthNote(c, o, t, NOTE(n), d, opts); }

export const BEATS = [
  {
    id: 'beat-energy', name: 'Energia', desc: 'house • 120 BPM', bpm: 120, bars: 8,
    play(c, o, step, bar, s, t) {
      const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
      const roots = [45, 41, 48, 43];
      const ch = bar % 4;
      if (s % 4 === 0) kick(c, o, t);
      if (s === 4 || s === 12) clap(c, o, t);
      if (s % 4 === 2) { hat(c, o, t, true, 0.12); synthNote(c, o, t, NOTE(roots[ch] - 12 + 12), step * 1.6, { peak: 0.22, cut: 500 }); }
      if (s % 2 === 1) hat(c, o, t, false, 0.06);
      if (s === 0 || s === 6 || s === 10) chord(c, o, t, prog[ch].map((n) => n + 12), step * 2.5, { peak: 0.05, cut: 1600 });
    },
  },
  {
    id: 'beat-chill', name: 'Na luzie', desc: 'lo-fi • 90 BPM', bpm: 90, bars: 8, swing: 0.18,
    play(c, o, step, bar, s, t) {
      const prog = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]];
      const ch = bar % 4;
      if (s === 0 || s === 7 || s === 10) kick(c, o, t);
      if (s === 4 || s === 12) snare(c, o, t, 0.3);
      if (s % 2 === 0) hat(c, o, t, false, s % 4 === 0 ? 0.08 : 0.05);
      if (s === 0) chord(c, o, t, prog[ch], step * 15, { type: 'triangle', peak: 0.07, cut: 1400 });
      if (s === 0 || s === 8) tone(c, o, { f: NOTE(prog[ch][0] - 12), t0: t, a: 0.02, d: step * 6, peak: 0.35 });
      if (s === 0 && bar === 0) hiss(c, o, { t0: 0, a: 0.5, d: 20, peak: 0.012, type: 'bandpass', f: 3000, q: 0.5 });
    },
  },
  {
    id: 'beat-trap', name: 'Mocny trap', desc: 'trap • 140 BPM', bpm: 140, bars: 8,
    play(c, o, step, bar, s, t) {
      const bass = [36, 36, 32, 34][Math.floor(bar / 2) % 4];
      if (s === 0 || s === 10 || (s === 7 && bar % 2 === 1)) { kick(c, o, t); tone(c, o, { f: NOTE(bass), f2: NOTE(bass) * 0.94, t0: t, a: 0.005, d: step * 6, peak: 0.6 }); }
      if (s === 8) { clap(c, o, t); snare(c, o, t, 0.25); }
      const roll = bar % 2 === 1 && s >= 12;
      if (roll) { for (let k = 0; k < 3; k++) hat(c, o, t + (k * step) / 3, false, 0.08); } else if (s % 2 === 0 || s === 3) hat(c, o, t, false, 0.09);
      if (s === 0 && bar % 2 === 0) chord(c, o, t, [60, 63, 67].map((n) => n + (bass - 36)), step * 14, { type: 'square', peak: 0.025, cut: 1100 });
    },
  },
];

async function renderOffline(dur, fill) {
  const sr = 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.ratio.value = 4;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(comp).connect(ctx.destination);
  fill(ctx, master);
  return ctx.startRendering();
}

export async function synthSound(def) {
  const buf = await renderOffline(def.dur, (ctx, out) => def.gen(ctx, out));
  return new File([audioBufferToWav(buf)], `${def.name}.wav`, { type: 'audio/wav' });
}
export async function synthBeat(def) {
  const step = 60 / def.bpm / 4;
  const dur = def.bars * 16 * step + 0.6;
  const buf = await renderOffline(dur, (ctx, out) => {
    for (let bar = 0; bar < def.bars; bar++) {
      for (let s = 0; s < 16; s++) {
        let t = (bar * 16 + s) * step;
        if (def.swing && s % 2 === 1) t += step * def.swing;
        def.play(ctx, out, step, bar, s, t);
      }
    }
  });
  return new File([audioBufferToWav(buf)], `${def.name} (${def.bpm} BPM).wav`, { type: 'audio/wav' });
}
