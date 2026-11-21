// Rozpoznawanie mowy – dwa silniki:
//  • komputer z serwerem KadrStudio: Whisper „small” na karcie graficznej (szybko, dokładnie),
//  • telefon / bez laptopa: Whisper „small” (dokładny) albo „base” (szybki) w samej aplikacji (transformers.js, WebGPU albo WASM).
//    Model pobiera się raz z Hugging Face i zostaje w pamięci telefonu – potem działa bez internetu.
import { audioBufferToWav } from './audio.js';
import { db } from './db.js';

const SR = 16000;
// Modele w aplikacji: „dokładny” (small, ok. 250 MB – dużo lepiej rozumie polski) i „szybki” (base, ok. 77 MB).
export const LOCAL_MODELS = {
  accurate: { id: 'onnx-community/whisper-small_timestamped', name: 'Dokładne', size: '≈ 250 MB' },
  fast: { id: 'onnx-community/whisper-base_timestamped', name: 'Szybkie', size: '≈ 77 MB' },
};
export function localQuality() {
  let q = null;
  try { q = localStorage.getItem('kadr.asrQuality'); } catch { /* */ }
  if (q && LOCAL_MODELS[q]) return q;
  // domyślnie dokładny, chyba że urządzenie ma mało pamięci
  return (navigator.deviceMemory || 8) >= 4 ? 'accurate' : 'fast';
}
export function setLocalQuality(q) {
  try { localStorage.setItem('kadr.asrQuality', q); } catch { /* */ }
  if (pipeKey !== q) dropPipeline();
}
// zwalnia pamięć po poprzednim modelu (ważne w telefonie)
function dropPipeline() {
  const old = pipeP;
  pipeP = null; pipeKey = null;
  if (old) old.then((p) => p && p.dispose && p.dispose()).catch(() => {});
}

async function to16k(buf) {
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * SR)), SR);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

export async function serverSpeech(app) {
  if (!app.serverLocal) return null;
  try { const r = await fetch('/api/speech', { cache: 'no-store' }); const j = r.ok ? await r.json() : null; return j && j.available ? j : null; } catch { return null; }
}
export function localSpeechSupported() { return typeof WebAssembly === 'object' && typeof OfflineAudioContext === 'function'; }

// który silnik zostanie użyty
export async function speechEngine(app) {
  const s = await serverSpeech(app);
  if (s) return { kind: 'server', status: s };
  if (localSpeechSupported()) return { kind: 'local' };
  return null;
}

// ------------------------------------------------------------------ silnik na serwerze (komputer)
async function transcribeServer(buf) {
  const wav = audioBufferToWav(await to16k(buf));
  const r = await fetch('/api/transcribe?lang=pl', { method: 'POST', headers: { 'X-Kadr': '1' }, body: wav });
  let j;
  try { j = await r.json(); } catch { j = { ok: false, error: `Błąd serwera (${r.status})` }; }
  if (!j.ok) throw new Error(j.error || 'Nie udało się rozpoznać mowy');
  return { segments: j.segments, language: j.language, model: j.model, engine: 'server' };
}

// ------------------------------------------------------------------ silnik w aplikacji (telefon)
let pipeP = null;
let pipeKey = null;
let threads = 1;
// próbny wątek – jeśli nie odpowie, liczymy na jednym rdzeniu (zamiast zawiesić rozpoznawanie)
function workersOk() {
  if (!self.crossOriginIsolated || typeof Worker !== 'function') return Promise.resolve(false);
  return new Promise((res) => {
    let w;
    const end = (v) => { clearTimeout(t); try { w && w.terminate(); } catch { /* */ } res(v); };
    const t = setTimeout(() => end(false), 4000);
    try {
      w = new Worker(new URL('../vendor/transformers/probe-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => end(e.data === true);
      w.onerror = () => end(false);
    } catch { end(false); }
  });
}
export function speechThreads() { return threads; }
let progressCb = null;
async function getPipeline() {
  const q = localQuality();
  if (pipeP && pipeKey !== q) dropPipeline();
  if (!pipeP) {
    pipeKey = q;
    const LOCAL_MODEL = LOCAL_MODELS[q].id;
    pipeP = (async () => {
      const T = await import('../vendor/transformers/transformers.min.js');
      T.env.allowLocalModels = false;
      T.env.useBrowserCache = true;
      T.env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;
      // wiele rdzeni, gdy strona jest „izolowana” (nagłówki dokłada service worker) i wątki naprawdę startują
      T.env.backends.onnx.wasm.numThreads = (await workersOk()) ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
      threads = T.env.backends.onnx.wasm.numThreads;
      // Telefon: tryb WASM i model skwantowany (mniej pamięci, stabilniej – WebGPU na telefonach
      // potrafi zawiesić albo zamknąć stronę). Komputer: WebGPU (szybciej).
      const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (navigator.userAgentData && navigator.userAgentData.mobile);
      let gpu = false;
      if (!mobile) { try { gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { gpu = false; } }
      const progress_callback = (p) => { if (progressCb) progressCb(p); };
      const wasm = { device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, progress_callback };
      const opts = gpu ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback } : wasm;
      try {
        return await T.pipeline('automatic-speech-recognition', LOCAL_MODEL, opts);
      } catch (e) {
        if (!gpu) throw e;
        return T.pipeline('automatic-speech-recognition', LOCAL_MODEL, wasm);
      }
    })();
    pipeP.catch(() => { pipeP = null; });
  }
  return pipeP;
}

// Proste wykrywanie mowy po głośności – każdy fragment rozpoznajemy osobno (Whisper nie pomija wtedy powtórek).
function speechChunks(x, joinGap = 0.25) {
  const fl = Math.round(SR * 0.02);
  const n = Math.floor(x.length / fl);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * fl; j < (i + 1) * fl; j++) s += x[j] * x[j];
    e[i] = Math.sqrt(s / fl);
  }
  const sorted = Array.from(e).sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.2)] || 0;
  const peak = sorted[Math.floor(n * 0.98)] || 0;
  const thr = Math.max(0.006, floor * 3, peak * 0.08);
  const chunks = [];
  let cur = null, silent = 0;
  for (let i = 0; i < n; i++) {
    if (e[i] > thr) {
      if (!cur) cur = [i, i];
      cur[1] = i;
      silent = 0;
    } else if (cur && ++silent > 14) { chunks.push(cur); cur = null; }
  }
  if (cur) chunks.push(cur);
  const out = [];
  for (const [a, b] of chunks) {
    if (b - a < 6) continue; // krócej niż 0,12 s – szum
    let s = Math.max(0, (a - 6) * fl), en = Math.min(x.length, (b + 8) * fl);
    const last = out[out.length - 1];
    if (last && s - last[1] < SR * joinGap && en - last[0] < SR * 20) { last[1] = en; continue; }
    while (en - s > SR * 20) { out.push([s, s + SR * 20]); s += SR * 20; }
    out.push([s, en]);
  }
  return out;
}

export async function transcribeLocal(buf, onStatus) {
  // postęp pobierania liczony łącznie dla wszystkich plików modelu
  const files = {};
  progressCb = (p) => {
    if (!onStatus) return;
    if (p.status === 'progress' && p.file) {
      files[p.file] = { l: p.loaded || 0, t: p.total || 0 };
      const all = Object.values(files);
      const t = all.reduce((a, f) => a + f.t, 0), l = all.reduce((a, f) => a + f.l, 0);
      if (t > 2e6) onStatus(`Pobieram model mowy do aplikacji (jednorazowo): ${Math.round(l / 1e6)} z ${Math.round(t / 1e6)} MB…`);
    } else if (p.status === 'ready') onStatus('Model gotowy – rozpoznaję mowę w telefonie…');
  };
  const pipe = await getPipeline();
  const q = pipeKey || localQuality();
  const x = (await to16k(buf)).getChannelData(0);
  // Kawałki z głosem (krótkie pauzy w zdaniu łączymy – więcej kontekstu = lepiej rozpoznane słowa).
  const chunks = speechChunks(x, 0.6);
  // Kawałki składamy w okna do ~24 s: Whisper i tak liczy zawsze 30 s naraz, więc mniej okien = dużo szybciej.
  const wins = [];
  for (const c of chunks) {
    const w = wins[wins.length - 1];
    if (w && c[1] - w.s < SR * 24 && c[0] - w.e < SR * 2.5) { w.e = c[1]; w.parts.push(c); } else wins.push({ s: c[0], e: c[1], parts: [c] });
  }
  const total = wins.reduce((t, w) => t + (w.e - w.s), 0) || 1;
  let done = 0;
  const t0 = performance.now();
  const tell = (wi) => {
    let eta = '';
    if (done > 0) {
      const sec = ((performance.now() - t0) / done) * (total - done) / 1000;
      if (sec > 5) eta = ` (zostało ok. ${sec < 90 ? Math.round(sec) + ' s' : Math.round(sec / 60) + ' min'})`;
    }
    onStatus && onStatus(`Rozpoznaję mowę w aplikacji: fragment ${wi + 1} z ${wins.length}${eta}…`);
  };
  const decode = async (s0, e0) => {
    // bardzo krótkie kawałki Whisper rozpoznaje słabo – dokładamy trochę otoczenia (min. 1,6 s)
    const need = SR * 1.6 - (e0 - s0);
    if (need > 0) { s0 = Math.max(0, s0 - Math.round(need / 2)); e0 = Math.min(x.length, s0 + SR * 1.6); }
    const off = s0 / SR;
    const res = await pipe(x.subarray(s0, e0), { language: 'polish', task: 'transcribe', return_timestamps: 'word', chunk_length_s: 30 });
    return (res.chunks || []).filter((w) => w.text && w.text.trim()).map((w) => ({
      start: +(off + (w.timestamp[0] || 0)).toFixed(3),
      end: +(off + (w.timestamp[1] == null ? (w.timestamp[0] || 0) + 0.3 : w.timestamp[1])).toFixed(3),
      word: w.text.startsWith(' ') ? w.text : ' ' + w.text,
      prob: 0.8,
    }));
  };
  const mid = (w) => (w.start + w.end) / 2;
  let all = [];
  for (let wi = 0; wi < wins.length; wi++) {
    tell(wi);
    const W = wins[wi];
    const words = await decode(W.s, W.e);
    all.push(...words);
    // Whisper w dłuższym oknie potrafi pominąć powtórzone zdanie – kawałki z głosem, w których
    // nie wypisał prawie nic, rozpoznajemy jeszcze raz osobno.
    if (W.parts.length > 1) {
      for (const [a, b] of W.parts) {
        const ta = a / SR, tb = b / SR;
        if (tb - ta < 0.6) continue;
        const inside = words.filter((w) => mid(w) >= ta && mid(w) <= tb);
        const covered = inside.reduce((t, w) => t + Math.max(0, Math.min(w.end, tb) - Math.max(w.start, ta)), 0);
        if (inside.length && covered > (tb - ta) * 0.3) continue;
        const extra = await decode(a, b);
        if (!extra.length) continue;
        all = all.filter((w) => !(mid(w) >= ta && mid(w) <= tb));
        all.push(...extra.filter((w) => mid(w) >= ta - 0.3 && mid(w) <= tb + 0.3));
      }
    }
    done += W.e - W.s;
  }
  all.sort((p, r) => p.start - r.start);
  // zdania (segmenty) dzielimy po przerwach – tak jak robi to rozpoznawanie na komputerze
  const segments = [];
  let cur = null;
  for (const w of all) {
    if (cur && (w.start - cur.end >= 0.6 || cur.words.length >= 40)) { segments.push(cur); cur = null; }
    if (!cur) cur = { start: w.start, end: w.end, words: [], avg_logprob: -0.3, no_speech_prob: 0 };
    cur.words.push(w);
    cur.end = Math.max(cur.end, w.end);
  }
  if (cur) segments.push(cur);
  for (const sg of segments) sg.text = sg.words.map((w) => w.word).join('').trim();
  const name = q === 'accurate' ? 'whisper-small' : 'whisper-base';
  return { segments, language: 'pl', model: `${name} (aplikacja)`, engine: 'local', quality: q };
}

// Fragmenty z głosem po samej głośności (gdy rozpoznawanie mowy nie zadziała) – w sekundach.
export async function voiceSegments(buf) {
  const x = (await to16k(buf)).getChannelData(0);
  return speechChunks(x).map(([a, b]) => ({ start: a / SR, end: b / SR }));
}

// ------------------------------------------------------------------ wspólne
// Rozpoznaje mowę w kilku plikach i opisuje postęp w okienku (ui.line / ui.sub).
export async function transcribeAll(app, list, ui) {
  list = list.filter(Boolean);
  if (!list.length) return;
  const eng = await speechEngine(app);
  const todo = list.filter((m) => (eng ? needsSpeech(m, eng) : !(m.transcript && m.transcript.segments)));
  if (!todo.length) return;
  if (!eng) throw new Error('To urządzenie nie potrafi rozpoznawać mowy.');
  let poll = 0;
  if (eng.kind === 'server' && !eng.status.modelReady) {
    poll = setInterval(async () => {
      const s = await serverSpeech(app);
      if (s && !s.modelReady) ui.sub(`Pierwszy raz pobieram model rozpoznawania mowy (jednorazowo, ok. 480 MB): ${Math.round(s.downloadedMB)} MB…`);
      else if (s) ui.sub('Model gotowy – rozpoznaję mowę…');
    }, 1000);
  }
  try {
    for (let i = 0; i < todo.length; i++) {
      ui.line(`Słucham, co mówisz: „${todo[i].name}”${todo.length > 1 ? ` (${i + 1}/${todo.length})` : ''}…`);
      ui.sub(eng.kind === 'server' ? 'Rozpoznaję mowę na komputerze.' : 'Rozpoznaję mowę w aplikacji – na telefonie może to chwilę potrwać.');
      await transcribeMedia(app, todo[i], (t) => ui.sub(t));
    }
  } finally {
    clearInterval(poll);
  }
}

// Słowa rozpoznane słabszym modelem rozpoznajemy jeszcze raz, gdy jest dostępny lepszy
// (laptop albo przełączenie na „Dokładne”).
function stale(tr, eng) {
  if (!tr || !tr.segments || tr.engine !== 'local') return false;
  if (eng.kind === 'server') return true;
  return localQuality() === 'accurate' && tr.quality !== 'accurate';
}
function needsSpeech(m, eng) { return !(m.transcript && m.transcript.segments) || stale(m.transcript, eng); }

export async function transcribeMedia(app, m, onStatus, force = false) {
  const eng = await speechEngine(app);
  if (!eng) {
    if (m.transcript && m.transcript.segments) return m.transcript;
    throw new Error('To urządzenie nie potrafi rozpoznawać mowy.');
  }
  if (!force && !needsSpeech(m, eng)) return m.transcript;
  if (!m.audio && m.audioReady) { onStatus && onStatus(`Czytam dźwięk z „${m.name}”…`); await m.audioReady; }
  if (!m.audio) throw new Error(m.audioError || `Nie mogę odczytać dźwięku z „${m.name}”`);
  const tr = eng.kind === 'server' ? await transcribeServer(m.audio) : await transcribeLocal(m.audio, onStatus);
  // Whisper potrafi „usłyszeć” typowe zdania z napisów w muzyce albo szumie – odrzuć je
  // (zwroty, które ktoś mógłby naprawdę powiedzieć, tylko gdy model jest ich niepewny)
  const HALLU = /amara|napisy (stworzone|wykonane|przygotowane)|subtitles by/i;
  const MAYBE = /dzięki za (obejrzenie|uwagę)|dziękuję za (obejrzenie|uwagę)|zapraszam do subskrypcji/i;
  tr.segments = tr.segments.filter((s) => !HALLU.test(s.text || '') && !(MAYBE.test(s.text || '') && (s.no_speech_prob > 0.4 || s.avg_logprob < -0.7)) && !(s.no_speech_prob > 0.8 && s.avg_logprob < -0.8));
  m.transcript = tr;
  db.put('media', app.media._record(m)).catch(() => {});
  return m.transcript;
}
