import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, normalizeAppearance, appearanceTokens, contrastRatio, validColor } from '../public/appearance-model.js';

test('appearance preferences reject malformed styles and color injection', () => {
  assert.deepEqual(normalizeAppearance(null), { style: 'space', palette: 'mist', colors: PALETTES.mist });
  assert.equal(normalizeAppearance({ style: 'unknown', palette: 'constructor' }).palette, 'mist');
  assert.deepEqual(normalizeAppearance({ palette: 'custom', colors: ['red; background: url(test)'] }).colors, PALETTES.mist);
  assert.equal(validColor('#d3dff2'), true);
  assert.equal(validColor('#fff'), false);
  assert.equal(validColor('url(test)'), false);
});

test('saved custom colors normalize without changing the default palette', () => {
  const preference = normalizeAppearance({ style: 'compact', palette: 'custom', colors: ['#f6f7f1', '#b1b2ae', '#e1e9d2', '#879e72', '#243025'] });
  assert.equal(preference.style, 'compact');
  assert.equal(preference.colors[0], '#F6F7F1');
  assert.equal(PALETTES.mist[0], '#E7E8E4');
});

test('every palette and extreme custom choice retains readable content and actions in both modes', () => {
  const combinations = [...Object.entries(PALETTES).map(([palette, colors]) => ({ palette, colors })), ...['#000000', '#FFFFFF', '#777777', '#999999', '#333333', '#FF00FF'].map(color => ({ palette: 'custom', colors: Array(5).fill(color) })), { palette: 'custom', colors: ['#000000', '#999999', '#FFFFFF', '#FFFFFF', '#FFFFFF'] }];
  for (const preference of combinations) {
    for (const dark of [false, true]) {
      const tokens = appearanceTokens(preference, dark);
      for (const background of ['canvas', 'surface', 'surface-quiet', 'selected']) {
        assert.ok(contrastRatio(tokens.ink, tokens[background]) >= 4.5, `${JSON.stringify(preference)} ${dark} ink/${background}`);
        assert.ok(contrastRatio(tokens.muted, tokens[background]) >= 4.5, `${JSON.stringify(preference)} ${dark} muted/${background}`);
      }
      assert.ok(contrastRatio(tokens['action-ink'], tokens.green) >= 4.5);
      assert.ok(contrastRatio(tokens['sidebar-ink'], tokens.sidebar) >= 4.5);
      assert.ok(contrastRatio(tokens['sidebar-active-ink'], tokens['sidebar-active']) >= 4.5);
      for (const background of ['canvas', 'surface', 'surface-quiet', 'amber-light']) assert.ok(contrastRatio(tokens.amber, tokens[background]) >= 4.5);
      for (const background of ['canvas', 'surface', 'surface-quiet', 'error-light']) assert.ok(contrastRatio(tokens.error, tokens[background]) >= 4.5);
    }
  }
});
