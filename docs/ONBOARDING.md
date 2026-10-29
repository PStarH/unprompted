# Local app, connections and continuous observation

[← Documentation](README.md)

## Use a local macOS app

The source includes a builder for a local, unsigned app bundle:

```sh
npm ci --include=optional
npm run build:macos-app
npm run smoke:macos-app
```

The builder uses an official Node.js archive with its published SHA-256 and
checks that the runtime links only to macOS system libraries. The app includes
the web interface and installed optional Pi packages. Its user does not need a
separate Node.js or Git installation. The build defaults to `outputs/Unprompted.app`;
use `node scripts/build-macos-app.mjs --out OTHER_PATH` for another output.

The launcher chooses a free local port and opens only the service started by
that launch. The app opens persistent model and source setup; a local folder can
be used without connecting a cloud account. Normal startup does not schedule a
sample. A selected source activates without restarting; first access is
read-only.

The smoke command exercises the actual app launcher with isolated temporary
setup, no opened browser and no saved account. It checks the full first-view →
prepared reply → approved simulated delivery → verified receipt path.

This is a local review artifact. Distribution signing, notarization and a
download release require the application's signing identity and a release
process; a successful local launch does not establish those properties.

## Connect your model first

Open the app and fill in the API endpoint, model ID and API key. Compatible
local models can omit the key. **Verify and connect model** makes a real
structured request using invented content, then saves the working connection
privately and activates it without restarting. Failed checks never appear as
connected. With no model, the normal first run waits for setup.

Saved connections use primary interpretation. Requests recognized by rules
still invoke the model; original verifiable requirements stay in force. A
failed model reading cannot become a rule-only ready action. Choose a source on
the same page to supply your actual working context. See [Connectors](CONNECTORS.md)
for GitHub, Outlook, Slack and Notion authorization, permissions and extension points.

## Choose your first source

The home page offers local folders, Apple Notes on macOS, Google, GitHub,
Microsoft Outlook, Slack and Notion. One source is enough to start. GitHub and
Outlook use official device OAuth and a registered public Client ID. Slack and
Notion open the provider’s own consent page and return to
`http://localhost:53682/oauth/slack` or `http://localhost:53682/oauth/notion`.
The distribution or self-hosted operator supplies the registered application
identity. Users authorize their own accounts. The app verifies identity and
activates the connection. No access-token copying is required. See the
[connector guide](CONNECTORS.md) for exact scopes and publisher requirements.

Each connector keeps independent cursors and status. Observation can be paused
globally. Disconnecting a source retains the others and local historical records.
New integrations are read-only, and delivery is bound to the original source.

## Connect local sources

Choose **Local folders** to read Markdown and text files without OAuth or a
cloud account. On macOS, use the folder picker; on other platforms, enter the
folder path. Unprompted reads only the selected folders, skips hidden files and
symlinks, and never asks for Full Disk Access.

On macOS, **Apple Notes** asks for Automation permission for the host app (for
example, Terminal when launched with `npm start`). Then choose the Notes folders
to observe. Locked notes and attachments are not read. The connector is
read-only; its real-account and signed-app permission flow still need manual
acceptance. See [local-source behavior and limits](CONNECTORS.md#local-sources).

## Connect Google from the interface

The home page includes Google setup. If your distribution provides a registered
Desktop OAuth client, choose read sources and **Connect Google**. Otherwise,
the page provides three Google Cloud steps with direct links: enable Gmail and
Drive APIs, configure the OAuth audience/test users, then create a Desktop app
client and download JSON. Choose or drop the JSON and select **Import and connect
Google** to save and continue directly to Google consent.

The short-lived loopback callback uses PKCE and one-use state. OpenID email
identity is resolved from Google's authenticated userinfo endpoint, so the
application displays the actual selected account and selects its own hashed
workspace filename. Access and refresh tokens never enter the public API, SSE
or browser local storage. If a popup is blocked, use the inline authorization
link. Cancellation and expiration leave a retry path on the page.

After authorization, the connection applies immediately. The first pass reads
recent Gmail messages and up to 20 existing Google Docs. The account card reports
actual read counts, discovered work and last observation. A successful empty
check is not a fabricated task. Separate accounts do not share tasks, cursors,
standing grants or local view preferences.

The first scopes are read-only. In **Connections → Sending and document changes**,
choose extra capabilities when needed and authorize those Google scopes. The
same action also activates the selected capability without a restart; each
actual action still requires your approval or a matching stated authorization.
You can turn execution off while retaining observation. A Docs-only grant can
never produce a simulated email delivery in a real workspace.

A distribution can provision its registered client using
`UNPROMPTED_GOOGLE_DESKTOP_CLIENT_FILE` or the
`UNPROMPTED_GOOGLE_DESKTOP_CLIENT_ID` / `UNPROMPTED_GOOGLE_DESKTOP_CLIENT_SECRET`
pair. The local app builder accepts `--google-client /path/to/desktop.json` and
includes only the registered client metadata, never account tokens. Google
registration, audience settings and required verification are supplied by the
product owner; the application cannot create that status locally.

If the launch environment supplies `GOOGLE_REFRESH_TOKEN`, that environment
remains authoritative. The UI explains that account/scopes are managed there;
it can still stop this process from reading or writing when disconnected.

## Keep observation running

The connection form offers continuous observation, enabled by default. You can
pause it or change the interval in Connections. Enabling begins a pull
immediately; another pull is scheduled after the current one finishes. A slow
connector does not cause overlapping automatic runs. The switch and interval
survive a restart; the restarted app begins another immediate pull.

The interface distinguishes off, needs connection, starting, syncing, watching,
failed and expired observations. Last success and failure remain visible after
the switch is turned off. The local process must remain running to observe new
events. Reopening the app restores its configured observation policy and
rechecks existing work.

## Manage a piece of work

- Reminders in the same trusted commitment update its sources instead of
  creating another task. Changed requirements keep a revision history; a
  withdrawal invalidates work that has not been sent.
- Task details show the next action, known responsibility, dependencies,
  priority reasons and wake condition. Unknown responsibility is shown as such.
- Save a document, reply or time wait. Cosmetic document changes do not resolve
  a saved document wait; a changed delivery condition does. Significant risk can
  interrupt waiting.
- **Prepare a patch from evidence** searches related current sources for exact
  quoted content satisfying missing criteria. Review its source and base version
  before applying. Missing, conflicting or stale evidence blocks preparation.
- Applied patches are read back and the task is reassessed. A patch is separate
  from the final delivery result. Unknown writes are held for investigation;
  they are not blindly repeated after restart.
- Ownership, duplicate and association corrections affect matching future
  candidates within their stated scope. Undo removes that rule's future effect.
  Saying a task was handled does not fabricate a verified receipt.
- A shared dependency appears once with its affected work. Deadline, source
  conflict and uncertain execution decisions remain visible.

## Local data and model boundaries

Setup is kept in a private local file, and workspace records stay in local JSON
state. The demo uses isolated temporary setup/state and does not inherit saved
account credentials. Selected local-file and Notes content, like cloud-source
content, can be included in requests to the configured model. The
optional Pi runtime remains a bounded read-tool loop; document writing goes
through the versioned document service and its independent authorization.

See [configuration](CONFIGURATION.md), [API](API.md), [repair acceptance](TESTING.md)
and [test coverage](TESTING.md) for the exact implementation and validation scope.

## Prepare the distribution's Google connection

Register a Desktop OAuth client in the product's Google Cloud project, enable
Gmail and Drive APIs, and configure the intended audience. While the app is in
Testing, add the intended pilot accounts as test users. Complete the applicable
restricted-scope review before public use beyond the allowed testing or
exception scope. The registration and consent page must identify the actual
product and its data handling; model processing is part of that disclosure.

Pass the downloaded Desktop client JSON to `--google-client` when building the
app, or set `UNPROMPTED_GOOGLE_DESKTOP_CLIENT_FILE` when running the source.
Check a clean installation: the first page should offer **Connect Google**,
without asking the user to create another Cloud project. With a consenting
account, confirm its displayed identity, the first read counts, a real sourced
finding or an honest empty result, pause and reconnect. Add sending only for an
explicitly approved action and check the actual provider receipt.

The automated browser coverage uses scripted OAuth/provider responses. It
cannot substitute for registering the actual client or accepting a real Google
account and selected model. Google documents [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
and [refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).
