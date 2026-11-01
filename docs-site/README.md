# Documentation site

Bilingual documentation for Unprompted. The reading layout is adapted from the
Tailwind Plus **Syntax** template: grouped sidebar, keyboard search, an
on-this-page list, previous and next links, and a mobile menu. Colors and type
follow the public site in `website/`.

Sources live in this directory. `node docs-site/build.mjs` writes static HTML
to `website/docs/`, which GitHub Pages serves at `/unprompted/docs/` because
the Pages workflow publishes `website/`.

```sh
node docs-site/build.mjs
node docs-site/check-links.mjs
```

Preview the project path from the repository root:

```sh
python3 -m http.server 4173 --directory /tmp/unprompted-pages --bind 127.0.0.1
```

Create that preview root with a link named `unprompted` pointing at `website/`,
then open `http://127.0.0.1:4173/unprompted/docs/`. Serving `website/` directly
and opening `/docs/` uses the same relative links.

The pages describe the current source. They do not add product behavior.
The longer repository notes remain in `docs/`.

Each page has a breadcrumb, a heading link, a button that copies that page as
Markdown, and a link that opens a GitHub issue for that page. The build also
writes a sitemap.
