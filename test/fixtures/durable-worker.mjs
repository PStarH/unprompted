import { DurableDatabase, iso } from '../../src/durable/database.js';
import { DurableJobs } from '../../src/durable/jobs.js';
import { DurableTasks } from '../../src/durable/tasks.js';
import { ToolExecutionLedger } from '../../src/durable/execution.js';

const [mode, filename, endpoint] = process.argv.slice(2);
const database = new DurableDatabase(filename), jobs = new DurableJobs(database), tasks = new DurableTasks(database, jobs);
if (mode === 'claim') {
  process.send?.({ ready: true });
  process.on('message', () => {
    const job = jobs.claim(`child:${process.pid}`);
    process.send?.({ claimed: job?.id || null }); database.close(); process.disconnect?.();
  });
} else if (mode === 'commit') {
  database.atomic(() => {
    database.db.prepare('INSERT INTO durable_inbox(id,provider,provider_event_id,event_json,material_signature,received_at) VALUES(?,?,?,?,?,?)')
      .run('committed', 'fixture', 'committed', '{}', 'signature', iso());
    jobs.enqueue({ type: 'test', key: 'committed' });
  });
  process.send?.({ committed: true });
  process.on('message', () => process.exit(0));
} else if (mode === 'dedup') {
  const created = tasks.createOrLoad({ candidateKey: `race:${process.pid}`, situationId: endpoint, dedupTaskKey: 'same-work', data: { status: 'waiting_for_information' } });
  process.send?.({ taskId: created.taskId, createdNew: created.createdNew });
  database.close();
} else if (mode === 'crash-after-send') {
  const created = tasks.createOrLoad({ candidateKey: 'crash-action', data: { subject: 'Fixture work' } });
  const job = jobs.claim('crashing-worker'), run = tasks.beginRun(job);
  tasks.checkpoint(run, job, { expectedInputVersion: 0, plan: {} });
  const ledger = new ToolExecutionLedger(database, { jobs, tasks });
  const intent = ledger.intent({ taskId: created.taskId, run, job, provider: 'fixture', tool: 'send', actionFamily: 'fixture.send', resourceId: 'shared', key: 'crash-write',
    payload: {}, effect: { type: 'fixture' }, authorize: () => ({ allowed: true }) });
  await ledger.dispatch(intent, { run, job, send: async () => {
    await fetch(endpoint, { method: 'POST' });
    process.exit(23);
  } });
}
