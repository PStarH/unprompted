import { durableError, json, parse } from './database.js';

/** New proactive paths can be disabled without skipping revocation, write
 * reconciliation, or the privacy fence. Defaults stay on once the path has a
 * regression test; turning a flag off is the rollback. */
export const ACTIVATION_FLAGS = Object.freeze({
  lexicalRecall: true,
  standingIntents: true,
  scopedCancellation: true,
  coverageProbes: true,
  globalCoordination: true,
  stagedReadiness: true,
  boundedRsi: true
});

const KEYS = Object.keys(ACTIVATION_FLAGS);

export function activationFlags(database) {
  const stored = parse(database.get('activation_flags', 'null')) || {};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { ...ACTIVATION_FLAGS };
  const flags = { ...ACTIVATION_FLAGS };
  for (const key of KEYS) if (typeof stored[key] === 'boolean') flags[key] = stored[key];
  return flags;
}

export function setActivationFlags(database, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !KEYS.includes(key) || typeof patch[key] !== 'boolean')) {
    throw durableError('INVALID_ACTIVATION_FLAGS', 'Activation flags accept only known boolean switches.', 400);
  }
  const next = { ...activationFlags(database), ...patch };
  database.atomic(() => database.set('activation_flags', json(next)));
  return next;
}
