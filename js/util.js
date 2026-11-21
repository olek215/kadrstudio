// Drobne narzędzia wspólne dla całej aplikacji.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const deep = (o) => JSON.parse(JSON.stringify(o));
export const uid = (p = 'id') => `${p}_${Math.random().toString(36).slice(2, 8)}${(Date.now() % 1679616).toString(36)}`;

export const EASE = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  elastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
  bounce: (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};

export function fmtTime(s, dec = 1) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  const ss = dec ? sec.toFixed(dec).padStart(3 + dec, '0') : String(Math.floor(sec)).padStart(2, '0');
  return `${String(m).padStart(2, '0')}:${ss}`;
}
export function fmtDur(s) {
  if (!isFinite(s)) return '–';
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return fmtTime(s, 0);
}
export function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
export function hexToRgb(hex) {
  let h = (hex || '#000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function hexA(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tworzenie elementów DOM: h('div', {class:'x', onclick}, 'tekst', dziecko)
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Ikony (Lucide) – budujemy SVG bezpośrednio z danych biblioteki.
const SVGNS = 'http://www.w3.org/2000/svg';
const iconCache = new Map();
function iconKey(name) { return name.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(''); }
export function ic(name, cls = '') {
  let tpl = iconCache.get(name);
  if (!tpl) {
    const lib = window.lucide && window.lucide.icons;
    let node = lib && (lib[iconKey(name)] || lib[name]);
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', 'lucide');
    if (node) {
      let children = node;
      if (node[0] === 'svg') children = node[2] || [];
      for (const [tag, attrs] of children) {
        const e = document.createElementNS(SVGNS, tag);
        for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
        svg.append(e);
      }
    }
    tpl = svg;
    iconCache.set(name, tpl);
  }
  const out = tpl.cloneNode(true);
  if (cls) out.classList.add(...cls.split(' '));
  return out;
}
// Zamienia <i data-lucide="..."> w dokumencie (statyczny HTML) na SVG.
export function hydrateIcons(root = document) {
  for (const i of root.querySelectorAll('i[data-lucide]')) {
    const s = ic(i.getAttribute('data-lucide'), i.className);
    i.replaceWith(s);
  }
}
export function setIcon(btn, name) {
  const old = btn.querySelector('svg');
  const s = ic(name);
  if (old) old.replaceWith(s); else btn.prepend(s);
}

export function once(target, ev, timeout = 0) {
  return new Promise((res, rej) => {
    let to;
    const f = (e) => { clearTimeout(to); target.removeEventListener(ev, f); res(e); };
    target.addEventListener(ev, f);
    if (timeout) to = setTimeout(() => { target.removeEventListener(ev, f); rej(new Error('timeout: ' + ev)); }, timeout);
  });
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export function downloadBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

export const isTyping = () => {
  const a = document.activeElement;
  if (!a) return false;
  const t = a.tagName;
  return (t === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'color'].includes(a.type)) || t === 'TEXTAREA' || t === 'SELECT' || a.isContentEditable;
};
