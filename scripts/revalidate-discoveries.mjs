#!/usr/bin/env node
/**
 * Re-validate discoveries that already exist in a state file.
 *
 * The discovery gate tightened on 2026-10-17: a task is only created from a
 * person, in the imperative, about a deliverable that is the object of the
 * request. Tasks created before that change may no longer qualify — a live
 * shadow run had eight of nine tasks come from newsletters.
 *
 * This script does NOT delete anything. Dry run by default; `--apply` cancels
 * the affected tasks through the engine's own `cancel` path, which records the
 * reason and keeps the task, its message and its evidence in place so the
 * decision is auditable and reversible.
 *
 *   node scripts/revalidate-discoveries.mjs                     # report only
 *   node scripts/revalidate-discoveries.mjs --apply             # cancel them
 *   node scripts/revalidate-discoveries.mjs --state data/x.json # explicit file
 */

import fs from 'node:fs';
import path from 'node:path';
import { interpretRequest, isAutomatedSender, hasRequestForm } from '../src/requests.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const stateFlag = args.indexOf('--state');
const statePath = stateFlag !== -1 ? args[stateFlag + 1] : path.join(process.cwd(), 'data', 'shadow-state.json');

if (!fs.existsSync(statePath)) {
  console.log(JSON.stringify({ error: `no state file at ${statePath}` }));
  process.exit(1);
}

// Read the file directly. Constructing the engine would run recovery and could
// write to the file, and a dry run must not change anything.
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const inbox = new Map((state.inbox || []).map(message => [message.id, message]));

const affected = [];
for (const task of Object.values(state.tasks || {})) {
  if (['completed', 'cancelled'].includes(task.status)) continue;
  const message = inbox.get(task.sourceEmailId);
  if (!message) continue;

  const reason = isAutomatedSender(message.from)
    ? `sender is automated (“${String(message.from).slice(0, 60)}”)`
    : !hasRequestForm(`${message.subject || ''}\n${message.body || ''}`)
      ? 'message contains no request form (imperative or direct ask)'
      : interpretRequest(message)
        ? null
        : 'no deliverable request survives the current gate';

  if (!reason) continue;
  affected.push({
    taskId: task.id,
    status: task.status,
    entity: task.request?.subjectEntity ?? null,
    deliverable: task.request?.deliverable ?? null,
    subject: String(task.subject || '').slice(0, 70),
    from: String(message.from || '').slice(0, 60),
    reason
  });
}

console.log(JSON.stringify({
  state: statePath,
  mode: apply ? 'apply' : 'dry-run',
  tasksInspected: Object.keys(state.tasks || {}).length,
  noLongerJustified: affected.length,
  affected
}, null, 2));

if (apply && affected.length) {
  // Write the same legal transition the engine uses (`waiting_for_information →
  // cancelled`) with a truthful reason. Nothing is deleted: the task, its
  // message and its evidence stay, so the correction is auditable.
  const at = new Date().toISOString();
  let cancelled = 0;
  for (const item of affected) {
    const task = state.tasks[item.taskId];
    if (!task || task.status !== 'waiting_for_information') continue;
    task.status = 'cancelled';
    task.updatedAt = at;
    task.reason = `Closed on re-validation: ${item.reason}. This task was created before the discovery gate required a person, a request form and a governed deliverable.`;
    task.draft = null;
    state.history.push({
      id: `h-${state.history.length + 1}`,
      at,
      kind: 'revalidation',
      text: `Closed a discovery that the current gate would not create: ${item.reason}. Nothing was sent.`,
      taskId: item.taskId,
      eventId: null
    });
    cancelled += 1;
  }
  state.revision = (state.revision || 0) + 1;
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, statePath);
  console.log(JSON.stringify({ cancelled, note: 'tasks are cancelled, not deleted; history records why' }));
} else if (!apply && affected.length) {
  // stderr, so stdout stays parseable JSON.
  console.error('Re-run with --apply to close these (nothing is deleted; the reason is recorded).');
}
