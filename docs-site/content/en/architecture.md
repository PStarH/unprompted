---
title: Architecture
description: How one piece of work moves through the local Node.js process, and what is not implemented.
---

Unprompted is a Node.js process with SQLite, a browser interface in `public/`, and HTTP in `server.js`. `better-sqlite3` is required. Pi Agent Core and the MCP client are optional. The demo keeps a JSON store.

## One piece of work

```text
event → normalize → request → correlate → evidence
      → prepare → check authority → execute → verify
```

A later event can reassess an open request. An unrelated event is stored without a task. If newer evidence invalidates a draft, the draft is withdrawn. Completion requires a verified result, not a model sentence.

## Modules

| Layer | Role | Where |
| --- | --- | --- |
| Connectors | Read sources and keep cursors | `src/connectors/` |
| Context | Requests, documents, freshness | `src/requests.js`, `src/store.js` |
| Planning | Interpret and choose checks | `src/reasoning.js`, `src/pi-runtime.js` |
| Authority | Evidence and permissions | `src/evidence.js`, `src/permissions.js` |
| Execution | Prepare and run allowed actions | `src/engine.js` |
| MCP | Optional read tools | `src/mcp.js`, `src/tool-loop.js` |
| Interface | The local workspace | `public/` |

`src/contracts.js` defines the shapes those layers exchange.

## Not implemented

General desktop control, calendar, and unrestricted document rewriting are not implemented. There is no hosted service, no authentication, and no multi-user tenancy.

Google sync polls. It does not renew a push channel. Tests and scenario scores are about their fixtures. They are not a measurement of time saved or of production reliability.

The longer design note is [docs/ARCHITECTURE.md](https://github.com/PStarH/unprompted/blob/main/docs/ARCHITECTURE.md). The v0.3 baseline is [docs/PRD.md](https://github.com/PStarH/unprompted/blob/main/docs/PRD.md).
