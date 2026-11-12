import { randomUUID } from 'node:crypto';

const active = task => task && typeof task.id === 'string' && !task.privacyInvalidated && !task.userDismissed
  && !['completed', 'cancelled'].includes(task.status);
const invalid = message => Object.assign(new Error(message), { code: 'INVALID_AUTONOMY', status: 400 });

/** User-issued leases live in workspace state. Planners cannot create leases.
 * Leases remove approval clicks; adapter, freshness and privacy checks still run. */
export class Autonomy {
  constructor(engine, { now = Date.now } = {}) {
    this.engine = engine;
    this.now = now;
    this.pending = new Set();
    this.runningTasks = new Set();
    this.attempted = new Map();
    this.queued = false;
    this.expire();
  }
  grants() { return this.engine.store.state.autonomyGrants || []; }
  valid(grant, taskId = null) {
    return grant?.status === 'active' && grant.source === 'user' &&
      (grant.mode === 'time' ? Date.parse(grant.expiresAt) > this.now()
        : grant.mode === 'task' && active(this.engine.store.state.tasks[grant.taskId]) && (!taskId || grant.taskId === taskId));
  }
  forTask(taskId) {
    if (!active(this.engine.store.state.tasks[taskId])) return null;
    return this.grants().find(grant => grant.mode === 'task' && this.valid(grant, taskId))
      || this.grants().find(grant => this.valid(grant, taskId)) || null;
  }
  authorize(approval, taskId) {
    const grant = this.grants().find(item => item.id === approval.grantId);
    return Boolean(taskId && approval.taskId === taskId && active(this.engine.store.state.tasks[taskId]) && this.valid(grant, taskId));
  }
  describe() {
    return { enabled: !this.engine.policy.shadow, grants: this.grants().filter(grant => this.valid(grant)) };
  }
  expire() {
    const expired = this.grants().filter(grant => grant.status === 'active' && !this.valid(grant));
    if (expired.length) this.engine.store.mutate(state => {
      for (const grant of state.autonomyGrants) if (expired.some(item => item.id === grant.id)) grant.status = 'expired';
    });
  }
  create(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['mode', 'taskId', 'durationMinutes'].includes(key))) throw invalid('Invalid YOLO authorization.');
    const { mode, taskId = null, durationMinutes = null } = input;
    if (this.engine.policy.shadow) throw invalid('YOLO requires write mode.');
    if (!['time', 'task'].includes(mode)) throw invalid('Choose time or task YOLO.');
    if (mode === 'task' && (typeof taskId !== 'string' || !active(this.engine.store.state.tasks[taskId]) || durationMinutes !== null)) throw invalid('Task YOLO requires an active task and no duration.');
    if (mode === 'time' && (taskId !== null || typeof durationMinutes !== 'number' || !Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440)) throw invalid('Time YOLO requires 1–1440 minutes and covers this workspace.');
    this.expire();
    const grant = { id: randomUUID(), mode, taskId, source: 'user', status: 'active',
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: mode === 'time' ? new Date(this.now() + durationMinutes * 60000).toISOString() : null };
    this.engine.store.mutate(state => {
      // Replacing a lease revokes it, including operations queued under its ID.
      state.autonomyGrants = (state.autonomyGrants || []).filter(item => item.status === 'active');
      for (const item of state.autonomyGrants) if (item.mode === mode && item.taskId === taskId) item.status = 'revoked';
      state.autonomyGrants.push(grant);
    });
    this.engine.changed();
    return grant;
  }
  revoke(id) {
    if (!this.grants().some(grant => grant.id === id)) throw invalid('Unknown YOLO authorization.');
    this.engine.store.mutate(state => { state.autonomyGrants.find(grant => grant.id === id).status = 'revoked'; });
    this.engine.changed();
  }
  schedule() {
    this.expire();
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; this.runReady(); });
  }
  runReady() {
    if (this.engine.store.closed || this.engine.policy.shadow || this.engine.durableRuntime?.closed) return;
    const state = this.engine.store.state;
    for (const task of Object.values(state.tasks)) {
      const grant = this.forTask(task.id);
      if (!grant || this.runningTasks.has(task.id) || task.control?.paused || task.guidanceReviewRequired || task.contextReadRequired || task.pendingCommitmentChange) continue;
      const latestPatch = Object.values(state.documentPatches || {}).filter(item => item.taskId === task.id).at(-1);
      const patch = latestPatch?.status === 'prepared' ? latestPatch : null;
      if (latestPatch && !patch && latestPatch.status !== 'applied') continue;
      const send = !patch && task.status === 'ready_for_approval' && task.draft && !task.action;
      if (!patch && !send) continue;
      const key = patch ? `patch:${patch.id}` : `send:${task.id}`;
      const signature = JSON.stringify([grant.id, task.inputVersion, task.draft, patch?.baseDocument]);
      if (this.attempted.get(key) === signature) continue;
      this.attempted.set(key, signature);
      this.runningTasks.add(task.id);
      const operation = Promise.resolve().then(() => patch
        ? this.engine.taskServices.applyDocumentPatch(task.id, { patchId: patch.id, autonomyGrantId: grant.id })
        : this.engine.approve(task.id, { autonomyGrantId: grant.id }));
      const pending = operation.catch(error => {
        // Preserve failures for the task UI; never retry an uncertain outcome.
        if (!this.engine.store.closed) this.engine.store.mutate(current => {
          const item = current.tasks[task.id];
          if (item) item.autonomyError = error.message;
        });
        if (!this.engine.store.closed) this.engine.onChange(this.engine.publicState());
      }).finally(() => {
        this.pending.delete(pending);
        this.runningTasks.delete(task.id);
        if (!this.engine.store.closed) this.schedule();
      });
      this.pending.add(pending);
    }
  }
  async whenIdle() {
    await Promise.resolve();
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
