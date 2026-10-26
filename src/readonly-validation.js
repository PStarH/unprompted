import fs from 'node:fs';

export function readonlyValidationEnv(env, { port, stateFile, setupDirectory }) {
  const output = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(GOOGLE_|UNPROMPTED_)/i.test(key)));
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_GMAIL_QUERY',
    'GOOGLE_READ_GMAIL', 'GOOGLE_READ_DRIVE', 'GOOGLE_REQUEST_TIMEOUT_MS', 'GOOGLE_SYNC_BUDGET_MS',
    'GOOGLE_MAX_DOCUMENT_CHARS', 'GOOGLE_MAX_RETRIES', 'GOOGLE_RETRY_BASE_MS']) {
    if (env[key] != null) output[key] = env[key];
  }
  return Object.assign(output, {
    PORT: String(port), UNPROMPTED_STATE_FILE: stateFile, UNPROMPTED_CONFIG_DIR: setupDirectory,
    UNPROMPTED_SHADOW_MODE: 'true', UNPROMPTED_FORCE_SIMULATION: 'false', UNPROMPTED_SYNC_INTERVAL_MS: '0',
    GOOGLE_SEND_ENABLED: 'false', GOOGLE_DOCS_WRITE_ENABLED: 'false'
  });
}

export function snapshotSource(filename) {
  const bytes = fs.readFileSync(filename);
  const stat = fs.statSync(filename, { bigint: true });
  return { bytes, size: stat.size, inode: stat.ino, modifiedAt: stat.mtimeNs, changedAt: stat.ctimeNs };
}

export function sourceUnchanged(filename, before) {
  try {
    const after = snapshotSource(filename);
    return before.bytes.equals(after.bytes) && ['size', 'inode', 'modifiedAt', 'changedAt'].every(key => before[key] === after[key]);
  } catch { return false; }
}

export function isReadonlyValidationRuntime(health, runtime) {
  return health?.ok === true && health.mode === 'live' && health.shadow === true &&
    health.reasoner?.id === 'none' && runtime?.mode === 'live' && runtime.shadow === true &&
    runtime.google?.ok === true && (runtime.google.readGmail === true || runtime.google.readDrive === true) &&
    runtime.google.sendEnabled === false && runtime.mailProvider === 'simulated' &&
    runtime.simulationRunning === false && runtime.monitoring?.enabled === false;
}
