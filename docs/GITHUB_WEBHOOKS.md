# GitHub webhooks

Polling is the default way GitHub data enters the workspace, and it keeps
working on its own. A repository webhook is an optional prompt: GitHub tells
the local receiver that something changed, and the existing GitHub connector
still performs the authorized incremental pull. The webhook never carries
issue text, code or any other provider content into the workspace.

The receiver is disabled by default. Enabling it is a manual, local decision.
There is no subscription registration, tunnel or hosted relay in this project.

## Requirements

- A GitHub repository you administer, so you can add a webhook.
- An HTTPS endpoint that reaches this local server. A reverse proxy you control
  may terminate TLS, but it must forward the request body and headers
  unchanged, and only the `/api/webhooks/github` path. The receiver verifies
  the signature over the exact bytes it receives.
- The GitHub account must already be connected through the normal connector
  flow. The webhook does not grant access and cannot connect an account.

## Configuration

Set these before starting the server:

| Variable | Meaning |
| --- | --- |
| `UNPROMPTED_GITHUB_WEBHOOK_ENABLED` | Exactly `true` enables the receiver. Any other value leaves it off. |
| `UNPROMPTED_GITHUB_WEBHOOK_SECRET` | The same secret entered in the GitHub webhook form. 16–1024 characters. |
| `UNPROMPTED_GITHUB_WEBHOOK_REPOS` | Comma-separated `owner/repo` allowlist, at most 100 entries. |
| `UNPROMPTED_GITHUB_WEBHOOK_ACCOUNT_ID` | The numeric GitHub account id that owns the connected account. |

Then, in the repository settings, add a webhook:

- Payload URL: `https://<your-receiver>/api/webhooks/github`
- Content type: `application/json`
- Secret: the value of `UNPROMPTED_GITHUB_WEBHOOK_SECRET`
- SSL verification: enabled
- Events: issues, pull requests, pull request reviews, pushes and workflow runs

GitHub sends a `ping` when the hook is created. The receiver answers it
without contacting GitHub, so a `200` confirms the route, signature and
repository allowlist are configured. A `403` means the repository is not in
`UNPROMPTED_GITHUB_WEBHOOK_REPOS`.

## What the receiver does

1. Reads the bounded raw request body (256 KiB, 10 second total budget,
   5 second idle budget).
2. Verifies `X-Hub-Signature-256` with HMAC-SHA256 and a constant-time
   comparison over those exact bytes, before any JSON parsing.
3. Rejects duplicate, malformed or ambiguous transport headers and non-JSON
   bodies. An event or action outside the allowlist is accepted with `202`,
   `accepted: false` and `state: ignored`; it never triggers a provider pull.
4. Checks the current account, repository allowlist, revocation state,
   monitoring pause and connector availability. Every failed check rejects the
   delivery without a provider pull or model call.
5. Commits one SQLite receipt and, when needed, one durable job atomically,
   then acknowledges. A delivery cannot be acknowledged unless both are stored.

The delivery id header is not covered by the signature, so it is treated as an
untrusted hint. Receipts are deduplicated twice: by account plus delivery id,
and by account plus the SHA-256 digest of the raw body. Replaying a valid body
under a new delivery id returns the existing receipt and creates no new job. A
reused delivery id with a different body is a conflict. The body itself, the
secret and provider content are never persisted.

Pending receipts are capped at 128; when the backlog is full the receiver
returns `503` and does not acknowledge, so GitHub retries. Completed receipts
are retained for up to 7 days and at most 10,000 rows, then pruned in bounded
batches. Pending work is never deleted to make room.

A worker re-checks the account binding, revocation, monitoring state and
connector availability immediately before pulling. Pausing observation leaves
queued receipts in place until observation is explicitly resumed. Changing or
revoking the GitHub account expires retained receipts instead of driving the
new account. A partial, rate-limited or failed pull never completes the
delivery; it is retried with backoff and the connector cursor still moves only
after ingestion.

The status is reported under `webhooks` in `GET /api/runtime`: configured,
available, paused, account binding, pending and retained counts, last received
time, last successful pull time and a coarse error code. Connector health is
reported separately by the existing sync status. Neither exposes the secret,
repository names or raw provider errors.

## Limits

- Only GitHub repository webhooks are supported. GitHub App installation
  events are refused.
- Only the listed repository events trigger a pull. Other events are accepted
  and ignored with `202` and no receipt.
- The webhook is a latency optimization, not a guaranteed delivery mechanism.
  Polling remains enabled and continues to close any gap.
- The local tests use synthetic signed requests and a fake provider. They show
  the receiver, persistence and pull chain work, not that a particular network
  reaches GitHub or delivers an event in under five minutes. That depends on
  your proxy, DNS, TLS and GitHub's own delivery schedule.
- The receiver never registers a webhook, opens a tunnel or writes to GitHub.
