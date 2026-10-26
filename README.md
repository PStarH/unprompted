<p align="center"><img src="docs/assets/banner.svg" alt="Unprompted — Work without the prompt." width="100%"></p>

# Unprompted

**A proactive AI agent that notices what needs doing and moves it forward.**

Unprompted follows changes in the work and personal environments you authorize,
connects them to existing work, checks the evidence, and prepares the next useful action. You
join in when a decision needs you. Work starts without another prompt.

The current priority is learning whether users value an unrequested discovery
enough to keep Unprompted in their workflow. Email/document flows are engineering
samples for a general personal partner. [Product direction and current priority](docs/PRODUCT_DIRECTION.md)

[简体中文](README.zh-CN.md) · [Quick start](#start-your-agent) · [Docs](docs/README.md) · [Contribute](CONTRIBUTING.md) · [Report a bug](https://github.com/PStarH/unprompted/issues/new/choose)

[![CI](https://github.com/PStarH/unprompted/actions/workflows/ci.yml/badge.svg)](https://github.com/PStarH/unprompted/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-b9eea3)](LICENSE)
[![Node.js: 20+](https://img.shields.io/badge/Node.js-20%2B-174438)](package.json)

## Start your agent

You need **Node.js 20+** and your model provider's API endpoint, model ID and
API key. Local compatible models can work without a key. No dependency install
or build step is needed for the standard harness.

```sh
git clone https://github.com/PStarH/unprompted.git
cd unprompted
npm start
```

Open the address printed after **Ready**. An interactive terminal also opens
your browser. Enter the endpoint, model ID and key, then choose **Verify and
connect model**. The application sends one real structured inference using
invented content. Only a successful response saves the key locally and activates
the connection; no restart is required. Keys are not returned by the API.

Next, choose a source on the same page. **Local folders** work without a cloud
account: select a folder containing Markdown or text. **Apple Notes** is
macOS-only and asks for Automation permission; real-account acceptance is still
pending. Google, GitHub and Outlook use your provider account. GitHub and Outlook
use device authorization, so you confirm a short code on the provider’s page
instead of copying tokens. Sources can be paused or disconnected independently.
[Source permissions and limits →](docs/CONNECTORS.md)

For Google, a distribution with a registered Desktop OAuth client opens Google
consent directly. A self-hosted checkout without that client guides you through
the one-time Google Cloud setup and accepts its downloaded JSON. No refresh-token
copying or service restart is required.

Authorization starts the first read immediately. Actual email and document
content become model context; assigned GitHub issues retain their native source,
assignee and state. The page reports actual emails read, documents read
and work discovered. An empty result is shown as an empty result. **Normal
startup never plays a sample or invents tasks.**

Read access is the starting permission. Automatic observation can be paused,
and sending or editing requires a separate explicit opt-in. Model failure
keeps work unready; rules cannot silently substitute a successful model reading.

The interface supports English and Chinese. A busy default port is replaced
automatically; `npm start -- --port 4180` chooses a specific port.
[Download a source ZIP](https://github.com/PStarH/unprompted/archive/refs/heads/main.zip)
if you prefer not to use Git.

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

## What works today

Unprompted is an **early, local-first prototype**. The event engine, evidence
checks, approval boundary, persistence, interface, and simulated end-to-end
workflow are implemented. The primary experience connects your own model. The explicit rule-based example
is separate from model-backed operation.

| Area | Current scope |
| --- | --- |
| Context | Email requests, native assigned issues, document updates and run records |
| Local sources | Selected Markdown/text folders (explicit to-dos) and a read-only macOS Notes bridge; real Notes account acceptance is pending |
| GitHub | Device OAuth, assigned-issue discovery, update/reassignment tracking; read-only |
| Microsoft Outlook | Device OAuth, inbox delta sync and model-backed request discovery; read-only |
| Google Workspace | Optional Gmail / Drive / Docs connector; read-only setup is documented |
| Live sending | Implemented, explicitly gated, and covered by scripted tests; not claimed as validated in production |
| Task management | Trusted commitment revisions/withdrawals, persisted waits, reversible corrections and shared dependencies |
| Document changes | Source-backed, version-checked patches with separate authorization and readback |
| Local app | Browser OAuth setup, continuous observation controls and an unsigned macOS app builder |
| Storage | One user, one local JSON store, one server process |

Calendar, Slack, Notion, general desktop control, unrestricted autonomous rewriting, and a
hosted multi-user service are not implemented. Real-world usefulness and error
rates still need user feedback. [Architecture and limitations →](docs/ARCHITECTURE.md)

## Use your own workspace

`npm start` opens persistent model and source setup for **your real work**.
Sources start **read-only**. The interface supports first connection, initial
observation, incremental permissions, pause, retry and disconnect without
restarting the service. Each Google account has its own local workspace:

- [Local app and browser connection setup](docs/ONBOARDING.md)
- [Choose or build a connector](docs/CONNECTORS.md)
- [Connect Gmail and Drive](docs/LIVE_INTEGRATION.md)
- [Configuration and data handling](docs/CONFIGURATION.md)
- [API reference](docs/API.md)

The server binds to `127.0.0.1` and has no authentication. Run it on your own
machine. Task context is sent to your selected model provider. The explicitly
invoked rule-only example makes no model calls.

## Build it with us

Run a complete framework workflow without a server, account or model:

```sh
npm run example
npm run example -- --approve
```

The first command discovers a follow-up and prepares a reply while keeping
sends at zero. The second explicitly approves one **simulated** delivery,
verifies its receipt and checks that a duplicate event does not resend it.
Edit [the example](examples/first-workflow.mjs) to change the request or evidence.

```text
Connector events → WorkEngine → evidence / policy → provider → verified result
                      ↕
                  local store
```

[Extend your first workflow](docs/EXTENDING.md) explains the actual extension
boundaries, contracts and tests. The optional
[Pi harness](docs/CONFIGURATION.md#pi-tool-loop) adds bounded document-reading
tool calls; it requires Node.js 22.19+ and the optional packages. The core example
and demo require neither. To inspect the disposable browser simulation, run
`npm run demo`; it does not use saved accounts or contact external services.

Contribute a focused improvement; documentation, accessibility and synthetic
regression cases all help.

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
