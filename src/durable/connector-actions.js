import { readMcpFinancialContract, validMoneyPointer } from '../mcp-financial.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { API_METHODS, PLATFORM_APIS, platformRequest } from '../connectors/platform-api.js';
import { draftReviewToken } from '../draft-review.js';
import { durableError, iso, json, parse } from './database.js';
import { addOperationSources, operationContext } from './reasoning-sessions.js';

const digest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
const deny = (message, code = 'CONNECTOR_AUTHORIZATION_REQUIRED', status = 403) => durableError(code, message, status);
const active = task => task && !task.privacyInvalidated && !task.control?.paused && !['completed', 'cancelled'].includes(task.status);
const TRANSFER_SEMANTICS = ['nonfinancial', 'unknown', 'paid'];
const publicGrant = grant => ({ ...grant, transfer: TRANSFER_SEMANTICS.includes(grant.transfer) ? grant.transfer : 'unknown' });
const transferReview = () => deny('This platform operation may move money and needs explicit user review.', 'TRANSFER_REVIEW_REQUIRED', 403);
const transferAmountRequired = () => deny('The paid contract has no explicit amount at its configured pointer; a missing price is never zero.', 'TRANSFER_AMOUNT_REQUIRED', 422);
const pointerPath = value => typeof value === 'string' && value.length <= 500 && (value === '' || value.startsWith('/')) && !/[\u0000]/.test(value)
  && value.split('/').slice(1).every(part => !/^(?:__proto__|constructor|prototype)$/.test(part.replaceAll('~1', '/').replaceAll('~0', '~')));
const hasPrefix = (path, prefix) => prefix === '/' || path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
const pointer = (value, path) => path === '' ? value : path.split('/').slice(1).reduce((item, key) => { const name = key.replaceAll('~1', '/').replaceAll('~0', '~'); return item != null && typeof item === 'object' && Object.hasOwn(item, name) ? item[name] : undefined; }, value);
const equal = isDeepStrictEqual;

/** General API writes and MCP writes use the same durable execution ledger as
 * existing mail/artifact actions. An API acceptance is not business verification. */
export class ConnectorActions {
  constructor(runtime) { this.runtime = runtime; this.engine = runtime.engine; this.database = runtime.database; this.mcpChecks = new Map(); this.currentChecks = new Map(); this.transferQuotes = new Map(); this.inFlight = new Set(); }
  grants() { return parse(this.database.get('connector_action_grants', '[]')) || []; }
  account(connector) { return String(connector?.account?.id || connector?.config?.accountId || connector?.config?.accountEmail || ''); }
  connector(id) {
    const connector = this.runtime.connectorFor(id);
    return connector?.live && typeof connector.requestApi === 'function' && typeof connector.platformCapabilities === 'function' && PLATFORM_APIS[id] && !this.runtime.privacy.permissionRevoked(id) ? connector : null;
  }
  describe() {
    return { available: true, enabled: !this.engine.policy.shadow,
      platforms: Object.keys(PLATFORM_APIS).flatMap(id => { const connector = this.connector(id); return connector ? [{ connectorId: id, accountId: this.account(connector), api: connector.platformCapabilities(), grantedScopes: connector.scopes || connector.config?.grantedScopes || [] }] : []; }),
      grants: this.grants().map(grant => ({ ...publicGrant(grant), available: this.account(this.connector(grant.connectorId)) === grant.accountId })) };
  }
  createGrant(input, { actor = 'user' } = {}) {
    if (actor !== 'user' || input?.confirmed !== true) throw deny('Confirm which connected account may execute actions.');
    if (Object.keys(input).some(key => !['connectorId', 'methods', 'pathPrefix', 'taskId', 'project', 'confirmed', 'transfer', 'monetaryGrantId', 'amountMicrosPointer','currencyPointer','financialConfirmed'].includes(key))) throw deny('Invalid connector grant.', 'INVALID_CONNECTOR_GRANT', 400);
    const transfer = input.transfer === undefined ? 'unknown' : input.transfer;
    if (!TRANSFER_SEMANTICS.includes(transfer)) throw deny('Declare whether these actions can move money.', 'INVALID_CONNECTOR_GRANT', 400);
    let monetary = {};
    if (transfer === 'paid') {
      if(input.financialConfirmed!==true)throw deny('Confirm the financial amount and currency mapping.', 'INVALID_CONNECTOR_GRANT', 400);
      // The cap and currency come only from a user-issued transaction lease,
      // never from model JSON or the request payload. The user contract maps
      // the amount argument; actual values are rechecked at every step.
      const money = this.runtime.transactionMoney;
      if (!money || typeof money.leaseInfo !== 'function') throw deny('The persistent workspace has no transaction money ledger.', 'MONEY_LEDGER_REQUIRED', 409);
      if (typeof input.monetaryGrantId !== 'string' || !input.monetaryGrantId || input.monetaryGrantId.length > 200) throw deny('Choose a user-issued monetary grant.', 'INVALID_CONNECTOR_GRANT', 400);
      if (!validMoneyPointer(input.amountMicrosPointer) || !validMoneyPointer(input.currencyPointer) || input.currencyPointer===input.amountMicrosPointer) throw deny('Choose an exact amount pointer for this paid contract.', 'INVALID_CONNECTOR_GRANT', 400);
      const lease = money.leaseInfo(input.monetaryGrantId);
      if (!lease || lease.revoked || Date.parse(lease.expiresAt) <= this.database.now()) throw deny('The monetary grant is missing, revoked or expired.', 'MONEY_LEASE_UNAVAILABLE', 409);
      if (lease.scope === 'task' && lease.taskId !== (input.taskId || null)) throw deny('The monetary grant is scoped to a different task.', 'MONEY_LEASE_SCOPE', 409);
      monetary = { monetaryGrantId: lease.grantId, amountMicrosPointer: input.amountMicrosPointer, currencyPointer:input.currencyPointer, monetaryCurrency: lease.currency };
    } else if (input.monetaryGrantId != null || input.amountMicrosPointer != null || input.currencyPointer != null || input.financialConfirmed != null) {
      throw deny('Only a paid contract takes a monetary grant or amount pointer.', 'INVALID_CONNECTOR_GRANT', 400);
    }
    const connector = this.connector(input.connectorId), accountId = this.account(connector);
    if (!connector || !accountId) throw deny('Connect and verify this platform account first.');
    const supportedMethods = connector.platformCapabilities()?.methods || [];
    const methods = input.methods || [...supportedMethods];
    if (!Array.isArray(methods) || !methods.length || methods.some(method => !API_METHODS.includes(method) || !supportedMethods.includes(method))) throw deny('Choose supported API methods.', 'INVALID_CONNECTOR_GRANT', 400);
    const pathPrefix = input.pathPrefix || '/';
    if (typeof pathPrefix !== 'string' || !pathPrefix.startsWith('/') || /[\\?#%\u0000-\u0020]/.test(pathPrefix) || pathPrefix.includes('..') || pathPrefix.length > 2000) throw deny('Use an exact API path prefix.', 'INVALID_CONNECTOR_GRANT', 400);
    for (const field of ['taskId', 'project']) if (input[field] != null && (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 500)) throw deny('Invalid task or project scope.', 'INVALID_CONNECTOR_GRANT', 400);
    const grant = { id: randomUUID(), status: 'active', version: 1, connectorId: connector.id, accountId, methods: [...new Set(methods)], pathPrefix,
      taskId: input.taskId || null, project: input.project || null, transfer, ...monetary, createdBy: 'user', confirmedAt: iso(this.database.now()) };
    return this.database.atomic(() => {
      const grants = this.grants();
      const existing = grants.find(item => item.status === 'active' && equal([item.connectorId,item.accountId,item.methods,item.pathPrefix,item.taskId,item.project,publicGrant(item).transfer,item.monetaryGrantId,item.amountMicrosPointer,item.currencyPointer],
        [grant.connectorId,grant.accountId,grant.methods,grant.pathPrefix,grant.taskId,grant.project,grant.transfer,grant.monetaryGrantId,grant.amountMicrosPointer,grant.currencyPointer]));
      if (existing) return publicGrant(existing);
      if (grants.length >= 100) throw deny('Too many retained platform authorizations.', 'CONNECTOR_GRANT_LIMIT', 400);
      this.database.set('connector_action_grants', json([...grants, grant])); this.database.bump('context_version'); return publicGrant(grant);
    });
  }
  revoke(id) {
    return this.database.atomic(() => { const grants = this.grants(), grant = grants.find(item => item.id === id);
      if (!grant) throw deny('Platform authorization not found.', 'CONNECTOR_GRANT_NOT_FOUND', 404);
      grant.status = 'revoked'; grant.version++; this.database.set('connector_action_grants', json(grants)); this.database.bump('context_version'); return publicGrant(grant);
    });
  }
  covers(grant, task, spec, accountId) {
    // %2F and %2E decode into slashes and dots, so a prefix check after decoding
    // would treat a different path as inside the grant.
    if (typeof spec.path !== 'string' || /%(?:2f|2e)/i.test(spec.path)) return false;
    let path; try { path = decodeURIComponent(spec.path); } catch { return false; }
    return grant.status === 'active' && grant.createdBy === 'user' && grant.confirmedAt && grant.accountId === accountId && grant.connectorId === spec.connectorId
      && grant.methods.includes(spec.method) && hasPrefix(path, grant.pathPrefix) && (!grant.taskId || grant.taskId === task.id) && (!grant.project || grant.project === task.request?.subjectEntity);
  }
  assertTask(taskId, { isCurrent, actor, inputVersion, reviewToken } = {}) {
    const task = this.runtime.tasks.get(taskId);
    if (!active(task) || this.runtime.closed || this.runtime.suspended || this.runtime.tasks.hasPendingSemantic(taskId) || task.inputVersion !== task.processedInputVersion) throw deny('The task or its current context is unavailable.');
    if (actor === 'user') {
      if (inputVersion !== task.inputVersion || reviewToken && reviewToken !== draftReviewToken(task)) throw deny('Refresh the task before executing this action.', 'REVIEW_CHANGED', 409);
    } else if (!isCurrent?.() || !this.runtime.contextReady(taskId)) throw deny('A current task harness and its context are required.');
    return task;
  }
  verification(connector, spec) {
    if (spec == null) return null;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || Object.keys(spec).some(key => !['request', 'status', 'matches'].includes(key))) throw deny('Invalid provider readback.', 'INVALID_VERIFICATION', 400);
    const read = platformRequest(connector.id, spec.request);
    if (read.write || !['GET', 'HEAD'].includes(read.method) || !Number.isInteger(spec.status || 200) || ![200, 201, 204, 404].includes(spec.status || 200)) throw deny('Verification must independently read the provider.', 'INVALID_VERIFICATION', 400);
    if (spec.matches != null && (!Array.isArray(spec.matches) || spec.matches.length > 20 || spec.matches.some(match => !match || !Object.hasOwn(match, 'value') || match.value === undefined || typeof match.pointer !== 'string' || match.pointer && !match.pointer.startsWith('/') || Object.keys(match).some(key => !['pointer', 'value'].includes(key))))) throw deny('Invalid readback assertions.', 'INVALID_VERIFICATION', 400);
    if (!(spec.matches?.length) && spec.status !== 404 && spec.status !== 204) throw deny('Supply the expected provider fields for readback.', 'INVALID_VERIFICATION', 400);
    return spec;
  }
  async lookup(record, receiptId, signal) {
    const connector = this.connector(record.connectorId);
    if (!record.verification || this.account(connector) !== record.accountId) return { status: 'unknown' };
    const spec = record.verification; let read;
    try { read = await connector.requestApi(spec.request, { signal, beforeDispatch: () => { if (connector !== this.connector(record.connectorId) || this.account(connector) !== record.accountId) throw deny('The connected account changed during verification.'); } }); }
    catch (error) { if (spec.status === 404 && error.status === 404) return { status: 'found', receipt: { id: receiptId || record.key, status: 'verified', idempotencyKey: record.key } }; throw error; }
    if (read.status !== (spec.status || 200) || (spec.matches || []).some(match => !equal(pointer(read.body, match.pointer), match.value))) return { status: 'unknown' };
    return { status: 'found', receipt: { id: receiptId || record.key, status: 'verified', idempotencyKey: record.key } };
  }
  authorize({ taskId, provider, tool, actionFamily, resourceId, key, payload, effect }) {
    const task = this.runtime.tasks.get(taskId), request = task?.platformRequests?.find(item => item.key === key);
    if (!active(task) || !request || this.engine.policy.shadow || this.runtime.closed || this.runtime.suspended || request.inputVersion !== task.inputVersion
      || request.privacyEpoch !== task.privacyEpoch || !equal(request.payload, payload) || !equal(request.effect, effect) || request.resourceId !== resourceId || request.provider !== provider.kind || tool !== request.tool) throw deny('The platform action no longer matches its current authorization.');
    if (this.currentChecks.has(key) && this.currentChecks.get(key)() !== true) throw deny('The task execution is no longer current.');
    if (actionFamily === 'connector.request') {
      const connector = this.connector(request.connectorId), spec = platformRequest(request.connectorId, payload.request);
      const grant = this.grants().find(item => item.id === request.grantId);
      if (connector !== provider.connector || !grant || grant.version !== request.grantVersion || !this.covers(grant, task, spec, this.account(connector))) throw deny('The platform account or action scope was revoked.');
      const semantics = publicGrant(grant).transfer;
      if (semantics === 'paid') {
        const quote = this.#paidQuote(task, request, payload);
        return { ...(request.explicit ? { permission: 'user_approved', taskId } : { permission: 'pre_authorized', source: 'user_stated', scope: { entity: request.accountId || request.provider }, taskId }),
          transfer: quote, transferBinding: { mcpSchemaId: null, mcpConnectionId: null } };
      }
      if (!request.explicit && semantics !== 'nonfinancial') throw transferReview();
    } else if (actionFamily === 'mcp.tool') {
      if (this.mcpChecks.get(key)?.() !== true) throw deny('The MCP tool permission or connection changed.');
      if(request.transferSemantics === 'paid') return {permission:'pre_authorized',source:'user_stated',scope:{entity:request.accountId},taskId,transfer:this.#paidQuote(task,request,payload),transferBinding:{mcpSchemaId:request.schemaDigest,mcpConnectionId:request.connectionIdentity}};
    } else throw deny('Unknown platform action.');
    return request.explicit ? { permission: 'user_approved', taskId } : { permission: 'pre_authorized', source: 'user_stated', scope: { entity: request.accountId || request.provider }, taskId };
  }
  #transferCurrent(key, taskId, payload) {
    const task = this.runtime.tasks.get(taskId);
    if (!active(task) || this.engine.policy.shadow || this.runtime.closed || this.runtime.suspended) return false;
    const request = (task.platformRequests || []).find(item => item.key === key);
    if (!request || request.inputVersion !== task.inputVersion || request.privacyEpoch !== task.privacyEpoch || !equal(request.payload, payload)) return false;
    if (this.currentChecks.has(key) && this.currentChecks.get(key)() !== true) return false;
    if (request.family === 'mcp.tool' && this.mcpChecks.get(key)?.() !== true) return false;
    return true;
  }
  #paidQuote(task, request, payload) {
    if(!validMoneyPointer(request.currencyPointer) || !validMoneyPointer(request.amountMicrosPointer))throw deny('Confirm exact amount and currency fields before financial dispatch.','TRANSFER_CONTRACT_REQUIRED',403);
    const money = this.runtime.transactionMoney;
    if (!money || typeof money.issueQuote !== 'function') throw deny('The persistent workspace has no transaction money ledger.', 'MONEY_LEDGER_REQUIRED', 409);
    const amountMicros = pointer(payload, request.amountMicrosPointer);
    // Missing, fractional, negative or out-of-range amounts never become zero.
    if (!Number.isSafeInteger(amountMicros) || amountMicros < 0) throw transferAmountRequired();
    const lease = money.leaseInfo(request.monetaryGrantId);
    if (!lease || lease.revoked || Date.parse(lease.expiresAt) <= this.database.now()) throw deny('The monetary grant is missing, revoked or expired.', 'MONEY_LEASE_UNAVAILABLE', 409);
    if (lease.scope === 'task' && lease.taskId !== task.id) throw deny('The monetary grant is scoped to a different task.', 'MONEY_LEASE_SCOPE', 409);
    if(request.currencyPointer && pointer(payload,request.currencyPointer)!==lease.currency) throw deny('The argument currency differs from the user-issued funds allowance.', 'TRANSFER_CURRENCY_MISMATCH', 422);
    if (this.transferQuotes.get(request.key)?.grantVersion !== lease.version) this.transferQuotes.delete(request.key);
    const cached = this.transferQuotes.get(request.key);
    if (cached) {
      if (cached.amountMicros !== amountMicros || cached.grantId !== lease.grantId || cached.currency !== lease.currency || cached.taskId !== task.id
        || cached.resourceId !== request.resourceId || cached.inputVersion !== task.inputVersion || cached.privacyEpoch !== String(task.privacyEpoch)
        || cached.provider !== request.provider || cached.tool !== request.tool || cached.actionFamily !== request.family) {
        throw deny('The paid action changed after its quote was issued.', 'TRANSFER_QUOTE_MISMATCH', 409);
      }
      return cached;
    }
    const quote = money.issueQuote({
      provider: request.provider, tool: request.tool, actionFamily: request.family, grantId: lease.grantId,
      taskId: task.id, currency: lease.currency, amountMicros, resourceId: request.resourceId,
      inputVersion: task.inputVersion, privacyEpoch: task.privacyEpoch, payload, effect: request.effect,
      mcpSchemaId:request.family === 'mcp.tool' ? request.schemaDigest : null, mcpConnectionId:request.connectionIdentity || null,
      quoteExpiresAt: new Date(Math.min(Date.parse(lease.expiresAt), this.database.now() + 60000)).toISOString()
    }, { isCurrent: () => this.#transferCurrent(request.key, task.id, payload) });
    this.transferQuotes.set(request.key, quote);
    return quote;
  }
  async dispatch(task, request, provider, send, verify) {
    const previous = this.runtime.ledger.byKey(request.key);
    if (previous && ['accepted', 'verified'].includes(previous.status)) return { state: previous.status, executionId: previous.id, receipt: parse(previous.result_json), alreadyDispatched: true };
    if (previous && !['cancelled', 'failed'].includes(previous.status)) return { state: 'unknown', executionId: previous.id, alreadyDispatched: true, detail: 'Reconcile the existing execution before retrying.' };
    if (!(task.platformRequests || []).some(item => item.key === request.key)) {
      if ((task.platformRequests || []).length >= 100) throw deny('This task reached its platform-action limit.', 'PLATFORM_ACTION_LIMIT', 400);
      this.engine.store.mutate(state => { state.tasks[task.id].platformRequests = [...(state.tasks[task.id].platformRequests || []), request]; });
    }
    const receipt = await this.runtime.external({ ...task, ...(request.explicit ? { action: { permission: 'user_approved', inputVersion: task.inputVersion } } : { action: null }) }, {
      provider, tool: request.tool, actionFamily: request.family, resourceId: request.resourceId, key: request.key, payload: request.payload, effect: request.effect, deferDispatch: true, send, verify
    });
    const execution = this.runtime.ledger.byKey(request.key);
    if(request.transferSemantics === 'paid' && !verify) {
      const money=this.database.db.prepare('SELECT money_attempt_id FROM execution_money_bindings WHERE execution_id=? ORDER BY attempt_number DESC LIMIT 1').get(execution.id);
      if(money && this.runtime.transactionMoney.attemptInfo(money.money_attempt_id)?.state==='dispatched') this.runtime.transactionMoney.markUnknownAttempt(money.money_attempt_id);
    }
    this.engine.changed();
    return { state: execution.status, executionId: execution.id, receipt, verified: execution.status === 'verified' };
  }
  async request(taskId, input, context = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['connectorId', 'request', 'verification', 'operationId', 'inputVersion', 'confirmed', 'reviewToken'].includes(key))) throw deny('Invalid platform action.', 'INVALID_PLATFORM_ACTION', 400);
    const connector = this.connector(input.connectorId); if (!connector) throw deny('Connect this platform account first.');
    const operation = operationContext();
    const spec = platformRequest(connector.id, input.request), task = this.assertTask(taskId, { ...context, inputVersion: input.inputVersion, reviewToken: input.reviewToken });
    if (!spec.write) return this.runtime.gateway.read(signal => connector.requestApi(input.request, { signal, beforeDispatch: () => { this.assertTask(taskId, { ...context, inputVersion: input.inputVersion }); if (connector !== this.connector(connector.id)) throw deny('The connected account changed.'); } }));
    if (context.actor === 'user' && input.confirmed !== true) throw deny('Confirm this platform operation.');
    const accountId = this.account(connector), grant = this.grants().find(item => this.covers(item, task, spec, accountId));
    if (!grant) throw deny('Allow actions for this account and target before executing.');
    // Transfer semantics come only from the stored user grant; request input
    // cannot declare or override them. Fail closed for model/standing writers.
    const transfer = publicGrant(grant).transfer, disclosure = { semantics: transfer, amount: null };
    // A paid contract carries its own user-issued cap; unknown semantics still
    // need explicit user review and never auto-run from standing authority.
    if (context.actor !== 'user' && transfer === 'unknown') throw transferReview();
    const effectiveOperationId = input.operationId ?? operation?.operationId ?? null;
    if (effectiveOperationId != null && (typeof effectiveOperationId !== 'string' || effectiveOperationId.length > 100)) throw deny('Invalid operation identity.', 'INVALID_PLATFORM_ACTION', 400);
    const verification = this.verification(connector, input.verification);
    const payload = { request: input.request }, effect = { connectorId: connector.id, accountId, requestDigest: digest(payload), verification: verification || null };
    const key = `platform:${digest([task.id,task.inputVersion,connector.id,accountId,payload,verification,effectiveOperationId])}`;
    const provider = { kind: `platform:${connector.id}`, connector, live: true, dispatchGuard: true };
    const record = { key, provider: provider.kind, tool: 'request_api', family: 'connector.request', connectorId: connector.id, accountId,
      grantId: grant.id, grantVersion: grant.version, transferSemantics: transfer,
      ...(transfer === 'paid' ? { amountMicrosPointer: grant.amountMicrosPointer, currencyPointer:grant.currencyPointer, monetaryGrantId: grant.monetaryGrantId, monetaryCurrency: grant.monetaryCurrency } : {}),
      inputVersion: task.inputVersion, privacyEpoch: task.privacyEpoch, payload, effect, verification,
      resourceId: `${connector.id}:${accountId}:${spec.method}:${spec.path}`, explicit: context.actor === 'user',
      ...(operation?.sessionId ? { operationId: operation.operationId } : {}), createdAt: iso(this.database.now()) };
    if (this.inFlight.has(key)) return { state: 'unknown', alreadyDispatched: true, detail: 'This operation is already in progress.', transfer: disclosure };
    this.inFlight.add(key);
    if (context.actor !== 'user') this.currentChecks.set(key, context.isCurrent);
    try { return { ...await this.dispatch(task, record, provider, async (signal, beforeDispatch) => {
      const result = await connector.requestApi(input.request, { signal, beforeDispatch });
      return { id: String(result.body?.id || result.body?.ts || key), idempotencyKey: key, httpStatus: result.status, data: result.body, status: 'accepted' };
    }, verification ? accepted => this.lookup(record, accepted.id) : null), transfer: disclosure }; }
    finally { this.currentChecks.delete(key); this.inFlight.delete(key); this.transferQuotes.delete(key); }
  }
  async mcpWrite({ taskId, serverId, tool, args, isCurrent, check, invoke, transfer, schemaDigest, financialContract=null }) {
    // MCP writes are never explicit user requests, so the transfer decision must
    // come from the manager's schema-bound declaration, never from model args.
    if (!['nonfinancial','paid'].includes(transfer)) throw transferReview();
    const financial=transfer === 'paid' ? readMcpFinancialContract(financialContract,{serverId,tool,schemaDigest}) : null;
    if (typeof schemaDigest !== 'string' || !/^[a-f0-9]{64}$/.test(schemaDigest)) throw deny('The MCP write tool schema is not bound to a transfer contract.');
    const task = this.assertTask(taskId, { isCurrent }), payload = { serverId, tool, args:structuredClone(args) };
    const moneyLease=financial && this.runtime.transactionMoney.leaseInfo(financial.monetaryGrantId);
    if(financial && (!moneyLease || moneyLease.revoked))throw deny('Choose a current user-issued funds allowance.','MONEY_LEASE_UNAVAILABLE',409);
    if (check() !== true) throw deny('The MCP write tool is not currently authorized.');
    const operation = operationContext();
    addOperationSources([{ kind: 'mcp', id: serverId }]);
    const key = `mcp-write:${digest([task.id,task.inputVersion,payload,operation?.operationId || null,schemaDigest])}`, provider = { kind: `mcp:${serverId}`, live: true, dispatchGuard: true };
    const record = { key, provider: provider.kind, tool, family: 'mcp.tool', accountId: serverId, inputVersion: task.inputVersion, privacyEpoch: task.privacyEpoch,
      ...(operation?.sessionId ? { operationId: operation.operationId } : {}),
      resourceId: `${provider.kind}:${tool}`, payload, effect: { serverId, tool, argumentsDigest: digest(args), schemaDigest,...(financial?{connectionIdentity:financial.connectionIdentity}:{}) }, explicit: false, transferSemantics: transfer, schemaDigest,
      ...(financial?{monetaryGrantId:financial.monetaryGrantId,monetaryCurrency:moneyLease.currency,amountMicrosPointer:`/args${financial.amountMicrosPointer}`,currencyPointer:`/args${financial.currencyPointer}`,connectionIdentity:financial.connectionIdentity}:{}), createdAt: iso(this.database.now()) };
    if (this.inFlight.has(key)) return { state: 'unknown', alreadyDispatched: true, detail: 'This operation is already in progress.' };
    this.inFlight.add(key);
    this.mcpChecks.set(key, () => isCurrent() && check());
    try { return await this.dispatch(task, record, provider, async (signal, beforeDispatch) => { const result = await invoke(signal,beforeDispatch); return { id: key, idempotencyKey: key, status: 'accepted', data: result }; }, null); }
    finally { this.mcpChecks.delete(key); this.inFlight.delete(key); this.transferQuotes.delete(key); }
  }
  recoveryProvider(execution) {
    const record = this.runtime.tasks.get(execution.task_id)?.platformRequests?.find(item => item.key === execution.idempotency_key);
    return record?.family === 'connector.request' && record.verification ? { lookup: (_key, options) => this.lookup(record, options.receiptId, options.signal) } : null;
  }
  tools({ taskId, isCurrent = () => false } = {}) {
    const platforms = this.describe().platforms;
    if (!platforms.length) return [];
    return [{ name: 'inspect_platform_access', label: 'Inspect connected platform access', contextProvider: 'workspace', effect: 'read',
      sources: platforms.map(item => ({ kind: 'connector', id: item.connectorId })),
      description: 'List current platform API origins, provider-granted OAuth scopes, and user-granted action scopes. Call before choosing an action; local grants cannot expand provider permissions.',
      parameters: { type: 'object', properties: { connectorId: { type: 'string', enum: platforms.map(item => item.connectorId) } }, additionalProperties: false },
      execute: async (_id, input = {}) => { this.assertTask(taskId, { isCurrent }); const access = this.describe(); return { content: [{ type: 'text', text: json({ ...access, platforms: access.platforms.filter(item => !input.connectorId || item.connectorId === input.connectorId), grants: access.grants.filter(item => !input.connectorId || item.connectorId === input.connectorId) }).slice(0, 12000) }], details: {} }; }
    }, { name: 'platform_api', label: 'Use a connected platform API', contextProvider: 'workspace', effect: 'write', managedOperation: true,
      sources: platforms.map(item => ({ kind: 'connector', id: item.connectorId })),
      description: `Call any API exposed by a connected platform within its actual granted permissions. Reads use current account access; writes require a user-granted account/path scope and are recorded in the execution ledger. Use inspect_platform_access to inspect permissions. Supply independent GET readback assertions where available. An accepted response is not verified completion. Platforms: ${json(platforms.map(item => ({ id: item.connectorId, origin: item.api.origin, grantedScopeCount: item.grantedScopes.length })))}`,
      parameters: { type: 'object', properties: { connectorId: { type: 'string', enum: platforms.map(item => item.connectorId) }, request: { type: 'object', properties: { method: { type: 'string', enum: API_METHODS }, path: { type: 'string' }, origin: { type: 'string' }, query: { type: 'object', additionalProperties: true }, headers: { type: 'object', additionalProperties: { type: 'string' } }, body: {}, bodyEncoding: { type: 'string', enum: ['json','text','form','base64'] }, responseType: { type: 'string', enum: ['json','text','base64'] } }, required: ['path'], additionalProperties: false }, verification: { type: 'object', additionalProperties: true }, operationId: { type: 'string', maxLength: 100 } }, required: ['connectorId','request'], additionalProperties: false },
      execute: async (_id, input, signal) => { signal?.throwIfAborted(); const result = await this.request(taskId, input, { isCurrent: () => isCurrent() && !signal?.aborted }); return { content: [{ type: 'text', text: json(result).slice(0, 12000) }], details: {} }; }
    }];
  }
}
