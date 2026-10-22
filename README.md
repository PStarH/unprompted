<p align="center"><img src="docs/assets/banner.svg" alt="Unprompted — Work without the prompt." width="100%"></p>

# Unprompted

**A proactive AI agent that notices what needs doing and moves it forward.**

Unprompted follows changes in an environment you authorize, connects them to
existing work, checks the evidence, and prepares the next useful action. You
join in when a decision needs you. Work starts without another prompt.

[简体中文](README.zh-CN.md) · [Quick start](#try-it-in-a-minute) · [Docs](docs/README.md) · [Contribute](CONTRIBUTING.md) · [Report a bug](https://github.com/PStarH/unprompted/issues/new/choose)

[![CI](https://github.com/PStarH/unprompted/actions/workflows/ci.yml/badge.svg)](https://github.com/PStarH/unprompted/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-b9eea3)](LICENSE)
[![Node.js: 20+](https://img.shields.io/badge/Node.js-20%2B-174438)](package.json)

## Try it in a minute

You need **Node.js 20+** and Git. Node.js 22 or newer is recommended.
No API key, account connection, package installation, or build step is needed.

```sh
git clone https://github.com/PStarH/unprompted.git
cd unprompted
npm run demo
```

Open **[http://127.0.0.1:4173](http://127.0.0.1:4173)** and watch for about
15 seconds. The scenario starts on its own.

1. An email arrives asking Maya for an updated proposal. Unprompted discovers
   the follow-through without receiving a task of its own.
2. A related document changes. It checks what is present, what is still missing,
   and whether the results match the latest known run. Unrelated edits are ignored.
3. Once the evidence is sufficient, a reply and document link are ready.
4. Click **Approve simulated send**. The action is recorded in the local
   simulated outbox, and completion follows a verified simulated receipt.

**The demo is entirely local and uses simulated data.** It ignores Google and
model credentials, uses a fresh temporary workspace, and sends no external
email. **Replay scenario** starts it again; **Ctrl+C** stops it.

Port busy? Run `npm run demo -- --port 4180`.
See the [first-run guide](docs/QUICKSTART.md) for screenshots, normal mode, and troubleshooting.

## What makes it proactive?

A new prompt isn't the trigger. A meaningful change in context is.

```text
An email arrives → a commitment is discovered → evidence changes
                → a reply is prepared → you approve → the result is verified
```

- **It notices existing work.** Requests are discovered from authorized events.
- **It follows the evidence.** Missing or stale information keeps work open;
  a newer result can withdraw a prepared draft automatically.
- **It does the preparation.** The next action comes with its document, sources,
  and checked requirements, ready for review.
- **It knows when to ask.** External actions require your approval or a
  previously stated, explicitly scoped authorization. Uncertain outcomes are
  reconciled before a retry.

<details>
<summary>See the reasoning chain in the current application</summary>

![Actual application: noticed email, linked proposal, verified requirements, prepared draft. Local simulated data.](docs/assets/reasoning-chain.png)

This is the running prototype, using its built-in local simulation.

</details>

## What works today

Unprompted is an **early, local-first prototype**. The event engine, evidence
checks, approval boundary, persistence, interface, and simulated end-to-end
workflow are implemented. The default experience is deterministic; an external
model is optional.

| Area | Current scope |
| --- | --- |
| Local demo | Self-starting scenario, evidence checks, prepared reply, simulated approval and verification |
| Context | Email requests, document updates, and run records |
| Google Workspace | Optional Gmail / Drive / Docs connector; read-only setup is documented |
| Live sending | Implemented, explicitly gated, and covered by scripted tests; not claimed as validated in production |
| Storage | One user, one local JSON store, one server process |

Calendar, Slack, general desktop control, autonomous document editing, and a
hosted multi-user service are not implemented. Real-world usefulness and error
rates still need user feedback. [Architecture and limitations →](docs/ARCHITECTURE.md)

## Use your own workspace

`npm start` runs the normal application with **read-only shadow mode on**.
Without configured credentials, it uses the local simulation. Optional Google
Workspace setup is separate from the one-command demo:

- [Connect Gmail and Drive](docs/LIVE_INTEGRATION.md)
- [Configuration and data handling](docs/CONFIGURATION.md)
- [API reference](docs/API.md)

The server binds to `127.0.0.1` and has no authentication. Run it on your own
machine. If you enable an external model, request content may be sent to that
provider; the default demo makes no model calls.

## Build it with us

**Star** the project if the direction resonates. **Try** the demo and tell us
what you expected it to notice. **Contribute** a focused improvement.

- New to the code? Start with the [contributor guide](CONTRIBUTING.md) and
  [good first issues](https://github.com/PStarH/unprompted/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22).
- Found a problem? [Open a bug report](https://github.com/PStarH/unprompted/issues/new/choose)
  with synthetic reproduction data.
- Have a scenario or idea? [Share it](https://github.com/PStarH/unprompted/issues/new/choose),
  including what should trigger discovery and what evidence would justify action.
- Working on a change? `npm run test:workflow` is a short first check;
  [testing docs](docs/TESTING.md) explain the full suite and evaluations.

Documentation, accessibility, reproducible scenarios, and regression tests are
all useful contributions. No separate contributor agreement is required.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.
