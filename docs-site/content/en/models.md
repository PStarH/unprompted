---
title: Models
description: Connect a model over OpenAI Chat Completions, OpenAI Responses or Anthropic Messages, and what that connection is allowed to do.
---

The model interprets requests and can correlate context. It cannot approve an action, grant a permission, or declare that work is complete.

## Connect from the app

Run `npm start`, then enter:

- API endpoint
- model ID
- API key, if the provider requires one

**Advanced options** also selects the API protocol: OpenAI Chat Completions, OpenAI Responses or Anthropic Messages. The protocol decides the request path and how the key is sent; changing it requires verifying the connection again.

**Verify and connect model** sends one structured request using invented content. Only a successful check is saved. The key is stored in the private local setup file, not in workspace records, and it is not returned by the API or the event stream. Changing the endpoint does not reuse another provider's key.

A saved connection uses primary interpretation. Rules can still recognize a request, and the model is still called. The original verifiable requirements stay in force. A failed or ungrounded reading does not become a ready action.

With no model, normal mode does not mark work ready. `npm run demo` is the separate rule-only simulation.

## Environment settings

For an operator-controlled process, set:

- `UNPROMPTED_MODEL_ROLE=primary`
- `UNPROMPTED_MODEL_BASE_URL`
- `UNPROMPTED_MODEL_NAME`
- `UNPROMPTED_MODEL_API_KEY` when required
- `UNPROMPTED_MODEL_PROTOCOL=chat-completions|responses|messages`

The adapter supports `chat-completions` (OpenAI Chat Completions and compatible servers), `responses` (OpenAI Responses) and `messages` (Anthropic Messages). The default is `chat-completions`. Changing the protocol requires verifying the connection again. `UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE` bounds calls. `npm start` does not read `.env`. Load it with `node --env-file=.env server.js`, or export the variables yourself. Node.js 20.6+ is required for `--env-file`.

Leaving the role unset keeps the legacy assist mode, which adds interpretation only where deterministic coverage is incomplete.

## Token, fee and routing controls

Model settings can add daily UTC token and fee allowances, by workspace or by task. An explicit `null` disables a limit; `0` blocks new spending. Usage reports settled, reserved and unknown amounts. Fees are estimates from price profiles you confirm as explicit integer micro-currency rates per million tokens; a provider's actual bill may differ. Unpriced calls have unknown fees and are not reported as free. Saving prices does not activate a connection or save its credentials. Missing prices require your confirmation; the app does not invent prices, savings or quality guarantees.

A saved routing group chooses `modelIds`, a `defaultModel`, optional per-stage choices for interpret, discovery, planning, verification and general, and an optional `fallbackModel`. It is bounded dispatch configuration, not an evaluation of model quality. `requestCallLimit` and `maxRpcAttempts` belong to the same saved configuration. A configuration change before dispatch produces a controlled `configuration_changed` deferral with no request sent by that attempt.

`GET /api/model-controls?taskId=<existing task>` returns current limits, usage and price versions; omit `taskId` for the workspace. The [Local API](api.md) lists the save routes.

## Pi harness

Set `UNPROMPTED_AGENT_HARNESS=pi` to use Pi Agent Core 1.4.0 instead of the default classic adapter. Install the optional packages with `npm ci --include=optional` on Node.js **22.19+**. Pi supports the `chat-completions` protocol only, so the endpoint must support streaming chat completions and function tools.

Pi can search and read a bounded set of documents already correlated with the task. Its built-in tools do not send mail, run a shell, or change permissions. Each run is capped at four model requests, eight tool attempts, and 60 seconds. `npm run eval:pi` checks that integration with scripted responses. It does not score model quality.

## What leaves the machine

A remote model receives the selected task context. Decide whether that provider's policy fits the sources you connect. A fully local demo makes no model call. Connecting a model does not turn on connector writes. See [Permissions and privacy](permissions.md).
