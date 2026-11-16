import { createHash, createHmac } from 'node:crypto';
import { durableError } from './durable/database.js';
import { MoneyBudgetService } from './durable/money-budget.js';
import { ModelMoneyService, modelProviderIdentity } from './durable/model-money.js';
import { normalizeModelSettings } from './model-setup.js';

const invalid = message => durableError('MODEL_CONTROLS_INVALID', message, 400);
const plain = (value, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw invalid('Use only the supported model-control fields.');
};
const profileView = (profile, version) => ({ model: profile.model, protocol: profile.protocol, currency: profile.currency, revision: profile.revision, rates: profile.rates, version });

/** User-confirmed local controls. Never accepts provider identity or permissions
 * from request/model data and never changes the active model connection. */
export class ModelControlsService {
  constructor(runtime, setup) {
    if (!runtime?.database || !runtime.tokenBudget) throw durableError('DURABLE_WORKSPACE_REQUIRED', 'Open a persistent workspace to configure model budgets.', 409);
    this.runtime = runtime; this.database = runtime.database; this.setup = setup;
    this.money = new MoneyBudgetService(this.database, { kind: 'model' });
  }
  workspaceToken() { return createHmac('sha256', this.database.get('privacy_salt')).update('model-controls/workspace/v1').digest('hex'); }
  task(taskId = null) {
    if (taskId === null || taskId === '') return null;
    if (typeof taskId !== 'string' || !this.runtime.tasks.get(taskId)) throw durableError('MODEL_CONTROLS_TASK_MISSING', 'Choose an existing task in this workspace.', 404);
    return taskId;
  }
  scope(input) {
    if (!['workspace','task'].includes(input.scope)) throw invalid('Choose workspace or task scope.');
    const taskId = this.task(input.taskId ?? null);
    if (input.scope === 'workspace' && taskId !== null || input.scope === 'task' && taskId === null) throw invalid('Task scope requires its existing task; workspace scope has no task.');
    return { scope: input.scope, taskId };
  }
  currentSettings() {
    const reasoner = this.runtime.engine.reasoner;
    if (reasoner?.baseUrl && reasoner?.model) return { baseUrl: reasoner.baseUrl, model: reasoner.model, protocol: reasoner.protocol,
      apiKey: reasoner.apiKey || null, harness: reasoner.runtime ? 'pi' : 'classic' };
    const saved = this.setup?.get().model;
    return saved?.baseUrl && saved?.model ? saved : null;
  }
  describe(taskId = null) {
    taskId = this.task(taskId);
    const token = this.runtime.tokenBudget.describe({ taskId });
    const money = this.money.describe({ ...(taskId ? { scope: 'task', taskId } : { scope: 'workspace' }) });
    const limits = this.database.db.prepare("SELECT scope,scope_id,currency,micros,version FROM money_budget_limits WHERE kind='model' AND (scope='workspace' OR (scope='task' AND scope_id=?))").all(taskId || '');
    const limit = scope => {
      const row = limits.find(row => row.scope === scope);
      return { scope, taskId: scope === 'task' ? taskId : null, currency: row?.currency || money.currencies[0]?.currency || profiles[0]?.currency || 'USD', micros: row?.micros ?? null, version: row?.version || 0 };
    };
    const settings = this.currentSettings(), providerId = this.runtime.engine.reasoner?.modelMoney?.providerId;
    const exists = this.database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_price_snapshots'").get();
    const profiles = settings && providerId && exists ? this.database.db.prepare('SELECT profile_json,version FROM model_price_snapshots WHERE provider_id=? AND protocol=? ORDER BY model,currency LIMIT 24')
      .all(providerId, settings.protocol).map(row => profileView(JSON.parse(row.profile_json), row.version)) : [];
    const unpricedCalls = this.database.db.prepare(`SELECT COUNT(*) n FROM token_budget_reservations t
      LEFT JOIN money_budget_reservations m ON m.kind='model' AND m.attempt_id=t.attempt_id
      WHERE t.day=? AND t.state IN ('dispatched','settled','unknown') AND m.attempt_id IS NULL AND (? IS NULL OR t.task_id=?)`)
      .get(token.date, taskId, taskId).n;
    return { available: true, workspaceToken: this.workspaceToken(), taskId, window: 'utc_day', nextReset: money.nextReset,
      token: { day: token.date, workspace: token.workspace, task: token.task },
      money: { day: money.day, unpricedCalls, currencies: money.currencies, limits: { workspace: limit('workspace'), task: taskId ? limit('task') : null } },
      model: settings ? { model: settings.model, protocol: settings.protocol, harness: settings.harness } : null, profiles,
      tasks: [...(taskId ? [this.runtime.tasks.get(taskId)] : []), ...Object.values(this.runtime.store.state.tasks || {}).filter(task => task.id !== taskId)].slice(0,200).map(task => ({ id: task.id, title: String(task.subject || task.request?.text || task.id).slice(0,160), status: task.status })) };
  }
  configureToken(input) {
    plain(input, ['scope','taskId','tokens']); const scope = this.scope(input);
    if (!Object.hasOwn(input, 'tokens')) throw invalid('Supply a token count or explicit null for unlimited.');
    this.runtime.tokenBudget.setLimit({ ...scope, tokens: input.tokens }); this.runtime.kick();
    return this.describe(scope.taskId);
  }
  configureMoney(input) {
    plain(input, ['scope','taskId','currency','micros','expectedVersion']); const scope = this.scope(input);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw invalid('Reload the current money limit version before saving.');
    // Limit and durable wake are one committed configuration fact.
    this.database.atomic(() => {
      if (input.micros !== null) {
        const conflicts = this.database.db.prepare("SELECT scope FROM money_budget_limits WHERE kind='model' AND micros IS NOT NULL AND currency!=? AND (scope='workspace' OR ?='workspace') AND NOT(scope=? AND scope_id=?)").get(input.currency, scope.scope, scope.scope, scope.taskId || '');
        if (conflicts) throw durableError('MONEY_CURRENCY_CONFLICT', 'Active workspace and task budgets must use the same currency. Disable conflicting limits before changing currency; no exchange conversion is performed.', 409);
      }
      const result = this.money.configureLimit({ ...scope, currency: input.currency, micros: input.micros, expectedVersion: input.expectedVersion });
      this.runtime.jobs.startBudgetWake({ key: `model-money-control:${createHash('sha256').update(JSON.stringify([scope.scope,scope.taskId,result.version])).digest('hex')}`, kind: 'model', taskId: scope.taskId });
    });
    this.runtime.kick(); return this.describe(scope.taskId);
  }
  configureProfile(input) {
    plain(input, ['connection','currency','revision','rates','expectedVersion','confirmed']);
    if (input.confirmed !== true) throw durableError('MODEL_PRICE_CONFIRMATION_REQUIRED', 'Confirm all four prices before saving. Missing prices are unknown, never free.', 403);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw invalid('Reload the current price version before saving.');
    if (input.connection) plain(input.connection, ['baseUrl','model','apiKey','harness','protocol']);
    const previous = this.currentSettings() || {};
    const { apiKey: _privateKey, ...previousFields } = previous;
    const settings = normalizeModelSettings({ ...previousFields, ...input.connection }, previous);
    const providerId = modelProviderIdentity(this.database, settings), service = new ModelMoneyService(this.database, { providerId });
    service.attachWakeQueue(this.runtime.jobs);
    let saved;
    try {
      saved = service.configureProfile({ providerId, model: settings.model, protocol: settings.protocol, currency: input.currency,
        revision: input.revision, rates: input.rates }, { expectedVersion: input.expectedVersion });
    } catch (error) {
      if (error.code === 'MONEY_BUDGET_CONFLICT') {
        const current = this.database.db.prepare('SELECT profile_json,version FROM model_price_snapshots WHERE provider_id=? AND model=? AND protocol=? AND currency=?').get(providerId, settings.model, settings.protocol, input.currency);
        if (current) error.currentProfile = profileView(JSON.parse(current.profile_json), current.version);
      }
      throw error;
    }
    this.runtime.kick();
    return { profile: profileView(saved.profile, saved.version), savedFor: { baseUrl: settings.baseUrl, model: settings.model, protocol: settings.protocol }, controls: this.describe() };
  }
}
