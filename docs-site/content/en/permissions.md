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
- A transaction allowance is a separate limit, off by default at zero. You confirm its currency, cumulative amount and finite expiry. It never grants a provider, destination or tool by itself.
- Model token and fee limits are separate model settings, with daily UTC windows. Routing groups choose among saved models; they are not a quality evaluation.
- The model cannot grant these permissions. An explicit `UNPROMPTED_SHADOW_MODE=true` blocks external writes.

Each real action still needs your approval or a matching standing authorization. An unknown provider result is reconciled before another try. It is not treated as success.

## Money, fees and confirmation

Connecting a provider or MCP server, confirming a UI dialog, and granting a platform path are different steps. A UI confirmation is not provider authorization. An operation that may move money needs a finite transaction allowance, a separate confirmed financial contract for the exact tool or platform path, and the provider's own permissions. The allowance is off by default at zero, names one currency and expires independently. A funds cap alone never enables a tool.

A provider accepting a request is not a verified payment. Without independent financial readback the amount stays held and unknown; it is neither a refund nor permission to retry the same action automatically. Model token and fee allowances are separate from transaction funds. Their fees are estimates from prices you confirm; missing prices and usage stay unknown, and unpriced calls are not free.

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
