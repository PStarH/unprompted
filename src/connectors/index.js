import { GoogleWorkspaceConnector, googleConfigFromEnv } from './google.js';
import { SimulatedConnector } from './simulated.js';
import { hasRealEvents } from '../store.js';
import { SimulatedMailProvider, GoogleMailAdapter } from '../providers.js';
import { CursorStore } from './connector.js';
import { PermissionPolicy } from '../permissions.js';

/**
 * Runtime wiring.
 *
 * Chooses live or simulated operation from the environment, reports exactly
 * what is missing, and hands the engine a mail provider plus a set of
 * connectors. Core reasoning never imports provider code directly.
 *
 * Modes:
 *   live       - Google credentials present; events come from Gmail/Drive
 *   simulation - no credentials; deterministic local scenario
 *
 * The simulation is never presented as live data: every event carries
 * `source`, and `mode` is exposed through the API and the interface.
 */
export function buildRuntime(env = process.env, { store, fetchImpl } = {}) {
  // Absent means on. External writes require an explicit opt-out.
  const shadow = env.UNPROMPTED_SHADOW_MODE !== 'false';
  const googleConfig = { ...googleConfigFromEnv(env), shadow };
  const google = new GoogleWorkspaceConnector({ config: googleConfig, ...(fetchImpl ? { fetchImpl } : {}) });
  const simulated = new SimulatedConnector();
  const googleStatus = google.validate();
  const live = googleStatus.ok;
  // A state that holds real recorded events is served as recorded: nothing is
  // synced into it without a live connector, and the simulation never runs
  // over it.
  const heldRealEvents = store ? hasRealEvents(store.state) : false;

  const connectors = live ? [google, simulated] : [simulated];
  // Shadow mode never wires a provider that can deliver mail, even when the
  // send scope is configured. The policy denies the same action again at execution.
  const provider = !shadow && live && googleConfig.sendEnabled
    ? new GoogleMailAdapter(google)
    : new SimulatedMailProvider(store);
  const policy = new PermissionPolicy({ shadow });

  // The note states what this process is actually doing. With no credentials, a
  // state that holds real events is shown as recorded: nothing is synced and
  // the simulation is not started over it.
  let note;
  if (!live && heldRealEvents) {
    note = `${shadow ? 'Shadow mode is on. ' : ''}This state holds real recorded events, so the local simulation is not started; no Google credentials are configured in this session, nothing new is synced, and the recorded activity is shown as-is.`;
  } else if (shadow) {
    note = live
      ? 'Live read-only shadow mode. Events can be read from Google Workspace. External writes are refused even when send credentials are present.'
      : 'Shadow mode is on. This workspace is simulated and read-only: external writes are refused. Set UNPROMPTED_SHADOW_MODE=false to watch the local demonstration through approval and verification.';
  } else {
    note = live
      ? (googleConfig.sendEnabled
        ? 'Live Google Workspace sync and send are enabled.'
        : 'Live read-only sync is enabled. Set GOOGLE_SEND_ENABLED=true and grant gmail.send to allow approved replies to be delivered.')
      : 'No Google credentials found. Running the deterministic local simulation; no external service is contacted.';
  }

  return {
    mode: live ? 'live' : 'simulation',
    live,
    shadow,
    policy,
    provider,
    connectors,
    cursors: new CursorStore(store),
    report: {
      mode: live ? 'live' : 'simulation',
      shadow,
      google: {
        ...googleStatus,
        sendEnabled: Boolean(googleConfig.sendEnabled) && !shadow,
        readGmail: googleConfig.readGmail,
        readDrive: googleConfig.readDrive
      },
      // What still needs configuration before live sync works.
      pendingConfiguration: googleStatus.missing,
      mailProvider: provider.kind,
      eventSource: live ? 'google' : 'simulated',
      note
    }
  };
}

export const runtimeApi = { buildRuntime };
