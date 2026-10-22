# Security policy

## Supported versions

Unprompted is a pre-1.0 prototype. Fixes land on `main`; release branches are
not maintained separately.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting page](https://github.com/PStarH/unprompted/security/advisories/new)
when it is available. If that page is unavailable, contact
[the maintainer](https://github.com/PStarH) through a private contact method
listed on their profile. Do not post exploit details, credentials, or private
content in a public issue. If no private contact method is available, open a
minimal issue requesting a private reporting channel, without technical details.

Include the affected commit, impact, synthetic reproduction steps, and relevant
mode/settings. Say whether live Google access, send opt-in, or shadow-mode
opt-out is involved. Do not include real OAuth credentials, API keys, email
content, document links, or state files. Reports are handled on a best-effort
basis; no response-time guarantee or bounty is offered.

## Security boundaries

- The application binds to **localhost** and has **no authentication**. Do not
  expose it through a public host, reverse proxy, or network tunnel.
- Normal mode is **read-only by default**. Live sending requires the granted
  scope, explicit settings, and approval or a valid scoped pre-authorization.
- `npm run demo` isolates credentials and state, and uses simulated sending only.
- Provider acceptance is not completion: a receipt is verified, and unknown
  outcomes are reconciled before retrying.
- Model output cannot approve an action, expand permission, or establish evidence
  on its own. An enabled remote model may receive request content.
- Local state contains synchronized content and evidence. It is not encrypted.
  Credentials are read from the environment; don't store them in issues or fixtures.

See [configuration and data handling](docs/CONFIGURATION.md) for the complete
mode and storage behavior.
