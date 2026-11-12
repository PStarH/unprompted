---
title: Google Workspace
description: Connect Gmail, Google documents and calendar, and allow actions as needed.
---

Under **Connections → Google**, select Gmail, Google Docs / Sheets / Slides and the primary calendar you want to observe. Choose your own account and consent on Google. Enabling calendar or adding permissions requires consent again. The connection card shows the last observation and counts.

## Allow actions

Enter the scopes you need in **Additional OAuth scopes**, separated by spaces. After Google consent, select and confirm the API path under **Platform action access**.

| Action | Additional scope |
| --- | --- |
| Manage Gmail drafts | `https://www.googleapis.com/auth/gmail.compose` |
| Send mail | `https://www.googleapis.com/auth/gmail.send` |
| Edit Google Docs | `https://www.googleapis.com/auth/documents` |
| Edit Google Sheets | `https://www.googleapis.com/auth/spreadsheets` |
| Edit Google Slides | `https://www.googleapis.com/auth/presentations` |
| Manage calendar events | `https://www.googleapis.com/auth/calendar.events` |
| Archive mail or change labels | `https://www.googleapis.com/auth/gmail.modify` |

`gmail.compose` also permits sending at Google. The local platform action grant controls which API paths Unprompted can call; `/` covers all Google API paths. Existing dedicated Gmail sending and Docs editing flows have their own action settings. For drafts alone, you can authorize a Drafts destination under **Create work artifacts**.

The publisher must configure the permissions with Google first; work accounts can also be restricted by an administrator. If a required scope is missing or the application is not approved, contact the publisher or your administrator.

## Search and disconnect

**Search Google** searches Gmail or document names; results do not automatically create tasks. **Disconnect** stops new observation and retains local history. **Disconnect and clear local copy** also removes the local copy, not the original at Google.

For other services see [Connectors](connectors.md). An explicit `UNPROMPTED_SHADOW_MODE=true` still blocks external writes.
