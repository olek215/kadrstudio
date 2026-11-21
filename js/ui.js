// Okienka, powiadomienia i menu kontekstowe.
import { $, h, ic } from './util.js';

export function toast(msg, type = 'info', ms = 3200, actions = null) {
  const icon = type === 'ok' ? 'circle-check' : type === 'err' ? 'circle-alert' : 'info';
  const el = h('div', { class: `toast ${type}` }, ic(icon), h('span', null, msg));
  const hide = () => { el.classList.add('out'); setTimeout(() => el.remove(), 320); };
  if (actions && actions.length) {
    for (const a of actions) {
      const b = h('button', { class: 'btn sm' }, a.icon ? ic(a.icon) : null, a.label);
      b.addEventListener('click', () => { hide(); a.run(); });
      el.append(b);
    }
    el.append(h('button', { class: 'icon-btn sm', title: 'Zamknij', onclick: hide }, ic('x')));
  }
  $('#toasts').append(el);
  setTimeout(hide, ms);
  return el;
}

export function modal({ title, icon, body, foot, wide = false, onClose, closable = true }) {
  const root = $('#modal-root');
  const bodyEl = h('div', { class: 'modal-body' });
  const footEl = h('div', { class: 'modal-foot' });
  const closeBtn = h('button', { class: 'icon-btn sm', title: 'Zamknij' }, ic('x'));
  const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog' },
    h('div', { class: 'modal-head' }, icon ? ic(icon) : null, h('h2', null, title), closeBtn), bodyEl, footEl);
  const back = h('div', { class: 'modal-back' }, box);
  let closed = false;
  const api = {
    el: box,
    canClose: closable,
    close() {
      if (closed) return;
      closed = true;
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      onClose && onClose();
    },
    setBody(...kids) { bodyEl.replaceChildren(...kids.flat()); },
    setFoot(...kids) { footEl.replaceChildren(...kids.flat()); footEl.classList.toggle('hidden', !kids.flat().length); },
    setTitle(t) { box.querySelector('h2').textContent = t; },
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && api.canClose) { e.stopPropagation(); api.close(); }
    else e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', () => { if (api.canClose) api.close(); });
  back.addEventListener('pointerdown', (e) => { if (e.target === back && api.canClose) api.close(); });
  api.setBody(body || []);
  api.setFoot(foot || []);
  root.append(back);
  return api;
}

export function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise((res) => {
    let val = false;
    const m = modal({
      title, icon: danger ? 'triangle-alert' : 'circle-help', body: [h('p', { style: { margin: 0, lineHeight: 1.5 } }, text)],
      onClose: () => res(val),
    });
    m.setFoot(
      h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Anuluj'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { val = true; m.close(); } }, okLabel),
    );
  });
}

let menuEl = null;
export function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
export function contextMenu(x, y, items) {
  closeMenu();
  const el = h('div', { class: 'ctx-menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { el.append(h('hr')); continue; }
    const b = h('button', { disabled: it.disabled }, ic(it.icon || 'dot'), h('span', null, it.label), it.key ? h('span', { class: 'k' }, it.key) : null);
    if (it.disabled) b.style.opacity = '.4';
    b.addEventListener('click', () => { closeMenu(); if (!it.disabled) it.run(); });
    el.append(b);
  }
  $('#menu-root').append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  menuEl = el;
  setTimeout(() => {
    const off = (e) => { if (!el.contains(e.target)) { closeMenu(); document.removeEventListener('pointerdown', off, true); } };
    document.addEventListener('pointerdown', off, true);
  });
}
