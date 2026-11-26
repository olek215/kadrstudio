// Usuwanie powtórek: gdy kilka razy pod rząd mówisz to samo, program wybiera najlepszą wersję i wycina resztę.
// Mowa jest rozpoznawana lokalnie (faster-whisper na serwerze KadrStudio), nic nie idzie do internetu.
import { h, ic, clamp, fmtTime, fmtDur } from './util.js';
import { splitClip, clipEnd, getTrack, MIN_DUR } from './model.js';
import { modal, toast } from './ui.js';
import { transcribeMedia, transcribeAll, speechEngine } from './asr.js';

const FILLERS = new Set(['yyy', 'yy', 'y', 'yyyy', 'eee', 'ee', 'e', 'eeee', 'eh', 'ehm', 'em', 'emm', 'mmm', 'mm', 'hmm', 'hm', 'yhm', 'aaa', 'aa', 'uh', 'um', 'uhm']);
const RESTART = ['jeszcze raz', 'od nowa', 'od początku', 'czekaj', 'sorry', 'sory', 'przepraszam', 'kurczę', 'kurde', 'stop', 'raz jeszcze', 'pomyliłem się', 'pomyliłam się', 'nie nie', 'dobra jeszcze', 'jeszcze jeden raz', 'cięcie'];

const norm = (w) => (w || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// ------------------------------------------------------------------ podobieństwo zdań
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function wEq(a, b) {
  if (a === b) return true;
  const L = Math.max(a.length, b.length);
  if (L <= 3) return false;
  return 1 - lev(a, b) / L >= 0.75;
}
function lcs(A, B) {
  const m = B.length;
  const dp = new Array(m + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    let prev = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      dp[j] = wEq(A[i - 1], B[j - 1]) ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[m];
}
export function similarity(A, B) {
  if (!A.length || !B.length) return 0;
  let s = (2 * lcs(A, B)) / (A.length + B.length);
  const [S, L] = A.length <= B.length ? [A, B] : [B, A];
  if (S.length >= 2) {
    // ucięty początek ("Cześć, dzisiaj pokażę…" -> "Cześć, dzisiaj pokażę wam, jak…")
    const p = lcs(S, L.slice(0, S.length + 2)) / S.length;
    if (p >= 0.75) s = Math.max(s, 0.65 + 0.3 * p);
  } else if (S.length === 1 && L.length >= 2 && wEq(S[0], L[0])) s = Math.max(s, 0.62);
  return s;
}

// ------------------------------------------------------------------ rozpoznawanie mowy (asr.js: komputer albo sama aplikacja)
export function transcribe(app, m, onStatus, force) { return transcribeMedia(app, m, onStatus, force); }

// ------------------------------------------------------------------ wypowiedzi
function makeUtt(c, words) {
  const sp = c.speed || 1, cin = c.in || 0;
  const srcStart = Math.max(words[0].start, cin);
  const srcEnd = Math.min(words[words.length - 1].end, cin + c.duration * sp);
  const text = words.map((w) => w.word).join('').replace(/\s+/g, ' ').trim();
  const toks = words.map((w) => norm(w.word)).filter(Boolean);
  const tokens = toks.filter((t) => !FILLERS.has(t));
  let pauses = 0;
  for (let i = 1; i < words.length; i++) if (words[i].start - words[i - 1].end > 0.8) pauses++;
  const prob = words.reduce((s, w) => s + (w.prob == null ? 0.7 : w.prob), 0) / words.length;
  return {
    clipId: c.id, trackId: c.trackId, srcStart, srcEnd,
    tlStart: c.start + (srcStart - cin) / sp, tlEnd: c.start + (srcEnd - cin) / sp,
    text, tokens, fillers: toks.length - tokens.length, pauses, prob,
    lastProb: words[words.length - 1].prob == null ? 0.7 : words[words.length - 1].prob,
  };
}
export function clipUtterances(c, tr) {
  const sp = c.speed || 1, a = c.in || 0, b = a + c.duration * sp;
  const words = [];
  for (const s of tr.segments) {
    const ws = s.words && s.words.length ? s.words : [{ start: s.start, end: s.end, word: ' ' + s.text, prob: Math.exp(s.avg_logprob || -0.4) }];
    for (const w of ws) if (w.end > a + 0.05 && w.start < b - 0.05) words.push({ ...w, seg: s });
  }
  const utts = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = words[i - 1];
    if (prev) {
      const gap = w.start - prev.end;
      // nowa wypowiedź po wyraźnej pauzie (sam znak "!" w "Cześć! Dzisiaj…" jej nie rozdziela)
      if (gap > 0.75 || (/[.!?…]\s*$/.test(prev.word) && gap > 0.5) || (prev.seg !== w.seg && gap > 0.6)) { utts.push(makeUtt(c, cur)); cur = []; }
    }
    cur.push(w);
  }
  if (cur.length) utts.push(makeUtt(c, cur));
  return utts;
}
export function isRestart(u) {
  const t = u.text.toLowerCase().replace(/[^\p{L}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!u.tokens.length) return true;
  if (u.tokens.length <= 4 && RESTART.some((p) => t.includes(p))) return true;
  return u.tokens.length <= 1 && u.fillers > 0;
}

// ------------------------------------------------------------------ grupy powtórek
function scoreGroup(g) {
  const maxT = Math.max(1, ...g.takes.map((t) => t.tokens.length));
  g.takes.forEach((t, k) => {
    const completeness = t.tokens.length / maxT;
    const fluency = 1 - Math.min(1, t.fillers * 0.25 + t.pauses * 0.2);
    const ending = /[.!?…]$/.test(t.text) ? 1 : 0.5;
    const cut = t.lastProb < 0.35 ? 0.6 : 1;
    t.score = (0.45 * completeness + 0.3 * t.prob + 0.15 * fluency + 0.05 * ending + 0.05 * (k === g.takes.length - 1 ? 1 : 0)) * cut;
    t.partial = completeness < 0.75;
  });
  g.best = g.takes.reduce((b, t) => (t.score > b.score ? t : b), g.takes[0]);
  g.keep = g.best;
  return g;
}
export function findRetakes(utts) {
  const groups = [];
  const longest = (arr) => arr.reduce((b, t) => (t.tokens.length > b.tokens.length ? t : b), arr[0]);
  const simTo = (u, g) => Math.max(similarity(u.tokens, longest(g.takes).tokens), similarity(u.tokens, g.takes[g.takes.length - 1].tokens));
  let i = 0;
  while (i < utts.length) {
    if (!utts[i].tokens.length) { i++; continue; }
    const g = { takes: [utts[i]], extras: [] };
    let j = i + 1;
    while (j < utts.length) {
      const u = utts[j];
      const last = g.takes[g.takes.length - 1];
      if (u.tlStart - last.tlEnd > 30) break;
      if (u.tokens.length && simTo(u, g) >= 0.6) { g.takes.push(u); j++; continue; }
      if (isRestart(u) && j + 1 < utts.length && simTo(utts[j + 1], g) >= 0.6) { g.extras.push(u); g.takes.push(utts[j + 1]); j += 2; continue; }
      break;
    }
    if (g.takes.length >= 2) { groups.push(scoreGroup(g)); i = j; } else i++;
  }
  return groups;
}

// ------------------------------------------------------------------ wycinanie
export function removalRanges(utts, groups, withExtras) {
  const remove = new Set();
  for (const g of groups) {
    for (const t of g.takes) if (t !== g.keep) remove.add(t);
    if (withExtras) for (const e of g.extras) remove.add(e);
  }
  const ranges = [];
  utts.forEach((u, i) => {
    if (!remove.has(u)) return;
    const prev = utts[i - 1], next = utts[i + 1];
    let a = u.tlStart - 0.06;
    if (prev && prev.clipId === u.clipId && !remove.has(prev)) a = Math.max(prev.tlEnd + 0.03, prev.tlEnd + Math.min(0.3, (u.tlStart - prev.tlEnd) / 2));
    let b;
    if (next && next.clipId === u.clipId && next.tlStart - u.tlEnd < 3) b = next.tlStart - Math.min(0.12, (next.tlStart - u.tlEnd) / 2);
    else b = u.tlEnd + 0.3;
    if (b <= a) b = u.tlEnd;
    ranges.push({ clipId: u.clipId, a, b });
  });
  ranges.sort((x, y) => x.a - y.a);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && last.clipId === r.clipId && r.a <= last.b + 0.2) last.b = Math.max(last.b, r.b);
    else merged.push({ ...r });
  }
  return merged;
}
function cutRange(P, c, a, b) {
  const s = c.start, e = clipEnd(c);
  a = Math.max(a, s);
  b = Math.min(b, e);
  if (b - a < 0.05) return 0;
  if (a - s < MIN_DUR + 0.01) a = s;
  if (e - b < MIN_DUR + 0.01) b = e;
  if (b < e && !splitClip(P, c, b)) return 0;
  let mid = c;
  if (a > s) { mid = splitClip(P, c, a); if (!mid) return 0; }
  P.clips = P.clips.filter((x) => x !== mid);
  const len = b - a;
  const tr = getTrack(P, c.trackId);
  if (!(tr && tr.main && P.magnet)) for (const o of P.clips) if (o.trackId === c.trackId && o.start >= b - 1e-6) o.start -= len;
  return len;
}
export function applyCuts(P, ranges) {
  let total = 0;
  for (const r of [...ranges].sort((x, y) => y.a - x.a)) {
    const c = P.clips.find((x) => x.id === r.clipId);
    if (c) total += cutRange(P, c, r.a, r.b);
  }
  return total;
}

// ------------------------------------------------------------------ analiza całej osi czasu
export function speechClips(app, onlyId) {
  const P = app.store.project;
  return P.clips.filter((c) => {
    if (onlyId) return c.id === onlyId;
    if (c.kind !== 'video' && c.kind !== 'audio') return false;
    const m = app.media.get(c.mediaId);
    const tr = getTrack(P, c.trackId);
    if (!m || !m.hasAudio || c.muted || (tr && tr.muted)) return false;
    if (c.kind === 'audio') return /^Lektor/i.test(c.name || m.name);
    return true;
  }).sort((a, b) => a.start - b.start);
}

export async function analyze(app, clips, ui = { line() {}, sub() {} }) {
  const media = [...new Set(clips.map((c) => c.mediaId))].map((id) => app.media.get(id)).filter(Boolean);
  await transcribeAll(app, media, ui);
  const utts = [];
  for (const c of clips) {
    const m = app.media.get(c.mediaId);
    if (m && m.transcript) utts.push(...clipUtterances(c, m.transcript));
  }
  utts.sort((a, b) => a.tlStart - b.tlStart);
  return { utts, groups: findRetakes(utts) };
}

// ------------------------------------------------------------------ okno
export async function openRetakes(app, onlyClipId) {
  const P = app.store.project;
  if (!P) return;
  app.player.pause();
  const clips = speechClips(app, onlyClipId);
  if (!clips.length) { toast('Na osi czasu nie ma klipów z mową (filmów z dźwiękiem albo nagrań lektora).', 'err', 5000); return; }
  if (!(await speechEngine(app))) { toast('To urządzenie nie potrafi rozpoznawać mowy.', 'err', 6000); return; }

  const m = modal({ title: 'Usuń powtórki', icon: 'scissors-line-dashed', wide: true });
  m.canClose = false;
  const line = h('b', null, 'Przygotowuję…');
  const sub = h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '6px', textAlign: 'center' } }, '');
  m.setBody(h('div', { class: 'am-run' }, h('div', { class: 'am-wand' }, ic('audio-lines')), line, sub));
  m.setFoot(h('button', { class: 'btn ghost', onclick: () => { m.canClose = true; m.close(); } }, 'Anuluj'));
  let res;
  try {
    res = await analyze(app, clips, { line: (t) => { line.textContent = t; }, sub: (t) => { sub.textContent = t; } });
  } catch (e) {
    console.error(e);
    m.canClose = true;
    m.close();
    toast(e.message || 'Nie udało się rozpoznać mowy', 'err', 6000);
    return;
  }
  m.canClose = true;
  if (!m.el.isConnected) return; // anulowano
  showResults(app, m, res);
}

function showResults(app, m, res) {
  const { utts, groups } = res;
  const state = { extras: true };
  const render = () => {
    const ranges = removalRanges(utts, groups, state.extras);
    const saved = ranges.reduce((s, r) => s + (r.b - r.a), 0);
    const cards = groups.map((g, gi) => {
      const rows = g.takes.map((t) => {
        const on = g.keep === t;
        const play = h('button', { class: 'icon-btn sm', title: 'Odsłuchaj tę wersję' }, ic('play'));
        play.addEventListener('click', (e) => { e.stopPropagation(); app.previewRange(Math.max(0, t.tlStart - 0.15), t.tlEnd + 0.15); });
        const stars = Math.max(1, Math.round(t.score * 5));
        const row = h('div', { class: `rt-take${on ? ' on' : ''}` },
          h('span', { class: 'rt-radio' }),
          play,
          h('span', { class: 'rt-time' }, fmtTime(t.tlStart)),
          h('span', { class: 'rt-text' }, `„${t.text}”`),
          t.partial ? h('span', { class: 'rt-bdg warn' }, 'ucięte') : null,
          t === g.best ? h('span', { class: 'rt-bdg' }, '★ najlepsza') : null,
          h('span', { class: 'rt-stars', title: `ocena ${Math.round(t.score * 100)}%` }, '★'.repeat(stars) + '☆'.repeat(5 - stars)),
          h('span', { class: 'rt-dur' }, fmtDur(t.tlEnd - t.tlStart)));
        row.addEventListener('click', () => { g.keep = t; render(); });
        return row;
      });
      const extras = g.extras.map((e) => h('div', { class: 'rt-extra' }, ic('message-square-x'), `wtrącenie: „${e.text}” ${state.extras ? '– zostanie wycięte' : '– zostaje'}`));
      return h('div', { class: 'rt-group' }, h('div', { class: 'rt-head' }, h('b', null, `Powtórka ${gi + 1}`), h('span', { class: 'muted' }, ` – ${g.takes.length} wersje, zostawiam zaznaczoną`)), rows, extras);
    });
    const transcript = h('details', { class: 'rt-transcript' }, h('summary', null, `Co usłyszałem (${utts.length} wypowiedzi)`),
      h('div', null, utts.map((u) => h('div', null, h('span', { class: 'rt-time' }, fmtTime(u.tlStart)), ' ', u.text))));
    if (!groups.length) {
      m.setTitle('Usuń powtórki');
      const auto = autoLink(app, m);
      m.setBody(h('div', { class: 'rt-none' }, ic('circle-check'), h('b', null, 'Nie znalazłem powtórek'), h('span', { class: 'muted' }, auto ? 'W filmie na osi czasu nie ma już powtórzonych zdań.' : 'Nie mówisz tego samego kilka razy pod rząd.')), auto, transcript);
      m.setFoot(h('button', { class: 'btn primary', onclick: () => m.close() }, 'OK'));
      return;
    }
    const cb = h('input', { type: 'checkbox', checked: state.extras });
    cb.addEventListener('change', () => { state.extras = cb.checked; render(); });
    m.setTitle(`Znalazłem powtórki: ${groups.length}`);
    m.setBody(
      h('div', { class: 'tip' }, ic('lightbulb'), h('span', null, 'Gwiazdką oznaczyłem najlepszą wersję (pełne zdanie, wyraźnie, bez „yyy”). Kliknij inną wersję, jeśli wolisz ją zostawić. ▶ odtwarza wersję.')),
      h('div', { class: 'rt-list' }, cards),
      h('label', { class: 'am-check', style: { marginTop: '12px' } }, h('span', { class: 'switch' }, cb, h('span')), 'Wytnij też wtrącenia między wersjami („jeszcze raz”, „yyy”, „nie, czekaj”)'),
      transcript,
      autoLink(app, m),
    );
    m.setFoot(
      h('span', { class: 'muted', style: { marginRight: 'auto', fontSize: '13px' } }, `Film skróci się o ${fmtDur(saved)}`),
      h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', onclick: () => apply(ranges) }, ic('scissors'), 'Wytnij powtórki'),
    );
  };
  const apply = (ranges) => {
    const P = app.store.project;
    const n = groups.reduce((s, g) => s + g.takes.length - 1, 0);
    const cut = applyCuts(P, ranges);
    app.store.select(null);
    app.commit();
    app.timeline.fit();
    app.player.seek(0);
    m.close();
    toast(`Usunięto ${n} ${n === 1 ? 'powtórkę' : n < 5 ? 'powtórki' : 'powtórek'} (film krótszy o ${fmtDur(cut)}). Ctrl+Z cofa.`, 'ok', 6000);
  };
  render();
}

// ------------------------------------------------------------------ co wyciął Auto-montaż
function autoCount(P) { return ((P && P.autoRetakes) || []).reduce((n, g) => n + g.takes.length - 1, 0); }
function autoLink(app, m) {
  const n = autoCount(app.store.project);
  if (!n) return null;
  return h('div', { class: 'tip', style: { marginTop: '12px', marginBottom: 0 } }, ic('wand-sparkles'),
    h('span', null, `Auto-montaż wyciął już ${n} ${n === 1 ? 'powtórkę' : n < 5 ? 'powtórki' : 'powtórek'} z nagrań. `),
    h('button', { class: 'btn sm', onclick: () => { m.close(); openAutoRetakes(app); } }, ic('eye'), 'Pokaż'));
}
// gdzie w filmie jest dany moment nagrania (null, jeśli go już nie ma na osi czasu)
function timelinePos(app, mediaId, a) {
  for (const c of app.store.project.clips) {
    if (c.mediaId !== mediaId || (c.kind !== 'video' && c.kind !== 'audio')) continue;
    const sp = c.speed || 1, cin = c.in || 0;
    if (a >= cin - 0.3 && a < cin + c.duration * sp) return { clip: c, t: c.start + Math.max(0, a - cin) / sp };
  }
  return null;
}

// Okno „Wycięte powtórki”: każda grupa powtórzonych zdań z Auto-montażu – która wersja została,
// które wypadły i gdzie były w nagraniu. ▶ pokazuje wersję z oryginalnego pliku (także wyciętą).
export function openAutoRetakes(app) {
  const P = app.store.project;
  const list = (P && P.autoRetakes) || [];
  const n = autoCount(P);
  if (!n) { toast('Auto-montaż nie wyciął w tym projekcie żadnych powtórek.', 'info', 4000); return; }
  app.player.pause();
  const video = h('video', { class: 'rt-video', playsinline: '', preload: 'metadata' });
  const cap = h('div', { class: 'rt-vcap muted' }, 'Kliknij ▶ przy wersji, żeby ją obejrzeć i odsłuchać.');
  let stopAt = null, raf = 0, playing = null;
  const stop = () => {
    video.pause();
    cancelAnimationFrame(raf);
    stopAt = null;
    if (playing) { playing.replaceChildren(ic('play')); playing = null; }
  };
  const tick = () => { if (stopAt != null && video.currentTime >= stopAt) { stop(); return; } raf = requestAnimationFrame(tick); };
  const play = async (g, x, btn, label) => {
    if (playing === btn) { stop(); return; }
    stop();
    const md = app.media.get(g.mediaId);
    if (!md || !md.url) { toast('Nie mogę otworzyć tego nagrania – plik usunięto z projektu?', 'err', 5000); return; }
    if (video.dataset.mid !== md.id) {
      video.dataset.mid = md.id;
      video.src = md.url;
      await new Promise((r) => { video.addEventListener('loadedmetadata', r, { once: true }); video.addEventListener('error', r, { once: true }); });
    }
    cap.textContent = label;
    video.currentTime = Math.max(0, x.a - 0.15);
    stopAt = x.b + 0.25;
    playing = btn;
    btn.replaceChildren(ic('square'));
    try { await video.play(); raf = requestAnimationFrame(tick); } catch { stop(); toast('Nie udało się odtworzyć tego fragmentu.', 'err'); }
  };
  const m = modal({ title: `Wycięte powtórki: ${n}`, icon: 'scissors-line-dashed', wide: true, onClose: stop });
  const playBtn = (g, x, label) => {
    const b = h('button', { class: 'icon-btn sm', title: 'Obejrzyj i odsłuchaj' }, ic('play'));
    b.addEventListener('click', (e) => { e.stopPropagation(); play(g, x, b, label); });
    return b;
  };
  const cards = list.map((g, gi) => {
    const rows = g.takes.map((x) => {
      const where = `${fmtTime(x.a)} w nagraniu „${g.name}”`;
      let show = null;
      if (x.keep) {
        show = h('button', { class: 'btn sm', title: 'Przejdź do tego zdania w filmie' }, ic('locate'), 'W filmie');
        show.addEventListener('click', () => {
          const p = timelinePos(app, g.mediaId, x.a);
          if (!p) { toast('Tego zdania nie ma już w filmie.', 'info', 4000); return; }
          m.close();
          app.store.select(p.clip.id);
          app.player.seek(p.t);
        });
      }
      return h('div', { class: `rt-take${x.keep ? ' on' : ' cut'}` },
        playBtn(g, x, `${x.keep ? 'Zostawiona' : 'Wycięta'} wersja – ${where}`),
        h('span', { class: 'rt-time', title: 'czas w oryginalnym nagraniu' }, fmtTime(x.a)),
        h('span', { class: 'rt-text' }, `„${x.text}”`),
        x.partial ? h('span', { class: 'rt-bdg warn' }, 'ucięte') : null,
        h('span', { class: `rt-bdg ${x.keep ? 'ok' : 'cut'}` }, x.keep ? '✓ zostawione' : '✂ wycięte'),
        show);
    });
    const extras = g.extras.map((x) => h('div', { class: 'rt-extra' },
      playBtn(g, x, `Wtrącenie – ${fmtTime(x.a)} w nagraniu „${g.name}”`), ic('message-square-x'), `wtrącenie: „${x.text}” – wycięte`));
    return h('div', { class: 'rt-group' },
      h('div', { class: 'rt-head' }, h('b', null, `Powtórka ${gi + 1}`), h('span', { class: 'muted' }, ` – ${g.takes.length} wersje w „${g.name}”`)),
      rows, extras);
  });
  m.setBody(h('div', { class: 'rt-view' },
    h('div', { class: 'tip' }, ic('lightbulb'), h('span', null, 'Auto-montaż zostawił w filmie najlepszą wersję każdego powtórzonego zdania, a resztę wyciął. ▶ odtwarza wersję z oryginalnego nagrania – także wyciętą. Czas to miejsce w nagraniu.')),
    h('div', { class: 'rt-player' }, video, cap),
    h('div', { class: 'rt-list' }, cards)));
  m.setFoot(h('button', { class: 'btn primary', onclick: () => m.close() }, 'Zamknij'));
}
