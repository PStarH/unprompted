// Slack's HTTPS callback is only a browser relay. The PKCE verifier stays in
// the local app, which verifies state before exchanging the one-use code.
const query = new URLSearchParams(location.search);
history.replaceState(null, '', location.pathname);
const state = query.getAll('state');
const codes = query.getAll('code');
const errors = query.getAll('error');
const validState = state.length === 1 && /^[a-f0-9]{64}$/.test(state[0]);
const validCode = codes.length === 1 && codes[0].length > 0 && codes[0].length <= 4096 && errors.length === 0;
const validError = errors.length === 1 && /^[a-z_]{1,100}$/.test(errors[0]) && codes.length === 0;
if (validState && (validCode || validError)) {
  const callback = new URL('http://localhost:53682/oauth/slack');
  callback.searchParams.set('state', state[0]);
  callback.searchParams.set(validCode ? 'code' : 'error', validCode ? codes[0] : errors[0]);
  const link = document.querySelector('#continue');
  link.href = callback.href;
  link.hidden = false;
  location.replace(callback.href);
} else {
  document.querySelector('#message').textContent = 'This authorization response is invalid. Return to Unprompted and start again.';
}
