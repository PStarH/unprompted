# Changelog

## 0.3.0 — 2026-10-28

Unprompted is an early, local-first proactive agent implementation. This preview
connects your own model and authorized workspace sources to discover actual work.
A separate deterministic example demonstrates the event → evidence → authorized
action → verified result loop for framework contributors.

### First experience

- Choose local folders, Apple Notes on macOS, Google Workspace, GitHub,
  Microsoft Outlook, Slack or Notion from the home page. Local file access is
  limited to selected Markdown/text folders. Apple Notes creation requires a
  separately authorized folder; its real-account flow still needs acceptance.
- GitHub and Outlook use official device OAuth and verify the signed-in account
  before activation. Distributions can provision public Client IDs once;
  self-hosted installs can enter them in the application.
- GitHub assignments retain native issue identity, repository, source link and
  assignee. Reassignment, closure and unavailable access stop tracking without
  claiming the agent completed the issue. Outlook reads inbox delta updates.
- Multiple sources activate without restart and disconnect independently. Gmail
  and Outlook can save drafts, and Notion and Apple Notes can create content in
  separately authorized destinations. Sending uses its independent authorization.
- A connector guide, synthetic OAuth/provider fixtures and a connector issue
  template provide an account-free path for new contributors. Historical design
  and audit notes are excluded from the maintained public documentation.
- Normal startup connects real models and real workspace context; it never
  schedules sample tasks. Google setup is available on the home page, with a direct consent
  path for provisioned clients and an in-app Cloud guide for self-hosted installs.
- Google consent applies without restart, verifies account identity, isolates
  each account's work, and immediately reads recent email and existing Docs.
  Counts and empty outcomes come from actual provider responses.
- Popup fallback, cancellation, API enablement recovery, retry, pause and
  reconnection have explicit states. Incremental action permissions apply without
  restart, and a new account cannot inherit another account's write authority.
- Read-only replies can be copied and declined. Live work always retains its
  real mail provider identity, preventing a missing send scope from producing a
  simulated receipt.

- The main entry is `npm start`, followed by **Verify and connect model** with
  the user's endpoint, model ID and key. Normal startup waits for this connection.
  The old no-model flow remains an explicitly separate rule-only example.
- A real structured response is required before saving a candidate connection.
  Primary interpretation invokes the model even for rule-recognized requests,
  preserves original requirements and blocks readiness on missing model review.
  Keys stay outside workspace/API/SSE records. Connection applies without restart.

- A dependency-free demo waits until the page connects before starting its
  15-second story. The launcher handles a busy default port and opens a browser
  from an interactive terminal.
- English and Chinese controls follow the browser language and remember your
  choice. The demo explains its current stage and shows the verified receipt.
- Refresh keeps the current story. Replay resets it. Declining sends nothing.
  The disposable demo explains how to start a persistent personal workspace.
- The local macOS launcher chooses a free port and verifies its own server's
  identity before opening real setup. Distributors can bundle their registered
  Desktop OAuth client using the builder's `--google-client` option.
- `npm run example` exercises the real engine without a server; `--approve`
  adds one simulated, verified delivery and checks duplicate-event behavior.
  The [extension guide](docs/EXTENDING.md) maps the code to extension boundaries.

### Framework and interaction

- Event normalization, source-backed assessments, freshness checks, scoped
  authority, versioned review, receipt lookup and durable recovery.
- Commitment revisions and withdrawal, persistent waits, reversible matching
  corrections, shared dependencies and source-backed document patches.
- Optional Pi read-tool reasoning with bounded budgets, task-scoped access and
  validated proposals. Core operation remains independent of installed packages.
- A proactive workspace with decision relay, evidence preview, stable editing
  through live updates, keyboard navigation and visible uncertain outcomes.
- Optional local Google setup and observation. Read access, document writes and
  mail sending have separate boundaries; normal mode remains read-only by default.

### Validation and limits

- Automated engine, recovery, lifecycle and browser contracts use invented data
  and local/scripted providers. They do not establish real-user value or real
  provider reliability.
- The framework imports and extension boundaries are early implementation APIs,
  not a stable versioned SDK. It runs one local user and one writer per store.
- Google use requires your OAuth configuration. The local macOS builder produces
  an unsigned review app; signing and notarization are separate release work.
- Real unrequested discoveries and explicit user evidence remain the product
  validation priority. See [product direction](docs/PRODUCT_DIRECTION.md).

Try the [first-run guide](docs/QUICKSTART.md), report a synthetic reproduction,
or open a small fix using [Contributing](CONTRIBUTING.md).
