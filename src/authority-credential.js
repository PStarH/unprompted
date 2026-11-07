/**
 * Sealed execution credentials.
 *
 * Only AuthorityGate.decide (and test helpers that call issueCredential) may
 * place an object in the issued set. A permission string, a structured clone,
 * or a plain `{ permission, grantId, approved }` object is not a credential.
 */
const issued = new WeakSet();

export function issueCredential(fields) {
  if (!fields || typeof fields !== 'object') throw new TypeError('A credential needs a stored record.');
  const kind = fields.kind;
  if (!['approval', 'yolo', 'standing'].includes(kind)) throw new TypeError('Unknown credential kind.');
  if (typeof fields.id !== 'string' || !fields.id) throw new TypeError('A credential needs a stored id.');
  const credential = Object.freeze({
    kind,
    id: fields.id,
    version: Number(fields.version) || 1,
    taskId: fields.taskId || null,
    effectDigest: fields.effectDigest || null
  });
  issued.add(credential);
  return credential;
}

export function isAuthorityCredential(value) {
  return Boolean(value && typeof value === 'object' && issued.has(value));
}

/** Ledger and unit tests need a real credential, not a permission string. */
export function authorizeForTests(fields = {}) {
  const credential = issueCredential({
    kind: fields.kind || 'approval',
    id: fields.id || 'test-approval',
    version: fields.version || 1,
    taskId: fields.taskId || null,
    effectDigest: fields.effectDigest || null
  });
  return { allowed: true, credential };
}
