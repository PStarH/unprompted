---
title: Permissions and privacy
description: Read-only defaults, separate write grants, YOLO limits, local storage, and what leaves your machine.
---

## Read is separate from write

Unprompted starts from a read-only contract. Connecting an account or selecting a folder grants observation only. A write requires a separate destination grant, and often a separate provider scope and provider opt-in.

| Layer | What it controls |
| --- | --- |
| Connection | The account or folder the app may read. |
| Read scope | Which content is observed. Missing scope means no read. |
| Destination grant | The specific mailbox, parent page, or folder a write may target. Separate from the read connection. |
| Provider opt-in | Environment or settings switch for a write adapter, such as `GOOGLE_SEND_ENABLED`. |
| Action approval | A person approves this action, or a scoped YOLO lease covers it. |
| Dispatch checks | Source, payload, version, privacy, connection, and destination are rechecked at action time. |
| Readback | A provider-accepted action is not reported as verified until the result is read back. |

An accepted-but-unconfirmed external action stays visible and blocked from retry until reconciliation. Shadow mode refuses external writes, including simulated sends.

## Approvals and YOLO

Individual approval is the default. A prepared action includes a review token tied to its current version. If the source, guidance, or destination changes, the token becomes stale and the action returns `REVIEW_CHANGED`.

YOLO is optional automatic approval:

- **Task YOLO** covers one task until it completes, is cancelled, declined, or becomes unavailable.
- **Time YOLO** covers the current workspace for 1–1440 minutes, including tasks discovered in that period.

YOLO is stored user authorization, not a model decision. A model response or tool argument cannot create a lease. Paused tasks and tasks requiring review of changed guidance do not proceed automatically. Expiration is checked at dispatch. Revoking a lease stops operations not yet dispatched; it cannot undo an action a provider already accepted.

## What stays local

There is no project-hosted backend and no analytics endpoint. The server binds to `127.0.0.1`. Normal mode can store synchronized email, document content, local-file excerpts, requests, evidence, drafts, and action history in a local SQLite workspace.

The platform application-support directory holds `setup.json`:

| Platform | Default location |
| --- | --- |
| macOS | `~/Library/Application Support/Unprompted` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/unprompted` |
| Windows | `%APPDATA%\Unprompted` |

`UNPROMPTED_CONFIG_DIR` selects another directory; `UNPROMPTED_SETUP_FILE` selects a specific file. On POSIX systems the directory is mode `0700` and setup/model/MCP files are mode `0600` where supported. **The workspace and credentials are not encrypted.** Use full-disk encryption and a private account.

Connected cloud sources contact their providers. An enabled model contacts its configured endpoint. The interface uses system fonts and makes no third-party font requests. The demo makes no provider, model, or font calls.

## What leaves your machine

| Destination | What can be sent |
| --- | --- |
| Your model endpoint | Prompts, requests, selected source excerpts, and tool results needed for the current task. |
| Google | API reads; writes only if separately enabled and approved. |
| GitHub | API reads. No comments, reviews, merges, or workflow changes. |
| Microsoft Graph | Mail reads; draft creation only after separate authorization. |
| Slack | Message reads. |
| Notion | Page reads; child-page writes only in an authorized parent. |
| MCP server | Tool arguments and whatever the server returns. Review each server and tool. |

Read-only mode prevents writes through Unprompted. It does not prevent task context from being sent to your model provider, and it does not change that provider's retention or training policy.

## Local API exposure

The local API has no authentication. Origin checks and JSON requirements reduce browser cross-site abuse; they are not a login and do not protect against another process on the same machine. Do not expose the port to a network. Do not put the workspace in a public or shared directory.

## Deleting data

- **Forget this context** removes selected memory and task context behind confirmation.
- **Disconnect** stops observation and actions for that source. Local history remains.
- Deleting a memory or local record does not delete the original email, document, or provider data.
- To revoke a provider grant, use the provider's connected-app settings.
- Stop the process before backing up, moving, or removing a state file. Do not delete an active lock.

Never attach a state file, OAuth token, model key, real email, or document content to a bug report.

## A short privacy checklist

1. Start with a local folder and fictional content.
2. Connect one cloud source at a time and review the actual read scopes.
3. Keep shadow mode on until you understand the prepared actions.
4. Use a model endpoint whose data policy fits the content.
5. Keep the app on localhost and the state directory private.
6. Delete local state and revoke provider grants when you no longer need them.

For the execution boundary, read [Architecture](architecture.md). For connector-specific scopes, read [Connectors](connectors.md).
