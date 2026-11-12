---
title: Troubleshooting
description: Fix startup, model, connector, review, and local-state problems without exposing private data.
---

## Start with the facts

Run the command that failed and read the whole error. Confirm the basics:

```sh
node --version
npm --version
pwd
node --check server.js
npm run check:syntax
```

The app prints the exact URL after **Ready**. Use that URL, including the port. The server is local to the machine running it.

## Common problems

| Symptom | What to do |
| --- | --- |
| `node` or `npm` not found | Install Node.js 20+ (22+ recommended), reopen the terminal, run `node --version`. |
| `ENOENT` or `package.json` not found | Change into the cloned or extracted project directory. |
| Port 4173 is busy | The launcher chooses another port and prints it. A requested busy port fails with a retry hint: `npm start -- --port 4180`. |
| Nothing appears in Work | Confirm a model and a source are connected. Inspect actual read counts and choose **Check now** in Connections. Zero discoveries can be valid. |
| Model verification fails | Check the base URL, exact model ID, key, and provider compatibility. Verification uses a real structured request. The previous connection stays unchanged when it fails. |
| Model is busy | A model request is already running. Wait for it; setup returns `MODEL_BUSY`. |
| Model settings are read-only | Environment-managed configuration returns `MODEL_ENV_CONFIGURED`. Change the launch environment, not the interface. |
| `.env` changes do nothing | `npm start` does not load `.env`. Use `node --env-file=.env server.js` or export the variables. |
| Google has no events | Confirm consent finished, the APIs are enabled, test-user access is valid, and polling or **Check now** is active. Incremental sync covers its current window. |
| Google consent fails | Use a **Desktop app** OAuth client, not a Web client. Check enabled APIs and test-user access. |
| Google refresh fails | The token may be expired or revoked. Authorize again. Testing-mode refresh tokens can expire after seven days. |
| Google send is refused | Sending needs `gmail.send`, `GOOGLE_SEND_ENABLED=true`, shadow mode off, approval or a standing grant, and readback. Reading and drafting can still work. |
| Outlook reports a failed delta | The checkpoint may have expired. Unprompted restarts an inbox enumeration without the initial three-day limit and deduplicates known messages. If it persists, reconnect. |
| OAuth callback fails | Use the exact loopback redirect: `http://localhost:53682/oauth/slack` or `http://localhost:53682/oauth/notion`. The port must be free. |
| `STATE_LOCKED` | Another normal-mode process owns that state file. Stop it or use a different state file and port. Do not delete an active lock. |
| Browser cannot connect | Use the printed `http://127.0.0.1:PORT/` address. A server on another machine or in a container needs an explicit reachable address. |
| `WORKSPACE_CONNECTING` | A connection transition is in progress. Wait for it to finish, then retry the request. |
| `REVIEW_CHANGED` | The source, guidance, or destination changed after the review was prepared. Fetch the current task and review it again. |
| `DURABLE_WORKSPACE_REQUIRED` | This mutation needs a durable workspace. Do not attempt it in the transient demo. |
| MCP tools are missing | Install `npm ci --include=optional`, restart, and check the server status. Unannotated tools need an explicit read grant; writable or destructive tools stay blocked. |
| An MCP resource is unavailable | Select the resource under **Resources and access**. Text resources only; templates and subscriptions are not supported. |
| A source paused or disconnected | Reconnect it and check provider status. A disconnected source cannot provide current evidence; its old work is not complete. |
| The app shows unknown or unconfirmed | That is a real state, not a bug. An external action without readback stays blocked until reconciliation. Do not retry blindly. |

## Inspect state without exposing it

```sh
curl http://127.0.0.1:4173/api/health
curl http://127.0.0.1:4173/api/runtime
curl http://127.0.0.1:4173/api/state
```

These are local and unauthenticated. Do not expose the port. When sharing output, remove account names, message content, document text, tokens, keys, and file paths.

## Reset safely

- **Demo:** stop it and run `npm run demo` again. The temporary workspace is disposable.
- **Normal mode:** stop the process first. Back up the state file if you need the history. Use a different `UNPROMPTED_STATE_FILE` and port for a second instance.
- **Credentials:** remove or rotate the provider grant, then remove the local setup entry. Deleting local state alone does not revoke a provider token.
- **Model:** disconnect or replace the connection. A failed replacement does not overwrite the previous working connection.

Do not remove a lock file while a process is running. If a process crashed and you are certain no instance is alive, move the state and lock aside together, then restart.

## When to open an issue

Include:

- operating system and architecture;
- Node.js and npm versions;
- the exact command and the address printed;
- the error text or API status code;
- whether the workspace is demo or normal;
- connector name and whether it uses a real or scripted account.

Exclude credentials, tokens, real email or document content, state files, and private paths. Use the repository's issue template:
[open a bug report](https://github.com/PStarH/unprompted/issues/new/choose).

## Related reading

- [Install and first run](quickstart.md)
- [Configuration](configuration.md)
- [Local API](api.md)
- [Development & testing](development.md)
