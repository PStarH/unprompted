// Test-only transport: official Google URLs are forwarded to a local scripted
// HTTP fixture. Product code keeps its fixed Google endpoints and OAuth flow.
const originalFetch = globalThis.fetch;
const endpoint = process.env.UNPROMPTED_TEST_GOOGLE_ENDPOINT;
const allowed = new Set(['oauth2.googleapis.com', 'openidconnect.googleapis.com', 'gmail.googleapis.com', 'www.googleapis.com',
  'github.com', 'api.github.com', 'login.microsoftonline.com', 'graph.microsoft.com']);
globalThis.fetch = (input, options) => {
  const url = new URL(input);
  if (endpoint && allowed.has(url.hostname)) return originalFetch(`${endpoint}/google/${url.hostname}${url.pathname}${url.search}`, options);
  return originalFetch(input, options);
};
