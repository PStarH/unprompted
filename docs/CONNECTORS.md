# Connectors

[← Documentation](README.md)

Connect a model, then choose a source on the home page. Authorization applies
without restarting. You can connect several sources, pause observation, retry a
failed read and disconnect one account while keeping the others connected.

## Available connections

| Source | Sign-in | What is observed | External actions |
| --- | --- | --- | --- |
| Local folders | Native folder picker on macOS; absolute path on other systems | Markdown and UTF-8 text inside selected folders; explicit text to-dos | Read-only |
| Apple Notes | macOS Automation consent, then choose Notes folders | Plain text in selected folders; locked notes and attachments excluded | Read-only; real-account acceptance pending |
| Google Workspace | Desktop OAuth with PKCE | Gmail, Google Docs and changes | Off by default; Gmail sending and Docs editing need explicit additional authorization |
| GitHub | Official device OAuth | Issues assigned to the signed-in user in repositories accessible to the app | Read-only; no comments, edits, closing, labels or merges |
| Microsoft Outlook | Official device OAuth | Inbox email, initially the last 3 days, then Graph delta updates | Read-only; no mail sending or editing |

For device OAuth, choose Connect, copy the displayed code and confirm it on the
official provider page. The local service polls at the provider's stated
interval, verifies the actual account and starts reading. Tokens are never
copied by the user or exposed through the setup API, SSE or browser storage.
Cancellation, denial and expiration can be retried without losing an existing
connection. New providers do not reuse Gmail's delivery transport.

An empty read is a valid result. GitHub assignments become native issue tasks
with their repository, number, URL and assignee. A source closure stops tracking;
it does not create a verified agent completion. Outlook requests enter the same
source-grounded request/evidence pipeline as other email.

## Local sources

Choose **Local folders** or **Apple Notes** in Connections. Neither needs an
OAuth client, token or Full Disk Access. On macOS, Notes may ask the host
application (such as Terminal when running `npm start`) for Automation access.
Change that grant in System Settings → Privacy & Security → Automation.
Only folders selected in Unprompted are observed. Removing a folder immediately
invalidates its current evidence and stops its source tasks; historical records
remain in the private workspace. Read contexts can be sent to the model you
configured, just like connected cloud context.

Local files support `.md`, `.markdown` and `.txt`; hidden files, symlinks and
binary files are excluded. Observation is bounded to 500 text files, 512 KiB per
file and 4 MiB of changed text per pass. Notes is bounded to 500 notes and
512 Ki characters per note. Larger or inaccessible scopes produce a visible
partial-read error; select a narrower folder. Only the first 100 explicit
text to-dos in a document are tracked. `- [ ]`, `TODO:` and `☐` are supported;
ordinary prose stays context. The Notes scripting interface does not expose
native checklist completion reliably, so native Notes checkboxes are not a
supported completion signal. A checked or removed source to-do never counts
as verified agent completion.
Local document viewing links work only on this computer. Local text can supply
evidence, but external document delivery waits for a shareable document source;
Unprompted does not send the recipient a loopback link.

The Notes bridge uses Apple's public scripting interface, not the private Notes
database. Automated tests use injected Notes responses; a real Notes account and
the signed distribution's permission prompt still need manual acceptance.

## Provision applications once for a distribution

The publisher registers the application; end users authorize their own accounts.
A self-hosted installation without provisioned clients shows a public Client ID
field. It does not ask for provider access tokens or client secrets.

For GitHub, register a GitHub App, enable its device flow and grant read access
to issues and metadata. Install it in the intended repositories. The user token
can access the intersection of the user's access and the app's installation
permissions. A classic OAuth app can be used for public issues without broad
repository scopes; this implementation does not request the broad `repo` scope.
See [GitHub device authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
and [the assigned-issues API](https://docs.github.com/en/rest/issues/issues#list-issues-assigned-to-the-authenticated-user).

For Outlook, register an application supporting the intended personal and/or
organization accounts, enable public-client/device authorization, and configure
delegated `User.Read` and `Mail.Read` permissions. `offline_access` permits token
refresh. Organization policy may require an administrator to allow the app.
No client secret or public callback server is required. See [Microsoft device
authorization](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
and [message delta sync](https://learn.microsoft.com/en-us/graph/delta-query-messages).

Provide `UNPROMPTED_GITHUB_CLIENT_ID` and `UNPROMPTED_MICROSOFT_CLIENT_ID` in the
launch environment, or set `UNPROMPTED_CONNECTOR_CLIENTS_FILE` to a local JSON:

```json
{
  "github": { "clientId": "YOUR_REGISTERED_GITHUB_APP_CLIENT_ID" },
  "microsoft": { "clientId": "YOUR_REGISTERED_MICROSOFT_APPLICATION_CLIENT_ID" }
}
```

The app builder accepts `--connector-clients /path/to/connector-clients.json`.
Only recognized public Client IDs are bundled; account tokens and other fields
are discarded. Google uses the separate `--google-client` option described in
[account setup](ONBOARDING.md). Tests use scripted providers; a publisher still
needs to accept the real registered apps with consenting accounts.

## Add a source without a real account

Start with `src/connectors/connector.js`. A connector implements `validate()` and
`pull({ cursor })`, and returns normalized events plus the checkpoint it can
safely acknowledge. Inject `fetchImpl` and test with invented data.

This complete example makes no network calls:

```js
import assert from 'node:assert/strict';
import { GitHubConnector } from '../src/connectors/github.js';

const connector = new GitHubConnector({
  auth: { accessToken: async () => 'fixture-token' },
  account: { id: '123', login: 'reader', label: 'reader' },
  fetchImpl: async () => new Response(JSON.stringify([{
    id: 7, number: 7, title: 'Check the retry policy', body: 'Assigned work.',
    repository: { full_name: 'team/project' }, state: 'open',
    assignees: [{ id: 123, login: 'reader' }], user: { login: 'teammate' },
    updated_at: '2026-10-26T09:00:00Z'
  }]), { headers: { 'content-type': 'application/json' } })
});
const result = await connector.pull();
assert.equal(result.events[0].type, 'issue.updated');
assert.equal(result.events[0].payload.assigned, true);
assert.equal(result.events[0].source, 'github');
```

Place the example in an ES module under `test/` so its import resolves. For a
regression suite use `node:test`; existing cases are in
`test/connectors-multi.test.js` and `test/device-oauth.test.js`.

## Module boundaries

| Module | Responsibility |
| --- | --- |
| `src/connection-catalog.js` | Fixed provider endpoints and public client metadata |
| `src/device-oauth.js` | Device authorization, identity verification, cancellation and refresh rotation |
| `src/setup.js` | Private persistent credentials, redacted model/Google status and client settings |
| `src/connected-sources.js` | Construct authorized connectors and count current-account observations |
| `src/connectors/http.js` | Bounded, fixed-origin reads and sanitized errors |
| `src/connectors/github.js` | Assigned-issue pages, revisions, assignment loss and availability rechecks |
| `src/connectors/outlook.js` | Inbox delta pages, immutable message identities and source URLs |
| `src/connectors/events.js` | Native event types and payload validation |
| `src/external-work.js` | Native assigned work and retiring changed source accounts |
| `src/providers.js` | Delivery selected by the original source, with read-only fallback |
| `src/connectors/sync.js` | Serialized ingestion, deduplication and safe cursor commits |

Register the connector in runtime wiring, add its setup/status UI and document
its real sign-in requirements. Reuse existing normalized types only when their
meaning matches; do not disguise issues, chat messages or calendar events as
email. Keep provider identity in IDs, source references and delivery routing.

## Failure and permission contracts

- A provider failure is an error or explicit partial result, never an empty
  successful pull. Commit only acknowledged progress.
- Consume pagination or persist an exact continuation. Do not move a checkpoint
  past unread data. Reject continuations outside the expected provider origin.
- Re-delivery must be idempotent. Retain provider timestamps and account identity.
- Observe reassignment, source removal and lost access. Keep unknown outcomes
  unknown; do not infer task completion from disappearance.
- Honor polling intervals, expiration and `slow_down`. Cancelled/late callbacks
  cannot restore disconnected credentials or a different account.
- Start read-only. A future `execute()` needs scoped authority and independent
  `verify()`/readback. An accepted operation is not a verified result.
- Never require real credentials or private workspace records in tests or issues.

Run focused checks with `node --test test/device-oauth.test.js
test/connectors-multi.test.js test/connections-api.test.js`. The actual browser
contract is `npm run test:connections`; [Testing](TESTING.md) describes tooling.
