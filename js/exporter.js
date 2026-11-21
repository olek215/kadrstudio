// Eksport do MP4 (H.264 + AAC) klatka po klatce – przez WebCodecs, szybciej niż w czasie rzeczywistym.
import { h, ic, fmtTime, fmtBytes, downloadBlob, sleep, clamp } from './util.js';
import { projectDuration } from './model.js';
import { Renderer } from './renderer.js';
import { VideoPool } from './player.js';
import { scheduleAudio } from './audio.js';
import { modal, toast } from './ui.js';
import { getDecodeInfo, DecodedSource } from './decoder.js';

// Oddaj na chwilę wątek (bez setTimeout, który w tle jest mocno spowalniany).
function yieldTask() {
  return new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
}

export function outputSize(P, short) {
  const ar = P.width / P.height;
  if (ar >= 1) return { w: Math.round((short * ar) / 2) * 2, h: short };
  return { w: short, h: Math.round(short / ar / 2) * 2 };
}

const LEVELS = [[0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]];
async function pickAvc(w, h, fps, bitrate) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const ok = LEVELS.filter((l) => mbs <= l[1] && mbs * fps <= l[2]);
  const lv = (ok[0] || LEVELS[LEVELS.length - 1])[0].toString(16).padStart(2, '0');
  for (const prof of ['6400', '4d00', '42e0']) {
    for (const hw of ['no-preference', 'prefer-software']) {
      const cfg = { codec: `avc1.${prof}${lv}`, width: w, height: h, bitrate, framerate: fps, hardwareAcceleration: hw, avc: { format: 'avc' }, latencyMode: 'quality' };
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return cfg; } catch { /* dalej */ }
    }
  }
  return null;
}
async function pickAudio(sr) {
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate: sr, numberOfChannels: 2, bitrate: 192000 };
    try { const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) return { cfg, mux }; } catch { /* dalej */ }
  }
  return null;
}
function waitReady(v) {
  if (v.readyState >= 2) return Promise.resolve();
  return new Promise((res) => {
    const done = () => { clearTimeout(to); v.removeEventListener('loadeddata', done); res(); };
    const to = setTimeout(done, 10000);
    v.addEventListener('loadeddata', done);
  });
}
function seekExact(v, t) {
  return new Promise((res) => {
    if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2 && !v.seeking) return res();
    const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); res(); };
    const to = setTimeout(done, 5000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}
export async function ensureFonts(P) {
  const jobs = [];
  for (const c of P.clips) if (c.kind === 'text') jobs.push(document.fonts.load(`${c.italic ? 'italic ' : ''}${c.weight || 400} 48px "${c.font}"`, c.text || 'A').catch(() => {}));
  await Promise.race([Promise.all(jobs), sleep(4000)]);
}

export async function renderVideo({ P, media, opts, onProgress, signal }) {
  const { w, h } = outputSize(P, opts.res);
  const fps = opts.fps;
  const dur = projectDuration(P);
  const N = Math.max(1, Math.round(dur * fps));
  const bpp = { low: 0.05, med: 0.09, high: 0.15, max: 0.24 }[opts.quality] || 0.09;
  const bitrate = Math.round(clamp(w * h * fps * bpp, 1e6, 80e6));
  const vcfg = await pickAvc(w, h, fps, bitrate);
  if (!vcfg) throw new Error('Ta przeglądarka nie potrafi zakodować H.264 w tej rozdzielczości. Spróbuj niższej.');

  onProgress({ stage: 'audio' });
  const SR = 48000;
  const actx = new OfflineAudioContext(2, Math.max(1, Math.ceil(dur * SR)), SR);
  scheduleAudio(actx, actx.destination, P, media, 0, dur, 0);
  const abuf = await actx.startRendering();
  const acfg = await pickAudio(SR);

  const muxer = new window.Mp4Muxer.Muxer({
    target: new window.Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    audio: acfg ? { codec: acfg.mux, numberOfChannels: 2, sampleRate: SR } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let err = null;
  if (acfg) {
    const aenc = new AudioEncoder({ output: (ch, meta) => muxer.addAudioChunk(ch, meta), error: (e) => { err = e; } });
    aenc.configure(acfg.cfg);
    const L = abuf.getChannelData(0), R = abuf.getChannelData(1);
    const CH = 4096;
    for (let off = 0; off < abuf.length; off += CH) {
      const n = Math.min(CH, abuf.length - off);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(off, off + n), 0);
      data.set(R.subarray(off, off + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off / SR) * 1e6), data });
      aenc.encode(ad);
      ad.close();
    }
    await aenc.flush();
    aenc.close();
  }
  if (err) throw err;

  const canvas = document.createElement('canvas');
  const pool = new VideoPool(media);
  const decoded = new Map(); // id klipu -> DecodedSource | 'seek'
  const frames = new Map(); // id klipu -> gotowa klatka w tej chwili
  const renderer = new Renderer(canvas, { media, videoOf: (c) => frames.get(c.id) || pool.get(c.id), exporting: true });
  renderer.resize(P, w, h);
  await ensureFonts(P);
  const venc = new VideoEncoder({ output: (ch, meta) => muxer.addVideoChunk(ch, meta), error: (e) => { err = e; } });
  venc.configure(vcfg);
  const t0 = performance.now();
  let fast = 0, slow = 0;
  try {
    for (let i = 0; i < N; i++) {
      if (signal.aborted) throw new DOMException('Przerwano', 'AbortError');
      if (err) throw err;
      const t = i / fps;
      const needs = renderer.videoNeeds(P, t);
      frames.clear();
      const ids = new Set(needs.map((n) => n.clip.id));
      for (const [id, src] of decoded) if (!ids.has(id)) { if (src !== 'seek') src.close(); decoded.delete(id); }
      const seekNeeds = [];
      for (const n of needs) {
        const m = media.get(n.clip.mediaId);
        let src = decoded.get(n.clip.id);
        if (src === undefined) {
          const info = m ? await getDecodeInfo(m) : null;
          src = info ? new DecodedSource(m, info) : 'seek';
          decoded.set(n.clip.id, src);
        }
        if (src !== 'seek') {
          try {
            const f = await src.frameAt(n.src);
            if (f) { frames.set(n.clip.id, f); fast++; continue; }
          } catch (e) {
            console.warn('[eksport] dekoder – przełączam na przewijanie', e);
            src.close();
            decoded.set(n.clip.id, 'seek');
          }
        }
        seekNeeds.push(n);
      }
      if (seekNeeds.length) {
        pool.update(seekNeeds);
        for (const n of seekNeeds) {
          const v = pool.get(n.clip.id);
          if (!v) continue;
          await waitReady(v);
          const m = media.get(n.clip.mediaId);
          const target = Math.min(n.src + (n.src > 0 ? 0.001 : 0), m && isFinite(m.duration) ? Math.max(0, m.duration - 0.02) : Infinity);
          await seekExact(v, target);
          slow++;
        }
      }
      renderer.render(P, t);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 8) await yieldTask();
      if (i % 4 === 0 || i === N - 1) {
        onProgress({ stage: 'video', i: i + 1, N, elapsed: (performance.now() - t0) / 1000 });
        await yieldTask();
      }
    }
    await venc.flush();
  } finally {
    try { venc.close(); } catch { /* już zamknięty */ }
    for (const src of decoded.values()) if (src !== 'seek') src.close();
    pool.destroy();
  }
  console.info(`[eksport] klatki wideo: szybko ${fast}, przewijaniem ${slow}`);
  if (err) throw err;
  onProgress({ stage: 'mux' });
  muxer.finalize();
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), w, h, fps, dur, codec: vcfg.codec, audio: acfg ? acfg.mux : null };
}

// ------------------------------------------------------------------ okno eksportu
export function openExport(app) {
  const P = app.store.project;
  const dur = projectDuration(P);
  if (!dur) { toast('Najpierw dodaj coś na oś czasu.', 'err'); return; }
  app.player.pause();
  if (!('VideoEncoder' in window) || !window.Mp4Muxer) {
    const m = modal({ title: 'Eksport niedostępny', icon: 'triangle-alert', body: [
      h('p', null, 'Do eksportu potrzebna jest przeglądarka Microsoft Edge lub Google Chrome w aktualnej wersji.'),
      !window.isSecureContext ? h('p', { class: 'muted' }, 'Ta strona jest otwarta przez zwykłe połączenie sieciowe (http). Otwórz KadrStudio na komputerze przez skrót na pulpicie.') : null,
    ] });
    m.setFoot(h('button', { class: 'btn primary', onclick: () => m.close() }, 'OK'));
    return;
  }
  const saved = JSON.parse(localStorage.getItem('kadr.export') || '{}');
  const short = Math.min(P.width, P.height);
  const resOpts = [720, 1080, 1440, 2160].map((r) => { const s = outputSize(P, r); return [r, `${r}p  (${s.w}×${s.h})`]; });
  const sel = (opts, val) => { const s = h('select', { class: 'inp' }, opts.map(([v, n]) => h('option', { value: v }, n))); s.value = String(val); return s; };
  const nameIn = h('input', { class: 'inp', value: P.name || 'film', maxlength: 70 });
  const resSel = sel(resOpts, saved.res || (short >= 1080 ? 1080 : 720));
  const fpsSel = sel([24, 25, 30, 50, 60].map((v) => [v, `${v} kl/s`]), saved.fps || P.fps);
  const qSel = sel([['low', 'Niska (mały plik)'], ['med', 'Standardowa'], ['high', 'Wysoka'], ['max', 'Maksymalna']], saved.quality || 'high');
  const est = h('span', { class: 'muted' });
  const upd = () => {
    const { w, h: hh } = outputSize(P, +resSel.value);
    const bpp = { low: 0.05, med: 0.09, high: 0.15, max: 0.24 }[qSel.value];
    const br = clamp(w * hh * +fpsSel.value * bpp, 1e6, 80e6) + 192000;
    est.textContent = `≈ ${fmtBytes((br * dur) / 8)} • długość ${fmtTime(dur)}`;
  };
  [resSel, fpsSel, qSel].forEach((s) => s.addEventListener('change', upd));
  nameIn.addEventListener('keydown', (e) => e.stopPropagation());
  upd();
  const m = modal({
    title: 'Eksport filmu', icon: 'download',
    body: [h('div', { class: 'form-grid' },
      h('label', null, 'Nazwa pliku'), nameIn,
      h('label', null, 'Rozdzielczość'), resSel,
      h('label', null, 'Płynność'), fpsSel,
      h('label', null, 'Jakość'), qSel,
      h('label', null, 'Rozmiar'), est,
    ),
    h('div', { class: 'tip', style: { marginTop: '16px', marginBottom: 0 } }, ic('info'), h('span', null, app.serverLocal ?'Film MP4 (H.264) zapisze się w folderze „Filmy” w KadrStudio – pasuje do TikToka, Instagrama i YouTube.' : 'Film MP4 (H.264) zostanie pobrany – pasuje do TikToka, Instagrama i YouTube.'))],
  });
  m.setFoot(
    h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Anuluj'),
    h('button', { class: 'btn primary', onclick: () => start() }, ic('clapperboard'), 'Eksportuj'),
  );

  async function start() {
    const opts = { res: +resSel.value, fps: +fpsSel.value, quality: qSel.value };
    localStorage.setItem('kadr.export', JSON.stringify(opts));
    const fileName = (nameIn.value || 'film').trim();
    const ac = new AbortController();
    const bar = h('div');
    const stage = h('b', null, 'Przygotowuję…');
    const stats = h('div', { class: 'export-stats' });
    m.setTitle('Eksportuję…');
    m.canClose = false;
    m.setBody(h('div', { style: { marginBottom: '10px' } }, stage), h('div', { class: 'progress' }, bar), stats,
      h('p', { class: 'muted', style: { fontSize: '12.5px', marginBottom: 0 } }, 'Nie zamykaj okna programu. Możesz przełączyć się do innej aplikacji.'));
    m.setFoot(h('button', { class: 'btn danger', onclick: () => ac.abort() }, ic('square'), 'Przerwij'));
    app.exporting = true;
    const snapshot = JSON.parse(JSON.stringify(P));
    try {
      const res = await renderVideo({
        P: snapshot, media: app.media, opts, signal: ac.signal,
        onProgress: (p) => {
          if (p.stage === 'audio') stage.textContent = 'Miksuję dźwięk…';
          else if (p.stage === 'mux') { stage.textContent = 'Zapisuję plik…'; bar.style.width = '100%'; }
          else if (p.stage === 'video') {
            stage.textContent = 'Renderuję obraz…';
            const frac = p.i / p.N;
            bar.style.width = (frac * 100).toFixed(1) + '%';
            const speed = p.i / Math.max(0.01, p.elapsed);
            const left = (p.N - p.i) / Math.max(0.01, speed);
            stats.replaceChildren(h('span', null, `${Math.round(frac * 100)}%`), h('span', null, `klatka ${p.i} / ${p.N}`), h('span', null, `${speed.toFixed(0)} kl/s`), h('span', null, `zostało ≈ ${fmtTime(left, 0)}`));
          }
        },
      });
      let savedName = null;
      if (app.serverLocal) {
        stage.textContent = 'Zapisuję w folderze Filmy…';
        try {
          const r = await fetch(`/api/save?name=${encodeURIComponent(fileName)}&ext=mp4`, { method: 'POST', headers: { 'X-Kadr': '1' }, body: res.blob });
          const j = await r.json();
          if (j.ok) savedName = j.file;
        } catch { /* pobierzemy zwykle */ }
      }
      if (!savedName) downloadBlob(res.blob, `${fileName}.mp4`);
      showDone(res, savedName, fileName);
    } catch (e) {
      m.canClose = true;
      if (e && e.name === 'AbortError') { m.close(); toast('Eksport przerwany.'); }
      else {
        console.error(e);
        m.setTitle('Coś poszło nie tak');
        m.setBody(h('p', null, 'Nie udało się wyeksportować filmu.'), h('p', { class: 'muted' }, String((e && e.message) || e)));
        m.setFoot(h('button', { class: 'btn primary', onclick: () => m.close() }, 'Zamknij'));
      }
    } finally {
      app.exporting = false;
    }
  }

  function showDone(res, savedName, fileName) {
    m.canClose = true;
    m.setTitle('Gotowe! 🎉');
    const url = URL.createObjectURL(res.blob);
    const vid = h('video', { class: 'export-preview', src: url, controls: true, playsinline: true });
    const prevClose = m.close;
    m.close = () => { URL.revokeObjectURL(url); prevClose(); };
    m.setBody(vid,
      h('div', { class: 'export-ok' }, ic('circle-check'), h('span', null, savedName ? `Zapisano: Filmy\\${savedName}` : `Pobrano plik ${fileName}.mp4`)),
      h('div', { class: 'export-stats' }, h('span', null, `${res.w}×${res.h}`), h('span', null, `${res.fps} kl/s`), h('span', null, fmtTime(res.dur)), h('span', null, fmtBytes(res.blob.size))));
    const file = new File([res.blob], `${fileName}.mp4`, { type: 'video/mp4' });
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    m.setFoot(
      canShare ? h('button', { class: 'btn', onclick: () => navigator.share({ files: [file], title: fileName }).catch(() => {}) }, ic('share-2'), 'Udostępnij') : null,
      savedName ? h('button', { class: 'btn', onclick: () => fetch('/api/open-folder', { headers: { 'X-Kadr': '1' } }) }, ic('folder-open'), 'Otwórz folder') : null,
      h('button', { class: 'btn', onclick: () => downloadBlob(res.blob, `${fileName}.mp4`) }, ic('download'), 'Pobierz kopię'),
      h('button', { class: 'btn primary', onclick: () => m.close() }, 'Zamknij'),
    );
    toast('Film wyeksportowany!', 'ok');
  }
}
