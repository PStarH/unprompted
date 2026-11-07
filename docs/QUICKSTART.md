# First run

[← Documentation](README.md)

## Requirements

Version 0.4.0 is a self-hosted web app. macOS and Windows use the same Node service and browser interface; Linux can also run it. No App installer or Docker is required. Hosted Windows CI covers installation, selected-folder reads, restart recovery and browser startup. Apple sources are macOS-only.

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

Check Node with `node --version`. Use the commands below in macOS Terminal or Windows PowerShell. If SQLite cannot download a prebuilt binary, its native build requires the platform C++ toolchain (Visual Studio Build Tools on Windows). Prefer Node.js 22 on a supported architecture.

## Upgrade, stop and remove

Before replacing an earlier version, stop its service with **Ctrl+C** and back up the entire configuration directory described in [storage](CONFIGURATION.md#persistent-local-setup). Include any separately configured state directory and all SQLite companion files. Keep the backup private: it contains account credentials and source content. Do not copy a live database as an upgrade backup.

Extract the new source into a separate directory, run `npm ci --include=optional`, then `npm start`. Use the same configuration/state paths to retain accounts and work. Do not run both versions against the same workspace. The 0.4.0 database upgrade is additive, but a previous application may refuse the newer schema: rollback requires stopping the new version and restoring the complete pre-upgrade backup before starting the previous version. An old executable alone is not a data rollback.

Deleting the extracted source or an optional App does not delete the platform configuration directory. To remove private local data, stop the service and separately delete the configuration/state directories and any backups you made. Source files in selected folders and records already sent to providers are separate. This source distribution has no automatic updater.

The default interface is local to the computer running the service. For a personal remote server, keep the loopback binding and use an SSH tunnel, for example `ssh -L 4173:127.0.0.1:4173 user@server`, then open `http://127.0.0.1:4173` locally. Loopback OAuth callbacks need their own forwards as well: the native Microsoft/Slack/Notion flow uses port 53682, MCP OAuth uses 53683, and Google chooses a temporary loopback port during sign-in. Add the matching SSH forwards before completing authorization; forwarding the web port alone does not make remote OAuth work. Remote OAuth acceptance has not been verified. Local file paths and MCP processes belong to the server, and macOS integrations require the server to be a Mac. The service has no built-in login: exposing its port publicly requires an independently configured access boundary.

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

GitHub uses device OAuth: copy its short code and confirm it on GitHub. Outlook opens Microsoft sign-in directly. Both connections start read-only and activate without restarting.

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
provider can receive the selected source content. Credentials are encrypted
at rest. The local workspace still contains source content and is not
encrypted. Review [secrets at rest](CONFIGURATION.md#secrets-at-rest)
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
