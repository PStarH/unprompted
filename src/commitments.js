import crypto from 'node:crypto';

const compact = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Keep the sender's active text and remove quoted or forwarded history. */
export function unquotedMessageFields(message = {}) {
  let quoted = false;
  const active = [];
  for (const line of String(message.body || '').normalize('NFKC').replace(/```[\s\S]*?```/g, ' ').split(/\r?\n/)) {
    if (/^\s*(?:-{2,}\s*(?:forwarded|original) message|begin forwarded message:|on .+wrote:)\s*$/i.test(line) || /^\s*(?:from|sent|to|subject):\s/i.test(line)) {
      quoted = true;
      continue;
    }
    if (quoted || /^\s*>/.test(line)) continue;
    active.push(line.replace(/“[^”]*”|"[^"]*"|‘[^’]*’/gu, ' '));
  }
  return { subject: String(message.subject || ''), body: active.join('\n') };
}

/** Normalize a mailbox address independently of its display name and casing. */
export function normalizeAddress(value) {
  const raw = String(value || '').trim();
  const bracketed = raw.match(/<\s*([^<>]+)\s*>/);
  const address = (bracketed?.[1] || raw).trim().replace(/^mailto:/i, '');
  const match = address.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return (match?.[0] || address).toLowerCase();
}

function addresses(value) {
  if (Array.isArray(value)) return value.flatMap(addresses);
  if (!value) return [];
  const text = String(value);
  const found = [...text.matchAll(/(?:[^,;<>]*<\s*([^<>]+)\s*>|([^,;\s<>]+@[^,;\s<>]+))/g)]
    .map(match => normalizeAddress(match[1] || match[2]))
    .filter(Boolean);
  if (found.length) return found;
  return text.split(/[,;]/).map(normalizeAddress).filter(Boolean);
}

function normalizedRecipients(request) {
  const source = request?.source || {};
  const outputRecipients = Array.isArray(request?.deliveryRecipients) ? request.deliveryRecipients : [];
  return [...new Set([...normalizedConversationRecipients(request), ...outputRecipients.map(normalizeAddress)])].sort();
}

function normalizedConversationRecipients(request) {
  const source = request?.source || {};
  return [...new Set([...addresses(source.to), ...addresses(source.cc), ...addresses(source.bcc)])].sort();
}

function normalizedSender(request) {
  return normalizeAddress(request?.source?.from);
}

function normalizedEntity(value) {
  return compact(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizedDelivery(value) {
  return compact(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * The stable identity of one deliverable commitment in a mail thread.
 * Requests without a provider thread id are intentionally message-scoped:
 * subject similarity alone is not enough to merge separate work.
 */
export function commitmentScope(request, message = null) {
  const source = request?.source || {};
  const threadId = String(message?.threadId || source.threadId || '').trim();
  const scope = {
    threadId: threadId || null,
    sender: normalizedSender(request),
    conversationRecipients: normalizedConversationRecipients(request),
    participants: normalizedRecipients(request),
    entity: normalizedEntity(request?.subjectEntity),
    deliverable: normalizedDelivery(request?.deliverable),
    deliveryRecipients: [...new Set((request?.deliveryRecipients || []).map(normalizeAddress))].sort(),
    explicitDocument: compact(request?.explicitDocumentUrl)
  };
  const identity = threadId
    ? ['thread', compact(threadId), 'sender', scope.sender, 'participants', scope.participants.join(','),
      'entity', scope.entity, 'deliverable', scope.deliverable,
      'delivery', scope.deliveryRecipients.join(','), 'document', scope.explicitDocument].join('|')
    : ['message', String(message?.id || source.id || request?.id || ''), 'sender', scope.sender,
      'entity', scope.entity, 'deliverable', scope.deliverable, 'document', scope.explicitDocument].join('|');
  scope.key = `commitment:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
  return scope;
}

/** True only when two requests name the same stable commitment boundary. */
export function sameCommitment(left, right, leftMessage = null, rightMessage = null) {
  const a = commitmentScope(left, leftMessage);
  const b = commitmentScope(right, rightMessage);
  if (!a.threadId || !b.threadId || compact(a.threadId) !== compact(b.threadId)) return false;
  if (a.sender !== b.sender || a.entity !== b.entity || a.deliverable !== b.deliverable) return false;
  if (JSON.stringify(a.participants) !== JSON.stringify(b.participants)) return false;
  if (a.deliveryRecipients.length && b.deliveryRecipients.length && JSON.stringify(a.deliveryRecipients) !== JSON.stringify(b.deliveryRecipients)) return false;
  if (a.explicitDocument && b.explicitDocument && a.explicitDocument !== b.explicitDocument) return false;
  return true;
}

/** Semantic request signature used to distinguish a duplicate from a revision. */
export function requestRevisionSignature(request) {
  const requiredContent = [...new Set((request?.requiredContent || []).map(item =>
    compact(typeof item === 'string' ? item : item?.text)
  ).filter(Boolean))].sort();
  return crypto.createHash('sha256').update(JSON.stringify({
    intent: request?.intent || null,
    deliverable: normalizedDelivery(request?.deliverable),
    entity: normalizedEntity(request?.subjectEntity),
    requiredContent,
    deadline: request?.deadline?.iso || compact(request?.deadline?.text),
    qualifiers: [...new Set((request?.qualifiers || []).map(item => compact(item?.id || item?.text)))].sort(),
    deliveryRecipients: [...new Set((request?.deliveryRecipients || []).map(normalizeAddress))].sort(),
    explicitDocument: compact(request?.explicitDocumentUrl)
  })).digest('hex').slice(0, 24);
}

/**
 * Identify a high confidence cancellation/withdrawal message. This does not
 * establish its target; callers must first match a trusted sender and a unique
 * in-thread commitment.
 */
export function isWithdrawalMessage(message) {
  const active = unquotedMessageFields(message);
  const text = `${active.subject}\n${active.body}`.toLowerCase();
  const negated = /\b(?:do\s+not|don't|dont|never|no\s+need\s+to|not|should\s+not|shouldn't|cannot|can't)\s+(?:please\s+)?(?:cancel|withdraw|retract)\b/i.test(text) ||
    /(?:不要|不必|无需|無需|不是要|不想|别|別|請勿|请勿)\s*(?:再\s*)?(?:取消|撤回|撤销|撤銷|收回)/u.test(text);
  if (negated) return false;
  const patterns = [
    /\b(?:please\s+)?(?:cancel|withdraw|retract)\s+(?:the\s+)?(?:request|task|work|update|delivery|proposal|report)?\b/i,
    /\b(?:no\s+longer\s+needed|don't\s+need\s+(?:it|this|that|the\s+work)|do\s+not\s+need\s+(?:it|this|that|the\s+work)|never\s*mind|disregard\s+(?:it|this|that|my\s+request)|ignore\s+(?:it|this|that|my\s+request)|hold\s+off\s+on\s+(?:it|this|the\s+work))\b/i,
    /(?:撤回|取消|作废|不再需要|不用(?:做|更新|发送|发)|无需(?:再|继续)?(?:做|更新|发送|发)|先别(?:做|更新|发送|发)|暂时不要(?:做|更新|发送|发)|请忽略(?:这项|这个|该)?(?:请求|任务|工作|提案|报告)?)/u
  ];
  return patterns.some(pattern => pattern.test(text));
}

/** A clear deadline correction that can update one uniquely matched request. */
export function isRescheduleMessage(message) {
  const active = unquotedMessageFields(message);
  const text = `${active.subject}\n${active.body}`.toLowerCase();
  return /\b(?:move|push|shift|change|reschedule|extend|delay|bring forward)\b.{0,80}\b(?:deadline|due|date|by|to)\b/i.test(text) ||
    /\b(?:deadline|due date)\b.{0,50}\b(?:is now|moved to|changed to|pushed to|shifted to|extended to|will be)\b/i.test(text) ||
    /(?:改到|改为|改成|延到|推迟到|提前到|延期至|截止日期.{0,8}(?:改|调整|变更)|期限.{0,8}(?:改|调整|变更))/u.test(text);
}

/** Whether the message explicitly names a candidate's entity or deliverable. */
export function messageNamesCommitment(message, request) {
  return commitmentMatchScore(message, request) > 0;
}

function commitmentMatchScore(message, request) {
  const active = unquotedMessageFields(message);
  const text = compact(`${active.subject} ${active.body}`);
  const entity = compact(request?.subjectEntity);
  const deliverable = compact(request?.deliverable);
  const includes = (needle, haystack) => needle.length > 1 && haystack.includes(needle);
  const entityMatch = includes(entity, text);
  const deliverableMatch = includes(deliverable, text);
  const recipientMatch = (request?.deliveryRecipients || []).some(value => includes(compact(value), text));
  return (entityMatch ? 2 : 0) + (deliverableMatch ? 2 : 0) + (recipientMatch ? 3 : 0);
}

/** Return only uniquely best explicit target matches; ambiguous instructions stay untouched. */
export function narrowCommitmentsByMessage(candidates, message) {
  const scored = (candidates || []).map(task => ({ task, score: commitmentMatchScore(message, task.request) })).filter(item => item.score > 0);
  if (!scored.length) return [];
  const best = Math.max(...scored.map(item => item.score));
  const matches = scored.filter(item => item.score === best).map(item => item.task);
  return matches.length === 1 ? matches : [];
}

/** Trusted source check for amendments and withdrawals in a known thread. */
export function isTrustedThreadSender(task, message) {
  const scope = task?.commitment || commitmentScope(task?.request, task?.request?.source);
  const threadId = String(message?.threadId || '').trim();
  if (!scope.threadId || !threadId || compact(scope.threadId) !== compact(threadId)) return false;
  if (!scope.sender || normalizeAddress(message?.from) !== scope.sender) return false;
  const incoming = [...new Set([...addresses(message?.to), ...addresses(message?.cc), ...addresses(message?.bcc)])].sort();
  const expected = scope.conversationRecipients || [];
  return !incoming.length || !expected.length || JSON.stringify(incoming) === JSON.stringify(expected);
}

export const commitmentsApi = {
  normalizeAddress, commitmentScope, sameCommitment, requestRevisionSignature, unquotedMessageFields,
  isWithdrawalMessage, isRescheduleMessage, messageNamesCommitment, narrowCommitmentsByMessage, isTrustedThreadSender
};
