import { getLocale } from './i18n.js';
import { readLocal, writeLocal } from './ux-state.js';
import { APPEARANCE_KEY, PALETTES, COLOR_ROLES, DEFAULT_APPEARANCE, normalizeAppearance, validColor, appearanceTokens } from './appearance-model.js';

const text = (zh, en) => getLocale() === 'en' ? en : zh;

export function createAppearance({ icon }) {
  let preference = normalizeAppearance(readLocal(APPEARANCE_KEY));
  let theme = readLocal('unprompted:theme', 'system');
  if (!['system', 'light', 'dark'].includes(theme)) theme = 'system';
  let renderedLocale = null;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const host = document.getElementById('appearanceSettings');

  function apply() {
    const dark = theme === 'dark' || theme === 'system' && system.matches;
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.style = preference.style;
    root.dataset.palette = preference.palette;
    const tokens = appearanceTokens(preference, dark);
    for (const [name, color] of Object.entries(tokens)) root.style.setProperty(`--${name}`, color);
    document.querySelector('meta[name="theme-color"]').content = tokens.canvas;
    const toggle = document.getElementById('themeToggle');
    toggle.innerHTML = icon(dark ? 'sun' : 'moon');
    toggle.setAttribute('aria-label', dark ? text('切换浅色', 'Switch to light appearance') : text('切换深色', 'Switch to dark appearance'));
    toggle.title = toggle.getAttribute('aria-label');
    const select = document.getElementById('appearanceSelect');
    if (select) select.value = theme;
  }

  function render() {
    if (!host) return;
    renderedLocale = getLocale();
    const styles = [
      ['space', text('空间', 'Space'), text('窄导航，宽工作区', 'Icon rail, open workspace')],
      ['classic', text('经典', 'Classic'), text('文字导航，清晰分区', 'Labeled navigation, defined panels')],
      ['compact', text('紧凑', 'Compact'), text('收紧间距，保留可读性', 'Closer spacing, readable content')]
    ];
    const names = { mist: text('雾蓝 · 默认', 'Mist · default'), sage: text('苔绿', 'Sage'), sand: text('沙色', 'Sand'), graphite: text('石墨', 'Graphite') };
    const labels = [text('背景', 'Canvas'), text('中性色', 'Neutral'), text('选中状态', 'Selection'), text('强调色', 'Accent'), text('文字与导航', 'Ink & navigation')];
    host.innerHTML = `<div class="appearance-section-heading"><h2>${text('界面样式', 'Interface style')}</h2><span>${text('选择后即刻生效', 'Applies immediately')}</span></div>
      <div class="style-options" role="group" aria-label="${text('界面样式', 'Interface style')}">${styles.map(([id, label, description]) => `<button type="button" class="style-option" data-interface-style="${id}" aria-pressed="${preference.style === id}"><span class="style-thumbnail" data-preview-style="${id}" aria-hidden="true"><i></i><span><b></b><em></em><em></em><em></em><strong></strong></span></span><span class="style-option-label"><strong>${label}</strong><i>${preference.style === id ? '✓' : ''}</i></span><small>${description}</small></button>`).join('')}</div>
      <div class="appearance-section-heading"><h2>${text('配色', 'Color palette')}</h2><span>${text('深浅模式均可使用', 'Available in light and dark')}</span></div>
      <div class="palette-options" role="group" aria-label="${text('配色', 'Color palette')}">${Object.entries(PALETTES).map(([id, colors]) => `<button type="button" class="palette-option" data-palette="${id}" aria-pressed="${preference.palette === id}"><span class="palette-swatches" aria-hidden="true">${colors.map(color => `<i style="background:${color}"></i>`).join('')}</span><span>${names[id]}<b>${preference.palette === id ? '✓' : ''}</b></span></button>`).join('')}</div>
      <details class="custom-appearance" data-preserve="custom-appearance"${preference.palette === 'custom' ? ' open' : ''}><summary>${text('自定义五色', 'Custom colors')}${preference.palette === 'custom' ? ` · ${text('正在使用', 'active')}` : ''}</summary><form id="customColorsForm" novalidate><p>${text('选择五个基础色。文字和按钮会自动调整对比度，保持可读。', 'Choose five base colors. Text and buttons adapt to keep a readable contrast.')}</p><div class="custom-color-fields">${COLOR_ROLES.map((role, index) => `<label><span>${labels[index]}</span><span class="color-input-pair"><input type="color" data-color-picker="${role}" aria-label="${labels[index]}" value="${preference.colors[index]}"><input name="${role}" data-color-hex="${role}" value="${preference.colors[index]}" aria-label="${labels[index]} HEX" maxlength="7" required pattern="#[0-9a-fA-F]{6}" spellcheck="false" autocomplete="off"></span></label>`).join('')}</div><p class="appearance-error" id="appearanceError" role="alert" hidden></p><div class="appearance-form-actions"><button class="primary-button" type="submit">${text('应用自定义配色', 'Apply custom colors')}</button></div></form></details>
      <div class="appearance-reset"><span id="appearanceSaveStatus" role="status">${text('偏好保存在当前浏览器', 'Saved in this browser')}</span><button class="text-button" type="button" data-appearance-reset>${text('恢复默认外观', 'Restore defaults')}</button></div>`;
  }

  function save() {
    const stored = writeLocal(APPEARANCE_KEY, preference) && writeLocal('unprompted:theme', theme);
    apply();
    render();
    if (!stored) document.getElementById('appearanceSaveStatus').textContent = text('当前会话已应用；浏览器未允许保存', 'Applied for this session; browser storage is unavailable');
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.interfaceStyle) preference = { ...preference, style: button.dataset.interfaceStyle };
    else if (button.dataset.palette) preference = { ...preference, palette: button.dataset.palette, colors: [...PALETTES[button.dataset.palette]] };
    else if (button.hasAttribute('data-appearance-reset')) { preference = normalizeAppearance(DEFAULT_APPEARANCE); theme = 'system'; }
    else if (button.id === 'themeToggle') { theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; apply(); writeLocal('unprompted:theme', theme); return; }
    else return;
    const selector = button.dataset.interfaceStyle ? `[data-interface-style="${button.dataset.interfaceStyle}"]` : button.dataset.palette ? `[data-palette="${button.dataset.palette}"]` : '[data-appearance-reset]';
    save();
    host.querySelector(selector)?.focus({ preventScroll: true });
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'appearanceSelect') { theme = event.target.value; writeLocal('unprompted:theme', theme); apply(); }
  });
  host?.addEventListener('input', event => {
    const picker = event.target.dataset.colorPicker, hex = event.target.dataset.colorHex;
    if (picker) host.querySelector(`[data-color-hex="${picker}"]`).value = event.target.value.toUpperCase();
    if (hex && validColor(event.target.value)) host.querySelector(`[data-color-picker="${hex}"]`).value = event.target.value;
  });
  host?.addEventListener('submit', event => {
    if (event.target.id !== 'customColorsForm') return;
    event.preventDefault();
    const colors = COLOR_ROLES.map(role => event.target.elements[role].value.trim().toUpperCase());
    COLOR_ROLES.forEach((role, index) => event.target.elements[role].setAttribute('aria-invalid', String(!validColor(colors[index]))));
    if (!colors.every(validColor)) {
      const error = document.getElementById('appearanceError');
      error.hidden = false; error.textContent = text('请输入完整的 HEX 颜色，例如 #E7E8E4。', 'Enter a six-digit HEX color, such as #E7E8E4.'); return;
    }
    preference = { ...preference, palette: 'custom', colors };
    save();
    host.querySelector('#customColorsForm button[type="submit"]')?.focus({ preventScroll: true });
  });
  system.addEventListener('change', () => { if (theme === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (![APPEARANCE_KEY, 'unprompted:theme', null].includes(event.key)) return;
    preference = normalizeAppearance(readLocal(APPEARANCE_KEY));
    const stored = readLocal('unprompted:theme', 'system');
    theme = ['system', 'light', 'dark'].includes(stored) ? stored : 'system';
    apply();
    if (!host?.contains(document.activeElement)) render();
  });
  apply(); render();
  return { refresh() { apply(); if (renderedLocale !== getLocale()) render(); } };
}
