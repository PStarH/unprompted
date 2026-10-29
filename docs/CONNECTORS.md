# Connectors

[← Documentation](README.md)

Connect a model, then choose a source on the home page. Authorization applies
without restarting. You can connect several sources, pause observation, retry a
failed read and disconnect one account while keeping the others connected.

## Available connections

| Source | Sign-in | What is observed | External actions |
| --- | --- | --- | --- |
| Local folders | Native folder picker on macOS; absolute path on other systems | Markdown and UTF-8 text inside selected folders; explicit text to-dos | Read-only |
| Apple Notes | macOS Automation consent, then choose Notes folders | Plain text in selected folders; locked notes and attachments excluded | New notes in explicitly authorized folders; real-account acceptance pending |
| Google Workspace | Desktop OAuth with PKCE | Gmail, Google Docs and changes | Draft creation after separate authorization; Gmail sending and Docs editing require independent approval |
| GitHub | Official device OAuth | Assigned issues, pull requests awaiting the user's review or response, commits from the last three days, and Actions runs from that window | Read-only; no comments, reviews, edits, merges, or workflow reruns |
| Microsoft Outlook | Official device OAuth | Inbox email, initially the last 3 days, then Graph delta updates | Unsent draft creation after separate authorization |
| Notion | Public integration browser OAuth | Pages selected by the user | Child pages in an explicitly authorized parent |
| Slack | User browser OAuth | Authorized direct and group messages | Read-only |

With Google connected, **Connections → Search Google** searches Gmail or Google
Docs by name, with a **Load more** control. Gmail accepts the provider's search
syntax; Docs search matches document names, not their full contents. Search uses
the connected account and selected read permissions. Results are shown for your
own use and do not automatically create tasks or get sent to the model.

The connector reports its configured operations in `/api/runtime` and
`/api/setup`. These describe enabled local configuration, not proof that the
provider has not since revoked access. Gmail sending additionally requires Gmail
read access so the sent message can be independently verified.

Source changes are observed by polling. The local `/api/stream` subscription
publishes workspace snapshots as those observations are processed; it is not a
provider webhook or a replayable per-event feed. Provider push is not enabled.
[Gmail push](https://developers.google.com/workspace/gmail/api/guides/push)
requires Cloud Pub/Sub, and [Drive push](https://developers.google.com/workspace/drive/api/guides/push)
requires an HTTPS webhook; both still need recovery for missed notifications.

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

If Outlook's delta checkpoint expires, Unprompted restarts an inbox enumeration
without the initial three-day limit. This can
surface older messages that were not previously observed and can take multiple
passes for a large inbox. Already ingested message IDs are deduplicated. The
checkpoint only advances after each page is ingested; a failed reset is retried
from the previous checkpoint. This recovery has automated fixture coverage but
has not yet been verified against a real Microsoft account.

One observation follows up to five pages per connector. If automatic observation
is enabled and more pages remain, it schedules up to four short continuation
passes before returning to the normal polling interval. A partial failure stops
the quick continuation. A one-off check processes at most five pages and leaves
the remaining cursor for the next check.

## External MCP tools

Install the optional client with `npm ci --include=optional`, then restart the
app. In **Connections → MCP → Add server**, enter a Streamable HTTP URL and an
optional bearer token, or choose **Paste config** for an existing `mcpServers`
configuration. Both Standard and Pi can use authorized tools. Your model must
support function calling. Remote servers use HTTPS; HTTP is accepted on localhost.

```json
{
  "mcpServers": {
    "work-context": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

For a local process, use `command`, an `args` array, optional `env` and an absolute
`cwd`. Commands run as your local user without a shell; connect only trusted
servers. Legacy SSE is supported with `"type":"sse"` and `url` in pasted config.
Custom header authentication and stdio environment credentials are supported;
interactive MCP OAuth and prompts are not implemented.

Connecting can grant access to tools the server declares read-only. These
annotations are server claims, not a security sandbox. Review individual tools
under **Tools and access**; unannotated tools need an explicit read grant. Tools
declared writable or destructive remain blocked. Disabling or removing a server
revokes captured adapters immediately and closes its process/transport. Restart
restores enabled connections and their saved grants.

Servers that expose MCP resources, including resource-only servers, are also
supported. In **Resources and access**, select each resource the agent may read;
none are enabled by default. During a task the agent can read selected resources
as context. Only text is used, and resource content may be sent to the configured
model and retained with the task. Revoking a selection blocks captured readers.
Resource templates, subscriptions and automatic change observation are not yet
supported; reconnect to refresh a catalog when its server does not send changes.

MCP supplies investigation tools for discovered email work, assigned GitHub
issues and explicit local to-dos. It does not poll arbitrary tools to discover
new tasks: connect a work source for that. Calls and bounded text results appear
in the task's **Sources** dialog. Suggestions and MCP results never satisfy
completion criteria or execute source writes on their own. Text returned by a
tool can be sent to the configured model and retained in the private task record.

Credentials stay in the private `mcp.json` next to local setup, with mode `0600`;
the API never returns commands, arguments, environment values or headers. This
file is not encrypted. Replacing a server's config uses the same server name.
The implementation uses the [official MCP TypeScript client](https://github.com/modelcontextprotocol/typescript-sdk).

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
text to-dos in a supported local text document are tracked. `- [ ]`, `TODO:` and
`☐` are supported; ordinary prose stays context. The Notes scripting interface
does not expose native checklist completion reliably, so native Notes checkboxes
are not a supported completion signal. A checked or removed source to-do never
counts as verified agent completion.
Local document viewing links work only on this computer. Local text can supply
evidence, but external document delivery waits for a shareable document source;
Unprompted does not send the recipient a loopback link.

The Notes bridge uses Apple's public scripting interface, not the private Notes
database. Automated tests use injected Notes responses; a real Notes account and
the signed distribution's permission prompt still need manual acceptance.

## Provision applications once for a distribution

The publisher registers each application once. End users then authorize their own
accounts. Tokens stay on that computer. A self-hosted installation without
provisioned clients asks for the application identity, not a user access token.

GitHub and Outlook use device authorization and a public Client ID. Slack and
Notion use a browser authorization code and a fixed loopback redirect. Their
client secrets are stored in the local setup file. Slack’s browser login uses
PKCE and does not send that secret to Slack.

For GitHub, register a GitHub App, enable its device flow and grant read access
to Issues, Pull requests, Contents, Actions, and Metadata. Install it in the
intended repositories. The user token can access the intersection of the user's
access and the app's installation permissions. Contents read is used to list
commits and the paths they change. File patches and file bodies are not stored.
A classic OAuth app can be used where its account scopes cover the same reads;
this implementation does not request the broad `repo` scope.
See [GitHub device authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
and [the assigned-issues API](https://docs.github.com/en/rest/issues/issues#list-issues-assigned-to-the-authenticated-user).

For Outlook, register an application supporting the intended personal and/or
organization accounts, enable public-client/device authorization, and configure
delegated `User.Read` and `Mail.Read` permissions. `offline_access` permits token
refresh. Organization policy may require an administrator to allow the app.
No client secret or public callback server is required. See [Microsoft device
authorization](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
and [message delta sync](https://learn.microsoft.com/en-us/graph/delta-query-messages).

For Slack, create an app and enable PKCE. PKCE is one-way for that Slack app.
Register this redirect URL exactly:

`http://localhost:53682/oauth/slack`

If the redirect form rejects `http`, set the same URL in the app manifest under
`oauth_config.redirect_urls` and set `pkce_enabled` to true. Add only these user
token scopes: `im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read`.
Do not add bot scopes or a write scope. The app reads direct messages and group
direct messages from the last three days, skips the user’s own messages, and
labels them Slack. The same workspace can install the app directly. Other
workspaces need Slack public distribution; a directory listing is a separate
review. See [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth)
and [PKCE](https://docs.slack.dev/authentication/using-pkce).

For Notion, create a public integration at
[My integrations](https://www.notion.so/my-integrations). Register this redirect
URL exactly:

`http://localhost:53682/oauth/notion`

Enable read content and read user information. Enable **Insert content** if users
will create work artifacts; leave **Update content** disabled.
During consent, each user selects the pages Unprompted may read. Recently edited
pages in that selection are stored as documents. See
[Notion public connections](https://developers.notion.com/guides/get-started/public-connections).

### Authorized artifact creation

In **Connections → Create work artifacts**, each user explicitly authorizes a
mailbox Drafts destination, Notion parent page, or selected Apple Notes folder.
An optional project limits that authorization. Connecting an account alone never
authorizes creation. Grants bind the exact account and destination in that user's
persistent workspace and can be revoked. An explicit launch setting
`UNPROMPTED_SHADOW_MODE=true` continues to block every write.

Gmail requires `gmail.readonly` and `gmail.compose`. The latter also permits
sending at Google; the product retains its independent send authorization.
Do not request `gmail.modify` or full-mail scope for this feature. External
distribution must complete applicable OAuth verification. See
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
Outlook adds delegated `Mail.ReadWrite` only when the user authorizes drafts,
alongside `User.Read`, `Mail.Read` and `offline_access`; it does not request
`Mail.Send` or application mailbox access. That provider scope also covers
editing and deletion, while this feature exposes only new drafts. See
[Graph draft creation](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0).
Notion needs **Read content** and **Insert content**, access to the chosen parent,
and user permission to create there. Existing read-only installations must be
reauthorized after changing capabilities. Creation targets child pages, not
database entries. Apple Notes uses macOS Automation and only previously selected
folders; the new grant permits creation without exposing editing or deletion.
GitHub, Slack and local-file connectors keep their existing read permissions.

Standard and Pi share the same bounded creation tool. The activation layer can
save a prepared mail reply automatically; tasks requiring review cannot create
automatically. Each action goes through the durable execution ledger and an
independent readback. Revocation, account changes and stale task context block
dispatch. Ambiguous writes are retained for reconciliation without blind retry.
Saving an artifact does not send mail or complete its source task. Outcomes appear
in task details. Automated coverage uses scripted providers; real account OAuth,
macOS Automation and provider publication approval still require acceptance tests.

Application client metadata is provisioned once, but users authorize their own
accounts. The current Slack/Notion exchange runs locally, so provisioned client
secrets are distributed to the client, not kept confidential on a server. Use a
hosted OAuth exchange when the distribution requires confidential clients.
The [Chinese setup walkthrough](CONNECTORS.zh-CN.md#为所有用户配置可执行的原生连接器)
includes registration steps and the user flow.

Provide the registered values in the launch environment, or put them in
`connector-clients.json` at the repository root (gitignored) or in the file named
by `UNPROMPTED_CONNECTOR_CLIENTS_FILE`:

```json
{
  "github": { "clientId": "YOUR_GITHUB_APP_CLIENT_ID" },
  "microsoft": { "clientId": "YOUR_MICROSOFT_APPLICATION_ID" },
  "slack": { "clientId": "YOUR_SLACK_CLIENT_ID", "clientSecret": "YOUR_SLACK_CLIENT_SECRET" },
  "notion": { "clientId": "YOUR_NOTION_CLIENT_ID", "clientSecret": "YOUR_NOTION_CLIENT_SECRET" }
}
```

Environment names are `UNPROMPTED_GITHUB_CLIENT_ID`, `UNPROMPTED_MICROSOFT_CLIENT_ID`,
`UNPROMPTED_SLACK_CLIENT_ID`, `UNPROMPTED_SLACK_CLIENT_SECRET`,
`UNPROMPTED_NOTION_CLIENT_ID` and `UNPROMPTED_NOTION_CLIENT_SECRET`. A code-flow
pair is used only when both values are present. Google uses the separate Desktop
client file described in [account setup](ONBOARDING.md).

The app builder accepts `--connector-clients /path/to/connector-clients.json`.
It keeps GitHub and Outlook Client IDs, plus Slack and Notion client secrets.
It discards account tokens, refresh tokens, and a GitHub or Outlook client secret.
Tests use scripted providers; a publisher still needs consent from real accounts.

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
