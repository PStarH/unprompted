#!/usr/bin/env node
/**
 * Build the Unprompted docs site into website/docs/.
 *
 * The reading layout follows the Tailwind Plus Syntax documentation template
 * (sidebar groups, search, on-this-page, previous/next, mobile menu) and uses
 * the website's paper and green palette. Pages are static HTML so GitHub Pages
 * can serve them at /unprompted/docs/ with relative links.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const outRoot = path.join(repoRoot, 'website', 'docs');
const contentRoot = path.join(here, 'content');
const nav = JSON.parse(fs.readFileSync(path.join(here, 'nav.json'), 'utf8'));
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version || '0.3.0';
const origin = 'https://pstarh.github.io/unprompted/docs/';
const repo = 'https://github.com/PStarH/unprompted';

const escapeHtml = value => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

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

const plain = value => String(value)
  .replace(/!\[[^\]]*]\([^)]*\)/g, '')
  .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/[`*_~]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: source };
  const data = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    data[key] = value;
  }
  return { data, body: source.slice(match[0].length) };
}

const flatPages = lang => nav[lang].groups.flatMap(group => group.links.map(link => ({ ...link, group: group.title })));
const depthOf = (lang, slug) => (lang === 'zh' ? 1 : 0) + (slug ? 1 : 0);
const docsPath = (lang, slug) => (lang === 'en' ? (slug ? `${slug}/` : '') : (slug ? `zh/${slug}/` : 'zh/'));
const up = depth => depth ? '../'.repeat(depth) : '';

function pageHref(depth, lang, slug, hash = '') {
  const target = docsPath(lang, slug);
  const base = target ? up(depth) + target : (up(depth) || './');
  return hash ? `${base}#${hash}` : base;
}

function resolveHref(raw, ctx) {
  if (/^(?:https?:|mailto:|#)/i.test(raw)) return raw;
  const [file, hash] = raw.split('#');
  if (file.endsWith('.md')) {
    const name = path.basename(file, '.md');
    const slug = name === 'index' ? '' : name;
    return pageHref(ctx.depth, ctx.lang, slug, hash || '');
  }
  if (raw.startsWith('../../../docs/assets/')) return up(ctx.depth) + 'assets/' + path.posix.basename(raw);
  if (raw.startsWith('assets/')) return up(ctx.depth) + raw;
  return raw;
}

function renderInline(text, ctx) {
  const codes = [];
  let value = escapeHtml(text);
  value = value.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  value = value.replace(/\[([^\]]+)]\(([^)\s]+)\)/g, (_, label, href) => {
    const url = resolveHref(href, ctx);
    const external = /^https?:/i.test(url);
    return `<a href="${escapeHtml(url)}"${external ? ' rel="noreferrer"' : ''}>${label}</a>`;
  });
  value = value.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return value.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

function renderMarkdown(source, ctx) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const html = [];
  const headings = [];
  const used = new Map();
  const text = [];
  let i = 0;
  const isBlock = line => /^(#{1,3}\s|```|>\s?|[-*]\s|\d+\.\s|\|)/.test(line);

  const heading = (level, raw) => {
    const label = plain(raw);
    let id = slugify(label);
    used.set(id, (used.get(id) || 0) + 1);
    if (used.get(id) > 1) id = `${id}-${used.get(id)}`;
    headings.push({ level, id, text: label });
    text.push(label);
    const anchor = `<a class="heading-link" href="#${id}" aria-label="${escapeHtml(ctx.headingLink || 'Link')}"><span aria-hidden="true">#</span></a>`;
    html.push(`<h${level} id="${id}">${renderInline(raw, ctx)}${anchor}</h${level}>`);
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i += 1;
      text.push(body.join(' '));
      const label = language ? `<span class="code-label">${escapeHtml(language)}</span>` : '';
      html.push(`<div class="code-block">${label}<pre><code>${escapeHtml(body.join('\n'))}</code></pre><button type="button" class="code-copy">${escapeHtml(ctx.copy)}</button></div>`);
      continue;
    }
    const headingMatch = /^(#{2,3})\s+(.+)$/.exec(line);
    if (headingMatch) { heading(headingMatch[1].length, headingMatch[2]); i += 1; continue; }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
      const head = cells(rows[0]);
      const bodyRows = rows.slice(2).map(cells);
      text.push(...head, ...bodyRows.flat());
      html.push(`<div class="table-wrap"><table><thead><tr>${head.map(cell => `<th>${renderInline(cell, ctx)}</th>`).join('')}</tr></thead><tbody>${bodyRows.map(row => `<tr>${row.map(cell => `<td>${renderInline(cell, ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i].replace(/^>\s?/, ''));
      i += 1;
      text.push(plain(quote.join(' ')));
      html.push(`<blockquote class="note">${quote.filter(item => item.trim()).map(item => `<p>${renderInline(item, ctx)}</p>`).join('')}</blockquote>`);
      continue;
    }
    if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) {
      const ordered = /^\d+\.\s/.test(line);
      const items = [];
      while (i < lines.length && (ordered ? /^\d+\.\s/.test(lines[i]) : /^[-*]\s/.test(lines[i]))) {
        items.push(lines[i].replace(ordered ? /^\d+\.\s/ : /^[-*]\s/, ''));
        i += 1;
      }
      text.push(...items.map(plain));
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map(item => `<li>${renderInline(item, ctx)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (line.startsWith('![')) {
      const match = /^!\[([^\]]*)]\(([^)\s]+)\)/.exec(line);
      if (match) {
        html.push(`<figure class="figure"><img src="${escapeHtml(resolveHref(match[2], ctx))}" alt="${escapeHtml(match[1])}" loading="lazy" decoding="async"><figcaption>${escapeHtml(match[1])}</figcaption></figure>`);
        i += 1;
        continue;
      }
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) paragraph.push(lines[i++]);
    text.push(plain(paragraph.join(' ')));
    html.push(`<p>${renderInline(paragraph.join(' '), ctx)}</p>`);
  }
  return { html: html.join('\n'), headings, text: text.join(' ') };
}

function navHtml(lang, current, depth) {
  return nav[lang].groups.map(group => `<section class="nav-section"><h2>${escapeHtml(group.title)}</h2><ul>${group.links.map(link => {
    const currentPage = link.slug === current;
    return `<li><a href="${pageHref(depth, lang, link.slug)}"${currentPage ? ' aria-current="page"' : ''}>${escapeHtml(link.title)}</a></li>`;
  }).join('')}</ul></section>`).join('');
}

function tocHtml(headings, label) {
  if (!headings.length) return { desktop: '', mobile: '' };
  const items = headings.filter(item => item.level === 2 || item.level === 3).map(item =>
    `<li><a class="${item.level === 3 ? 'toc-h3' : ''}" href="#${item.id}">${escapeHtml(item.text)}</a></li>`).join('');
  return {
    desktop: `<nav class="toc" aria-label="${escapeHtml(label)}"><h2>${escapeHtml(label)}</h2><ol>${items}</ol></nav>`,
    mobile: `<details class="mobile-toc"><summary>${escapeHtml(label)}</summary><ol>${items}</ol></details>`
  };
}

function agentMarkdown(body, lang) {
  return body.replace(/\]\(([^)\s]+)\)/g, (full, href) => {
    if (/^(?:https?:|mailto:|#)/i.test(href)) return full;
    const [file, hash] = href.split('#');
    const suffix = hash ? `#${hash}` : '';
    if (file.endsWith('.md')) {
      const name = path.basename(file, '.md');
      const slug = name === 'index' ? '' : name;
      return `](${origin}${docsPath(lang, slug)}${suffix})`;
    }
    if (href.startsWith('../../../docs/assets/')) return `](${origin}assets/${path.posix.basename(href)})`;
    if (href.startsWith('assets/')) return `](${origin}${href})`;
    return full;
  });
}

function crumbsHtml(lang, page, depth) {
  const labels = nav[lang].labels;
  const home = page.slug
    ? `<a href="${pageHref(depth, lang, '')}">${escapeHtml(labels.docs)}</a>`
    : `<span>${escapeHtml(labels.docs)}</span>`;
  const group = page.slug === '404' ? '' : `<span class="crumb-sep" aria-hidden="true">/</span><span>${escapeHtml(page.group)}</span>`;
  return `<nav class="crumbs" aria-label="${escapeHtml(labels.breadcrumb)}">${home}${group}<span class="crumb-sep" aria-hidden="true">/</span><span aria-current="page">${escapeHtml(page.title)}</span></nav>`;
}

function structuredData(lang, page, canonical) {
  const article = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: page.title,
    description: page.description,
    inLanguage: nav[lang].htmlLang,
    url: canonical,
    isPartOf: { '@type': 'WebSite', name: 'Unprompted', url: origin }
  };
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: nav[lang].labels.docs, item: origin + docsPath(lang, '') },
      { '@type': 'ListItem', position: 2, name: page.group || nav[lang].labels.docs },
      { '@type': 'ListItem', position: 3, name: page.title, item: canonical }
    ]
  };
  const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');
  return `<script type="application/ld+json">${json(article)}</script>\n  <script type="application/ld+json">${json(breadcrumb)}</script>`;
}

function pageShell({ lang, page, rendered, prev, next, markdown = '' }) {
  const labels = nav[lang].labels;
  const depth = depthOf(lang, page.slug === '404' ? '' : page.slug);
  const langSlug = page.slug === '404' ? '' : page.slug;
  const canonical = origin + docsPath(lang, langSlug);
  const enHref = origin + docsPath('en', langSlug);
  const zhHref = origin + docsPath('zh', langSlug);
  const asset = name => up(depth) + name;
  const missing = page.slug === '404';
  const feedbackTitle = `${lang === 'zh' ? '文档' : 'Docs'}: ${page.title}`;
  const feedbackBody = `${lang === 'zh' ? '页面' : 'Page'}: ${missing ? `${canonical}404.html` : canonical}\n\n${lang === 'zh' ? '问题' : 'What is wrong'}:\n\n`;
  const feedback = `${repo}/issues/new?title=${encodeURIComponent(feedbackTitle)}&body=${encodeURIComponent(feedbackBody)}`;
  const title = page.title;
  const documentTitle = `${page.title} · Unprompted ${labels.docs}`;
  const sourceLinks = markdown
    ? `<button type="button" data-copy-page>${escapeHtml(labels.copyPage)}</button><script type="application/json" id="page-markdown">${JSON.stringify(markdown).replaceAll('<', '\\u003c')}</script>`
    : '';
  const pager = `<nav class="pager" aria-label="${escapeHtml(labels.previous)}">${prev ? `<a href="${pageHref(depth, lang, prev.slug)}"><span>${escapeHtml(labels.previous)}</span><strong>${escapeHtml(prev.title)}</strong></a>` : '<span></span>'}${next ? `<a class="next" href="${pageHref(depth, lang, next.slug)}"><span>${escapeHtml(labels.next)}</span><strong>${escapeHtml(next.title)}</strong></a>` : ''}</nav>`;
  const toc = tocHtml(rendered.headings, labels.onThisPage);
  return `<!DOCTYPE html>
<html lang="${nav[lang].htmlLang}" data-lang="${lang}" data-root="${up(depth)}" data-copy="${escapeHtml(labels.copy)}" data-copied="${escapeHtml(labels.copied)}" data-no-results="${escapeHtml(labels.noResults)}" data-search-start="${escapeHtml(labels.searchStart)}" data-close="${escapeHtml(labels.close)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(documentTitle)}</title>
  <meta name="description" content="${escapeHtml(page.description)}">
  <link rel="canonical" href="${canonical}">
  <link rel="alternate" hreflang="en" href="${enHref}">
  <link rel="alternate" hreflang="zh-CN" href="${zhHref}">
  <link rel="alternate" hreflang="x-default" href="${enHref}">
  <meta property="og:title" content="${escapeHtml(documentTitle)}">
  <meta property="og:description" content="${escapeHtml(page.description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:type" content="article">
  <link rel="icon" href="${asset('assets/favicon.svg')}" type="image/svg+xml">
  <link rel="sitemap" type="application/xml" title="Sitemap" href="${asset('sitemap.xml')}">
  <link rel="stylesheet" href="${asset('assets/site.css')}">
  ${structuredData(lang, page, canonical)}
  <script>document.documentElement.classList.add('js')</script>
  <script src="${asset('assets/site.js')}" defer></script>
</head>
<body>
  <a class="skip" href="#main">${escapeHtml(labels.skip)}</a>
  <header class="header">
    <button class="menu-button" type="button" data-menu aria-expanded="false" aria-label="${escapeHtml(labels.menu)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    <a class="brand" href="${pageHref(depth, lang, '')}"><img src="${asset('assets/logo.svg')}" alt="" width="27" height="27"><span>unprompted</span><span class="brand-docs">${escapeHtml(labels.docs)}</span></a>
    <button class="search-button" type="button" data-search><span>${escapeHtml(labels.searchPlaceholder)}</span><kbd>${escapeHtml(labels.shortcut)}</kbd></button>
    <div class="header-tools">
      <button class="icon-button search-icon" type="button" data-search aria-label="${escapeHtml(labels.search)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg></button>
      <nav class="lang" aria-label="${escapeHtml(labels.language)}"><a href="${pageHref(depth, 'en', langSlug)}" hreflang="en"${lang === 'en' ? ' aria-current="true"' : ''}>EN</a><a href="${pageHref(depth, 'zh', langSlug)}" hreflang="zh-CN"${lang === 'zh' ? ' aria-current="true"' : ''}>中文</a></nav>
      <a class="quiet" href="${repo}" rel="noreferrer">GitHub</a>
    </div>
  </header>
  <details class="nav-fallback"><summary>${escapeHtml(labels.navSummary)}</summary>${navHtml(lang, page.slug, depth)}</details>
  <div class="shell">
    <aside class="sidebar">${navHtml(lang, page.slug, depth)}</aside>
    <main id="main" class="content">
      ${crumbsHtml(lang, page, depth)}
      <p class="page-kicker">${escapeHtml(page.group)}</p><h1 class="page-title">${escapeHtml(title)}</h1>
      ${toc.mobile}
      <article class="prose">${rendered.html}</article>
      <div class="page-meta">${sourceLinks}<a href="${escapeHtml(feedback)}" rel="noreferrer">${escapeHtml(labels.feedback)}</a><span>${escapeHtml(labels.versionLabel)} ${escapeHtml(version)} · ${escapeHtml(labels.updated)}</span></div>
      ${pager}
    </main>
    ${toc.desktop}
  </div>
  <footer class="page-footer"><a href="${up(depth)}../">${escapeHtml(labels.site)}</a><a href="${pageHref(depth, lang, '')}">${escapeHtml(labels.docs)}</a></footer>
  <div class="scrim"></div>
  <div class="drawer" role="dialog" aria-modal="true" aria-label="${escapeHtml(labels.menu)}">
    <div class="drawer-head"><strong>${escapeHtml(labels.docs)}</strong><button class="icon-button" type="button" data-menu-close aria-label="${escapeHtml(labels.close)}">×</button></div>
    ${navHtml(lang, page.slug, depth)}
  </div>
  <div class="search-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(labels.search)}">
    <div class="search-head"><strong>${escapeHtml(labels.search)}</strong><button class="icon-button" type="button" data-search-close aria-label="${escapeHtml(labels.close)}">×</button></div>
    <input type="search" placeholder="${escapeHtml(labels.searchPlaceholder)}" aria-label="${escapeHtml(labels.search)}">
    <p class="search-status">${escapeHtml(labels.searchStart)}</p>
    <ul class="search-list"></ul>
  </div>
</body>
</html>
`;
}

function notFound(lang) {
  const labels = nav[lang].labels;
  const depth = lang === 'zh' ? 1 : 0;
  const page = { slug: '404', title: labels.notFoundTitle, description: labels.notFoundBody, group: labels.docs, layout: '' };
  const rendered = { html: `<p>${escapeHtml(labels.notFoundBody)}</p><p><a href="${pageHref(depth, lang, '')}">${escapeHtml(labels.backHome)}</a></p>`, headings: [], text: labels.notFoundBody };
  return pageShell({ lang, page, rendered, prev: null, next: null });
}

const search = { en: [], zh: [] };
const sitemap = [];

for (const lang of ['en', 'zh']) {
  const pages = flatPages(lang);
  pages.forEach((page, index) => {
    const file = path.join(contentRoot, lang, `${page.slug || 'index'}.md`);
    const source = fs.readFileSync(file, 'utf8');
    const { data, body } = parseFrontmatter(source);
    const full = { ...page, title: data.title || page.title, description: data.description || page.title, layout: data.layout || '' };
    const rendered = renderMarkdown(body, { lang, depth: depthOf(lang, full.slug), copy: nav[lang].labels.copy, headingLink: nav[lang].labels.headingLink });
    const url = docsPath(lang, full.slug);
    const directory = path.join(outRoot, url);
    fs.mkdirSync(directory, { recursive: true });
    const markdown = `# ${full.title}\n\n> ${full.description}\n\n${agentMarkdown(body, lang).trim()}\n`;
    fs.writeFileSync(path.join(directory, 'index.html'), pageShell({
      lang,
      page: full,
      rendered,
      prev: pages[index - 1] || null,
      next: pages[index + 1] || null,
      markdown
    }));
    const markdownFile = path.join(directory, 'index.md');
    if (fs.existsSync(markdownFile)) fs.unlinkSync(markdownFile);
    search[lang].push({ title: full.title, url: url || './', section: full.group, text: rendered.text.slice(0, 700) });
    for (const heading of rendered.headings) {
      if (heading.level === 2) search[lang].push({ title: heading.text, url: `${url || './'}#${heading.id}`, section: full.title, text: '' });
    }
    sitemap.push(`  <url><loc>${origin}${url}</loc></url>`);
    console.log(`built ${lang}/${full.slug || 'index'}`);
  });
  const notFoundDir = lang === 'zh' ? path.join(outRoot, 'zh') : outRoot;
  fs.mkdirSync(notFoundDir, { recursive: true });
  fs.writeFileSync(path.join(notFoundDir, '404.html'), notFound(lang));
}

fs.mkdirSync(path.join(outRoot, 'assets'), { recursive: true });
for (const file of ['site.css', 'site.js']) {
  fs.copyFileSync(path.join(here, 'assets', file), path.join(outRoot, 'assets', file));
}
for (const file of ['logo.svg', 'favicon.svg', 'ui-work.png', 'ui-task.png']) {
  const fromWebsite = path.join(repoRoot, 'website', 'assets', file);
  const fromDocs = path.join(outRoot, 'assets', file);
  if (!fs.existsSync(fromDocs)) {
    const source = fs.existsSync(fromWebsite) ? fromWebsite : path.join(repoRoot, 'docs', 'assets', file);
    if (fs.existsSync(source)) fs.copyFileSync(source, fromDocs);
  }
}
fs.writeFileSync(path.join(outRoot, 'search-en.json'), JSON.stringify(search.en));
fs.writeFileSync(path.join(outRoot, 'search-zh.json'), JSON.stringify(search.zh));
fs.writeFileSync(path.join(outRoot, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemap.join('\n')}\n</urlset>\n`);
for (const file of ['llms.txt', 'llms-full.txt']) {
  const target = path.join(outRoot, file);
  if (fs.existsSync(target)) fs.unlinkSync(target);
}
console.log(`wrote ${sitemap.length} pages to website/docs`);
