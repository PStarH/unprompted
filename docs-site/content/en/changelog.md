---
title: Changelog
description: What shipped in the current preview, version 0.3.0.
---

This is a pre-1.0 preview. The notes below summarize the only published release, 0.3.0, dated 2026-10-28. The full text is the repository [changelog](https://github.com/PStarH/unprompted/blob/main/CHANGELOG.md).

## 0.3.0

You connect your own model and the sources you authorize. A separate demo walks the loop from an event, through evidence and an authorized action, to a verified result, using invented data.

### First run

- Sources on the home page: local folders, Apple Notes on macOS, Google, GitHub, Outlook, Slack, and Notion. Several can be active without a restart. Each one disconnects on its own.
- Start with `npm start`, then **Verify and connect model**. A real structured response is required before a connection is saved. Keys stay out of the workspace, the API, and the event stream.
- GitHub and Outlook use device authorization and check the signed-in account before activation. Google consent applies without a restart and reads recent mail and existing Docs.
- Gmail and Outlook can save drafts. Notion and Apple Notes can create in a destination you authorize separately. Sending is its own grant. GitHub and Slack stay read-only.
- English and Chinese follow the browser language. If the default port is busy, startup prints another address.

### Limits stated with that release

- Tests use invented data and scripted providers. They do not prove real-user value or that a provider is reliable in production.
- One local user, and one writer per store. The extension surface is not a stable SDK.
- The macOS builder can produce an unsigned review bundle. Signing and notarization are separate release work. This site does not offer that download.
- Real unrequested discoveries remain the validation priority.

Install from [Install and first run](quickstart.md). Report a gap from [Contributing](contributing.md).
