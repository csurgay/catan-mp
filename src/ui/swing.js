// Just enough Swing (Metal, "Steel" theme) for the original look: a JMenuBar
// with popups and submenus, image JButtons with Swing's own disabled icon,
// JOptionPane dialogs in a Metal-decorated JDialog, and the bevel borders the
// applet's panels had. See original.css for the measured colours.

import { ASSET_DIR } from './assets.js';

export function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

export function iconSrc(name) {
  return /\.(gif|jpg|png)$/.test(name) ? `${ASSET_DIR}${name}` : `${ASSET_DIR}${name}.gif`;
}

// ------------------------------------------------------------------ GrayFilter

// javax.swing.GrayFilter(brighter = true, percent = 50), the filter Swing used
// for a disabled button's icon -- integer arithmetic, quirks included (the
// luminance is divided by 3).
const grayCache = new Map();
export function disabledIcon(name) {
  if (grayCache.has(name)) return grayCache.get(name);
  const p = new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) {
        let gray = Math.trunc((0.30 * d.data[i] + 0.59 * d.data[i + 1] + 0.11 * d.data[i + 2]) / 3);
        gray = 255 - Math.trunc(((255 - gray) * 50) / 100);
        d.data[i] = gray; d.data[i + 1] = gray; d.data[i + 2] = gray;
      }
      ctx.putImageData(d, 0, 0);
      resolve(c.toDataURL());
    };
    im.onerror = () => resolve(iconSrc(name));
    im.src = iconSrc(name);
  });
  grayCache.set(name, p);
  return p;
}

// ------------------------------------------------------------------ JButton

/** An image JButton at (x, y, w, h) in `parent`; returns { node, setEnabled }. */
export function imageButton(parent, name, x, y, w, h, onClick) {
  const b = el('button', 'o-btn', parent);
  b.type = 'button';
  Object.assign(b.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  const im = el('img', null, b);
  im.alt = '';
  im.draggable = false;
  let enabled = null;
  const setEnabled = (on) => {
    on = !!on;
    if (on === enabled) return;
    enabled = on;
    b.disabled = !on;
    if (on) im.src = iconSrc(name);
    else disabledIcon(name).then((src) => { if (!enabled) im.src = src; });
  };
  setEnabled(true);
  b.addEventListener('mousedown', () => focusButton(b));
  b.addEventListener('click', (e) => { if (!b.disabled) onClick(e); });
  return { node: b, setEnabled };
}

// Metal paints a focus rectangle around the focused button's icon or text.
let focusedButton = null;
export function focusButton(b) {
  if (focusedButton) focusedButton.classList.remove('focused');
  focusedButton = b;
  if (b) b.classList.add('focused');
}

// ------------------------------------------------------------------ bevel borders on a canvas

/**
 * Paints a border profile measured from the applet into a canvas: `tl` are
 * the grey levels of the top/left rows from the outside in, `br` those of the
 * bottom/right rows from the outside in.
 */
export function paintBevel(ctx, w, h, tl, br) {
  ctx.save();
  br.forEach((v, i) => {
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(i, h - 1 - i, w - 2 * i, 1);
    ctx.fillRect(w - 1 - i, i, 1, h - 2 * i);
  });
  tl.forEach((v, i) => {
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(i, i, w - 2 * i - 1, 1);
    ctx.fillRect(i, i, 1, h - 2 * i - 1);
  });
  ctx.restore();
}

// ------------------------------------------------------------------ MetalBumps

// The dotted texture of a Metal title bar: on a 4x4 tile, highlight dots at
// (0,0) and (2,2), shadow dots at (1,1) and (3,3).
const bumpsCache = new Map();
export function bumps(highlight, shadow) {
  const key = highlight + shadow;
  if (bumpsCache.has(key)) return bumpsCache.get(key);
  const c = document.createElement('canvas');
  c.width = 4; c.height = 4;
  const ctx = c.getContext('2d');
  ctx.fillStyle = highlight; ctx.fillRect(0, 0, 1, 1); ctx.fillRect(2, 2, 1, 1);
  ctx.fillStyle = shadow; ctx.fillRect(1, 1, 1, 1); ctx.fillRect(3, 3, 1, 1);
  const url = `url(${c.toDataURL()})`;
  bumpsCache.set(key, url);
  return url;
}

// ------------------------------------------------------------------ JMenuBar

/**
 * menus: [{ title, test, items: () => [item] }] -- `title` may be a function
 * (re-read by refresh(), e.g. after a language switch); `test` names the
 * data-test hook (menu-<test>), default the title.
 * item: { kind: 'item'|'check'|'radio'|'sep'|'sub', label, icon, checked, enabled,
 *         onSelect, items (for 'sub') }
 * Items are rebuilt every time a popup opens, so `checked`/`enabled`/`icon`
 * are plain values computed by the caller at that moment.
 */
export function createMenuBar(applet, menus) {
  const bar = el('div', null, applet);
  bar.id = 'o-menubar';
  let openIdx = -1;
  let popups = [];
  const titleOf = (m) => (typeof m.title === 'function' ? m.title() : m.title);
  const titles = menus.map((m, i) => {
    const t = el('div', 'o-menu-title', bar);
    t.textContent = titleOf(m);
    t.dataset.test = `menu-${m.test || titleOf(m)}`;
    t.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (openIdx === i) close(); else open(i);
    });
    t.addEventListener('mouseenter', () => { if (openIdx !== -1 && openIdx !== i) open(i); });
    return t;
  });

  function closePopups(fromLevel) {
    while (popups.length > fromLevel) popups.pop().remove();
  }
  function close() {
    closePopups(0);
    if (openIdx !== -1) titles[openIdx].classList.remove('open');
    openIdx = -1;
  }
  function open(i) {
    close();
    openIdx = i;
    titles[i].classList.add('open');
    const t = titles[i];
    showPopup(menus[i].items(), t.offsetLeft, 21, 0);
  }
  function showPopup(items, x, y, level) {
    closePopups(level);
    const pop = el('div', 'o-popup', applet);
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
    popups.push(pop);
    // Swing lined the text of icon-less items up with the icon items' text.
    const anyIcon = items.some((it) => it.icon);
    const anyIndicator = items.some((it) => it.kind === 'check' || it.kind === 'radio');
    for (const it of items) {
      if (it.kind === 'sep') { el('div', 'o-sep', pop); continue; }
      const row = el('div', 'o-mi', pop);
      row.dataset.test = `mi-${it.test || it.label}`;
      if (it.enabled === false) row.classList.add('disabled');
      if (it.kind === 'check' || it.kind === 'radio') {
        row.classList.add('indicated');
        const ind = el('span', `o-ind${it.kind === 'radio' ? ' radio' : ''}${it.checked ? ' on' : ''}`, row);
        ind.setAttribute('aria-hidden', 'true');
      } else {
        row.classList.add('plain');
      }
      if (it.icon) {
        row.classList.add('has-icon');
        const im = el('img', 'o-mi-icon', row);
        im.src = iconSrc(it.icon);
        im.alt = '';
      }
      el('span', null, row).textContent = it.label;
      if (anyIcon && !it.icon) row.style.paddingLeft = anyIndicator ? '57px' : '43px';
      if (it.kind === 'sub') el('span', 'o-arrow', row);
      row.addEventListener('mouseenter', () => {
        for (const r of pop.querySelectorAll('.o-mi.armed')) r.classList.remove('armed');
        if (it.enabled !== false) row.classList.add('armed');
        if (it.kind === 'sub') {
          const r = row.getBoundingClientRect();
          const a = applet.getBoundingClientRect();
          const scale = a.width / applet.offsetWidth || 1;
          showPopup(it.items, (r.right - a.left) / scale - 2, (r.top - a.top) / scale - 2, level + 1);
        } else {
          closePopups(level + 1);
        }
      });
      row.addEventListener('mouseup', (e) => {
        e.stopPropagation();
        if (it.enabled === false || it.kind === 'sub') return;
        close();
        if (it.onSelect) it.onSelect();
      });
    }
  }
  document.addEventListener('mousedown', (e) => {
    if (openIdx === -1) return;
    if (bar.contains(e.target) || popups.some((p) => p.contains(e.target))) return;
    close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  function refresh() { menus.forEach((m, i) => { titles[i].textContent = titleOf(m); }); }
  return { node: bar, close, refresh, isOpen: () => openIdx !== -1 };
}

// ------------------------------------------------------------------ JOptionPane

let modalRoot = null;
let modalOpen = 0;
export function dialogOpen() { return modalOpen > 0; }

const WARN_SVG = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 2 L31 29 L1 29 Z" fill="#cc9" stroke="#663" stroke-width="1"/>'
  + '<path d="M16 5 L28 27 L4 27 Z" fill="#ffc"/><rect x="14.5" y="11" width="3" height="10" fill="#000"/><rect x="14.5" y="23" width="3" height="3" fill="#000"/></svg>',
);
const INFO_SVG = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#ccf" stroke="#669" stroke-width="1.5"/>'
  + '<rect x="14" y="13" width="4" height="12" fill="#000"/><rect x="14" y="7" width="4" height="4" fill="#000"/></svg>',
);

/**
 * JOptionPane.showOptionDialog / showMessageDialog. options: [{ icon } | { text }].
 * Resolves with the chosen index, or -1 when the dialog was closed.
 */
export function optionDialog(applet, { title, message = '', icon = null, kind = 'plain', options = [{ text: 'OK' }], test }) {
  if (!modalRoot || !modalRoot.isConnected) { modalRoot = el('div', null, applet); modalRoot.id = 'o-modal'; }
  modalRoot.style.display = 'block';
  modalOpen++;
  return new Promise((resolve) => {
    const dlg = el('div', `o-dialog${kind === 'warning' ? ' warning' : ''}`, modalRoot);
    dlg.dataset.test = test || 'dialog';
    dlg.setAttribute('role', 'dialog');
    const bar = el('div', 'o-dlg-title', dlg);
    el('span', null, bar).textContent = title;
    const bm = el('span', 'o-bumps', bar);
    bm.style.backgroundImage = kind === 'warning' ? bumps('#fff', 'rgb(153,102,51)') : bumps('#fff', '#669');
    const closeBox = el('span', 'o-close', bar);
    const body = el('div', 'o-dlg-body', dlg);
    const iconSrcUrl = icon ? iconSrc(icon) : (kind === 'warning' ? WARN_SVG : (kind === 'info' ? INFO_SVG : null));
    if (iconSrcUrl) { const im = el('img', 'o-dlg-icon', body); im.src = iconSrcUrl; im.alt = ''; }
    const main = el('div', 'o-dlg-main', body);
    el('div', 'o-dlg-msg', main).textContent = message;
    const row = el('div', 'o-dlg-buttons', main);
    const finish = (v) => {
      dlg.remove();
      modalOpen--;
      if (!modalOpen) modalRoot.style.display = 'none';
      resolve(v);
    };
    const buttons = options.map((opt, i) => {
      const b = el('button', `o-btn${opt.icon ? ' icon' : ' text'}`, row);
      b.type = 'button';
      b.dataset.test = `dialog-option-${i}`;
      if (opt.icon) { const im = el('img', null, b); im.src = iconSrc(opt.icon); im.alt = opt.alt || ''; } else el('span', null, b).textContent = opt.text;
      b.addEventListener('mousedown', () => focusButton(b));
      b.addEventListener('click', () => finish(i));
      return b;
    });
    if (buttons[0]) focusButton(buttons[0]);
    closeBox.addEventListener('click', () => finish(-1));
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(-1); });
    // Centered on the applet, like a JOptionPane centered on the screen.
    requestAnimationFrame(() => {
      dlg.style.left = `${Math.round((applet.offsetWidth - dlg.offsetWidth) / 2)}px`;
      dlg.style.top = `${Math.round((applet.offsetHeight - dlg.offsetHeight) / 2)}px`;
      if (buttons[0]) buttons[0].focus({ preventScroll: true });
    });
    dlg.style.left = '-9999px';
  });
}

/**
 * A Metal-decorated JDialog with arbitrary content (the network lobby).
 * Returns { dlg, body, close, center }. Counts as modal while open, like
 * optionDialog, so the game loop waits.
 */
export function frameDialog(applet, { title, test, onClose }) {
  if (!modalRoot || !modalRoot.isConnected) { modalRoot = el('div', null, applet); modalRoot.id = 'o-modal'; }
  modalRoot.style.display = 'block';
  modalOpen++;
  const dlg = el('div', 'o-dialog o-frame', modalRoot);
  dlg.dataset.test = test || 'frame';
  dlg.setAttribute('role', 'dialog');
  const bar = el('div', 'o-dlg-title', dlg);
  const titleSpan = el('span', null, bar);
  titleSpan.textContent = title;
  const bm = el('span', 'o-bumps', bar);
  bm.style.backgroundImage = bumps('#fff', '#669');
  const closeBox = el('span', 'o-close', bar);
  closeBox.dataset.test = `${test || 'frame'}-close`;
  const body = el('div', 'o-frame-body', dlg);
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    dlg.remove();
    modalOpen--;
    if (!modalOpen) modalRoot.style.display = 'none';
    if (onClose) onClose();
  };
  const center = () => {
    dlg.style.left = `${Math.max(0, Math.round((applet.offsetWidth - dlg.offsetWidth) / 2))}px`;
    dlg.style.top = `${Math.max(21, Math.round((applet.offsetHeight - dlg.offsetHeight) / 2))}px`;
  };
  closeBox.addEventListener('click', close);
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  requestAnimationFrame(center);
  return { dlg, body, close, center, setTitle: (t) => { titleSpan.textContent = t; }, isOpen: () => open };
}

export function messageDialog(applet, title, message, kind = 'info') {
  return optionDialog(applet, { title, message, kind, options: [{ text: 'OK' }], test: `dialog-${kind}` });
}
