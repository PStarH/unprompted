---
title: Development and testing
description: Run the example, the test suites, the docs build, and find the extension points.
---

## Set up

```sh
git clone https://github.com/PStarH/unprompted.git
cd unprompted
npm ci --include=optional
npm run example
```

`npm run example` runs the deterministic scenario and prints the requests, evidence, prepared reply, approval, and verification path. It needs no credentials and makes no provider or model calls.

Use Node.js 20+ (22+ recommended); Pi requires 22.19+.

## Test commands

| Command | Covers |
| --- | --- |
| `npm test` | Main Node test runner. |
| `npm run test:fast` | Excludes the slow API, framework, and generalization suites. |
| `npm run test:workflow` | End-to-end workflow behavior. |
| `npm run test:api` | HTTP API contracts. |
| `npm run test:connectors` | Connector harnesses, OAuth, sync, Google durability, verification safety. |
| `npm run test:durable` | Durable execution, context, learning, privacy, runtime, pairs, situations, probes. |
| `npm run test:safety` | Reliability, send safety, MCP, Pi, task services. |
| `npm run test:browser` | Browser interaction contract; requires Playwright and a local browser. |
| `npm run test:workspace` | Workspace views and responsive behavior. |
| `npm run test:appearance` | Contrast and appearance contracts. |
| `npm run check:syntax` | Syntax checks across the project. |
| `npm run check:public` | Public-repository checks: links, credentials, private paths. |
| `npm run eval:pi` | 27 task contracts through the real Pi loop with scripted model responses. |

Run the smallest relevant suite first. Browser tests use simulated providers and do not prove a real account works. Live provider acceptance is a separate manual step.

## Repository shape

| Area | Where |
| --- | --- |
| HTTP server and routes | `server.js` |
| Engine and evidence | `src/` |
| Connectors | `src/connectors/`, `src/mcp.js` |
| Browser workspace | `public/` |
| Tests | `test/`, `test/browser/` |
| Docs sources | `docs/`, `website/docs/content/` |
| Public website | `website/` |
| macOS app builder | `scripts/build-macos-app.mjs` |
| Docs site generator | `website/docs/build.mjs` |

## Docs site

The docs are dependency-free static HTML generated from Markdown:

```sh
node website/docs/build.mjs
node website/docs/check-links.mjs
```

Sources are in `website/docs/content/en/` and `website/docs/content/zh/`; navigation and UI labels are in `website/docs/nav.json`. The build writes `website/docs/index.html`, language pages, `search-en.json`, `search-zh.json`, and `sitemap.xml`. It does not require a framework or a network connection.

When adding a page, update all three:

1. the English Markdown file;
2. the Chinese Markdown file with the same slug;
3. `website/docs/nav.json` for both languages.

Then run the build and link checker. Internal links use sibling `.md` names so `npm run check:public` can resolve them; the build rewrites them to `.html` page URLs.

## Extension points

| Goal | Start here |
| --- | --- |
| Add a connector | `src/connectors/`, connector harness tests, `docs/CONNECTORS.md`. |
| Add a write adapter | `src/providers.js`, permission and destination checks, verification/readback tests. |
| Change evidence or planning | `src/evidence.js`, `src/reasoning.js`, `src/probes/`, workflow tests. |
| Change durable jobs | `src/store.js`, durable runtime tests, migration and restart coverage. |
| Change the workspace | `public/`, browser contracts in `test/browser/`, appearance tests. |
| Add an MCP path | `src/mcp.js`, `src/tool-loop.js`, read-grant tests. |

Keep deterministic authority outside the model. A new capability needs a visible permission boundary, an idempotent dispatch path, and a verification story. Do not add a write path that reports success from an accepted request alone.

## Code conventions

- The project is plain JavaScript ES modules; there is no frontend framework build.
- Tests use Node's built-in test runner unless they are browser scripts.
- Source content and credentials stay out of tests; use scripted transports and fixtures.
- Generated docs and public output must pass `npm run check:public`.
- Do not commit `.env`, `setup.json`, OAuth client JSON, workspace state, logs, or screenshots containing real content.

## Contributing

- [Open an issue](https://github.com/PStarH/unprompted/issues/new/choose) with a minimal reproduction and no private data.
- Read [`CONTRIBUTING.md`](https://github.com/PStarH/unprompted/blob/main/CONTRIBUTING.md) if present in the checkout.
- Security reports should not include live credentials or personal content.
- The project is Apache-2.0 licensed.

## Related reading

- [Architecture](architecture.md)
- [Local API](api.md)
- [Connectors](connectors.md)
- [Troubleshooting](troubleshooting.md)
