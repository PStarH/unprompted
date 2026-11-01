---
title: Models
description: Connect an OpenAI-compatible model from the app, and what that connection is allowed to do.
---

The model interprets requests and can correlate context. It cannot approve an action, grant a permission, or declare that work is complete.

## Connect from the app

Run `npm start`, then enter:

- API endpoint
- model ID
- API key, if the provider requires one

**Verify and connect model** sends one structured request using invented content. Only a successful check is saved. The key is stored in the private local setup file, not in workspace records, and it is not returned by the API or the event stream. Changing the endpoint does not reuse another provider's key.

A saved connection uses primary interpretation. Rules can still recognize a request, and the model is still called. The original verifiable requirements stay in force. A failed or ungrounded reading does not become a ready action.

With no model, normal mode does not mark work ready. `npm run demo` is the separate rule-only simulation.

## Environment settings

For an operator-controlled process, set:

- `UNPROMPTED_MODEL_ROLE=primary`
- `UNPROMPTED_MODEL_BASE_URL`
- `UNPROMPTED_MODEL_NAME`
- `UNPROMPTED_MODEL_API_KEY` when required

The adapter expects an OpenAI-compatible chat-completions endpoint. `UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE` bounds calls. `npm start` does not read `.env`. Load it with `node --env-file=.env server.js`, or export the variables yourself. Node.js 20.6+ is required for `--env-file`.

Leaving the role unset keeps the legacy assist mode, which adds interpretation only where deterministic coverage is incomplete.

## Pi harness

Set `UNPROMPTED_AGENT_HARNESS=pi` to use Pi Agent Core 1.4.0 instead of the default classic adapter. Install the optional packages with `npm ci --include=optional` on Node.js **22.19+**. The endpoint must support streaming chat completions and function tools.

Pi can search and read a bounded set of documents already correlated with the task. Its built-in tools do not send mail, run a shell, or change permissions. Each run is capped at four model requests, eight tool attempts, and 60 seconds. `npm run eval:pi` checks that integration with scripted responses. It does not score model quality.

## What leaves the machine

A remote model receives the selected task context. Decide whether that provider's policy fits the sources you connect. A fully local demo makes no model call. Connecting a model does not turn on connector writes. See [Permissions and privacy](permissions.md).
