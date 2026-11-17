# Connectors

[← Documentation](README.md)

Connect a model, then choose a source on the home page. Authorization applies
without restarting. You can connect several sources, pause observation, retry a
failed read and disconnect one account while keeping the others connected.

## Observation

Sources use periodic incremental checks on this computer by default. Observation starts immediately after connection and resumes on restart. Keep the local service running; pause or disconnect to stop observation. GitHub repositories can additionally use the [opt-in signed webhook receiver](GITHUB_WEBHOOKS.md). It persists delivery metadata and schedules scoped pulls through the existing observer; the notification is not evidence or authorization. It requires explicit account/repository configuration and a reachable HTTPS endpoint. Other sources continue to use polling.

## Available connections

| Source | Sign-in | What is observed | External actions |
| --- | --- | --- | --- |
| Local folders | Native folder picker on macOS; absolute path on other systems | Markdown and UTF-8 text inside selected folders; explicit text to-dos | Read-only |
| Apple Notes | macOS only. Automation consent, then choose Notes folders. Offered on a Mac; hidden elsewhere unless already connected | Plain text in selected folders; locked notes and attachments excluded | New notes in explicitly authorized folders; real-account acceptance pending |
| Apple Reminders | macOS Automation consent, then choose lists | Explicit reminders, completion and due dates in selected lists | Create, edit, complete and delete reminders in separately authorized selected lists |
| Apple Calendar | macOS only. Automation consent, then choose calendars. Hidden off a Mac unless already connected | Upcoming and recent events in the selected calendars, and later changes. A bounded window (14 days back, 60 days ahead, at most 500 events) | Read only. Modify off. No create, edit, or delete |
| Apple Mail | macOS only. Automation consent, then choose mailboxes across accounts | Messages in the selected mailboxes from the last 7 days, at most 40 per mailbox and 200 overall, with bounded body text | Read only. Sending, deleting, and editing stay off |
| Apple Contacts | macOS only. Automation consent, then choose groups (or All Contacts) | Selected people, for evidence and name/email/phone lookup. At most 400 people observed and 20 lookup matches | Read only. The address book is not modified |
| Todoist native | Personal API token; no developer app | Active tasks with paginated snapshots; removed tasks stop being followed | Authorized API actions after a separate local grant, within the token’s actual permissions |
| Google Workspace | Desktop OAuth with PKCE | Gmail; Docs, Sheets (first sheet as CSV), Slides; optional primary Calendar | Draft creation after separate authorization; Gmail sending and Docs editing require independent approval |
| GitHub | Official device OAuth | Assigned issues, issue mentions (title/body), pull requests awaiting the user's review or response, the newest five commits per repository from the last three days, and the newest ten Actions runs per repository from that window | Authorized platform API actions within installation and user permissions |
| Microsoft Outlook | Browser OAuth with PKCE | Inbox email, initially the last 3 days, then Graph delta updates | Draft target grant; generic Graph actions additionally require the relevant scopes and a local action grant |
| Notion | Public integration browser OAuth | Pages selected by the user | Child-page target grant; generic API actions remain limited to actual integration permissions and a separate local grant |
| Slack | User browser OAuth with PKCE | Direct/group messages; optionally joined public/private channels and replies | Platform API actions after user-scope consent and local authorization |

With Google connected, **Connections → Search Google** searches Gmail or Google
Drive documents by name, with a **Load more** control. Gmail accepts the provider's search
syntax; Drive search matches Docs, Sheets and Slides names, not their full contents. Search uses
the connected account and selected read permissions. Results are shown for your
own use and do not automatically create tasks or get sent to the model.

The connector reports its configured operations in `/api/runtime` and
`/api/setup`. These describe enabled local configuration, not proof that the
provider has not since revoked access. Gmail sending additionally requires Gmail
read access so the sent message can be independently verified.

## Source capability contract

The table records what each adapter actually implements and how a result can be
checked. It describes local behavior, not a promise that a real account granted
the scope. Live adapters observe through `pull()`/`listHistoricalEvents()`; only
Google exposes a separate native `search()` method, and only adapters with a
provider readback expose strong verification.

| Source | Read | Search | Observe | Write | Verify | Required grant |
| --- | --- | --- | --- | --- | --- | --- |
| Google Workspace | Native Gmail, Drive, optional primary Calendar API | Native Gmail and Drive-name search in the app UI; not a model tool | Native poll: Gmail history, Drive changes, Calendar sync | Native approved Gmail reply and Docs patch; other endpoints through `platform_api` | Native Gmail Sent readback and Docs revision readback. Generic API writes need independent GET/HEAD assertions; otherwise accepted or unknown | Desktop OAuth: Gmail readonly (plus `gmail.compose` for send), Drive readonly (Docs edit separate), Calendar readonly; local action grant for platform writes |
| Microsoft Outlook | Native Graph inbox API | API only through `platform_api` | Native poll: Graph delta | Artifact draft creation; other Graph endpoints through `platform_api` | Native adapter verification is unknown/manual. Draft creation is read back by the artifact layer; API writes need GET/HEAD assertions, otherwise accepted or unknown | Delegated `User.Read`, `Mail.Read`, `offline_access`; `Mail.ReadWrite` for drafts; local action grant for platform writes |
| Slack | Native user API direct/group messages; optional joined channels and threads | API only through `platform_api` | Native poll | API only through `platform_api` | API readback assertions; otherwise accepted or unknown | User scopes (`im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read`; optional channel scopes; action scopes such as `chat:write`); local action grant |
| Notion | Native API for user-selected pages | API only through `platform_api` (`/v1/search`) | Native poll | Artifact child page in an authorized parent; other endpoints through `platform_api` | Artifact readback and API readback assertions; otherwise accepted or unknown | Integration capabilities and selected pages; Insert content for artifacts; local grants |
| GitHub | Native API assigned issues, PR reviews, repository changes, Actions runs | API only through `platform_api` | Native poll | API only through `platform_api` | Independent GET/HEAD assertions; otherwise accepted or unknown | GitHub App installation and user permissions; local action grant |
| Todoist native | Native API active tasks, up to 10,000 per scan | API only through `platform_api` | Native poll | API only through `platform_api` | API readback assertions; otherwise accepted or unknown | Personal API token; local action grant |
| Apple Reminders | Native macOS Automation for selected lists | Native list and item reads; no remote search | Native poll | Native selected-list POST/PATCH/DELETE with `expectedUpdatedAt`; local action grant | Independent native GET readback, or 404 after deletion; API assertions where supplied | macOS Automation consent and selected lists; explicit local action grant |
| MCP | Server tools and resources allowed per tool/resource | `find_connected_tools` over the current authorized catalog | None; MCP is not a background source | Per-tool explicit write selection through the durable ledger | Unknown for arbitrary tools: acceptance is recorded as accepted, not verified | User-selected tool and resource grants; server read annotations are claims |

A missing native observation or provider readback stays unknown or manual. An
empty read, provider acceptance, a source closure or a disappeared record is not
evidence that the agent completed the work.

Source changes are observed by polling. The local `/api/stream` subscription
publishes workspace snapshots as those observations are processed; it is not a
provider webhook or a replayable per-event feed. GitHub repository push is optional and must be explicitly configured; other sources continue to use polling.
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
passes for a large inbox. Repeated deliveries of the same message revision are deduplicated; a new etag or modification timestamp updates the stored message. The
checkpoint advances only after each page is ingested. Recovery remains active across continuation pages; a failed reset is retried
from the previous checkpoint. This recovery has automated fixture coverage but
has not yet been verified against a real Microsoft account.

One observation follows up to five pages per connector. If automatic observation
is enabled and more pages remain, it schedules up to four short continuation
passes before returning to the normal polling interval. A partial failure stops
the quick continuation. A one-off check processes at most five pages and leaves
the remaining cursor for the next check.

## External MCP tools

Install the optional client with `npm ci --include=optional`, then restart the
app. Open **Connections → MCP**.

**Fetch** needs no account and is on by default. It runs with the bundled Node runtime, resolved from the current process rather than a path saved on a developer’s machine, so it does not require Python, `uvx`, or an npm download. A saved Fetch config that still points at another computer’s Node or `mcp-fetch-server.js` is rewritten on startup. It reads bounded public text pages, blocks private/local network destinations, and returns plain text; it does not render JavaScript. **Git** (`uvx mcp-server-git`) accepts one `--repository`. Each directory you enter becomes its own server (`git`, `git-2`, …). Read tools (`git_status`, `git_log`, `git_diff`, `git_show`, `git_branch`) are allowed. `git_add`, `git_commit`, `git_reset`, `git_checkout` and `git_create_branch` stay off. **Filesystem** (`npx -y @modelcontextprotocol/server-filesystem`) reads only the directories you enter. Its tools that can create or change files stay off until you enable each one under **Tools and access**. **Time** (`uvx mcp-server-time`) reports the current time in the computer’s time zone. **DeepWiki** connects to `https://mcp.deepwiki.com/mcp` with no sign-in. None of these ask for an API key or an OAuth app. Paths must be existing directories, one per line, and cannot be the filesystem root or your home directory. Preset checks apply to the preset’s own server name. A custom name that happens to run the same command is not checked. If `uvx` or `npx` is not installed, the preset stays in a clear unavailable state and tells you what to install instead of failing closed. The Connections page takes these presets from the app, including the command and fields. **Notion**, **Linear**,
**Jira and Confluence** (Atlassian), and **Todoist** use the vendor sign-in
page: choose **Sign in and connect**. You do not paste a client secret or an
API token. **Brave Search** and **Firecrawl** still need an API key. Their bounded read tools also run with bundled Node: Brave web search and Firecrawl single-page Markdown scraping need no `npx` or package installation. You can
also add an HTTPS URL or paste a `mcpServers` config. A local command runs as
your user, without a shell. Both Standard and Pi can use authorized tools. Your
model must support function calling. Remote servers use HTTPS; HTTP is accepted
on localhost.

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
Custom header authentication and stdio environment credentials are supported.
Hosted presets sign in with OAuth 2.1 in the browser. MCP prompts are not
implemented. An imported config cannot include OAuth tokens. An older Linear or
Jira API-token entry stays in the server list until you remove it. Signing in
replaces a saved Linear config.

Signing in, or connecting Fetch, can allow tools the server declares read-only.
These annotations are server claims, not a security sandbox. Other tools stay
off until you allow them under **Tools and access**. Write and destructive tools can be explicitly selected under **Tools and access**.
They execute through the durable task ledger; importing a server never grants write access. Disabling or removing a server
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

Credentials and sign-in tokens stay in the private `mcp.json` next to local
setup, with mode `0600`, and are encrypted at rest. The API never returns
commands, arguments, environment values, headers, or tokens. Replacing a
server's config uses the same server name. See
[secrets at rest](CONFIGURATION.md#secrets-at-rest).
The implementation uses the [official MCP TypeScript client](https://github.com/modelcontextprotocol/typescript-sdk).

## Local sources

Local folders are offered on every system and need no account. Apple Notes is
offered only when Unprompted is running on macOS. On other systems the card is
hidden. A Notes connection that already exists stays visible so you can
disconnect it. Neither source needs an OAuth client, token, or Full Disk Access.
On macOS, Notes may ask the host application (such as Terminal when running
`npm start`) for Automation access.
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

Calendar, Mail, and Contacts use the same JavaScript for Automation bridge.
Each is offered only on macOS, and an existing connection stays visible on
other systems so it can be disconnected. None needs an API key, an OAuth
client, or Full Disk Access. The first read asks macOS for Automation
permission for Calendar, Mail, or Contacts. The prompt names the app that is
running Unprompted (Terminal for `npm start`, or the Unprompted app). Allow it
in System Settings → Privacy & Security → Automation. If macOS denies access,
the connection shows that message and previously read evidence is marked
unavailable until you allow access and retry. These three connectors do not
create, edit, send, or delete. Calendar covers events that overlap the last 14
days and the next 60 days. Mail covers the last 7 days in the mailboxes you
select, across every account Mail.app shows. Contacts lookup searches the
groups you select and does not turn an address-book note into a task. During a
task, **Look up a contact** calls that search. A timeout, an oversized response,
or any read failure other than a macOS Automation denial (`-1743`) keeps the
previous evidence and reports a partial read. Only an Automation denial marks
that evidence unavailable. Wording such as “not authorized” without that error
number is a failed read, not a permission retraction.

## Provision applications once for a distribution

For the full publisher-to-user procedure, scope recipes and packaging commands, see the [complete setup tutorial (Chinese)](CONNECTOR_SETUP.zh-CN.md).

The publisher registers each application once. End users then authorize their own
accounts. Tokens stay on that computer. A self-hosted installation without
provisioned clients asks for the application identity, not a user access token.

GitHub uses device authorization. Outlook uses browser authorization with PKCE and a public Client ID. Slack uses a public Client ID with PKCE and needs no client secret. Notion uses browser authorization. A public build registers the provider callback `<broker origin>/v1/notion/callback` and carries only a secretless broker descriptor (`clientId` plus `brokerUrl`); the desktop loopback `http://localhost:53682/oauth/notion` is only the handoff, the publisher client secret stays on the broker server, and an owner-private self-host can still register that loopback redirect directly. A locally supplied native Notion secret is exchanged on this computer; it is extractable and is not a confidential-client deployment. This repository does not deploy or register the broker publisher identity.

For GitHub, register a GitHub App, enable its device flow and grant read access
to Issues, Pull requests, Contents, Actions, and Metadata for observation. Configure write permissions for the actions offered by your product. Install it in the
intended repositories. The user token can access the intersection of the user's
access and the app's installation permissions. Contents read is used to list
commits and the paths they change. File patches and file bodies are not stored.
A classic OAuth app can be used where its account scopes cover the same reads;
this implementation does not request the broad `repo` scope.
See [GitHub device authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
and [the assigned-issues API](https://docs.github.com/en/rest/issues/issues#list-issues-assigned-to-the-authenticated-user).

For Outlook, register an application supporting the intended personal and/or
organization accounts, register `http://localhost/oauth/microsoft` as a mobile and desktop redirect, and configure
delegated `User.Read` and `Mail.Read` permissions. `offline_access` permits token
refresh. Organization policy may require an administrator to allow the app.
No client secret or public callback server is required. See [Microsoft authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
and [message delta sync](https://learn.microsoft.com/en-us/graph/delta-query-messages).

For Slack, create an app and enable PKCE. PKCE is one-way for that Slack app.
Register this redirect URL exactly:

`http://localhost:53682/oauth/slack`

If the redirect form rejects `http`, set the same URL in the app manifest under
`oauth_config.redirect_urls` and set `pkce_enabled` to true. Add only these user
token scopes: `im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read`.
Optional channel access adds user scopes `channels:read`, `channels:history`, `groups:read`, and `groups:history`. Users explicitly select channel access during connection or reconnect from **Manage connection**. Existing observation grants remain DM-only. Add supported user action scopes such as `chat:write` when offering actions; users enter these in Additional OAuth scopes and consent again. Do not add bot scopes to this desktop flow. The app reads direct messages and group
direct messages from the last three days, skips the user’s own messages, and
labels them Slack. The same workspace can install the app directly. Cross-workspace distribution needs Slack distribution approval/configuration. Commercial distribution must follow the [Slack Marketplace requirements](https://api.slack.com/changelog/2025-05-terms-rate-limit-update-and-faq); localhost PKCE acceptance alone does not prove public-distribution eligibility. Confirm the production redirect with Slack before release. See [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth)
and [PKCE](https://docs.slack.dev/authentication/using-pkce).

For Notion, create a public integration at
[My integrations](https://www.notion.so/my-integrations). A public distribution
registers the broker callback `<broker origin>/v1/notion/callback` and keeps the
client secret on the broker server; see the
[Notion broker operator guide](NOTION_BROKER.md) for the descriptor, endpoints
and remaining deployment work. An owner-private self-host can instead register
this redirect URL exactly:

`http://localhost:53682/oauth/notion`

Enable read content and read user information. Enable **Insert content** if users
will create work artifacts, and **Update content** when offering update actions. Add comment capabilities if your product uses those APIs.
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
accounts. Slack PKCE requires no secret. A public Notion build carries only the secretless broker descriptor `{clientId, brokerUrl}`; the publisher secret stays on the broker server, and the public app builder rejects Notion client-secret metadata. An owner-private installation can still exchange its own locally supplied secret; that local exchange is not a confidential-client deployment because a bundled secret is extractable. Use the official Notion MCP for interactive lookups without registering an app; native background observation requires the public integration and, for public builds, a deployed broker. Broker registration and HTTPS deployment remain publisher tasks.
The [Chinese setup walkthrough](CONNECTORS.zh-CN.md#为所有用户配置可执行的原生连接器)
includes registration steps and the user flow.

Provide the registered values in the launch environment, or put them in
`connector-clients.json` at the repository root (gitignored) or in the file named
by `UNPROMPTED_CONNECTOR_CLIENTS_FILE`:

```json
{
  "github": { "clientId": "YOUR_GITHUB_APP_CLIENT_ID" },
  "microsoft": { "clientId": "YOUR_MICROSOFT_APPLICATION_ID" },
  "slack": { "clientId": "YOUR_SLACK_CLIENT_ID" },
  "notion": { "clientId": "YOUR_NOTION_CLIENT_ID", "brokerUrl": "https://broker.example.test" }
}
```

The `broker.example.test` origin is a reserved, nonfunctional placeholder. An owner-private self-host can use `clientSecret` instead of `brokerUrl`.
Environment names are `UNPROMPTED_GITHUB_CLIENT_ID`, `UNPROMPTED_MICROSOFT_CLIENT_ID`,
`UNPROMPTED_SLACK_CLIENT_ID`, `UNPROMPTED_SLACK_CLIENT_SECRET`,
`UNPROMPTED_NOTION_CLIENT_ID`, `UNPROMPTED_NOTION_BROKER_URL` and
`UNPROMPTED_NOTION_CLIENT_SECRET`. A public Notion build uses the client ID with the broker URL; an owner-private self-host can instead set the client ID with the client secret locally. Notion accepts either the broker descriptor or an ID/secret pair, not both. Slack needs only its ID; the legacy Slack secret setting is optional. Google uses the separate Desktop
client file described in [account setup](ONBOARDING.md).

The app builder accepts `--connector-clients /path/to/connector-clients.json`.
It keeps GitHub, Outlook and Slack Client IDs and the secretless Notion `{clientId, brokerUrl}` descriptor. It rejects a Notion client secret. An optional legacy Slack secret is removed from the public build; PKCE does not use it.
It discards account tokens, refresh tokens, and GitHub or Outlook client secrets.
Tests use scripted providers; a publisher still needs consent from real accounts.

## Observation and recovery contract

Provider record IDs identify objects; normalized event IDs identify deliveries of
one revision. `providerRevision` or `providerEtag` may be an opaque value: compare
for equality, never sort it. Modification timestamps provide ordering where the
provider supplies them. A replay is idempotent; message updates replace the local
body and revise affected requests. GitHub PR identity uses repository + PR number,
since search returns an issue ID while the pulls endpoint returns a pull ID.

An ingested page may acknowledge its checkpoint. An ingestion failure acknowledges
nothing. A partial pull keeps failed scopes at their prior position while allowing
acknowledged pages/scopes to progress. `hasMore` means incomplete coverage and keeps
observation health from claiming a complete pass. An expired checkpoint starts a
new baseline before enumeration; failed recovery preserves the old checkpoint.
Google exposes explicit per-scope checkpoint outcomes. Outlook carries `recovering`
through every reset page; Notion retries a partial search page; Slack persists the
frozen history window and continuation until all included conversations finish.

Drive changes tokens rejected with 400/410 restart a readable-file enumeration;
this restores current accessible documents, not a complete account of deletions
that happened during the outage. Gmail history discovery reads the newest messages
matching its bootstrap query (default `newer_than:14d -in:chats -in:sent`), so it
cannot claim to recover every old message; incremental observation defaults to
`newer_than:3d -in:chats -in:sent`. Set `GOOGLE_GMAIL_QUERY` to use one query for
both. Sent, Trash and Draft messages are excluded from new work. `GOOGLE_DOCUMENT_LIST_LIMIT` sets the target listing count per pull (1–500, default 20); provider pages are never truncated after
receiving a continuation token. Sheets export is CSV for the first sheet, not a
whole workbook reader. Slides export supplies text without images.

Slack freezes the upper window boundary and resumes history/reply/list pages.
It rotates availability/edit rechecks over the 200 most recently tracked messages,
and follows up to 100 known threads, including replies to old roots. It does not
provide exhaustive workspace history, unjoined channels, all past edits/deletions,
or threads whose roots were never observed. Workspace retention and provider rate
limits still apply. MCP lookup does not replace native background observation.

Calendar is off by default. Selecting it asks for
`calendar.events.readonly` and reopens Google consent; it reads the primary calendar,
bootstraps events from the previous 30 days onward, preserves recurrence metadata
without expanding every occurrence, follows pages and sync tokens, and resets on
400/410. Cancellation invalidates calendar evidence; it never reports that an
agent completed a meeting or a task. Secondary calendars are not included.

Reminders uses the public macOS scripting interface, requires Automation consent,
and reads up to 500 reminders from selected lists. Incomplete reads never imply
that absent reminders were completed. Todoist native reads up to 10,000 active
tasks across pages with each user's personal token. A missing task after a complete
scan means it is no longer followed, not verified agent completion. Both connectors
are read-only. Native Reminders, real OAuth and installed-app permission prompts
still need acceptance on actual accounts; fixtures are not that evidence.

## Publisher setup for low-friction connections

| Connection | Publisher provisions once | User does | Remaining distribution requirement |
| --- | --- | --- | --- |
| Google | Enable Gmail, Drive, Docs (if editing), Calendar (if offered); Desktop OAuth client via `--google-client` | Choose account and read scopes | External production consent, verified domains/privacy policy and applicable sensitive/restricted-scope review |
| GitHub | Public GitHub App, device flow, read Issues/PRs/Contents/Actions/Metadata; Client ID | Install on chosen repositories and authorize | Organization installation/approval may require an admin |
| Outlook | Entra app for any organization + personal accounts, public client/browser PKCE, delegated `User.Read`, `Mail.Read`, `offline_access`; Client ID | Sign in and consent | Publisher verification and tenant policy; draft scope is separately requested |
| Slack | PKCE app, Client ID, user DM scopes and optional channel scopes; registered production redirect | Authorize workspace and chosen access | Cross-workspace/Marketplace distribution and admin policy; verify redirect eligibility |
| Notion native | Public integration with Any workspace, Read content/user info, optional Insert content; public builds use a secretless `{clientId, brokerUrl}` descriptor, owner-private self-hosts may use ID + secret | Select pages | Broker registration and HTTPS deployment remain publisher tasks; no publisher identity is deployed |
| Local folders / Notes / Reminders | Bundle and sign the macOS application; no cloud app | Choose folders/lists and allow macOS access | Real signed-app permission acceptance |
| Notion / Linear / Atlassian / Todoist MCP | No private app registration in this client | Official provider sign-in | Vendor availability and organization admin policy |
| Todoist native | No developer app | Paste personal token once | Token rights are available through the platform API after action authorization |
| Brave / Firecrawl MCP | No OAuth application in this client | Supply an API key | Users pay/obtain keys; sharing a publisher key would require a controlled billing proxy |

Google testing consent is not a public release: external testing refresh tokens
normally expire after seven days for these scopes. Moving to Production does not
replace verification. Gmail/Drive data sent to a cloud model also matters when
assessing restricted-scope security-review requirements; local token storage alone
does not establish an exemption. See [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification),
[refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration),
[Microsoft account types](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app),
and [publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview).

Build after the actual registrations have supplied their values:

```sh
node scripts/build-macos-app.mjs --out outputs/Unprompted.app \
  --google-client /private/path/google-desktop-client.json \
  --connector-clients /private/path/connector-clients.json
```

Never distribute personal access/refresh tokens or a common user account. Each user
still authorizes their own account. App client metadata does not bypass provider
review, organization restrictions or repository/page selection.

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

## Using platform permissions for actions

Connections support observation and actions. The `platform_api` task tool exposes the connected Google, Microsoft Graph, GitHub, Slack, Notion and Todoist APIs through GET, HEAD, OPTIONS, POST, PUT, PATCH and DELETE. The platform decides whether the actual account token permits an operation; the app does not ship a static provider endpoint allowlist, and each user grant is enforced locally as a method and path prefix before dispatch. OAuth tokens stay inside the connector, requests remain on the platform origin, and redirects are rejected. Google also supports official service origins such as `calendar.googleapis.com` and `docs.googleapis.com`.

In connection settings, use **Additional OAuth scopes** to request Google, Microsoft or Slack permissions, then complete consent again. Defaults remain suitable for observation. GitHub App permissions are configured in the GitHub app and approved by its installations; Notion capabilities and page access are configured in the integration and approved again when changed. A local grant cannot expand provider permissions. Organization policies and provider verification still apply.

After connecting, open **Platform action access**, choose the API path scope (`/` covers the platform) and allow actions. The grant is bound to the connected account and can be revoked there. The API also supports method, task and project restrictions. This permits all granted platform operations within that scope, including sending and deletion. Existing specialized draft and artifact tools remain available.

General API calls accept JSON, form, text or base64 request bodies, custom noncredential headers and JSON, text or base64 responses. Requests are bounded to 192 KB and responses to 2 MB; large files require provider chunking or an appropriate MCP tool. Binary uploads and non-JSON endpoints therefore do not require a new connector action implementation.

Writes use the durable execution ledger and stable operation identities. A lost connection after dispatch remains unknown and is not automatically resent. An accepted response is not verified task completion. Supply an independent GET/HEAD readback and expected JSON fields (or explicit 204/404) when verification is available. Native Apple/selected-folder interfaces retain their existing supported operations; this HTTP tool does not expand operating-system automation APIs.

MCP write tools must be selected explicitly. Unknown annotations are treated as actions, and destructive annotations override a read-only hint. Larger authorized catalogs are searchable through `find_connected_tools` and callable through `call_connected_tool`; selection is no longer limited to the first 24 tools. When the model's schema budget omits an otherwise inline MCP tool, that same pair is retained automatically instead of silently dropping the capability; a catalog that fits completely keeps no extra meta tools. Each find re-reads the current authorized tools and schemas, and each call resolves the exact returned name against that current set, so revocation, account replacement, a closed server or a changed catalog fails closed. Search results include a bounded continuation when more tools match. A schema too large for one result is marked oversized; the finder can return its complete public JSON schema in bounded fragments by exact tool name. Continuations bind the current catalog or schema digest, so changed permissions or schemas require discovery to restart. Calls still validate arguments against the current server schema. Revoking a tool or disconnecting a server invalidates captured adapters. Generic MCP success is recorded as accepted because MCP does not standardize independent verification for arbitrary tools.

For an operation that may move money, first confirm a finite funds allowance in automatic follow-up settings. Then bind the platform grant or individual MCP tool to that allowance and explicitly confirm distinct request pointers for the integer amount in micros and its currency. A funds cap does not grant tool access by itself. Native checks bind the tool schema and connection identity, enforce the cumulative cap and expiry immediately before dispatch, and reject missing or mismatched currencies. Imported MCP JSON cannot grant financial access. Revoking a financial declaration retains write classification, including when the server advertises a read-only hint. An accepted generic response without independent financial readback leaves the amount held as unknown; it does not refund it or authorize a retry.

Authenticated local endpoints:

- `GET /api/connector-grants`: platform capabilities, granted-scope metadata and local grants.
- `POST /api/connector-grants`: `{ "connectorId": "github", "pathPrefix": "/repos/acme/project", "methods": ["POST", "PATCH"], "confirmed": true }`; optional `taskId` and `project` restrict the grant.
- `POST /api/connector-grants/:id/revoke`: revoke a grant.
- `POST /api/tasks/:id/platform-actions`: `{ "connectorId": "github", "request": { "method": "PATCH", "path": "/repos/acme/project/issues/42", "body": { "title": "Updated" } }, "inputVersion": 3, "confirmed": true }`. Use the current task version. Optional `verification` contains `request`, `status`, and `matches: [{ "pointer": "/title", "value": "Updated" }]`; optional `operationId` distinguishes an intentional repeat.
- `POST /api/setup/connections/:id/authorize`: accepts additional `scopes` for Microsoft and Slack; Google uses its setup scope object with `additionalScopes`.
- MCP server updates accept `writeTools` alongside `readTools`; imported configuration cannot grant writes.

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
- Start read-only. Execution needs scoped authority and independent
  `verify()`/readback. An accepted operation is not a verified result.
- Never require real credentials or private workspace records in tests or issues.

Run focused checks with `node --test test/device-oauth.test.js
test/connectors-multi.test.js test/connections-api.test.js`. The actual browser
contract is `npm run test:connections`; [Testing](TESTING.md) describes tooling.

Run `npm run check:connector-clients` to check the local distribution files without printing credentials. This checks file shape, not provider approval.
