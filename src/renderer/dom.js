// Small DOM helpers for building panels.
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

export const ICONS = {
  open: '<path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8"/>',
  save: '<path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  undo: '<path d="M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-3" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  redo: '<path d="m15 7 5 5-5 5M20 12H9a5 5 0 0 0 0 10h3" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  scale: '<path d="M4 20V10h10v10zM14 10l6-6M15 4h5v5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  select: '<path d="m5 3 14 8-6 2-2 6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  xray: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 2"/>',
  layers: '<path d="m12 4 9 5-9 5-9-5zM3 14l9 5 9-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.1 7.6C3.6 9.3 2 12 2 12s4 7 10 7a9 9 0 0 0 4.3-1.1" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  export: '<path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

export function num(value, { unit = '', min = -1e9, max = 1e9, step = 0.1, digits = 2, axis = null, onChange, title } = {}) {
  const input = h('input', { type: 'number', step, min, max, value: fmt(value, digits), title, 'aria-label': title });
  const commit = () => {
    let v = parseFloat(input.value);
    if (!Number.isFinite(v)) { input.value = fmt(value, digits); return; }
    v = Math.min(max, Math.max(min, v));
    input.value = fmt(v, digits);
    if (v !== value) { value = v; onChange?.(v); }
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); input.blur(); } e.stopPropagation(); });
  return h('div', { class: 'num' }, axis ? h('span', { class: `ax ${axis.toLowerCase()}` }, axis) : null, input, unit ? h('span', { class: 'u' }, unit) : null);
}

export function fmt(v, d = 2) {
  if (!Number.isFinite(v)) return '';
  return String(Math.round(v * 10 ** d) / 10 ** d);
}

export function row(label, control, title) {
  return h('div', { class: 'row', title }, h('label', {}, label), control);
}

export function select(options, value, onChange) {
  const s = h('select', { class: 'sel' }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
  s.addEventListener('change', () => onChange(s.value));
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}

export function check(label, value, onChange) {
  const i = h('input', { type: 'checkbox', checked: !!value });
  i.addEventListener('change', () => onChange(i.checked));
  return h('label', { class: 'check' }, i, label);
}

export function btn(label, onClick, { cls = '', ico = null, title = null, disabled = false, pressed = null } = {}) {
  return h('button', { class: `btn ${cls}`, onclick: onClick, title, disabled, 'aria-pressed': pressed == null ? null : String(!!pressed) }, ico ? icon(ico) : null, label);
}
