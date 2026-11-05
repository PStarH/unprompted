---
title: Documentation
description: Install Unprompted, connect a model and a source, review prepared work, and understand the local-first boundaries.
layout: home
---

## What this documentation covers

Unprompted is a local-first work partner. It watches the sources you authorize, notices work that was not explicitly assigned, checks the evidence, prepares the next step, and asks before acting.

These pages describe the current `main` branch and the v0.3.0 release. They are written for two readers: someone running the app for the first time, and someone changing the code or calling its local API.

## How the pieces fit

```text
authorized source → observed change → evidence check → prepared work
                  → your decision → external action (if permitted) → readback
```

- **Sources** supply work and context. Local folders need no cloud account. Google, GitHub, Outlook, Slack, and Notion use your own account.
- **The model** interprets requests and correlates context. It cannot grant permissions or declare completion.
- **The workspace** shows what needs you, what is moving, and what is waiting, with the evidence behind each result.
- **Permissions** start read-only. Sending, drafting, document edits, and source writes require separate authorization.

## The workspace at a glance

![The Work page: one total, a status sentence, four state zones, and what the agent is watching and recently did.](../../assets/ui-work.png)

The interface is designed to stay quiet. New tasks and live updates do not open details, steal focus, or interrupt typing. Read [Workspace](workspace.md) for the task view, memory, connections, and settings.

## Current scope

This is a local, single-user, single-process implementation. It runs on your machine, binds to `127.0.0.1`, and has no built-in authentication. The local database, tokens, and model keys are not encrypted. Review [Permissions & privacy](permissions.md) before connecting sensitive work.

The repository does not ship a public OAuth client. Cloud sources need a client you register or a distribution that includes one. Real-account acceptance for several connectors is still pending; [Connectors](connectors.md) states the current boundary.

## Where to go next

- [Install and connect](quickstart.md) — run `npm start`, connect a model, and choose a source.
- [Connectors](connectors.md) — local folders, Google, GitHub, Outlook, Slack, Notion, and MCP.
- [Workspace](workspace.md) — review tasks, evidence, memory, and settings.
- [Local API](api.md) — inspect state and drive the workspace from a script.
- [Development & testing](development.md) — run the example, the test suites, and the docs build.
