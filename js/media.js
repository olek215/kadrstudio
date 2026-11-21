// Pliki projektu: import, miniatury, dźwięk (dekodowanie + fala), zapis w IndexedDB.
import { db } from './db.js';
import { uid, once, sleep } from './util.js';

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', '3gp', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', 'ogv'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'heic'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'amr'];
const THUMB_H = 80;

function typeOf(file) {
  const t = file.type || '';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (t.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video';
  if (t.startsWith('image/') || IMAGE_EXT.includes(ext)) return 'image';
  if (t.startsWith('audio/') || AUDIO_EXT.includes(ext)) return 'audio';
  return null;
}

function seek(v, t) {
  return new Promise((res) => {
    const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); res(); };
    const to = setTimeout(done, 3000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

function probeVideo(url) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'metadata'; v.playsInline = true;
    const fail = (msg) => { clearTimeout(to); v.removeAttribute('src'); v.load(); rej(new Error(msg)); };
    const to = setTimeout(() => fail('Przekroczono czas odczytu'), 25000);
    v.onloadedmetadata = async () => {
      let d = v.duration;
      if (!isFinite(d)) {
        // np. nagrania z przeglądarki (webm) nie mają długości w nagłówku
        v.currentTime = 1e9;
        await Promise.race([once(v, 'durationchange'), sleep(4000)]);
        d = v.duration;
        v.currentTime = 0;
      }
      if (!v.videoWidth) return fail('Brak obrazu lub nieobsługiwany kodek');
      clearTimeout(to);
      const info = { duration: d, width: v.videoWidth, height: v.videoHeight };
      v.removeAttribute('src'); v.load();
      res(info);
    };
    v.onerror = () => fail((v.error && v.error.message) || 'Nie można odczytać wideo');
    v.src = url;
  });
}

function drawThumb(src, sw, sh, h = THUMB_H) {
  const w = Math.max(1, Math.round((h * sw) / sh));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  return c;
}

function computePeaks(buf, perSec = 50) {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
  const step = Math.max(1, Math.floor(buf.sampleRate / perSec));
  const n = Math.ceil(buf.length / step);
  const out = new Float32Array(n);
  let max = 0.0001;
  for (let i = 0; i < n; i++) {
    let mx = 0;
    const end = Math.min((i + 1) * step, buf.length);
    for (let j = i * step; j < end; j += 3) {
      const v = Math.abs(ch0[j]) + Math.abs(ch1[j]);
      if (v > mx) mx = v;
    }
    out[i] = mx / 2;
    if (out[i] > max) max = out[i];
  }
  const norm = Math.min(4, 1 / max);
  for (let i = 0; i < n; i++) out[i] = Math.min(1, out[i] * norm);
  return out;
}

const MIME_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
function extOf(file, mime) {
  const mt = (file && file.name ? file.name : '').toLowerCase().match(/\.([a-z0-9]{1,6})$/);
  return mt ? mt[1] : MIME_EXT[(mime || (file && file.type) || '').split(';')[0]] || 'bin';
}

// Plik leżący na dysku D: (serwer KadrStudio) – udaje Blob: size, slice().arrayBuffer(), arrayBuffer().
export class ServerFile {
  constructor(url, size, type, name) { this.url = url; this.size = size; this.type = type || ''; this.name = name || ''; }
  slice(a = 0, b = this.size) {
    const url = this.url;
    const s = Math.max(0, a), e = Math.min(this.size, b);
    return {
      size: Math.max(0, e - s),
      async arrayBuffer() {
        if (e <= s) return new ArrayBuffer(0);
        const r = await fetch(url, { headers: { Range: `bytes=${s}-${e - 1}` } });
        if (!r.ok) throw new Error('Nie można odczytać pliku z dysku');
        return r.arrayBuffer();
      },
    };
  }
  async arrayBuffer() {
    const r = await fetch(this.url);
    if (!r.ok) throw new Error('Nie można odczytać pliku z dysku');
    return r.arrayBuffer();
  }
}

export class MediaManager {
  constructor(getAudioCtx) {
    this.items = new Map();
    this.getAudioCtx = getAudioCtx;
    this.listeners = new Set();
    this.server = null; // {ffmpeg:true} gdy działa lokalny serwer
  }
  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  _emit(m) { for (const f of this.listeners) { try { f(m); } catch (e) { console.error(e); } } }
  get(id) { return this.items.get(id); }
  list(pid) { return [...this.items.values()].filter((m) => m.projectId === pid).sort((a, b) => a.created - b.created); }
  clear() {
    for (const m of this.items.values()) if (m.url && m.url.startsWith('blob:')) URL.revokeObjectURL(m.url);
    this.items.clear();
    this._emit();
  }
  static typeOf(f) { return typeOf(f); }
  // na komputerze z serwerem KadrStudio pliki leżą na dysku D: (folder Projekty), a nie w przeglądarce
  get useServer() { return !!(this.server && this.server.local !== false && this.server.storage); }

  _attachServer(m, ext, size, type) {
    if (m.url && m.url.startsWith('blob:')) URL.revokeObjectURL(m.url);
    m.stored = 'server';
    m.ext = ext;
    if (size != null) m.size = size;
    if (type) m.mime = type;
    m.url = `/api/media/${m.projectId}/${m.id}.${ext}`;
    m.blob = new ServerFile(m.url, m.size, m.mime, `${m.name}.${ext}`);
  }
  async _upload(m, file, ext) {
    const r = await fetch(`/api/media?project=${encodeURIComponent(m.projectId)}&id=${encodeURIComponent(m.id)}&ext=${ext}`, { method: 'POST', headers: { 'X-Kadr': '1' }, body: file });
    let j = null;
    try { j = await r.json(); } catch { /* */ }
    if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || `Nie udało się zapisać „${m.name}” na dysku`);
    this._attachServer(m, ext, file.size, file.type || m.mime);
  }
  _serverDelete(m) {
    if (m.stored !== 'server') return;
    fetch(`/api/media-delete?project=${encodeURIComponent(m.projectId)}&id=${encodeURIComponent(m.id)}`, { method: 'POST', headers: { 'X-Kadr': '1' } }).catch(() => {});
  }

  async importFile(file, projectId, onStatus) {
    const type = typeOf(file);
    if (!type) throw new Error(`Nieobsługiwany plik: ${file.name}`);
    const m = {
      id: uid('m'), projectId, name: file.name.replace(/\.[^.]+$/, '') || file.name, type,
      mime: file.type, size: file.size, created: Date.now(), fileTime: file.lastModified || Date.now(), blob: file, status: 'loading',
      duration: 0, width: 0, height: 0, hasAudio: false,
    };
    this.items.set(m.id, m);
    this._emit(m);
    try {
      if (this.useServer) await this._upload(m, file, extOf(file));
      await this._prepare(m, true, onStatus);
    } catch (e) {
      this.items.delete(m.id);
      this._serverDelete(m);
      this._emit(m);
      throw e;
    }
    await db.put('media', this._record(m));
    return m;
  }

  _record(m) {
    const { id, projectId, name, type, mime, size, created, fileTime, duration, width, height, hasAudio, transcript, stored, ext } = m;
    return { id, projectId, name, type, mime, size, created, fileTime, duration, width, height, hasAudio, transcript, stored, ext, blob: stored === 'server' ? null : m.blob };
  }

  async loadRecord(r) {
    const m = { ...r, status: 'loading' };
    if (r.stored === 'server') this._attachServer(m, r.ext, r.size, r.mime);
    this.items.set(m.id, m);
    this._emit(m);
    try { await this._prepare(m, false); } catch (e) { m.status = 'error'; m.error = e.message; this._emit(m); }
    if (m.status === 'ready' && m.stored !== 'server' && m.blob && this.useServer) this._queueMigrate(m);
    return m;
  }

  // stare projekty: przenieś pliki z pamięci przeglądarki (dysk C:) do folderu Projekty na D:
  _queueMigrate(m) {
    this._mig = (this._mig || Promise.resolve()).then(async () => {
      if (!this.items.has(m.id) || m.stored === 'server') return;
      try {
        await this._upload(m, m.blob, extOf(m.blob, m.mime));
        await db.put('media', this._record(m));
        this.migrated = (this.migrated || 0) + 1;
        this._emit(m);
      } catch (e) { console.warn('przenoszenie pliku', m.name, e); }
    });
    return this._mig;
  }

  // przenieś pliki wszystkich zapisanych projektów (także nieotwartych) na dysk D:
  async migrateAll() {
    if (!this.useServer || this._migAllDone) return 0;
    this._migAllDone = true;
    let n = 0;
    for (const r of await db.all('media')) {
      if (r.stored === 'server' || !r.blob || this.items.has(r.id)) continue;
      const m = { ...r };
      try {
        await this._upload(m, r.blob, extOf(r.blob, r.mime));
        await db.put('media', this._record(m));
        n++;
      } catch (e) { console.warn('przenoszenie pliku', r.name, e); }
    }
    return n;
  }

  async remove(id) {
    const m = this.items.get(id);
    if (!m) return;
    if (m.url && m.url.startsWith('blob:')) URL.revokeObjectURL(m.url);
    this.items.delete(id);
    this._serverDelete(m);
    await db.del('media', id);
    this._emit(m);
  }

  async _transcode(m, kind, onStatus) {
    if (!this.server || !this.server.ffmpeg || this.server.local === false) throw new Error(`Ta przeglądarka nie obsługuje pliku „${m.name}”`);
    onStatus && onStatus(`Konwertuję „${m.name}”…`);
    if (m.stored === 'server') {
      const r = await fetch(`/api/media-transcode?project=${encodeURIComponent(m.projectId)}&id=${encodeURIComponent(m.id)}&ext=${m.ext}&kind=${kind}`, { method: 'POST', headers: { 'X-Kadr': '1' } });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) throw new Error('Nie udało się przekonwertować pliku');
      this._attachServer(m, j.ext, j.size, j.mime);
      m.converted = true;
      return;
    }
    const r = await fetch(`/api/transcode?kind=${kind}`, { method: 'POST', headers: { 'X-Kadr': '1' }, body: m.blob });
    if (!r.ok) throw new Error('Nie udało się przekonwertować pliku');
    const b = await r.blob();
    if (m.url) URL.revokeObjectURL(m.url);
    const ext = kind === 'audio' ? 'm4a' : 'mp4';
    m.blob = new File([b], `${m.name}.${ext}`, { type: kind === 'audio' ? 'audio/mp4' : 'video/mp4' });
    m.mime = m.blob.type;
    m.size = b.size;
    m.url = URL.createObjectURL(m.blob);
    m.converted = true;
  }

  async _prepare(m, fresh, onStatus) {
    if (!m.url) m.url = URL.createObjectURL(m.blob);
    if (m.type === 'image') {
      const img = new Image();
      // zdarzenie "load" zamiast img.decode() – decode() potrafi się zawiesić, gdy okno jest w tle
      const ok = await new Promise((res) => {
        const to = setTimeout(() => res(img.complete && img.naturalWidth > 0), 20000);
        img.onload = () => { clearTimeout(to); res(true); };
        img.onerror = () => { clearTimeout(to); res(false); };
        img.src = m.url;
      });
      if (!ok || !img.naturalWidth) throw new Error(`Nie można otworzyć obrazu „${m.name}”`);
      m.img = img;
      m.width = img.naturalWidth || 1080;
      m.height = img.naturalHeight || 1080;
      m.duration = 0;
      const th = drawThumb(img, m.width, m.height, 160);
      m.thumbs = [{ t: 0, c: drawThumb(img, m.width, m.height) }];
      m.thumb = th.toDataURL('image/jpeg', 0.8);
      m.status = 'ready';
      this._emit(m);
      return;
    }
    if (m.type === 'video') {
      let info;
      try {
        info = await probeVideo(m.url);
      } catch (e) {
        if (!fresh) throw e;
        await this._transcode(m, 'video', onStatus);
        info = await probeVideo(m.url);
      }
      Object.assign(m, info);
      m.status = 'ready';
      this._emit(m);
      // w tle: miniatury i dźwięk
      this._videoThumbs(m).catch((e) => console.warn('miniatury', e));
      this._decodeAudio(m).catch(() => {});
      return;
    }
    if (m.type === 'audio') {
      try {
        await this._decodeAudio(m, true);
      } catch (e) {
        if (!fresh) throw e;
        await this._transcode(m, 'audio', onStatus);
        await this._decodeAudio(m, true);
      }
      m.duration = m.audio.duration;
      m.hasAudio = true;
      m.status = 'ready';
      this._emit(m);
    }
  }

  async _videoThumbs(m) {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.src = m.url;
    await once(v, 'loadeddata', 20000);
    const n = Math.max(4, Math.min(40, Math.ceil(m.duration / 1.5)));
    m.thumbs = [];
    for (let i = 0; i < n; i++) {
      const t = Math.min(m.duration - 0.05, ((i + 0.5) * m.duration) / n);
      await seek(v, Math.max(0, t));
      m.thumbs.push({ t, c: drawThumb(v, v.videoWidth, v.videoHeight) });
      if (i === 0) {
        await seek(v, Math.min(m.duration * 0.15, 1.5));
        m.thumb = drawThumb(v, v.videoWidth, v.videoHeight, 160).toDataURL('image/jpeg', 0.8);
        this._emit(m);
      }
      if (i % 6 === 5) this._emit(m);
    }
    v.removeAttribute('src'); v.load();
    this._emit(m);
  }

  async _decodeAudio(m, required = false) {
    if (m.blob.size > 1.2 * 1024 * 1024 * 1024) { if (required) throw new Error('Plik audio jest zbyt duży'); return; }
    const ac = this.getAudioCtx();
    const ab = await m.blob.arrayBuffer();
    let buf;
    try {
      buf = await ac.decodeAudioData(ab);
    } catch (e) {
      m.hasAudio = false;
      if (required) throw new Error(`Nie można odczytać dźwięku „${m.name}”`);
      this._emit(m);
      return;
    }
    m.audio = buf;
    m.hasAudio = true;
    m.peaks = computePeaks(buf);
    this._emit(m);
    if (m.type === 'video' && !m._savedAudioFlag) {
      m._savedAudioFlag = true;
      db.put('media', this._record(m)).catch(() => {});
    }
  }

  // Zamiana obrazu z płótna na nowy plik (np. stop-klatka).
  async importBlob(blob, name, projectId) {
    const file = new File([blob], name, { type: blob.type });
    return this.importFile(file, projectId);
  }
}
