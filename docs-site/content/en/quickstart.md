---
title: Install and first run
description: Clone the repository, install dependencies, and start the local app with npm start.
---

## Requirements

- Node.js **20+** and npm. **22+** is recommended. The optional Pi harness needs **22.19+**.
- Git, or a downloaded source archive opened in a terminal.
- A browser.
- A model endpoint, a model ID, and an API key when the provider requires one. A compatible local model can omit the key.
- A cloud account only if you connect that cloud source. A local folder needs no account. Apple Notes needs macOS.

Check the runtime with `node --version`.

## Install and start

```sh
git clone https://github.com/PStarH/unprompted.git
cd unprompted
npm ci --include=optional
npm start
```

`npm ci --include=optional` installs the pinned SQLite runtime and the optional Pi and MCP packages. There is no frontend build.

`npm start` prints an address after **Ready**, for example `Ready → http://127.0.0.1:4173/`. Open that address. The server listens on localhost only and has no login.

If port 4173 is busy, the launcher picks another port and prints it. To request one port:

```sh
npm start -- --port 4180
```

An explicitly requested busy port fails and tells you to try another. Add `--no-open` if you do not want the launcher to open a browser.

## Connect a model

On the first screen, enter the API endpoint, model ID, and API key. Choose **Verify and connect model**. That sends one real structured request with invented content. A failure does not replace a connection that already worked. A success is stored privately, the key field is cleared, and the connection is used without a restart.

`npm start` does not load a `.env` file. See [Models](models.md) and [Configuration](configuration.md).

## Choose one source

One source is enough.

- **Local folders** read Markdown and text. **Choose folders** opens the macOS folder picker. Other systems take an absolute path. No Full Disk Access.
- **Apple Notes** is macOS only. Use **Choose Notes folders**. The app that launched Unprompted, often Terminal, needs Automation permission.
- **Google, GitHub, Outlook, Slack, and Notion** — your own account. Google uses **Connect Google**. GitHub uses **Get authorization code**. Outlook, Slack and Notion use **Connect** and the provider's page. [Connectors](connectors.md) lists what each one reads.

Authorization starts the first read without a restart. Counts come from the provider. An empty result stays empty.

## Demo, and what it is not

```sh
npm run demo
```

The demo is a disposable local simulation. It does not use saved accounts and does not contact external services. Use `npm start` for your own model and sources.

## After setup

Keep the process running if you want continuous observation. You can pause it, or choose **Check now**, from Connections. Sources start read-only. [Permissions and privacy](permissions.md) describes writes, local storage, and what a model provider receives.

If the page does not come up, use [Troubleshooting](troubleshooting.md).
