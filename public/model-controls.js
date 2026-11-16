const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const currencies = ['USD','CNY','EUR'];
const rates = ['input','output','cacheRead','cacheWrite'];
let routing = null;
const stages = ['interpret','discovery','planning','verification','general'];
let generation = 0, loadingGeneration = null;
let cached = null, selectedTask = null, workspace = null, locale = 'zh', connectionChanged = false, conflictProfile = null;
let rendering = null, getConnection = null, bound = false, connectionRevision = 0;
const t = (zh, en) => locale === 'en' ? en : zh;
export function parseMajor(value, { optional = false } = {}) {
  const text = String(value ?? '').trim(); if (optional && text === '') return null;
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw new Error(t('请输入非负金额，最多六位小数。', 'Enter a non-negative amount with at most six decimal places.'));
  const [whole, fraction = ''] = text.split('.'), amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6,'0'));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(t('金额超出支持范围。','The amount exceeds the supported range.'));
  return Number(amount);
}
export function formatMajor(micros) {
  if (micros === null || micros === undefined) return '';
  const value = BigInt(micros), whole = value / 1000000n, fraction = String(value % 1000000n).padStart(6,'0').replace(/0+$/,'');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
const currencyOptions = selected => currencies.map(c => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
const valueLabel = value => value === null || value === undefined ? t('不设上限','Unlimited') : String(value);
function profile(currency, model = null) { model ||= cached?.model?.model; return conflictProfile?.currency === currency && conflictProfile?.model === model ? conflictProfile : !connectionChanged ? cached?.profiles?.find(p => p.currency === currency && p.model === model) : null; }
export function invalidateModelControls() { generation++; cached = null; routing = null; conflictProfile = null; connectionChanged = false; }
export function modelControlsMarkup({ language, workspaceId } = {}) {
  locale = language || locale;
  if (workspace !== workspaceId) { generation++; workspace = workspaceId; cached = null; selectedTask = null; conflictProfile = null; connectionChanged = false; }
  if (!cached) return `<details class="model-advanced model-budget-controls" data-preserve="model-controls"><summary>${t('模型预算与费率','Model budgets and prices')}</summary><p>${t('按工作区或任务限制调用。缺失价格不等于免费。','Limit calls by workspace or task. Missing prices do not mean free usage.')}</p><button type="button" class="text-button" data-model-controls-refresh>${t('载入预算设置','Load budget settings')}</button>${selectedTask ? `<button type="button" class="text-button" data-model-controls-workspace>${t('返回工作区预算','Return to workspace budgets')}</button>` : ''}<p role="status" data-model-controls-load></p></details>`;
  const scope = selectedTask ? 'task' : 'workspace', token = selectedTask ? cached.token.task : cached.token.workspace;
  const money = cached.money.limits[scope], currency = money.currency, bucket = cached.money.currencies.find(b => b.currency === currency)?.[scope];
  const p = profile(currency), names = { input:t('输入','Input'), output:t('输出','Output'), cacheRead:t('缓存读取','Cache read'), cacheWrite:t('缓存写入','Cache write') };
  return `<details class="model-advanced model-budget-controls" data-preserve="model-controls"><summary>${t('模型预算与费率','Model budgets and prices')}</summary>
    <p class="setup-note">${t('每日额度在 UTC 零点重置。0 禁止新增对应的 Token 用量或费用；留空不设上限。未知结果保留账本占用，不会自动退款。','Daily budgets reset at midnight UTC. Zero forbids additional tokens or charges for that limit; blank means unlimited. Unknown outcomes retain ledger holds and are not automatically refunded.')}</p>
    <label>${t('预算范围','Budget scope')}<select data-model-budget-task><option value="">${t('整个工作区','Whole workspace')}</option>${cached.tasks.map(task => `<option value="${escape(task.id)}" ${task.id === selectedTask ? 'selected' : ''}>${escape(task.title)} · ${escape(task.id)}</option>`).join('')}</select></label>
    <form data-model-token-form data-preserve="token-budget:${escape(selectedTask || 'workspace')}"><label>${t('每日 Token 上限','Daily Token limit')}<input name="tokens" type="number" min="0" step="1" value="${escape(token?.limit ?? '')}" placeholder="${t('不设上限','Unlimited')}"></label><p class="setup-note">${t('已结算 / 已预留 / 未知占用','Settled / reserved / unknown holds')}: ${Number(token?.settled || 0)} / ${Number(token?.reserved || 0)} / ${Number(token?.unknown || 0)} · ${t('当前上限','Current limit')}: ${escape(valueLabel(token?.limit))}</p><button class="secondary-button" type="submit">${t('保存 Token 上限','Save Token limit')}</button><p class="model-error" role="alert" data-controls-error hidden></p></form>
    <form data-model-money-form data-preserve="money-budget:${escape(selectedTask || 'workspace')}"><div class="model-fields"><label>${t('币种','Currency')}<select name="moneyCurrency">${currencyOptions(currency)}</select></label><label>${t('每日模型费用上限','Daily model fee limit')}<input name="moneyMajor" inputmode="decimal" value="${escape(formatMajor(money.micros))}" placeholder="${t('不设上限','Unlimited')}"></label></div><p class="setup-note">${escape(currency)} · ${t('已结算 / 已预留 / 未知占用','Settled / reserved / unknown holds')}: ${formatMajor(bucket?.consumedMicros || 0)} / ${formatMajor(bucket?.reservedMicros || 0)} / ${formatMajor(bucket?.unknownMicros || 0)}. ${cached.money.unpricedCalls ? `${t('另有未报价调用，费用未知：','Additional unpriced calls with unknown fees:')} ${Number(cached.money.unpricedCalls)}. ` : ''}${t('以上仅为已报价调用；没有报价的调用不当作免费。不自动换汇，已派发请求无法撤回。','Totals cover priced calls only; unpriced calls are not assumed free. No automatic currency conversion; dispatched calls cannot be recalled.')}</p><button class="secondary-button" type="submit">${t('保存费用上限','Save fee limit')}</button><p class="model-error" role="alert" data-controls-error hidden></p></form>
    <details data-preserve="model-prices"><summary>${t('确认模型费率','Confirm model prices')}</summary><p class="setup-note">${t('适用于上方填写的连接与模型；保存费率不会连接或切换模型。先确认费率，再验证连接。费率单位为每百万 Token 的币种金额；四项都必须填写。','Applies to the connection and model entered above. Saving prices does not connect or switch models. Confirm prices before verifying the connection. Enter currency amounts per million tokens; all four rates are required.')}</p><form data-model-price-form data-preserve="model-prices-form"><label>${t('费率适用模型 ID（留空使用上方模型）','Price model ID (blank uses the model above)')}<input name="priceModel" value="" placeholder="${escape(cached.model?.model || '')}"></label><label>${t('费率币种','Price currency')}<select name="priceCurrency">${currencyOptions(currency)}</select></label><div class="model-fields">${rates.map(name => `<label>${names[name]} / 1M Token<input name="price_${name}" required inputmode="decimal" value="${escape(formatMajor(p?.rates[name]))}" placeholder="${t('未知，需确认','Unknown; confirm price')}"></label>`).join('')}</div><label><input name="priceConfirmed" type="checkbox" required> ${t('我已核对这组连接、模型和四项费率；明确的 0 表示已确认免费。','I checked this connection, model and all four rates. An explicit zero is confirmed free pricing.')}</label><button class="secondary-button" type="submit">${t('确认并保存费率','Confirm and save prices')}</button><p class="model-error" role="alert" data-controls-error hidden></p><p role="status" data-price-status></p></form></details>
    ${routingMarkup()}
    <p role="status" data-model-controls-load></p><button type="button" class="text-button" data-model-controls-refresh>${t('刷新预算与价格','Refresh budgets and prices')}</button></details>`;
}
function routingMarkup() {
  if (!routing) return '';
  const config = routing.config;
  const labels = { interpret:t('理解','Interpret'), discovery:t('发现','Discovery'), planning:t('规划','Planning'), verification:t('核验','Verification'), general:t('其他','General') };
  return `<details data-preserve="model-routing"><summary>${t('按工作阶段选择模型','Choose models by work stage')}</summary><form data-model-routing-form data-preserve="model-routing-form">
  <label><input type="checkbox" name="routingEnabled" ${config ? 'checked' : ''}> ${t('启用模型组（同一个提供方连接）','Enable a model group (one provider connection)')}</label>
  <label>${t('模型 ID，逗号分隔，最多 8 个','Model IDs, comma-separated, up to 8')}<input name="routingModels" value="${escape(config?.modelIds?.join(', ') || '')}"></label>
  <div class="model-fields"><label>${t('默认模型','Default model')}<input name="routingDefault" value="${escape(config?.defaultModel || '')}"></label><label>${t('失败回退模型（可留空）','Fallback model (optional)')}<input name="routingFallback" value="${escape(config?.fallbackModel || '')}"></label><label><input name="routingAllowSecond" type="checkbox" ${routing.requestCallLimit === 2 && routing.maxRpcAttempts === 2 ? 'checked' : ''}> ${t('允许一次额外失败回退（经典单次调用最多2次）','Allow one extra fallback attempt (classic single-call cap: 2)')}</label></div>
  <div class="model-fields">${stages.map(stage=>`<label>${labels[stage]}<input name="route_${stage}" value="${escape(config?.stages?.[stage] || '')}" placeholder="${t('使用默认模型','Use default model')}"></label>`).join('')}</div>
  <p class="setup-note">${t('所有模型继续使用当前来源权限及预算。只有无工具副作用的暂时失败允许一次回退；缺价或额度不足不触发回退。','All models retain current source permissions and budgets. Only transient failures without tool side effects allow one fallback; missing prices or exhausted budgets never trigger fallback.')} ${t('当前每次请求调用上限','Current per-request call cap')}: ${Number(routing.maxCallsPerRequest || 1)}. ${t('未勾选时经典调用上限为1。工具循环仍受原有4轮总上限约束，包含回退请求。','Unchecked keeps the classic call cap at 1. Tool loops keep their existing four-turn total limit, including fallback calls.')}</p>
  <button class="secondary-button" type="submit">${t('保存模型组','Save model group')}</button><p class="model-error" role="alert" data-controls-error hidden></p></form></details>${routingMeasurementsMarkup(routing.measurements)}`;
}
/** Safe aggregate diagnostics only; no conversation or task data is accepted. */
export function routingMeasurementsMarkup(summary, language = locale) {
  const label = (zh,en) => language === 'en' ? en : zh;
  const unknown = label('未知','Unknown'), number = value => value === null || value === undefined ? unknown : escape(value);
  const heading = `<details data-preserve="model-routing-measurements"><summary>${label('路由诊断：模型与阶段观测','Routing diagnostics: model and stage observations')}</summary>`;
  if (!summary?.available) return `${heading}<p class="setup-note">${label('观测暂不可用，模型设置仍可操作。','Observations are currently unavailable; model settings remain usable.')}</p></details>`;
  const totals = summary.totals || {}, groups = Array.isArray(summary.groups) ? summary.groups : [];
  const stages = { interpret:label('理解','Interpret'), discovery:label('发现','Discovery'), planning:label('规划','Planning'), verification:label('核验','Verification'), general:label('其他','General') };
  const status = summary.observationStatus || {}, failures = Number(status.writeFailures || 0);
  return `${heading}<p class="setup-note">${label('累计已记录的真实提供方请求；与上方每日额度分开统计。输出质量需要独立评测。','Recorded provider attempts across configurations; separate from the daily budgets above. Output quality requires separate evaluation.')}</p>
  <p>${label('尝试 / 成功 / 失败','Attempts / successes / failures')}: ${number(totals.attempts)} / ${number(totals.successes)} / ${number(totals.failures)} · ${label('可信 Token 合计','Trusted Token total')}: <span data-known-tokens-total>${number(totals.knownTokens)}</span> · ${label('缺失用量的调用','Calls with unknown usage')}: ${number(totals.usageUnknownCalls)}</p>
  ${groups.length ? `<div tabindex="0" style="max-height:340px;overflow:auto" aria-label="${label('各模型和阶段的观测数据','Observed model and stage data')}"><table><thead><tr><th>${label('实际模型','Wire model')}</th><th>${label('阶段 / 配置版本','Stage / config version')}</th><th>${label('尝试','Attempts')}</th><th>${label('失败','Failures')}</th><th>${label('平均毫秒','Mean ms')}</th><th>${label('可信 Token','Trusted Tokens')}</th><th>${label('未知用量调用','Unknown-usage calls')}</th></tr></thead><tbody>${groups.slice(0,20).map(row=>`<tr><td style="overflow-wrap:anywhere">${escape(row.model)} · ${escape(row.protocol)}</td><td>${escape(stages[row.stage] || row.stage)} / ${number(row.routingVersion)}</td><td>${number(row.attempts)}</td><td>${number(row.failures)}</td><td>${row.avgDurationMs === null || row.avgDurationMs === undefined ? unknown : escape(Math.round(row.avgDurationMs))}</td><td data-known-tokens>${number(row.knownTokens)}</td><td>${number(row.usageUnknownCalls)}</td></tr>`).join('')}</tbody></table></div>` : `<p>${label('暂无调用观测。','No provider attempts recorded yet.')}</p>`}
  ${groups.length > 20 || summary.truncated ? `<p class="setup-note">${label('显示前20组配置与阶段，合计包含全部已记录尝试。','Showing the first 20 configuration/stage groups; totals include all recorded attempts.')}</p>` : ''}
  ${failures ? `<p class="setup-note">${label('观测写入失败，部分统计可能缺失','Observation writes failed; some statistics may be missing')}: ${escape(failures)}${status.lastFailure ? ` · ${escape(status.lastFailure.code)} · ${escape(status.lastFailure.at)}` : ''}</p>` : ''}</details>`;
}
async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method:'POST', headers:{ 'content-type':'application/json', ...(cached?.workspaceToken ? { 'x-unprompted-model-workspace':cached.workspaceToken } : {}) }, body:JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || t('设置未保存，请重试。','Settings were not saved. Try again.')), value);
  return value;
}
export async function refreshModelControls() {
  const epoch=generation; if (loadingGeneration===epoch) return; loadingGeneration=epoch;
  try {
    const [controls, policy]=await Promise.all([request(`/api/model-controls${selectedTask ? `?taskId=${encodeURIComponent(selectedTask)}` : ''}`), request('/api/model-controls/routing')]);
    if(epoch!==generation)return;
    if(controls.workspaceToken!==policy.workspaceToken)throw new Error(t('工作区已改变，请重新载入设置。','The workspace changed. Reload these settings.'));
    cached=controls;routing=policy;rendering?.();
  } catch (error) { if(epoch===generation){const node=document.querySelector('[data-model-controls-load]');if(node)node.textContent=error.message;} }
  finally { if(loadingGeneration===epoch)loadingGeneration=null; }
}
export function bindModelControls({ render, connection }) {
  rendering = render; getConnection = connection; if (bound) return; bound = true;
  document.addEventListener('input', event => {
    if (event.target.closest('[data-model-form]')) {
      connectionRevision++; connectionChanged = true; conflictProfile = null;
      const checkbox = document.querySelector('[data-model-price-form] [name=priceConfirmed]');
      if (checkbox) checkbox.checked = false;
    }
    const priceForm = event.target.closest('[data-model-price-form]');
    if (priceForm && event.target.name !== 'priceConfirmed') priceForm.querySelector('[name=priceConfirmed]').checked = false;
  });
  document.addEventListener('change', async event => {
    if (event.target.matches('[data-model-budget-task]')) { generation++; selectedTask = event.target.value || null; cached = null; rendering?.(); await refreshModelControls(); }
    if (event.target.name === 'moneyCurrency' && event.target.form?.matches('[data-model-money-form]')) event.target.form.elements.moneyMajor.value = '';
    if (['priceCurrency','priceModel'].includes(event.target.name) && event.target.form?.matches('[data-model-price-form]')) {
      const form = event.target.form, p = profile(form.elements.priceCurrency.value, form.elements.priceModel.value.trim() || null);
      for (const name of rates) form.elements[`price_${name}`].value = formatMajor(p?.rates[name]);
      form.elements.priceConfirmed.checked = false;
    }
  });
  document.addEventListener('toggle', event => { if (event.target.matches?.('.model-budget-controls') && event.target.open && !cached) void refreshModelControls(); }, true);
  document.addEventListener('click', event => { if (event.target.closest('[data-model-controls-workspace]')) { generation++; selectedTask=null; cached=null; rendering?.(); void refreshModelControls(); } else if (event.target.closest('[data-model-controls-refresh]')) void refreshModelControls(); });
  document.addEventListener('submit', async event => {
    const form = event.target.closest('[data-model-token-form],[data-model-money-form],[data-model-price-form],[data-model-routing-form]'); if (!form) return;
    event.preventDefault(); const button = form.querySelector('button[type=submit]'), errorNode = form.querySelector('[data-controls-error]');
    const epoch=generation, connectionEpoch=connectionRevision; button.disabled = true; errorNode.hidden = true;
    try {
      if (!cached || cached.taskId !== selectedTask) throw new Error(t('预算范围正在载入，请稍后再保存。','The budget scope is loading. Wait before saving.'));
      const data = new FormData(form), scope = selectedTask ? 'task' : 'workspace', taskId = selectedTask;
      if (form.matches('[data-model-token-form]')) {
        const value = String(data.get('tokens') || '').trim(); if (value && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error(t('Token 上限必须为非负整数。','The Token limit must be a non-negative integer.'));
        const result = await request('/api/model-controls/token-limit', { scope, taskId, tokens:value ? Number(value) : null }); if(epoch===generation){cached = result.controls; rendering?.();}
      } else if (form.matches('[data-model-money-form]')) {
        const result = await request('/api/model-controls/money-limit', { scope, taskId, currency:data.get('moneyCurrency'), micros:parseMajor(data.get('moneyMajor'),{optional:true}), expectedVersion:cached.money.limits[scope].version }); if(epoch===generation){cached=result.controls; rendering?.();}
      } else if (form.matches('[data-model-routing-form]')) {
        const enabled = data.get('routingEnabled') === 'on';
        const config = enabled ? { modelIds:String(data.get('routingModels')).split(',').map(value=>value.trim()).filter(Boolean), defaultModel:String(data.get('routingDefault')).trim(),
          stages:Object.fromEntries(stages.map(stage=>[stage,String(data.get(`route_${stage}`)).trim()]).filter(([,value])=>value)),
          ...(String(data.get('routingFallback')).trim() ? { fallbackModel:String(data.get('routingFallback')).trim() } : {}) } : null;
        const savedRouting = await request('/api/model-controls/routing', { expectedVersion:routing.version, config, requestCallLimit:enabled && data.get('routingAllowSecond') === 'on' ? 2 : 1, maxRpcAttempts:enabled && data.get('routingAllowSecond') === 'on' ? 2 : 1 }); if(epoch===generation){routing=savedRouting;rendering?.();}
      } else {
        const currency = data.get('priceCurrency'), model = String(data.get('priceModel') || '').trim() || cached?.model?.model, current = profile(currency, model);
        let connection = getConnection?.();
        if (String(data.get('priceModel') || '').trim()) connection = { ...connection, model:String(data.get('priceModel')).trim() };
        const result = await request('/api/model-controls/price-profile', { ...(connection ? { connection } : {}), currency, revision:(current?.revision || 0)+1,
          expectedVersion:current?.version || 0, rates:Object.fromEntries(rates.map(name=>[name,parseMajor(data.get(`price_${name}`))])), confirmed:data.get('priceConfirmed') === 'on' });
        if(epoch!==generation || connectionEpoch!==connectionRevision)return; conflictProfile=result.profile; cached=result.controls;
        form.querySelector('[data-price-status]').textContent=t('费率已保存。连接设置未改变；现在可以验证上方的模型连接。','Prices saved. Connection settings are unchanged; you can now verify the model connection above.');
      }
    } catch (error) {
      if(epoch!==generation)return;
      if (error.currentProfile) { conflictProfile=error.currentProfile; error.message += ` ${t('当前已保存费率（输入/输出/缓存读取/缓存写入），请核对后再保存：','Current saved rates (input/output/cache read/cache write); review before saving again:')} ${rates.map(name=>formatMajor(error.currentProfile.rates[name])).join(' / ')}`; }
      errorNode.textContent=error.message; errorNode.hidden=false;
      if (error.code === 'MONEY_BUDGET_CONFLICT' && !error.currentProfile) await refreshModelControls();
    } finally { button.disabled=false; }
  });
}
