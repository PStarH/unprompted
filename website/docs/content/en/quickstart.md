---
title: Install and first run
description: Requirements, the real npm start path, model connection, and choosing your first source.
---

## Requirements

- **Node.js 20+** with npm. **22+** is recommended, and the optional Pi harness needs **22.19+**.
- Git to clone the repository. A source ZIP works too.
- A browser.
- A model endpoint, model ID, and API key. Compatible local models can omit the key.
- A cloud account only for that cloud source. Local folders need no account. Apple Notes needs macOS.

Check Node before installing:

```sh
node --version
npm --version
```

## Install and start

```sh
git clone https://github.com/PStarH/unprompted.git
cd unprompted
npm ci --include=optional
npm start
```

`npm ci --include=optional` installs the pinned SQLite runtime and the optional Pi and MCP packages. There is no frontend build step.

`npm start` launches the persistent local app. It prints the address after **Ready**, for example:

```text
Ready → http://127.0.0.1:4173/
```

Open that exact address. The server binds to localhost and has no login. If port 4173 is busy, the launcher chooses another port and prints it. To request a specific port:

```sh
npm start -- --port 4180
```

Use `--no-open` to stop the launcher from opening a browser. Stop the app with `Ctrl+C`.

> [!NOTE]
> `npm start` does not load `.env` automatically. Use `node --env-file=.env server.js` when you want a local env file, or export variables in your shell before `npm start`.

## Connect a model

The first screen asks for:

| Field | What it means |
| --- | --- |
| API endpoint | An OpenAI-compatible chat-completions base URL, such as `https://api.openai.com/v1`. |
| Model ID | The provider's exact model name. |
| API key | Optional for compatible local models; required by most hosted providers. |

Choose **Verify and connect model**. Unprompted sends one real structured request using invented content. A failed request leaves the previous connection unchanged. A successful check saves the connection privately, clears the key field, and applies it without restarting.

The model interprets requests and prepares work. It cannot approve actions, grant permissions, or declare a task complete. See [Models](models.md) for the classic and Pi harnesses.

## Choose your first source

One source is enough to begin. The home screen offers:

- **Local folders** — select Markdown or text files. On macOS use the folder picker; elsewhere enter an absolute path. No OAuth client or Full Disk Access is needed.
- **Apple Notes** (macOS) — allow Automation access for the app running Unprompted, then select Notes folders.
- **Google** — Gmail and Google Docs, with read-only scopes first.
- **GitHub** — assigned issues, pull requests, commits, and Actions runs; read-only.
- **Outlook** — inbox mail through Microsoft Graph; read-only unless you authorize drafts.
- **Slack** — authorized direct and group messages; read-only.
- **Notion** — pages selected during consent; child-page creation needs a separate parent-page grant.

Authorization starts the first observation immediately. The page reports actual read counts and discovered work. An empty result is valid: normal startup never inserts a sample task.

For local limits, sign-in details, and MCP, read [Connectors](connectors.md). For Google Cloud setup, read [Google Workspace](google.md).

## What happens next

Open [Workspace](workspace.md) to review a task. A prepared reply or document is shown with its sources and the requirements it satisfies. You can approve, decline, steer, wait, or ask the agent to check again. External actions need permission; an unconfirmed result is never displayed as done.

If you want a disposable tour first:

```sh
npm run demo
```

The demo is a local simulation. It does not read saved accounts, call a model, or contact external services.

## If startup fails

| Symptom | First check |
| --- | --- |
| `node` or `npm` not found | Install Node.js, reopen the terminal, run `node --version`. |
| `package.json` not found | Change into the extracted or cloned project directory. |
| Port busy | The launcher picks another port; an explicit `--port` fails with a retry hint. |
| Nothing appears | Confirm a model and a source are connected, then use **Check now** in Connections. Zero discoveries can be valid. |
| `.env` has no effect | Load it explicitly with `node --env-file=.env server.js`. |

More in [Troubleshooting](troubleshooting.md).
