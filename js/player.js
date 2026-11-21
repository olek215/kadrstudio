// Odtwarzacz podglądu: zegar, synchronizacja elementów <video>, dźwięk przez Web Audio.
import { clamp } from './util.js';
import { projectDuration } from './model.js';
import { srcTime } from './renderer.js';
import { scheduleAudio } from './audio.js';

// Pula elementów <video>: jeden plik może mieć kilka elementów (np. przejście między częściami tego samego klipu).
export class VideoPool {
  constructor(media, onFrame) {
    this.media = media;
    this.onFrame = onFrame || (() => {});
    this.pools = new Map();
    this.assign = new Map();
  }
  _create(m) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.disablePictureInPicture = true;
    v.src = m.url;
    v._url = m.url;
    v.addEventListener('seeked', () => this.onFrame());
    v.addEventListener('loadeddata', () => this.onFrame());
    return v;
  }
  update(needs) {
    const ids = new Set(needs.map((n) => n.clip.id));
    for (const [cid, v] of this.assign) {
      const n = needs.find((x) => x.clip.id === cid);
      const m = n && this.media.get(n.clip.mediaId);
      if (!ids.has(cid) || !m || v._url !== m.url) this.assign.delete(cid);
    }
    const busy = new Set(this.assign.values());
    for (const n of needs) {
      if (this.assign.has(n.clip.id)) continue;
      const m = this.media.get(n.clip.mediaId);
      if (!m || !m.url || m.type !== 'video') continue;
      let list = this.pools.get(m.id);
      if (!list) this.pools.set(m.id, (list = []));
      for (let i = list.length - 1; i >= 0; i--) if (list[i]._url !== m.url) { list[i].removeAttribute('src'); list[i].load(); list.splice(i, 1); }
      let v = list.find((e) => !busy.has(e));
      if (!v) { v = this._create(m); list.push(v); }
      busy.add(v);
      this.assign.set(n.clip.id, v);
    }
    for (const list of this.pools.values()) for (const v of list) if (!busy.has(v) && !v.paused) v.pause();
  }
  get(clipId) { return this.assign.get(clipId); }
  pauseAll() { for (const list of this.pools.values()) for (const v of list) if (!v.paused) v.pause(); }
  destroy() {
    for (const list of this.pools.values()) for (const v of list) { v.pause(); v.removeAttribute('src'); v.load(); }
    this.pools.clear();
    this.assign.clear();
  }
}

export class Player {
  constructor({ store, media, renderer, pool, getAudioCtx }) {
    this.store = store;
    this.media = media;
    this.renderer = renderer;
    this.pool = pool;
    this.getAudioCtx = getAudioCtx;
    this.playing = false;
    this.loop = false;
    this.dirty = true;
    this.boxes = [];
    this.sources = [];
    this.onRender = null;
    this.onState = null;
    this._raf = 0;
    this._resched = 0;
    this.tick = this.tick.bind(this);
    this._raf = requestAnimationFrame(this.tick);
  }
  get time() { return this.store.time; }
  get duration() { return projectDuration(this.store.project); }

  get master() {
    const ac = this.getAudioCtx();
    if (!this._master || this._master.context !== ac) {
      this._master = ac.createGain();
      this._master.connect(ac.destination);
    }
    return this._master;
  }

  async play() {
    const P = this.store.project;
    if (!P || this.playing) return;
    const dur = this.duration;
    if (dur <= 0) return;
    if (this.store.time >= dur - 0.02) this.store.setTime(0);
    const ac = this.getAudioCtx();
    try { if (ac.state !== 'running') await ac.resume(); } catch { /* brak dźwięku */ }
    this.playing = true;
    this._startClock();
    this.onState && this.onState();
  }
  _startClock() {
    const ac = this.getAudioCtx();
    this.t0 = this.store.time;
    this.c0 = ac.currentTime + 0.06;
    this.p0 = performance.now() / 1000 + 0.06;
    this._stopAudio();
    this.sources = scheduleAudio(ac, this.master, this.store.project, this.media, this.t0, this.duration, this.c0);
  }
  _stopAudio() {
    for (const s of this.sources) { try { s.stop(); } catch { /* już zatrzymany */ } try { s.disconnect(); } catch { /* */ } }
    this.sources = [];
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.stopAt = null;
    this._stopAudio();
    this.pool.pauseAll();
    this.dirty = true;
    this.onState && this.onState();
  }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  seek(t) {
    const d = this.duration;
    this.store.setTime(clamp(t, 0, Math.max(0, d)));
    if (this.playing) this._startClock();
    this.dirty = true;
  }
  // po edycji w trakcie odtwarzania – przeplanuj dźwięk
  projectChanged() {
    this.dirty = true;
    if (this.playing) {
      clearTimeout(this._resched);
      this._resched = setTimeout(() => { if (this.playing) this._startClock(); }, 120);
    }
  }
  _clock() {
    const ac = this.getAudioCtx();
    if (ac.state === 'running') return this.t0 + Math.max(0, ac.currentTime - this.c0);
    return this.t0 + Math.max(0, performance.now() / 1000 - this.p0);
  }

  tick() {
    this._raf = requestAnimationFrame(this.tick);
    const P = this.store.project;
    if (!P) return;
    const dur = this.duration;
    if (this.playing) {
      let t = this._clock();
      if (this.stopAt != null && t >= this.stopAt) {
        this.stopAt = null;
        this.store.setTime(t);
        this.pause();
        return;
      }
      if (t >= dur) {
        if (this.loop && dur > 0) { this.store.setTime(0); this._startClock(); t = 0; } else {
          this.store.setTime(dur);
          this.pause();
          return;
        }
      }
      this.store.setTime(t);
    }
    const t = Math.min(this.store.time, Math.max(0, dur - 0.5 / P.fps));
    this.sync(P, t);
    if (this.playing || this.dirty) {
      this.dirty = false;
      this.renderer.keepFrames = !this.playing;
      this.boxes = this.renderer.render(P, t);
      this.onRender && this.onRender(this.boxes);
    }
  }

  sync(P, t) {
    const needs = this.renderer.videoNeeds(P, t);
    if (this.playing) {
      for (const c of P.clips) {
        if (c.kind === 'video' && c.start > t && c.start - t < 1.2 && !needs.some((n) => n.clip.id === c.id)) {
          needs.push({ clip: c, src: srcTime(c, c.start, this.media.get(c.mediaId)), preload: true });
        }
      }
    }
    this.pool.update(needs);
    for (const n of needs) {
      const v = this.pool.get(n.clip.id);
      if (!v || v.readyState < 1) continue;
      const m = this.media.get(n.clip.mediaId);
      if (this.playing && !n.preload) {
        const rate = clamp(n.clip.speed || 1, 0.0625, 16);
        if (Math.abs(v.playbackRate - rate) > 1e-3) v.playbackRate = rate;
        const atEnd = m && n.src >= m.duration - 0.06;
        if (v.paused) {
          if (Math.abs(v.currentTime - n.src) > 0.05) v.currentTime = n.src;
          if (!atEnd) v.play().catch(() => {});
        } else if (!v.seeking && Math.abs(v.currentTime - n.src) > 0.22 + 0.06 * rate) {
          v.currentTime = n.src;
        }
      } else {
        if (!v.paused) v.pause();
        if (!v.seeking && Math.abs(v.currentTime - n.src) > 0.4 / P.fps) v.currentTime = n.src;
      }
    }
  }
}
