import { resolveRequiredContent } from './criteria.js';
import { isVerbatimQuote } from './probes/lexicon.js';
import { unquotedMessageFields } from './commitments.js';

/**
 * Request interpretation.
 *
 * Turns an incoming message into a structured request: what was asked for, who
 * asked, by when, and which content the deliverable must contain. This is
 * deliberately not tied to one project name or one email template.
 *
 * Deterministic first. A model is only consulted when configured, and only to
 * fill gaps the deterministic pass could not resolve. If the model is
 * unavailable the deterministic result is used unchanged.
 */

const DELIVERABLE_NOUNS = [
  'proposal', 'report', 'deck', 'plan', 'memo', 'brief', 'summary', 'write-up', 'writeup',
  'spec', 'one-pager', 'presentation', 'analysis', 'document', 'doc', 'review', 'roadmap'
];
const CHINESE_DELIVERABLES = [
  ['presentation', ['演示文稿', '演示稿', '幻灯片']],
  ['proposal', ['提案', '方案']],
  ['report', ['报告', '報告']],
  ['plan', ['计划', '計劃']],
  ['memo', ['备忘录', '備忘錄']],
  ['brief', ['简报', '簡報']],
  ['summary', ['摘要', '总结', '總結']],
  ['spec', ['规格说明', '規格說明', '规范', '規範']],
  ['one-pager', ['一页纸', '一頁紙']],
  ['analysis', ['分析']],
  ['document', ['文档', '文件', '文檔']],
  ['review', ['评审', '審查', '复盘', '複盤']],
  ['roadmap', ['路线图', '路線圖']]
];
const UPDATE_VERBS = ['update', 'revise', 'refresh', 'edit', 'rework', 'finalize', 'finalise', 'incorporate', 'add', 'append', 'complete', 'finish', 'prepare'];
const SEND_VERBS = ['send', 'share', 'email', 'forward', 'deliver', 'return', 'circulate', 'hand over', 'submit'];
const CHINESE_UPDATE_VERB = /(?:更新|修订|修訂|修改|刷新|改版|补充|補充|添加|增加|加入|纳入|納入|完善|定稿|准备|準備|完成|整理|编写|編寫)/u;
const CHINESE_SEND_VERB = /(?:发送|發送|发给|發給|分享|提交|交付|递交|遞交|寄给|寄給)/u;
const CHINESE_DELIVERABLE_LOOKUP = new Map(CHINESE_DELIVERABLES.flatMap(([canonical, aliases]) => aliases.map(alias => [alias, canonical])));
const CHINESE_CONTENT_TERMS = [
  { pattern: /(?:最新|最近|当前|目前)?(?:实验|實驗)(?:结果|結果|数据|數據)/u, text: 'experiment results', freshness: true },
  { pattern: /(?:最新|最近|当前|目前)?(?:客户|客戶|用户|用戶)(?:反馈|回饋|意见|意見)/u, text: 'customer feedback', freshness: true },
  { pattern: /(?:样本量|樣本數|样本数|样本数量)/u, text: 'sample size' },
  { pattern: /(?:结论|結論)/u, text: 'conclusion' },
  { pattern: /(?:转化率|轉換率)/u, text: 'conversion rate' },
  { pattern: /(?:控制组|對照組|对照组)(?:结果|數據|数据)?/u, text: 'control result' },
  { pattern: /(?:处理组|實驗組|实验组)(?:结果|數據|数据)?/u, text: 'treatment result' }
];
const CHINESE_NEGATION = /(?:不需要|不必|无需|無需|不用|不要|别再|別再|请勿|請勿|不是要|并非要|並非要|不再需要|不再要求)/u;

const STOPWORDS = new Set([
  'hi', 'hello', 'hey', 'dear', 'thanks', 'thank', 'please', 'the', 'this', 'that', 'these', 'those',
  'i', 'we', 'you', 'your', 'our', 'my', 'me', 'us', 'it', 'its', 'and', 'or', 'but', 'for', 'with',
  'from', 'to', 'by', 'on', 'at', 'in', 'of', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'will',
  'would', 'could', 'should', 'can', 'may', 'need', 'needs', 'want', 'wants', 'latest', 'newest', 'recent',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'eod', 'eow', 'asap', 'european', 'north', 'south'
]);

/**
 * Words that are capitalised for grammatical reasons but never name an entity.
 *
 * A sentence commonly starts with a request verb — "Prepare a presentation",
 * "Send the brief" — and the old capitalised-run heuristic read that verb as the
 * project name. That is a fabricated identity, which is worse than declining the
 * request: every later correlation would be anchored to a word that names
 * nothing. These are filtered from *both* the title-adjacent run and the
 * frequency fallback. `email` is deliberately not here: "the Email review" is a
 * strange but real request whose only identity token is that word, and the
 * existing discovery tests pin that behaviour.
 */
const ENTITY_NOISE = new Set([
  'update', 'updated', 'updating', 'revise', 'revised', 'revising',
  'refresh', 'refreshed', 'refreshing', 'edit', 'edited', 'editing',
  'rework', 'reworked', 'reworking', 'finalize', 'finalise', 'finalized', 'finalised',
  'incorporate', 'incorporated', 'incorporating', 'add', 'added', 'adding',
  'append', 'appended', 'appendices', 'complete', 'completed', 'completing',
  'finish', 'finished', 'finishing', 'prepare', 'prepared', 'preparing',
  'send', 'sent', 'sending', 'share', 'shared', 'sharing', 'forward', 'forwarded',
  'deliver', 'delivered', 'delivering', 'return', 'returned', 'circulate', 'circulated',
  'submit', 'submitted', 'submitting', 'work', 'works', 'request', 'requests',
  'task', 'tasks', 'meeting', 'meetings', 'notes', 'note', 'draft', 'status',
  'weekly', 'daily', 'monthly', 'quarterly', 'hello', 'hi', 'dear', 'thanks', 'thank',
  'regards', 'subject', 're', 'fwd', 'fw'
]);

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Senders that never ask a person to produce a deliverable.
 *
 * This is a correctness gate, not a taste filter. Newsletters, product
 * announcements and automated account notices are written in the declarative and
 * happen to contain request-shaped words ("update", "share", "review"), which is
 * exactly how a naive extractor manufactures work that nobody asked for. The
 * That failure mode is important, so the sender is checked before
 * any wording is interpreted.
 */
const AUTOMATED_SENDER = new RegExp(
  '^(' +
  'no-?reply|do-?not-?reply|donotreply|' +
  'notifications?|notification|' +
  'news|newsletter|digest|' +
  'alerts?|updates|mailer-daemon|postmaster|bounce|' +
  'marketing|promotions?|campaign|' +
  'githubeducation|' +
  'noreply-[a-z-]+' +
  ')(\\+|@|$)', 'i'
);

export function isAutomatedSender(from) {
  const address = String(from || '').toLowerCase();
  const match = address.match(/<([^>]+)>/);
  const email = (match ? match[1] : address).trim();
  const local = email.split('@')[0] || '';
  if (!local) return false;
  if (AUTOMATED_SENDER.test(local)) return true;
  // A display name that announces itself as a feed is also not a person.
  return /\b(newsletter|notifications?|digest|no-?reply)\b/i.test(address.replace(email, ''));
}

/**
 * A person asking for work uses an imperative or a direct request. Marketing and
 * notification copy does not, even when it contains "update" or "share".
 */
const REQUEST_FORM = /\b(please|kindly|could you|can you|would you|will you|i need|i'?d like|i would like|we need|we'?d like|make sure|don'?t forget|remember to|let'?s|go ahead and)\b/i;

export function hasRequestForm(text) {
  const source = String(text || '').normalize('NFKC');
  const englishActions = [...source.matchAll(REQUEST_VERB_PATTERN_GLOBAL)];
  const chineseActions = [...source.matchAll(new RegExp(`${CHINESE_UPDATE_VERB.source}|${CHINESE_SEND_VERB.source}`, 'gu'))];
  const segmentFor = index => {
    const separators = /[\r\n,.!?，、。！？；;]/g;
    let start = 0;
    let end = source.length;
    for (const match of source.matchAll(separators)) {
      if (match.index < index) start = match.index + match[0].length;
      else { end = match.index; break; }
    }
    return { start, end, text: source.slice(start, end) };
  };
  const inheritsEnglishNegation = (match, actions) => {
    const segment = segmentFor(match.index);
    const segmentActions = actions.filter(item => item.index >= segment.start && item.index < segment.end);
    const firstAction = segmentActions[0];
    if (!firstAction || firstAction.index === match.index) return false;
    const beforeFirst = source.slice(segment.start, firstAction.index);
    const negatedFirst = /(?:\bdo\s+not|\bdon['’]?t|\bshould\s+not|\bshouldn['’]?t|\bcannot|\bcan['’]?t)\s+(?:please\s+)?$/i.test(beforeFirst);
    if (!negatedFirst) return false;
    const betweenActions = source.slice(firstAction.index + firstAction[0].length, match.index);
    return /\b(?:and|or|nor)\b/i.test(betweenActions) && !/\bbut\b/i.test(betweenActions);
  };
  const positiveEnglish = englishActions.some(match => {
    const segment = segmentFor(match.index);
    const beforeAction = source.slice(segment.start, match.index);
    const negated = /(?:\bdo\s+not|\bdon['’]?t|\bnever|\bshould\s+not|\bshouldn['’]?t|\bcannot|\bcan['’]?t)\s+(?:please\s+)?$/i.test(beforeAction);
    return !negated && !inheritsEnglishNegation(match, englishActions) &&
      (REQUEST_FORM.test(segment.text) || /(?:请|請|麻烦|麻煩|帮我|幫我|需要|能否|可以|务必|務必)/u.test(segment.text));
  });
  const positiveChinese = chineseActions.some(match => {
    const segment = segmentFor(match.index);
    const beforeAction = source.slice(segment.start, match.index);
    return !CHINESE_NEGATION.test(beforeAction) &&
      (REQUEST_FORM.test(segment.text) || /(?:请|請|麻烦|麻煩|帮我|幫我|请帮|請幫|需要|能否|可以|务必|務必)/u.test(segment.text));
  });
  if ((englishActions.length || chineseActions.length) && !positiveEnglish && !positiveChinese) return false;
  if (CHINESE_NEGATION.test(source) && !positiveChinese) return false;
  return REQUEST_FORM.test(source) || /(?:请|請|麻烦|麻煩|帮我|幫我|请帮|請幫|需要|能否|可以|务必|務必)/u.test(source);
}

/**
 * The deliverable must actually be the object of the request: introduced by a
 * determiner and preceded by a request verb in the same neighbourhood.
 *
 * Without this, a phrase like "Hey there, v0.14.7 is out" yields "there" as a
 * deliverable and "Update" in a subject line yields an update request.
 */
const DETERMINER_BEFORE = /(?:^|[\s(\[“"'])(?:the|our|your|a|an|its|their|this)\s+(?:[\w'’-]+\s+){0,4}$/i;

/**
 * Inflected forms of the request verbs.
 *
 * A bare `\bupdate\b` misses "updated", "updating" and "sends", which is how a
 * perfectly ordinary request ("I need the proposal updated by Friday") was being
 * read as informational. The forms are generated so the list cannot drift.
 */
function verbForms(verbs) {
  const forms = new Set(verbs);
  for (const verb of verbs) {
    if (/\s/.test(verb)) continue; // multi-word verbs are matched as written
    if (verb.endsWith('e')) {
      forms.add(`${verb}s`);
      forms.add(`${verb}d`);
      forms.add(`${verb.slice(0, -1)}ing`);
    } else if (/(?:s|x|z|ch|sh)$/.test(verb)) {
      forms.add(`${verb}es`);
      forms.add(`${verb}ed`);
      forms.add(`${verb}ing`);
    } else {
      forms.add(`${verb}s`);
      forms.add(`${verb}ed`);
      forms.add(`${verb}ing`);
    }
  }
  forms.add('sent'); // irregular past of send
  return [...forms].sort((a, b) => b.length - a.length);
}

const REQUEST_VERB_PATTERN = new RegExp(`\\b(?:${verbForms([...UPDATE_VERBS, ...SEND_VERBS]).join('|')})\\b`, 'i');
const REQUEST_VERB_PATTERN_GLOBAL = new RegExp(REQUEST_VERB_PATTERN.source, 'gi');

export function deliverableIsGoverned(text, deliverable) {
  if (!deliverable) return false;
  const source = String(text || '');
  if (deliverable.source === 'chinese') {
    const window = source.slice(Math.max(0, deliverable.index - 70), Math.min(source.length, deliverable.index + deliverable.length + 70));
    return hasRequestForm(window) && (CHINESE_UPDATE_VERB.test(window) || CHINESE_SEND_VERB.test(window));
  }
  const before = source.slice(Math.max(0, deliverable.index - 80), deliverable.index);
  if (!DETERMINER_BEFORE.test(before)) return false;
  // The verb may follow the noun too: "I need the proposal updated by Friday".
  const window = source.slice(
    Math.max(0, deliverable.index - 140),
    Math.min(source.length, deliverable.index + deliverable.length + 140)
  );
  return REQUEST_VERB_PATTERN.test(window);
}

/**
 * Find the deliverable noun the request is actually about.
 *
 * Every occurrence of every known noun is a candidate, and the candidates are
 * ranked rather than taking the first hit: a subject line ("Northstar proposal —
 * experiment results") names the deliverable without a determiner, while the
 * sentence that actually asks for work says "update the Northstar project
 * proposal". Preferring the governed occurrence is what makes the discovery gate
 * meaningful instead of rejecting real requests.
 */
function findDeliverable(text) {
  const lower = text.toLowerCase();
  const candidates = [];
  const wholeWord = (index, length) => {
    const before = lower[index - 1];
    const after = lower[index + length];
    return (!before || !/[a-z0-9]/.test(before)) && (!after || !/[a-z0-9]/.test(after));
  };

  for (const noun of DELIVERABLE_NOUNS) {
    let from = 0;
    while (candidates.length < 60) {
      const index = lower.indexOf(noun, from);
      if (index === -1) break;
      if (wholeWord(index, noun.length)) candidates.push({ noun, index, length: noun.length, source: 'known' });
      from = index + 1;
    }
  }

  const unicodeText = String(text || '').normalize('NFKC');
  for (const [canonical, aliases] of CHINESE_DELIVERABLES) {
    for (const alias of aliases) {
      let from = 0;
      while (candidates.length < 80) {
        const index = unicodeText.indexOf(alias, from);
        if (index === -1) break;
        candidates.push({ noun: canonical, index, length: alias.length, source: 'chinese' });
        from = index + alias.length;
      }
    }
  }

  // A deliverable noun outside the list is still a deliverable. After a request
  // verb, skip the article and any capitalised name, then take the first
  // lowercase noun: "update the Helios playbook" yields playbook.
  const verbs = REQUEST_VERB_PATTERN_GLOBAL;
  for (const verbMatch of text.matchAll(verbs)) {
    const rest = text.slice(verbMatch.index + verbMatch[0].length);
    const match = rest.match(/^\s+(?:me\s+)?(?:(?:the|our|a|an)\s+)?(?:(?:[A-Z][\w'-]*)\s+){0,3}([a-z][\w-]{2,20})\b/);
    if (!match) continue;
    const noun = match[1];
    if (STOPWORDS.has(noun)) continue;
    candidates.push({
      noun,
      index: verbMatch.index + verbMatch[0].length + match[0].length - noun.length,
      length: noun.length,
      source: 'derived'
    });
  }

  if (!candidates.length) return null;

  // Rank: governed by a determiner and a nearby request verb, then determined,
  // then earliest. Known nouns beat derived ones at equal rank.
  const ranked = candidates.map(candidate => ({
    ...candidate,
    governed: deliverableIsGoverned(text, candidate),
    determined: DETERMINER_BEFORE.test(text.slice(Math.max(0, candidate.index - 80), candidate.index)),
    known: candidate.source === 'known' || candidate.source === 'chinese' ? 1 : 0
  }));
  ranked.sort((a, b) =>
    (b.governed - a.governed) || (b.determined - a.determined) || (b.known - a.known) || (a.index - b.index));
  const best = ranked[0];
  return { noun: best.noun, index: best.index, length: best.length, source: best.source };
}

/** The last contiguous run of capitalised words in a fragment. */
function capitalisedRun(fragment) {
  const words = String(fragment || '').split(/\s+/).filter(Boolean);
  const runs = [];
  let current = [];
  for (const word of words) {
    if (/^[A-Z][\w'-]*$/.test(word) && !STOPWORDS.has(word.toLowerCase()) && !ENTITY_NOISE.has(word.toLowerCase())) {
      current.push(word);
    } else if (current.length) { runs.push(current); current = []; }
  }
  if (current.length) runs.push(current);
  return runs.length ? runs[runs.length - 1] : [];
}

function extractEntity(text, deliverable) {
  if (deliverable?.source === 'chinese') {
    const before = String(text || '').normalize('NFKC').slice(0, deliverable.index);
    const verbMatches = [...before.matchAll(new RegExp(`${CHINESE_UPDATE_VERB.source}|${CHINESE_SEND_VERB.source}`, 'gu'))];
    const verb = verbMatches.at(-1);
    if (verb) {
      let candidate = before.slice(verb.index + verb[0].length)
        .replace(/^(?:一下|一下子|把|将|將|的|我们|我們|你|我|请|請)+/u, '')
        .replace(/(?:项目|專案|專案的|项目的|的)$/u, '')
        .trim()
        .replace(/^[\s:：,，、-]+|[\s:：,，、-]+$/gu, '');
      if (candidate.length >= 2 && candidate.length <= 40 && !CHINESE_DELIVERABLE_LOOKUP.has(candidate)) return candidate;
    }
  }
  // 1. An explicit "project: X" or "the X project" declaration wins.
  const explicit = text.match(/\bproject\s*:\s*([A-Z][\w'-]{1,30})/) ||
    text.match(/\b(?:the\s+)?([A-Z][\w'-]{1,30})\s+project\b/) ||
    text.match(/\bfor\s+(?:the\s+)?([A-Z][\w'-]{1,30})\b(?!\s+(?:project|proposal|report)\b)/);
  if (explicit && !STOPWORDS.has(explicit[1].toLowerCase()) && !ENTITY_NOISE.has(explicit[1].toLowerCase())) {
    return explicit[1];
  }

  // 2. The capitalised words immediately preceding the deliverable noun. A
  //    multi-word name ("Nimbus Payments") is kept whole.
  if (deliverable) {
    const before = text.slice(Math.max(0, deliverable.index - 48), deliverable.index);
    const run = capitalisedRun(before);
    if (run.length) return run.join(' ');
  }

  // 3. Most frequent capitalised token that is not a stopword or a request verb.
  const counts = new Map();
  for (const word of text.match(/\b[A-Z][\w'-]{1,30}\b/g) || []) {
    const key = word.toLowerCase();
    if (STOPWORDS.has(key) || ENTITY_NOISE.has(key)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] || null;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const CHINESE_WEEKDAY_SUFFIX = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

/** Canonical readings of an explicitly configured numeric-date format. */
const DATE_LOCALES = {
  'MM/DD': 'MM/DD', 'MM-DD': 'MM/DD', 'M/D': 'MM/DD', 'MDY': 'MM/DD', 'MMDD': 'MM/DD', 'MONTH/DAY': 'MM/DD',
  'DD/MM': 'DD/MM', 'DD-MM': 'DD/MM', 'D/M': 'DD/MM', 'DMY': 'DD/MM', 'DDMM': 'DD/MM', 'DAY/MONTH': 'DD/MM'
};

/**
 * Canonicalise an explicitly configured numeric-date reading, or null.
 *
 * The configuration is always explicit — an environment value or a stated user
 * preference. Nothing here guesses a locale from the machine, an IP address,
 * or the text itself; an unknown value is treated as "not configured".
 */
export function normaliseDateLocale(value) {
  if (value == null) return null;
  const key = String(value).trim().toUpperCase().replace(/\s+/g, '');
  return DATE_LOCALES[key] || null;
}

function utcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoFromUtc(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function daysInUtcMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * A real calendar day, or null. Never rolls an impossible day into the next
 * month: 2026-02-31 does not become 2026-03-03, it is rejected.
 */
function realUtcDay(year, month, day) {
  if (!Number.isInteger(year) || month < 0 || month > 11 || day < 1 || day > daysInUtcMonth(year, month)) return null;
  return isoFromUtc(new Date(Date.UTC(year, month, day)));
}

/**
 * Month/day readings a numeric pair could have.
 *
 * Without a configured format both orders are possible. With one, only the
 * configured order is read — `13/1` under MM/DD is invalid rather than silently
 * flipped into day/month because only that order happens to parse.
 */
function numericReadings(first, second, dateLocale) {
  const candidates = dateLocale === 'MM/DD'
    ? [{ month: first, day: second, format: 'MM/DD' }]
    : dateLocale === 'DD/MM'
      ? [{ month: second, day: first, format: 'DD/MM' }]
      : [{ month: first, day: second, format: 'MM/DD' }, { month: second, day: first, format: 'DD/MM' }];
  const seen = new Set();
  const readings = [];
  for (const reading of candidates) {
    if (reading.month < 1 || reading.month > 12 || reading.day < 1 || reading.day > 31) continue;
    const key = `${reading.month}/${reading.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    readings.push(reading);
  }
  return readings;
}

/** A yearless month/day against the anchor day: this year, or next year when past. */
function resolveYearlessDay(month, day, anchor) {
  for (const year of [anchor.getUTCFullYear(), anchor.getUTCFullYear() + 1]) {
    const iso = realUtcDay(year, month - 1, day);
    if (!iso) continue;
    if (new Date(`${iso}T00:00:00.000Z`).getTime() < addUtcDays(anchor, -1).getTime()) continue;
    return iso;
  }
  return null;
}

/**
 * Parse a deadline phrase into a calendar day, honestly.
 *
 * Anchored to the request time (usually the email's receivedAt). Weekdays mean
 * the next occurrence on or after that day. This is a calendar rule, not a
 * guess about the sender's timezone or intent beyond the words they used.
 *
 * The result keeps ambiguity visible instead of resolving it silently:
 *
 *   resolved   - one real calendar day (`iso`)
 *   ambiguous  - several plausible days (`candidates`), because a numeric date
 *                has more than one real reading and no format is configured.
 *                The original phrase and the reason are kept. Nothing may treat
 *                it as a certain deadline.
 *   invalid    - the words name a day that does not exist (Feb 30, 2026-13-01).
 *                Rejected, never corrected into a nearby day.
 *   unresolved - recognised as a phrase but no day follows (never invented).
 */
export function parseDeadline(phrase, reference = new Date(), { dateLocale = null } = {}) {
  const locale = normaliseDateLocale(dateLocale);
  const unresolved = { status: 'unresolved', iso: null, kind: 'relative', candidates: [], readings: [], reason: null };
  if (!phrase) return unresolved;
  const text = String(phrase).replace(/\s+/g, ' ').trim().toLowerCase();
  const anchor = utcDay(reference instanceof Date ? reference : new Date(reference));
  if (Number.isNaN(anchor.getTime())) return unresolved;

  const resolvedDay = (iso, kind = 'relative_resolved') =>
    ({ status: 'resolved', iso, kind, candidates: [], readings: [], reason: null });
  const invalidDay = reason =>
    ({ status: 'invalid', iso: null, kind: 'invalid', candidates: [], readings: [], reason });
  const ambiguousDay = (readings) => {
    const detail = readings
      .map(reading => `${reading.iso} (${reading.format === 'MM/DD' ? 'month/day' : 'day/month'})`)
      .join(' or ');
    return {
      status: 'ambiguous', iso: null, kind: 'ambiguous',
      candidates: [...new Set(readings.map(reading => reading.iso))].sort(),
      readings: readings.map(reading => ({ iso: reading.iso, format: reading.format })),
      reason: `“${text}” could mean ${detail}, and no date format is configured.`
    };
  };

  const chinese = text.normalize('NFKC');
  if (/^(?:今天|今日|今晚|当天)$/.test(chinese)) return resolvedDay(isoFromUtc(anchor));
  if (/^(?:明天|明日)$/.test(chinese)) return resolvedDay(isoFromUtc(addUtcDays(anchor, 1)));
  const chineseWeekday = chinese.match(/^(?:(下周|下星期|本周|这周|這週|本星期))?(?:周|星期)?([一二三四五六日天])$/u);
  if (chineseWeekday) {
    if (!chineseWeekday[1] && !/^(?:周|星期)/u.test(chinese)) return unresolved;
    const wanted = CHINESE_WEEKDAY_SUFFIX[chineseWeekday[2]];
    const delta = (wanted - anchor.getUTCDay() + 7) % 7;
    const nextWeek = /^(?:下周|下星期)/u.test(chineseWeekday[1] || '');
    return resolvedDay(isoFromUtc(addUtcDays(anchor, nextWeek ? (delta || 7) + 7 : delta)));
  }
  const chineseMonthDay = chinese.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?$/u);
  if (chineseMonthDay) {
    const year = Number(chineseMonthDay[1] || anchor.getUTCFullYear());
    const month = Number(chineseMonthDay[2]);
    const day = Number(chineseMonthDay[3]);
    const iso = realUtcDay(year, month - 1, day);
    if (!iso) return invalidDay(`“${text}” is not a real calendar date.`);
    if (!chineseMonthDay[1] && new Date(`${iso}T00:00:00.000Z`) < addUtcDays(anchor, -1)) {
      const next = realUtcDay(year + 1, month - 1, day);
      return next ? resolvedDay(next) : invalidDay(`“${text}” is not a real calendar date.`);
    }
    return resolvedDay(iso, chineseMonthDay[1] ? 'explicit_date' : 'relative_resolved');
  }

  const finishReadings = (readings, kind) => {
    if (!readings.length) return invalidDay(`“${text}” is not a real calendar date.`);
    const days = [...new Set(readings.map(reading => reading.iso))];
    return days.length > 1 ? ambiguousDay(readings) : resolvedDay(days[0], kind);
  };

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    const iso = realUtcDay(year, month - 1, day);
    return iso ? resolvedDay(iso, 'explicit_date') : invalidDay(`“${text}” is not a real calendar date.`);
  }

  if (/^(today|tonight|eod|end of day)$/.test(text)) return resolvedDay(isoFromUtc(anchor));
  if (text === 'tomorrow') return resolvedDay(isoFromUtc(addUtcDays(anchor, 1)));
  if (/^(eow|end of week)$/.test(text)) {
    // Business end of week: Friday on or after the anchor.
    const day = anchor.getUTCDay(); // Sun=0
    const delta = (5 - day + 7) % 7;
    return resolvedDay(isoFromUtc(addUtcDays(anchor, delta)));
  }
  if (text === 'next week') return resolvedDay(isoFromUtc(addUtcDays(anchor, 7)));

  const weekday = text.match(/^(?:(?:this|next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (weekday) {
    const wanted = WEEKDAYS.indexOf(weekday[1]); // Mon=0 … Sun=6
    const jsWanted = (wanted + 1) % 7; // Sun=0 … Sat=6
    let delta = (jsWanted - anchor.getUTCDay() + 7) % 7;
    if (/^next\s+/i.test(text)) delta = delta || 7;
    return resolvedDay(isoFromUtc(addUtcDays(anchor, delta)));
  }

  const monthDay = text.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})$/i);
  if (monthDay) {
    const month = MONTHS[monthDay[1].toLowerCase().slice(0, 3)];
    const day = Number(monthDay[2]);
    const iso = resolveYearlessDay(month + 1, day, anchor);
    return iso ? resolvedDay(iso) : invalidDay(`“${text}” is not a real calendar date.`);
  }

  const bareNumeric = text.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (bareNumeric) {
    const readings = numericReadings(Number(bareNumeric[1]), Number(bareNumeric[2]), locale)
      .map(reading => ({ iso: resolveYearlessDay(reading.month, reading.day, anchor), format: reading.format }))
      .filter(reading => reading.iso);
    return finishReadings(readings);
  }

  const numericWithYear = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (numericWithYear) {
    let year = Number(numericWithYear[3]);
    if (year < 100) year += 2000;
    const readings = numericReadings(Number(numericWithYear[1]), Number(numericWithYear[2]), locale)
      .map(reading => ({ iso: realUtcDay(year, reading.month - 1, reading.day), format: reading.format }))
      .filter(reading => reading.iso);
    return finishReadings(readings, 'explicit_date');
  }

  return unresolved;
}

/**
 * The resolved calendar day for a phrase, or null.
 *
 * Null now covers three different situations — unresolved, ambiguous, and
 * invalid — so callers that must distinguish them use `parseDeadline`.
 */
export function resolveDeadlineIso(phrase, reference = new Date(), options = {}) {
  return parseDeadline(phrase, reference, options).iso;
}

export function extractDeadline(text, { now = new Date(), dateLocale = null } = {}) {
  const unicodeSource = String(text || '').normalize('NFKC');
  const chineseMatch = unicodeSource.match(/(?:截止(?:日期)?(?:是|为|在|到)?|最晚(?:在|于)?|不晚于|于|在|到|改到|改为|改成|延期至|推迟到)?\s*((?:(?:下周|下星期|本周|这周|這週|本星期)(?:周|星期)?|(?:周|星期))[一二三四五六日天]|(?:今天|今日|明天|明日|今晚)|(?:\d{4}年)?\d{1,2}月\d{1,2}日?)/u);
  if (chineseMatch) {
    const phrase = chineseMatch[1].trim();
    const reference = now instanceof Date ? now : new Date(now);
    const outcome = parseDeadline(phrase, reference, { dateLocale });
    const deadline = { text: phrase, iso: outcome.iso, kind: outcome.kind };
    if (outcome.status === 'ambiguous') Object.assign(deadline, { ambiguous: true, candidates: outcome.candidates, readings: outcome.readings, reason: outcome.reason });
    else if (outcome.status === 'invalid') deadline.reason = outcome.reason;
    return deadline;
  }
  const pattern = new RegExp(
    `\\b(?:deadline\\s+(?:is\\s+now|moved\\s+to|changed\\s+to|pushed\\s+to|shifted\\s+to|extended\\s+to)|due\\s+date\\s+(?:is\\s+now|moved\\s+to|changed\\s+to|pushed\\s+to|shifted\\s+to|extended\\s+to)|by|before|due(?:\\s+by)?|deadline\\s*[:\\s]|no\\s+later\\s+than)\\s+` +
    `(today|tomorrow|tonight|eod|end\\s+of\\s+day|end\\s+of\\s+week|eow|next\\s+week|` +
    `(?:(?:this|next)\\s+)?(?:${WEEKDAYS.join('|')})|` +
    `\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?|` +
    `(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\s+\\d{1,2})`,
    'i'
  );
  const match = text.match(pattern);
  if (!match) return null;
  const phrase = match[1].replace(/\s+/g, ' ').trim();
  const reference = now instanceof Date ? now : new Date(now);
  const outcome = parseDeadline(phrase, reference, { dateLocale });
  const deadline = { text: phrase, iso: outcome.iso, kind: outcome.kind };
  if (outcome.status === 'ambiguous') {
    deadline.ambiguous = true;
    deadline.candidates = outcome.candidates;
    deadline.readings = outcome.readings;
    deadline.reason = outcome.reason;
  } else if (outcome.status === 'invalid') {
    deadline.reason = outcome.reason;
  }
  return deadline;
}

/** Split a clause into candidate content noun phrases. */
function splitClauses(span) {
  return span
    .split(/,|;|\band\b|\bplus\b|\bas well as\b/i)
    .map(part => part.replace(/^(?:the|a|an|your|our|its|their)\s+/i, '').trim())
    .filter(Boolean);
}

function looksLikeContent(part) {
  const lower = part.toLowerCase();
  if (part.length > 70) return false;
  if (new RegExp(`\\b(${[...UPDATE_VERBS, ...SEND_VERBS].join('|')})\\b`, 'i').test(lower)) return false;
  if (/\b(?:by|before|due)\b/i.test(lower)) return false;
  if (WEEKDAYS.some(day => lower.includes(day))) return false;
  return /[a-z]/i.test(part);
}

/**
 * Phrases that name the recipient of a message rather than its content.
 *
 * "share it with the team" is a send instruction, not a requirement that the
 * document contain anything. Without this check the generic content markers
 * below would turn every "send it to X" into requested content.
 */
const RECIPIENT_PHRASES = new Set([
  'me', 'us', 'them', 'him', 'her', 'everyone', 'everybody', 'all',
  'the team', 'the group', 'the client', 'the customer', 'the board',
  'the leadership', 'the requester', 'the stakeholders', 'the relevant people'
]);

function isRecipientPhrase(part, markerId) {
  const lower = part.toLowerCase().replace(/[.!?]+$/, '').trim();
  if (RECIPIENT_PHRASES.has(lower)) return true;
  // After bare "with", a capitalised short name is almost always the person or
  // team the message goes to, not content the document must contain.
  if (markerId === 'with' && /^[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?$/.test(part.trim())) return true;
  return false;
}

/**
 * Content-introducing verb markers.
 *
 * These are grammatical relations, not task concepts: they say "the thing after
 * me is what the deliverable should contain", whatever that thing is. The
 * original extractor only understood "with" and "I need", so a request written
 * as "incorporating the latest customer feedback" or "using the most recent
 * incident statistics" yielded no verifiable requirement at all.
 */
const CONTENT_MARKERS = [
  { id: 'with', pattern: /\bwith\s+(?:the\s+)?([^.!?]+)/gi },
  {
    id: 'relation',
    pattern: /\b(?:incorporat(?:e|es|ed|ing)|includ(?:e|es|ed|ing)|contain(?:s|ed|ing)?|cover(?:s|ed|ing)?|reflect(?:s|ed|ing)?|us(?:e|es|ed|ing)|show(?:s|ed|ing)?|detail(?:s|ed|ing)?|featur(?:e|es|ed|ing)|summari[sz](?:e|es|ed|ing)|drawing\s+on|based\s+on|informed\s+by|built\s+from|prepared\s+from)\s+(?:the\s+)?([^.!?]+)/gi
  },
  {
    id: 'inclusion',
    pattern: /\b(?:to\s+include|that\s+includes?|which\s+includes?|must\s+(?:include|contain|cover|have)|needs?\s+to\s+(?:include|contain|cover|have)|should\s+(?:include|contain|cover)|has\s+to\s+(?:include|contain|cover|have)|will\s+(?:include|contain|cover))\s+(?:the\s+)?([^.!?]+)/gi
  }
];

const CONTENT_ANCHORS = [
  /\bI\s+(?:need|require|would\s+like|want)\s+([^.!?]+)/gi,
  /\bmake\s+sure\s+(?:it|the\s+\w+)?\s*(?:includes?|contains?|covers?|has)?\s*([^.!?]+)/gi,
  /\bmust\s+(?:include|contain|cover|have)\s+([^.!?]+)/gi,
  /\bneeds?\s+to\s+(?:include|contain|cover|have)\s+([^.!?]+)/gi
];

const STATUS_QUALIFIERS = new Set([
  'signed', 'unsigned', 'approved', 'unapproved', 'final', 'draft',
  'reviewed', 'unreviewed', 'verified', 'unverified',
  'authorised', 'authorized', 'endorsed', 'certified', 'ratified'
]);

const FRESHNESS_QUALIFIER = /\b(latest|newest|most\s+recent|up[- ]to[- ]date|current)\b/i;
const COMPLETENESS_COUNT = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
// "all reviewers", "every reviewer", "all three reviewers", "each of the
// signatories". The prefix may mix "of", "the" and a count in any order. The
// noun is one word — or two when the second is a real word ("customer
// regions") rather than a following conjunction ("reviewers and send").
const COMPLETENESS_QUALIFIER = new RegExp(
  `\\b(all|every|each)\\s+(?:(?:of|the|${COMPLETENESS_COUNT})\\s+){0,3}([a-z][\\w'-]{2,30}(?:\\s+[a-z][\\w'-]{3,30})?)\\b`, 'i'
);

/**
 * Nouns that never name a coverage set.
 *
 * "with all the details" is emphasis, not a requirement that the document
 * contain every detail in existence — treating it as coverage would withhold
 * every deliverable forever. Only a countable, named set ("all reviewers",
 * "every region", "each signatory") is a coverage requirement.
 */
const GENERIC_COVERAGE_NOUNS = new Set([
  'information', 'info', 'details', 'detail', 'stuff', 'things', 'content',
  'above', 'below', 'this', 'that', 'them', 'these', 'those', 'it', 'us'
]);

/**
 * "refresh it each week" is a cadence, not coverage of a set. Temporal words
 * are the one grammatical class where all/every/each does not quantify over
 * parts of the deliverable.
 */
const TEMPORAL_COVERAGE_NOUNS = new Set([
  'week', 'weeks', 'day', 'days', 'month', 'months', 'quarter', 'quarters',
  'year', 'years', 'sprint', 'sprints', 'time', 'hour', 'hours', 'minute',
  'minutes', 'morning', 'afternoon', 'evening', 'night', 'today', 'tomorrow'
]);

/**
 * "send it to all reviewers" is a send instruction, not a claim the document
 * must cover every reviewer. Only coverage phrased as content ("comments from
 * all reviewers", "reviewing all vendors") constrains the deliverable.
 */
const COVERAGE_RECIPIENT = /\b(?:to|for|cc)\s+(?:the\s+)?$/i;

function normaliseCoverageNoun(raw) {
  return String(raw || '').toLowerCase()
    .replace(/^(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+/, '')
    .trim();
}

/** Words that end a coverage phrase rather than extend the set's name. */
const COVERAGE_TRAILING_WORDS = new Set([
  'and', 'or', 'but', 'with', 'without', 'to', 'for', 'from', 'by', 'in', 'on', 'at',
  'of', 'as', 'that', 'which', 'who', 'when', 'where', 'while', 'after', 'before',
  'during', 'since', 'until', 'between', 'into', 'onto', 'out', 'up', 'down', 'it',
  'them', 'these', 'those', 'this', 'that', 'send', 'sends', 'sent', 'share', 'shares',
  'shared', 'update', 'updates', 'updated', 'include', 'includes', 'included', 'add',
  'adds', 'added', 'make', 'makes', 'made', 'prepare', 'prepares', 'prepared', 'file', 'files'
]);

/**
 * The coverage set a completeness match names, or null when it names none.
 * Returns the noun and the phrase text with any trailing function word removed,
 * so "all reviewers and send" records "all reviewers".
 */
function coverageSet(match) {
  if (!match) return null;
  const words = String(match[2] || '').split(/\s+/).filter(Boolean);
  const cleaned = words.length === 2 && COVERAGE_TRAILING_WORDS.has(words[1]) ? words.slice(0, 1) : words;
  const noun = normaliseCoverageNoun(cleaned.join(' '));
  if (!noun || GENERIC_COVERAGE_NOUNS.has(noun) || TEMPORAL_COVERAGE_NOUNS.has(noun)) return null;
  const text = (cleaned.length === words.length ? match[0] : match[0].replace(/\s+\S+$/, '')).toLowerCase().trim();
  return { noun, text };
}

/** Restrictions a phrase carries, in the vocabulary planning understands. */
function contentQualifiers(text) {
  const lower = String(text || '').toLowerCase();
  const found = [];
  for (const qualifier of STATUS_QUALIFIERS) {
    if (new RegExp(`\\b${qualifier}\\b`).test(lower)) found.push({ kind: 'status', text: qualifier });
  }
  if (FRESHNESS_QUALIFIER.test(lower)) found.push({ kind: 'freshness', text: lower.match(FRESHNESS_QUALIFIER)[0] });
  else {
    const chineseFreshness = String(text || '').match(/(?:最新|最近|当前|目前)/u);
    if (chineseFreshness) found.push({ kind: 'freshness', text: chineseFreshness[0] });
  }
  const set = coverageSet(lower.match(COMPLETENESS_QUALIFIER));
  if (set) found.push({ kind: 'completeness', text: set.text, noun: set.noun });
  return found;
}

/**
 * Request-level qualifiers.
 *
 * A qualifier restricts a requirement rather than naming content: "latest"
 * constrains freshness, "approved" constrains status, "all reviewers" constrains
 * coverage. They are kept with their own text so each one can be shown to come
 * from the request, and each one can become a criterion of the right kind.
 */
export function extractRequestQualifiers(text, deadline = null) {
  const source = String(text || '');
  const seen = new Set();
  const qualifiers = [];
  const add = qualifier => {
    const key = `${qualifier.kind}:${qualifier.text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    qualifiers.push(qualifier);
  };

  const freshness = source.match(FRESHNESS_QUALIFIER);
  if (freshness) add({ id: 'qualifier:freshness', kind: 'freshness', text: freshness[0].toLowerCase(), span: freshness[0] });
  else {
    const chineseFreshness = source.match(/(?:最新|最近|当前|目前)/u);
    if (chineseFreshness) add({ id: 'qualifier:freshness', kind: 'freshness', text: chineseFreshness[0], span: chineseFreshness[0] });
  }

  for (const qualifier of STATUS_QUALIFIERS) {
    const match = source.match(new RegExp(`\\b${qualifier}\\b`, 'i'));
    if (match) add({ id: `qualifier:${qualifier}`, kind: 'status', text: match[0].toLowerCase(), span: match[0] });
  }

  const completeness = source.match(COMPLETENESS_QUALIFIER);
  if (completeness) {
    const set = coverageSet(completeness);
    const before = source.slice(Math.max(0, completeness.index - 16), completeness.index);
    if (set && !COVERAGE_RECIPIENT.test(before)) {
      add({
        id: `qualifier:coverage:${set.noun.replace(/\s+/g, '-')}`,
        kind: 'completeness', text: set.text, noun: set.noun, span: set.text
      });
    }
  }

  if (deadline?.text) add({ id: 'qualifier:deadline', kind: 'deadline', text: deadline.text, iso: deadline.iso || null, span: deadline.text });
  return qualifiers;
}

export function extractRequiredContent(text, { deliverable = null } = {}) {
  const source = String(text || '');
  const spans = [];
  for (const anchor of CONTENT_ANCHORS) {
    for (const match of source.matchAll(anchor)) spans.push({ markerId: 'anchor', span: match[1] });
  }
  for (const marker of CONTENT_MARKERS) {
    for (const match of source.matchAll(marker.pattern)) spans.push({ markerId: marker.id, span: match[1] });
  }

  const found = [];
  const seen = new Set();
  const record = part => {
    const text = String(part || '').replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
    if (!text || !looksLikeContent(text)) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    // A longer phrase that contains an already-recorded one replaces it: the
    // request asked for "experiment results", not "experiment results" *and*
    // the full "latest experiment results".
    const covered = [...seen].filter(existing => key.includes(existing));
    if (covered.length) {
      for (const existing of covered) seen.delete(existing);
      for (let index = found.length - 1; index >= 0; index -= 1) {
        if (covered.includes(found[index].text.toLowerCase())) found.splice(index, 1);
      }
    } else if ([...seen].some(existing => existing.includes(key))) {
      return; // a longer phrase already covers this one
    }
    seen.add(key);
    found.push({ text, span: text, qualifiers: contentQualifiers(text) });
  };

  for (const { markerId, span } of spans) {
    for (const part of splitClauses(span)) {
      if (isRecipientPhrase(part, markerId)) continue;
      record(part);
    }
  }
  const unicodeSource = source.normalize('NFKC');
  for (const concept of CHINESE_CONTENT_TERMS) {
    const match = unicodeSource.match(concept.pattern);
    if (!match) continue;
    const key = concept.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      text: concept.text,
      span: match[0],
      sourceQuote: match[0],
      language: 'zh',
      grounding: 'built_in_lexicon',
      qualifiers: concept.freshness ? [{ kind: 'freshness', text: match[0] }] : []
    });
  }
  return found;
}

/**
 * The structured reading of a request: what outcome was asked for, which
 * criteria must hold, which qualifiers constrain them, and what cannot be
 * verified yet.
 *
 * This is deliberately descriptive. It does not decide completion — assessment
 * does that from evidence — and it never turns a qualifier into an assertion
 * that the qualifier's condition is met.
 */
export function analyseRequest({ text, deliverable, subjectEntity, intent, requiredContent, deadline = null, impliedClaims = [] }) {
  const source = String(text || '');
  const qualifiers = extractRequestQualifiers(source, deadline);
  const freshness = qualifiers.find(item => item.kind === 'freshness') || null;
  const coverage = qualifiers.filter(item => item.kind === 'completeness');

  const criteria = [];
  for (const [index, item] of (requiredContent || []).entries()) {
    const itemText = String(item.text || item);
    criteria.push({
      id: `content:${index + 1}:${slugFor(itemText)}`,
      kind: 'content',
      text: itemText,
      required: true,
      justification: itemText,
      qualifiers: item.qualifiers || contentQualifiers(itemText),
      // Which registered source types can speak to this criterion. Planning may
      // only execute providers on this list.
      sourceTypes: ['document_text']
    });
  }
  if (freshness) {
    criteria.push({
      id: 'freshness:latest', kind: 'freshness', text: freshness.text, required: false,
      justification: freshness.text, qualifiers: [], sourceTypes: ['run_registry', 'document_text']
    });
  }
  for (const qualifier of coverage) {
    criteria.push({
      id: `coverage:${slugFor(qualifier.noun || qualifier.text)}`,
      kind: 'coverage',
      text: qualifier.text,
      noun: qualifier.noun || null,
      required: true,
      justification: qualifier.text,
      qualifiers: [],
      sourceTypes: ['document_text']
    });
  }

  const unverifiable = [];
  if (!criteria.some(item => item.kind === 'content')) {
    unverifiable.push({
      id: 'no_requested_content',
      reason: 'The request names no specific content the deliverable must contain.',
      whatWouldResolveIt: 'State the content the deliverable should include, or add a source that can verify it.'
    });
  }

  return {
    expectedOutcome: {
      intent,
      deliverable,
      subjectEntity,
      deadline,
      description: `Update and send the ${subjectEntity} ${deliverable}.`.replace('Update and send', intent === 'send' ? 'Send' : intent === 'update' ? 'Update' : 'Update and send')
    },
    criteria,
    qualifiers,
    unverifiable,
    freshness: freshness ? { qualifier: freshness.text, required: false } : null,
    claims: (impliedClaims || []).map(item => item.id)
  };
}

function slugFor(value) {
  return String(value || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
}

function detectIntent(text) {
  const hasUpdate = new RegExp(`\\b(?:${verbForms(UPDATE_VERBS).join('|')})\\b`, 'i').test(text);
  const hasSend = new RegExp(`\\b(?:${verbForms(SEND_VERBS).join('|')})\\b`, 'i').test(text);
  const unicodeText = String(text || '').normalize('NFKC');
  const update = hasUpdate || CHINESE_UPDATE_VERB.test(unicodeText);
  const send = hasSend || CHINESE_SEND_VERB.test(unicodeText);
  if (update && send) return 'update_and_send';
  if (update) return 'update';
  if (send) return 'send';
  return 'informational';
}

/** Claims a request implicitly asks the system to be able to make. */
function impliedClaims(text) {
  const claims = [];
  if (/\b(latest|newest|most\s+recent|up[- ]to[- ]date|current)\b/i.test(text) || /(?:最新|最近|当前|目前)/u.test(String(text || '').normalize('NFKC'))) {
    claims.push({
      id: 'results_are_latest',
      text: 'The results in the deliverable are the most recent available.',
      forbiddenPattern: '\\b(latest|newest|most\\s+recent|up[- ]to[- ]date)\\b',
      requiresFreshness: true
    });
  }
  return claims;
}

/**
 * Interpret a message into a structured request.
 * Returns null when the message is not an actionable deliverable request, so the
 * caller can record it as context without inventing work.
 */
/**
 * Interpret a message, and say why it was *not* a request when it wasn't.
 *
 * Silence is not self-explanatory. If the user's real request is ignored, the
 * only way they can tell the product is working is by being able to see which
 * check declined it. Each rejection carries a stable code and a sentence a person
 * can act on; the codes are what the trace and the tests assert against.
 */
export function explainRequest(message, options = {}) {
  const active = unquotedMessageFields(message);
  const subject = active.subject;
  const body = active.body;
  const combined = `${subject}\n${body}`;
  const deliverable = findDeliverable(combined);
  const intent = detectIntent(combined);

  if (!deliverable) {
    return { request: null, rejection: { code: 'no_deliverable', detail: 'The message does not name a document, report or other deliverable.' } };
  }
  if (intent === 'informational') {
    return { request: null, rejection: { code: 'no_request_verb', detail: `It names a ${deliverable.noun} but does not ask for it to be updated or sent.` } };
  }

  // Discovery gates. A deliverable request comes from a person, in the
  // imperative, and the deliverable is the object of that request. Each gate is
  // deterministic: no model opinion can widen them.
  if (isAutomatedSender(message.from)) {
    return {
      request: null,
      rejection: {
        code: 'automated_sender',
        detail: `It came from an automated address (${String(message.from).slice(0, 60)}), which announces things rather than asking for work.`
      }
    };
  }
  if (!hasRequestForm(combined)) {
    return { request: null, rejection: { code: 'no_request_form', detail: 'It is not phrased as a request: nothing is asked of you.' } };
  }
  if (!deliverableIsGoverned(combined, deliverable)) {
    return {
      request: null,
      rejection: {
        code: 'deliverable_not_requested',
        detail: `It mentions “${deliverable.noun}” but not as the thing being asked for.`
      }
    };
  }

  const entity = extractEntity(combined, deliverable);
  if (!entity) {
    // Never guess which project a request refers to.
    return { request: null, rejection: { code: 'no_entity', detail: `It asks for a ${deliverable.noun} but does not say which project or entity it belongs to.` } };
  }

  const requiredContent = extractRequiredContent(combined);
  const link = combined.match(/https?:\/\/[^\s<>"')\]]+/i)?.[0] || null;
  const anchor = message.receivedAt || options.now || new Date();
  const deadline = extractDeadline(combined, { now: anchor, dateLocale: options.dateLocale });
  const claims = impliedClaims(combined);
  const request = {
    id: `request:${message.id}`,
    intent,
    deliverable: deliverable.noun,
    subjectEntity: entity,
    deadline,
    requiredContent,
    explicitDocumentUrl: link,
    impliedClaims: claims,
    // The full request text. Probes must be justifiable by a verbatim span of
    // this, and correlation matches document titles against it.
    text: combined,
    source: {
      kind: 'email',
      id: message.id,
      threadId: message.threadId || null,
      from: message.from,
      to: message.to || null,
      cc: message.cc || null,
      bcc: message.bcc || null,
      subject,
      receivedAt: message.receivedAt || null
    },
    interpretedBy: 'deterministic'
  };
  request.deliveryRecipients = extractDeliveryRecipients(message);
  request.analysis = analyseRequest({
    text: combined, deliverable: request.deliverable, subjectEntity: entity,
    intent, requiredContent, deadline, impliedClaims: claims
  });
  request.qualifiers = request.analysis.qualifiers;
  return { request, rejection: null };
}

/** Explicit delivery targets, kept separate from the message's participants. */
export function extractDeliveryRecipients(message) {
  const active = unquotedMessageFields(message);
  const text = `${active.subject}\n${active.body}`.normalize('NFKC');
  const found = [];
  const add = raw => {
    let target = String(raw || '').trim().replace(/[.!?。！？,，;；]+$/u, '');
    target = target.replace(/\s+(?:by|before|due|no later than|并在|並在|在|截止|且在|然后|然後).+$/iu, '').trim();
    target = target.replace(/^(?:the|a|an)\s+/i, '').trim();
    if (!target || target.length > 100) return;
    if (/^(?:me|myself|我|本人|自己)$/iu.test(target)) {
      target = normalizeRequestAddress(message?.from);
    }
    const key = target.toLowerCase().replace(/\s+/g, ' ');
    if (key && !found.some(item => item.toLowerCase().replace(/\s+/g, ' ') === key)) found.push(target);
  };
  const english = /\b(?:send|share|email|forward|deliver|return|circulate|submit)\b[^.!?\n]{0,90}?\bto\s+([^.!?\n,;]+)/gi;
  for (const match of text.matchAll(english)) add(match[1]);
  const chinese = /(?:发送给|發送給|发给|發給|分享给|分享給|交付给|交付給|提交给|提交給|寄给|寄給)([^，,。；;！？!?\n]+)/gu;
  for (const match of text.matchAll(chinese)) add(match[1]);
  return found.slice(0, 6);
}

function normalizeRequestAddress(value) {
  const raw = String(value || '').trim();
  const bracketed = raw.match(/<\s*([^<>]+)\s*>/);
  const email = (bracketed?.[1] || raw).match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return email?.[0]?.toLowerCase() || raw.toLowerCase();
}

/** The request, or null. Kept as the single-value form callers already use. */
export function interpretRequest(message, options = {}) {
  return explainRequest(message, options).request;
}

function modelQuoteIsInMessage(message, quote) {
  const value = String(quote || '').replace(/\s+/g, ' ').trim();
  const active = unquotedMessageFields(message);
  return value.length >= 2 && value.length <= 180 &&
    (isVerbatimQuote(active.subject, value) || isVerbatimQuote(active.body, value));
}

function modelEntityIsSpecific(value) {
  const entity = String(value || '').normalize('NFKC').replace(/[“”"'.,:：;；()（）]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (entity.length < 2 || entity.length > 60) return false;
  const lower = entity.toLowerCase();
  if (STOPWORDS.has(lower) || ENTITY_NOISE.has(lower) || DELIVERABLE_NOUNS.includes(lower)) return false;
  if (/^(?:更新|修改|补充|補充|发送|發送|分享|请|請|麻烦|麻煩|需要|最新|最近|报告|報告|提案|方案|文档|文件)$/u.test(lower)) return false;
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length && words.every(word => STOPWORDS.has(word) || ENTITY_NOISE.has(word) || DELIVERABLE_NOUNS.includes(word))) return false;
  return true;
}

function canonicalModelDeliverable(value, quote) {
  const declared = String(value || '').toLowerCase().trim().replace(/[_\s]+/g, '-');
  const quoted = String(quote || '').normalize('NFKC').trim();
  const knownEnglish = DELIVERABLE_NOUNS.find(noun => noun === declared || noun.replaceAll('-', '') === declared.replaceAll('-', ''));
  const quoteEnglish = DELIVERABLE_NOUNS.find(noun => new RegExp(`(?:^|[^a-z0-9])${escapeRegex(noun)}(?:$|[^a-z0-9])`, 'i').test(quoted));
  const quoteChinese = CHINESE_DELIVERABLE_LOOKUP.get(quoted) || null;
  const quoteCanonical = quoteChinese || quoteEnglish;
  return knownEnglish && quoteCanonical === knownEnglish ? knownEnglish : null;
}

/**
 * A bounded model rescue path for a deterministic miss. The model is consulted
 * only for an explicit human request candidate, and every identity/action
 * phrase must be copied from the original subject or body. It cannot turn a
 * notification into work or introduce a new project or deliverable.
 */
export async function recoverRequestCandidateWithReasoner(message, reasoner, options = {}) {
  if (explainRequest(message, options).request) return null;
  if (!reasoner?.available?.() || isAutomatedSender(message?.from)) return null;
  const active = unquotedMessageFields(message);
  const text = `${active.subject}\n${active.body}`;
  if (!hasRequestForm(text)) return null;
  const deterministic = findDeliverable(text);
  if (!deterministic && !REQUEST_FORM.test(text) && !/(?:请|請|麻烦|麻煩|帮我|幫我|需要|能否|可以)/u.test(text)) return null;
  if (CHINESE_NEGATION.test(text)) return null;
  if (typeof reasoner.discoverRequestCandidate !== 'function') return null;

  try {
    const suggestion = await reasoner.discoverRequestCandidate({ subject: active.subject, body: active.body }, `discover:${message.id || 'message'}`);
    if (!suggestion || typeof suggestion !== 'object') return null;
    const deliverable = canonicalModelDeliverable(suggestion.deliverable, suggestion.deliverableQuote);
    const entityQuote = String(suggestion.entityQuote || '').replace(/\s+/g, ' ').trim();
    const entity = String(suggestion.subjectEntity || '').replace(/\s+/g, ' ').trim();
    const intentQuote = String(suggestion.intentQuote || '').replace(/\s+/g, ' ').trim();
    if (!deliverable || !modelQuoteIsInMessage(message, suggestion.deliverableQuote) ||
        !modelQuoteIsInMessage(message, entityQuote) || !modelQuoteIsInMessage(message, intentQuote) ||
        !modelEntityIsSpecific(entity) || !isVerbatimQuote(entityQuote, entity) || !hasRequestForm(text)) return null;
    const quoteCarriesAction = new RegExp(`(?:${verbForms([...UPDATE_VERBS, ...SEND_VERBS]).join('|')})`, 'i').test(intentQuote) ||
      CHINESE_UPDATE_VERB.test(intentQuote) || CHINESE_SEND_VERB.test(intentQuote);
    if (!quoteCarriesAction) return null;
    if (isAutomatedSender(message.from)) return null;

    const { accepted: requiredContent, dropped: droppedModelContent } = groundModelContentList(suggestion.requiredContent, message);
    const combined = text;
    const anchor = message.receivedAt || options.now || new Date();
    const deadline = extractDeadline(combined, { now: anchor, dateLocale: options.dateLocale });
    const intent = detectIntent(combined);
    const requestedIntent = intent !== 'informational' ? intent : suggestion.intent;
    if (!['update', 'send', 'update_and_send'].includes(requestedIntent)) return null;
    const claims = impliedClaims(combined);
    const request = {
      id: `request:${message.id}`,
      intent: requestedIntent,
      deliverable,
      subjectEntity: entity,
      deadline,
      requiredContent,
      droppedModelContent,
      explicitDocumentUrl: combined.match(/https?:\/\/[^\s<>"')\]]+/i)?.[0] || null,
      deliveryRecipients: extractDeliveryRecipients(message),
      impliedClaims: claims,
      text: combined,
      source: {
        kind: 'email', id: message.id, threadId: message.threadId || null,
        from: message.from, to: message.to || null, cc: message.cc || null, bcc: message.bcc || null,
        subject: message.subject || '', receivedAt: message.receivedAt || null
      },
      interpretedBy: 'grounded_model_rescue'
    };
    request.analysis = analyseRequest({
      text: combined, deliverable, subjectEntity: entity, intent: requestedIntent,
      requiredContent, deadline, impliedClaims: claims
    });
    request.qualifiers = request.analysis.qualifiers;
    return request;
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

/**
 * Ground one model-proposed requirement in the original message.
 *
 * A model may interpret wording, but every requirement it proposes must occur
 * verbatim (whitespace-normalised) in the subject or body of the email it
 * claims to interpret. Anything else is discarded. This is what prevents a
 * model from inventing a completion condition — and from later quoting that
 * invention back as its own justification through `requestQuotationTexts`.
 *
 * The stored `text` is always the verbatim span, even when the model supplied
 * only a valid `sourceQuote` and a paraphrase.
 */
export function groundModelContent(item, message) {
  const candidate = typeof item === 'string' ? { text: item } : (item || {});
  const proposedText = String(candidate.text || '').replace(/\s+/g, ' ').trim();
  if (proposedText.length < 3 || proposedText.length > 120) return null;
  const quote = String(candidate.sourceQuote || candidate.quote || '').replace(/\s+/g, ' ').trim();
  const claimedField = ['subject', 'body'].includes(candidate.sourceField || candidate.field)
    ? (candidate.sourceField || candidate.field)
    : null;
  const fields = claimedField ? [claimedField] : ['subject', 'body'];
  const active = unquotedMessageFields(message);
  const groundedIn = textToCheck => {
    for (const field of fields) {
      if (active[field] && isVerbatimQuote(active[field], textToCheck)) {
        return { field, sourceQuote: textToCheck };
      }
    }
    return null;
  };

  // The stored requirement itself must be a verbatim quotation. A paraphrase
  // accompanied by a valid quote would still make the paraphrase look sourced.
  const direct = groundedIn(proposedText);
  if (direct) {
    return { text: proposedText, sourceQuote: direct.sourceQuote, sourceField: direct.field, grounding: 'verbatim' };
  }
  // If the model returned the email's literal words instead of the phrase, the
  // quote can stand in as the requirement — it is still the email's own wording.
  if (quote && quote.length <= 120) {
    const grounded = groundedIn(quote);
    if (grounded) {
      return {
        text: quote, sourceQuote: grounded.sourceQuote, sourceField: grounded.field,
        grounding: 'verbatim', proposedText
      };
    }
  }
  return null;
}

/** True when `phrase` appears in `text` as whole words. */
function containsAsWords(text, phrase) {
  const normalized = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const needle = String(phrase ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(normalized);
}

/** Discard model content that has no verbatim source in the message. */
function groundModelContentList(items, message) {
  const accepted = [];
  const dropped = [];
  for (const item of Array.isArray(items) ? items : []) {
    const grounded = groundModelContent(item, message);
    if (grounded) {
      accepted.push(grounded);
    } else {
      const text = typeof item === 'string' ? item : item?.text;
      if (text) dropped.push(String(text).slice(0, 120));
    }
  }
  return { accepted, dropped };
}

/**
 * Optional model-assisted interpretation.
 *
 * Only consulted when the deterministic pass left the request under-specified:
 * either it found no required content, or it found content nothing can verify.
 * Never overrides a specific deterministic answer, never invents an entity, and
 * never throws — a model failure returns the deterministic result unchanged.
 */
export async function interpretRequestWithReasoner(message, reasoner, options = {}) {
  const deterministic = interpretRequest(message, options);
  if (!reasoner?.available?.()) return deterministic;

  const resolution = deterministic ? resolveRequiredContent(deterministic.requiredContent) : null;
  const deterministicUsable = Boolean(resolution && resolution.probeIds.length && !resolution.unverifiable.length);
  if (deterministic && deterministicUsable && options.preferModel !== true) return deterministic;

  try {
    const active = unquotedMessageFields(message);
    // Each message gets its own reasoning budget key. Without this every
    // interpretation shared one key, so the first call exhausted the per-request
    // budget for the whole process.
    const suggestion = await reasoner.interpretRequest(
      { subject: active.subject, body: active.body },
      options.reasoningRequestId || `interpret:${message.id || 'message'}`
    );
    if (!suggestion) return deterministic;

    // Model output is untrusted input. Only phrases the email itself contains
    // can become requirements; everything else is recorded and discarded.
    const { accepted: grounded, dropped: droppedModelContent } =
      groundModelContentList(suggestion.requiredContent, message);

    if (deterministic) {
      // Nothing grounded means the model contributed no verifiable reading:
      // keep the deterministic result exactly as it was.
      if (!grounded.length) return deterministic;
      const withModel = {
        ...deterministic,
        requiredContent: options.preferModel === true && deterministicUsable
          ? [...new Map([...deterministic.requiredContent, ...grounded].map(item => [item.text.toLowerCase(), item])).values()]
          : grounded,
        originalRequiredContent: deterministic.requiredContent,
        droppedModelContent,
        interpretedBy: 'deterministic+model'
      };
      if (options.preferModel === true) withModel.modelInterpretation = { verified: true };
      withModel.analysis = analyseRequest({
        text: withModel.text, deliverable: withModel.deliverable, subjectEntity: withModel.subjectEntity,
        intent: withModel.intent, requiredContent: withModel.requiredContent, deadline: withModel.deadline, impliedClaims: withModel.impliedClaims
      });
      withModel.qualifiers = withModel.analysis.qualifiers;
      return withModel;
    }

    if (!suggestion.deliverable || !suggestion.subjectEntity) return null;
    const combined = `${message.subject || ''}\n${message.body || ''}`;
    // The model-only reading must be anchored in the message too. Without this
    // an invented project name plus an invented deliverable could create a task
    // that the deterministic pass would never have produced.
    if (!containsAsWords(combined, suggestion.subjectEntity)) return null;
    if (!containsAsWords(combined, suggestion.deliverable)) return null;
    const anchor = message.receivedAt || options.now || new Date();
    const deadline = extractDeadline(combined, { now: anchor, dateLocale: options.dateLocale });
    // The same deterministic gates apply to a model-derived reading: a model may
    // interpret wording, but it cannot turn a newsletter into a request.
    if (isAutomatedSender(message.from)) return null;
    if (!hasRequestForm(combined)) return null;
    const claims = impliedClaims(combined);
    const request = {
      id: `request:${message.id}`,
      intent: suggestion.intent || 'update_and_send',
      deliverable: suggestion.deliverable,
      subjectEntity: suggestion.subjectEntity,
      deadline,
      requiredContent: grounded,
      droppedModelContent,
      explicitDocumentUrl: combined.match(/https?:\/\/[^\s<>"')\]]+/i)?.[0] || null,
      impliedClaims: claims,
      text: combined,
      source: {
        kind: 'email', id: message.id, threadId: message.threadId || null,
        from: message.from, to: message.to || null, subject: message.subject,
        receivedAt: message.receivedAt || null
      },
      interpretedBy: 'model'
    };
    request.analysis = analyseRequest({
      text: combined, deliverable: request.deliverable, subjectEntity: request.subjectEntity,
      intent: request.intent, requiredContent: request.requiredContent, deadline, impliedClaims: claims
    });
    request.qualifiers = request.analysis.qualifiers;
    return request;
  } catch (error) {
    // A model failure is reported to the caller when it asked to hear about it,
    // so the engine can record it as a reasoning failure. It is never converted
    // into an assessment result.
    options.onError?.(error);
    return deterministic; // Degrade safely: never fabricate a request.
  }
}

export const requestsApi = {
  interpretRequest, explainRequest, interpretRequestWithReasoner, recoverRequestCandidateWithReasoner, extractDeadline, extractRequiredContent,
  extractRequestQualifiers, extractDeliveryRecipients, analyseRequest, escapeRegex,
  isAutomatedSender, hasRequestForm, deliverableIsGoverned
};
