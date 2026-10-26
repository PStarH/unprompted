import { GoogleWorkspaceConnector, googleConfigFromEnv } from './google.js';
import { SimulatedConnector } from './simulated.js';
import { hasRealEvents } from '../store.js';
import { SimulatedMailProvider, GoogleMailAdapter, ReadOnlyDeliveryProvider, SourceDeliveryRouter } from '../providers.js';
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
export function buildRuntime(env = process.env, { store, fetchImpl, allowSimulatedActions = false, allowSimulation = true, extraConnectors = [] } = {}) {
  // Absent means on. External writes require an explicit opt-out.
  let shadow = env.UNPROMPTED_SHADOW_MODE !== 'false';
  const googleConfig = { ...googleConfigFromEnv(env), shadow };
  const google = new GoogleWorkspaceConnector({ config: googleConfig, ...(fetchImpl ? { fetchImpl } : {}) });
  const simulated = new SimulatedConnector();
  const googleStatus = google.validate();
  const googleLive = googleStatus.ok;
  const extra = extraConnectors.filter(connector => connector.live && connector.validate().ok);
  const live = googleLive || extra.length > 0;
  // A state that holds real recorded events is served as recorded: nothing is
  // synced into it without a live connector, and the simulation never runs
  // over it.
  const heldRealEvents = store ? hasRealEvents(store.state) : false;
  // A desktop first run may complete the isolated local story. This exception
  // never applies to a configured live connector or a store holding real data,
  // and does not persist any permission for future live workspaces.
  if (allowSimulatedActions && !live && !heldRealEvents) shadow = false;

  const connectors = live ? [...(googleLive ? [google] : []), ...extra] : allowSimulation ? [simulated] : [];
  // Live work always keeps its real provider identity. Its adapter refuses
  // sends when read-only; a missing send grant can never produce a simulated
  // success in a real workspace. Readback remains available for reconciliation.
  const googleProvider = googleLive ? new GoogleMailAdapter(google) : null;
  const provider = extra.length ? new SourceDeliveryRouter({ ...(googleProvider ? { google: googleProvider } : {}),
    ...Object.fromEntries(extra.map(connector => [connector.id, new ReadOnlyDeliveryProvider(connector.kind)])) })
    : googleProvider || new SimulatedMailProvider(store);
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

  if (!live && !allowSimulation && !heldRealEvents) note = 'Connect your model and Google account to begin observing your own workspace.';
  if (extra.length) note = 'Connected sources are read independently. New integrations are read-only; external actions remain scoped to their original source.';
  const mode = live ? 'live' : allowSimulation ? 'simulation' : 'setup';
  return {
    mode,
    live,
    shadow,
    policy,
    provider,
    connectors,
    cursors: new CursorStore(store),
    report: {
      mode,
      shadow,
      google: {
        ...googleStatus,
        sendEnabled: googleLive && Boolean(googleConfig.sendEnabled) && !shadow,
        readGmail: googleLive && googleConfig.readGmail,
        readDrive: googleLive && googleConfig.readDrive
      },
      // What still needs configuration before live sync works.
      pendingConfiguration: live ? [] : googleStatus.missing,
      mailProvider: provider.kind,
      eventSource: extra.length ? 'connected' : googleLive ? 'google' : allowSimulation ? 'simulated' : 'none',
      note
    }
  };
}

export const runtimeApi = { buildRuntime };
