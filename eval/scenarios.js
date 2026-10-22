import { emailEvent, documentEvent, recordEvent } from './harness.js';

/**
 * Generalization evaluation suite.
 *
 * Each fixture is a request the reasoning code has never seen, with the
 * evidence conditions that matter. Fixtures are data, not code paths: nothing
 * here is special-cased inside the engine.
 *
 * Expectations are deliberately mixed. Several fixtures assert that the system
 * *refuses* to declare completion, because a withheld conclusion is the correct
 * outcome when evidence is insufficient.
 */

const T0 = '2026-10-16T09:00:00.000Z';
const at = minutes => new Date(Date.parse(T0) + minutes * 60000).toISOString();

export const SCENARIOS = [
  // 1 -------------------------------------------------------------------
  {
    id: 'wording-variation',
    category: 'Different wording for familiar task types',
    why: 'Same kind of request, different verb, deliverable noun and deadline phrasing.',
    events: [
      emailEvent({ id: 'wv-1', subject: 'Aurora onboarding report refresh', at: T0,
        body: 'Could you update the Aurora onboarding report with the newest experiment results and share it before Thursday?' }),
      documentEvent({ eventId: 'wv-1', id: 'aurora-onboarding-report', title: 'Aurora onboarding report', kind: 'report', at: at(10),
        content: '# Aurora onboarding report\n\n## Experiment results\nRun date: 2026-10-14\nSample size: 900\nControl: 12.0% activation\nTreatment: 15.5% activation\nConclusion: Treatment raised activation by 3.5 points.\n' })
    ],
    expect: {
      requestFound: true, entity: 'Aurora', deliverable: 'report', intent: 'update_and_send', deadline: 'Thursday',
      complete: true, status: 'ready_for_approval', outboxCount: 0, justificationsVerbatim: true,
      satisfied: ['control_metric', 'treatment_metric', 'conclusion']
    }
  },

  // 2 -------------------------------------------------------------------
  {
    id: 'new-deliverable-type',
    category: 'New deliverable types not explicitly hard-coded',
    why: '"Playbook" is not in any built-in list; the deliverable noun is derived from the sentence.',
    events: [
      emailEvent({ id: 'nd-1', subject: 'Helios playbook', at: T0,
        body: 'Please update the Helios playbook with the latest incident statistics and share it by Friday.' }),
      documentEvent({ eventId: 'nd-1', id: 'helios-incident-playbook', title: 'Helios incident playbook', kind: 'playbook', at: at(10),
        content: '# Helios incident playbook\n\n## Incident statistics\nAs of: 2026-10-12\nIncident count: 9\nMean time to recovery: 31 minutes\n\n## Escalation\nPage the on-call lead within five minutes of a severity-one alert.\n' })
    ],
    expect: {
      entity: 'Helios', deliverable: 'playbook', complete: true, status: 'ready_for_approval',
      outboxCount: 0, justificationsVerbatim: true, freshness: 'unverified', withheldClaims: ['results_are_latest']
    }
  },

  // 3 -------------------------------------------------------------------
  {
    id: 'multiword-entity',
    category: 'Requests involving different project or entity names',
    why: 'A two-word entity name must be kept whole, not truncated to its last word.',
    events: [
      emailEvent({ id: 'me-1', subject: 'Nimbus Payments quarterly report', at: T0,
        body: 'Please refresh the Nimbus Payments quarterly report with the latest customer feedback and send it by Monday.' }),
      documentEvent({ eventId: 'me-1', id: 'nimbus-payments-quarterly-report', title: 'Nimbus Payments quarterly report', kind: 'report', at: at(10),
        content: '# Nimbus Payments quarterly report\n\n## Customer feedback\nNPS improved to 41 this quarter; the top complaint is settlement delay.\n' })
    ],
    expect: {
      entity: 'Nimbus Payments', deliverable: 'report', complete: true, status: 'ready_for_approval',
      outboxCount: 0, justificationsVerbatim: true
    }
  },

  // 4 -------------------------------------------------------------------
  {
    id: 'different-terminology',
    category: 'Related documents with different terminology',
    why: 'The request is about a "Zephyr incident analysis"; the document is titled "Service Stability Retrospective". It correlates because the body names the entity — not because the words match.',
    events: [
      emailEvent({ id: 'dt-1', subject: 'Zephyr incident analysis', at: T0,
        body: 'Please refresh the Zephyr incident analysis with the most recent outage statistics and share it by Wednesday.' }),
      documentEvent({ eventId: 'dt-1', id: 'service-stability-retrospective', title: 'Service Stability Retrospective', kind: 'report', at: at(10),
        content: '# Service Stability Retrospective\n\n## Overview\nThis retrospective covers the Zephyr service for the last quarter.\n\n## Incident statistics\nAs of: 2026-10-15\nIncident count: 11\nMean time to recovery: 38 minutes\n' })
    ],
    expect: {
      entity: 'Zephyr', documentId: 'service-stability-retrospective', complete: true,
      status: 'ready_for_approval', outboxCount: 0, justificationsVerbatim: true, freshness: 'unverified'
    }
  },

  // 5 -------------------------------------------------------------------
  {
    id: 'wrong-project-lookalike',
    category: 'Similar documents belonging to the wrong project',
    why: 'A document with the same deliverable noun and the same evidence content, but a different entity, must be rejected even though it would satisfy every criterion.',
    events: [
      emailEvent({ id: 'wp-1', subject: 'Aurora onboarding report', at: T0,
        body: 'Please update the Aurora onboarding report with the latest experiment results and send it by Friday.' }),
      documentEvent({ eventId: 'wp-1a', id: 'operations-reliability-review', title: 'Operations Reliability Review', kind: 'report', at: at(10),
        content: '# Operations Reliability Review\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,000\nControl: 9.0% conversion\nTreatment: 9.1% conversion\nConclusion: No measurable change.\n' }),
      documentEvent({ eventId: 'wp-1b', id: 'aurora-onboarding-report', title: 'Aurora onboarding report', kind: 'report', at: at(20),
        content: '# Aurora onboarding report\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n' })
    ],
    expect: {
      complete: true, status: 'ready_for_approval', documentId: 'aurora-onboarding-report',
      unrelatedCount: 1, outboxCount: 0, justificationsVerbatim: true
    }
  },

  // 6 -------------------------------------------------------------------
  {
    id: 'multiple-criteria',
    category: 'Requests with multiple acceptance criteria',
    why: 'Three separate requirements, satisfied by three separate sections. Completion only when all three are met.',
    phases: [
      {
        label: 'only one of three requirements present',
        events: [
          emailEvent({ id: 'mc-1', subject: 'Meridian budget summary', at: T0,
            body: 'Please update the Meridian budget summary with the total costs, the delivery timeline, and the owners.' }),
          documentEvent({ eventId: 'mc-1a', id: 'meridian-budget-summary', title: 'Meridian budget summary', kind: 'summary', at: at(10),
            content: '# Meridian budget summary\n\n## Costs\nTotal costs: 240,000 EUR\n' })
        ],
        expect: {
          complete: false, status: 'waiting_for_information', draftPresent: false,
          unsatisfied: ['timeline', 'owners'], outboxCount: 0
        }
      },
      {
        label: 'all three requirements present',
        events: [
          documentEvent({ eventId: 'mc-1b', id: 'meridian-budget-summary', title: 'Meridian budget summary', kind: 'summary', at: at(20),
            content: '# Meridian budget summary\n\n## Costs\nTotal costs: 240,000 EUR\n\n## Timeline\nDelivery timeline: 2026-11-30\n\n## Owners\nOwners: Ravi Menon (platform), Dana Fox (finance)\n' })
        ],
        expect: {
          complete: true, status: 'ready_for_approval', draftPresent: true, outboxCount: 0,
          justificationsVerbatim: true, directEvidenceCount: 3
        }
      }
    ]
  },

  // 7 -------------------------------------------------------------------
  {
    id: 'latest-qualifier-withheld',
    category: 'Requests containing the qualifier "latest"',
    why: 'No source of truth is connected, so the reply may not claim the metrics are the latest ones.',
    events: [
      emailEvent({ id: 'lq-1', subject: 'Vega status report', at: T0,
        body: 'Please update the Vega status report with the latest metrics and share it by Friday.' }),
      documentEvent({ eventId: 'lq-1', id: 'vega-status-report', title: 'Vega status report', kind: 'report', at: at(10),
        content: '# Vega status report\n\n## Metrics\nMetrics for the current period: uptime 99.95%, error rate 0.4%.\n' })
    ],
    expect: {
      complete: true, status: 'ready_for_approval', freshness: 'unverified',
      withheldClaims: ['results_are_latest'], draftMentionsLatest: false, outboxCount: 0
    }
  },

  {
    id: 'latest-qualifier-supported',
    category: 'Requests containing the qualifier "latest"',
    why: 'The same request, but a registry publication now supports the claim, so it is allowed.',
    events: [
      emailEvent({ id: 'ls-1', subject: 'Vega status report', at: T0,
        body: 'Please update the Vega status report with the latest metrics and share it by Friday.' }),
      documentEvent({ eventId: 'ls-1', id: 'vega-status-report', title: 'Vega status report', kind: 'report', at: at(10),
        content: '# Vega status report\n\n## Metrics\nAs of: 2026-10-16\nMetrics for the current period: uptime 99.95%, error rate 0.4%.\n' }),
      recordEvent({ eventId: 'ls-1', id: 'vega-release-2026-10-16', label: 'Vega release 2026-10-16', subjectEntity: 'Vega', completedAt: '2026-10-16T12:00:00.000Z', at: at(20) })
    ],
    expect: {
      complete: true, status: 'ready_for_approval', freshness: 'verified',
      withheldClaims: [], draftMentionsLatest: true, outboxCount: 0
    }
  },

  // 8 -------------------------------------------------------------------
  {
    id: 'missing-authoritative-evidence',
    category: 'Missing or inaccessible authoritative evidence',
    why: 'First there is no document to read at all, then there is one that simply does not contain the requested content. Neither may be reported as complete.',
    phases: [
      {
        label: 'no document available',
        events: [
          emailEvent({ id: 'mx-1', subject: 'Orion partner report', at: T0,
            body: 'Please update the Orion partner report with the signed partner agreements and send it by Friday.' })
        ],
        expect: {
          complete: false, status: 'waiting_for_information', draftPresent: false,
          completionBlockers: ['no_document'], outboxCount: 0
        }
      },
      {
        label: 'document present but the content is absent',
        events: [
          documentEvent({ eventId: 'mx-1', id: 'orion-partner-report', title: 'Orion partner report', kind: 'report', at: at(10),
            content: '# Orion partner report\n\n## Overview\nThis report is being prepared.\n' })
        ],
        expect: {
          complete: false, status: 'waiting_for_information', draftPresent: false, outboxCount: 0
        }
      }
    ]
  },

  // 9 -------------------------------------------------------------------
  {
    id: 'stale-evidence-withdraws-draft',
    category: 'Contradictory evidence or stale results',
    why: 'A prepared reply is withdrawn without any user instruction when the registry publishes a newer review than the document reports.',
    phases: [
      {
        label: 'current evidence, reply prepared',
        events: [
          emailEvent({ id: 'st-1', subject: 'Lyra reliability report', at: T0,
            body: 'Please update the Lyra reliability report with the most recent incident statistics and share it by Friday.' }),
          documentEvent({ eventId: 'st-1', id: 'lyra-reliability-report', title: 'Lyra reliability report', kind: 'report', at: at(10),
            content: '# Lyra reliability report\n\n## Incident statistics\nAs of: 2026-10-16\nIncident count: 6\nMean time to recovery: 25 minutes\n' }),
          recordEvent({ eventId: 'st-1', id: 'lyra-review-2026-10-16', label: 'Lyra incident review 2026-10-16', subjectEntity: 'Lyra', completedAt: '2026-10-16T12:00:00.000Z', at: at(20) })
        ],
        expect: { complete: true, status: 'ready_for_approval', freshness: 'verified', draftPresent: true, outboxCount: 0 }
      },
      {
        label: 'a newer review is published',
        events: [
          recordEvent({ eventId: 'st-2', id: 'lyra-review-2026-10-20', label: 'Lyra incident review 2026-10-20', subjectEntity: 'Lyra', completedAt: '2026-10-20T12:00:00.000Z', at: at(30) })
        ],
        expect: {
          complete: false, status: 'waiting_for_information', freshness: 'stale',
          draftPresent: false, unknowns: ['stale_results'], outboxCount: 0
        }
      }
    ]
  },

  // 10 ------------------------------------------------------------------
  {
    id: 'ambiguous-candidates',
    category: 'Ambiguous candidate documents',
    why: 'Two documents match equally well. The system must say so rather than pick one.',
    events: [
      emailEvent({ id: 'am-1', subject: 'Atlas proposal', at: T0,
        body: 'Please refresh the Atlas proposal with the latest experiment results and send it by Friday.' }),
      documentEvent({ eventId: 'am-1', id: 'atlas-proposal-draft', title: 'Atlas proposal draft', kind: 'proposal', at: at(10),
        content: '# Atlas proposal draft\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 500\nControl: 5.0% conversion\nTreatment: 6.0% conversion\nConclusion: Treatment improved conversion.\n' }),
      documentEvent({ eventId: 'am-2', id: 'atlas-proposal-revision', title: 'Atlas proposal revision', kind: 'proposal', at: at(20),
        content: '# Atlas proposal revision\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 500\nControl: 5.0% conversion\nTreatment: 6.0% conversion\nConclusion: Treatment improved conversion.\n' })
    ],
    expect: {
      complete: false, status: 'waiting_for_information', draftPresent: false,
      conflicts: ['ambiguous_document'], outboxCount: 0
    }
  },

  // 11 ------------------------------------------------------------------
  {
    id: 'repeated-and-out-of-order-events',
    category: 'Repeated and out-of-order environmental events',
    why: 'A replayed event changes nothing; an older revision arriving later correctly reopens the task.',
    phases: [
      {
        label: 'complete and prepared',
        events: [
          emailEvent({ id: 'ro-1', subject: 'Pulsar experiment report', at: T0,
            body: 'Please update the Pulsar experiment report with the latest experiment results and share it by Friday.' }),
          documentEvent({ eventId: 'ro-1', id: 'pulsar-experiment-report', title: 'Pulsar experiment report', kind: 'report', at: at(10),
            content: '# Pulsar experiment report\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 800\nControl: 7.0% conversion\nTreatment: 8.4% conversion\nConclusion: Treatment improved conversion.\n' })
        ],
        expect: { complete: true, status: 'ready_for_approval', taskCount: 1, outboxCount: 0 }
      },
      {
        label: 'both events replayed verbatim',
        events: [
          emailEvent({ id: 'ro-1', subject: 'Pulsar experiment report', at: T0,
            body: 'Please update the Pulsar experiment report with the latest experiment results and share it by Friday.' }),
          documentEvent({ eventId: 'ro-1', id: 'pulsar-experiment-report', title: 'Pulsar experiment report', kind: 'report', at: at(10),
            content: '# Pulsar experiment report\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 800\nControl: 7.0% conversion\nTreatment: 8.4% conversion\nConclusion: Treatment improved conversion.\n' })
        ],
        expect: { complete: true, status: 'ready_for_approval', taskCount: 1, outboxCount: 0, unrelatedCount: 0 }
      },
      {
        label: 'an older revision arrives out of order',
        events: [
          documentEvent({ eventId: 'ro-2', id: 'pulsar-experiment-report', title: 'Pulsar experiment report', kind: 'report', at: at(30),
            content: '# Pulsar experiment report\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 800\n' })
        ],
        expect: {
          complete: false, status: 'waiting_for_information', draftPresent: false,
          taskCount: 1, outboxCount: 0, unsatisfied: ['control_metric', 'treatment_metric', 'conclusion']
        }
      }
    ]
  },

  // 12 ------------------------------------------------------------------
  {
    id: 'model-unavailable',
    category: 'A temporarily unavailable reasoning model',
    why: 'The model is not configured at all. The deterministic plan still investigates the request, and nothing claims completion.',
    reasoner: { available: false },
    events: [
      emailEvent({ id: 'mu-1', subject: 'Draco vendor report', at: T0,
        body: 'Please update the Draco vendor report with the vendor reconciliation notes and send it by Friday.' }),
      documentEvent({ eventId: 'mu-1', id: 'draco-vendor-report', title: 'Draco vendor report', kind: 'report', at: at(10),
        content: '# Draco vendor report\n\n## Overview\nPending.\n' })
    ],
    expect: {
      requestFound: true, complete: false, status: 'waiting_for_information',
      draftPresent: false, reasoningStatus: null, outboxCount: 0
    }
  },

  {
    id: 'model-call-fails',
    category: 'A temporarily unavailable reasoning model',
    why: 'The model is reachable in principle but the call fails. The failure is recorded as a reasoning failure, never as evidence about the work.',
    reasoner: { fail: new Error('connection refused') },
    events: [
      emailEvent({ id: 'mf-1', subject: 'Draco vendor report', at: T0,
        body: 'Please update the Draco vendor report with the vendor reconciliation notes and send it by Friday.' }),
      documentEvent({ eventId: 'mf-1', id: 'draco-vendor-report', title: 'Draco vendor report', kind: 'report', at: at(10),
        content: '# Draco vendor report\n\n## Overview\nPending.\n' })
    ],
    expect: {
      requestFound: true, complete: false, status: 'waiting_for_information',
      draftPresent: false, reasoningStatus: 'failed', outboxCount: 0
    }
  },

  {
    id: 'model-proposes-valid-probe',
    category: 'A model proposing a justified probe',
    why: 'A model-supplied probe with a verbatim justification is accepted and used to assess the request.',
    reasoner: {
      probes: [{
        concept: 'vendor reconciliation status',
        criterionLabel: 'Vendor reconciliation status',
        provider: 'document_text',
        strategies: ['section_body', 'labelled_value'],
        keywords: ['reconciliation', 'vendor'],
        justification: 'the vendor reconciliation notes',
        expectedEvidence: 'a section stating which vendor invoices have been reconciled',
        constraints: { freshness: false }
      }]
    },
    events: [
      emailEvent({ id: 'mp-1', subject: 'Draco vendor report', at: T0,
        body: 'Please update the Draco vendor report with the vendor reconciliation notes and send it by Friday.' }),
      documentEvent({ eventId: 'mp-1', id: 'draco-vendor-report', title: 'Draco vendor report', kind: 'report', at: at(10),
        content: '# Draco vendor report\n\n## Vendor reconciliation\nThree invoices reconciled; two remain open with Northwind.\n' })
    ],
    expect: {
      complete: true, status: 'ready_for_approval',
      modelSpecs: ['model-vendor-reconciliation-status'], justificationsVerbatim: true, outboxCount: 0
    }
  },

  {
    id: 'model-invents-justification',
    category: 'A model inventing a justification',
    why: 'The quoted span does not appear in the request, so the proposal is rejected and the reason is recorded.',
    reasoner: {
      probes: [{
        concept: 'vendor reconciliation status',
        criterionLabel: 'Vendor reconciliation status',
        provider: 'document_text',
        strategies: ['section_body'],
        keywords: ['reconciliation'],
        justification: 'the vendor reconciliation notes and all supporting evidence',
        expectedEvidence: 'a reconciliation section',
        constraints: { freshness: false }
      }]
    },
    events: [
      emailEvent({ id: 'mi-1', subject: 'Draco vendor report', at: T0,
        body: 'Please update the Draco vendor report with the vendor reconciliation notes and send it by Friday.' }),
      documentEvent({ eventId: 'mi-1', id: 'draco-vendor-report', title: 'Draco vendor report', kind: 'report', at: at(10),
        content: '# Draco vendor report\n\n## Vendor reconciliation\nThree invoices reconciled; two remain open with Northwind.\n' })
    ],
    expect: {
      modelSpecs: [], anyRejectedBecauseNotVerbatim: true, justificationsVerbatim: true, outboxCount: 0
    }
  },

  {
    id: 'model-proposes-unsupported-provider',
    category: 'A model proposing an unsafe probe',
    why: 'A probe naming an unregistered provider or strategy must be refused, so a proposal can never widen what the system may read.',
    reasoner: {
      probes: [
        { concept: 'vendor reconciliation status', criterionLabel: 'A', provider: 'the_internet', strategies: ['section_body'], keywords: ['reconciliation'], justification: 'the vendor reconciliation notes', expectedEvidence: 'x' },
        { concept: 'vendor reconciliation status', criterionLabel: 'B', provider: 'document_text', strategies: ['run_shell_command'], keywords: ['reconciliation'], justification: 'the vendor reconciliation notes', expectedEvidence: 'x' }
      ]
    },
    events: [
      emailEvent({ id: 'ms-1', subject: 'Draco vendor report', at: T0,
        body: 'Please update the Draco vendor report with the vendor reconciliation notes and send it by Friday.' }),
      documentEvent({ eventId: 'ms-1', id: 'draco-vendor-report', title: 'Draco vendor report', kind: 'report', at: at(10),
        content: '# Draco vendor report\n\n## Vendor reconciliation\nThree invoices reconciled; two remain open with Northwind.\n' })
    ],
    expect: {
      modelSpecs: [], rejectedProposals: ['provider "the_internet" is not registered', 'unknown strategy: run_shell_command'],
      outboxCount: 0
    }
  },

  // 18 ------------------------------------------------------------------
  {
    id: 'contradictory-evidence',
    category: 'Evidence that contradicts itself',
    why: 'The document states two different incident counts for the same claim. Neither may be chosen: the criterion must be contradictory, completion refused, and the conflict raised as a decision.',
    events: [
      emailEvent({ id: 'ce-1', subject: 'Altair service review', at: T0,
        body: 'Please update the Altair service review with the latest incident statistics and share it by 2026-12-01.' }),
      documentEvent({ eventId: 'ce-1', id: 'altair-service-review', title: 'Altair service review', kind: 'report', at: at(10),
        content: '# Altair service review\n\n## Incident statistics\nAs of: 2026-10-12\nIncident count: 7\nMean time to recovery: 29 minutes\nIncident count: 12\n' })
    ],
    expect: {
      entity: 'Altair', deliverable: 'review', requestFound: true,
      complete: false, status: 'waiting_for_information', draftPresent: false,
      conflictingCriteria: ['incident_stats'], openNotificationKinds: ['risk'],
      outboxCount: 0, justificationsVerbatim: true
    }
  },

  // 19 ------------------------------------------------------------------
  {
    id: 'stalled-request-reaches-the-user',
    category: 'A request that stops making progress',
    why: 'A request that cannot advance on its own must reach the user exactly once instead of waiting forever. The stall window is set to zero so the mechanism is exercised inside the fixture, and the decision withdraws by itself the moment the evidence arrives.',
    engineOptions: { stallAfterMs: 0 },
    phases: [
      {
        label: 'the request arrives with nothing to verify it',
        events: [
          emailEvent({ id: 'sr-1', subject: 'Cygnet migration report', at: T0,
            // Far deadline so this fixture measures the stall path, not deadline pressure.
            body: 'Please update the Cygnet migration report with the newest experiment results and share it by 2026-12-01.' })
        ],
        expect: {
          requestFound: true, complete: false, status: 'waiting_for_information',
          openNotificationKinds: ['blocker'], openNotificationCount: 1, outboxCount: 0
        }
      },
      {
        label: 'the evidence arrives and the decision is withdrawn',
        events: [
          documentEvent({ eventId: 'sr-1', id: 'cygnet-migration-report', title: 'Cygnet migration report', kind: 'report', at: at(10),
            content: '# Cygnet migration report\n\n## Experiment results\nRun date: 2026-10-14\nSample size: 900\nControl: 12.0% activation\nTreatment: 15.5% activation\nConclusion: Treatment raised activation by 3.5 points.\n' })
        ],
        expect: {
          complete: true, status: 'ready_for_approval', draftPresent: true,
          openNotificationCount: 0, outboxCount: 0
        }
      }
    ]
  },

  // 20 ------------------------------------------------------------------
  {
    id: 'deadline-pressure-raises-a-decision',
    category: 'A close deadline that is not yet met',
    why: 'A key deadline near arrival must reach the user once, with the unmet criteria attached, instead of being discovered too late. The date is fixed and already inside the risk window, so the fixture stays deterministic.',
    events: [
      emailEvent({ id: 'dl-1', subject: 'Pegasus pricing memo', at: T0,
        body: 'Please update the Pegasus pricing memo with the current conversion numbers and share it by 2026-10-18.' })
    ],
    expect: {
      requestFound: true, complete: false, status: 'waiting_for_information',
      deadline: '2026-10-18',
      openNotificationKinds: ['deadline'], openNotificationCount: 1, outboxCount: 0
    }
  },

  // 21 ------------------------------------------------------------------
  {
    id: 'recurring-freshness-gap-becomes-an-opportunity',
    category: 'A gap that keeps recurring',
    why: 'One withheld claim is a task still gathering evidence; the same gap on a second request for the same entity is a missing source of truth. It is raised once, with its evidence and a bounded next step, and the repeated flow asks for permission — both without acting.',
    events: [
      emailEvent({ id: 'rf-1', subject: 'Vega status report', at: T0,
        body: 'Please update the Vega status report with the latest metrics and share it by Friday.' }),
      documentEvent({ eventId: 'rf-1', id: 'vega-status-report', title: 'Vega status report', kind: 'report', at: at(10),
        content: '# Vega status report\n\n## Metrics\nMetrics for the current period: uptime 99.95%, error rate 0.4%.\n' }),
      emailEvent({ id: 'rf-2', subject: 'Vega status report', at: at(20),
        body: 'Please update the Vega status report with the latest metrics and share it by Friday.' })
    ],
    expect: {
      complete: true, status: 'ready_for_approval', freshness: 'unverified',
      openNotificationKinds: ['opportunity', 'permission'], openNotificationCount: 2, outboxCount: 0
    }
  },

  // 22 ------------------------------------------------------------------
  {
    id: 'content-from-incidental-wording',
    category: 'Content introduced by non-standard wording',
    why: '“incorporating the latest customer feedback” is not phrased as a with-list item, so the requested content has to be derived from the sentence itself. The first phase shows the requirement is verifiable (absent ⇒ unsatisfied); the second shows “latest” is actually checked against the registry before it may be claimed.',
    phases: [
      {
        label: 'the feedback is not in the presentation yet',
        events: [
          emailEvent({ id: 'cw-1', subject: 'Northstar presentation', at: T0,
            body: 'Please prepare a short presentation for Northstar incorporating the latest customer feedback and share it by Friday.' }),
          documentEvent({ eventId: 'cw-1', id: 'northstar-presentation', title: 'Northstar presentation', kind: 'presentation', at: at(10),
            content: '# Northstar presentation\n\n## Agenda\nRollout plan and next steps.\n' })
        ],
        expect: {
          requestFound: true, entity: 'Northstar', deliverable: 'presentation',
          complete: false, status: 'waiting_for_information', draftPresent: false,
          unsatisfied: ['customer_feedback'], outboxCount: 0, justificationsVerbatim: true
        }
      },
      {
        label: 'the feedback arrives, and a registry publication supports “latest”',
        events: [
          documentEvent({ eventId: 'cw-2', id: 'northstar-presentation', title: 'Northstar presentation', kind: 'presentation', at: at(20),
            content: '# Northstar presentation\n\n## Agenda\nRollout plan and next steps.\n\n## Customer feedback\nAs of: 2026-10-16\nNPS improved to 44; settlement delay remains the top complaint.\n' }),
          recordEvent({ eventId: 'cw-2', id: 'northstar-release-2026-10-16', label: 'Northstar release 2026-10-16', subjectEntity: 'Northstar', completedAt: '2026-10-16T12:00:00.000Z', at: at(30) })
        ],
        expect: {
          complete: true, status: 'ready_for_approval', draftPresent: true,
          freshness: 'verified', withheldClaims: [], draftMentionsLatest: true, outboxCount: 0
        }
      }
    ]
  },

  // 23 ------------------------------------------------------------------
  {
    id: 'completeness-qualifier-withholds-until-stated',
    category: 'Requests with a completeness qualifier',
    why: '“from all reviewers” is a real constraint: comments from some reviewers must not be reported as covering all of them. The document itself has to state the coverage before a reply may be prepared.',
    phases: [
      {
        label: 'comments are present but nothing states full coverage',
        events: [
          emailEvent({ id: 'cq-1', subject: 'Aster design brief', at: T0,
            body: 'Please update the Aster design brief with the reviewer comments from all reviewers and send it by Friday.' }),
          documentEvent({ eventId: 'cq-1', id: 'aster-design-brief', title: 'Aster design brief', kind: 'brief', at: at(10),
            content: '# Aster design brief\n\n## Reviewer comments\nDana: tighten the introduction.\nPriya: add the comparison table.\n' })
        ],
        expect: {
          requestFound: true, entity: 'Aster', deliverable: 'brief',
          complete: false, status: 'waiting_for_information', draftPresent: false,
          satisfied: ['reviewer_comments'], unsatisfied: ['coverage:reviewers'],
          outboxCount: 0, justificationsVerbatim: true
        }
      },
      {
        label: 'the brief states the coverage explicitly',
        events: [
          documentEvent({ eventId: 'cq-2', id: 'aster-design-brief', title: 'Aster design brief', kind: 'brief', at: at(20),
            content: '# Aster design brief\n\n## Reviewer comments\nDana: tighten the introduction.\nPriya: add the comparison table.\nMarcus: shorten the appendix.\n\nIncorporated comments from all three reviewers.\n' })
        ],
        expect: {
          complete: true, status: 'ready_for_approval', draftPresent: true,
          satisfied: ['coverage:reviewers'], outboxCount: 0, justificationsVerbatim: true
        }
      }
    ]
  },

  // 24 ------------------------------------------------------------------
  {
    id: 'broad-concept-needs-distinguishing-content',
    category: 'Requests naming specific content through a broad concept',
    why: '“revenue figures” and “the results of the pilot evaluation” both reduce to the broad metrics concept. Content matching only the broad word is not the requested content: the first phase reports it as unproven rather than absent, and the second shows genuinely named content satisfies each requirement.',
    phases: [
      {
        label: 'only generic results content is present',
        events: [
          emailEvent({ id: 'bc-1', subject: 'Zephyr report', at: T0,
            body: 'Please update the Zephyr report with the revenue figures and the results of the pilot evaluation.' }),
          documentEvent({ eventId: 'bc-1', id: 'zephyr-report', title: 'Zephyr report', kind: 'report', at: at(10),
            content: '# Zephyr report\n\n## Results\nConversion improved across the board this quarter.\n' })
        ],
        expect: {
          requestFound: true, complete: false, status: 'waiting_for_information', draftPresent: false,
          unsatisfied: ['metrics', 'metrics-the-results-of-the-pilot-evaluation'], outboxCount: 0
        }
      },
      {
        label: 'the named content arrives',
        events: [
          documentEvent({ eventId: 'bc-2', id: 'zephyr-report', title: 'Zephyr report', kind: 'report', at: at(20),
            content: '# Zephyr report\n\n## Revenue figures\nRevenue: 2.4m USD in Q3, up from 1.9m.\n\n## Pilot evaluation\nEvaluation results: 92% pass rate on 400 cases.\n' })
        ],
        expect: {
          complete: true, status: 'ready_for_approval', draftPresent: true,
          satisfied: ['metrics', 'metrics-the-results-of-the-pilot-evaluation'],
          outboxCount: 0, justificationsVerbatim: true
        }
      }
    ]
  },

  // 25 ------------------------------------------------------------------
  {
    id: 'recipient-phrase-is-not-content',
    category: 'Recipient mentions that are not content',
    why: '“to all reviewers” names recipients, not requested content: it must not become a coverage requirement or a content probe. With nothing verifiable to check, the system prepares nothing rather than treating the sentence as evidence.',
    events: [
      emailEvent({ id: 'rg-1', subject: 'Northstar proposal', at: T0,
        body: 'Please send the Northstar proposal to all reviewers by Friday.' }),
      documentEvent({ eventId: 'rg-1', id: 'northstar-proposal', title: 'Northstar proposal', kind: 'proposal', at: at(10),
        content: '# Northstar proposal\n\n## Summary\nPricing and rollout outline. Final figures are appended below.\n' })
    ],
    expect: {
      requestFound: true, entity: 'Northstar', deliverable: 'proposal',
      complete: false, status: 'waiting_for_information', draftPresent: false,
      specCount: 0, outboxCount: 0, justificationsVerbatim: true
    }
  },

  // 26 ------------------------------------------------------------------
  {
    id: 'approval-completes-the-loop',
    category: 'Approval completes the loop end to end',
    why: 'A complete, directly evidenced request is still not an action. Only the approval boundary executes it, and the completion is verified from the outbox receipt — the same predicate the framework gate reads.',
    approve: true,
    events: [
      emailEvent({ id: 'ap-1', subject: 'Callisto launch checklist', at: T0,
        body: 'Please update the Callisto launch checklist with the reviewer feedback and send it by Friday.' }),
      documentEvent({ eventId: 'ap-1', id: 'callisto-launch-checklist', title: 'Callisto launch checklist', kind: 'checklist', at: at(10),
        content: '# Callisto launch checklist\n\n## Reviewer feedback\nDana: confirm the rollback plan before launch. Priya: sign off the comms timeline.\n' })
    ],
    expect: {
      requestFound: true, complete: true, status: 'ready_for_approval', draftPresent: true,
      satisfied: ['reviewer_comments'], outboxCount: 0, justificationsVerbatim: true
    },
    outcomeExpect: {
      tasks: 1, statuses: ['completed'],
      completed: 1, verifiedComplete: 1, verifiedByReceipt: 1, unverifiedByReceipt: 0
    }
  },

  // 27 ------------------------------------------------------------------
  {
    id: 'competing-sources-disagree',
    category: 'Competing plausible sources',
    why: 'Two documents both pass correlation. The chosen one reports eleven incidents; the other plausible one reports four. Correlation never reads content, so only an independent cross-source check catches the disagreement — the work stops with both readings recorded instead of a draft resting on one of them. When the competing document is revised to agree, the same check resolves the stop without a person doing anything; the second reading is recorded as corroboration.',
    phases: [
      {
        label: 'the competing document disagrees',
        events: [
          emailEvent({ id: 'cs-1', subject: 'Zephyr incident analysis', at: T0,
            body: 'Please update the Zephyr incident analysis with the incident statistics and send it by Friday.' }),
          documentEvent({ eventId: 'cs-1', id: 'zephyr-incident-analysis', title: 'Zephyr incident analysis', kind: 'report', at: at(10),
            content: '# Zephyr incident analysis\n\n## Incident statistics\nIncident count: 11\n' }),
          documentEvent({ eventId: 'cs-1b', id: 'zephyr-retrospective', title: 'Zephyr service retrospective', kind: 'report', at: at(20),
            content: '# Zephyr service retrospective\n\n## Incident statistics\nIncident count: 4\n' })
        ],
        expect: {
          requestFound: true, entity: 'Zephyr', deliverable: 'analysis',
          complete: false, status: 'waiting_for_information', draftPresent: false,
          conflictingCriteria: ['incident_stats'], unsatisfied: ['incident_stats'],
          verificationDepth: 'enhanced',
          verificationPerformed: ['zephyr-retrospective:incident_stats:conflict'],
          outboxCount: 0
        }
      },
      {
        label: 'the competing document is revised to agree',
        events: [
          documentEvent({ eventId: 'cs-2', id: 'zephyr-retrospective', title: 'Zephyr service retrospective', kind: 'report', at: at(30),
            content: '# Zephyr service retrospective\n\n## Incident statistics\nIncident count: 11\n' })
        ],
        expect: {
          complete: true, status: 'ready_for_approval', draftPresent: true,
          satisfied: ['incident_stats'],
          verificationDepth: 'enhanced',
          verificationPerformed: ['zephyr-retrospective:incident_stats:corroborated'],
          outboxCount: 0
        }
      }
    ]
  }
];

export const CATEGORY_COUNT = new Set(SCENARIOS.map(scenario => scenario.category)).size;
export default SCENARIOS;
