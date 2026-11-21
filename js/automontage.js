// Auto-montaż: program sam składa film z wybranych plików.
// 1) słucha muzyki i znajduje rytm, 2) w każdym filmie szuka najciekawszych ujęć,
// 3) tnie je w rytm, dodaje przejścia, ruch kamery, filtr, tytuł i muzykę.
import { h, ic, clamp, mulberry32, fmtDur } from './util.js';
import { makeMediaClip, makeTextClip, makeFxClip, addTrack, normalize, projectDuration } from './model.js';
import { TEXT_PRESETS, FX_TYPES } from './catalog.js';
import { BEATS } from './audio.js';
import { modal, toast } from './ui.js';
import { clipUtterances, findRetakes, isRestart } from './retakes.js';
import { buildCaptions, clipWords } from './captions.js';
import { findKeywords, applySpeechFx, RULES } from './speechfx.js';
import { transcribeAll, speechEngine, voiceSegments } from './asr.js';

// ------------------------------------------------------------------ style
// Każdy styl mówi, JAK decydować (np. przejście przy zmianie sceny), a nie losuje efektów.
export const STYLES = {
  energy: {
    name: 'Energiczny', desc: 'szybkie cięcia w rytm, flesze i zoomy na mocnych momentach', icon: 'zap', bpm: 128, beat: ['beat-energy', 'beat-trap'],
    cuts: { hi: [1, 2], mid: [2, 2, 4], lo: [4] }, minSeg: 0.4, photoMin: 1, speechMax: 5,
    change: 'zoomin', strong: 'white', same: 'none', transDur: 0.28, still: 'zoomin', accents: true, captions: 'big',
    filter: 'vivid', fadeIn: 0, fadeOut: 0.3, title: 'Krzyk', titleY: -0.05,
  },
  calm: {
    name: 'Spokojny', desc: 'płynne przenikania między scenami – wspomnienia, wakacje', icon: 'sunset', bpm: 90, beat: ['beat-chill'],
    cuts: { hi: [4], mid: [4, 8], lo: [8] }, minSeg: 1.6, photoMin: 2.4, speechMax: 7,
    change: 'fade', strong: 'fade', same: 'none', transDur: 0.8, still: 'zoomin', accents: false, captions: 'classic',
    filter: 'warm', fadeIn: 0.6, fadeOut: 1, title: 'Elegancki', titleY: 0,
  },
  vlog: {
    name: 'Vlog', desc: 'całe zdania z mową, bez powtórek, z napisami', icon: 'video', bpm: 100, beat: ['beat-chill'],
    cuts: { hi: [4], mid: [4, 8], lo: [8] }, minSeg: 1.4, photoMin: 1.8, speechMax: 9, keepAudio: true,
    change: 'slideleft', strong: 'slideleft', same: 'none', transDur: 0.35, still: 'none', accents: false, captions: 'box',
    filter: 'none', fadeIn: 0, fadeOut: 0.5, title: 'Napis z tłem', titleY: 0.3,
  },
  cinema: {
    name: 'Kinowy', desc: 'powolne ujęcia, przez czerń między scenami', icon: 'clapperboard', bpm: 80, beat: ['beat-chill'],
    cuts: { hi: [4], mid: [4, 8], lo: [8] }, minSeg: 2, photoMin: 2.6, speechMax: 8,
    change: 'black', strong: 'black', same: 'fade', transDur: 0.9, still: 'zoomin', accents: false, captions: 'classic',
    filter: 'cinema', fadeIn: 1, fadeOut: 1.2, title: 'Kinowy', titleY: 0,
  },
};

const idle = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------------ rytm muzyki
function makeFFT(N) {
  const bits = Math.log2(N);
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos((-2 * Math.PI * i) / N); sin[i] = Math.sin((-2 * Math.PI * i) / N); }
  return (re, im) => {
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step, a = i + j, b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

// Zwraca { bpm, period, beats[], energy[] (0..1 na każde uderzenie), start (indeks pierwszego głośnego uderzenia) }
export function detectBeats(buf) {
  const sr = buf.sampleRate;
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const ds = Math.max(1, Math.round(sr / 11025));
  const sr2 = sr / ds;
  const len = Math.min(Math.floor(buf.length / ds), Math.floor(sr2 * 240));
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) { const j = i * ds; x[i] = ch1 ? (ch0[j] + ch1[j]) * 0.5 : ch0[j]; }
  const N = 512, hop = 128;
  const frames = Math.max(0, Math.floor((len - N) / hop));
  const fr = sr2 / hop;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const fft = makeFFT(N);
  const re = new Float32Array(N), im = new Float32Array(N), prev = new Float32Array(N / 2);
  const flux = new Float32Array(frames), lowFlux = new Float32Array(frames), rms = new Float32Array(frames);
  const lowBins = Math.max(2, Math.round((160 * N) / sr2)); // do ok. 160 Hz – stopa / bas
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    let e = 0;
    for (let i = 0; i < N; i++) { const v = x[o + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    rms[f] = Math.sqrt(e / N);
    fft(re, im);
    let s = 0, sl = 0;
    for (let k = 1; k < N / 2; k++) {
      const mag = Math.log1p(80 * Math.hypot(re[k], im[k]));
      const d = mag - prev[k];
      if (d > 0) { s += d; if (k <= lowBins) sl += d; }
      prev[k] = mag;
    }
    flux[f] = s;
    lowFlux[f] = sl;
  }
  // obwiednia nagłych zmian dźwięku (onsety) minus lokalna średnia
  const onset = (fl) => {
    const out = new Float32Array(frames);
    const W = 10;
    let acc = 0;
    for (let i = 0; i < Math.min(frames, 2 * W + 1); i++) acc += fl[i];
    for (let i = 0; i < frames; i++) {
      const a = i - W - 1, b = i + W;
      if (a >= 0) acc -= fl[a];
      if (b < frames && i > W) acc += fl[b];
      const cnt = Math.min(frames - 1, b) - Math.max(0, a + 1) + 1;
      out[i] = Math.max(0, fl[i] - acc / Math.max(1, cnt));
    }
    let mx = 1e-9;
    for (let i = 0; i < frames; i++) if (out[i] > mx) mx = out[i];
    for (let i = 0; i < frames; i++) out[i] /= mx;
    return out;
  };
  const env = onset(flux);
  const envLow = onset(lowFlux);
  // tempo: autokorelacja z preferencją ok. 120 BPM
  const minLag = Math.floor((fr * 60) / 185), maxLag = Math.ceil((fr * 60) / 65);
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < frames; i++) s += env[i] * env[i + lag];
    ac[lag] = s / Math.max(1, frames - lag);
  }
  let best = -1, bestLag = Math.round((fr * 60) / 120);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fr) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.8, 2));
    const sc = ac[lag] * w;
    if (sc > best) { best = sc; bestLag = lag; }
  }
  // dokładniejszy okres (interpolacja paraboliczna)
  let period = bestLag;
  const y0 = ac[bestLag - 1] || 0, y1 = ac[bestLag] || 0, y2 = ac[bestLag + 1] || 0;
  const den = y0 - 2 * y1 + y2;
  if (Math.abs(den) > 1e-12) period = bestLag + clamp((0.5 * (y0 - y2)) / den, -0.5, 0.5);
  // faza siatki uderzeń
  const gridSum = (e, ph) => {
    let s = 0;
    for (let p = ph; p < frames; p += period) {
      const i = Math.round(p);
      s += Math.max(e[i] || 0, (e[i - 1] || 0) * 0.7, (e[i + 1] || 0) * 0.7);
    }
    return s;
  };
  let bestPh = 0, bestPhS = -1;
  for (let ph = 0; ph < period; ph += 0.5) {
    const s = gridSum(env, ph);
    if (s > bestPhS) { bestPhS = s; bestPh = ph; }
  }
  // hi-hat/bas między uderzeniami potrafi "przeciągnąć" siatkę – wybierz tę, na której mocniej uderza stopa
  const alt = (bestPh + period / 2) % period;
  if (gridSum(envLow, alt) > gridSum(envLow, bestPh) * 1.15) bestPh = alt;
  const lat = N / 2 / sr2; // ramka analizy jest opóźniona o pół okna
  const beats = [], energy = [], loud = [];
  for (let p = bestPh; p < frames; p += period) beats.push(p / fr + lat);
  for (let k = 0; k < beats.length; k++) {
    const a = Math.round(beats[k] * fr), b = Math.min(frames, Math.round((beats[k + 1] || beats[k] + period / fr) * fr));
    let e = 0, r = 0;
    for (let i = a; i < b; i++) { e += env[i]; r += rms[i]; }
    energy.push(e / Math.max(1, b - a));
    loud.push(r / Math.max(1, b - a));
  }
  const em = Math.max(1e-9, ...energy);
  for (let k = 0; k < energy.length; k++) energy[k] /= em;
  const sorted = [...loud].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  let start = loud.findIndex((v) => v > med * 0.3);
  if (start < 0 || start > beats.length / 3) start = 0;
  return { bpm: (60 * fr) / period, period: period / fr, beats, energy, start };
}

// ------------------------------------------------------------------ najlepsze ujęcia
function seek(v, t) {
  return new Promise((res) => {
    const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); res(); };
    const to = setTimeout(done, 3000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}
export async function analyzeVideo(m) {
  if (m.analysis && m.analysis.cuts) return m.analysis;
  const n = clamp(Math.ceil(m.duration * 2), 4, 80);
  const samples = [];
  try {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = m.url;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(rej, 20000); });
    const W = 64, H = Math.max(12, Math.round((64 * v.videoHeight) / v.videoWidth));
    const c = h('canvas', { width: W, height: H });
    const g = c.getContext('2d', { willReadFrequently: true });
    let prev = null;
    for (let i = 0; i < n; i++) {
      const t = Math.min(m.duration - 0.05, ((i + 0.5) * m.duration) / n);
      await seek(v, Math.max(0, t));
      g.drawImage(v, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      const L = new Float32Array(W * H);
      let sum = 0, sr = 0, sg = 0, sb = 0;
      for (let p = 0, q = 0; p < d.length; p += 4, q++) { L[q] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; sum += L[q]; sr += d[p]; sg += d[p + 1]; sb += d[p + 2]; }
      const col = [sr / L.length / 255, sg / L.length / 255, sb / L.length / 255];
      const mean = sum / L.length;
      let vs = 0, sharp = 0, motion = 0;
      for (let q = 0; q < L.length; q++) {
        vs += (L[q] - mean) * (L[q] - mean);
        if ((q + 1) % W) sharp += Math.abs(L[q] - L[q + 1]);
        if (q + W < L.length) sharp += Math.abs(L[q] - L[q + W]);
        if (prev) motion += Math.abs(L[q] - prev[q]);
      }
      prev = L;
      samples.push({ t, bright: mean / 255, contrast: Math.sqrt(vs / L.length) / 255, sharp: sharp / L.length, motion: motion / L.length, col });
    }
    v.removeAttribute('src'); v.load();
  } catch {
    for (let i = 0; i < n; i++) samples.push({ t: ((i + 0.5) * m.duration) / n, bright: 0.5, contrast: 0.2, sharp: 1, motion: 1, col: [0.5, 0.5, 0.5] });
  }
  if (samples.length > 1) samples[0].motion = samples[1].motion;
  // zmiany scen w środku filmu: nagły skok różnicy obrazu na tle sąsiednich próbek
  const cuts = [];
  const mot = samples.map((s) => s.motion).sort((a, b) => a - b);
  const med = mot[Math.floor(mot.length / 2)] || 0;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    const around = Math.max(samples[i - 2] ? samples[i - 2].motion : 0, samples[i + 1] ? samples[i + 1].motion : 0);
    const cdist = Math.hypot(s.col[0] - samples[i - 1].col[0], s.col[1] - samples[i - 1].col[1], s.col[2] - samples[i - 1].col[2]);
    if ((s.motion > Math.max(med * 3, 18) && s.motion > around * 1.8) || cdist > 0.22) cuts.push((samples[i - 1].t + s.t) / 2);
  }
  const mx = (k) => Math.max(1e-6, ...samples.map((s) => s[k]));
  const ms = mx('sharp'), mm = mx('motion'), mc = mx('contrast');
  for (const s of samples) {
    let loud = 0.5;
    if (m.peaks) {
      const a = Math.floor(Math.max(0, s.t - 0.5) * 50), b = Math.floor((s.t + 0.5) * 50);
      let acc = 0, cnt = 0;
      for (let i = a; i < b && i < m.peaks.length; i++) { acc += m.peaks[i]; cnt++; }
      loud = cnt ? acc / cnt : 0.5;
    }
    let sc = 0.35 * (s.sharp / ms) + 0.3 * Math.sqrt(s.motion / mm) + 0.2 * (s.contrast / mc) + 0.15 * loud;
    if (s.bright < 0.07) sc *= 0.15; else if (s.bright < 0.15) sc *= 0.6;
    if (s.bright > 0.96) sc *= 0.4;
    s.score = sc;
    s.loud = loud;
  }
  const motions = samples.map((s) => s.motion).sort((a, b) => a - b);
  m.analysis = { samples, cuts, stillThr: motions[Math.floor(motions.length * 0.35)] || 0 };
  return m.analysis;
}
// średni kolor i ruch w kawałku filmu
function windowStats(m, a, b) {
  const an = m.analysis;
  if (!an || !an.samples.length) return { col: [0.5, 0.5, 0.5], motion: 0, startCol: [0.5, 0.5, 0.5], endCol: [0.5, 0.5, 0.5] };
  const inside = an.samples.filter((s) => s.t >= a && s.t <= b);
  const near = (t) => an.samples.reduce((best, s) => (Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best), an.samples[0]);
  const list = inside.length ? inside : [near((a + b) / 2)];
  const col = [0, 1, 2].map((k) => list.reduce((s, x) => s + x.col[k], 0) / list.length);
  return { col, motion: list.reduce((s, x) => s + x.motion, 0) / list.length, startCol: near(a).col, endCol: near(b).col };
}
const colDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function windowScore(an, a, b, speech) {
  let acc = 0, cnt = 0, near = null, nd = Infinity;
  for (const s of an.samples) {
    if (s.t >= a && s.t <= b) { acc += s.score + (speech ? s.loud * 0.4 : 0); cnt++; }
    const d = Math.abs(s.t - (a + b) / 2);
    if (d < nd) { nd = d; near = s; }
  }
  return cnt ? acc / cnt : near ? near.score : 0.5;
}
function pickWindow(m, L, used, rnd, speech) {
  const dur = m.duration;
  if (L >= dur - 0.1) return 0;
  const an = m.analysis || { samples: [] };
  const margin = Math.min(0.3, dur * 0.04);
  let best = null, bestS = -1, bestAny = margin, bestAnyS = -1;
  const cuts = an.cuts || [];
  for (let s = margin; s + L <= dur - 0.05; s += 0.2) {
    let sc = windowScore(an, s, s + L, speech) * (0.94 + 0.12 * rnd());
    // nie tnij przez zmianę sceny – ujęcie ma być jednym kadrem
    if (cuts.some((c) => c > s + 0.15 && c < s + L - 0.15)) sc *= 0.25;
    if (sc > bestAnyS) { bestAnyS = sc; bestAny = s; }
    if (used.some(([a, b]) => s < b - 0.05 && s + L > a + 0.05)) continue;
    if (sc > bestS) { bestS = sc; best = s; }
  }
  return best != null ? best : bestAny;
}

// ------------------------------------------------------------------ składanie
async function synthMedia(app, def) {
  const P = app.store.project;
  const name = `${def.name} (${def.bpm} BPM)`;
  const have = app.media.list(P.id).find((x) => x.type === 'audio' && x.name === name && x.audio);
  if (have) return have;
  const f = await app.library.getSynth(def, true);
  return app.media.importFile(f, P.id);
}

export async function buildMontage(app, o, step = () => {}) {
  const P = app.store.project;
  const S = STYLES[o.style] || STYLES.energy;
  const rnd = mulberry32(o.seed || 1);
  // poczekaj na pliki, które jeszcze się wczytują
  for (let i = 0; i < 100 && o.mediaIds.some((id) => { const m = app.media.get(id); return m && m.status === 'loading'; }); i++) {
    step('load');
    await new Promise((r) => setTimeout(r, 200));
  }
  let visual = o.mediaIds.map((id) => app.media.get(id)).filter((m) => m && m.status === 'ready' && m.type !== 'audio');
  if (!visual.length) throw new Error('Zaznacz przynajmniej jeden film albo zdjęcie.');
  // kolejność jak przy nagrywaniu (data pliku) – historia idzie po kolei; losowo tylko na życzenie
  if (o.shuffle) visual = [...visual].sort(() => rnd() - 0.5);
  else visual = [...visual].sort((a, b) => (a.fileTime || a.created || 0) - (b.fileTime || b.created || 0));

  // ---------------- muzyka i rytm
  let music = null;
  if (o.music && o.music !== 'none') {
    step('music');
    if (o.music.startsWith('beat:')) {
      const id = o.music === 'beat:auto' ? S.beat[(o.seed || 0) % S.beat.length] : o.music.slice(5);
      music = await synthMedia(app, BEATS.find((b) => b.id === id) || BEATS[0]);
    } else music = app.media.get(o.music);
    if (music && !music.audio) music = null;
  }
  let beat = 60 / S.bpm, energy = null, mIn = 0, bpm = S.bpm;
  if (music) {
    step('rhythm');
    await idle();
    if (!music.beats) music.beats = detectBeats(music.audio);
    const b = music.beats;
    if (b.beats.length > 8) {
      beat = b.period; bpm = b.bpm;
      mIn = b.beats[b.start];
      energy = b.energy.slice(b.start);
    }
  }

  // ---------------- co jest w filmach: obraz (sceny, ruch, kolory) i mowa
  const vids = visual.filter((m) => m.type === 'video');
  // na telefonie dźwięk z filmu wczytuje się chwilę – bez niego nie da się rozpoznać mowy ani odtworzyć głosu
  const pendingAudio = vids.filter((m) => m.audioReady && !m.audio);
  if (pendingAudio.length) { step('audio'); await Promise.all(pendingAudio.map((m) => m.audioReady)); }
  const warnings = [];
  for (const m of vids) if (m.audioError) warnings.push(`brak dźwięku: ${m.name}`);
  for (let i = 0; i < vids.length; i++) { step('shots', i + 1, vids.length); await analyzeVideo(vids[i]); }
  if (o.speech !== false && vids.some((m) => m.hasAudio) && (await speechEngine(app))) {
    try {
      await transcribeAll(app, vids.filter((m) => m.hasAudio && m.duration <= 300), { line: () => step('speech'), sub: (txt) => step('speech', 0, 0, txt) });
    } catch (e) {
      console.warn('mowa', e);
      warnings.push('mowa nierozpoznana – cięcia po głośności');
    }
  }
  const keepSound = S.keepAudio || o.clipAudio === 'keep';
  for (const m of vids) {
    m._utts = [];
    m._voiceOnly = false;
    if (m.transcript && m.transcript.segments && m.transcript.segments.length) {
      const whole = { id: m.id, trackId: '-', start: 0, in: 0, duration: m.duration, speed: 1 };
      const utts = clipUtterances(whole, m.transcript).filter((u) => u.tokens.length >= 2 || (u.tokens.length === 1 && u.srcEnd - u.srcStart > 0.35));
      // powtórki: zostaje najlepsza wersja zdania, wtrącenia „jeszcze raz” wypadają
      const drop = new Set();
      for (const g of findRetakes(utts)) {
        for (const tk of g.takes) if (tk !== g.keep) drop.add(tk);
        for (const ex of g.extras) drop.add(ex);
      }
      m._utts = utts.filter((u) => !drop.has(u) && !isRestart(u));
    }
    // vlog bez rozpoznanej mowy: fragmenty z głosem po głośności (ciche przerwy wypadają)
    if (!m._utts.length && keepSound && m.audio) {
      const reg = await voiceSegments(m.audio);
      m._utts = reg.filter((r) => r.end - r.start > 0.3).map((r) => ({ srcStart: r.start, srcEnd: Math.min(m.duration, r.end), tokens: ['_'], text: '' }));
      m._voiceOnly = m._utts.length > 0;
    }
    const sd = m._utts.reduce((s, u) => s + (u.srcEnd - u.srcStart), 0);
    m._speech = m._utts.length > 0 && sd >= Math.min(2.5, m.duration * 0.25);
    m._uidx = 0;
  }
  const anySpeech = vids.some((m) => m._speech);
  step('build');

  // ---------------- długość
  const speechTotal = vids.filter((m) => m._speech).reduce((s, m) => s + m._utts.reduce((a, u) => a + (u.srcEnd - u.srcStart) + 0.37, 0), 0);
  // ile materiału „warto” pokazać: długi film = dłuższy montaż (wcześniej max ~7 s z filmu)
  const use = { energy: 0.35, calm: 0.5, cinema: 0.45, vlog: 0.8 }[o.style] || 0.5;
  const material = visual.filter((m) => !m._speech).reduce((s, m) => s + (m.type === 'image' ? S.photoMin * 1.3 : clamp(m.duration * use, Math.min(m.duration, 2), 45)), 0);
  const musicLen = music ? music.duration - mIn : Infinity;
  let T;
  if (o.length === 'music') T = music ? Math.min(musicLen, 240) : clamp(material + speechTotal, 6, 90);
  else if (o.length === 'auto') T = anySpeech ? clamp(speechTotal + material * 0.5, 6, 180) : clamp(material, 6, 120);
  else T = +o.length;
  const q = energy ? [...energy].sort((a, b) => a - b) : null;
  const qAt = (f) => (q ? q[Math.min(q.length - 1, Math.floor(q.length * f))] : 0.5);
  const q33 = qAt(0.33), q66 = qAt(0.66), q75 = qAt(0.75), q90 = qAt(0.9);
  const eAt = (k) => (energy ? energy[((k % energy.length) + energy.length) % energy.length] || 0 : 0.5);

  // ---------------- plan ujęć
  const used = new Map();
  const segs = [];
  // jedno ujęcie bez mowy: długość z energii muzyki, koniec równo na uderzeniu
  const addShot = (m, t, limit) => {
    const k = Math.floor(t / beat + 1e-6);
    const e = (eAt(k) + eAt(k + 1)) / 2;
    const lvl = !energy ? 'mid' : e >= q66 ? 'hi' : e <= q33 ? 'lo' : 'mid';
    const opts = S.cuts[lvl];
    let nb = opts[(k + segs.length) % opts.length];
    const minDur = m.type === 'image' ? S.photoMin : S.minSeg;
    while (nb * beat < minDur && nb < 32) nb *= 2;
    let endT = (k + nb) * beat;
    if (endT - t < minDur * 0.75) endT += nb * beat;
    if (limit != null) {
      endT = Math.min(endT, limit);
      if (limit - endT > 0 && limit - endT < Math.max(minDur, S.minSeg, S.photoMin * 0.8)) endT = limit;
    }
    let dur = Math.max(0.3, endT - t);
    let src = 0, speed = 1;
    if (m.type === 'video') {
      const avail = m.duration - 0.06;
      if (avail < dur) { if (avail >= dur * 0.5) speed = avail / dur; else dur = Math.max(0.3, avail); }
      const L = Math.min(avail, dur * speed);
      const u = used.get(m.id) || [];
      src = pickWindow(m, L, u, rnd, false);
      u.push([src, src + L]);
      used.set(m.id, u);
    }
    segs.push({ m, src, dur, speed, speech: false, beatIdx: k, lvl });
    return dur;
  };
  let t = 0;
  if (!anySpeech) {
    // film z samej muzyki: ujęcia na zmianę, cięcia w rytm
    let idx = 0, guard = 0;
    while (t < T - 0.25 && guard++ < 800) t += addShot(visual[idx++ % visual.length], t, T);
  } else {
    // film z mową: mowa jest „kręgosłupem” – wszystkie zdania po kolei, całe (bez powtórek),
    // a między nimi krótkie ujęcia z filmów bez mowy, w kolejności nagrywania
    const plan = [];
    for (const m of visual) {
      if (m._speech) {
        let i = 0;
        while (i < m._utts.length) {
          const a = m._utts[i];
          let b = a, j = i + 1;
          while (j < m._utts.length && m._utts[j].srcEnd - a.srcStart <= S.speechMax && m._utts[j].srcStart - b.srcEnd < 1.6) { b = m._utts[j]; j++; }
          plan.push({ m, speech: true, src: Math.max(0, a.srcStart - 0.15), end: Math.min(m.duration - 0.03, b.srcEnd + 0.22) });
          i = j;
        }
      } else {
        const n = m.type === 'image' ? 1 : clamp(Math.round(m.duration / 6), 1, 3);
        for (let i = 0; i < n; i++) plan.push({ m, speech: false });
      }
    }
    const fixed = o.length !== 'auto';
    const speechSum = plan.filter((x) => x.speech).reduce((s, x) => s + (x.end - x.src), 0);
    const shots = plan.filter((x) => !x.speech).length;
    // przy stałej długości: najpierw mowa, ujęcia bez mowy dostają resztę czasu
    const shotBudget = fixed ? Math.max(0, T - speechSum) : Infinity;
    const maxShots = fixed ? Math.min(shots, Math.floor(shotBudget / Math.max(S.minSeg * 2, 1.2))) : shots;
    let shotsLeft = maxShots, shotsSeen = 0;
    for (const x of plan) {
      if (fixed && t >= T - 0.25) break;
      if (x.speech) {
        segs.push({ m: x.m, src: x.src, dur: x.end - x.src, speed: 1, speech: true, beatIdx: Math.round(t / beat) });
        t += x.end - x.src;
      } else {
        shotsSeen++;
        // przy braku czasu pomijaj równomiernie co któreś ujęcie
        if (shotsLeft <= 0 || (fixed && maxShots < shots && Math.floor(shotsSeen * maxShots / shots) === Math.floor((shotsSeen - 1) * maxShots / shots))) continue;
        shotsLeft--;
        t += addShot(x.m, t, fixed ? T : null);
      }
    }
  }
  if (!segs.length) throw new Error('Nie udało się wybrać ujęć – dodaj więcej filmów albo zdjęć.');

  // ---------------- decyzje na podstawie treści (bez losowania)
  const decideTransition = (prev, sg) => {
    const prevEnd = prev.src + prev.dur * prev.speed;
    const cutsBetween = sg.m.analysis && (sg.m.analysis.cuts || []).some((c) => c > Math.min(prevEnd, sg.src) - 0.2 && c < Math.max(prevEnd, sg.src) + 0.2);
    if (prev.m === sg.m && sg.m.type === 'video' && Math.abs(sg.src - prevEnd) < 1.5 && !cutsBetween) return 'none'; // ta sama scena – zwykłe cięcie
    // przy mowie zwykłe cięcie (naturalnie jak w vlogach); spokojny/kinowy łagodnie zmieniają tylko film
    if (prev.speech || sg.speech) {
      if (prev.m === sg.m) return 'none';
      return o.style === 'calm' ? 'fade' : o.style === 'cinema' ? 'black' : 'none';
    }
    const dist = prev.stats && sg.stats ? colDist(prev.stats.endCol, sg.stats.startCol) : 0.3;
    const sceneChange = prev.m !== sg.m || dist > 0.2 || cutsBetween;
    if (!sceneChange) return S.same === 'fade' && dist > 0.12 ? 'fade' : 'none';
    if (energy && !sg.speech && eAt(sg.beatIdx) >= q75) return S.strong; // mocny akcent w muzyce
    if (o.style === 'energy' || o.style === 'vlog') return dist > 0.25 ? S.change : 'none';
    return S.change;
  };

  if (o.replace) { P.clips = []; P.tracks = P.tracks.filter((tr) => tr.main); }
  const t0 = o.replace ? 0 : projectDuration(P);
  let tt = t0, photoN = 0;
  const ca = o.clipAudio || 'auto';
  segs.forEach((sg, i) => {
    const prev = segs[i - 1];
    const c = makeMediaClip(P, sg.m, 'main', tt);
    c.duration = sg.dur;
    sg.stats = sg.m.type === 'video' ? windowStats(sg.m, sg.src, sg.src + sg.dur * sg.speed) : null;
    if (sg.m.type === 'video') {
      c.in = sg.src;
      c.speed = +sg.speed.toFixed(4);
      if (sg.speech) { c.muted = false; c.volume = 1; }
      else if (ca === 'keep' || (S.keepAudio && ca !== 'mute')) c.volume = 1;
      else if (ca === 'low') c.volume = 0.3;
      else c.muted = true;
      // ruch kamery tylko na nieruchomych ujęciach – filmy z ruchem same „żyją”
      const still = sg.stats.motion <= (sg.m.analysis.stillThr || 0) * 1.05;
      if (!sg.speech && still && S.still !== 'none') { c.motion = S.still; c.motionAmt = 0.6; }
      else if (sg.speech && o.style === 'energy') { c.motion = 'zoomin'; c.motionAmt = 0.35; }
    } else {
      c.motion = ['zoomin', 'panright', 'zoomout', 'panleft'][photoN++ % 4];
      c.motionAmt = 0.9;
    }
    if (S.filter !== 'none') c.filter.preset = S.filter;
    if (prev) {
      const type = decideTransition(prev, sg);
      if (type !== 'none' && sg.dur > 0.45) c.transIn = { type, dur: +Math.min(S.transDur, sg.dur * 0.45, prev.dur * 0.8).toFixed(3) };
    }
    if (i === 0 && S.fadeIn) c.fadeIn = S.fadeIn;
    if (i === segs.length - 1 && S.fadeOut) c.fadeOut = Math.min(S.fadeOut, sg.dur * 0.6);
    P.clips.push(c);
    sg.clip = c;
    tt += sg.dur;
  });
  const end = tt;

  // ---------------- muzyka: ciszej, gdy ktoś mówi
  if (music) {
    const tr = addTrack(P, 'audio');
    tr.name = 'Muzyka';
    const one = music.duration - mIn;
    const baseVol = ca === 'keep' ? 0.35 : ca === 'low' ? 0.85 : 1;
    const parts = [];
    for (const sg of segs) {
      const vol = sg.speech ? 0.18 : baseVol;
      const last = parts[parts.length - 1];
      if (last && last.vol === vol) last.b = sg.clip.start + sg.clip.duration; else parts.push({ a: sg.clip.start, b: sg.clip.start + sg.clip.duration, vol });
    }
    let lastClip = null;
    for (const pt of parts) {
      let a = pt.a;
      while (a < pt.b - 0.02) {
        const pos = (a - t0) % one;
        const len = Math.min(pt.b - a, one - pos);
        lastClip = { ...makeMediaClip(P, music, tr.id, a), in: mIn + pos, duration: len, volume: pt.vol };
        P.clips.push(lastClip);
        a += len;
      }
    }
    if (lastClip) lastClip.aFadeOut = Math.min(2, lastClip.duration * 0.4);
  }

  // ---------------- akcenty obrazu na najmocniejszych uderzeniach (tylko tam, gdzie nikt nie mówi)
  let accents = 0;
  if (S.accents && energy) {
    let fxTr = null, lastK = -99;
    const nb = Math.floor((end - t0) / beat);
    for (let k = 1; k < nb; k++) {
      const e = eAt(k);
      if (e < q90 || e < eAt(k - 1) || e < eAt(k + 1) || k - lastK < 4) continue;
      const time = t0 + k * beat;
      const sg = segs.find((s) => s.clip.start <= time && time < s.clip.start + s.clip.duration);
      if (!sg || sg.speech) continue;
      const kind = e - eAt(k - 1) > 0.45 ? 'shake' : 'zoom';
      if (!fxTr) { fxTr = addTrack(P, 'fx'); fxTr.name = 'Efekty'; }
      const fx = makeFxClip(fxTr.id, time, kind, FX_TYPES[kind]);
      fx.amt = 0.8;
      fx.auto = 'montage';
      P.clips.push(fx);
      lastK = k;
      accents++;
    }
  }

  // ---------------- mowa: napisy i efekty przy słowach-kluczach
  const speechMade = segs.filter((s) => s.speech && !s.m._voiceOnly).map((s) => s.clip);
  let caps = 0, keyFx = 0;
  if (speechMade.length && o.captions !== false) {
    const big = S.captions === 'big';
    caps = buildCaptions(app, speechMade, { style: S.captions, chunk: big ? 'tiktok' : 'short', pos: big ? 'center' : 'bottom', upper: big, hl: '#ffd400', replace: false }).length;
  }
  if (speechMade.length && o.speechFx !== false) {
    const words = [];
    for (const c of speechMade) { const md = app.media.get(c.mediaId); if (md && md.transcript) words.push(...clipWords(c, md.transcript)); }
    words.sort((a, b) => a.t0 - b.t0);
    const hits = findKeywords(words, RULES);
    if (hits.length) keyFx = await applySpeechFx(app, hits, { sounds: true, motion: true, stickers: true, volume: 0.8, replace: false });
  }
  if (o.title && o.title.trim()) {
    const pr = (TEXT_PRESETS.find((p) => p.label === S.title) || TEXT_PRESETS[0]).p;
    const tr = addTrack(P, 'text');
    const y = caps && S.captions === 'big' ? -0.32 : S.titleY;
    const tc = makeTextClip(tr.id, t0 + Math.min(0.2, beat), { ...pr, text: o.title.trim(), y, duration: clamp((end - t0) * 0.25, 2, 3.5), animOut: 'fade' });
    tc.name = 'Tytuł';
    P.clips.push(tc);
    app.loadFont(tc);
  }
  normalize(P);
  const extra = [...warnings];
  if (speechMade.length) extra.push(`mowa: ${speechMade.length} ${speechMade.length === 1 ? 'fragment' : 'fragmenty'}`);
  if (caps) extra.push(`napisy: ${caps}`);
  if (keyFx) extra.push(`efekty ze słów: ${keyFx}`);
  if (accents) extra.push(`akcenty: ${accents}`);
  return { duration: end - t0, cuts: segs.length, bpm: music ? Math.round(bpm) : null, music: music ? music.name : null, extra };
}

// ------------------------------------------------------------------ okno
const LS = 'kadr.auto';
export function openAutoMontage(app, opts = {}) {
  const P = app.store.project;
  if (!P) return;
  app.player.pause();
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } })();
  const all = app.media.list(P.id);
  const visual = all.filter((m) => m.type !== 'audio' && m.status !== 'error');
  const audios = all.filter((m) => m.type === 'audio' && m.status === 'ready' && !/\(\d+ BPM\)$/.test(m.name));
  const sel = new Set(opts.mediaIds || visual.map((m) => m.id));
  const o = opts.state ? { ...opts.state } : {
    style: saved.style || 'energy',
    music: audios.length ? audios[audios.length - 1].id : 'beat:auto',
    length: saved.length || 'auto',
    title: '',
    clipAudio: 'auto',
    shuffle: !!saved.shuffle,
    replace: true,
    captions: saved.captions !== false,
    speechFx: saved.speechFx !== false,
  };

  // miniatury filmów dochodzą w tle – dorysuj je, gdy będą gotowe
  const offMedia = app.media.onChange(() => {
    for (const el of document.querySelectorAll('.am-item[data-id]')) {
      const md = app.media.get(el.dataset.id);
      const th = el.querySelector('.thumb');
      if (md && md.thumb && th && !th.style.backgroundImage) { th.style.backgroundImage = `url(${md.thumb})`; th.replaceChildren(); }
    }
  });
  const m = modal({ title: 'Auto-montaż', icon: 'wand-sparkles', wide: true, onClose: () => offMedia() });
  const render = () => {
    // materiał
    const grid = h('div', { class: 'am-grid' });
    for (const md of visual) {
      const it = h('button', { class: `am-item${sel.has(md.id) ? ' on' : ''}`, title: md.name, 'data-id': md.id },
        h('div', { class: 'thumb', style: md.thumb ? { backgroundImage: `url(${md.thumb})` } : null }, md.thumb ? null : ic(md.type === 'image' ? 'image' : 'film')),
        h('span', { class: 'chk' }, ic('check')),
        md.type === 'video' ? h('span', { class: 'dur' }, fmtDur(md.duration)) : null);
      it.addEventListener('click', () => { if (sel.has(md.id)) sel.delete(md.id); else sel.add(md.id); render(); });
      grid.append(it);
    }
    const addBtn = h('button', { class: 'am-item am-add', title: 'Dodaj pliki' }, ic('plus'), h('span', null, 'Dodaj'));
    addBtn.addEventListener('click', async () => {
      const files = await app.pickFilesAsync('video/*,image/*,audio/*');
      if (!files.length) return;
      m.close();
      await app.importFiles(files, null, { noAutoAdd: true });
      openAutoMontage(app, opts);
    });
    grid.append(addBtn);
    // styl
    const styles = h('div', { class: 'am-styles' });
    for (const [id, s] of Object.entries(STYLES)) {
      const b = h('button', { class: `am-style${o.style === id ? ' on' : ''}` }, h('span', { class: 'ic' }, ic(s.icon)), h('b', null, s.name), h('span', null, s.desc));
      b.addEventListener('click', () => { o.style = id; render(); });
      styles.append(b);
    }
    // muzyka
    const mus = h('select', { class: 'inp' },
      h('option', { value: 'beat:auto' }, '🎵 Bit dopasowany do stylu'),
      BEATS.map((b) => h('option', { value: 'beat:' + b.id }, `🎵 ${b.name} – ${b.desc}`)),
      audios.map((a) => h('option', { value: a.id }, `🎧 ${a.name} (${fmtDur(a.duration)})`)),
      h('option', { value: 'none' }, '🔇 Bez muzyki'));
    mus.value = o.music;
    mus.addEventListener('change', () => { o.music = mus.value; render(); });
    const musRow = h('div', { class: 'row', style: { gap: '6px' } }, mus,
      h('button', { class: 'btn sm', title: 'Dodaj własną muzykę', onclick: async () => {
        const files = await app.pickFilesAsync('audio/*');
        if (!files.length) return;
        m.close();
        await app.importFiles(files, null, { noAutoAdd: true });
        openAutoMontage(app, opts);
      } }, ic('upload'), 'Własna'));
    // długość
    const lens = [['auto', 'Auto'], ['15', '15 s'], ['30', '30 s'], ['60', '60 s'], ['music', 'Cała muzyka']];
    const lenEl = h('div', { class: 'chips' }, lens.map(([v, n]) => {
      const b = h('button', { class: String(o.length) === v ? 'on' : '' }, n);
      b.addEventListener('click', () => { o.length = v; render(); });
      return b;
    }));
    // dźwięk z filmów
    const ca = o.clipAudio || 'auto';
    const caEl = h('div', { class: 'seg' }, [['auto', 'Auto (mowa zostaje)'], ['mute', 'Wyciszony'], ['keep', 'Normalny']].map(([v, n]) => {
      const b = h('button', { class: ca === v ? 'on' : '' }, n);
      b.addEventListener('click', () => { o.clipAudio = v; render(); });
      return b;
    }));
    const title = h('input', { class: 'inp', value: o.title, placeholder: 'np. Wakacje 2026 (możesz zostawić puste)', maxlength: 60 });
    title.addEventListener('input', () => { o.title = title.value; });
    title.addEventListener('keydown', (e) => e.stopPropagation());
    const sw = (key, label) => {
      const cb = h('input', { type: 'checkbox', checked: o[key] });
      cb.addEventListener('change', () => { o[key] = cb.checked; });
      return h('label', { class: 'am-check' }, h('span', { class: 'switch' }, cb, h('span')), label);
    };
    m.setBody(
      h('div', { class: 'am-sec' }, h('h4', null, `1. Materiał `, h('span', { class: 'muted' }, `(zaznaczone: ${[...sel].filter((id) => visual.some((v) => v.id === id)).length} z ${visual.length})`)), visual.length ? null : h('p', { class: 'muted' }, 'Dodaj filmy lub zdjęcia przyciskiem „Dodaj”.'), grid),
      h('div', { class: 'am-sec' }, h('h4', null, '2. Styl'), styles),
      h('div', { class: 'am-cols' },
        h('div', { class: 'am-sec' }, h('h4', null, '3. Muzyka'), musRow),
        h('div', { class: 'am-sec' }, h('h4', null, '4. Długość'), lenEl)),
      h('div', { class: 'am-cols' },
        h('div', { class: 'am-sec' }, h('h4', null, 'Tytuł na początku'), title),
        h('div', { class: 'am-sec' }, h('h4', null, 'Dźwięk z filmów'), caEl)),
      h('div', { class: 'am-opts' }, sw('captions', 'Napisy, gdy ktoś mówi'), sw('speechFx', 'Dźwięki i naklejki przy słowach-kluczach'), sw('shuffle', 'Losowa kolejność ujęć'), P.clips.length ? sw('replace', 'Zastąp to, co jest na osi czasu') : null),
      h('div', { class: 'tip', style: { marginTop: '12px', marginBottom: 0 } }, ic('brain'), h('span', null, 'Program patrzy, co jest w filmach: zostawia całe zdania (bez powtórek), omija nieostre i ciemne momenty, nie tnie w środku sceny, przejście daje tylko przy zmianie sceny, a zoomy na najmocniejszych uderzeniach muzyki.')),
    );
    m.setFoot(
      h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', disabled: !visual.some((v) => sel.has(v.id)), onclick: () => run() }, ic('wand-sparkles'), 'Zrób film'),
    );
  };

  const run = async () => {
    const opt = { ...o, clipAudio: o.clipAudio || 'auto', mediaIds: visual.filter((v) => sel.has(v.id)).map((v) => v.id), seed: (Date.now() ^ (Math.random() * 1e9)) & 0x7fffffff };
    if (!app.store.project.clips.length) opt.replace = true;
    localStorage.setItem(LS, JSON.stringify({ style: o.style, length: o.length, shuffle: o.shuffle, captions: o.captions, speechFx: o.speechFx }));
    const steps = { load: 'Wczytuję pliki', music: 'Przygotowuję muzykę', rhythm: 'Słucham rytmu muzyki', audio: 'Czytam dźwięk z filmów', shots: 'Oglądam filmy: sceny, ruch, ostrość', speech: 'Słucham, co mówisz', build: 'Składam film' };
    const list = h('div', { class: 'am-steps' });
    const subEl = h('div', { class: 'muted', style: { fontSize: '12.5px', textAlign: 'center', minHeight: '18px' } });
    const show = (key, i, n, txt) => {
      for (const el of list.children) { if (el.dataset.k !== key) { el.classList.remove('now'); el.classList.add('done'); } }
      let el = list.querySelector(`[data-k="${key}"]`);
      if (!el) { el = h('div', { 'data-k': key }, h('span', { class: 'spin' }), h('span', { class: 'lbl' })); list.append(el); subEl.textContent = ''; }
      el.classList.remove('done');
      el.classList.add('now');
      el.querySelector('.lbl').textContent = steps[key] + (n ? ` (${i}/${n})` : '') + '…';
      if (txt) subEl.textContent = txt;
    };
    m.canClose = false;
    m.setTitle('Robię film…');
    m.setBody(h('div', { class: 'am-run' }, h('div', { class: 'am-wand' }, ic('wand-sparkles')), list, subEl));
    m.setFoot();
    try {
      const res = await buildMontage(app, opt, show);
      m.canClose = true;
      m.close();
      app.afterAutoMontage(res, () => openAutoMontage(app, { mediaIds: opt.mediaIds, state: { ...o, replace: true }, autoRun: true }));
    } catch (e) {
      console.error(e);
      m.canClose = true;
      m.setTitle('Auto-montaż');
      toast(e.message || 'Nie udało się zrobić filmu', 'err', 5000);
      render();
    }
  };
  render();
  if (opts.autoRun) run();
}
