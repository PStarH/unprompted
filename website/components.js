/* Native, bilingual examples of the product's result and task components.
   All actions are confined to this preview; no provider API is contacted. */
(() => {
  const copy = {
    en: {
      replyTitle: 'Release-plan reply', to: 'To', recipient: 'Jordan · jordan@example.com', subject: 'Subject', subjectText: 'Re: Friday release',
      reply: 'Hi Jordan,\n\nThe release checklist and API tests are checked. Friday remains the target, pending confirmation of the rate-limit fix.\n\nPlease confirm the remaining dependency by Thursday at 16:00.',
      unsent: 'Draft · not sent', approve: 'Approve reply', approved: 'Approved in demo', demoReceipt: 'Demo only · no email sent.',
      briefTitle: 'Product review brief', briefIntro: 'Agenda and open questions for the next review.',
      briefItems: [['Import experience', 'Make progress and errors clear so people don’t repeat an operation.'], ['Release dependencies', 'Confirm the API fix and configuration before committing to a date.'], ['Customer feedback', 'Review the four feedback themes and agree on owners.']],
      briefEnd: 'Open questions: team capacity and when release dependencies will be confirmed.', download: 'Download brief', downloadNote: 'Plain-text brief',
      documentTitle: 'Customer feedback, organized', documentIntro: 'Twelve example feedback entries, grouped into four themes with proposed next steps.',
      themes: [['Import experience', 'Show progress and explain errors.'], ['Search context', 'Include the matching passage.'], ['Member permissions', 'Make the access scope visible.'], ['Repeated notifications', 'Combine updates about the same event.']],
      verified: 'Updated and checked', details: 'See the evidence', evidence: 'The saved document matches the approved changes. All twelve feedback entries are accounted for.',
      attentionTitle: 'Reply to the release plan', attentionBody: 'Release details checked. Reply prepared.', attentionStatus: 'Needs your confirmation', attentionAction: 'Review reply',
      workingTitle: 'Check release dependencies', workingBody: 'Following up on two open items.', workingStatus: 'In motion', waitingTitle: 'Confirm the budget limit', waitingBody: 'Waiting for the answer in the original thread.', waitingStatus: 'Waiting',
      sources: 'Sources', sourcesText: 'Release checklist · API test notes · Original request', example: 'Interactive demo'
    },
    zh: {
      replyTitle: '发布计划回复', to: '收件人', recipient: '林悦 · linyue@example.com', subject: '主题', subjectText: 'Re: 周五发布计划',
      reply: '林悦，你好：\n\n发布清单和 API 测试已核对。周五仍是目标日期，需要先确认限流修复结果。\n\n请在周四 16:00 前确认剩余依赖。',
      unsent: '草稿 · 尚未发送', approve: '批准回复', approved: '演示批准成功', demoReceipt: '仅作演示，未发送邮件。',
      briefTitle: '产品评审简报', briefIntro: '下次评审的议题与待确认事项。',
      briefItems: [['导入体验', '明确进度与异常原因，减少重复操作。'], ['发布依赖', '先确认 API 修复与配置，再确定发布日期。'], ['客户反馈', '核对四类反馈主题，确认后续事项与负责人。']],
      briefEnd: '待确认：本周可投入的人力，以及发布依赖的确认时间。', download: '下载简报', downloadNote: '文本简报',
      documentTitle: '客户反馈，已整理', documentIntro: '将十二条示例反馈归入四个主题，并整理下一步建议。',
      themes: [['导入体验', '展示进度，说明异常原因。'], ['搜索上下文', '显示与结果对应的原文片段。'], ['成员权限', '明确说明当前访问范围。'], ['重复提醒', '合并同一事件的多次更新。']],
      verified: '已更新并核验', details: '查看依据', evidence: '已核对保存后的文档，修改与批准内容一致，十二条反馈均有归类。',
      attentionTitle: '回复发布计划', attentionBody: '发布信息已核对，回复已备好。', attentionStatus: '需要你确认', attentionAction: '查看回复',
      workingTitle: '核对发布依赖', workingBody: '正在跟进两个未关闭事项。', workingStatus: '进行中', waitingTitle: '确认预算上限', waitingBody: '等待原始邮件线程中的答复。', waitingStatus: '等待外部',
      sources: '来源', sourcesText: '发布清单 · API 测试记录 · 原始请求', example: '交互演示'
    }
  };
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  let language = 'en';
  function render(kind, lang = language) {
    const t = copy[lang];
    const source = `<details class="preview-evidence"><summary>${t.sources}</summary><p>${t.sourcesText}</p></details>`;
    if (kind.startsWith('followup-')) {
      const flows = lang === 'zh' ? {
        'followup-change': [['来源更新','发现相关文档发生变化。'],['重新核对','检查已准备的内容是否仍然有效。'],['更新结果','撤回过时内容，保留待确认条件。']],
        'followup-wait': [['缺少答复','记录还需要哪项信息。'],['持续等待','等待原始线程中的新答复。'],['继续处理','新信息到达后重新核对任务。']],
        'followup-resume': [['保存进度','保留任务状态与待办步骤。'],['恢复检查','恢复后检查来源与执行结果。'],['继续推进','从已确认的进度继续处理。']]
      } : {
        'followup-change': [['Source updated','A relevant document changes.'],['Work rechecked','Prepared content is checked again.'],['Result updated','Stale work is withdrawn or revised.']],
        'followup-wait': [['Answer missing','The needed information is recorded.'],['Waiting','The original thread is watched for a reply.'],['Work continues','New information is checked before continuing.']],
        'followup-resume': [['Progress saved','The task state and next steps are kept.'],['Context checked','Sources and outcomes are checked after resuming.'],['Work continues','The task continues from confirmed progress.']]
      };
      return `<article class="preview-continuity" lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><header><span>${lang === 'zh' ? '持续跟进' : 'Continuous follow-through'}</span><span>${t.example}</span></header><ol>${flows[kind].map(([title, body], i) => `<li><span class="continuity-mark" aria-hidden="true">${i < 2 ? '✓' : '→'}</span><h3>${title}</h3><p>${body}</p></li>`).join('')}</ol></article>`;
    }
    if (['attention', 'background', 'waiting'].includes(kind)) {
      const type = kind === 'attention' ? 'attention' : kind === 'background' ? 'working' : 'waiting';
      return `<article class="preview-task preview-task-${type}" lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><div class="preview-task-mark" aria-hidden="true"></div><div class="preview-task-content"><h3>${t[`${type}Title`]}</h3><p>${t[`${type}Body`]}</p><footer><span>${t[`${type}Status`]}</span>${kind === 'attention' ? `<button type="button" data-preview-action="review">${t.attentionAction} ↗</button>` : ''}</footer>${kind === 'attention' ? `<div class="preview-inline-reply" hidden><p>${escape(t.reply).replaceAll('\n', '<br>')}</p><span>${t.unsent}</span></div>` : ''}</div></article>`;
    }
    let body, footer;
    if (kind === 'reply') {
      body = `<dl class="preview-mail-meta"><dt>${t.to}</dt><dd>${t.recipient}</dd><dt>${t.subject}</dt><dd>${t.subjectText}</dd></dl><label class="preview-editor-label"><span class="preview-sr-only">${t.replyTitle}</span><textarea class="preview-editor" aria-label="${t.replyTitle}" data-lenis-prevent>${escape(t.reply)}</textarea></label>`;
      footer = `<span data-preview-receipt>${t.unsent}</span><button type="button" class="preview-primary" data-preview-action="approve">${t.approve} ↗</button>`;
    } else if (kind === 'brief') {
      body = `<div class="preview-document" data-lenis-prevent><p>${t.briefIntro}</p><div class="preview-brief-items">${t.briefItems.map(([title, text], i) => `<section><h4>${i + 1}. ${title}</h4><p>${text}</p></section>`).join('')}</div><p class="preview-document-end">${t.briefEnd}</p></div>`;
      footer = `<span>${t.downloadNote}</span><button type="button" data-preview-action="download">${t.download} ↓</button>`;
    } else {
      body = `<div class="preview-document" data-lenis-prevent><p>${t.documentIntro}</p><dl class="preview-themes">${t.themes.map(([title, text]) => `<div><dt>${title}</dt><dd>${text}</dd></div>`).join('')}</dl><details class="preview-verification"><summary>${t.details}</summary><p>${t.evidence}</p></details></div>`;
      footer = `<span class="preview-verified">✓ ${t.verified}</span><span class="preview-result-label">${t.example}</span>`;
    }
    const title = kind === 'reply' ? t.replyTitle : kind === 'brief' ? t.briefTitle : t.documentTitle;
    return `<article class="preview-output" lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><header><h3>${title}</h3>${source}</header>${body}<footer class="preview-output-footer">${footer}</footer><p class="preview-feedback" role="status"></p></article>`;
  }
  function setLanguage(lang) {
    language = lang;
    document.querySelectorAll('[data-component]').forEach(el => { el.innerHTML = render(el.dataset.component); });
    document.querySelectorAll('[data-preview-language]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.previewLanguage === lang)));
    requestAnimationFrame(() => window.ScrollTrigger?.refresh());
  }
  window.unpromptedComponents = { render, setLanguage, get language() { return language; } };
  document.querySelectorAll('[data-preview-language]').forEach(button => button.addEventListener('click', () => setLanguage(button.dataset.previewLanguage)));
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-preview-action]');
    if (!button) return;
    const host = button.closest('[data-component]');
    const t = copy[language];
    const action = button.dataset.previewAction;
    if (action === 'review') {
      const content = host.querySelector('.preview-inline-reply');
      content.hidden = !content.hidden;
      button.setAttribute('aria-expanded', String(!content.hidden));
      host.closest('.attention-crop')?.classList.toggle('is-expanded', !content.hidden);
    } else if (action === 'approve') {
      host.querySelector('[data-preview-receipt]').textContent = `✓ ${t.approved}`;
      host.querySelector('.preview-feedback').textContent = t.demoReceipt;
      host.querySelector('.preview-editor').readOnly = true;
      button.disabled = true;
      button.textContent = t.approved;
    } else if (action === 'download') {
      const text = [t.briefTitle, t.briefIntro, ...t.briefItems.map(([title, body]) => `${title}\n${body}`), t.briefEnd].join('\n\n');
      const url = URL.createObjectURL(new Blob([text], { type:'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = `unprompted-brief-${language}.txt`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    window.ScrollTrigger?.refresh();
  });
})();
