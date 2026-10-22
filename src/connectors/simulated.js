import { Connector } from './connector.js';
import { normalizeEvent } from './events.js';

/**
 * Simulated connector.
 *
 * Produces deterministic regression scenarios through the same normalized event
 * interface a live connector uses, so the reasoning pipeline is exercised
 * identically. Events are always labelled `source: 'simulated'` and the
 * interface says so; nothing here is presented as a real external operation.
 *
 * Two scenarios:
 *
 *   northstar - the original experiment-shaped request. Kept as the regression
 *               baseline.
 *   beacon    - a deliberately different request: another entity, another
 *               deliverable, another vocabulary, and a document whose title
 *               shares no words with the request. Nothing about it is special
 *               cased in the reasoning code.
 */

const CONNECTOR_ID = 'simulated';

export const SCENARIOS = {
  northstar: {
    label: 'Northstar proposal (experiment results)',
    totalEvents: 6,
    build: buildNorthstar
  },
  beacon: {
    label: 'Beacon reliability report (incident statistics)',
    totalEvents: 6,
    build: buildBeacon
  }
};

export const DEFAULT_SCENARIO = 'northstar';

function buildNorthstar(startedAt) {
  const runDate = new Date(startedAt).toISOString().slice(0, 10);
  const draft = '# Northstar project proposal\n\n## Overview\nA proposal for the Northstar onboarding experiment.\n\n## Next steps\nExperiment results will be added after analysis.';
  const incomplete = `${draft}\n\n## Experiment results\nRun date: ${runDate}\nSample size: 1,200\n\nThe results are still being analyzed.`;
  const complete = `# Northstar project proposal\n\n## Overview\nThis proposal recommends an updated onboarding flow for the Northstar project.\n\n## Latest experiment results\nRun date: ${runDate}\nSample size: 1,200\nControl: 8.1% conversion (600 participants)\nTreatment: 10.4% conversion (600 participants)\nConclusion: The treatment improved conversion by 2.3 percentage points; recommend a monitored rollout.\n\n## Next steps\nReview with the project team before rollout.`;

  const at = delay => new Date(startedAt + delay).toISOString();
  return [
    { delay: 0, event: normalizeEvent({ connectorId: CONNECTOR_ID, source: 'simulated', providerEventId: 'document-initial', type: 'document.modified', at: at(0), payload: { id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal', content: draft, modifiedAt: at(0) } }) },
    { delay: 2400, event: normalizeEvent({ connectorId: CONNECTOR_ID, source: 'simulated', providerEventId: 'email-request', type: 'email.received', at: at(2400), payload: { id: 'mail-northstar-01', threadId: 'thread-northstar-01', from: 'alex@example.test', to: 'maya@example.test', subject: 'Northstar proposal — experiment results', body: 'Hi Maya, please update the Northstar project proposal with the latest experiment results and send me the revised proposal by Friday. I need the sample size, control and treatment conversion results, and your conclusion. Thanks, Alex.', receivedAt: at(2400) } }) },
    { delay: 5500, event: normalizeEvent({ connectorId: CONNECTOR_ID, source: 'simulated', providerEventId: 'unrelated-edit', type: 'document.modified', at: at(5500), payload: { id: 'ops-notes', kind: 'notes', title: 'Operations handoff notes', content: '# Operations handoff\n\nUpdated the office access checklist. No proposal here.', modifiedAt: at(5500) } }) },
    { delay: 9000, event: normalizeEvent({ connectorId: CONNECTOR_ID, source: 'simulated', providerEventId: 'document-incomplete', type: 'document.modified', at: at(9000), payload: { id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal', content: incomplete, modifiedAt: at(9000) } }) },
    // The registry publishes the newest completed run. This is the evidence that
    // later lets the system support a "latest results" claim.
    { delay: 12000, event: normalizeEvent({ connectorId: CONNECTOR_ID, source: 'simulated', providerEventId: 'run-completed', type: 'experiment.run.completed', at: at(12000), payload: { id: `run-northstar-${runDate}`, label: `Northstar onboarding A/B (${runDate})`, subjectEntity: 'Northstar', completedAt: at(12000), source: { kind: 'run_registry', id: 'simulated-registry', url: 'https://experiments.example.test/northstar' } } }) },
    { delay: 15000, event: normalizeEvent({ connectorId: CONNECTOR_ID, source: 'simulated', providerEventId: 'document-complete', type: 'document.modified', at: at(15000), payload: { id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal', content: complete, modifiedAt: at(15000) } }) }
  ];
}

/**
 * The unseen scenario.
 *
 * Deliberately shares nothing with Northstar: a different entity (Beacon), a
 * different deliverable (report), different requested content (incident
 * statistics, incident count, mean time to recovery, an assessment of the
 * trend), and a document titled "Production Reliability Review" that contains
 * none of those words in its title. It correlates only because the document body
 * names the entity — the same identity rule that keeps unrelated documents out.
 */
function buildBeacon(startedAt) {
  const asOf = new Date(startedAt).toISOString().slice(0, 10);
  const title = 'Production Reliability Review';
  const draft = `# ${title}\n\n## Overview\nReliability review for the Beacon service covering the last quarter.\n\n## Summary\nThe review is in progress. Figures will be published once the quarter closes.`;
  const incomplete = `# ${title}\n\n## Overview\nReliability review for the Beacon service covering the last quarter.\n\n## Incident statistics\nAs of: ${asOf}\nIncident count: 14\n\n## Summary\nAnalysis is in progress.`;
  const complete = `# ${title}\n\n## Overview\nReliability review for the Beacon service covering the last quarter.\n\n## Incident statistics\nAs of: ${asOf}\nIncident count: 14\nMean time to recovery: 42 minutes\nSeverity breakdown: 3 critical, 5 major, 6 minor\n\n## Assessment\nIncident volume is down 22% quarter over quarter, driven by the database failover fix. Recommend keeping the current on-call rotation.`;

  const at = delay => new Date(startedAt + delay).toISOString();
  return [
    { delay: 0, event: normalizeEvent({ connectorId: CONNECTOR_ID, source: 'simulated', providerEventId: 'beacon-document-initial', type: 'document.modified', at: at(0), payload: { id: 'production-reliability-review', kind: 'report', title, content: draft, modifiedAt: at(0) } }) },
    { delay: 2400, event: normalizeEvent({ connectorId: CONNECTOR_ID, source: 'simulated', providerEventId: 'beacon-email-request', type: 'email.received', at: at(2400), payload: { id: 'mail-beacon-01', threadId: 'thread-beacon-01', from: 'priya@example.test', to: 'maya@example.test', subject: 'Beacon reliability report — incident stats', body: 'Hi Maya, could you refresh the Beacon reliability report with the most recent incident statistics? I need the incident count, mean time to recovery, and your assessment of the trend. Please share it by Thursday. Thanks, Priya.', receivedAt: at(2400) } }) },
    { delay: 5500, event: normalizeEvent({ connectorId: CONNECTOR_ID, source: 'simulated', providerEventId: 'beacon-unrelated-edit', type: 'document.modified', at: at(5500), payload: { id: 'office-move-checklist', kind: 'checklist', title: 'Office move checklist', content: '# Office move checklist\n\nBooked the movers for the 24th. Badge access still to do.', modifiedAt: at(5500) } }) },
    { delay: 9000, event: normalizeEvent({ connectorId: CONNECTOR_ID, source: 'simulated', providerEventId: 'beacon-document-incomplete', type: 'document.modified', at: at(9000), payload: { id: 'production-reliability-review', kind: 'report', title, content: incomplete, modifiedAt: at(9000) } }) },
    { delay: 12000, event: normalizeEvent({ connectorId: CONNECTOR_ID, source: 'simulated', providerEventId: 'beacon-record-published', type: 'record.published', at: at(12000), payload: { id: `incident-review-beacon-${asOf}`, label: `Beacon incident review (${asOf})`, subjectEntity: 'Beacon', completedAt: `${asOf}T12:00:00.000Z`, source: { kind: 'run_registry', id: 'simulated-registry', url: 'https://incidents.example.test/beacon' } } }) },
    { delay: 15000, event: normalizeEvent({ connectorId: CONNECTOR_ID, source: 'simulated', providerEventId: 'beacon-document-complete', type: 'document.modified', at: at(15000), payload: { id: 'production-reliability-review', kind: 'report', title, content: complete, modifiedAt: at(15000) } }) }
  ];
}

/** @deprecated Use buildScenario(startedAt, 'northstar'). */
export function scenario(startedAt) {
  return buildNorthstar(startedAt);
}

export function buildScenario(startedAt, name = DEFAULT_SCENARIO) {
  const entry = SCENARIOS[name] || SCENARIOS[DEFAULT_SCENARIO];
  return entry.build(startedAt);
}

export class SimulatedConnector extends Connector {
  constructor(scenarioName = DEFAULT_SCENARIO) {
    super({ id: CONNECTOR_ID, kind: 'simulated' });
    this.live = false;
    this.scenarioName = scenarioName;
  }

  validate() {
    return { ok: true, missing: [], detail: 'Deterministic local scenario. No credentials required, no external effects.' };
  }

  async pull({ cursor = null } = {}) {
    const startedAt = cursor?.startedAt || Date.now();
    const name = cursor?.scenario || this.scenarioName;
    return { events: buildScenario(startedAt, name), cursor: { startedAt, scenario: name }, errors: [], partial: false };
  }
}

export const simulatedApi = { SCENARIOS, DEFAULT_SCENARIO, buildScenario, scenario, SimulatedConnector, SIMULATED_CONNECTOR_ID: CONNECTOR_ID };
