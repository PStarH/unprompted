const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const sources = new Set(['google','github','microsoft','slack','notion','todoist']);
/** Compact status only; the existing connection form retains all consent. */
export function sourceRepairMarkup(id, source, { language = 'zh', selected = false, externallyConfigured = false } = {}) {
  if (!sources.has(id) || !source?.connected || !source.repair) return '';
  const t = (zh, en) => language === 'en' ? en : zh;
  const { code, action } = source.repair;
  let message = '', button = '';
  if (code === 'SOURCE_API_DISABLED') {
    message = t('请在服务商控制台启用所需 API，然后重新检查连接。', 'Enable the required API in the provider console, then check the connection again.');
  } else if (action === 'reauthorize') {
    message = t('授权已失效或缺少所需权限。重新授权后继续观察。', 'Authorization expired or lacks required access. Reauthorize to resume observation.');
    if (externallyConfigured) message = t('请更新启动配置中的授权，然后重启本地服务。', 'Update authorization in the launch configuration, then restart the local service.');
    else if (id === 'google') button = `<button type="button" class="text-button" data-google-reconnect>${t('重新授权','Reauthorize')}</button>`;
    else if (!selected) button = `<button type="button" class="text-button" data-select-connection="${id}">${t('重新授权','Reauthorize')}</button>`;
  } else if (action === 'wait') {
    message = t('服务商正在限流，稍后会自动重试。', 'The provider is rate limiting requests. Observation will retry later.');
    const retryAt = typeof source.retryAt === 'string' && Number.isFinite(Date.parse(source.retryAt)) ? source.retryAt : null;
    if (retryAt) message += ` ${t('最早重试时间：','Earliest retry: ')}${retryAt}`;
  } else if (action === 'retry') {
    message = t('暂时无法完成观察。连接恢复后重试。', 'Observation could not complete. Retry when the connection recovers.');
    button = `<button type="button" class="text-button" data-sync-now>${t('重新检查','Check again')}</button>`;
  }
  return message ? `<div class="connection-issue" data-source-repair="${escape(code)}"><p role="status">${escape(message)}</p>${button}</div>` : '';
}
