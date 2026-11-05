---
title: Models
description: Connect an OpenAI-compatible model, choose the classic or Pi harness, and understand the limits.
---

## What the model does

Unprompted uses a configured model to interpret a request, correlate authorized context, and prepare work. The model is an interpreter and planner, not an authority:

- It cannot approve an action, grant a permission, or declare completion.
- Recognized rule-based requests still invoke the model when primary interpretation is active.
- A failed or ungrounded model reading cannot become a ready reply.
- Connecting a model grants no external write access.

The classic adapter makes one provider turn unless MCP tools are enabled. The optional Pi harness adds a bounded read-only tool loop.

## Connect from the interface

Run `npm start` and open the printed address. Enter the endpoint, model ID, and optional key, then choose **Verify and connect model**.

| Setting | Notes |
| --- | --- |
| API endpoint | OpenAI-compatible chat-completions base URL. |
| Model ID | Exact provider model name. |
| API key | Stored in the private local setup file when provided; never returned by the API or SSE. |
| Harness | `classic` by default; `pi` after installing the optional packages. |

Verification performs a real structured request with invented content. Only a successful request is saved. A failure leaves the previous connection unchanged. A working connection applies immediately, without a restart.

## Environment-managed setup

For a shell- or deployment-managed model, set:

```sh
UNPROMPTED_MODEL_ROLE=primary
UNPROMPTED_MODEL_BASE_URL=https://api.openai.com/v1
UNPROMPTED_MODEL_NAME=your-model-id
UNPROMPTED_MODEL_API_KEY=your-key
```

`UNPROMPTED_MODEL_ROLE=primary` makes model interpretation primary. Omit the key for a compatible local model that does not need one. `UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE` bounds calls.

`npm start` does not read `.env` automatically. Either export the variables or run:

```sh
node --env-file=.env server.js
```

## Classic or Pi

| | Classic | Pi |
| --- | --- | --- |
| Default | Yes | No |
| Provider turns | One, unless MCP tools are enabled | Bounded loop with read-only task tools |
| Install | Included | `npm ci --include=optional`, Node.js 22.19+ |
| Model requirements | Chat completions | Streaming chat completions and function tools |
| Best for | Lowest setup, predictable single-turn interpretation | Investigating correlated documents within explicit budgets |

Enable Pi with:

```sh
UNPROMPTED_AGENT_HARNESS=pi
```

Pi can search and read up to eight documents correlated with the current task. Each read rechecks availability and task scope; each chunk is at most 4,000 characters. Document excerpts may be sent to the configured model.

Per run, Pi allows at most four actual model requests, eight tool attempts, and 60 seconds. A provider request allows at most 2,048 output tokens, 20 seconds, and no SDK retries. Context is capped at 32,000 serialized characters. Oversized or malformed output fails explicitly, and the deterministic assessment is retained.

Pi's built-in tools expose no send, shell, filesystem, or permission operation. Separately authorized MCP tools follow their server's scope. See [Connectors](connectors.md#external-mcp-tools).

## Failure behavior

Normal product mode with no working model blocks action readiness. A failed inference does not silently fall back to a rule-only ready reply. If a model request is busy, setup returns `MODEL_BUSY`; environment-managed configuration returns `MODEL_ENV_CONFIGURED` and stays controlled by that environment.

## Data boundary

Prompts and selected source context go to the endpoint you configure. That provider's retention and training policy applies. Local state can retain the model's output and evidence excerpts. Treat the workspace as personal data. Read [Permissions & privacy](permissions.md) before connecting sensitive sources.

For the full environment table, see [Configuration](configuration.md#model-settings). For the HTTP boundary, see [Local API](api.md#model-connection).
