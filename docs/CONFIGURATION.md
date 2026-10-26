# Configuration and data handling

[← Documentation](README.md)

## Choose a mode

| Command | Workspace | Credentials | Sending |
| --- | --- | --- | --- |
| `npm run demo` | Fresh temporary simulation | Google and model configuration ignored | Simulated local outbox only |
| `npm start` | Persistent local workspace; Google accounts have separate state | Saved in-app model setup or inherited environment; `.env` is not automatically loaded | Real workspace read-only; no automatic sample |
| `node --env-file=.env server.js` | Persistent, or your configured state file | Explicit local `.env` file | Read-only unless explicitly enabled |

Normal mode reads only the sources you explicitly connect or configure. In-app
authorization applies immediately and starts the first observation without a
restart. Missing context does not start a simulation. Check `/api/health` and
`/api/runtime` to see what is actually connected; missing credentials never
produce a live connection.

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
| `UNPROMPTED_STATE_FILE` | Platform configuration directory | Explicit workspace location; UI-connected accounts use separate hashed filenames in that directory |
| `UNPROMPTED_SHADOW_MODE` | `true` | Refuse external writes, including simulated sends; only the literal `false` opts out |
| `UNPROMPTED_SYNC_INTERVAL_MS` | `0` | Legacy polling compatibility; new installations should use the persistent Connections settings panel |
| `UNPROMPTED_SYNC_TIMEOUT_MS` | unset | Optional hard ceiling for one connector pull |
| `UNPROMPTED_STALL_AFTER_MS` | `86400000` | Time with no evidence progress before a waiting request needs a decision |
| `UNPROMPTED_ATTENTION_SWEEP_MS` | `60000` | Attention sweep interval, at least 15 seconds |
| `UNPROMPTED_DATE_LOCALE` | unset | Explicit `MM/DD` or `DD/MM`; ambiguous numeric dates stay unknown without it |
| `UNPROMPTED_FORCE_SIMULATION` | `false` | Demo/test hint; simulated events are never started in a live runtime or a state holding real events |

Use the demo launcher for simulation instead of combining live credentials with
the demo/test hint. Demo runs use temporary setup and workspace files and do
not inherit user Google credentials.

## Persistent local setup

The **Connections → Continuous observation** panel stores the automatic sync
switch and interval across restarts. Enabling it performs an immediate sync;
the next run is scheduled after the current pass completes. Disabling it stops
future runs and preserves the last success, failure and expiration status.

The local setup file is `setup.json` under the platform application-support
directory (macOS: `~/Library/Application Support/Unprompted`; Linux:
`${XDG_CONFIG_HOME:-~/.config}/unprompted`; Windows: `%APPDATA%\\Unprompted`).
On POSIX systems its directory is mode `0700` and the file is mode `0600`.
`UNPROMPTED_CONFIG_DIR` can select a different directory; `UNPROMPTED_SETUP_FILE`
can point to a specific file for local development and isolated tests. Explicit
model configuration and full environment-managed Google credentials remain
authoritative. For UI-connected Google accounts, environment flags can restrict
access but cannot expand locally selected/granted scopes or enable unapproved
writes.

The browser connection flow and the bundled local app are described in the
[app and connection guide](ONBOARDING.md). Disconnecting an in-app source stops
its observation immediately. Environment-managed credentials remain the
operator's responsibility on a later boot.

## GitHub and Outlook client provisioning

Set `UNPROMPTED_GITHUB_CLIENT_ID` or `UNPROMPTED_MICROSOFT_CLIENT_ID` to the
registered public application ID. Alternatively set `UNPROMPTED_CONNECTOR_CLIENTS_FILE`
to a JSON with `github.clientId` and/or `microsoft.clientId`. The local app builder
accepts `--connector-clients PATH` and bundles only these public values.

End users use official device OAuth; they do not supply access tokens or client
secrets. Refresh tokens are stored in private local setup, with guarded rotation
and cancellation. The integrations are read-only. See [Connectors](CONNECTORS.md)
for exact application registration, scopes and supported behavior.

## Google client provisioning

A distribution can set `UNPROMPTED_GOOGLE_DESKTOP_CLIENT_FILE` to its registered
Desktop OAuth JSON, or provide `UNPROMPTED_GOOGLE_DESKTOP_CLIENT_ID` and
`UNPROMPTED_GOOGLE_DESKTOP_CLIENT_SECRET`. A bundled `google-oauth-client.json`
is also supported. These supply client metadata; users authorize their own
accounts through Google. The app builder’s `--google-client` option includes
only that metadata, never user tokens. Registration, audience and verification
remain the distributor’s responsibility. Without a provisioned client, the
interface guides self-hosted users through their one-time Cloud setup.

## Local source permissions

Local folders are limited to the paths you select. The app does not request Full
Disk Access. On macOS, Apple Notes uses the host app's Automation permission and
only reads selected Notes folders. Revoking a folder or Automation grant makes
its evidence unavailable; it does not count as completed work. Limits and
supported file types are listed in [Connectors](CONNECTORS.md#local-sources).

## Connect your model

Run `npm start`, then enter an API endpoint, model ID and key in the interface.
Compatible local models can omit the key. **Verify and connect model** sends
one real structured inference using invented content. Only a successful check
saves the connection privately and applies it without a restart.

Saved connections use primary interpretation: recognized requests still invoke
the model. The engine retains the original verifiable requirements. Failed or
ungrounded primary reasoning cannot silently produce a rule-only ready reply.
Connecting the model grants no real-world write authority.

For environment-controlled setup, set `UNPROMPTED_MODEL_ROLE=primary`,
`UNPROMPTED_MODEL_BASE_URL` and
`UNPROMPTED_MODEL_NAME`, plus `UNPROMPTED_MODEL_API_KEY` if your provider requires
one. The adapter expects an OpenAI-compatible chat-completions endpoint.

The model cannot approve actions, grant permissions, or declare completion.
The legacy assist mode remains available when the role is not `primary`; it
adds interpretation only where deterministic coverage is incomplete. The
`UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE` bounds model calls.

### Pi tool loop

Set `UNPROMPTED_AGENT_HARNESS=pi` to use Pi Agent Core 1.4.0 instead of the
default `classic` one-shot adapter. Install the pinned optional packages using
Node.js **22.19 or newer**:

```sh
npm ci --include=optional
```

Use your existing model base URL, model name and key. The endpoint must support
streaming chat completions and function tools. Leave the harness setting unset
to use the classic adapter; the deterministic demo still needs no installation.

Pi can search and read up to eight documents correlated with the current task.
The engine rechecks availability and task scope on each read; each chunk is at
most 4,000 characters. Document excerpts and selected chunks may be sent to the
configured model. Pi exposes no send, shell, filesystem, or permission tool.
Actions continue through the engine's existing authorization and receipt checks.

Each run allows at most four actual model requests, eight tool attempts and
60 seconds overall. Each provider request allows at most 2,048 output tokens,
20 seconds, and no SDK retries. The existing global rate limit, concurrency
ceiling and bounded queue apply to every model turn. Context is capped at
32,000 serialized characters; oversized or malformed output fails explicitly.
Failures retain the deterministic assessment and appear in runtime status.

`/api/runtime` includes active Pi phases (`starting`, `queued`, `reasoning`,
`reading`) and recent run summaries. Tool summaries contain names and outcomes,
without arguments or document content. Completed probe plans remain checkpointed
per task. In-flight conversations do not resume across a process restart.
The engine can resume bounded, persisted reasoning jobs by reconstructing the
read-only request; it does not replay a partially executed conversation.

Run `npm run eval:pi` for the existing 27 task contracts through the real Pi
loop using scripted model responses. This checks integration, not model quality.
See [the harness report](ARCHITECTURE.md#storage-and-process-model) for the implementation boundary.

**Enabling a remote model can send request content to that provider.** Decide
whether its data policy fits the content you connect. Leave these settings unset
for a fully local, deterministic demo.

## Work maintenance

`UNPROMPTED_ATTENTION_SWEEP_MS` controls attention and due read-only reasoning
maintenance. It defaults to 60,000 ms; accepted values are 15,000–86,400,000 ms.
Invalid values use the default. Each automatic recovery pass admits at most two
jobs, respects persisted backoff and attempts, and shares the provider's normal
limits. It does not resend uncertain external actions. See the
[harness lifecycle](ARCHITECTURE.md#storage-and-process-model) for retryable failures and remaining work.

## HTTP transport limits

These optional environment settings bound local request reception and queued
live snapshots. They are independent of business authorization and model/tool
execution budgets.

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNPROMPTED_HTTP_MAX_BODY_BYTES` | `1048576` | Maximum JSON request body in bytes |
| `UNPROMPTED_HTTP_BODY_TIMEOUT_MS` | `30000` | Total JSON body receive deadline |
| `UNPROMPTED_HTTP_BODY_IDLE_TIMEOUT_MS` | `10000` | Maximum wait between body chunks |
| `UNPROMPTED_HTTP_REQUEST_TIMEOUT_MS` | `35000` | Node HTTP complete-request receive timeout |
| `UNPROMPTED_HTTP_MAX_SSE_CLIENTS` | `32` | Maximum simultaneous event streams |
| `UNPROMPTED_HTTP_SSE_MAX_FRAME_BYTES` | `8388608` | Maximum encoded full-state frame |
| `UNPROMPTED_HTTP_SSE_MAX_CLIENT_BUFFER_BYTES` | `10485760` | Per-client in-flight and pending data budget |
| `UNPROMPTED_HTTP_SSE_MAX_TOTAL_BUFFER_BYTES` | `67108864` | Aggregate queued byte budget |
| `UNPROMPTED_HTTP_SSE_HEARTBEAT_MS` | `20000` | Heartbeat interval for unblocked streams |

Invalid settings use defaults. The effective per-client budget is at least the
configured maximum frame size. Slow clients retain one latest pending snapshot;
clients that would exceed the budget are closed and can reconnect. These are
transport accounting limits, not a promise about total process RSS or database
size. A workspace exceeding the frame cap remains accessible through the state
API, but its event stream needs a suitably sized transport configuration.

See [the quality report](TESTING.md) for measurements and fault coverage.

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
| `GOOGLE_DOCS_WRITE_ENABLED` | `false` | Separate Google Docs write provider opt-in; Gmail send scope does not grant this |
| `GOOGLE_REQUEST_TIMEOUT_MS` | `20000` | Per-request timeout |
| `GOOGLE_SYNC_BUDGET_MS` | `120000` | Total budget for a connector pull |
| `GOOGLE_MAX_RETRIES` | `2` | Bounded retries for idempotent GET requests only |
| `GOOGLE_RETRY_BASE_MS` | `500` | Retry backoff base |
| `GOOGLE_MAX_DOCUMENT_CHARS` | `1000000` | Maximum document export size |

## What stays on your machine

There is no project-hosted backend or analytics endpoint. The server binds to
localhost. In normal mode, the local JSON state can contain synchronized email,
document and selected local-source content, requests, evidence excerpts, drafts,
and action history.
**Treat that state as personal data.** Do not attach it to an issue or PR.

OAuth credentials can be entered in the local Connections setup panel or
provided through the environment. The setup panel stores them separately from
workspace state. Model keys can also be saved in that private setup file, with
mode 0600 on systems supporting those permission bits, or provided through the
environment. API and SSE projections do not return keys. Workspace state is
written atomically with restrictive file permissions and an exclusive process lock.
The permission bits depend on operating-system support; the state is not
encrypted. Don't put it in a public or shared directory.

Connected cloud sources contact their providers. An enabled model contacts its
configured endpoint.
The interface uses system fonts and makes no third-party font requests.
The local demo makes no provider, model, or external font calls.

## Resetting and stopping

Use **重新体验演示** in the simulated interface. It is refused for a workspace
holding real recorded events. The demo is disposable; run it again for a fresh
workspace. **Ctrl+C** stops either mode.

For a normal workspace, stop its process before backing up or moving the state
file. Don't delete its lock while a process is using it. One process may write a
state file at a time; use a separate port and state file for another instance.
