---
title: Connectors
description: Connect each work source and MCP service, choose what it can read, and enable actions when needed.
---

Connectors let Unprompted read selected work and, when you allow it, use actions supported by the service. First [connect a model](models.md), then open **Connections**. Start with one source; you do not need to connect everything. Sign in to your own accounts. An organization administrator may need to approve an app.

## Work sources and MCP

A **work source** checks your selected content on connection and continues observing while the app runs, normally every five minutes. You can pause it or choose **Check now**. **MCP** supplies tools used during a task; it does not automatically poll for changes or create tasks. A provider's native source and its MCP connection are separate and require separate authorization.

With publisher-provisioned clients, users do not need to register Google, GitHub, Outlook, Slack or Notion developer apps. Hosted Notion, Linear, Jira/Confluence and Todoist MCP presets use the vendor's sign-in page.

## Google: mail, documents and calendar

1. Choose **Connections → Google → Connect**.
2. Select Gmail, Google Docs / Sheets / Slides and the primary calendar as needed. Enabling calendar requires consent again.
3. To send mail or modify documents and events, enter the required space-separated scopes in **Additional OAuth scopes**. See [Google Workspace](google.md).
4. Select your own account on Google's consent page, approve the requested access and return to the app.
5. Check the account and last observation on the card. For actions, also allow **Platform action access** for the account and intended API path.

**Search Google** searches Gmail or document names; a search result does not automatically become a task. Contact the publisher or organization administrator if the app is restricted.

## GitHub: issues, PRs, commits and Actions

1. Open the GitHub App installation link supplied by the publisher. Choose your account or organization and the repositories to share. An organization may require admin approval.
2. In **Connections → GitHub**, request a device code, copy it, open GitHub's official page and enter the code.
3. Confirm authorization and return to the app. Check the account and last observation.
4. The source observes assigned issues, mentions, relevant pull requests and recent commits and Actions runs.
5. For comments or updates, the installation and your user need the corresponding GitHub permissions. Then grant **Platform action access**. New installation permissions may need approval again.

For example, `/repos/my-org/my-repo` covers the corresponding API paths for one repository. GitHub continues to enforce repository rules and your own access.

## Microsoft Outlook

1. Choose **Connections → Outlook**. Sign in and consent on the Microsoft page that opens.
2. To manage or send mail, open the connected account settings and reauthorize with `Mail.ReadWrite Mail.Send` under **Additional OAuth scopes**; add other Graph scopes as needed.
3. Return to the app and confirm that the account is connected. The source observes the inbox; calendar or file scopes do not start those observers.
4. For general Graph actions, allow the account and API path under **Platform action access**. For drafts, you can instead authorize a Drafts destination in **Create work artifacts**.

If Microsoft requires admin approval, contact your organization. Mail management and sending use distinct permissions.

## Slack: messages, channels and threads

1. Choose **Connections → Slack**. Direct and group messages are the default; select channel access to include joined channels and threads.
2. To send or update messages, enter `chat:write` in **Additional OAuth scopes**.
3. Sign in, select the right workspace and consent on Slack, then return to the app.
4. Allow the intended Slack API path under **Platform action access**. Slack still decides which conversations you can access.
5. Use **Manage connection** and consent again when adding scopes to an existing connection. Workspace installation can require admin approval.

## Notion: pages or MCP

**For ongoing page observation:** choose **Connections → Notion**, sign in and select the pages to share. To create or update, the publisher's integration must have the required capabilities and you must allow the account and path under platform action access. Native distribution depends on the publisher's OAuth configuration.

**For tools during a task:** choose **Connections → MCP → Notion → Sign in and connect**, complete Notion sign-in, then select the tools you want under **Tools and access**. MCP sign-in does not start native page observation.

## Todoist: native observation and MCP

**Observe tasks:** get your personal API token from Todoist **Settings → Integrations → Developer**, paste it into the native Todoist connection and connect. Keep the token private. Task actions also require local platform action access.

**Use tools:** choose **Connections → MCP → Todoist → Sign in and connect**, complete vendor sign-in and select tools. This does not automatically enable native task observation.

## Local folders

1. Choose **Connections → Local folders** and select a folder; non-macOS users can enter an absolute path.
2. The app observes supported `.md`, `.markdown` and `.txt` files, skipping hidden files, symbolic links and binaries.
3. Remove a selected scope in its connection details, or disconnect the source to stop all new reads.

Explicit to-dos such as `- [ ]`, `TODO:` and `☐` can be tracked. The existing local-folder connector reads selected files.

## Apple Notes and Reminders

1. On macOS, select Apple Notes or Apple Reminders under **Connections**.
2. Allow the macOS Automation prompt and choose the Notes folders or Reminders lists to observe.
3. If access was denied, open macOS **System Settings → Privacy & Security → Automation**, allow access for the application that actually launched Unprompted, and retry.
4. To create an Apple Note, separately authorize a selected folder under **Connections → Create work artifacts**.

Notes reads available text in selected folders and skips locked notes and attachments. The native Reminders connector observes selected lists and can create reminders in a separately authorized list. To edit, complete or delete existing reminders, separately allow **Platform action access**. Actions are limited to selected lists and check the last modification time. A source checkbox alone is not proof that the agent completed work.

## MCP presets and custom services

Open **Connections → MCP**:

- **Fetch:** enabled by default, no account; reads public page text without rendering scripts.
- **Notion, Linear, Jira and Confluence, Todoist:** choose the service and **Sign in and connect**, then consent at the vendor. An administrator may need to approve it.
- **Brave Search:** obtain your own key from [Brave Search API](https://api.search.brave.com/), enter it in the preset and connect. It searches the web.
- **Firecrawl:** obtain your own key from [Firecrawl](https://www.firecrawl.dev/), enter it in the preset and connect. It reads page content.
- **Other remote servers:** add the HTTPS MCP URL and supply authentication or sign in as required; localhost may use HTTP.
- **Local servers:** provide the command, arguments and required environment variables. The command runs as your system user; connect trusted servers only.

Expand **Tools and access** to select tools. Writable, destructive and unannotated tools require explicit action access. Select resources individually under **Resources and access**. Disconnecting a service invalidates captured tools.

## Allow actions and check results

Connecting an account does not automatically authorize all actions. First consent to the provider scopes, then grant the account and API path under **Platform action access**. `/` covers the platform's API paths, including any sending, editing or deletion permitted by your token. A narrower path limits API routes, but does not necessarily constrain recipients or channel IDs in a request body.

For drafts, Notion child pages or Apple Notes, you can also authorize a specific destination under **Create work artifacts**. Enable MCP write tools separately for each server. An explicit `UNPROMPTED_SHADOW_MODE=true` blocks external writes.

A provider accepting an action is distinct from independent readback verification. If the result is unknown, check the provider before attempting it again. See [Permissions and privacy](permissions.md).

## Disconnect and troubleshoot

**Disconnect** stops new observation and retains the local copy. **Disconnect and clear local copy** also removes the source's local copy and derived records, but does not delete the provider's original. MCP servers can be disabled or removed on their cards.

- Missing account or repository: check the signed-in account, GitHub installation, Slack workspace or Notion page selection.
- Reads work but writes fail: consent to the provider's write scopes again and check the local action or MCP tool grant.
- Slack or Notion callback fails: check whether local port 53682 is in use.
- Client ID requested, app not approved or organization policy blocks access: contact the publisher or your administrator; users do not need to register developer apps.
- Partial read or timeout: narrow the selected scope and check access. Check the actual provider state before repeating an uncertain write.
