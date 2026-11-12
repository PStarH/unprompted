---
title: Permissions and privacy
description: What the app can read, what it can write, and what stays on the machine.
---

Reads start when you connect a source. Writes do not. The server binds to localhost and has no authentication. Do not publish it through a tunnel, reverse proxy, or public host.

## Defaults

- Sources start with reads. Platform actions need provider permission and a local account and API path grant; `/` covers all API paths for that platform.
- Dedicated Google send and Docs editing flows have their own action settings. See [Google Workspace](google.md).
- General GitHub, Slack, Outlook, Notion, Google and Todoist API actions depend on actual provider permissions and the locally granted scope. Creating an Apple Note needs a folder grant.
- Writable, destructive and unannotated MCP tools need explicit action access; importing configuration never grants writes.
- The model cannot grant these permissions. An explicit `UNPROMPTED_SHADOW_MODE=true` blocks external writes.

Each real action still needs your approval or a matching standing authorization. An unknown provider result is reconciled before another try. It is not treated as success.

## What is stored

Normal mode keeps a SQLite workspace on the machine. It can contain synchronized mail, documents, local text, evidence excerpts, drafts, and action history. Treat that file as personal data. It is not encrypted. Do not attach it to an issue.

OAuth tokens and the model key live in the private setup file under the platform application-support directory. On macOS that is `~/Library/Application Support/Unprompted`. POSIX permissions are `0700` for the directory and `0600` for the file. MCP credentials live in `mcp.json` beside it. The API does not return those secrets.

There is no project analytics endpoint. Connected providers and an enabled model endpoint do receive the content required for their calls.

## Disconnect, clear, and forget

- **Disconnect** stops new reads and keeps the local copy.
- **Disconnect and clear local copy** removes that source's local inbox, tasks, snapshots, and derived records. It can wait for the current sync.
- **Forget** removes a chosen local record and reports cleanup that is still pending, including database readers and copies you registered. It does not erase the provider's copy or a request already sent to a model.

"Do not do this again" is a separate suppression rule, not Forget.

## Reports

Use [Security](security.md) for a vulnerability. That page points at [private vulnerability reporting](https://github.com/PStarH/unprompted/security/advisories/new). Do not include credentials, mail, or state files.
