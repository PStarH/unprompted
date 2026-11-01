---
title: Development and testing
description: Commands for a first change, the test suites, and how this documentation site is built.
---

Issues and pull requests in English or Chinese are welcome. Node.js 20+ runs the base suite. Node.js 22.19+ is needed for the Pi checks.

## A small loop

```sh
npm run example
npm run example -- --approve
```

Both use invented data and the simulated provider. No account or model is required. Reports, pull requests, and review expectations are in [Contributing](contributing.md).

## Checks

```sh
npm test
npm run test:fast
npm run check:syntax
npm run check:public
```

`npm test` runs the behavioral, HTTP, connector, permission, storage, UI, and launcher tests. `test:fast` skips the long API, framework-eval, and generalization files. `check:syntax` parses the JavaScript Git already tracks. `check:public` checks publishable paths, Markdown links, and credential-shaped strings.

One file at a time:

```sh
npm test -- --file=test/workflow.test.js
npm run test:workflow
```

Browser contracts include `npm run test:model-onboarding`, `npm run test:google-onboarding`, and `npm run test:connections`. They use scripted local servers and scripted connectors. Do not point them at a personal workspace.

Optional evaluations: `npm run eval`, `npm run eval:framework`, `npm run eval:resilience`, `npm run eval:lifecycle`, `npm run eval:pi`, and `npm run eval:value`. A passing eval is evidence about its fixtures, not a production claim. Pi needs the optional install and Node.js 22.19+.

The macOS bundle is a local unsigned build:

```sh
npm run build:macos-app
npm run smoke:macos-app
```

## This site

```sh
node docs-site/build.mjs
node docs-site/check-links.mjs
```

Markdown lives in `docs-site/content/en/` and `docs-site/content/zh/`. Navigation labels live in `docs-site/nav.json`. The build writes `website/docs/`, which is the GitHub Pages path `/unprompted/docs/`.

## Where to edit

| Change | Start |
| --- | --- |
| A connector | `src/connectors/` and `docs/CONNECTORS.md` |
| Permissions or evidence | `src/permissions.js`, `src/evidence.js` |
| The workspace | `public/` and `test/browser/` |
| MCP | `src/mcp.js`, `src/tool-loop.js` |
| These pages | `docs-site/content/` |

Stage files by path. Do not use `git add -A` in this checkout. Other agents may have uncommitted work.
