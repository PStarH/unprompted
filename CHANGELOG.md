# Changelog

## 0.5.1 — 2026-11-17

This release merges the published 0.4.x `main` line with the 0.5.0 candidate
and adds the following verified local behavior. It is a pre-1.0 preview; model
signing and real-account acceptance remain separate work.

### Security and authority

- OAuth tokens, model API keys and connector credentials in `setup.json` and
  `mcp.json` are sealed with AES-256-GCM before they touch disk. The key lives
  in the OS secret store (macOS login keychain, Linux secret service, Windows
  DPAPI), with a mode `0600` fallback file when no store is available. Existing
  installs are sealed on the next launch without another sign-in. The workspace
  SQLite database is not encrypted.
- Every approved external write carries a sealed, single-use authority
  credential bound to its task and effect. The ledger re-decides at the
  before-dispatch boundary and refuses a missing, replaced or spent credential,
  so an approval cannot drift to a different action.
- A dispatched send is read back and verified before the task may complete.
  Provider acceptance alone is surfaced to the model but is never treated as a
  completed delivery.
- The workspace admits an item to "Needs you" only when the next action is the
  user's own; task counts include every open task rather than only admitted
  ones.

### Reliability and maintenance

- Release-acceptance scenes and a connector sync matrix exercise the six
  end-to-end product clauses in the browser and in the repository suite.
- Expired private reasoning sessions are swept from the runtime maintenance
  tick, and a schema read-only open now requires the current schema and FTS
  secure-delete instead of silently proceeding.
- Retrying a non-live attempt after reconciliation proved no effect is allowed
  again; a dispatched live attempt still cannot be repeated under the same
  identity.
- The browser keeps a single MCP preset catalog, and the docs cover Apple
  Calendar, Mail and Contacts configuration and credential handling.

### Sources and delivery

- GitHub repositories can optionally send signed webhooks to a local receiver.
  The receiver verifies the HMAC over the exact request body, checks the
  current account and repository allowlist, and commits one idempotent receipt
  and, when a pull is needed, one durable job atomically. The existing GitHub
  connector then performs its normal authorized incremental pull. It never
  accepts provider content, registers a hook, opens a tunnel or replaces
  polling.
- Source health reports a bounded public failure message and a fixed repair
  classification, with retry timing where the provider supplies it.
  Credentials, account identifiers, continuation tokens and response bodies
  are redacted.
- The tagged 0.4.0 line is retained, including zero-config Apple Calendar, Mail
  and Contacts connectors and its navigation browser coverage.

### Model, token and money controls

- Saved routing groups can select a model per stage (interpret, discovery,
  planning, verification, general) with an optional fallback model. Fallback is
  limited to classified provider-transient, transport or capability-unsupported
  failures; routing is not a quality or price ranking and cannot switch
  provider credentials.
- Model settings can enforce optional daily UTC token limits and model-fee
  limits by workspace or task. `null` disables a limit; `0` blocks new
  spending. Usage reports settled, reserved and unknown amounts, and missing
  usage or prices are never treated as zero. Configured token and fee limits
  are enforced on the classic harness path through the accounting adapters;
  call paths that cannot account for a request (notably the Pi harness) are
  refused while a relevant limit is configured.
- Automatic follow-up can include a separate finite transaction allowance in
  one explicit USD, CNY or EUR currency, with a cumulative micro-unit cap, its
  own expiry and explicit confirmation. A positive cap requires the persistent
  native workspace. A paid platform or MCP action needs a separate confirmed
  contract that maps the exact amount and currency fields to the allowance.
  The allowance does not grant a provider, destination or tool.
- Model usage that cannot be accounted for and accepted transactions without
  independent financial readback keep their full hold as unknown; the hold is
  not a refund and the action is not retried blindly. Renewal, expiry,
  revocation and restart do not reset consumed funds or unknown holds, and
  there is no automatic currency conversion.

### Durable execution and workspace

- Durable reasoning sessions, model commits, planning-context revisions,
  budget wakes and bounded crash recovery preserve execution state across
  restarts. Startup revalidation checks at most eight risk-ordered open tasks
  by default and reports how many were left outside that sweep.
- Supervised Experience trials evaluate a candidate against saved declarative
  cases and can prepare a scoped format trial for an existing draft under its
  current review token. A trial result is advisory; adoption changes planning
  eligibility only and never grants a connector, tool or provider permission.
- The workspace adds model budget/routing controls, source health and repair
  states, memory focus/navigation and task page focus. The macOS app build uses
  the package version for its bundle metadata.
- Notion distribution work includes a local broker backend and desktop client
  protocol for a confidential OAuth publisher. It is not deployed and has no
  registered publisher identity; self-hosted Notion connections remain
  available.

### Known limitations

- Polling remains the primary path for every source. Only GitHub has an
  optional webhook; it is a latency hint for an authorized pull, not guaranteed
  delivery, and no other provider has push. `/api/stream` is a workspace
  snapshot, not an event stream.
- A GitHub webhook needs a repository the operator administers, an HTTPS
  endpoint or reverse proxy that forwards only `/api/webhooks/github`, a
  16–1024 character secret, a repository allowlist and an already connected
  GitHub account. The receiver never registers the hook or opens a tunnel.
- Connection health reflects the last sync attempt and its classified failure;
  it is not an active uptime probe. A source that has never synced reports
  unknown.
- Memory validity follows source availability and the stored source reference,
  not later source revisions. Editing a source document does not automatically
  invalidate a remembered fact.
- Model routing is bounded per-stage dispatch configuration. It does not rank
  models by quality or price.
- Token and fee limits are optional and off until configured. Fees are
  estimates from user-confirmed integer prices; a provider bill can differ.
  Missing prices or usage stay unknown, not free. Token and fee limits are
  separate from transaction allowances. The Pi harness is refused while a
  relevant limit is configured.
- A transaction allowance is not payment capability and cannot promise a
  provider-side hard bank limit. It does not perform currency conversion.
  Unknown outcomes hold the amount and are not retried blindly.
- Automatic observation reads a narrow provider-defined subset. Broader API
  access requires explicit method and path-prefix grants.
- Duplicate work is deduplicated by provider event identity. The same fact
  observed through two providers is associated through a Situation, not merged
  into one event.
- The app is one person, one machine, one process, with one writer per store.
  It binds to `127.0.0.1` and has no login. Tokens, model keys and connector
  credentials are encrypted at rest; the workspace database is not.
- Tests use synthetic providers and invented data. They do not establish
  real-account behavior, real-user value, provider reliability or a five-minute
  non-developer onboarding. Hosted CI for this merged candidate has not been
  executed, and Windows runtime acceptance remains pending.
- The local macOS app artifact is unsigned, unprovisioned, arm64-only and not
  notarized. The extension surface is not a stable SDK.
- The Notion broker is not deployed and has no registered publisher identity;
  provider and security review remain external gates.

## 0.4.0 — 2026-11-06

- Self-hosted browser workspace for macOS and Windows; no desktop installer required. Hosted CI covers Windows installation, persistence and browser startup.
- Source permissions, scoped platform actions, incremental synchronization and recovery improvements.
- Permission refresh keeps narrowing changes read-only; artifact retries retain the original actor and review token. Mailbox formatting, encoded path boundaries and Google Docs readback receive stricter validation.
- Memory exploration, MCP connection controls and task detail navigation.
- Automatic task grouping follows work when its previous section becomes empty, while preserving explicit user choices.
- Application bundles exclude local editor backups; privacy documentation describes actual credential storage and deletion limits.
- Sources continue using periodic reconciliation. Real-time provider notifications are deferred to a later version.

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
