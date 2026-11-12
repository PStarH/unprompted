#!/usr/bin/env node
/**
 * Build the Unprompted documentation site.
 *
 * The output is plain HTML, CSS, JS and JSON so GitHub Pages can serve it from
 * /unprompted/docs/ without a server or a framework build. Markdown sources and
 * navigation live under website/docs/content/ and website/docs/nav.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, '..', '..');
const contentRoot = path.join(root, 'content');
const nav = JSON.parse(fs.readFileSync(path.join(root, 'nav.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = packageJson.version || '0.0.0';
const siteBase = 'https://pstarh.github.io/unprompted/docs/';
const repoUrl = 'https://github.com/PStarH/unprompted';

const alertLabels = {
  en: { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' },
  zh: { note: '说明', tip: '提示', important: '重要', warning: '注意', caution: '当心' }
};

const escapeHtml = value => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const decodeBasic = value => String(value)
  .replaceAll('&amp;', '&')
  .replaceAll('&quot;', '"')
  .replaceAll('&#39;', "'");

const slugify = value => {
  const slug = String(value)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return slug || 'section';
};

const plainInline = value => decodeBasic(String(value)
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/[`*_~]/g, '')
  .replace(/\s+/g, ' ')
  .trim());

const pageUrl = (lang, slug) => lang === 'en' ? (slug ? `${slug}/` : '') : `zh/${slug ? `${slug}/` : ''}`;

function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { data: {}, body: source };
  const data = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, body: source.slice(match[0].length) };
}

function linkHref(raw, ctx) {
  const href = decodeBasic(raw);
  if (/^(?:https?:|mailto:|tel:|#)/i.test(href)) return href;
  if (href.endsWith('.md') || href.includes('.md#')) {
    const [file, fragment] = href.split('#');
    const target = file.replace(/^.*\//, '').replace(/\.md$/, '');
    const slug = target === 'index' ? '' : target;
    const base = ctx.prefix + pageUrl(ctx.lang, slug);
    return fragment ? `${base}#${fragment}` : (base || './');
  }
  if (href.startsWith('assets/') || href.startsWith('../assets/') || href.startsWith('../../assets/')) {
    return ctx.prefix + href.replace(/^(?:\.\.\/)+assets\//, 'assets/');
  }
  if (href.startsWith('/')) return href;
  return ctx.prefix + href;
}

function renderInline(text, ctx) {
  const codes = [];
  let value = escapeHtml(text);
  value = value.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });
  value = value.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, raw) => {
    const src = linkHref(raw, ctx);
    return `<img src="${escapeHtml(src)}" alt="${alt}" loading="lazy" decoding="async">`;
  });
  value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, raw) => {
    const href = linkHref(raw, ctx);
    const external = /^https?:/i.test(href);
    return `<a href="${escapeHtml(href)}"${external ? ' rel="noreferrer"' : ''}>${label}</a>`;
  });
  value = value.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  value = value.replace(/~~(.+?)~~/g, '<del>$1</del>');
  value = value.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codes[Number(index)]);
  return value;
}

const leadingSpaces = line => line.match(/^(\s*)/)[1].length;
const isListLine = line => /^\s*(?:[-*]|\d+\.)\s+/.test(line);
const isTableStart = (lines, index) => {
  const line = lines[index] || '';
  const next = lines[index + 1] || '';
  return line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(next) && next.includes('|');
};
const startsBlock = line => /^#{1,6}\s+/.test(line) || /^```/.test(line) || /^>\s?/.test(line) || /^---+$/.test(line.trim()) || isListLine(line);

function tableCells(line) {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map(cell => cell.trim());
}

function renderTable(lines, start, ctx, state) {
  const header = tableCells(lines[start]);
  const separator = tableCells(lines[start + 1]);
  const align = separator.map(cell => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
  let index = start + 2;
  const rows = [];
  while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
    rows.push(tableCells(lines[index]));
    state.current.text.push(lines[index]);
    index += 1;
  }
  const head = header.map((cell, column) => `<th${align[column] !== 'left' ? ` style="text-align:${align[column]}"` : ''}>${renderInline(cell, ctx)}</th>`).join('');
  const body = rows.map(row => `<tr>${header.map((_, column) => `<td${align[column] !== 'left' ? ` style="text-align:${align[column]}"` : ''}>${renderInline(row[column] || '', ctx)}</td>`).join('')}</tr>`).join('');
  return {
    html: `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    next: index
  };
}

function renderList(lines, start, indent, ctx, state) {
  const ordered = /^\s*\d+\.\s+/.test(lines[start]);
  const tag = ordered ? 'ol' : 'ul';
  let index = start;
  let html = `<${tag}>`;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) break;
    const match = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (!match) break;
    const itemIndent = match[1].length;
    if (itemIndent < indent) break;
    if (itemIndent > indent) {
      const child = renderList(lines, index, itemIndent, ctx, state);
      html += child.html;
      index = child.next;
      continue;
    }
    const itemOrdered = /^\d+\./.test(match[2]);
    if (itemOrdered !== ordered) break;
    let text = match[3];
    index += 1;
    const extra = [];
    while (index < lines.length && lines[index].trim() && leadingSpaces(lines[index]) > indent && !isListLine(lines[index])) {
      extra.push(lines[index].trim());
      index += 1;
    }
    if (extra.length) text += ` ${extra.join(' ')}`;
    let nested = '';
    if (index < lines.length) {
      const nextMatch = lines[index].match(/^(\s*)([-*]|\d+\.)\s+/);
      if (nextMatch && nextMatch[1].length > indent) {
        const child = renderList(lines, index, nextMatch[1].length, ctx, state);
        nested = child.html;
        index = child.next;
      }
    }
    state.current.text.push(plainInline(text));
    html += `<li>${renderInline(text, ctx)}${nested}</li>`;
  }
  html += `</${tag}>`;
  return { html, next: index };
}

function renderBlocks(lines, ctx, state) {
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    if (/^```/.test(line)) {
      const language = line.replace(/^```/, '').trim();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const codeText = escapeHtml(code.join('\n'));
      output.push(`<div class="code-block"${language ? ` data-language="${escapeHtml(language)}"` : ''}><pre><code>${codeText}</code></pre><button type="button" class="code-copy" data-copy-label="${escapeHtml(ctx.labels.copy)}" data-copied-label="${escapeHtml(ctx.labels.copied)}">${escapeHtml(ctx.labels.copy)}</button></div>`);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      if (level === 1) throw new Error(`${ctx.file}: use the frontmatter title instead of an H1`);
      const title = heading[2].trim();
      const id = uniqueSlug(title, state.slugs);
      if (level === 2 || level === 3) {
        state.current = { title: plainInline(title), anchor: id, text: [], page: ctx.pageTitle, url: `${ctx.pagePath}${id ? `#${id}` : ''}`, group: ctx.group };
        state.sections.push(state.current);
      }
      const anchor = `<a class="heading-anchor" href="#${id}" aria-label="${escapeHtml(ctx.labels.linkSection)}">#</a>`;
      output.push(`<h${level} id="${id}">${renderInline(title, ctx)}${anchor}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      output.push('<hr>');
      index += 1;
      continue;
    }

    if (line.startsWith('>')) {
      const quote = [];
      while (index < lines.length && lines[index].startsWith('>')) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      const alert = quote[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i);
      if (alert) {
        const kind = alert[1].toLowerCase();
        quote.shift();
        const inner = renderBlocks(quote, ctx, state).html;
        output.push(`<aside class="callout callout-${kind}"><p class="callout-label">${escapeHtml(alertLabels[ctx.lang][kind] || alert[1])}</p>${inner}</aside>`);
      } else {
        const inner = renderBlocks(quote, ctx, state).html;
        output.push(`<blockquote>${inner}</blockquote>`);
      }
      continue;
    }

    if (isTableStart(lines, index)) {
      const table = renderTable(lines, index, ctx, state);
      output.push(table.html);
      index = table.next;
      continue;
    }

    if (isListLine(line)) {
      const list = renderList(lines, index, leadingSpaces(line), ctx, state);
      output.push(list.html);
      index = list.next;
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index]) && !isTableStart(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    const paragraphText = paragraph.join(' ');
    state.current.text.push(plainInline(paragraphText));
    output.push(`<p>${renderInline(paragraphText, ctx)}</p>`);
  }
  return { html: output.join('\n') };
}

function uniqueSlug(title, counts) {
  const base = slugify(title);
  const count = counts.get(base) || 0;
  counts.set(base, count + 1);
  return count ? `${base}-${count + 1}` : base;
}

function sectionsFromMarkdown(body, page, group) {
  const clean = body.replace(/```[\s\S]*?```/g, '\n');
  const lines = clean.split('\n');
  const state = {
    slugs: new Map(),
    sections: [{ title: page.title, anchor: '', text: [page.description || ''], page: page.title, url: page.url, group }],
    current: null
  };
  state.current = state.sections[0];
  renderBlocks(lines, {
    lang: page.lang,
    prefix: '',
    pageTitle: page.title,
    pagePath: page.url,
    group,
    labels: page.labels,
    file: page.file
  }, state);
  return state.sections.map(section => ({
    ...section,
    text: section.text.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1400)
  }));
}

function navGroups(lang) {
  return nav[lang].groups;
}

function flattenPages(lang) {
  return navGroups(lang).flatMap(group => group.links.map(link => ({ ...link, group: group.title })));
}

function navHtml(lang, activeSlug, prefix, labels) {
  return navGroups(lang).map(group => {
    const links = group.links.map(link => {
      const href = prefix + pageUrl(lang, link.slug) || './';
      const active = link.slug === activeSlug;
      return `<li><a href="${escapeHtml(href)}"${active ? ' class="is-active" aria-current="page"' : ''}><span>${escapeHtml(link.title)}</span>${active ? '<span class="nav-dot" aria-hidden="true"></span>' : ''}</a></li>`;
    }).join('');
    return `<section class="nav-group"><h2>${escapeHtml(group.title)}</h2><ul>${links}</ul></section>`;
  }).join('');
}

function headerHtml(lang, slug, prefix, labels) {
  const other = lang === 'en' ? 'zh' : 'en';
  const otherHref = prefix + pageUrl(other, slug) || './';
  const homeHref = prefix + pageUrl(lang, '') || './';
  const quickHref = prefix + pageUrl(lang, 'quickstart');
  return `<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="${escapeHtml(homeHref)}" aria-label="${escapeHtml(labels.home)}">
      <img src="${prefix}assets/logo.svg" alt="" width="26" height="26">
      <span class="brand-name">unprompted</span>
      <span class="brand-docs">${escapeHtml(labels.docs)}</span>
    </a>
    <span class="version-badge">${escapeHtml(labels.version)}</span>
    <button class="search-trigger" type="button" data-search-open aria-label="${escapeHtml(labels.search)}">
      <svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17"><path d="m14.9 13.5 3.4 3.4M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <span class="search-label">${escapeHtml(labels.search)}</span>
      <kbd class="search-kbd">⌘K</kbd>
    </button>
    <nav class="header-nav" aria-label="${escapeHtml(labels.docs)}">
      <a href="${escapeHtml(quickHref)}">${escapeHtml(labels.getStarted)}</a>
      <a class="header-github" href="${repoUrl}" rel="noreferrer">${escapeHtml(labels.github)}<span aria-hidden="true">↗</span></a>
    </nav>
    <div class="language-switch" role="group" aria-label="${escapeHtml(labels.language)}">
      <a href="${escapeHtml(prefix + pageUrl('en', slug) || './')}"${lang === 'en' ? ' class="is-active" aria-current="page"' : ''} hreflang="en">EN</a>
      <a href="${escapeHtml(prefix + pageUrl('zh', slug) || './')}"${lang === 'zh' ? ' class="is-active" aria-current="page"' : ''} hreflang="zh-CN">中文</a>
    </div>
    <button class="menu-trigger" type="button" data-menu-open aria-label="${escapeHtml(labels.menu)}" aria-controls="mobile-nav">
      <svg aria-hidden="true" viewBox="0 0 24 24" width="21" height="21"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
    </button>
  </div>
</header>`;
}

function tocHtml(toc, labels) {
  if (!toc.length) return '';
  const items = toc.map(section => `<li><a href="#${escapeHtml(section.anchor)}">${escapeHtml(section.title)}</a>${section.children?.length ? `<ol>${section.children.map(child => `<li><a href="#${escapeHtml(child.anchor)}">${escapeHtml(child.title)}</a></li>`).join('')}</ol>` : ''}</li>`).join('');
  return `<aside class="toc" aria-label="${escapeHtml(labels.onThisPage)}"><div class="toc-inner"><p class="toc-title">${escapeHtml(labels.onThisPage)}</p><ol class="toc-list">${items}</ol></div></aside>`;
}

function mobileTocHtml(toc, labels) {
  if (!toc.length) return '';
  const items = toc.map(section => `<li><a href="#${escapeHtml(section.anchor)}">${escapeHtml(section.title)}</a>${section.children?.length ? `<ol>${section.children.map(child => `<li><a href="#${escapeHtml(child.anchor)}">${escapeHtml(child.title)}</a></li>`).join('')}</ol>` : ''}</li>`).join('');
  return `<details class="toc-mobile"><summary>${escapeHtml(labels.onThisPage)}</summary><ol>${items}</ol></details>`;
}

function heroHtml(labels, prefix, lang) {
  return `<section class="docs-hero">
  <div class="hero-copy">
    <p class="eyebrow"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(labels.homeEyebrow)} · ${escapeHtml(labels.version)}</p>
    <h1>${labels.homeTitle}</h1>
    <p class="hero-lead">${escapeHtml(labels.homeLead)}</p>
    <div class="hero-actions">
      <a class="button" href="${prefix}${pageUrl(lang, 'quickstart') || 'quickstart/'}">${escapeHtml(labels.homeStart)}<span aria-hidden="true">→</span></a>
      <button class="text-button" type="button" data-search-open>${escapeHtml(labels.homeSearch)}</button>
    </div>
    <p class="hero-meta">${escapeHtml(labels.homeMeta)}</p>
  </div>
  <div class="hero-panel" aria-label="${escapeHtml(labels.quickStart)}">
    <div class="panel-bar"><span>${escapeHtml(labels.quickStart)}</span><button type="button" class="panel-copy" data-copy-target="hero-command" data-copy-label="${escapeHtml(labels.copy)}" data-copied-label="${escapeHtml(labels.copied)}">${escapeHtml(labels.copy)}</button></div>
    <pre><code id="hero-command">git clone https://github.com/PStarH/unprompted.git
cd unprompted
npm ci --include=optional
npm start</code></pre>
    <p class="panel-note">${labels.quickStartNote}</p>
  </div>
</section>`;
}

function cardsHtml(labels, prefix, lang) {
  const cards = [
    { title: labels.cardInstallTitle, body: labels.cardInstallBody, href: prefix + pageUrl(lang, 'quickstart'), number: '01' },
    { title: labels.cardConnectorsTitle, body: labels.cardConnectorsBody, href: prefix + pageUrl(lang, 'connectors'), number: '02' },
    { title: labels.cardControlTitle, body: labels.cardControlBody, href: prefix + pageUrl(lang, 'permissions'), number: '03' },
    { title: labels.cardReferenceTitle, body: labels.cardReferenceBody, href: prefix + pageUrl(lang, 'development'), number: '04' }
  ];
  return `<section class="home-paths"><div class="home-paths-head"><h2>${escapeHtml(labels.startCardsTitle)}</h2><p>${escapeHtml(labels.startCardsLead)}</p></div><div class="path-grid">${cards.map(card => `<a class="path-card" href="${escapeHtml(card.href)}"><span class="path-number">${card.number}</span><h3>${escapeHtml(card.title)}</h3><p>${escapeHtml(card.body)}</p><span class="path-arrow" aria-hidden="true">↗</span></a>`).join('')}</div></section>`;
}

function buildPage(lang, page, content, allPages) {
  const labels = { ...nav[lang].labels, version: `v${version}` };
  const slug = page.slug;
  const outDir = lang === 'en' ? (slug || '.') : path.join('zh', slug || '.');
  const depth = outDir === '.' ? 0 : outDir.split(path.sep).filter(Boolean).length;
  const prefix = '../'.repeat(depth);
  const pagePath = pageUrl(lang, slug);
  const parsed = parseFrontmatter(content);
  const title = parsed.data.title || page.title;
  const description = parsed.data.description || '';
  const isHome = parsed.data.layout === 'home';
  const ctx = {
    lang,
    prefix,
    pageTitle: title,
    pagePath,
    group: page.group,
    labels,
    file: page.file
  };
  const state = {
    slugs: new Map(),
    sections: [{ title, anchor: '', text: [description], page: title, url: pagePath, group: page.group }],
    current: null
  };
  state.current = state.sections[0];
  const rendered = renderBlocks(parsed.body.split('\n'), ctx, state);
  // The renderer is the source of truth for heading IDs and TOC order.
  const renderedHeadings = [...rendered.html.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<a class="heading-anchor"/g)]
    .map(match => ({ level: Number(match[1]), id: match[2], title: plainInline(match[3]) }));
  const finalToc = [];
  let currentH2 = null;
  for (const heading of renderedHeadings) {
    if (heading.level === 2) {
      currentH2 = { ...heading, anchor: heading.id, children: [] };
      finalToc.push(currentH2);
    } else if (currentH2) {
      currentH2.children.push({ ...heading, anchor: heading.id });
    }
  }

  const sections = state.sections.map(section => ({
    ...section,
    text: section.text.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1400)
  }));
  const searchEntries = sections.map(section => ({
    title: section.title,
    pageTitle: title,
    group: page.group,
    url: section.url,
    text: section.text
  }));

  const index = allPages.findIndex(item => item.slug === slug);
  const previous = allPages[index - 1];
  const next = allPages[index + 1];
  const prevNext = (previous || next) ? `<nav class="prev-next" aria-label="Pagination">${previous ? `<a class="prev" href="${escapeHtml(prefix + pageUrl(lang, previous.slug))}"><span>${escapeHtml(labels.previous)}</span><strong>${escapeHtml(previous.title)}</strong></a>` : '<span></span>'}${next ? `<a class="next" href="${escapeHtml(prefix + pageUrl(lang, next.slug))}"><span>${escapeHtml(labels.next)}</span><strong>${escapeHtml(next.title)}</strong></a>` : ''}</nav>` : '';
  const homeContent = isHome ? `${heroHtml(labels, prefix, lang)}${cardsHtml(labels, prefix, lang)}` : '';
  const articleHeader = isHome ? '' : `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="${escapeHtml(prefix + pageUrl(lang, '') || './')}">${escapeHtml(labels.docs)}</a><span aria-hidden="true">/</span><span>${escapeHtml(page.group)}</span></nav>
  <header class="page-header"><h1>${escapeHtml(title)}</h1>${description ? `<p class="page-description">${escapeHtml(description)}</p>` : ''}</header>
  ${mobileTocHtml(finalToc, labels)}`;
  const editHref = `${repoUrl}/edit/main/website/docs/content/${lang}/${slug || 'index'}.md`;
  const articleBody = isHome ? `<div class="home-copy">${rendered.html}</div>` : rendered.html;
  const article = `<article class="prose${isHome ? ' prose-home' : ''}">${articleHeader}${homeContent}${articleBody}<div class="page-meta"><a href="${editHref}" rel="noreferrer">${escapeHtml(labels.edit)}<span aria-hidden="true">↗</span></a><span>${escapeHtml(labels.updated)}</span></div>${prevNext}</article>`;
  const footer = `<footer class="page-footer"><div><a class="footer-brand" href="${escapeHtml(prefix + pageUrl(lang, '') || './')}"><img src="${prefix}assets/logo.svg" alt="" width="22" height="22">unprompted</a><p>${escapeHtml(labels.footerNote)}</p></div><div class="footer-links"><a href="${repoUrl}" rel="noreferrer">GitHub ↗</a><a href="${repoUrl}/blob/main/LICENSE" rel="noreferrer">Apache-2.0 ↗</a><a href="${prefix}${pageUrl(lang, 'development')}">${escapeHtml(labels.docs)}</a></div></footer>`;

  const metaTitle = isHome ? `${title} · Unprompted` : `${title} · Unprompted ${labels.docs}`;
  const canonical = `${siteBase}${pagePath}`;
  const alternateEn = `${siteBase}${pageUrl('en', slug)}`;
  const alternateZh = `${siteBase}${pageUrl('zh', slug)}`;
  const searchIndex = `${prefix}search-${lang}.json`;
  const bodyData = `data-lang="${lang}" data-root="${escapeHtml(prefix)}" data-slug="${escapeHtml(slug)}" data-search-index="${escapeHtml(searchIndex)}" data-labels="${escapeHtml(JSON.stringify({ search: labels.search, noResults: labels.noResults, searchUnavailable: labels.searchUnavailable, searchStart: labels.searchStart, results: labels.results, close: labels.close }))}"`;
  const html = `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f7f7f2">
  <meta name="description" content="${escapeHtml(description || labels.homeLead)}">
  <meta name="author" content="Unprompted contributors">
  <meta property="og:title" content="${escapeHtml(metaTitle)}">
  <meta property="og:description" content="${escapeHtml(description || labels.homeLead)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${canonical}">
  <meta property="og:locale" content="${lang === 'zh' ? 'zh_CN' : 'en_US'}">
  <title>${escapeHtml(metaTitle)}</title>
  <link rel="canonical" href="${canonical}">
  <link rel="alternate" hreflang="en" href="${alternateEn}">
  <link rel="alternate" hreflang="zh-CN" href="${alternateZh}">
  <link rel="alternate" hreflang="x-default" href="${alternateEn}">
  <link rel="icon" href="${prefix}assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${prefix}assets/docs.css">
  <script src="${prefix}assets/docs.js" defer></script>
</head>
<body ${bodyData}>
  <a class="skip-link" href="#main">${escapeHtml(labels.skip)}</a>
  ${headerHtml(lang, slug, prefix, labels)}
  <div class="docs-shell">
    <aside class="sidebar" id="docs-sidebar">
      <div class="sidebar-inner">
        <nav class="side-nav" aria-label="${escapeHtml(labels.docs)}">${navHtml(lang, slug, prefix, labels)}</nav>
        <div class="sidebar-foot"><span>${escapeHtml(labels.version)}</span><a href="${repoUrl}" rel="noreferrer">Apache-2.0 ↗</a></div>
      </div>
    </aside>
    <main id="main" class="docs-main${isHome ? ' is-home' : ''}">
      <div class="article-wrap">
        ${article}
        ${footer}
      </div>
      ${isHome ? '' : tocHtml(finalToc, labels)}
    </main>
  </div>
  ${mobileNavHtml(lang, slug, prefix, labels)}
  ${searchDialogHtml(labels)}
</body>
</html>`;
  return { html, searchEntries, outDir, pagePath };
}

function mobileNavHtml(lang, slug, prefix, labels) {
  return `<dialog class="mobile-nav" id="mobile-nav" aria-label="${escapeHtml(labels.menu)}">
  <div class="mobile-nav-panel">
    <div class="mobile-nav-head"><span class="brand"><img src="${prefix}assets/logo.svg" alt="" width="24" height="24"><span class="brand-name">unprompted</span><span class="brand-docs">${escapeHtml(labels.docs)}</span></span><button type="button" class="icon-button" data-menu-close aria-label="${escapeHtml(labels.close)}">×</button></div>
    <nav class="side-nav" aria-label="${escapeHtml(labels.docs)}">${navHtml(lang, slug, prefix, labels)}</nav>
    <div class="mobile-nav-foot"><a href="${prefix}${pageUrl(lang, 'quickstart')}">${escapeHtml(labels.getStarted)}</a><a href="${repoUrl}" rel="noreferrer">${escapeHtml(labels.github)} ↗</a></div>
  </div>
</dialog>`;
}

function searchDialogHtml(labels) {
  return `<dialog class="search-dialog" id="search-dialog" aria-labelledby="search-title">
  <div class="search-box">
    <h2 id="search-title" class="sr-only">${escapeHtml(labels.search)}</h2>
    <div class="search-input-row">
      <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18"><path d="m14.9 13.5 3.4 3.4M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <input id="search-input" type="search" placeholder="${escapeHtml(labels.searchPlaceholder)}" autocomplete="off" spellcheck="false" aria-controls="search-results">
      <button type="button" class="search-close" data-search-close aria-label="${escapeHtml(labels.close)}">Esc</button>
    </div>
    <p class="search-hint" id="search-hint">${escapeHtml(labels.searchHint)}</p>
    <div class="search-results" id="search-results" aria-live="polite"></div>
    <div class="search-foot"><span>${escapeHtml(labels.searchShortcut)}</span><span><kbd>↑</kbd><kbd>↓</kbd> · <kbd>Enter</kbd></span></div>
  </div>
</dialog>`;
}

function buildLanguage(lang, allPagesByLang) {
  const pages = flattenPages(lang);
  const pageData = [];
  for (const page of pages) {
    const file = path.join(contentRoot, lang, `${page.slug || 'index'}.md`);
    if (!fs.existsSync(file)) throw new Error(`Missing content file: ${file}`);
    const content = fs.readFileSync(file, 'utf8');
    const parsed = parseFrontmatter(content);
    const title = parsed.data.title || page.title;
    pageData.push({ ...page, title, description: parsed.data.description || '', file });
  }
  const searchEntries = [];
  for (const page of pageData) {
    const content = fs.readFileSync(page.file, 'utf8');
    const result = buildPage(lang, page, content, pageData);
    const outPath = path.join(root, result.outDir, 'index.html');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.html);
    searchEntries.push(...result.searchEntries);
  }
  fs.writeFileSync(path.join(root, `search-${lang}.json`), `${JSON.stringify(searchEntries)}\n`);
  return { pages: pageData, searchEntries };
}

function buildSitemap(results) {
  const urls = [];
  for (const lang of ['en', 'zh']) {
    for (const page of results[lang].pages) {
      const pathName = pageUrl(lang, page.slug);
      urls.push(`  <url><loc>${siteBase}${pathName}</loc></url>`);
    }
  }
  fs.writeFileSync(path.join(root, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
}

function main() {
  const results = {};
  for (const lang of ['en', 'zh']) results[lang] = buildLanguage(lang, results);
  buildSitemap(results);
  const pages = results.en.pages.length + results.zh.pages.length;
  console.log(`Built ${pages} documentation pages (${results.en.pages.length} en, ${results.zh.pages.length} zh).`);
  console.log(`Search: ${results.en.searchEntries.length} en entries, ${results.zh.searchEntries.length} zh entries.`);
}

main();
