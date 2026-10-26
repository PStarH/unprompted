import { createReasoner } from './reasoning.js';

export class ModelSetupError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function normalizeModelSettings(input, previous = {}) {
  if (!input || typeof input !== 'object') throw new ModelSetupError('MODEL_CONFIG_INVALID', 'Enter a model endpoint and model ID.');
  let url;
  try { url = new URL(String(input.baseUrl || '').trim()); } catch { throw new ModelSetupError('MODEL_CONFIG_INVALID', 'Enter a valid model endpoint URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ModelSetupError('MODEL_CONFIG_INVALID', 'Use an HTTP or HTTPS endpoint without credentials, query parameters or fragments.');
  }
  const baseUrl = url.href.replace(/\/$/, '').replace(/\/chat\/completions$/, '');
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!model || model.length > 200 || /[\r\n]/.test(model)) throw new ModelSetupError('MODEL_CONFIG_INVALID', 'Enter the model ID supplied by your provider.');
  const harness = input.harness || 'classic';
  if (!['classic', 'pi'].includes(harness)) throw new ModelSetupError('MODEL_CONFIG_INVALID', 'Choose a supported model harness.');
  const apiKey = input.apiKey === undefined && previous.baseUrl === baseUrl ? previous.apiKey || null : input.apiKey || null;
  if (apiKey !== null && (typeof apiKey !== 'string' || apiKey.length > 8192 || /[\r\n]/.test(apiKey))) throw new ModelSetupError('MODEL_CONFIG_INVALID', 'Enter a valid API key.');
  return { baseUrl, model, apiKey: apiKey?.trim() || null, harness, role: 'primary' };
}
export function modelEnvironment(settings) {
  return {
    UNPROMPTED_MODEL_BASE_URL: settings.baseUrl,
    UNPROMPTED_MODEL_NAME: settings.model,
    ...(settings.apiKey ? { UNPROMPTED_MODEL_API_KEY: settings.apiKey } : {}),
    UNPROMPTED_AGENT_HARNESS: settings.harness || 'classic',
    UNPROMPTED_MODEL_ROLE: settings.role || 'primary'
  };
}

/** One real structured inference using invented content; never sends workspace data. */
export async function validateModelSettings(settings, { fetchImpl, piRuntimeOptions, budgetEnv = {} } = {}) {
  const limits = Object.fromEntries(['UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE', 'UNPROMPTED_MODEL_MAX_QUEUED', 'UNPROMPTED_MODEL_QUEUE_TIMEOUT_MS']
    .filter(key => budgetEnv[key] != null).map(key => [key, budgetEnv[key]]));
  const reasoner = createReasoner({ ...limits, ...modelEnvironment(settings) }, { fetchImpl, piRuntimeOptions });
  if (!reasoner.available()) throw new ModelSetupError('MODEL_UNAVAILABLE', 'This model harness is unavailable. Choose the standard harness or install the Pi packages.');
  let result;
  try {
    result = await reasoner.interpretRequest({ subject: 'Cedar proposal',
      body: 'Please update the Cedar proposal with sample size and conclusion, then send it to me.' }, 'connection-check');
  } catch (error) {
    const status = Number(error.status);
    if (status === 401 || status === 403) throw new ModelSetupError('MODEL_AUTH_FAILED', 'The model provider rejected the key or model access. Check your API key and permissions.');
    if (status === 429) throw new ModelSetupError('MODEL_RATE_LIMITED', 'The model provider is rate limited or has insufficient quota. Check your provider account.');
    throw new ModelSetupError('MODEL_CHECK_FAILED', 'The model request did not complete. Check the endpoint, model ID and structured-response support.');
  }
  const source = 'Please update the Cedar proposal with sample size and conclusion, then send it to me.';
  if (result?.deliverable !== 'proposal' || result?.subjectEntity?.toLowerCase() !== 'cedar' ||
    !result.requiredContent?.some(item => source.includes(item.text) && /sample size|conclusion/i.test(item.text) && (!item.sourceQuote || source.includes(item.sourceQuote)))) {
    throw new ModelSetupError('MODEL_RESPONSE_INVALID', 'The model responded but did not return the requested grounded structure. Choose a model supporting structured responses.');
  }
  return { reasoner, validation: { status: 'verified', at: new Date().toISOString(), scope: 'synthetic_structured_inference', externalWorkspaceDataSent: false } };
}
