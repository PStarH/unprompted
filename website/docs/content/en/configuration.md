---
title: Configuration
description: Modes, storage paths, model and Pi settings, Google options, connector clients, and transport limits.
---

## Choose a mode

| Command | Workspace | Credentials | External actions |
| --- | --- | --- | --- |
| `npm run demo` | Fresh temporary simulation | Google and model configuration ignored | Simulated local outbox only |
| `npm start` | Persistent local workspace | Saved in-app setup or inherited environment; `.env` is not loaded | Read-only unless separately authorized |
| `node --env-file=.env server.js` | Persistent or configured state file | Explicit local `.env` | Read-only unless explicitly enabled |

Normal mode reads only the sources you connect. An in-app authorization applies immediately and starts the first observation without a restart. Missing context does not start a simulation.

## Load a local env file

```sh
cp .env.example .env
node --env-file=.env server.js
```

`--env-file` needs Node.js 20.6+. `npm start` does not load `.env` automatically. Alternatively export variables in your shell and use `npm start`.

## Storage

| Setting | Default |
| --- | --- |
| `PORT` | `4173`, host always `127.0.0.1` |
| `UNPROMPTED_STATE_FILE` | Platform configuration directory |
| `UNPROMPTED_CONFIG_DIR` | Platform application-support directory |
| `UNPROMPTED_SETUP_FILE` | `setup.json` in the config directory |

The default config directory is `~/Library/Application Support/Unprompted` on macOS, `${XDG_CONFIG_HOME:-~/.config}/unprompted` on Linux, and `%APPDATA%\Unprompted` on Windows. On POSIX, the directory is mode `0700`; setup, model, and MCP files are mode `0600` where supported. Tokens and keys in those files are encrypted at rest. Workspace state is **not encrypted**.

UI-connected accounts use separate hashed state filenames in that directory. One process may write a state file at a time.

## Common settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNPROMPTED_SHADOW_MODE` | `true` | Refuse external writes, including simulated sends. Only the literal `false` opts out. |
| `UNPROMPTED_SYNC_INTERVAL_MS` | `0` | Legacy polling compatibility. Prefer the persistent Connections panel. |
| `UNPROMPTED_SYNC_TIMEOUT_MS` | unset | Hard ceiling for one connector pull. |
| `UNPROMPTED_STALL_AFTER_MS` | `86400000` | No-progress window before a waiting request needs a decision. |
| `UNPROMPTED_ATTENTION_SWEEP_MS` | `60000` | Attention sweep interval, 15 s to 24 h. |
| `UNPROMPTED_DATE_LOCALE` | unset | `MM/DD` or `DD/MM`. Ambiguous numeric dates stay unknown without it. |
| `UNPROMPTED_FORCE_SIMULATION` | `false` | Demo/test hint. Never starts simulated events in a live runtime or a state holding real events. |

## Model settings

| Variable | Meaning |
| --- | --- |
| `UNPROMPTED_MODEL_ROLE` | `primary` for model-primary interpretation; otherwise legacy assist. |
| `UNPROMPTED_MODEL_BASE_URL` | OpenAI-compatible chat-completions base URL. |
| `UNPROMPTED_MODEL_NAME` | Exact provider model ID. |
| `UNPROMPTED_MODEL_API_KEY` | Optional for compatible local models. |
| `UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE` | Global call bound. |
| `UNPROMPTED_AGENT_HARNESS` | `classic` (default) or `pi`. |

The adapter expects an OpenAI-compatible chat-completions endpoint. See [Models](models.md) for the interface flow and the classic/Pi comparison.

### Pi harness

Set `UNPROMPTED_AGENT_HARNESS=pi` on Node.js 22.19+ after `npm ci --include=optional`. The endpoint must support streaming chat completions and function tools. Pi allows at most four model requests, eight tool attempts, and 60 seconds per run; each provider request allows 2,048 output tokens, 20 seconds, and no SDK retries. Context is capped at 32,000 serialized characters. Oversized or malformed output fails explicitly and retains the deterministic assessment.

## Google settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | Desktop OAuth client credentials. |
| `GOOGLE_REFRESH_TOKEN` | unset | Locally stored refresh token. |
| `GOOGLE_ACCOUNT_EMAIL` | unset | Optional account label. |
| `GOOGLE_READ_GMAIL` / `GOOGLE_READ_DRIVE` | `true` | Enable each read scope. |
| `GOOGLE_GMAIL_QUERY` | unset | Optional initial Gmail query. |
| `GOOGLE_SEND_ENABLED` | `false` | Explicit live-send opt-in; still needs scope, approval, shadow mode off, and readback. |
| `GOOGLE_DRAFTS_ENABLED` | `false` | Draft adapter; also needs `gmail.compose` and a confirmed mailbox grant. |
| `GOOGLE_DOCS_WRITE_ENABLED` | `false` | Separate Docs write provider opt-in. Gmail send scope does not grant it. |
| `GOOGLE_REQUEST_TIMEOUT_MS` | `20000` | Per-request timeout. |
| `GOOGLE_SYNC_BUDGET_MS` | `120000` | Total connector-pull budget. |
| `GOOGLE_MAX_RETRIES` | `2` | Bounded retries for idempotent GETs only. |
| `GOOGLE_RETRY_BASE_MS` | `500` | Retry backoff base. |
| `GOOGLE_MAX_DOCUMENT_CHARS` | `1000000` | Maximum document export size. |

Read [Google Workspace](google.md) for the full setup.

## Connector clients

| Provider | Variables |
| --- | --- |
| GitHub | `UNPROMPTED_GITHUB_CLIENT_ID` |
| Microsoft | `UNPROMPTED_MICROSOFT_CLIENT_ID` |
| Slack | `UNPROMPTED_SLACK_CLIENT_ID`, `UNPROMPTED_SLACK_CLIENT_SECRET` |
| Notion | `UNPROMPTED_NOTION_CLIENT_ID`, `UNPROMPTED_NOTION_CLIENT_SECRET` |

Alternatively set `UNPROMPTED_CONNECTOR_CLIENTS_FILE` to a JSON file with `github.clientId`, `microsoft.clientId`, and Slack or Notion client ID/secret pairs. Google can be provisioned with `UNPROMPTED_GOOGLE_DESKTOP_CLIENT_FILE` or the client ID/secret pair. These supply client metadata only; users still authorize their own accounts. See [Connectors](connectors.md).

## HTTP transport limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNPROMPTED_HTTP_MAX_BODY_BYTES` | `1048576` | Maximum JSON request body. |
| `UNPROMPTED_HTTP_BODY_TIMEOUT_MS` | `30000` | Total JSON body receive deadline. |
| `UNPROMPTED_HTTP_BODY_IDLE_TIMEOUT_MS` | `10000` | Maximum wait between body chunks. |
| `UNPROMPTED_HTTP_REQUEST_TIMEOUT_MS` | `35000` | Complete-request receive timeout. |
| `UNPROMPTED_HTTP_MAX_SSE_CLIENTS` | `32` | Simultaneous event streams. |
| `UNPROMPTED_HTTP_SSE_MAX_FRAME_BYTES` | `8388608` | Maximum encoded full-state frame. |
| `UNPROMPTED_HTTP_SSE_MAX_CLIENT_BUFFER_BYTES` | `10485760` | Per-client buffer budget. |
| `UNPROMPTED_HTTP_SSE_MAX_TOTAL_BUFFER_BYTES` | `67108864` | Aggregate buffer budget. |
| `UNPROMPTED_HTTP_SSE_HEARTBEAT_MS` | `20000` | Heartbeat interval. |

Invalid values use defaults. Slow clients retain one latest pending snapshot; clients over budget are closed and can reconnect. These are transport limits, not a promise about total process memory or database size.

## Local sources and maintenance

Local folders are limited to selected paths and do not request Full Disk Access. Apple Notes reads selected folders through the host app's Automation permission. Revoking either grant makes evidence unavailable; it does not complete work.

`UNPROMPTED_ATTENTION_SWEEP_MS` controls attention and due read-only reasoning maintenance. Each automatic recovery pass admits at most two jobs, respects persisted backoff and attempts, and shares normal provider limits. It does not resend uncertain external actions.

## Resetting

**Ctrl+C** stops the app. Stop a normal workspace before backing up or moving its state file. Do not delete an active lock. For a second instance, use another port and state file.

For the local HTTP surface, read [Local API](api.md). For storage and execution design, read [Architecture](architecture.md).
