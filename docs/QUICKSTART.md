# First run

[← Documentation](README.md)

## Requirements

- Node.js **20+** with npm; **22+** is recommended.
- Git to clone the repository. A source ZIP works too: extract it and open a
  terminal inside the extracted directory.
- A browser. The demo does not need an account, API key, network connection,
  `npm install`, or a build step after you have downloaded the source.

Check Node with `node --version`.

## Start the demo

```sh
git clone https://github.com/PStarH/unprompted.git
cd unprompted
npm run demo
```

Open **http://127.0.0.1:4173/**. These commands work in macOS / Linux terminals
and Windows PowerShell; no shell-specific environment assignment is needed.

The launcher creates a fresh temporary workspace on every run, ignores Google
and model configuration, and permits approval only against the local simulated
provider. Your normal saved workspace is not used. Temporary data is removed
when the demo exits normally.

## What you will see

The Northstar scenario takes about 15 seconds to reach a prepared action:

| When | Environment change | What Unprompted does |
| --- | --- | --- |
| Start | A proposal exists with results pending | Observes the document |
| ~2 seconds | Alex emails Maya about updating and returning it | Discovers the request and checks what is missing |
| ~5 seconds | An unrelated document changes | Observes and ignores it |
| ~9 seconds | Partial results arrive in the proposal | Checks the document and keeps the work open |
| ~12 seconds | A completed run is registered | Reconsiders whether the results are current |
| ~15 seconds | The complete proposal arrives | Verifies requirements and prepares a linked reply |
| Your choice | **Approve simulated send** | Records the local action and verifies its simulated receipt |

The proposal updates are inputs from the environment. The demo does not claim
that the agent edited the proposal itself. All events and receipts are labelled
as simulated.

![Reasoning chain from the actual application, using simulated data](assets/reasoning-chain.png)

Inspect **Evidence per requirement**, **Freshness**, the reply, and the document
link. You can also choose **Reject**. **Replay scenario** resets the simulated
workspace; you don't need to enter a task or click an analysis button.

## Normal mode

Stop the demo with **Ctrl+C**, then run:

```sh
npm start
```

Normal mode persists state in `data/state.json` and starts with **read-only
shadow mode**. With no Google credentials it still plays the simulation, but
refuses writes, including approval of a simulated reply. Use `npm run demo` to
experience the whole simulated loop.

For account connections, read [Google Workspace setup](LIVE_INTEGRATION.md).
For environment loading, ports, model configuration, and storage, see
[Configuration](CONFIGURATION.md).

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `node` or `npm` is not found | Install Node.js, reopen your terminal, and run `node --version`. |
| `ENOENT` / `package.json` not found | Change into the directory containing this project's `package.json`. |
| Port 4173 is busy | Run `npm run demo -- --port 4180`, then open http://127.0.0.1:4180/. |
| No approval control in normal mode | Normal mode is read-only by default. Stop it and run `npm run demo`. |
| Nothing new happens | Wait about 15 seconds, then use **Replay scenario**. Check that the terminal process is still running. |
| `STATE_LOCKED` | Another normal-mode process owns that state file. Stop that process or use a different state file. Don't delete an active lock. |
| Browser cannot connect | Use the exact `http://127.0.0.1:PORT/` address printed by the process. The server is local to the machine running it. |
| `.env` changes have no effect | `npm start` does not automatically read `.env`; use the explicit command in the [configuration guide](CONFIGURATION.md#loading-a-local-env-file). The demo intentionally ignores those credentials. |

Still stuck? [Open a bug report](https://github.com/PStarH/unprompted/issues/new/choose)
with your Node version, OS, command, and error text. Leave out credentials,
real email content, and state files.
