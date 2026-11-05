---
title: Connectors
description: Local folders, Apple Notes, Google, GitHub, Outlook, Slack, Notion, and external MCP tools.
---

## Connect one source first

A source supplies work and context. Connect a model first, then choose a source on the home screen. Authorization applies without restarting. You can connect several sources, pause observation, retry a failed read, and disconnect one account while keeping the others.

| Source | Sign-in | Observed content | External actions |
| --- | --- | --- | --- |
| Local folders | Folder picker on macOS; absolute path elsewhere | Markdown and UTF-8 text in selected folders, including explicit text to-dos | Read-only |
| Apple Notes | macOS Automation permission, then selected folders | Plain text in selected folders; locked notes and attachments excluded | New notes in an explicitly authorized folder; real-account acceptance pending |
| Google Workspace | Desktop OAuth with PKCE | Gmail, Google Docs, and Drive changes | Drafts after separate authorization; Gmail sending and Docs editing have independent grants |
| GitHub | Official device OAuth | Assigned issues, review requests, recent commits, and Actions runs | Read-only |
| Microsoft Outlook | Official device OAuth | Inbox mail, initially the last three days, then Graph delta updates | Unsent drafts after separate authorization |
| Notion | Public integration browser OAuth | Pages selected during consent | Child pages in an explicitly authorized parent |
| Slack | User browser OAuth with PKCE | Authorized direct and group messages | Read-only |

Sources start read-only. Connecting an account never grants a write. A separate destination grant is required for drafts, new Notion pages, or new Apple Notes. See [Permissions & privacy](permissions.md).

## Local folders

Choose **Local folders**, then select a directory. On macOS the native picker opens; on other systems enter an absolute path. Unprompted reads only the selected folders, skips hidden files and symlinks, and does not request Full Disk Access.

Supported formats are `.md`, `.markdown`, and `.txt`. A pass is bounded to 500 files, 512 KiB per file, and 4 MiB of changed text. Only the first 100 explicit text to-dos in a supported document are tracked. `- [ ]`, `TODO:`, and `☐` are recognized; ordinary prose stays context.

Local document links work only on this computer. Do not use them as shareable links. Removing a folder invalidates its current evidence and stops source tasks; historical records stay in the private workspace.

## Apple Notes

Apple Notes is macOS-only. The app detects the operating system and does not recommend it on other systems. A Notes connection that already exists stays visible so you can disconnect it. The host app (for example Terminal when you run `npm start`) asks for Automation permission. Choose Notes folders to observe. Locked notes and attachments are not read. The connector is read-only unless you separately authorize a folder for note creation.

The Notes bridge uses Apple's public scripting interface, not the private Notes database. Automated tests use injected responses; a real Notes account and the signed app's permission prompt still need manual acceptance. Native Notes checkboxes are not a completion signal.

## Google Workspace

Google uses a Desktop OAuth client and PKCE. A distribution can provide a registered client; a self-hosted checkout without one guides you through a one-time Google Cloud setup. The first scopes are read-only for Gmail and Google Drive/Docs.

After consent, the connection applies immediately and the first pass reads recent mail and existing Docs. The page reports actual counts. Gmail drafts, sending, and Docs edits require separate authorization. Gmail sending also needs read access so the sent message can be verified.

Read [Google Workspace](google.md) for the exact setup, environment options, and recovery path.

## GitHub

GitHub uses the official device flow. Select **Connect**, copy the short code, and confirm it on GitHub's page. The connector reads assigned issues, pull requests awaiting your review or response, commits from the last three days, and Actions runs in that window. It is read-only: no comments, reviews, edits, merges, or workflow reruns.

GitHub needs a registered GitHub App with device flow and read access to Issues, Pull requests, Contents, Actions, and Metadata. A classic OAuth app can work when its account scopes cover the same reads. File patches and file bodies are not stored.

## Microsoft Outlook

Outlook uses the official device flow and delegated `User.Read`, `Mail.Read`, and `offline_access`. An organization may require administrator approval. The connector reads inbox mail, initially the last three days, then follows Graph delta updates.

If a delta checkpoint expires, Unprompted restarts an inbox enumeration without the initial three-day limit. Already ingested message IDs are deduplicated. This recovery has fixture coverage but has not been verified against a real Microsoft account. Outlook drafts need delegated `Mail.ReadWrite` and a separate destination grant; `Mail.Send` is not requested.

## Slack and Notion

Slack and Notion use a browser authorization code with fixed loopback redirects:

```text
http://localhost:53682/oauth/slack
http://localhost:53682/oauth/notion
```

Slack requires PKCE and only user-token scopes for direct and group messages. It reads messages from the last three days, skips your own messages, and is read-only. Other workspaces need public distribution and a separate directory review.

Notion uses a public integration. Users select the pages Unprompted may read during consent. Child-page creation needs **Read content** and **Insert content**, access to the chosen parent, and a separate grant. Existing read-only installations must be reauthorized after changing capabilities. Database entries are not supported.

## Observation and cursors

Source changes are observed by polling. `/api/stream` publishes workspace snapshots as observations are processed; it is not a provider webhook or a replayable per-event feed. Provider push is not enabled.

One observation follows up to five pages per connector. With automatic observation on, remaining pages can schedule up to four short continuation passes before the normal interval resumes. A one-off check processes at most five pages and leaves the remaining cursor for the next check.

An empty read is a valid result. A source closure stops tracking; it does not create a verified completion. Pausing observation keeps the connection and local history.

## External MCP tools

MCP is a client integration: external services supply tools to the agent. It is not an Unprompted server and does not discover new tasks by polling arbitrary tools.

Install the optional client, then restart:

```sh
npm ci --include=optional
```

In **Connections → MCP**, **Fetch** needs no account and is on by default. **Notion**, **Linear**, **Jira and Confluence**, and **Todoist** use **Sign in and connect** on the vendor page. No client secret or API token. **Brave Search** and **Firecrawl** still need an API key. Or choose **Add server** and enter a Streamable HTTP URL, a stdio command, or a pasted `mcpServers` object. Remote servers use HTTPS; HTTP is accepted on localhost. Signing in allows tools the server declares read-only. Other tools stay off until allowed. Writable or destructive tools stay blocked. MCP prompts are not implemented, and these servers do not discover tasks. An imported config cannot include OAuth tokens. An older Linear or Jira API-token entry stays until you remove it. Signing in replaces a saved Linear config.

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

Standard and Pi can both use authorized tools if the model supports function calling. Server read annotations are claims, not a security sandbox. Review individual tools; unannotated tools need an explicit read grant. Tools declared writable or destructive stay blocked. Disabling or removing a server revokes captured adapters and closes its process or transport.

Resource-only servers are supported. In **Resources and access**, select each resource the agent may read; none are enabled by default. Only text is used. Resource templates, subscriptions, and automatic change observation are not supported yet.

Credentials and sign-in tokens stay in a private `mcp.json` next to local setup, with mode `0600` where supported. The API never returns commands, arguments, environment values, headers, or tokens. The file is not encrypted. Call records are bounded and remain in the task workspace.

## Provision a distribution

Application registration is done once by the publisher. Users still authorize their own accounts. Provide client metadata through the launch environment or a gitignored `connector-clients.json`:

```json
{
  "github": { "clientId": "YOUR_GITHUB_APP_CLIENT_ID" },
  "microsoft": { "clientId": "YOUR_MICROSOFT_APPLICATION_ID" },
  "slack": { "clientId": "YOUR_SLACK_CLIENT_ID", "clientSecret": "YOUR_SLACK_CLIENT_SECRET" },
  "notion": { "clientId": "YOUR_NOTION_CLIENT_ID", "clientSecret": "YOUR_NOTION_CLIENT_SECRET" }
}
```

Environment names are `UNPROMPTED_GITHUB_CLIENT_ID`, `UNPROMPTED_MICROSOFT_CLIENT_ID`, `UNPROMPTED_SLACK_CLIENT_ID`, `UNPROMPTED_SLACK_CLIENT_SECRET`, `UNPROMPTED_NOTION_CLIENT_ID`, and `UNPROMPTED_NOTION_CLIENT_SECRET`. A code-flow pair is used only when both values are present. Google uses the separate Desktop client described in [Google Workspace](google.md).

The current Slack and Notion exchange runs locally, so a provisioned client secret reaches the local installation and is not a server-side confidential secret. Use a hosted OAuth exchange if the distribution requires confidential clients.

## Limits and acceptance

The repository does not ship a public client ID. Cloud sources need a registered app or a distribution that includes one. Automated coverage uses scripted providers; real-account consent, provider publication approval, and macOS Automation still need manual acceptance. Google, Outlook, Slack, and Notion are not presented as production-validated integrations.

For a developer view, read [Architecture](architecture.md) and [Development & testing](development.md). For the local API, see [Local API](api.md).
