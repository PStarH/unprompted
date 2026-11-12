/* Unprompted documentation interactions. No analytics, storage or network
   requests beyond the same-origin search index. */
(() => {
  const body = document.body;
  const root = body.dataset.root || '';
  const lang = body.dataset.lang || 'en';
  const labels = (() => {
    try { return JSON.parse(body.dataset.labels || '{}'); }
    catch { return {}; }
  })();
  const searchDialog = document.querySelector('#search-dialog');
  const searchInput = document.querySelector('#search-input');
  const searchResults = document.querySelector('#search-results');
  const searchHint = document.querySelector('#search-hint');
  const mobileNav = document.querySelector('#mobile-nav');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const text = (key, fallback) => labels[key] || fallback;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  if (!isMac) {
    document.querySelectorAll('.search-kbd').forEach(node => { node.textContent = 'Ctrl K'; });
  }

  function setDialogOpen(dialog, open) {
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      document.body.classList.add('dialog-open');
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      document.body.classList.remove('dialog-open');
    }
  }

  document.querySelectorAll('[data-menu-open]').forEach(button => {
    button.addEventListener('click', () => setDialogOpen(mobileNav, true));
  });
  document.querySelectorAll('[data-menu-close]').forEach(button => {
    button.addEventListener('click', () => setDialogOpen(mobileNav, false));
  });
  mobileNav?.addEventListener('click', event => {
    if (event.target === mobileNav) setDialogOpen(mobileNav, false);
    if (event.target.closest('a')) setDialogOpen(mobileNav, false);
  });
  mobileNav?.addEventListener('close', () => document.body.classList.remove('dialog-open'));

  /* Header shadow --------------------------------------------------------- */
  const header = document.querySelector('.site-header');
  const onScrollHeader = () => header?.classList.toggle('is-scrolled', window.scrollY > 2);
  window.addEventListener('scroll', onScrollHeader, { passive: true });
  onScrollHeader();

  /* Copy controls --------------------------------------------------------- */
  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      document.body.append(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      area.remove();
      return ok;
    }
  }

  document.querySelectorAll('[data-copy-target]').forEach(button => {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      if (!target) return;
      const ok = await copyText(target.textContent);
      const original = button.dataset.copyLabel || text('copy', 'Copy');
      const copied = button.dataset.copiedLabel || text('copied', 'Copied');
      button.textContent = ok ? copied : original;
      window.setTimeout(() => { button.textContent = original; }, 1600);
    });
  });

  document.querySelectorAll('.code-copy').forEach(button => {
    button.addEventListener('click', async () => {
      const code = button.closest('.code-block')?.querySelector('code');
      if (!code) return;
      const ok = await copyText(code.textContent);
      const original = button.dataset.copyLabel || text('copy', 'Copy');
      const copied = button.dataset.copiedLabel || text('copied', 'Copied');
      button.textContent = ok ? copied : original;
      window.setTimeout(() => { button.textContent = original; }, 1600);
    });
  });

  /* Table of contents ----------------------------------------------------- */
  const tocHeadings = [...document.querySelectorAll('.prose h2[id], .prose h3[id]')];
  const tocLinks = [...document.querySelectorAll('.toc-list a, .toc-mobile a')];
  let tocFrame = 0;
  function updateToc() {
    tocFrame = 0;
    if (!tocHeadings.length) return;
    const offset = 88;
    let active = tocHeadings[0].id;
    for (const heading of tocHeadings) {
      if (heading.getBoundingClientRect().top <= offset) active = heading.id;
      else break;
    }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      active = tocHeadings[tocHeadings.length - 1].id;
    }
    tocLinks.forEach(link => {
      const target = link.getAttribute('href')?.slice(1);
      link.classList.toggle('is-active', target === active);
      if (target === active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  function queueToc() {
    if (tocFrame) return;
    tocFrame = window.requestAnimationFrame(updateToc);
  }
  window.addEventListener('scroll', queueToc, { passive: true });
  window.addEventListener('resize', queueToc);
  updateToc();

  /* Search ---------------------------------------------------------------- */
  const searchState = { entries: null, error: false, loading: false, active: 0 };
  const normalize = value => String(value).toLowerCase().normalize('NFKC');
  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapeHtml = value => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  function loadIndex() {
    if (searchState.entries || searchState.loading) return Promise.resolve();
    searchState.loading = true;
    const indexUrl = body.dataset.searchIndex || `${root}search-${lang}.json`;
    return fetch(indexUrl, { credentials: 'same-origin' })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(entries => {
        searchState.entries = Array.isArray(entries) ? entries : [];
      })
      .catch(() => {
        searchState.error = true;
      })
      .finally(() => {
        searchState.loading = false;
      });
  }

  function highlight(value, query) {
    const safe = escapeHtml(value);
    const terms = query.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!terms.length) return safe;
    const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
    return safe.replace(pattern, '<mark>$1</mark>');
  }

  function snippet(entry, query) {
    const textValue = entry.text || '';
    if (!textValue) return '';
    const lower = normalize(textValue);
    const first = query.split(/\s+/).filter(Boolean)
      .map(term => lower.indexOf(normalize(term)))
      .filter(index => index >= 0)
      .sort((a, b) => a - b)[0];
    if (first === undefined) return textValue.slice(0, 150);
    const start = Math.max(0, first - 55);
    const end = Math.min(textValue.length, first + 145);
    return `${start > 0 ? '…' : ''}${textValue.slice(start, end)}${end < textValue.length ? '…' : ''}`;
  }

  function search(query) {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const scored = [];
    for (const entry of searchState.entries || []) {
      const title = normalize(entry.title || '');
      const pageTitle = normalize(entry.pageTitle || '');
      const textValue = normalize(entry.text || '');
      const haystack = `${title} ${pageTitle} ${textValue}`;
      if (!terms.every(term => haystack.includes(term))) continue;
      const phrase = terms.join(' ');
      let score = 0;
      if (title === phrase) score += 120;
      else if (title.startsWith(phrase)) score += 70;
      else if (title.includes(phrase)) score += 42;
      if (pageTitle === phrase) score += 80;
      else if (pageTitle.includes(phrase)) score += 28;
      for (const term of terms) {
        if (title.includes(term)) score += 16;
        if (pageTitle.includes(term)) score += 8;
        if (textValue.includes(term)) score += 2;
      }
      if (!entry.title || entry.title === entry.pageTitle) score += 4;
      if (entry.url && !entry.url.includes('#')) score += 3;
      scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.entry.pageTitle || '').localeCompare(b.entry.pageTitle || ''));
    const results = [];
    const perPage = new Map();
    for (const { entry } of scored) {
      const page = entry.pageTitle || '';
      const count = perPage.get(page) || 0;
      if (count >= 2) continue;
      perPage.set(page, count + 1);
      results.push(entry);
      if (results.length >= 12) break;
    }
    return results;
  }

  function setActive(index) {
    const items = [...searchResults.querySelectorAll('.search-result')];
    if (!items.length) {
      searchState.active = 0;
      searchInput?.removeAttribute('aria-activedescendant');
      return;
    }
    searchState.active = Math.max(0, Math.min(index, items.length - 1));
    items.forEach((item, itemIndex) => {
      const active = itemIndex === searchState.active;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });
    const active = items[searchState.active];
    searchInput?.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  }

  function renderSearch(query) {
    if (!searchResults) return;
    if (!query.trim()) {
      searchResults.innerHTML = `<p class="search-empty">${escapeHtml(text('searchStart', 'Type to search the documentation.'))}</p>`;
      searchInput?.removeAttribute('aria-activedescendant');
      return;
    }
    if (searchState.error) {
      searchResults.innerHTML = `<p class="search-empty">${escapeHtml(text('searchUnavailable', 'Search is unavailable. You can still browse the sidebar.'))}</p>`;
      return;
    }
    const results = search(query);
    if (!results.length) {
      searchResults.innerHTML = `<p class="search-empty">${escapeHtml(text('noResults', 'No results for'))} “${escapeHtml(query)}”.</p>`;
      searchInput?.removeAttribute('aria-activedescendant');
      return;
    }
    let lastPage = '';
    searchResults.innerHTML = results.map((entry, index) => {
      const page = entry.pageTitle || '';
      const showPage = page && page !== lastPage && entry.title !== page;
      lastPage = page;
      const href = root + entry.url;
      const meta = [entry.group, page].filter(Boolean).join(' · ');
      return `${showPage ? `<p class="search-group-label">${escapeHtml(page)}</p>` : ''}<a class="search-result" href="${escapeHtml(href)}" id="search-result-${index}" role="option" aria-selected="false"><span class="search-result-title">${highlight(entry.title || page, query)}</span><span class="search-result-meta">${escapeHtml(meta)}</span>${entry.text ? `<span class="search-result-snippet">${highlight(snippet(entry, query), query)}</span>` : ''}</a>`;
    }).join('');
    setActive(0);
  }

  function openSearch() {
    if (!searchDialog) return;
    setDialogOpen(searchDialog, true);
    if (searchHint) searchHint.textContent = text('searchHint', 'Search titles, headings and page text');
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    if (!searchState.entries && !searchState.loading) {
      searchResults.innerHTML = `<p class="search-empty">${escapeHtml(text('loading', 'Loading search…'))}</p>`;
      loadIndex().then(() => renderSearch(searchInput?.value || ''));
    } else {
      renderSearch('');
    }
  }

  document.querySelectorAll('[data-search-open]').forEach(button => {
    button.addEventListener('click', openSearch);
  });
  document.querySelectorAll('[data-search-close]').forEach(button => {
    button.addEventListener('click', () => setDialogOpen(searchDialog, false));
  });
  searchDialog?.addEventListener('click', event => {
    if (event.target === searchDialog) setDialogOpen(searchDialog, false);
  });
  searchDialog?.addEventListener('close', () => {
    document.body.classList.remove('dialog-open');
    if (searchInput) searchInput.value = '';
  });
  searchInput?.addEventListener('input', () => renderSearch(searchInput.value));
  searchInput?.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (searchState.entries) setActive(searchState.active + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(searchState.active - 1);
    } else if (event.key === 'Enter') {
      const item = searchResults?.querySelector(`#search-result-${searchState.active}`);
      if (item) {
        event.preventDefault();
        window.location.href = item.getAttribute('href');
      }
    }
  });

  document.addEventListener('keydown', event => {
    const modifier = isMac ? event.metaKey : event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    }
    if (event.key === '/' && !modifier && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
      event.preventDefault();
      openSearch();
    }
  });

  /* Keep the index warm once the page is idle. */
  const idle = window.requestIdleCallback || (callback => window.setTimeout(callback, 1200));
  idle(() => { loadIndex(); });

  reduceMotion.addEventListener?.('change', queueToc);
})();
