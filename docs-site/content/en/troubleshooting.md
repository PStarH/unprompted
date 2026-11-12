---
title: Troubleshooting
description: What to check when install, the local page, a model, or a connector does not come up.
---

Leave credentials, mail, and state files out of any report.

| What you see | What to do |
| --- | --- |
| `node` or `npm` is missing | Install Node.js 20 or newer, open a new terminal, and run `node --version`. |
| `ENOENT` or `package.json` not found | `cd` into the directory that contains this project's `package.json`. |
| Port 4173 is busy | The launcher prints another address. A port you passed with `--port` fails if it is busy. Try a different one. |
| The browser cannot connect | Use the exact `http://127.0.0.1:PORT/` line printed after **Ready**. The server is only on that machine. |
| `.env` seems ignored | `npm start` does not load it. Use `node --env-file=.env server.js`, or export the variables. |
| The model will not connect | Verification is a real request. A failure leaves the previous connection unchanged. Check the endpoint, model ID, and key. |
| Nothing new appears | Confirm a model and at least one source, look at the read counts, and choose **Check now**. Zero items can be a real result. Normal mode does not insert samples. |
| Authorization does not finish | The card says what happened. Start again. An expired code is replaced with a new one. If the grant was saved, choose **Apply saved connection**. You do not sign in again. |
| A Google send does not leave | Sending needs a separate scope, `GOOGLE_SEND_ENABLED`, shadow mode off, and an approval. This path is tested with scripts, not claimed as production-validated. |
| `STATE_LOCKED` | Another normal-mode process holds that state file. Stop it, or use another state file. Do not delete a live lock. |
| Notes permission prompt | On macOS, allow Automation for the app that launched Unprompted, often Terminal. Locked notes are skipped. |
| Writes are refused | Check the provider scopes and local action grant. An explicit `UNPROMPTED_SHADOW_MODE=true` forces read-only mode. |

## Still stuck

Open a [bug report](https://github.com/PStarH/unprompted/issues/new/choose) with the Node version, operating system, command, and error text. Short answers are on the [FAQ](faq.md).

For a vulnerability, use [Security](security.md) instead of a public issue.
