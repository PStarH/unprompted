---
title: FAQ
description: Short answers about where Unprompted runs, what it can change, and where data stays.
---

These answers match the current app. Each one links to the longer page.

## Does it run in the cloud?

No. `npm start` binds to `127.0.0.1` on your machine. There is no login and no hosted workspace. Do not publish that port through a tunnel or reverse proxy. See [Security](security.md).

## Do I need an Unprompted account?

No. You connect your own model and authorize your own source accounts. A distribution can ship the connector apps already registered. You do not paste a client ID to get started. See [Connectors](connectors.md).

## Will it send mail or edit documents on its own?

A source starts read-only. Sending, drafts, document edits, and other writes need a separate grant. Saving a draft does not send it. An explicit `UNPROMPTED_SHADOW_MODE=true` blocks external writes. See [Permissions and privacy](permissions.md).

## Can it approve the next step for me?

Only after you start [automatic follow-up](follow-up.md). That lease can send a prepared reply or apply a prepared document patch. It still cannot skip evidence, a permission, or shadow mode.

## Does connecting a source let it create things there?

No. **Create work artifacts** is a separate grant. Destinations are Gmail drafts, Outlook drafts, Notion child pages, and Apple Notes folders. General GitHub and Slack actions require provider permissions and a separate local grant; the local folder connector currently reads files. See [Connectors](connectors.md).

## What is the difference between Disconnect and Forget?

**Disconnect** stops new reads and keeps the local copy. **Disconnect and clear local copy** removes that source's local records. **Forget** removes a chosen local record and reports cleanup that is still pending. It does not erase the provider's copy, or a request already sent to a model. "Do not do this again" is a suppression rule, not Forget.

## Why does startup ask me to verify a model?

**Verify and connect model** sends one structured request with invented content. A failure does not save the candidate. The key stays in the private setup file. See [Models](models.md).

## Why is my `.env` file ignored?

`npm start` does not load `.env`. Use `node --env-file=.env server.js` on Node.js 20.6 or newer, or export the variables. See [Configuration](configuration.md).

## Is `npm run demo` my workspace?

No. It is a disposable simulation. It ignores saved accounts and does not insert sample tasks into the normal workspace.

## Where is data stored, and is it encrypted?

The workspace is a local SQLite file and is not encrypted. OAuth tokens, model keys, and connector credentials are encrypted at rest in the platform config directory. On macOS that is `~/Library/Application Support/Unprompted`, and the key is kept in the login keychain. Where the system supports it, the directory is mode `0700` and the files are mode `0600`. See [Permissions and privacy](permissions.md).

## Which sources can I connect?

Local folders, Apple Notes on macOS, Google Workspace, GitHub, Outlook, Slack, and Notion. MCP is an optional lookup, not a task source. See [Connectors](connectors.md).

## Can the model mark work complete?

No. It cannot approve an action, grant a permission, or declare work complete. A verified result needs a readback after a permitted action. See [How work moves](workflows.md).

## What should I install?

Node.js 20 or newer, then `npm ci --include=optional` and `npm start`. Open the address printed after Ready. The Pi harness needs Node.js 22.19 or newer. There is no notarized Mac download. See [Install and first run](quickstart.md).

## How do I report a problem?

Bugs, interface issues, mistakes in these pages, and feature requests can be public issues. Leave out credentials, mail, and state files. Vulnerabilities use the private channel on [Security](security.md). Code changes start at [Contributing](contributing.md).
