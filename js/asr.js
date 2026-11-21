// Rozpoznawanie mowy – dwa silniki:
//  • komputer z serwerem KadrStudio: Whisper „small” na karcie graficznej (szybko, dokładnie),
//  • telefon / bez laptopa: Whisper „base” uruchamiany w samej aplikacji (transformers.js, WebGPU albo WASM).
//    Model pobiera się raz z Hugging Face i zostaje w pamięci telefonu – potem działa bez internetu.
import { audioBufferToWav } from './audio.js';
import { db } from './db.js';

const SR = 16000;
const LOCAL_MODEL = 'onnx-community/whisper-base_timestamped';

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
let progressCb = null;
async function getPipeline() {
  if (!pipeP) {
    pipeP = (async () => {
      const T = await import('../vendor/transformers/transformers.min.js');
      T.env.allowLocalModels = false;
      T.env.useBrowserCache = true;
      T.env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;
      T.env.backends.onnx.wasm.numThreads = 1;
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
function speechChunks(x) {
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
    if (last && s - last[1] < SR * 0.25 && en - last[0] < SR * 20) { last[1] = en; continue; }
    while (en - s > SR * 20) { out.push([s, s + SR * 20]); s += SR * 20; }
    out.push([s, en]);
  }
  return out;
}

async function transcribeLocal(buf, onStatus) {
  progressCb = (p) => {
    if (!onStatus) return;
    if (p.status === 'progress' && p.total) onStatus(`Pobieram model mowy do aplikacji (jednorazowo): ${Math.round((p.loaded || 0) / 1e6)} z ${Math.round(p.total / 1e6)} MB…`);
    else if (p.status === 'ready') onStatus('Model gotowy – rozpoznaję mowę w telefonie…');
  };
  const pipe = await getPipeline();
  const x = (await to16k(buf)).getChannelData(0);
  const segments = [];
  const chunks = speechChunks(x);
  for (let ci = 0; ci < chunks.length; ci++) {
    const [s0, e0] = chunks[ci];
    onStatus && onStatus(`Rozpoznaję mowę w aplikacji: fragment ${ci + 1} z ${chunks.length}…`);
    const off = s0 / SR;
    const res = await pipe(x.subarray(s0, e0), { language: 'polish', task: 'transcribe', return_timestamps: 'word', chunk_length_s: 30 });
    const words = (res.chunks || []).filter((w) => w.text && w.text.trim()).map((w) => ({
      start: +(off + (w.timestamp[0] || 0)).toFixed(3),
      end: +(off + (w.timestamp[1] == null ? (w.timestamp[0] || 0) + 0.3 : w.timestamp[1])).toFixed(3),
      word: w.text.startsWith(' ') ? w.text : ' ' + w.text,
      prob: 0.8,
    }));
    if (!words.length) continue;
    segments.push({ start: words[0].start, end: words[words.length - 1].end, text: (res.text || '').trim(), avg_logprob: -0.3, no_speech_prob: 0, words });
  }
  return { segments, language: 'pl', model: 'whisper-base (aplikacja)', engine: 'local' };
}

// ------------------------------------------------------------------ wspólne
// Rozpoznaje mowę w kilku plikach i opisuje postęp w okienku (ui.line / ui.sub).
export async function transcribeAll(app, list, ui) {
  const todo = list.filter((m) => m && !(m.transcript && m.transcript.segments));
  if (!todo.length) return;
  const eng = await speechEngine(app);
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

export async function transcribeMedia(app, m, onStatus) {
  if (m.transcript && m.transcript.segments) return m.transcript;
  if (!m.audio) throw new Error(`„${m.name}” nie ma dźwięku albo jeszcze się wczytuje`);
  const eng = await speechEngine(app);
  if (!eng) throw new Error('To urządzenie nie potrafi rozpoznawać mowy.');
  const tr = eng.kind === 'server' ? await transcribeServer(m.audio) : await transcribeLocal(m.audio, onStatus);
  // Whisper potrafi „usłyszeć” typowe zdania z napisów w muzyce albo szumie – odrzuć je
  const HALLU = /amara|napisy (stworzone|wykonane|przygotowane)|dzięki za (obejrzenie|uwagę)|dziękuję za (obejrzenie|uwagę)|zapraszam do subskrypcji|subtitles by/i;
  tr.segments = tr.segments.filter((s) => !HALLU.test(s.text || '') && !(s.no_speech_prob > 0.8 && s.avg_logprob < -0.8));
  m.transcript = tr;
  db.put('media', app.media._record(m)).catch(() => {});
  return m.transcript;
}
