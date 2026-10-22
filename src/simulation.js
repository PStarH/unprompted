import { emptyState } from './store.js';
import { buildScenario, SCENARIOS, DEFAULT_SCENARIO } from './connectors/simulated.js';

/**
 * Drives a deterministic scenario through the normal event path.
 *
 * This is a scheduler, not a decision maker: it only decides *when* an event
 * arrives. Every event still goes through normalization, deduplication,
 * correlation, assessment and permission checks exactly like a live event, and
 * is labelled `source: 'simulated'` so it is never mistaken for real activity.
 */
export class SimulationController {
  constructor(store, engine) {
    this.store = store;
    this.engine = engine;
    this.timers = [];
  }

  start() {
    this.stop();
    if (!this.store.state.simulation) {
      this.store.mutate(state => {
        state.simulation = {
          startedAt: new Date().toISOString(),
          scenario: DEFAULT_SCENARIO,
          label: SCENARIOS[DEFAULT_SCENARIO].label,
          totalEvents: SCENARIOS[DEFAULT_SCENARIO].totalEvents
        };
      });
      this.engine.changed();
    }
    const { startedAt, scenario: name = DEFAULT_SCENARIO } = this.store.state.simulation;
    const started = Date.parse(startedAt);
    for (const { delay, event } of buildScenario(started, name)) {
      if (this.store.state.events.some(item => item.id === event.id)) continue;
      this.timers.push(setTimeout(() => {
        try {
          this.engine.ingest(event);
        } catch (error) {
          console.error('Simulation event failed:', error.message);
        }
      }, Math.max(0, started + delay - Date.now())));
    }
  }

  stop() { for (const timer of this.timers) clearTimeout(timer); this.timers = []; }

  /** Reset and replay, optionally with a different scenario. */
  reset(scenarioName = null) {
    this.stop();
    const name = SCENARIOS[scenarioName] ? scenarioName : DEFAULT_SCENARIO;
    this.store.state = emptyState();
    this.store.mutate(state => {
      state.simulation = {
        startedAt: new Date().toISOString(),
        scenario: name,
        label: SCENARIOS[name].label,
        totalEvents: SCENARIOS[name].totalEvents
      };
    });
    this.engine.changed();
    this.start();
    return name;
  }

  describe() {
    return {
      available: Object.entries(SCENARIOS).map(([id, entry]) => ({ id, label: entry.label, totalEvents: entry.totalEvents })),
      current: this.store.state.simulation?.scenario || null
    };
  }
}
