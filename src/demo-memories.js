/**
 * Deterministic sample data for the demo Memory Space.
 *
 * The first 100 records are the historical demo collection: the same ten
 * project/deliverable scopes and the same texts as before, so existing demo
 * behaviour and browser expectations stay compatible. Records 101-500 add
 * deterministic, representative Memory Space edge cases for service tests:
 * direct facts and preferences, legacy scoped records, isolated records,
 * duplicate text without implied edges, explicit relations, supersession
 * chains, shared sources/tasks, verified lineage, validity windows, and every
 * lifecycle state.
 *
 * All identifiers and timestamps come from fixed constants. Seeding is
 * idempotent, never overwrites an existing record (including a deleted one),
 * and never writes to a workspace that is not in demo mode.
 */

const collections = [
  ['写作与沟通', '邮件与文稿', [
    '先写结论，再补充支持结论的依据。', '给外部客户的邮件控制在三段以内。', '发送前核对姓名、称谓与附件版本。', '涉及承诺时明确时间与责任人。', '中文文稿使用全角标点，数字与单位保持一致。', '复杂安排用项目符号列出，不塞进长句。', '回复争议问题时先复述对方关切。', '周报只保留进展、风险和下一步。', '引用数据时附上来源与统计时间。', '不要把推测写成已经确认的事实。'
  ]],
  ['产品规划', '需求与路线图', [
    '每项需求先说明用户要完成的任务。', '路线图区分已承诺与探索中的工作。', '范围变动时列出新增与移除的事项。', '优先级讨论记录影响范围与依据。', '原型中的模拟能力必须明确标记。', '需求文档保留关键验收条件。', '任务拆分到能够独立验证的交付物。', '风险依赖放在方案旁边，不放在附录末尾。', '同一个问题避免创建重复的跟进事项。', '上线计划中保留回退步骤。'
  ]],
  ['设计规范', '界面与交互', [
    '重要状态同时用文字表达，不只靠颜色。', '默认先展示内容，详情由用户主动展开。', '移动端优先保留主要动作的触达空间。', '同类操作使用一致的名称与位置。', '需要确认的修改给出明确的影响范围。', '加载过程保留当前页面的布局。', '错误提示同时提供恢复入口。', '减少重复标题和解释性段落。', '不要在用户输入时切换视图或抢走焦点。', '动效只用于解释有意义的状态变化。'
  ]],
  ['工程交付', '代码与发布', [
    '修复缺陷时附上可复现条件。', '变更说明优先解释用户可见的行为。', '测试从受影响的最小范围开始。', '上线前核对环境变量与回退配置。', '不要在日志中输出账号密钥。', '保留外部请求的超时与重试边界。', '数据迁移需验证旧记录能够读取。', '失败不能被记录为已核验完成。', '代码评审先检查业务边界，再检查格式。', '依赖更新记录影响与兼容性。'
  ]],
  ['客户协作', '客户跟进', [
    '客户请求先核对原始邮件中的交付要求。', '承诺交付日期前确认团队可用时间。', '对外共享前检查接收方与访问范围。', '同一客户的历史约定保留来源。', '报价说明包含税费与有效期。', '客户反馈区分问题、建议和新需求。', '变更涉及费用时先取得明确确认。', '会议后把责任人和下一步写清楚。', '等待客户回复时保留最近一次联系时间。', '不把内部讨论的草稿当作正式结论。'
  ]],
  ['研究资料', '资料与证据', [
    '研究摘要区分原始证据与个人解读。', '优先引用一手资料。', '记录资料的发布时间与访问时间。', '比较结论时保留样本量与限制。', '互相矛盾的来源不要静默合并。', '过期数据需要重新核对。', '没有足够证据时明确标注不确定性。', '保存关键引用对应的原文位置。', '重复来源归入同一资料组。', '实验结论写明基线与对照条件。'
  ]],
  ['会议安排', '日程与纪要', [
    '会议邀请写明目的与预期决策。', '跨时区安排同时标注双方当地时间。', '没有议题的会议先确认是否需要召开。', '决议与讨论过程分开记录。', '行动项包含责任人和截止时间。', '会议前为参与者提供必要资料。', '时间调整要核对所有参与者的可用性。', '纪要不记录未经确认的承诺。', '取消会议时保留原因与后续安排。', '连续会议之间预留十分钟缓冲。'
  ]],
  ['财务与采购', '预算与供应商', [
    '比较报价时统一币种、税费与数量。', '采购审批保留原始报价文件。', '预算区分一次性费用和经常性费用。', '付款前核对合同中的收款信息。', '超出预算的项目单独列出。', '供应商比较同时考虑交付周期。', '续费事项记录通知期限与取消方式。', '报销材料保留日期、用途和凭证。', '金额汇总保留可追溯的明细。', '涉及银行账号变更时通过独立渠道复核。'
  ]],
  ['个人计划', '生活与出行', [
    '旅行计划优先考虑转乘次数与到达时间。', '预订前核对退改规则。', '行程中为交通延误保留缓冲。', '重要证件记录有效期与办理时限。', '医疗预约只保存明确确认的时间。', '家庭采购先核对已有库存。', '提醒聚焦有截止时间的事项。', '未确认的安排不要写入固定日程。', '比较方案时先列必要条件。', '暂不处理的计划保留为暂停状态。'
  ]],
  ['工作方式', '偏好与边界', [
    '默认把来源访问限制在明确选择的范围。', '共享记忆只用于指定项目与交付物。', '发送或修改外部内容前取得明确授权。', '后台变化不要打断正在进行的编辑。', '同一问题的重复通知合并展示。', '只有重要风险才提升提醒强度。', '停止跟进与删除记录分别处理。', '保留撤销最近一次纠偏的入口。', '偏好变化时允许编辑与删除旧记忆。', '无法确认结果时保留待核实状态。'
  ]]
];

export const DEMO_MEMORY_LIMIT = 500;
export const DEMO_MEMORY_COUNTS = Object.freeze([100, 250, 500]);
export const DEMO_MEMORY_EPOCH = '2026-10-28T09:00:00.000Z';
export const DEMO_MEMORY_ORIGIN = 'demo_preview';
export const DEMO_MEMORY_PREFIX = 'demo-memory-';

const EPOCH = Date.parse(DEMO_MEMORY_EPOCH);
const HOUR = 3_600_000;
const pad = value => String(value).padStart(3, '0');
const demoId = index => `${DEMO_MEMORY_PREFIX}${pad(index)}`;
const timeAt = index => new Date(EPOCH - (index - 1) * HOUR).toISOString();
const projectScope = (entity, deliverable) => ({ type: 'project', key: `${entity}/${deliverable}`, entity, deliverable });
const globalScope = () => ({ type: 'global', key: '*', entity: '全局', deliverable: '所有工作' });
const entityScope = (entity, entityType, key, deliverable = '跨范围协作') => ({ type: 'entity', key, entity, entityType, deliverable });

const people = [
  { entity: '林晨', entityType: 'person', key: 'person:lin-chen' },
  { entity: '陈屿', entityType: 'person', key: 'person:chen-yu' },
  { entity: '北欧客户组', entityType: 'organization', key: 'org:nordic-clients' },
  { entity: '供应商联络', entityType: 'organization', key: 'org:supplier-desk' },
  { entity: '研究合作方', entityType: 'organization', key: 'org:research-partners' }
];

const generatedTexts = [
  '先确认负责人和截止时间，再开始处理。',
  '关键结论附上来源和获取时间。',
  '涉及外部共享时先核对接收范围。',
  '变更前保留可回退的版本。',
  '把未确认的信息标记为待核实。',
  '行动项写明责任人和下一步。',
  '比较方案时先列出必要条件。',
  '重复出现的问题合并为一个跟进项。',
  '发布前核对配置与回退步骤。',
  '数据结论同时保留样本量与限制。',
  '错误提示提供明确的恢复入口。',
  '对外承诺先确认团队可用时间。',
  '重要状态同时用文字说明。',
  '会议邀请写明目的与预期决策。',
  '报价说明包含税费与有效期。',
  '长期未处理的事项保留暂停状态。',
  '引用资料时优先使用一手来源。',
  '评审先检查业务边界，再检查格式。',
  '偏好变化时更新或删除旧记忆。',
  '无法确认结果时保留未核验状态。'
];

const generatedScopes = [
  projectScope('研发平台', '接口设计'), projectScope('增长实验', '实验报告'),
  projectScope('品牌内容', '发布计划'), projectScope('法务合规', '合同审阅'),
  projectScope('数据治理', '指标口径'), projectScope('招聘协作', '面试反馈'),
  projectScope('学习计划', '课程笔记'), projectScope('社区运营', '活动复盘'),
  projectScope('合作伙伴', '联合方案'), projectScope('基础设施', '容量评估'),
  projectScope('安全响应', '事件报告'), projectScope('移动客户端', '版本发布'),
  projectScope('客服支持', '问题汇总'), projectScope('内容审核', '审核记录'),
  projectScope('市场调研', '访谈纪要'), projectScope('知识库', '文档整理'),
  projectScope('周会', '会议纪要'), projectScope('长期维护', '技术债清单')
];

/** The historical first 100 records, unchanged except for deterministic times. */
function baseRecordSpecs() {
  return collections.flatMap(([entity, deliverable, texts], groupIndex) =>
    texts.map((text, itemIndex) => {
      const index = groupIndex * 10 + itemIndex + 1;
      const preference = deliverable === '偏好与边界';
      const direct = groupIndex === 0 || preference;
      const primary = projectScope(entity, deliverable);
      const contexts = [primary];
      // Preferences apply beyond their capture scope, so keep both contexts.
      if (preference) contexts.push(globalScope());
      // Every twentieth record is also attached to a person or organization.
      if (index % 20 === 0) {
        const person = people[(index / 20 - 1) % people.length];
        contexts.push(entityScope(person.entity, person.entityType, person.key));
      }
      return {
        text,
        memoryType: preference ? 'preference' : 'fact',
        descriptor: direct ? 'direct' : 'legacy_scoped',
        status: 'active',
        scope: primary,
        contexts,
        relations: index === 1 ? [{ type: 'related_to', targetIndex: 2 }] : []
      };
    })
  );
}

/**
 * Forty curated records covering every lifecycle state and explicit edge.
 * Indices refer to absolute catalog positions; finalizeRecords resolves them.
 */
function curatedRecordSpecs() {
  return [
    { // 101
      text: '团队默认先确认目标，再开始整理材料。',
      memoryType: 'fact', descriptor: 'direct', scope: globalScope()
    },
    { // 102
      text: '林晨希望所有评审意见先合并成一份清单。',
      memoryType: 'preference', descriptor: 'direct',
      scope: entityScope('林晨', 'person', 'person:lin-chen', '设计评审'),
      createdAt: '2022-03-15T08:30:00.000Z', updatedAt: '2022-03-15T08:30:00.000Z'
    },
    { // 103
      text: '对外沟通默认使用简体中文，除非对方明确要求其他语言。',
      memoryType: 'preference', descriptor: 'direct', scope: globalScope(),
      createdAt: '2023-04-01T09:00:00.000Z', updatedAt: '2023-04-01T09:00:00.000Z'
    },
    { // 104
      text: '每个交付物在提交前保留一份可追溯的版本。',
      memoryType: 'fact', descriptor: 'legacy_scoped', scope: projectScope('交付管理', '版本记录')
    },
    { // 105 - duplicate of 101, deliberately isolated
      text: '团队默认先确认目标，再开始整理材料。',
      memoryType: 'fact', descriptor: 'direct', scope: globalScope()
    },
    { // 106 - duplicate of 101, deliberately isolated
      text: '团队默认先确认目标，再开始整理材料。',
      memoryType: 'fact', descriptor: 'direct',
      scope: entityScope('北欧客户组', 'organization', 'org:nordic-clients', '客户沟通')
    },
    { // 107
      text: '开始整理材料前不需要确认目标，直接执行即可。',
      memoryType: 'fact', descriptor: 'direct', scope: globalScope(),
      relations: [{ type: 'contradicts', targetIndex: 101 }]
    },
    { // 108
      text: '确认目标时同时记录负责人和截止时间。',
      memoryType: 'fact', descriptor: 'direct', scope: globalScope(),
      relations: [{ type: 'related_to', targetIndex: 101 }]
    },
    { // 109 - supersession chain: 109 -> 110 -> 111
      text: '项目复盘默认使用旧版模板。',
      memoryType: 'preference', descriptor: 'legacy_scoped',
      scope: projectScope('项目复盘', '复盘模板'),
      status: 'superseded', supersededBy: 110
    },
    { // 110
      text: '项目复盘默认使用新版模板。',
      memoryType: 'preference', descriptor: 'legacy_scoped',
      scope: projectScope('项目复盘', '复盘模板'),
      status: 'superseded', supersedes: [109], supersededBy: 111
    },
    { // 111
      text: '项目复盘使用当前模板，并附上行动项。',
      memoryType: 'preference', descriptor: 'legacy_scoped',
      scope: projectScope('项目复盘', '复盘模板'),
      status: 'active', supersedes: [110]
    },
    { // 112 - past validity window
      text: '旧版报价单在季度结束前有效。',
      memoryType: 'fact', descriptor: 'direct', scope: projectScope('商务', '报价单'),
      status: 'expired', validUntil: '2026-09-30T00:00:00.000Z'
    },
    { // 113 - future validity window
      text: '当前价格表有效至下一年度。',
      memoryType: 'fact', descriptor: 'direct', scope: projectScope('商务', '价格表'),
      status: 'active', validUntil: '2027-06-30T00:00:00.000Z'
    },
    { // 114
      text: '此提醒规则暂时停用。',
      memoryType: 'preference', descriptor: 'direct', scope: globalScope(),
      status: 'disabled', disabledAt: '2026-09-01T00:00:00.000Z'
    },
    { // 115
      text: '归档的历史偏好仅用于追溯。',
      memoryType: 'preference', descriptor: 'direct', scope: globalScope(),
      status: 'archived', archivedAt: '2026-08-01T00:00:00.000Z'
    },
    { // 116
      text: '这条示例记忆已被删除。',
      memoryType: 'fact', descriptor: 'legacy_scoped', scope: projectScope('示例项目', '示例交付物'),
      status: 'deleted', deletedAt: '2026-09-15T03:00:00.000Z'
    },
    { // 117 - shared source
      text: '共享来源的会议纪要保留原始链接。',
      memoryType: 'fact', descriptor: 'legacy_scoped', scope: projectScope('共享来源', '会议纪要'),
      source: { kind: 'task_memory', id: 'fixture-shared-source', taskId: null, verified: false }
    },
    { // 118 - same shared source
      text: '共享来源的会议纪要同时保留参会人。',
      memoryType: 'fact', descriptor: 'legacy_scoped', scope: projectScope('共享来源', '会议纪要'),
      source: { kind: 'task_memory', id: 'fixture-shared-source', taskId: null, verified: false }
    },
    { // 119 - verified lineage
      text: '已验证的交付摘要包含核验时间。',
      memoryType: 'fact', descriptor: 'legacy_scoped', scope: projectScope('交付验证', '摘要'),
      lineage: { sourceKind: 'task', sourceId: 'fixture-verified-lineage', taskId: 'fixture-verified-lineage', verified: true, verifiedAt: '2026-10-20T06:00:00.000Z' }
    },
    { // 120 - multi-context
      text: '跨项目共享的风险清单每周更新。',
      memoryType: 'fact', descriptor: 'direct', scope: projectScope('跨项目协作', '风险清单'),
      contexts: [projectScope('跨项目协作', '风险清单'), entityScope('林晨', 'person', 'person:lin-chen', '风险评审'), globalScope()]
    },
    { // 121 - overlaps 120 by context, no implied relation
      text: '跨项目共享的风险清单每月更新。',
      memoryType: 'fact', descriptor: 'direct', scope: projectScope('跨项目协作', '风险清单'),
      contexts: [projectScope('跨项目协作', '风险清单'), globalScope()]
    },
    { // 122
      text: '给林晨的更新先写结论，再列待决事项。',
      memoryType: 'preference', descriptor: 'direct',
      scope: entityScope('林晨', 'person', 'person:lin-chen', '邮件与文稿')
    },
    { // 123
      text: '北欧客户组要求报价附上税费明细。',
      memoryType: 'fact', descriptor: 'direct',
      scope: entityScope('北欧客户组', 'organization', 'org:nordic-clients', '预算与供应商')
    },
    { // 124
      text: '默认保留每次修改的可撤销入口。',
      memoryType: 'preference', descriptor: 'direct', scope: globalScope()
    },
    { // 125
      text: '林晨负责设计评审的最终确认。',
      memoryType: 'fact', descriptor: 'direct',
      scope: entityScope('林晨', 'person', 'person:lin-chen', '设计评审')
    },
    { // 126 - duplicates record 002, isolated
      text: '给外部客户的邮件控制在三段以内。',
      memoryType: 'preference', descriptor: 'legacy_scoped', scope: projectScope('外部沟通', '邮件与文稿')
    },
    { // 127 - duplicate of 126 in another scope, isolated
      text: '给外部客户的邮件控制在三段以内。',
      memoryType: 'preference', descriptor: 'legacy_scoped', scope: projectScope('客户协作', '客户跟进')
    },
    { // 128 - contradiction pair
      text: '供应商报价只需比较总价。',
      memoryType: 'fact', descriptor: 'direct', scope: projectScope('采购', '供应商比较'),
      relations: [{ type: 'contradicts', targetIndex: 129 }]
    },
    { // 129
      text: '供应商报价必须拆分税费与交付周期。',
      memoryType: 'fact', descriptor: 'direct', scope: projectScope('采购', '供应商比较'),
      relations: [{ type: 'contradicts', targetIndex: 128 }]
    },
    { // 130
      text: '季度预算在每月第一周复核。',
      memoryType: 'fact', descriptor: 'direct', scope: projectScope('财务', '季度预算'),
      relations: [{ type: 'related_to', targetIndex: 129 }]
    },
    { // 131 - second supersession chain
      text: '旧地址仅用于历史订单。',
      memoryType: 'fact', descriptor: 'direct', scope: projectScope('订单', '收货地址'),
      status: 'superseded', supersededBy: 132
    },
    { // 132
      text: '新地址用于所有当前订单。',
      memoryType: 'fact', descriptor: 'direct', scope: projectScope('订单', '收货地址'),
      status: 'active', supersedes: [131]
    },
    { // 133
      text: '节日提醒规则在下一季度重新启用。',
      memoryType: 'preference', descriptor: 'direct', scope: globalScope(),
      status: 'disabled', disabledAt: '2026-09-10T00:00:00.000Z', validUntil: '2027-03-01T00:00:00.000Z'
    },
    { // 134
      text: '归档来源只用于追溯历史决策。',
      memoryType: 'fact', descriptor: 'direct', scope: projectScope('归档', '历史决策'),
      status: 'archived', archivedAt: '2026-07-01T00:00:00.000Z',
      source: { kind: 'connector', id: 'fixture-archived-source' }
    },
    { // 135 - deleted duplicate pair
      text: '这条重复示例只保留一份有效记录。',
      memoryType: 'fact', descriptor: 'direct', scope: projectScope('示例项目', '去重'),
      status: 'deleted', deletedAt: '2026-09-20T03:00:00.000Z'
    },
    { // 136 - same text as 135, no implied edge
      text: '这条重复示例只保留一份有效记录。',
      memoryType: 'fact', descriptor: 'direct', scope: projectScope('示例项目', '去重')
    },
    { // 137 - shared task source
      text: '共享任务来源保留任务编号。',
      memoryType: 'fact', descriptor: 'legacy_scoped', scope: projectScope('任务来源', '任务记录'),
      source: { kind: 'task', id: 'fixture-shared-task', taskId: 'fixture-shared-task', verified: false }
    },
    { // 138 - same task source
      text: '共享任务来源同时保留负责人。',
      memoryType: 'fact', descriptor: 'legacy_scoped', scope: projectScope('任务来源', '任务记录'),
      source: { kind: 'task', id: 'fixture-shared-task', taskId: 'fixture-shared-task', verified: false }
    },
    { // 139 - verified lineage and future validity
      text: '已验证的旧流程记录保留到下一版本发布。',
      memoryType: 'preference', descriptor: 'legacy_scoped', scope: projectScope('流程', '发布'),
      status: 'active', validUntil: '2027-01-15T00:00:00.000Z',
      source: { kind: 'task', id: 'fixture-verified-lineage', taskId: 'fixture-verified-lineage', verified: true },
      lineage: { sourceKind: 'task', sourceId: 'fixture-verified-lineage', taskId: 'fixture-verified-lineage', verified: true, verifiedAt: '2026-10-21T06:00:00.000Z' }
    },
    { // 140
      text: '独立的全局偏好没有来源和关系。',
      memoryType: 'preference', descriptor: 'direct', scope: globalScope()
    }
  ];
}

/** 360 generated records, unique per scope/template pair. */
function generatedRecordSpecs() {
  const specs = [];
  for (let position = 0; position < 360; position++) {
    const scope = generatedScopes[Math.floor(position / generatedTexts.length)];
    const template = generatedTexts[position % generatedTexts.length];
    const text = `${template.replace(/。$/, '')}（${scope.deliverable}）。`;
    const contexts = [{ ...scope }];
    if (position % 30 === 0) {
      const person = people[Math.floor(position / 30) % people.length];
      contexts.push(entityScope(person.entity, person.entityType, person.key));
    }
    if (position % 45 === 0) contexts.push(globalScope());
    specs.push({
      text,
      memoryType: position % 5 === 0 ? 'preference' : 'fact',
      descriptor: 'legacy_scoped',
      status: 'active',
      scope: { ...scope },
      contexts
    });
  }
  return specs;
}

function finalizeRecords(specs, count) {
  if (specs.length !== DEMO_MEMORY_LIMIT) throw new Error(`Demo memory catalog must contain ${DEMO_MEMORY_LIMIT} records.`);
  const selected = specs.slice(0, count);
  const ids = new Set(selected.map((_, index) => demoId(index + 1)));
  return selected.map((spec, index) => {
    const position = index + 1;
    const at = timeAt(position);
    const descriptor = spec.descriptor || 'legacy_scoped';
    const resolve = targetIndex => demoId(targetIndex);
    return {
      id: demoId(position),
      text: spec.text,
      memoryType: spec.memoryType || 'fact',
      descriptor,
      legacy: descriptor === 'legacy_scoped',
      status: spec.status || 'active',
      scope: spec.scope,
      contexts: spec.contexts || [spec.scope],
      createdAt: spec.createdAt || at,
      updatedAt: spec.updatedAt || spec.createdAt || at,
      deletedAt: spec.deletedAt || null,
      disabledAt: spec.disabledAt || null,
      archivedAt: spec.archivedAt || null,
      validFrom: spec.validFrom || spec.createdAt || at,
      validUntil: spec.validUntil || null,
      source: spec.source || null,
      lineage: spec.lineage || null,
      relations: (spec.relations || [])
        .filter(relation => ids.has(resolve(relation.targetIndex)))
        .map(relation => ({ type: relation.type, targetId: resolve(relation.targetIndex) })),
      supersedes: (spec.supersedes || []).map(resolve).filter(id => ids.has(id)),
      supersededBy: spec.supersededBy && ids.has(resolve(spec.supersededBy)) ? resolve(spec.supersededBy) : null,
      taskId: null,
      origin: DEMO_MEMORY_ORIGIN
    };
  });
}

/**
 * Build deterministic demo descriptors. Counts are 0..500; use
 * DEMO_MEMORY_COUNTS for the representative fixture sizes.
 */
export function createDemoMemoryRecords(count = 0) {
  if (!Number.isInteger(count) || count < 0 || count > DEMO_MEMORY_LIMIT) {
    throw new RangeError(`Demo memory count must be an integer between 0 and ${DEMO_MEMORY_LIMIT}.`);
  }
  return finalizeRecords([...baseRecordSpecs(), ...curatedRecordSpecs(), ...generatedRecordSpecs()], count);
}

/**
 * Seed sample memories into a demo workspace.
 *
 * Records that already exist under their stable ID are left untouched, so an
 * edited or deleted sample never comes back. Non-demo workspaces and invalid
 * counts are ignored. Returns the number of records written.
 */
export function seedDemoMemories(store, { count = 0, demo = false } = {}) {
  if (!demo || !Number.isInteger(count) || count < 1 || count > DEMO_MEMORY_LIMIT) return 0;
  const records = createDemoMemoryRecords(count);
  const missing = records.filter(record => !store.state.taskMemories?.[record.id]);
  if (!missing.length) return 0;
  store.mutate(state => {
    state.taskMemories ||= {};
    for (const record of missing) state.taskMemories[record.id] = {
      id: record.id,
      text: record.text,
      taskId: null,
      origin: DEMO_MEMORY_ORIGIN,
      scope: { entity: record.scope.entity, deliverable: record.scope.deliverable },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt
    };
  });
  return missing.length;
}
