---
title: Google Workspace
description: Connect Gmail and Google Drive read-only, enable separate drafts or sending, and recover from consent problems.
---

## Read-only first

Google is optional. The first connection requests only read access to Gmail and Google Drive. Drafts, Gmail sending and Docs edits are independent permissions added later. Connecting Google never enables a write.

A distribution can include a registered Desktop OAuth client, in which case **Connect Google** opens consent directly. A self-hosted checkout without a client shows a one-time Google Cloud guide and accepts the downloaded Desktop client JSON.

## Self-hosted setup

### 1. Prepare the Google Cloud project

1. Create or select a Google Cloud project.
2. Enable the **Gmail API** and **Google Drive API**.
3. Configure the OAuth consent screen. For an external app in testing, add your test account under test users.
4. Create an OAuth client with application type **Desktop app** and download the JSON file. Keep it outside the repository.

Use a dedicated test account and fictional content for the first run. Gmail and Drive read scopes are restricted scopes; public distribution normally requires Google review unless an exception applies. Apps left in Testing can issue refresh tokens that expire after seven days.

### 2. Authorize in the app

Open **Connections → Google**, choose **Connect Google**, and follow the consent page. If the popup is blocked, use the visible link or the printed fallback URL. Consent applies immediately; no token copying and no restart.

For an environment-managed setup, the helper is an alternative:

```sh
node scripts/google-refresh-token.mjs /path/to/client_secret.json --write-env
```

The helper uses a localhost callback and requests:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive.readonly
```

Use a Desktop client, not a Web application client. `--write-env` writes the returned credentials to `.env` without printing them and preserves other entries. Do not add `--send` for the first read-only setup.

### 3. Configure read-only operation

```dotenv
GOOGLE_READ_GMAIL=true
GOOGLE_READ_DRIVE=true
GOOGLE_SEND_ENABLED=false
UNPROMPTED_SHADOW_MODE=true
UNPROMPTED_SYNC_INTERVAL_MS=60000
UNPROMPTED_STATE_FILE=./data/google-readonly.json
```

Load the file explicitly and start:

```sh
node --env-file=.env server.js
```

Check `http://127.0.0.1:4173/api/health` and `/api/runtime`. A read-only live workspace reports `mode: "live"`, `shadow: true`, and `google.sendEnabled: false`. Read-only mode still writes observed context to your local state; it does not change Google content.

## What is read

The connector reads recent Gmail and existing Google Docs visible to the authorized account, then follows incremental changes. A positive `UNPROMPTED_SYNC_INTERVAL_MS` polls automatically; `0` means request a sync through the API or **Check now**.

Google Docs read access comes through Drive. A Docs timestamp alone does not prove that a document's experiment results are current. Unsupported freshness claims stay withheld.

## Separate write permissions

These are not part of read-only consent:

| Action | Additional requirement |
| --- | --- |
| Create a Gmail draft | `GOOGLE_DRAFTS_ENABLED`, the `gmail.compose` scope, a confirmed mailbox destination grant, and write policy enabled |
| Send Gmail | `gmail.send`, `GOOGLE_SEND_ENABLED=true`, shadow mode off, approval or a standing grant, and readback verification |
| Edit Google Docs | Docs API enabled, the granted write scope, the Docs write provider opt-in, and explicit action authorization |

Sending also needs read access so the accepted message can be verified. An `accepted_live` or uncertain result stays blocked until reconciliation. Never retry blindly.

## Distribution setup

Provision a registered Desktop client once:

```sh
UNPROMPTED_GOOGLE_DESKTOP_CLIENT_FILE=/path/to/desktop-client.json npm start
```

For the macOS bundle:

```sh
node scripts/build-macos-app.mjs --out outputs/Unprompted-Connected.app --google-client /path/to/desktop-client.json
```

Users then consent with their own account without creating a Cloud project. This supplies client metadata; it does not create Google registration or verification for you.

## Disconnect and revoke

**Disconnect Google** stops this process's reads and external actions immediately. Local work records remain, and the client configuration is kept for reconnecting. For an environment-managed account, also remove the launch credentials if it should stay disconnected after a restart.

To revoke the provider grant, remove the app in your Google account's connected-app settings. Delete local credentials and state you no longer need, including backups and logs. Never submit them as feedback.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Waiting for a workspace | Finish consent. For environment setup, load `.env` explicitly and provide all credentials. |
| Consent denied | Enabled APIs, consent-screen test users, and Desktop client type. |
| Refresh fails | The token may be expired or revoked. Authorize again; Testing-mode tokens can expire after seven days. |
| No new events | Polling interval, Gmail query, document access, and connector status. Incremental sync only covers its current window. |
| Send is refused | Reading and drafting still work. Check every sending requirement above. |
| State is locked | Stop the other process or choose a different state file. Do not delete an active lock. |

For the shared privacy boundary, read [Permissions & privacy](permissions.md). For the API, see [Local API](api.md).
