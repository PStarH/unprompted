# Configuration and data handling

[← Documentation](README.md)

## Choose a mode

| Command | Workspace | Credentials | Sending |
| --- | --- | --- | --- |
| `npm run demo` | Fresh temporary simulation | Google and model configuration ignored | Simulated local outbox only |
| `npm start` | Persistent `data/state.json` by default | Inherited environment; `.env` is not automatically loaded | Read-only shadow mode by default |
| `node --env-file=.env server.js` | Persistent, or your configured state file | Explicit local `.env` file | Read-only unless explicitly enabled |

Normal mode switches to the Google connector only when all required Google
credentials are present. Check `/api/health` and `/api/runtime` to see what is
actually connected. Missing credentials do not produce a live connection.

## Loading a local env file

Copy `.env.example` to `.env` and edit only the settings you need. The file is
ignored by Git. Load it explicitly:

```sh
node --env-file=.env server.js
```

This command needs Node.js 20.6+; Node.js 22+ is recommended. Alternatively,
export settings through your shell and use `npm start`. `npm run demo` always
uses an isolated simulation, regardless of `.env` or exported credentials.

## Common settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4173` | Local listening port; host stays `127.0.0.1` |
| `UNPROMPTED_STATE_FILE` | `data/state.json` | Local persistent workspace |
| `UNPROMPTED_SHADOW_MODE` | `true` | Refuse external writes, including simulated sends; only the literal `false` opts out |
| `UNPROMPTED_SYNC_INTERVAL_MS` | `0` | Live polling; `0` disables automatic sync, positive values are clamped to at least 15 seconds |
| `UNPROMPTED_SYNC_TIMEOUT_MS` | unset | Optional hard ceiling for one connector pull |
| `UNPROMPTED_STALL_AFTER_MS` | `86400000` | Time with no evidence progress before a waiting request needs a decision |
| `UNPROMPTED_ATTENTION_SWEEP_MS` | `60000` | Attention sweep interval, at least 15 seconds |
| `UNPROMPTED_DATE_LOCALE` | unset | Explicit `MM/DD` or `DD/MM`; ambiguous numeric dates stay unknown without it |
| `UNPROMPTED_FORCE_SIMULATION` | `false` | Advanced simulation override; never injects a scenario over recorded real events |

Use the demo launcher for simulation instead of combining live credentials with
the advanced override.

## Optional model

The default path uses deterministic request interpretation and evidence probes.
To enable the optional provider, set `UNPROMPTED_MODEL_BASE_URL` and
`UNPROMPTED_MODEL_NAME`, plus `UNPROMPTED_MODEL_API_KEY` if your provider requires
one. The adapter expects an OpenAI-compatible chat-completions endpoint.

The model helps interpret requests that the deterministic pass cannot make
verifiable. It cannot approve actions, grant permissions, or declare completion.
Provider failures keep the deterministic assessment. The optional
`UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE` bounds model calls.

**Enabling a remote model can send request content to that provider.** Decide
whether its data policy fits the content you connect. Leave these settings unset
for a fully local, deterministic demo.

## Google settings

[Google Workspace setup](LIVE_INTEGRATION.md) explains how to obtain credentials.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | unset | Your desktop OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | unset | Its client secret |
| `GOOGLE_REFRESH_TOKEN` | unset | Your locally stored refresh token |
| `GOOGLE_ACCOUNT_EMAIL` | unset | Optional account label |
| `GOOGLE_READ_GMAIL` / `GOOGLE_READ_DRIVE` | `true` | Enable each read scope |
| `GOOGLE_GMAIL_QUERY` | unset | Optional initial Gmail query |
| `GOOGLE_SEND_ENABLED` | `false` | Explicit opt-in to the live send path |
| `GOOGLE_REQUEST_TIMEOUT_MS` | `20000` | Per-request timeout |
| `GOOGLE_SYNC_BUDGET_MS` | `120000` | Total budget for a connector pull |
| `GOOGLE_MAX_RETRIES` | `2` | Bounded retries for idempotent GET requests only |
| `GOOGLE_RETRY_BASE_MS` | `500` | Retry backoff base |
| `GOOGLE_MAX_DOCUMENT_CHARS` | `1000000` | Maximum document export size |

## What stays on your machine

There is no project-hosted backend or analytics endpoint. The server binds to
localhost. In normal mode, the local JSON state contains synchronized email and
document content, requests, evidence excerpts, drafts, and action history.
**Treat that state as personal data.** Do not attach it to an issue or PR.

OAuth credentials and model keys come from the environment. State is written
atomically with restrictive file permissions and an exclusive process lock.
The permission bits depend on operating-system support; the state is not
encrypted. Don't put it in a public or shared directory.

Google mode contacts Google. An enabled model contacts its configured endpoint.
The interface uses system fonts and makes no third-party font requests.
The local demo makes no provider, model, or external font calls.

## Resetting and stopping

Use **Replay scenario** in the simulated interface. It is refused for a workspace
holding real recorded events. The demo is disposable; run it again for a fresh
workspace. **Ctrl+C** stops either mode.

For a normal workspace, stop its process before backing up or moving the state
file. Don't delete its lock while a process is using it. One process may write a
state file at a time; use a separate port and state file for another instance.
