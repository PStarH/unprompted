# First run

[← Documentation](README.md)

## Requirements

- Node.js **20+** with npm; **22+** is recommended.
- Git to clone the repository. A source ZIP works too: extract it and open a
  terminal inside the extracted directory.
- A browser and a model endpoint/model ID/API key (the key is optional for
  compatible local models). You can start with a local folder; a Google, GitHub
  or Microsoft account is only needed for that cloud source. Apple Notes needs
  macOS.
- Cloud OAuth needs a registered provider app. Distributions can supply it; a
  self-hosted setup may require one-time registration. Local folders need no
  connector registration. Run `npm ci --include=optional` once for the pinned
  SQLite runtime and optional harness integrations. No frontend build is required.

Check Node with `node --version`.

## Start the model-backed agent

```sh
git clone https://github.com/PStarH/unprompted.git
cd unprompted
npm ci --include=optional
npm start
```

Open the address after **Ready**. Enter your provider's API endpoint, model ID
and API key; compatible local models may omit the key. **Verify and connect
model** sends a real structured request using invented content. A failed request
leaves the previous connection unchanged. Successful verification saves the
connection privately, clears the key field and applies it without restarting.

Choose a source on the same page. To start without a cloud account, select a
local folder containing Markdown or text. On macOS, choose folders in the native
picker; on other systems, enter the folder path. Apple Notes is macOS-only and
requires Automation permission for the app that runs Unprompted. Only the
selected folders are read. Its real-account acceptance is still pending.

GitHub and Outlook use official device OAuth: select Connect, copy the short
code and confirm it on the official sign-in page. Both connections start
read-only and activate without restarting.

For Google, use its connection card. If a Desktop OAuth client is provisioned,
choose **Connect Google**. Otherwise, follow the three in-app Google Cloud steps,
download a Desktop app client JSON, and choose **Import and connect Google**.
The import continues directly to authorization. A blocked popup has a regular
link fallback.

For Google, choose the account and allow the selected read access. The page
activates the connection without restarting and immediately reads recent email
and existing Google Docs. Counts and discovered work reflect actual provider
responses. Read access starts with no sending or document edits. Leave automatic
observation on to check periodically, or pause it in Connections.

Normal mode never plays a sample, including after connecting a model or reloading.
If a service fails, its status includes retry or reconnection guidance. Work
requires successful model reading; failed inference does not become a rule-only
ready action. [Detailed Google setup and recovery](LIVE_INTEGRATION.md).

The launcher handles a busy default port. You can choose one with
`npm start -- --port 4180`. The connection form and settings support English and
Chinese. Your key is stored outside workspace records and is not returned by
the API or SSE stream. See [model configuration](CONFIGURATION.md#connect-your-model).

## What happens after setup

Unprompted reads the sources you selected and shows actual read counts, current
work and any decisions that need you. An empty result is valid; normal startup
never inserts sample tasks. Keep the local app running for automatic observation.
Pause observation or run **Check now** from Connections whenever you want.

Sources start read-only. Google sending and document edits require separate
permissions; other listed connectors do not send or edit. A configured model
provider can receive the selected source content. Local state contains source
content and is not encrypted. Review [data handling](CONFIGURATION.md#what-stays-on-your-machine)
before connecting sensitive work.

For source permissions, limits and account setup, read [Connectors](CONNECTORS.md)
and [Google Workspace setup](LIVE_INTEGRATION.md). For model configuration,
storage, or the optional Pi harness, see [Configuration](CONFIGURATION.md).

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `node` or `npm` is not found | Install Node.js, reopen your terminal, and run `node --version`. |
| `ENOENT` / `package.json` not found | Change into the directory containing this project's `package.json`. |
| Port 4173 is busy | The launcher chooses another port and prints the address. An explicitly requested busy port fails with a command to try. |
| Nothing appears | Check that the model and at least one source are connected, inspect actual read counts, and choose Check now. Zero discoveries can be a valid result. |
| A Google reply cannot send | Sending requires a separately authorized Gmail scope and explicit action permission. See the [Google integration guide](LIVE_INTEGRATION.md#live-send-testing-for-contributors); this path is not yet validated in production. |
| `STATE_LOCKED` | Another normal-mode process owns that state file. Stop that process or use a different state file. Don't delete an active lock. |
| Browser cannot connect | Use the exact `http://127.0.0.1:PORT/` address printed by the process. The server is local to the machine running it. |
| `.env` changes have no effect | `npm start` does not automatically read `.env`; use the explicit command in the [configuration guide](CONFIGURATION.md#loading-a-local-env-file). |

Still stuck? [Open a bug report](https://github.com/PStarH/unprompted/issues/new/choose)
with your Node version, OS, command, and error text. Leave out credentials,
real email content, and state files.
