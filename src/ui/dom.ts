type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const P = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const ICONS = {
  select: P('<path d="M5 3l14 8-6.5 1.5L9 19z"/>'),
  box: P('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>'),
  cylinder: P('<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/>'),
  sphere: P('<circle cx="12" cy="12" r="8"/><path d="M4.5 10.5c2 1.6 5 2.4 7.5 2.4s5.5-.8 7.5-2.4"/>'),
  beam: P('<path d="M4 18L18 4"/><rect x="2.5" y="16.5" width="4" height="4" rx=".6" transform="rotate(45 4.5 18.5)"/><rect x="17" y="2" width="4" height="4" rx=".6" transform="rotate(45 19 4)"/>'),
  undo: P('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
  redo: P('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>'),
  copy: P('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>'),
  trash: P('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  play: P('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  pause: P('<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/>'),
  stop: P('<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>'),
  reset: P('<path d="M4 12a8 8 0 108-8 8.3 8.3 0 00-6 2.6L4 8.5"/><path d="M4 4v4.5h4.5"/>'),
  stress: P('<path d="M3 12h3l2.5-6 4 12 3-8 2 4H21"/>'),
  eye: P('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  frame: P('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  persp: P('<path d="M3 7l9-4 9 4-9 4zM3 7v10l9 4V11M21 7v10l-9 4"/>'),
  save: P('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h8V3M8 21v-7h8v7"/>'),
  open: P('<path d="M3 7h6l2 2h10v10H3z"/>'),
  file: P('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'),
  book: P('<path d="M4 4h6a3 3 0 013 3v13a2.5 2.5 0 00-2.5-2.5H4zM20 4h-6a3 3 0 00-3 3"/><path d="M20 4v13.5h-6.5A2.5 2.5 0 0011 20"/>'),
  magnet: P('<path d="M6 4v8a6 6 0 0012 0V4"/><path d="M6 8h4M14 8h4"/>'),
  ball: P('<circle cx="12" cy="12" r="7"/><path d="M3 12h2M19 12h2M12 3v2M12 19v2"/>'),
  slow: P('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>'),
  camera: P('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  sound: P('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/>'),
  mute: P('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/>'),
  plane: P('<path d="M3 16l9-5 9 5-9 5z"/><path d="M12 3v8"/>'),
  info: P('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  close: P('<path d="M6 6l12 12M18 6L6 18"/>'),
  anchor: P('<circle cx="12" cy="5" r="2"/><path d="M12 7v13M5 13a7 7 0 0014 0M8 10h8"/>'),
  saw: P('<path d="M13.5 7.5L3 18l3 3L16.5 10.5"/><path d="M4.5 19.5l1-.2M6 21l.2-1M7.5 16.5l1-.2M9 18l.2-1M10.5 13.5l1-.2M12 15l.2-1"/><path d="M13.5 7.5l3-3h4.5v4.5l-4.5 1.5z"/><circle cx="18.2" cy="6.8" r="1"/>'),
  hammer: P('<path d="M4 6.5l5-3 3 2.2-5 3z"/><path d="M12 5.7c2.6-.6 5.2.2 7 2.3"/><path d="M8.6 7.6L19 18.5a1.6 1.6 0 01-2.3 2.3L6.4 9.9"/>'),
  hand: P('<path d="M8 13V5.5a1.5 1.5 0 013 0V11M11 10.5V4a1.5 1.5 0 013 0v6.5M14 10.5V5.5a1.5 1.5 0 013 0V12M17 11.5V8.5a1.5 1.5 0 013 0V14c0 4-2.8 7-6.8 7h-1.4c-2.6 0-4.4-1.4-5.6-3.6l-2.3-4.2a1.5 1.5 0 012.5-1.6L8 13.5"/>'),
  glue: P('<path d="M12 3s-6 7-6 11.2a6 6 0 0012 0C18 10 12 3 12 3z"/><path d="M9.5 14.5a2.5 2.5 0 002.5 2.5"/>'),
  screw: P('<path d="M6 4h12M8 4v3h8V4"/><path d="M9.5 7v9l2.5 5 2.5-5V7"/><path d="M9.5 10l5-1.5M9.5 13l5-1.5M9.5 16l5-1.5"/>'),
  bolt: P('<path d="M7.5 3h9l2.5 3.5-2.5 3.5h-9L5 6.5z"/><path d="M9.5 10v11h5V10M9.5 13.5h5M9.5 17h5"/>'),
  weld: P('<path d="M4 20l7-7"/><path d="M11 13l2-2 3 3-2 2z"/><circle cx="17.5" cy="6.5" r="1.4"/><path d="M17.5 2.5v1.5M21.5 6.5H20M20.3 3.7l-1 1M14.7 3.7l1 1M20.3 9.3l-1-1"/>'),
  pry: P('<path d="M4 21L17.5 7.5"/><path d="M17.5 7.5c1.6-1.6 3.9-1 4 1.2.1 1.4-1 2.3-2.3 2.3"/><path d="M4 21l-1.5-.3.6-2"/>'),
  round: P('<path d="M4 20v-7a9 9 0 019-9h7"/><path d="M4 9V4h5" stroke-dasharray="1.6 2.2"/><path d="M15.5 10.5l-3 3"/>'),
  tape: P('<rect x="2.5" y="6" width="13" height="13" rx="3"/><circle cx="9" cy="12.5" r="3.2"/><path d="M15.5 15.5h6v3h-6M18.5 15.5v1.6"/>'),
};

export function icon(name: keyof typeof ICONS, cls = 'ico'): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.innerHTML = ICONS[name];
  return s;
}

export function fmtLen(m: number): string {
  const a = Math.abs(m);
  if (a >= 1) return `${m.toFixed(a >= 10 ? 1 : 2)} m`;
  if (a >= 0.1) return `${(m * 100).toFixed(1).replace(/\.0$/, '')} cm`;
  return `${(m * 1000).toFixed(a < 0.01 ? 1 : 0)} mm`;
}

export function fmtMass(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toFixed(kg >= 1e4 ? 1 : 2)} t`;
  if (kg >= 1) return `${kg.toFixed(kg >= 100 ? 0 : 1)} kg`;
  return `${(kg * 1000).toFixed(0)} g`;
}

export function fmtForce(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)} MN`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 2)} kN`;
  return `${n.toFixed(0)} N`;
}
