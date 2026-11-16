# Notion broker operator guide

The Notion broker is a standalone backend for a confidential Notion OAuth
publisher. It keeps the publisher client secret on the server and hands a
one-time authorization code back to a desktop application through a loopback
redirect that the desktop chose when it started the flow.

This repository contains the broker backend and its fake-provider tests. It is
not deployed, has no registered Notion publisher identity, and is not connected
to the native desktop client yet. Those remain operator and user decisions.

## What is public and what stays secret

Public values:

- protocol version `unprompted-notion-broker-v1`
- the Notion integration client ID
- the HTTPS public origin, for example `https://notion-broker.example.com`
- the registered redirect URI `<publicOrigin>/v1/notion/callback`
- the endpoint paths in the table below

Server-only values:

- the Notion client secret
- the 32-byte master key that encrypts and authenticates broker state
- the SQLite state file and its backups
- access tokens, refresh tokens, verifiers, OAuth state and handoff codes

The public descriptor returned by the service contains only the public values:

```json
{
  "protocolVersion": "unprompted-notion-broker-v1",
  "clientId": "your-notion-client-id",
  "issuer": "https://notion-broker.example.com",
  "redirectUri": "https://notion-broker.example.com/v1/notion/callback",
  "endpoints": {
    "meta": "/v1/notion/meta",
    "session": "/v1/notion/session",
    "authorize": "/v1/notion/authorize",
    "callback": "/v1/notion/callback",
    "redeem": "/v1/notion/redeem",
    "refresh": "/v1/notion/refresh",
    "revoke": "/v1/notion/revoke",
    "cancel": "/v1/notion/cancel"
  },
  "limits": {
    "sessionTtlMs": 300000,
    "handoffTtlMs": 60000,
    "refreshCacheTtlMs": 120000,
    "grantTtlMs": 7776000000,
    "maxSessions": 1024,
    "maxGrants": 4096,
    "providerConcurrency": 4,
    "providerRatePerSecond": 3
  }
}
```

## Notion application registration

Create a public Notion integration owned by the publisher account. Register
exactly one redirect URI:

```
<publicOrigin>/v1/notion/callback
```

The authorization request uses `owner=user`. Notion's documented publisher
flow exchanges the code with HTTP Basic client authentication, so the broker
does not claim or depend on Notion supporting PKCE. The desktop side performs a
separate S256 handoff to the broker; it is not a Notion code challenge.

Registration of the publisher identity, privacy and legal fields, the public
domain, HTTPS certificate and a real non-developer account remain held until
the operator completes them.

## Configuration

The CLI requires all five values below and refuses to listen when one is
missing. There are no default credentials.

| Variable | Meaning |
| --- | --- |
| `NOTION_BROKER_CLIENT_ID` | Registered Notion integration client ID |
| `NOTION_BROKER_CLIENT_SECRET` | Notion publisher client secret |
| `NOTION_BROKER_PUBLIC_ORIGIN` | HTTPS origin only, no path, query or fragment |
| `NOTION_BROKER_MASTER_KEY` | 32 random bytes, standard Base64 |
| `NOTION_BROKER_STATE_FILE` | SQLite state file inside a dedicated directory that is already mode 700 on POSIX |
| `NOTION_BROKER_HOST` | Optional, default `127.0.0.1`; loopback only |
| `NOTION_BROKER_PORT` | Optional, default `9043` |
| `NOTION_BROKER_GRANT_TTL_MS` | Optional broker transport capability lifetime, 1 hour to 365 days, default 90 days |

Generate the master key once with a cryptographically secure random source and
store it outside the state file, for example in the service manager's secret
environment. Losing the key makes existing grants unrecoverable; changing it
makes the broker refuse the old state file. There is no online re-keying: start
a new state file and ask users to connect again.

## Running

```sh
node broker/notion/server.mjs
```

The process listens on loopback and is expected to sit behind an operator
managed TLS reverse proxy. The proxy must forward the original request path and
body to the loopback listener, must not add authentication headers that the
broker would trust, and must enforce its own connection and request limits.
The broker ignores forwarded-client headers for rate limiting.

Run one process per state file. The broker takes a short-lived ownership lease
in the database. A second process pointed at the same file fails before it
listens. After a crash, wait at least 15 seconds for the lease to expire before
restarting; the new owner marks interrupted exchanges and pending refreshes as
unknown, and affected grants `reauthorization_required`, before it serves. Do
not share the state file across hosts.

An owner never revives its own expired lease. If renewal fails because the
process was paused, the clock jumped or the database was blocked, it marks the
lease lost and stops serving; restart or let another process take over. Recovery
runs on every successful acquisition, including when the previous owner closed
after its lease expired and therefore left no lease row. Pending work is never
redispatched by recovery.

## Lifecycle

1. The desktop creates a loopback redirect URI of the form
   `http://127.0.0.1:<port>/oauth/notion` and a 43-128 character S256 verifier.
2. `POST /v1/notion/session` binds the challenge, redirect URI and client state
   to a five-minute broker session and returns an authorize URL.
3. The browser opens `GET /v1/notion/authorize?session=...`. The broker sets a
   short-lived `__Host-` correlation cookie and redirects to Notion with its own
   random state.
4. Notion redirects to `GET /v1/notion/callback`. The broker checks the state
   hash and the browser cookie before exchanging the code with Notion. It
   stores an encrypted pending reply and redirects to the original loopback URI
   with a 60-second handoff code and the desktop's client state. The handoff
   expiry is capped at the parent session's remaining lifetime.
5. The desktop calls `POST /v1/notion/redeem` with the handoff code and its
   verifier. Only a valid S256 proof consumes the code and creates an active
   grant with an encrypted refresh capability.
6. `POST /v1/notion/refresh` refreshes with a capability, proof and refresh
   token. One upstream refresh is attempted per grant and old refresh token.
   Duplicate completed requests can receive a two-minute encrypted cached reply.
7. `POST /v1/notion/revoke` revokes only the matching local grant and purges its
   encrypted caches. It does not call Notion and does not revoke other grants.
8. `POST /v1/notion/cancel` requires the session ID and the original verifier.
   It cancels only that pending flow and aborts its in-flight provider request.

There is no public polling endpoint and no status endpoint that returns tokens.

## Expiry and reauthorization

- Session: 5 minutes.
- Handoff code: 60 seconds, one use, and never beyond its parent session.
- Refresh success cache: 2 minutes.
- Broker transport capability: configured 1 hour to 365 days, default 90 days.

A redeem checks both the handoff and its parent session inside the consume
transaction. A handoff row that still looks live is rejected as `expired` once
the session has expired, and no grant is created.

If a Notion exchange or refresh response omits `refresh_token`, the broker
returns an explicit `refreshToken: null` and stores no current refresh hash. It
does not reuse or resurrect the previous refresh token. A later request with
that old token fails without a provider call; after the two-minute cache it is
`invalid_grant`, while a different token is `reauthorization_required`. Once the
access token expires the user must connect the account again.

Capability expiry is not a remote Notion grant expiry. When it expires, the
desktop must reconnect the account. A refresh response with a different account
identity, an invalid provider response, an interrupted refresh or a known
failure after dispatch marks the grant `reauthorization_required`. The old
refresh token is never sent again, including after restart or cache expiry.
Revoking during an in-flight refresh prevents the late response from delivering
or storing tokens.

## Security properties

- The client secret is used only in the fixed Notion token request.
- The broker accepts no caller-chosen provider URL, client ID, secret or proxy
  headers.
- Provider requests use fixed endpoints, HTTP Basic on the server, redirect
  error handling, a bounded timeout (10 seconds by default), a 64 KiB response
  bound and no automatic retry. The timeout aborts the request; a transport that
  resolves after cancellation or the deadline is checked again and cannot
  publish a handoff or refresh reply. A timed-out refresh also marks the grant
  `reauthorization_required`.
- Session flow parameters are encrypted at rest. Only HMAC lookup values,
  statuses, timestamps and opaque IDs are stored in clear.
- Tokens, account metadata and cached replies use AES-256-GCM with random
  nonces and authenticated row kind, row ID, client ID and origin.
- The state file's parent must be a dedicated directory. On POSIX it must
  already be mode 700; the broker refuses an existing group- or
  world-accessible directory rather than chmodding a shared parent such as
  `/tmp`. A missing directory is created with mode 700. State files are set to
  mode 600. Symbolic links and non-regular state files are refused.
- The broker never chmods an existing parent directory, so operators must
  provision the dedicated state directory before first start.
- Browser cookies are `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` and use the
  `__Host-` prefix. API routes do not accept cookie authentication.
- No CORS headers are emitted. HTML responses use a fixed page and a
  `default-src 'none'` content security policy. Provider error text, query
  values and tokens are never reflected.

## Failure responses

Fixed JSON error codes for API routes: `invalid_request` (400), `invalid_grant`
(401), `in_progress` and `reauthorization_required` (409), `expired` (410),
`rate_limited` (429, with `Retry-After`), `provider_error` (502), `capacity`
(503). Browser routes render fixed HTML with the corresponding status.

## Tests

The suite has 21 serial tests on Node 22. It uses a fake Notion provider, a fake
clock and an internal temporary SQLite state file. It makes no real network,
account or Notion requests.

```sh
TMPDIR=/private/tmp/unprompted-tmp node --test --test-concurrency=1 test/notion-broker.test.js
```

## Held items

The following are not included and must not be represented as complete:
publisher identity and legal/privacy fields, public domain and HTTPS
certificate, real client ID and secret, reverse proxy deployment, monitoring,
real-account consent testing, remote Notion revocation, native desktop client
integration, uptime or provider push guarantees.
