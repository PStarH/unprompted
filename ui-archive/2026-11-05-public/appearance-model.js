export const APPEARANCE_KEY = 'unprompted:appearance';
export const COLOR_ROLES = ['canvas', 'neutral', 'selection', 'accent', 'ink'];
export const PALETTES = {
  mist: ['#E7E8E4', '#B1B2AE', '#D3DFF2', '#93A4C1', '#18202B'],
  sage: ['#F4F5EF', '#B2B9AC', '#E2ECCF', '#819678', '#1B3026'],
  sand: ['#F4F0E8', '#BEB3A2', '#E9DCC9', '#B29572', '#332D27'],
  graphite: ['#F2F2F0', '#B1B1AD', '#E0E0DD', '#8A8A86', '#252625']
};
export const DEFAULT_APPEARANCE = { style: 'space', palette: 'mist', colors: PALETTES.mist };

export function validColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export function normalizeAppearance(value) {
  const source = value && typeof value === 'object' ? value : {};
  const style = ['space', 'classic', 'compact'].includes(source.style) ? source.style : 'space';
  const palette = Object.hasOwn(PALETTES, source.palette) || source.palette === 'custom' ? source.palette : 'mist';
  const colors = palette !== 'custom' ? PALETTES[palette] : Array.isArray(source.colors) && source.colors.length === 5 && source.colors.every(validColor) ? source.colors.map(color => color.toUpperCase()) : PALETTES.mist;
  return { style, palette, colors: [...colors] };
}

function channels(color) {
  return [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16));
}

export function mixColor(first, second, proportion) {
  const other = channels(second);
  return '#' + channels(first).map((channel, index) => Math.round(channel * (1 - proportion) + other[index] * proportion).toString(16).padStart(2, '0')).join('');
}

function luminance(color) {
  return channels(color).map(channel => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  }).reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

export function contrastRatio(first, second) {
  const values = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function readableColor(color, backgrounds, minimum = 4.5) {
  if (backgrounds.every(background => contrastRatio(color, background) >= minimum)) return color;
  const target = ['#000000', '#ffffff'].sort((left, right) => Math.min(...backgrounds.map(background => contrastRatio(right, background))) - Math.min(...backgrounds.map(background => contrastRatio(left, background))))[0];
  for (let amount = 0.05; amount <= 1.001; amount += 0.05) {
    const candidate = mixColor(color, target, Math.min(amount, 1));
    if (backgrounds.every(background => contrastRatio(candidate, background) >= minimum)) return candidate;
  }
  return target;
}

export function appearanceTokens(preference, dark = false) {
  const [base, neutral, selection, accent, foreground] = normalizeAppearance(preference).colors;
  const canvas = dark ? mixColor(foreground, '#11151a', 0.82) : base;
  const lightBase = luminance(base) > 0.38;
  const surfaceTint = luminance(base) > 0.179 ? '#ffffff' : '#000000';
  const surface = dark ? mixColor(canvas, '#ffffff', 0.045) : mixColor(base, surfaceTint, lightBase ? 0.72 : 0.08);
  const quiet = dark ? mixColor(canvas, '#ffffff', 0.025) : mixColor(base, surfaceTint, lightBase ? 0.32 : 0.03);
  let selected = dark ? mixColor(canvas, selection, 0.17) : selection;
  const ink = readableColor(dark ? mixColor(base, '#ffffff', 0.72) : foreground, [canvas, surface, quiet]);
  for (let amount = 0; contrastRatio(ink, selected) < 4.5 && amount < 20; amount++) selected = mixColor(selected, canvas, 0.15);
  const muted = readableColor(mixColor(ink, neutral, 0.5), [canvas, surface, quiet, selected]);
  const action = readableColor(dark ? selection : mixColor(accent, foreground, 0.6), [canvas, surface, quiet]);
  const actionInk = readableColor(dark ? canvas : '#ffffff', [action]);
  const sidebar = dark ? mixColor(canvas, '#000000', 0.1) : mixColor(foreground, '#11151a', 0.12);
  const warningSurface = mixColor(surface, '#BE863F', 0.1);
  const errorSurface = mixColor(surface, '#B3483B', 0.08);
  return {
    canvas, surface, 'surface-quiet': quiet, ink, muted, 'muted-soft': muted,
    line: mixColor(canvas, ink, 0.14), 'line-strong': mixColor(canvas, ink, 0.28),
    green: action, 'green-strong': action, 'green-light': selected, selected, 'action-ink': actionInk,
    accent, lime: selection, hover: mixColor(surface, accent, dark ? 0.12 : 0.09),
    sidebar, 'sidebar-ink': readableColor('#F4F5F2', [sidebar]),
    'sidebar-muted': readableColor(neutral, [sidebar]), 'sidebar-line': mixColor(sidebar, '#ffffff', 0.15),
    'sidebar-active': selection, 'sidebar-active-ink': readableColor(foreground, [selection]),
    amber: readableColor(dark ? '#EDBC83' : '#8B4E19', [canvas, surface, quiet, warningSurface]), 'amber-light': warningSurface,
    error: readableColor(dark ? '#F3AA9F' : '#A23D32', [canvas, surface, quiet, errorSurface]), 'error-light': errorSurface
  };
}
