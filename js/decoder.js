// Szybkie dekodowanie klatek do eksportu: demuxer MP4/MOV (mp4box.js) + VideoDecoder (WebCodecs).
// Zamiast "przewijać" film do każdej klatki, dekodujemy go po kolei – kilkanaście razy szybciej.

let loading = null;
export function loadMp4box() {
  if (window.MP4Box) return Promise.resolve();
  if (!loading) {
    loading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/mp4box.all.min.js';
      s.onload = () => res();
      s.onerror = () => rej(new Error('Nie można wczytać mp4box'));
      document.head.append(s);
    });
  }
  return loading;
}

const infoCache = new Map();
export function getDecodeInfo(m) {
  if (!('VideoDecoder' in window) || m.type !== 'video') return Promise.resolve(null);
  const key = m.id + '|' + m.size;
  if (!infoCache.has(key)) infoCache.set(key, demux(m).catch((e) => { console.info('[eksport] dekodowanie przez przewijanie:', m.name, e.message); return null; }));
  return infoCache.get(key);
}

async function demux(m) {
  const name = (m.blob.name || m.name || '').toLowerCase();
  const mime = (m.mime || m.blob.type || '').toLowerCase();
  if (mime.includes('webm') || mime.includes('matroska') || /\.(webm|mkv)$/.test(name)) throw new Error('format bez MP4');
  await loadMp4box();
  const file = window.MP4Box.createFile();
  let info = null, failure = null;
  file.onReady = (i) => { info = i; };
  file.onError = (e) => { failure = new Error(String(e)); };
  const blob = m.blob;
  const CH = 8 * 1024 * 1024;
  for (let off = 0; off < blob.size && !info && !failure; off += CH) {
    const buf = await blob.slice(off, off + CH).arrayBuffer();
    buf.fileStart = off;
    file.appendBuffer(buf);
  }
  if (failure) throw failure;
  if (!info) { file.flush(); if (!info) throw new Error('brak nagłówka moov'); }
  const vt = info.videoTracks && info.videoTracks[0];
  if (!vt) throw new Error('brak ścieżki wideo');
  const trak = file.getTrackById(vt.id);
  let description;
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const DS = window.DataStream || window.MP4Box.DataStream;
      const ds = new DS(undefined, 0, DS.BIG_ENDIAN);
      box.write(ds);
      description = new Uint8Array(ds.buffer, 8);
      break;
    }
  }
  const raw = trak.samples || [];
  if (!raw.length) throw new Error('brak listy próbek (plik fragmentowany)');
  const ts = vt.timescale;
  // lista edycji (elst) – przesunięcie początku, tak jak robi to element <video>
  let shiftTicks = 0, delaySec = 0;
  const elst = trak.edts && trak.edts.elst && trak.edts.elst.entries;
  if (elst && elst.length) {
    const movieTs = (file.moov && file.moov.mvhd && file.moov.mvhd.timescale) || ts;
    for (const e of elst) {
      if (e.media_time === -1) delaySec += e.segment_duration / movieTs;
      else { shiftTicks = e.media_time; break; }
    }
  }
  const samples = raw.map((s) => ({ t: (s.cts - shiftTicks) / ts + delaySec, dur: s.duration / ts, sync: !!s.is_sync, offset: s.offset, size: s.size }));
  let rot = 0;
  if (vt.matrix) {
    const a = vt.matrix[0] / 65536, b = vt.matrix[1] / 65536;
    rot = (Math.round((Math.atan2(b, a) * 180) / Math.PI) + 360) % 360;
  }
  const w = vt.video ? vt.video.width : vt.track_width;
  const h = vt.video ? vt.video.height : vt.track_height;
  // kontrola: wymiary po obrocie muszą się zgadzać z tym, co pokazuje <video>
  const dw = rot % 180 ? h : w, dh = rot % 180 ? w : h;
  if (m.width && m.height && (Math.abs(dw / dh - m.width / m.height) > 0.02)) throw new Error('niezgodna orientacja');
  const config = { codec: vt.codec, codedWidth: w, codedHeight: h, description, optimizeForLatency: false };
  const sup = await VideoDecoder.isConfigSupported(config);
  if (!sup.supported) throw new Error('kodek nieobsługiwany: ' + vt.codec);
  return { samples, config, rot, w, h };
}

// Źródło klatek dla jednego klipu (czas rośnie po kolei).
export class DecodedSource {
  constructor(m, info) {
    this.m = m;
    this.info = info;
    this.frames = [];
    this.decoder = null;
    this.waiters = [];
    this.err = null;
    this.win = null;
    this.canvas = null;
  }
  _wake() { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
  _wait() { return new Promise((r) => { this.waiters.push(r); setTimeout(r, 3000); }); }
  _reset(t) {
    this.close();
    this.err = null;
    this.decoder = new VideoDecoder({
      output: (f) => { this.frames.push(f); this._wake(); },
      error: (e) => { this.err = e; this._wake(); },
    });
    this.decoder.configure(this.info.config);
    const S = this.info.samples;
    let k = 0;
    for (let i = 0; i < S.length; i++) if (S[i].sync && S[i].t <= t + 1e-4) k = i;
    this.feedIdx = k;
    this.flushed = false;
    this.eos = false;
    this.lastT = t;
  }
  async _bytes(s) {
    const w = this.win;
    if (w && s.offset >= w.start && s.offset + s.size <= w.end) return w.buf.subarray(s.offset - w.start, s.offset - w.start + s.size);
    const len = Math.max(4 * 1024 * 1024, s.size);
    const ab = await this.m.blob.slice(s.offset, s.offset + len).arrayBuffer();
    this.win = { start: s.offset, end: s.offset + ab.byteLength, buf: new Uint8Array(ab) };
    return this.win.buf.subarray(0, s.size);
  }
  async _feed(n) {
    const S = this.info.samples;
    for (let j = 0; j < n && this.feedIdx < S.length; j++) {
      const s = S[this.feedIdx++];
      const data = await this._bytes(s);
      this.decoder.decode(new EncodedVideoChunk({ type: s.sync ? 'key' : 'delta', timestamp: Math.round(s.t * 1e6), duration: Math.round(s.dur * 1e6), data }));
    }
    if (this.feedIdx >= S.length && !this.flushed) {
      this.flushed = true;
      this.decoder.flush().then(() => { this.eos = true; this._wake(); }, (e) => { if (!this.err) this.err = e; this._wake(); });
    }
  }
  async frameAt(t) {
    const S = this.info.samples;
    if (!this.decoder || t < this.lastT - 1e-3) this._reset(t);
    else if (!this.frames.length || this.frames[this.frames.length - 1].timestamp / 1e6 < t - 2) {
      // daleki skok do przodu: zacznij od najbliższej klatki kluczowej
      let k = -1;
      for (let i = this.feedIdx; i < S.length && S[i].t <= t + 1e-4; i++) if (S[i].sync) k = i;
      if (k > this.feedIdx + 30) this._reset(t);
    }
    this.lastT = t;
    const us = t * 1e6 + 600;
    let stalls = 0;
    for (let guard = 0; guard < 100000; guard++) {
      if (this.err) throw this.err;
      // zamykaj klatki sprzed szukanej chwili (zostaw ostatnią) – dekoder ma mało buforów i inaczej staje
      while (this.frames.length > 1 && this.frames[1].timestamp <= us) this.frames.shift().close();
      const later = this.frames.findIndex((f) => f.timestamp > us);
      if (later > 0 || later === 0) break;
      if (this.eos) break;
      if (this.decoder.decodeQueueSize < 8 && this.feedIdx < S.length) { await this._feed(8); stalls = 0; }
      else {
        const before = this.frames.length;
        await this._wait();
        if (this.frames.length === before && !this.eos && !this.err && ++stalls > 4) throw new Error('dekoder przestał odpowiadać');
      }
    }
    if (!this.frames.length) return null;
    let idx = this.frames.findIndex((f) => f.timestamp > us);
    const pick = idx === -1 ? this.frames.length - 1 : Math.max(0, idx - 1);
    for (let i = 0; i < pick; i++) this.frames[i].close();
    this.frames.splice(0, pick);
    return this.drawable(this.frames[0]);
  }
  drawable(f) {
    const rot = this.info.rot;
    const fw = f.displayWidth, fh = f.displayHeight;
    if (!rot) return { isFrame: true, img: f, w: fw, h: fh };
    const c = this.canvas || (this.canvas = document.createElement('canvas'));
    const w = rot % 180 ? fh : fw, h = rot % 180 ? fw : fh;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.translate(w / 2, h / 2);
    g.rotate((rot * Math.PI) / 180);
    g.drawImage(f, -fw / 2, -fh / 2, fw, fh);
    return { isFrame: true, img: c, w, h };
  }
  close() {
    for (const f of this.frames) { try { f.close(); } catch { /* */ } }
    this.frames = [];
    if (this.decoder) { try { this.decoder.close(); } catch { /* */ } }
    this.decoder = null;
    this._wake();
  }
}
