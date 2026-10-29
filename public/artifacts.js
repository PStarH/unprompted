import { preserveInteraction } from './dom-state.js';

export function createArtifactPanel({ context, post, refresh, applyState, notify, language, authorizeGoogle, authorizeSource }) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const t = (zh, en) => language() === 'en' ? en : zh;
  let busy = false;
  const names = { google: 'Gmail', microsoft: 'Outlook', notion: 'Notion', apple_notes: 'Apple Notes' };
  function googleScopeForm(setup) {
    const scopes = setup.google?.requestedScopes || {};
    return `<form data-artifact-scope="google" data-enable-writes="${setup.google?.allowExternalWrites === true}"><input type="hidden" name="readGmail"><input type="hidden" name="gmailDrafts"><input type="hidden" name="observe" ${setup.monitoring?.enabled ? '' : 'disabled'}>${['readDrive', 'docsWrite', 'gmailSend'].filter(name => scopes[name]).map(name => `<input type="hidden" name="${name}">`).join('')}<p class="setup-note">${t('Google 的草稿权限也包含发送能力；产品中的发送仍由独立授权控制。', 'Google’s draft scope also includes sending. Sending in this product remains separately authorized.')}</p><button class="secondary-button" type="submit">${t('授权 Gmail 草稿权限', 'Authorize Gmail drafts')}</button></form>`;
  }
  function render() {
    const { setup } = context(), config = setup?.artifacts;
    let host = document.getElementById('artifactPermissions');
    if (!host) {
      const sources = document.getElementById('connectorContent');
      if (!sources) return;
      host = document.createElement('section'); host.id = 'artifactPermissions'; host.className = 'source-group'; sources.after(host);
    }
    host.hidden = !config?.available;
    if (host.hidden || host.contains(document.activeElement)) return;
    const grants = (config.grants || []).filter(grant => grant.status === 'active');
    const html = `<h3>${t('创建工作成果', 'Create work artifacts')}</h3><p class="setup-note">${t('允许 Agent 把准备好的回复放入草稿箱，或在指定位置创建页面和备忘录。这里的授权不允许发送、删除或覆盖已有内容。共享位置的新内容会对其成员可见。', 'Let the Agent save prepared replies to Drafts, or create pages and notes in selected destinations. This authorization does not permit sending, deleting, or overwriting content. New content in a shared destination is visible to its members.')}</p>
      ${(config.targets || []).map(source => `<details class="connection-advanced" data-preserve="artifact-${esc(source.connectorId)}" data-artifact-source="${esc(source.connectorId)}"><summary>${esc(names[source.connectorId])} · ${esc(source.accountLabel)}</summary>${source.connectorId === 'google' ? googleScopeForm(setup) : source.connectorId === 'microsoft' ? `<form data-artifact-scope="microsoft"><input type="hidden" name="drafts"><input type="hidden" name="observe" ${setup.monitoring?.enabled ? '' : 'disabled'}><p class="setup-note">${t('Microsoft 的 Mail.ReadWrite 权限包含创建、修改和删除邮件；本功能只创建未发送草稿。', 'Microsoft’s Mail.ReadWrite scope includes creating, editing and deleting messages. This feature only creates unsent drafts.')}</p><button class="secondary-button" type="submit">${t('授权 Outlook 草稿权限', 'Authorize Outlook drafts')}</button></form>` : ''}
        ${source.available ? `<form data-artifact-grant-form="${esc(source.connectorId)}"><label class="setup-field">${t('写入位置', 'Destination')}${source.targets?.length ? `<select name="targetId" required>${source.targets.map(target => `<option value="${esc(target.id)}">${esc(target.label)}</option>`).join('')}</select>` : `<input name="targetId" required maxlength="64" placeholder="${t('Notion 父页面 ID', 'Notion parent page ID')}">`}</label><label class="setup-field">${t('限定项目（留空适用于所有任务）', 'Project scope (blank for all tasks)')}<input name="project" maxlength="200" autocomplete="off"></label><label class="setup-toggle"><input name="confirmed" type="checkbox" required><span>${t('允许 Agent 在此位置自动创建工作成果', 'Allow the Agent to create work artifacts here automatically')}</span></label><button class="primary-button" type="submit">${t('保存创建权限', 'Save creation permission')}</button></form>` : `<p class="setup-note">${t('先授予上面的草稿权限，完成后再选择写入位置。', 'Authorize drafts first, then choose the destination.')}</p>`}</details>`).join('')}
      ${grants.length ? `<ul class="native-scope-list">${grants.map(grant => `<li><span>${esc(names[grant.connectorId])} · ${esc(config.targets.find(source => source.connectorId === grant.connectorId)?.targets?.find(target => target.id === grant.targetId)?.label || grant.targetId)}${grant.project ? ` · ${esc(grant.project)}` : ''}${grant.available ? '' : ` · ${t('连接不可用', 'Connection unavailable')}`}</span><button class="text-button" data-artifact-revoke="${esc(grant.id)}">${t('撤销授权', 'Revoke')}</button></li>`).join('')}</ul>` : `<p class="setup-note">${t('尚未授权任何写入位置。', 'No destinations authorized yet.')}</p>`}`;
    preserveInteraction(host, () => { host.innerHTML = html; });
  }
  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!form.matches('[data-artifact-grant-form], [data-artifact-scope]')) return;
    event.preventDefault(); if (busy) return; busy = true;
    const button = form.querySelector('[type="submit"]'); button.disabled = true;
    try {
      if (form.dataset.artifactScope) {
        if (form.dataset.artifactScope === 'google') await authorizeGoogle(form);
        else await authorizeSource('microsoft', form);
      } else {
        const data = new FormData(form);
        const result = await post('/api/artifact-grants', { connectorId: form.dataset.artifactGrantForm, targetId: data.get('targetId'),
          ...(data.get('project')?.trim() ? { project: data.get('project').trim() } : {}), confirmed: data.has('confirmed'), automatic: true });
        applyState(result.state); await refresh();
        notify(t('创建权限已保存。', 'Creation permission saved.'));
      }
    } catch (error) { notify(error.message, true); }
    finally { busy = false; button.disabled = false; render(); }
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-artifact-revoke]');
    if (!button || busy) return; busy = true; button.disabled = true;
    try { const result = await post(`/api/artifact-grants/${encodeURIComponent(button.dataset.artifactRevoke)}/revoke`); applyState(result.state); await refresh(); }
    catch (error) { notify(error.message, true); }
    finally { busy = false; button.disabled = false; render(); }
  });
  return { render };
}
