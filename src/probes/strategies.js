/**
 * Extraction strategies.
 *
 * A deliberately small, fixed set of bounded text operations. A probe names a
 * strategy; it can never supply code. This is what keeps model-proposed probes
 * safe: the model may choose *what* to look for, but only these functions ever
 * run, and each one is bounded by the caller's limits.
 *
 * Strength matters for the completion decision:
 *   direct      - the requested content is actually present
 *   indicative  - related words appear, which is not proof the content is there
 *
 * Only `direct` evidence can satisfy a criterion, so a weak keyword hit can
 * never by itself justify an outbound action.
 */

export const DEFAULT_BOUNDS = {
  maxLines: 4000,
  maxExcerpt: 320,
  minBodyChars: 24,
  maxMatches: 5
};

/**
 * Merge caller bounds over the safe defaults.
 *
 * This is a correctness requirement, not a convenience. A probe spec may carry a
 * partial `bounds` object (a model proposal, or a built-in spec built with
 * `{}`), and a missing bound used to be worse than useless:
 *
 *   - `Math.min(lines.length, undefined)` is `NaN`, so a loop bounded by it never
 *     ran and the strategy silently matched nothing;
 *   - `length < undefined` is `false`, so the minimum-body check silently passed.
 *
 * Either way the failure was invisible — the criterion just looked unsatisfied.
 * Normalising here means every entry point (a provider, a caller, a direct
 * strategy invocation through `runStrategies`) gets finite limits.
 */
export function normaliseBounds(bounds = {}) {
  const merged = { ...DEFAULT_BOUNDS, ...(bounds || {}) };
  for (const key of Object.keys(DEFAULT_BOUNDS)) {
    if (!Number.isFinite(merged[key]) || merged[key] <= 0) merged[key] = DEFAULT_BOUNDS[key];
  }
  return merged;
}

const DATE_PATTERN = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i;
const NUMBER_PATTERN = /\d/;
const HEADING_PATTERN = /^(#{1,6})\s*(.+)$/;
const BULLET_PATTERN = /^\s*(?:[-*•]|\d+[.)])\s+/;

const clip = (text, limit) => {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
};

const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Normalise any date the pattern accepts to `YYYY-MM-DD`, or null. */
function dateKey(raw) {
  const value = String(raw || '').trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return value;
  const dayFirst = value.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i);
  if (dayFirst) {
    const month = MONTH_INDEX[dayFirst[2].slice(0, 3).toLowerCase()];
    if (month) return `${dayFirst[3]}-${String(month).padStart(2, '0')}-${String(dayFirst[1]).padStart(2, '0')}`;
  }
  const monthFirst = value.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (monthFirst) {
    const month = MONTH_INDEX[monthFirst[1].slice(0, 3).toLowerCase()];
    if (month) return `${monthFirst[3]}-${String(month).padStart(2, '0')}-${String(monthFirst[2]).padStart(2, '0')}`;
  }
  return null;
}

const OLDER_PERIOD = /\b(?:last|previous|prior|earlier)\s+(?:month|week|year|quarter|period)\b/i;
const NEWER_PERIOD = /\b(?:this|current|latest|newest)\s+(?:month|week|year|quarter|period)\b/i;

/**
 * A comparable time key for one reported value, or null when the value is not
 * placed in time.
 *
 * Explicit dates are used first (the statement's own text, then — walking
 * upwards, bounded — the nearest date above it within the same section, which
 * is where "As of:" lines live). A relative period ("last month", "this
 * month") is the weaker fallback. Ordering words alone ("later notes say") are
 * deliberately *not* a time key: they do not date the value, so they cannot
 * turn an unresolved contradiction into a sequence.
 */
function timeKeyOf(text, lines, number) {
  const own = String(text || '').match(DATE_PATTERN);
  if (own) {
    const key = dateKey(own[1]);
    if (key) return { kind: 'date', key, label: key };
  }
  if (OLDER_PERIOD.test(text)) return { kind: 'relative', key: '0', label: 'an earlier period' };
  if (NEWER_PERIOD.test(text)) return { kind: 'relative', key: '1', label: 'the current period' };
  const index = lines.findIndex(line => line.number === number);
  if (index < 0) return null;
  for (let cursor = index - 1; cursor >= 0 && index - cursor <= 40; cursor -= 1) {
    const above = lines[cursor];
    const date = above.text.match(DATE_PATTERN);
    if (date) {
      const key = dateKey(date[1]);
      if (key) return { kind: 'date', key, label: key };
    }
    if (headingOf(above.text)) return null; // the entry's own section is exhausted
  }
  return null;
}

/**
 * Two values for the same label are not automatically a contradiction.
 *
 * A document that reports "5" as of one date and "7" as of a later date is
 * describing a change over time; reading the newer statement is not "picking
 * one of two values silently", because the older one is *explained* as older.
 * The rule stays strict about what counts as time evidence: every value must
 * carry its own date (or relative period), the moments must not all be the
 * same (same moment with different values is still a contradiction), and the
 * newest moment itself must be unambiguous (one value). Anything else returns
 * null and keeps the conflict.
 */
function reconcilesAsUpdate(entries, lines, label, bounds) {
  const keys = entries.map(entry => timeKeyOf(entry.text, lines, entry.line));
  if (keys.some(key => !key)) return null;
  const kinds = new Set(keys.map(key => key.kind));
  if (kinds.size > 1) return null; // explicit dates and relative periods cannot be ordered together
  const moments = [...new Set(keys.map(key => key.key))];
  if (moments.length < 2) return null; // all reported at the same moment: unresolved
  const newest = moments.sort().at(-1);
  const latest = entries.filter((entry, index) => keys[index].key === newest);
  const currentValues = [...new Set(latest.map(entry => entry.value.replace(/\s*\([^)]*\)\s*/g, ' ').trim()))];
  if (currentValues.length !== 1) return null; // the newest moment itself is ambiguous
  const older = entries.filter(entry => !latest.includes(entry));
  const latestKey = keys[entries.indexOf(latest[0])];
  // The earlier values are named, not discarded: the evidence says what was
  // superseded and when, so a reader can check the reading instead of trusting it.
  const olderText = older.map(entry => `“${entry.value}”`).slice(0, 2).join(', ');
  const more = older.length > 2 ? ` and ${older.length - 2} more` : '';
  return {
    matched: true,
    strength: 'direct',
    excerpt: clip(latest[0].text, bounds.maxExcerpt),
    locator: `line ${latest[0].line}`,
    // The newest explicit date travels with the hit so the freshness mechanism
    // can use it, exactly as a dated_reference hit would.
    date: latestKey.kind === 'date' ? newest : null,
    detail: `“${label}” is reported for different moments; the most recent is “${currentValues[0]}” (${latestKey.label}), superseding ${olderText}${more}.`,
    matchedKeyword: latest[0].keyword,
    superseded: older.map(entry => ({ value: entry.value, at: keys[entries.indexOf(entry)].label, line: entry.line }))
  };
}

/** A line that looks like a heading rather than prose. */
function headingOf(line) {
  const markdown = line.match(HEADING_PATTERN);
  if (markdown) return { level: markdown[1].length, title: markdown[2].trim() };
  const plain = line.trim();
  // A plain heading is a short title. "Incident count: 14" is a labelled value,
  // not a heading, so reject anything carrying an inline value.
  if (plain.length > 64 || /[.!?]$/.test(plain)) return null;
  if (/:\s*\S/.test(plain)) return null;
  if (!/^[A-Z0-9]/.test(plain)) return null;
  if (plain.split(/\s+/).length > 6) return null;
  return { level: 3, title: plain.replace(/:$/, '') };
}

const URL_TOKENS = new Set(['http', 'https', 'www']);

function keywordHit(line, keywords) {
  const lower = line.toLowerCase();
  return keywords.find(keyword => {
    const term = String(keyword || '').toLowerCase();
    // A URL scheme is not the requested content. "https" plus a digit used to
    // look like a labelled figure and prepare a reply from a newsletter link.
    return term.length > 2 && !URL_TOKENS.has(term) && lower.includes(term);
  }) || null;
}

/** Prefer the longest matching keyword so "incident count" beats "incident". */
function longestKeywordHit(line, keywords) {
  const lower = line.toLowerCase();
  let best = null;
  for (const keyword of keywords || []) {
    const term = String(keyword || '').toLowerCase();
    if (term.length <= 2 || URL_TOKENS.has(term) || !lower.includes(term)) continue;
    if (!best || term.length > best.length) best = term;
  }
  return best;
}

/**
 * Distinguishing words carried by the spec.
 *
 * Some concepts are matched through a single broad word ("results", "figures",
 * "numbers"). When the request said more than that ("revenue figures", "results
 * of the pilot evaluation"), content that matches only the broad word is not the
 * requested content. Strategies keep scanning past such a candidate so a later,
 * genuinely relevant line or section can still match; if nothing qualifies, the
 * first rejected candidate is returned instead of `null`. That distinction
 * matters: "related content exists but not this" is reported as `unknown` with
 * an explanation, which is more honest than "nothing found".
 */
function requiredAnyTerms(prepared = {}) {
  return (prepared.requiredAny || [])
    .map(term => String(term).toLowerCase().trim())
    .filter(term => term.length > 0);
}

function passesRequiredAny(text, required) {
  if (!required.length) return true;
  const lower = String(text || '').toLowerCase();
  return required.some(term => lower.includes(term));
}

/**
 * Split "Control: 12.0% activation" into its label and its reported value.
 *
 * An explicit `label: value` line is the strongest claim shape. Comparing whole
 * labels ("control" vs "control group size") keeps two genuinely different
 * facts about the same thing from being mistaken for a contradiction.
 */
function labelledClaim(text) {
  const match = String(text || '').match(/^\s*([^:]{1,60}):\s*(\S.*)$/);
  if (!match) return null;
  const label = match[1].toLowerCase().replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
  const value = match[2].toLowerCase().replace(/\s+/g, ' ').replace(/[.;]+$/, '').trim();
  return label && value ? { label, value } : null;
}

const FIGURE = String.raw`\d[\d,]*(?:\.\d+)?(?:\s*%|\s*[a-z]+)?`;

/**
 * A prose claim such as "the incident count is 9" or "14 incidents".
 *
 * Only a clear relation between the concept words and a figure counts. A line
 * that merely mentions both is not enough. The label is the longest matching
 * keyword, so related but different phrases stay distinct.
 */
function proseClaim(text, keyword) {
  if (!keyword) return null;
  const escaped = String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\b${escaped}\\b\\s*(?:is|was|were|equals?|=)\\s*(${FIGURE})\\b`, 'i'),
    new RegExp(`\\b${escaped}\\b\\s+of\\s+(${FIGURE})\\b`, 'i'),
    new RegExp(`\\b(${FIGURE})\\s+${escaped}\\b`, 'i')
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (!match) continue;
    const value = match[1].toLowerCase().replace(/\s+/g, ' ').trim();
    if (!value) continue;
    return { label: String(keyword).toLowerCase(), value };
  }
  return null;
}

/**
 * A line that names the concept and carries a figure.
 * Covers "Incident count: 14", "the incident count is 9", "14 incidents".
 *
 * When the same label is reported with two different values, the first is *not*
 * silently taken. The hit carries a `conflict` describing both, which the
 * assessor turns into a `conflicting` criterion. Choosing one of two figures a
 * document states for the same thing would be fabricating a fact.
 */
function labelledValue(lines, keywords, bounds, prepared = {}) {
  const required = requiredAnyTerms(prepared);
  let first = null;
  let rejected = null;
  const byLabel = new Map();
  for (const { text, number } of lines) {
    const hit = keywordHit(text, keywords);
    if (!hit) continue;
    if (!NUMBER_PATTERN.test(text)) continue;
    const candidate = {
      matched: true,
      strength: 'direct',
      excerpt: clip(text, bounds.maxExcerpt),
      locator: `line ${number}`,
      detail: `Found a figure reported for “${hit}”.`,
      matchedKeyword: hit
    };
    if (!passesRequiredAny(text, required)) {
      if (!rejected) rejected = { ...candidate, fallback: true };
      continue;
    }
    if (!first) first = candidate;
    const claim = labelledClaim(text) || proseClaim(text, longestKeywordHit(text, keywords) || hit);
    if (!claim) continue;
    if (!byLabel.has(claim.label)) byLabel.set(claim.label, []);
    byLabel.get(claim.label).push({ ...claim, line: number, text: clip(text, bounds.maxExcerpt), keyword: hit });
  }

  for (const [label, entries] of byLabel) {
    const values = [...new Set(entries.map(entry => entry.value))];
    if (values.length < 2) continue;
    const reconciled = reconcilesAsUpdate(entries, lines, label, bounds);
    if (reconciled) return reconciled;
    return {
      matched: true,
      strength: 'direct',
      excerpt: clip(entries.map(entry => entry.text).join(' | '), bounds.maxExcerpt),
      locator: entries.map(entry => `line ${entry.line}`).join(', '),
      detail: `“${label}” is reported with different values: ${values.map(value => `“${value}”`).join(' and ')}.`,
      matchedKeyword: entries[0].keyword,
      conflict: { label, values, entries }
    };
  }

  return first || rejected;
}

/** A line that names the concept and carries a date. */
function datedReference(lines, keywords, bounds, prepared = {}) {
  const required = requiredAnyTerms(prepared);
  let rejected = null;
  for (const { text, number } of lines) {
    const hit = keywordHit(text, keywords);
    const date = text.match(DATE_PATTERN);
    if (!hit || !date) continue;
    const candidate = {
      matched: true,
      strength: 'direct',
      excerpt: clip(text, bounds.maxExcerpt),
      locator: `line ${number}`,
      detail: `Found a dated reference for “${hit}”: ${date[1]}.`,
      matchedKeyword: hit,
      date: date[1]
    };
    if (!passesRequiredAny(text, required)) {
      if (!rejected) rejected = { ...candidate, fallback: true };
      continue;
    }
    return candidate;
  }
  return rejected;
}

/** Compare heading and document titles ignoring decoration and case. */
const titleKey = value => String(value || '').toLowerCase().replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();

/**
 * A heading that names the concept and is followed by substantive content.
 *
 * The document's own title is never a section. A request names its deliverable,
 * so the deliverable's title will match the request's words whether or not the
 * document contains anything about them: accepting it would let a document
 * satisfy a criterion on its title alone, with the entire body attached as
 * evidence. That is a wrong-evidence path, not a lenient one.
 */
function sectionBody(text, keywords, bounds, prepared = {}) {
  const required = requiredAnyTerms(prepared);
  let rejected = null;
  const lines = String(text || '').split('\n');
  const documentTitle = titleKey(prepared.title);
  for (let index = 0; index < Math.min(lines.length, bounds.maxLines); index += 1) {
    const heading = headingOf(lines[index]);
    if (!heading) continue;
    if (documentTitle && titleKey(heading.title) === documentTitle) continue;
    const hit = keywordHit(heading.title, keywords);
    if (!hit) continue;
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = headingOf(lines[cursor]);
      if (next && next.level <= heading.level) break;
      body.push(lines[cursor]);
    }
    const joined = body.join('\n').trim();
    if (joined.replace(/\s+/g, '').length < bounds.minBodyChars) continue;
    const candidate = {
      matched: true,
      strength: 'direct',
      excerpt: clip(`${heading.title}: ${joined}`, bounds.maxExcerpt),
      locator: `line ${index + 1}`,
      detail: `Found a “${heading.title}” section for “${hit}”.`,
      matchedKeyword: hit,
      sectionTitle: heading.title
    };
    if (!passesRequiredAny(`${heading.title} ${joined}`, required)) {
      if (!rejected) rejected = { ...candidate, fallback: true };
      continue;
    }
    return candidate;
  }
  return rejected;
}

/** A quotation or bullet that names the concept. */
function quotedStatement(lines, keywords, bounds, prepared = {}) {
  const required = requiredAnyTerms(prepared);
  let rejected = null;
  for (const { text, number } of lines) {
    const hit = keywordHit(text, keywords);
    if (!hit) continue;
    const isQuote = /["“”]/.test(text) || /^\s*['‘’]/.test(text);
    const isBullet = BULLET_PATTERN.test(text);
    if (!isQuote && !isBullet) continue;
    const content = text.replace(BULLET_PATTERN, '').replace(/["“”'‘’]/g, '').trim();
    if (content.length < 12) continue;
    const candidate = {
      matched: true,
      strength: 'direct',
      excerpt: clip(text, bounds.maxExcerpt),
      locator: `line ${number}`,
      detail: `Found a quoted ${isBullet ? 'entry' : 'statement'} for “${hit}”.`,
      matchedKeyword: hit
    };
    if (!passesRequiredAny(text, required)) {
      if (!rejected) rejected = { ...candidate, fallback: true };
      continue;
    }
    return candidate;
  }
  return rejected;
}

/**
 * The concept's words appear, with some surrounding text.
 * Indicative only: a mention is not the content itself.
 */
function keywordPresence(lines, keywords, bounds, prepared = {}) {
  const required = requiredAnyTerms(prepared);
  let rejected = null;
  for (const { text, number } of lines) {
    const hit = keywordHit(text, keywords);
    if (!hit) continue;
    if (text.trim().length < Math.max(12, bounds.minBodyChars / 2)) continue;
    const candidate = {
      matched: true,
      strength: 'indicative',
      excerpt: clip(text, bounds.maxExcerpt),
      locator: `line ${number}`,
      detail: `Mention of “${hit}” only; this is not proof the content is present.`,
      matchedKeyword: hit
    };
    if (!passesRequiredAny(text, required)) {
      if (!rejected) rejected = { ...candidate, fallback: true };
      continue;
    }
    return candidate;
  }
  return rejected;
}

/**
 * An explicit statement that a set is fully covered.
 *
 * "Comments from all reviewers" is not satisfied by comments from *some*
 * reviewers, and the only thing a reader could verify is what the document
 * itself claims. So the coverage claim must sit next to the noun a person would
 * recognise: "all reviewers", "every reviewer", "all three reviewers", "a
 * complete set of reviewers". A stray "all" elsewhere on the line does not
 * count — "Reviewers checked all figures" is not a statement about reviewers.
 */
const COVERAGE_MARKER = 'all|every|each|both|complete(?: set of)?|entire(?: set of)?|full(?: set of)?';
const COVERAGE_COUNT = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';

function coverageStatement(text, keywords, bounds) {
  const terms = [...new Set((keywords || []).map(term => String(term).toLowerCase().trim()).filter(term => term.length > 2))];
  if (!terms.length) return null;
  const lines = String(text || '').split('\n');
  for (let index = 0; index < Math.min(lines.length, bounds.maxLines); index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    for (const term of terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b(?:${COVERAGE_MARKER})\\b\\s+(?:of\\s+)?(?:the\\s+)?(?:${COVERAGE_COUNT}\\s+)?${escaped}\\b`, 'i');
      if (!pattern.test(lower)) continue;
      return {
        matched: true,
        strength: 'direct',
        excerpt: clip(line, bounds.maxExcerpt),
        locator: `line ${index + 1}`,
        detail: `Found an explicit coverage statement for “${term}”.`,
        matchedKeyword: term
      };
    }
  }
  return null;
}

export const STRATEGIES = {
  labelled_value: { id: 'labelled_value', label: 'A labelled figure', strength: 'direct', input: 'lines', run: labelledValue },
  dated_reference: { id: 'dated_reference', label: 'A dated reference', strength: 'direct', input: 'lines', run: datedReference },
  section_body: { id: 'section_body', label: 'A section with content', strength: 'direct', input: 'raw', run: sectionBody },
  quoted_statement: { id: 'quoted_statement', label: 'A quotation or entry', strength: 'direct', input: 'lines', run: quotedStatement },
  coverage_statement: { id: 'coverage_statement', label: 'An explicit coverage statement', strength: 'direct', input: 'raw', run: coverageStatement },
  keyword_presence: { id: 'keyword_presence', label: 'A mention of the concept', strength: 'indicative', input: 'lines', run: keywordPresence }
};

export const STRATEGY_IDS = Object.keys(STRATEGIES);

export function isStrategy(id) {
  return Object.prototype.hasOwnProperty.call(STRATEGIES, id);
}

/**
 * Prepare the text once so each strategy does not re-split it.
 *
 * `context.title` is the document's own title. It is carried separately from the
 * line list because a section strategy needs to be able to tell a section
 * heading apart from the document's title.
 */
export function prepareText(text, bounds = {}, context = {}) {
  const limits = normaliseBounds(bounds);
  const lines = String(text || '').split('\n');
  const numbered = [];
  for (let index = 0; index < Math.min(lines.length, limits.maxLines); index += 1) {
    const line = lines[index].trim();
    if (line) numbered.push({ text: line, number: index + 1 });
  }
  return { raw: String(text || ''), lines: numbered, title: context.title ?? null, requiredAny: context.requiredAny ?? [] };
}

/**
 * Run the first strategy that matches, in the order the probe asked for.
 * Each strategy declares whether it needs raw text or prepared lines.
 *
 * A strategy result flagged `fallback` matched only the broad words of the
 * probe, not the distinguishing ones. It is kept rather than returned: a later
 * strategy may still find the content the request actually named (a bare
 * "Metrics: 12" line must not stop the search before a "Revenue figures"
 * section is seen). The first fallback is returned only when no strategy
 * qualifies, so the assessor still reports "related content exists but not
 * this" as `unknown` instead of "nothing found".
 *
 * `strategies` is untrusted input (it can come from a model proposal), so an
 * unknown id is skipped rather than throwing, and the bounds are normalised
 * before any strategy sees them.
 */
export function runStrategies(prepared, keywords, strategyIds, bounds = {}) {
  const limits = normaliseBounds(bounds);
  let fallback = null;
  for (const id of strategyIds || []) {
    const strategy = STRATEGIES[id];
    if (!strategy) continue;
    const input = strategy.input === 'raw' ? prepared.raw : prepared.lines;
    // `prepared` is passed through so a strategy can use document-level context
    // (the title) without every strategy having to declare it.
    const result = strategy.run(input, keywords, limits, prepared);
    if (!result?.matched) continue;
    // `fallback` is normalised to an explicit boolean on every hit, so the
    // assessor can tell "the search checked the distinguishing words and this
    // hit passed" from "the flag is absent" (e.g. built-in probes).
    const shaped = { ...result, strategy: id, strength: result.strength || strategy.strength, fallback: result.fallback === true };
    if (shaped.fallback) {
      if (!fallback) fallback = shaped;
      continue;
    }
    return shaped;
  }
  return fallback;
}

export const strategiesApi = { STRATEGIES, STRATEGY_IDS, DEFAULT_BOUNDS, normaliseBounds, isStrategy, prepareText, runStrategies, DATE_PATTERN, coverageStatement };
