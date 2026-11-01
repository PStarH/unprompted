import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readdirSync(root).filter(file => file.endsWith('.html'));

test('every page and asset link resolves under a GitHub Pages project prefix', () => {
  const origin = 'https://example.github.io/unprompted/';
  for (const page of pages) {
    const html = readFileSync(resolve(root, page), 'utf8');
    for (const [, value] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = new URL(value, origin + page);
      if (url.origin !== new URL(origin).origin) {
        assert.equal(url.protocol, 'https:', `External link must use HTTPS: ${value}`);
        continue;
      }
      assert.ok(url.pathname.startsWith('/unprompted/'), `Link escapes repository prefix: ${page}: ${value}`);
      const file = resolve(root, decodeURIComponent(url.pathname.slice('/unprompted/'.length) || 'index.html'));
      assert.ok(!relative(root, file).startsWith('..'), `Link escapes website: ${value}`);
      assert.ok(existsSync(file), `Missing asset: ${page}: ${value}`);
      if (url.hash) {
        const target = readFileSync(file.endsWith('.html') ? file : resolve(file, 'index.html'), 'utf8');
        assert.ok(target.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `Missing anchor: ${page}: ${value}`);
      }
    }
  }
});

test('CSS assets are local and included in the deployable directory', () => {
  const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
  for (const [, asset] of css.matchAll(/url\(["']?([^\s"')]+)["']?\)/g)) {
    assert.ok(!asset.startsWith('/') && !asset.includes('://'), `Non-local CSS asset: ${asset}`);
    assert.ok(existsSync(resolve(root, asset)), `Missing CSS asset: ${asset}`);
  }
});

test('self-hosted animation distributions preserve their license notices', () => {
  for (const file of ['gsap.min.js', 'ScrollTrigger.min.js', 'ScrollToPlugin.min.js']) {
    const js = readFileSync(resolve(root, 'assets/vendor', file), 'utf8');
    assert.match(js.slice(0, 600), /@license/);
    assert.match(js.slice(0, 600), /gsap.com\/standard-license/);
    assert.ok(js.length > (file === 'ScrollToPlugin.min.js' ? 3000 : 10000), `Incomplete vendor download: ${file}`);
  }
});
