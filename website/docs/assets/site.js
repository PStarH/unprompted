document.documentElement.classList.add('js');

const root = document.documentElement;
const labels = {
  copy: root.dataset.copy || 'Copy',
  copied: root.dataset.copied || 'Copied',
  noResults: root.dataset.noResults || 'No matches',
  searchStart: root.dataset.searchStart || 'Type to search.',
  close: root.dataset.close || 'Close'
};

const header = document.querySelector('.header');
const onScroll = () => header?.classList.toggle('is-scrolled', window.scrollY > 4);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

function trap(dialog) {
  const focusable = [...dialog.querySelectorAll('a, button, input, summary')].filter(el => !el.disabled);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || focusable.length === 0) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

const drawer = document.querySelector('.drawer');
const scrim = document.querySelector('.scrim');
const menuButton = document.querySelector('[data-menu]');
let menuReturn = null;

function setMenu(open) {
  if (!drawer) return;
  drawer.classList.toggle('is-open', open);
  scrim?.classList.toggle('is-open', open);
  drawer.toggleAttribute('inert', !open);
  menuButton?.setAttribute('aria-expanded', String(open));
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) {
    menuReturn = document.activeElement;
    drawer.querySelector('a, button')?.focus();
  } else menuReturn?.focus?.();
}

menuButton?.addEventListener('click', () => setMenu(true));
document.querySelector('[data-menu-close]')?.addEventListener('click', () => setMenu(false));
scrim?.addEventListener('click', () => {
  setMenu(false);
  setSearch(false);
});
drawer?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => setMenu(false)));
if (drawer) {
  drawer.setAttribute('inert', '');
  trap(drawer);
}

const searchDialog = document.querySelector('.search-dialog');
const searchInput = searchDialog?.querySelector('input');
const searchList = searchDialog?.querySelector('.search-list');
const searchStatus = searchDialog?.querySelector('.search-status');
let searchReturn = null;
let records = null;
let activeIndex = 0;

function setSearch(open) {
  if (!searchDialog) return;
  searchDialog.classList.toggle('is-open', open);
  searchDialog.toggleAttribute('inert', !open);
  scrim?.classList.toggle('is-open', open || drawer?.classList.contains('is-open'));
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) {
    searchReturn = document.activeElement;
    searchInput.value = '';
    renderResults('');
    searchInput.focus();
  } else searchReturn?.focus?.();
}

async function loadRecords() {
  if (records) return records;
  const prefix = root.dataset.root || '';
  const lang = root.dataset.lang === 'zh' ? 'zh' : 'en';
  const response = await fetch(`${prefix}search-${lang}.json`);
  if (!response.ok) throw new Error('search index');
  records = await response.json();
  return records;
}

function score(item, query) {
  const title = item.title.toLowerCase();
  const text = (item.text || '').toLowerCase();
  const haystack = `${title} ${text}`;
  if (title.includes(query)) return 4;
  const parts = query.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && parts.every(part => haystack.includes(part))) return 2;
  if (text.includes(query)) return 1;
  return 0;
}

function renderResults(raw) {
  const query = raw.trim().toLowerCase();
  searchList.replaceChildren();
  if (!query) {
    searchStatus.textContent = labels.searchStart;
    return;
  }
  const matches = (records || [])
    .map(item => ({ item, rank: score(item, query) }))
    .filter(entry => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.item.title.localeCompare(b.item.title))
    .slice(0, 12);
  if (matches.length === 0) {
    searchStatus.textContent = `${labels.noResults} “${raw.trim()}”`;
    return;
  }
  searchStatus.textContent = '';
  activeIndex = 0;
  const prefix = root.dataset.root || '';
  matches.forEach((entry, index) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = index === 0 ? 'is-active' : '';
    button.dataset.href = prefix + entry.item.url;
    const strong = document.createElement('strong');
    strong.textContent = entry.item.title;
    button.append(strong);
    if (entry.item.section) {
      const small = document.createElement('small');
      small.textContent = entry.item.section;
      button.append(small);
    }
    button.addEventListener('click', () => { window.location.href = button.dataset.href; });
    li.append(button);
    searchList.append(li);
  });
}

function moveSearch(delta) {
  const buttons = [...searchList.querySelectorAll('button')];
  if (buttons.length === 0) return;
  activeIndex = (activeIndex + delta + buttons.length) % buttons.length;
  buttons.forEach((button, index) => button.classList.toggle('is-active', index === activeIndex));
  buttons[activeIndex].scrollIntoView({ block: 'nearest' });
}

document.querySelectorAll('[data-search]').forEach(button => {
  button.addEventListener('click', async () => {
    try {
      await loadRecords();
      setSearch(true);
    } catch {
      searchStatus.textContent = labels.noResults;
      setSearch(true);
    }
  });
});
document.querySelector('[data-search-close]')?.addEventListener('click', () => setSearch(false));
searchInput?.addEventListener('input', () => renderResults(searchInput.value));
searchDialog && trap(searchDialog);
if (searchDialog) searchDialog.setAttribute('inert', '');

document.addEventListener('keydown', event => {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (searchDialog?.classList.contains('is-open')) setSearch(false);
    else document.querySelector('[data-search]')?.click();
    return;
  }
  if (event.key === 'Escape') {
    setMenu(false);
    setSearch(false);
  }
  if (!searchDialog?.classList.contains('is-open')) return;
  if (event.key === 'ArrowDown') { event.preventDefault(); moveSearch(1); }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveSearch(-1); }
  if (event.key === 'Enter') {
    const current = searchList.querySelectorAll('button')[activeIndex];
    if (current) window.location.href = current.dataset.href;
  }
});

document.querySelectorAll('[data-copy-page]').forEach(button => {
  const idle = button.textContent;
  button.addEventListener('click', async () => {
    const source = document.getElementById('page-markdown');
    try {
      await navigator.clipboard.writeText(source ? JSON.parse(source.textContent) : '');
      button.textContent = labels.copied;
      setTimeout(() => { button.textContent = idle; }, 1400);
    } catch {
      button.textContent = idle;
    }
  });
});

document.querySelectorAll('.code-copy').forEach(button => {
  button.addEventListener('click', async () => {
    const code = button.parentElement.querySelector('code')?.innerText || '';
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = labels.copied;
      setTimeout(() => { button.textContent = labels.copy; }, 1400);
    } catch {
      button.textContent = labels.copy;
    }
  });
});

const tocLinks = [...document.querySelectorAll('.toc a')];
if (tocLinks.length && 'IntersectionObserver' in window) {
  const map = new Map(tocLinks.map(link => [decodeURIComponent(link.getAttribute('href').slice(1)), link]));
  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    tocLinks.forEach(link => link.classList.remove('is-active'));
    map.get(visible.target.id)?.classList.add('is-active');
  }, { rootMargin: '-20% 0px -70% 0px', threshold: [0, 1] });
  map.forEach((_, id) => {
    const target = document.getElementById(id);
    if (target) observer.observe(target);
  });
}
