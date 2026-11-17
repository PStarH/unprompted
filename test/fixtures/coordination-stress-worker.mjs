import { DurableDatabase } from '../../src/durable/database.js';
import { DurableJobs } from '../../src/durable/jobs.js';
import { DurableTasks } from '../../src/durable/tasks.js';
import { ToolExecutionLedger } from '../../src/durable/execution.js';
import { authorizeForTests } from '../../src/authority-credential.js';

const [mode, filename, encoded = '{}'] = process.argv.slice(2);
const options = JSON.parse(encoded);
let currentNow = options.now ?? Date.now();
const send = message => { try { process.send?.(message); } catch { /* parent closed the channel */ } };
const wait = () => new Promise(resolve => process.once('message', resolve));

let database;
try {
  database = new DurableDatabase(filename, { now: () => currentNow });
  const jobs = new DurableJobs(database, { leaseMs: options.leaseMs ?? 30000, random: () => 0.5 });
  const tasks = new DurableTasks(database, jobs);
  const ledger = new ToolExecutionLedger(database, { jobs, tasks, timeoutMs: options.timeoutMs ?? 5000 });

  if (mode === 'hold') {
    send({ stage: 'ready', worker: `worker:${process.pid}` });
    let claimed = null;
    for (;;) {
      const message = await wait();
      if (message.action === 'advance') {
        currentNow += message.ms;
        send({ stage: 'advance', now: currentNow });
      } else if (message.action === 'claim') {
        claimed = jobs.claim(`worker:${process.pid}`, { id: message.jobId ?? options.jobId ?? null });
        send({ stage: 'claim', claimed: claimed?.id || null, owner: claimed?.lease_owner || null, token: claimed?.lease_token ?? null });
      } else if (message.action === 'complete') {
        try {
          jobs.complete(claimed);
          send({ stage: 'complete', ok: true });
        } catch (error) {
          send({ stage: 'complete', ok: false, code: error.code || error.message });
        }
      } else if (message.action === 'exit') break;
    }
  } else if (mode === 'write') {
    const created = tasks.createOrLoad({ candidateKey: options.candidateKey, data: { subject: options.candidateKey } });
    const queued = jobs.enqueue({ type: 'stress_write', key: `stress:${options.candidateKey}`, taskId: created.taskId, payload: {} });
    const job = jobs.claim(`worker:${process.pid}`, { id: queued.id });
    if (!job) throw Object.assign(new Error('No durable job was available.'), { code: 'NO_JOB' });
    const run = tasks.beginRun(job);
    tasks.checkpoint(run, job, { expectedInputVersion: 0, plan: { stress: true } });
    let intent = null;
    try {
      intent = ledger.intent({
        taskId: created.taskId, run, job,
        provider: options.provider || 'fixture', tool: options.tool || 'send',
        actionFamily: options.actionFamily || 'fixture.send', resourceId: options.resourceId,
        key: options.key, effect: options.effect || { type: 'fixture' }, payload: options.payload || {},
        isWrite: options.isWrite !== false, providerIdempotent: Boolean(options.providerIdempotent),
        conditionalVersion: options.conditionalVersion ?? null,
        // The ledger must see an allowed, current review decision before a
        // write can reach the provider. A stale token fails here, never by
        // rewriting a durable status after the fact.
        authorize: () => options.reviewToken === options.expectedReviewToken ? authorizeForTests({ taskId: created.taskId }) : ({ allowed: false })
      });
    } catch (error) {
      send({ stage: 'intent', error: error.code || error.message });
    }
    if (intent) {
      if (options.barrier) { send({ stage: 'prepared', executionId: intent.execution.id }); await wait(); }
      try {
        const result = await ledger.dispatch(intent, {
          run, job, deferDispatch: true,
          send: async (signal, beforeDispatch) => {
            beforeDispatch?.();
            const response = await fetch(`${options.endpoint}${options.path}`, {
              method: 'POST', signal, headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...options.request, key: options.key })
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw Object.assign(new Error(body.error || 'provider rejected the write'), { status: response.status, definitiveNoEffect: body.definitiveNoEffect === true });
            return body.receipt;
          },
          verify: options.verify === false ? null : async receipt => ({ status: 'found', receipt })
        });
        send({ stage: 'done', result, status: ledger.get(intent.execution.id)?.status });
      } catch (error) {
        send({ stage: 'dispatch', error: error.code || error.message, ambiguous: Boolean(error.ambiguous), status: ledger.get(intent.execution.id)?.status });
      }
    }
  } else {
    throw Object.assign(new Error(`Unknown stress worker mode: ${mode}`), { code: 'UNKNOWN_MODE' });
  }
} catch (error) {
  send({ stage: 'fatal', error: error.code || error.message });
  process.exitCode = 1;
} finally {
  try { database?.close(); } catch { /* already closed */ }
  process.disconnect?.();
}
