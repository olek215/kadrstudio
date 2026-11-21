// Napisy z mowy: program sam rozpoznaje słowa i wstawia je jako napisy zsynchronizowane z głosem.
import { h, ic, clamp } from './util.js';
import { makeTextClip, addTrack, getTrack } from './model.js';
import { speechClips } from './retakes.js';
import { transcribeAll, speechEngine } from './asr.js';
import { modal, toast } from './ui.js';

export const CAPTION_STYLES = {
  karaoke: {
    name: 'Karaoke', desc: 'słowo podświetla się, gdy je mówisz',
    p: { font: 'Montserrat', weight: 900, size: 76, color: '#ffffff', stroke: '#000000', strokeW: 8, animIn: 'karaoke', animOut: 'none', shadow: 0 },
    css: 'font:900 15px Montserrat;color:#fff;-webkit-text-stroke:.7px #000', html: 'tak <span style="color:#ffd400">mówię</span> teraz',
  },
  words: {
    name: 'Słowo po słowie', desc: 'słowa wyskakują w rytm mowy',
    p: { font: 'Montserrat', weight: 900, size: 84, color: '#ffffff', stroke: '#000000', strokeW: 7, animIn: 'words', animOut: 'none' },
    css: 'font:900 15px Montserrat;color:#fff;-webkit-text-stroke:.6px #000', html: 'słowo <span style="opacity:.35">po</span>',
  },
  big: {
    name: 'Duże słowa', desc: '1–2 słowa naraz, na środku (styl TikToka)', chunk: 'tiktok', pos: 'center', upper: true,
    p: { font: 'Anton', weight: 400, size: 150, color: '#ffffff', stroke: '#000000', strokeW: 9, animIn: 'pop', animDur: 0.16, animOut: 'none' },
    css: 'font:400 22px Anton;color:#fff;-webkit-text-stroke:.8px #000;text-transform:uppercase', html: 'DUŻE',
  },
  box: {
    name: 'Z tłem', desc: 'czarny tekst na białym pasku',
    p: { font: 'Poppins', weight: 700, size: 62, color: '#111111', boxColor: '#ffffff', boxAlpha: 1, boxRadius: 14, animIn: 'fade', animDur: 0.12, animOut: 'none' },
    css: 'font:700 13px Poppins;color:#111;background:#fff;padding:2px 7px;border-radius:5px', html: 'napis z tłem',
  },
  classic: {
    name: 'Klasyczne', desc: 'jak w filmie – białe z cieniem',
    p: { font: 'Inter', weight: 700, size: 58, color: '#ffffff', stroke: '#000000', strokeW: 3, shadow: 16, shadowColor: '#000000', animIn: 'none', animOut: 'none' },
    css: 'font:700 13px Inter;color:#fff;text-shadow:0 2px 6px #000', html: 'klasyczny napis',
  },
};
const CHUNK = { tiktok: { words: 2, chars: 16 }, short: { words: 4, chars: 26 }, sentence: { words: 10, chars: 52 } };
const POS = { top: -0.3, center: 0, bottom: 0.27 };
const LS = 'kadr.captions';

// słowa jednego klipu w czasie osi (uwzględnia przycięcie i prędkość)
export function clipWords(c, tr) {
  const sp = c.speed || 1, a = c.in || 0, b = a + c.duration * sp;
  const out = [];
  for (const s of tr.segments) {
    for (const w of s.words || []) {
      const mid = (w.start + w.end) / 2;
      if (mid < a || mid > b) continue;
      const parts = w.word.trim().split(/\s+/).filter(Boolean);
      for (const p of parts) {
        out.push({ w: p, src: w.start, t0: c.start + (w.start - a) / sp, t1: c.start + (Math.min(w.end, b) - a) / sp, prob: w.prob });
      }
    }
  }
  return out;
}

function chunkWords(words, mode) {
  const lim = CHUNK[mode] || CHUNK.short;
  const chunks = [];
  let cur = [];
  for (const w of words) {
    if (cur.length) {
      const last = cur[cur.length - 1];
      const len = cur.reduce((s, x) => s + x.w.length + 1, 0) + w.w.length;
      const gap = w.t0 - last.t1;
      const stop = /[.!?…]$/.test(last.w);
      const comma = /[,;:]$/.test(last.w) && cur.length >= Math.ceil(lim.words / 2);
      if (cur.length >= lim.words || len > lim.chars || gap > 0.6 || stop || comma) { chunks.push(cur); cur = []; }
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function buildCaptions(app, clips, o) {
  const P = app.store.project;
  const S = CAPTION_STYLES[o.style] || CAPTION_STYLES.karaoke;
  if (o.replace) P.clips = P.clips.filter((c) => c.auto !== 'captions');
  let tr = P.tracks.find((t) => t.kind === 'text' && t.name === 'Napisy' && !P.clips.some((c) => c.trackId === t.id));
  if (!tr) { tr = addTrack(P, 'text', { top: true }); tr.name = 'Napisy'; }
  const vertical = P.height > P.width;
  const y = o.pos === 'bottom' ? (vertical ? POS.bottom : 0.36) : o.pos === 'top' ? (vertical ? POS.top : -0.36) : POS.center;
  const all = [];
  for (const c of clips) {
    const m = app.media.get(c.mediaId);
    if (!m || !m.transcript) continue;
    for (const ch of chunkWords(clipWords(c, m.transcript), o.chunk)) all.push(ch);
  }
  all.sort((a, b) => a[0].t0 - b[0].t0);
  const made = [];
  all.forEach((ch, i) => {
    const prevEnd = made.length ? made[made.length - 1].start + made[made.length - 1].duration : 0;
    const next = all[i + 1];
    let start = Math.max(prevEnd, ch[0].t0 - 0.05);
    let end = Math.max(ch[ch.length - 1].t1 + 0.2, start + 0.4);
    if (next) {
      const ns = next[0].t0 - 0.05;
      if (ns - end < 0.45) end = ns; // bez migania między napisami
      end = Math.min(end, Math.max(ns, start + 0.2));
    }
    const text = ch.map((w) => w.w).join(' ');
    const preset = { ...S.p, text, y, upper: !!o.upper, hl: o.hl || '#ffd400', maxW: 0.84 };
    const tc = makeTextClip(tr.id, start, preset);
    tc.duration = Math.max(0.2, end - start);
    tc.name = 'Napis';
    tc.auto = 'captions';
    tc.wt = ch.map((w) => +Math.max(0, w.t0 - start).toFixed(3));
    P.clips.push(tc);
    made.push(tc);
  });
  if (made.length) app.loadFont(made[0]);
  return made;
}

export async function openCaptions(app, onlyClipId) {
  const P = app.store.project;
  if (!P) return;
  app.player.pause();
  const clips = speechClips(app, onlyClipId);
  if (!clips.length) { toast('Na osi czasu nie ma klipów z mową (filmów z dźwiękiem albo nagrań lektora).', 'err', 5000); return; }
  const missing = clips.map((c) => app.media.get(c.mediaId)).filter((m) => m && !(m.transcript && m.transcript.segments));
  if (missing.length && !(await speechEngine(app))) { toast('To urządzenie nie potrafi rozpoznawać mowy.', 'err', 5000); return; }
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } })();
  const o = { style: saved.style || 'karaoke', chunk: saved.chunk || 'short', pos: saved.pos || 'bottom', upper: !!saved.upper, hl: saved.hl || '#ffd400', replace: true };
  const hasOld = P.clips.some((c) => c.auto === 'captions');
  const m = modal({ title: 'Napisy z mowy', icon: 'captions', wide: true });

  const render = () => {
    const styles = h('div', { class: 'cap-styles' }, Object.entries(CAPTION_STYLES).map(([id, s]) => {
      const pv = h('span', { style: s.css });
      pv.innerHTML = s.html;
      const b = h('button', { class: `cap-style${o.style === id ? ' on' : ''}` }, h('div', { class: 'cap-pv' }, pv), h('b', null, s.name), h('span', null, s.desc));
      b.addEventListener('click', () => {
        o.style = id;
        if (s.chunk) o.chunk = s.chunk;
        if (s.pos) o.pos = s.pos;
        if (s.upper != null) o.upper = s.upper;
        render();
      });
      return b;
    }));
    const seg = (key, opts) => h('div', { class: 'seg' }, opts.map(([v, n]) => {
      const b = h('button', { class: o[key] === v ? 'on' : '' }, n);
      b.addEventListener('click', () => { o[key] = v; render(); });
      return b;
    }));
    const upper = h('input', { type: 'checkbox', checked: o.upper });
    upper.addEventListener('change', () => { o.upper = upper.checked; });
    const hl = h('input', { type: 'color', value: o.hl, class: 'cap-color' });
    hl.addEventListener('input', () => { o.hl = hl.value; });
    const rep = h('input', { type: 'checkbox', checked: o.replace });
    rep.addEventListener('change', () => { o.replace = rep.checked; });
    m.setBody(
      h('div', { class: 'am-sec' }, h('h4', null, 'Wygląd napisów'), styles),
      h('div', { class: 'am-cols' },
        h('div', { class: 'am-sec' }, h('h4', null, 'Ile słów naraz'), seg('chunk', [['tiktok', '1–2 słowa'], ['short', 'Krótkie'], ['sentence', 'Całe zdania']])),
        h('div', { class: 'am-sec' }, h('h4', null, 'Położenie'), seg('pos', [['top', 'Góra'], ['center', 'Środek'], ['bottom', 'Dół']]))),
      h('div', { class: 'am-opts' },
        h('label', { class: 'am-check' }, h('span', { class: 'switch' }, upper, h('span')), 'WIELKIE LITERY'),
        o.style === 'karaoke' ? h('label', { class: 'am-check' }, hl, 'kolor podświetlenia') : null,
        hasOld ? h('label', { class: 'am-check' }, h('span', { class: 'switch' }, rep, h('span')), 'Zastąp poprzednie napisy') : null),
      h('div', { class: 'tip', style: { marginTop: '14px', marginBottom: 0 } }, ic('lightbulb'), h('span', null, `Napiszę to, co słychać w ${clips.length === 1 ? 'zaznaczonym klipie' : `${clips.length} klipach`}. Jeśli chcesz usunąć powtórki, zrób to najpierw. Każdy napis możesz potem poprawić – kliknij go i zmień tekst.`)),
    );
    m.setFoot(
      h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', onclick: () => run() }, ic('captions'), 'Dodaj napisy'),
    );
  };

  const run = async () => {
    localStorage.setItem(LS, JSON.stringify({ style: o.style, chunk: o.chunk, pos: o.pos, upper: o.upper, hl: o.hl }));
    const line = h('b', null, 'Słucham, co mówisz…');
    const sub = h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '6px' } });
    m.canClose = false;
    m.setTitle('Robię napisy…');
    m.setBody(h('div', { class: 'am-run' }, h('div', { class: 'am-wand' }, ic('captions')), line, sub));
    m.setFoot();
    try {
      await transcribeAll(app, missing, { line: (t) => { line.textContent = t; }, sub: (t) => { sub.textContent = t; } });
      const made = buildCaptions(app, clips, o);
      m.canClose = true;
      m.close();
      if (!made.length) { toast('Nie usłyszałem żadnych słów w tych klipach.', 'err', 5000); app.commit(); return; }
      app.store.select(null);
      app.commit();
      app.timeline.fit();
      app.previewRange(Math.max(0, made[0].start - 0.2), made[0].start + 6);
      toast(`Dodano napisy: ${made.length}. Kliknij napis, żeby poprawić tekst.`, 'ok', 6000);
    } catch (e) {
      console.error(e);
      m.canClose = true;
      m.close();
      toast(e.message || 'Nie udało się zrobić napisów', 'err', 6000);
    }
  };
  render();
}
