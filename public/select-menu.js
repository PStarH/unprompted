// Styled replacement for the browser's native <select> popup. The <select>
// stays the source of truth (value, change events, form state), so live
// re-renders, tests and assistive tech keep working; only the list is ours.
// Touch devices keep the operating system's picker.
const SELECTOR = 'select:not([multiple]):not([size])';
const OPEN_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', ' ']);
const finePointer = () => !matchMedia('(pointer: coarse)').matches;
let menu = null;
let owner = null;
let active = -1;
let observer = null;
let typed = '';
let typedAt = 0;

const items = () => (menu ? [...menu.querySelectorAll('[role=option]')] : []);
const enabled = item => item.getAttribute('aria-disabled') !== 'true';

function build(select) {
  const list = document.createElement('div');
  list.className = 'select-menu';
  list.id = 'select-menu';
  list.setAttribute('role', 'listbox');
  const name = select.getAttribute('aria-label');
  if (name) list.setAttribute('aria-label', name);
  let group = null;
  [...select.options].forEach((option, index) => {
    const parent = option.parentElement;
    const grouped = parent instanceof HTMLOptGroupElement;
    if (grouped && parent !== group) {
      const heading = document.createElement('div');
      heading.className = 'select-menu-group';
      heading.setAttribute('role', 'presentation');
      heading.textContent = parent.label;
      list.append(heading);
    }
    group = grouped ? parent : null;
    const item = document.createElement('div');
    item.className = 'select-menu-item';
    item.id = `select-menu-option-${index}`;
    item.dataset.index = String(index);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.selected));
    if (option.disabled || (grouped && parent.disabled)) item.setAttribute('aria-disabled', 'true');
    item.textContent = option.textContent.trim();
    list.append(item);
  });
  return list;
}

function place() {
  if (!menu || !owner) return;
  const box = owner.getBoundingClientRect();
  const gap = 6;
  const below = window.innerHeight - box.bottom - gap - 8;
  const above = box.top - gap - 8;
  const flip = below < 180 && above > below;
  menu.style.minWidth = `${Math.round(box.width)}px`;
  menu.style.maxHeight = `${Math.max(120, Math.min(340, flip ? above : below))}px`;
  const left = Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8));
  menu.style.left = `${left}px`;
  if (flip) { menu.style.top = 'auto'; menu.style.bottom = `${window.innerHeight - box.top + gap}px`; }
  else { menu.style.bottom = 'auto'; menu.style.top = `${box.bottom + gap}px`; }
}

function setActive(index, { scroll = true } = {}) {
  const list = items();
  active = index;
  list.forEach((item, i) => item.classList.toggle('is-active', i === index));
  const item = list[index];
  if (!item) return;
  owner?.setAttribute('aria-activedescendant', item.id);
  if (scroll) item.scrollIntoView({ block: 'nearest' });
}

function step(direction, from = active) {
  const list = items();
  for (let i = from + direction; i >= 0 && i < list.length; i += direction) if (enabled(list[i])) return i;
  return from;
}

function close() {
  if (!menu) return;
  observer?.disconnect();
  observer = null;
  if (owner) for (const name of ['aria-expanded', 'aria-controls', 'aria-activedescendant']) owner.removeAttribute(name);
  menu.remove();
  menu = null;
  owner = null;
  active = -1;
  typed = '';
}

function open(select) {
  if (select.disabled || !select.options.length) return;
  close();
  owner = select;
  menu = build(select);
  // Inside a modal dialog the list must live in the dialog, or it would be inert.
  const host = select.closest('dialog[open]') || document.body;
  const popover = typeof menu.showPopover === 'function';
  if (popover) menu.popover = 'manual';
  host.append(menu);
  if (popover) menu.showPopover();
  select.setAttribute('aria-expanded', 'true');
  select.setAttribute('aria-controls', menu.id);
  place();
  setActive(Math.max(0, select.selectedIndex));
  // A live re-render that replaces the select or its options makes the list stale.
  observer = new MutationObserver(records => {
    if (!owner?.isConnected || records.some(record => owner.contains(record.target) || [...record.removedNodes].includes(owner))) close();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function choose(index) {
  const select = owner;
  const option = select?.options[index];
  if (!option || option.disabled) return;
  const changed = select.selectedIndex !== index;
  close();
  if (!changed) return;
  select.selectedIndex = index;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function typeahead(key, list) {
  const now = performance.now();
  typed = now - typedAt > 700 ? key.toLowerCase() : typed + key.toLowerCase();
  typedAt = now;
  const from = typed.length === 1 ? active + 1 : active;
  for (let n = 0; n < list.length; n++) {
    const i = (from + n) % list.length;
    if (enabled(list[i]) && list[i].textContent.trim().toLowerCase().startsWith(typed)) { setActive(i); return; }
  }
}

document.addEventListener('mousedown', event => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (menu?.contains(target)) { event.preventDefault(); return; }
  const select = target.closest(SELECTOR);
  if (select && event.button === 0 && finePointer()) {
    event.preventDefault();
    select.focus({ preventScroll: true });
    if (select === owner) close(); else open(select);
    return;
  }
  close();
}, true);

document.addEventListener('click', event => {
  const item = menu && event.target instanceof Element ? event.target.closest('.select-menu-item') : null;
  if (!item || !menu.contains(item) || !enabled(item)) return;
  event.preventDefault();
  choose(Number(item.dataset.index));
});

document.addEventListener('mousemove', event => {
  const item = menu && event.target instanceof Element ? event.target.closest('.select-menu-item') : null;
  if (item && enabled(item) && Number(item.dataset.index) !== active) setActive(Number(item.dataset.index), { scroll: false });
});

document.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (!menu) {
    const select = event.target instanceof Element ? event.target.closest(SELECTOR) : null;
    if (select && !select.disabled && finePointer() && !event.ctrlKey && !event.metaKey && OPEN_KEYS.has(event.key)) { event.preventDefault(); open(select); }
    return;
  }
  const list = items();
  let handled = true;
  if (event.key === 'ArrowDown') setActive(step(1));
  else if (event.key === 'ArrowUp') setActive(step(-1));
  else if (event.key === 'Home') setActive(step(1, -1));
  else if (event.key === 'End') setActive(step(-1, list.length));
  else if (event.key === 'Enter' || event.key === ' ') choose(active);
  else if (event.key === 'Escape') close();
  else if (event.key === 'Tab') { close(); handled = false; }
  else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) typeahead(event.key, list);
  else handled = false;
  if (handled) { event.preventDefault(); event.stopPropagation(); }
}, true);

window.addEventListener('resize', close);
window.addEventListener('blur', close);
document.addEventListener('scroll', event => { if (menu && !menu.contains(event.target)) close(); }, true);
