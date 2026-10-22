# Google Workspace: read-only setup

[← Documentation](README.md)

Try the [local demo](QUICKSTART.md) first. Connecting an account is optional and
requires your own Google Cloud project. The connector is an early integration;
start with a dedicated test account and synthetic email and documents.

## 1. Prepare your Google project

1. Create or select a Google Cloud project.
2. Enable the **Gmail API** and **Google Drive API**.
3. Configure the OAuth consent screen. For an external application in testing,
   add your test account to its test users.
4. Create an OAuth client with application type **Desktop app** and download
   its JSON file. Keep it outside the source repository.

Google's [Gmail setup guide](https://developers.google.com/workspace/gmail/api/quickstart/nodejs)
and [desktop OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app)
cover the current console steps. This project provides its own bootstrap script;
you do not need to install the Google client libraries from Google's sample.

## 2. Authorize locally

From the project root, run the helper with the path to your downloaded client
file. Substitute its actual path:

```sh
node scripts/google-refresh-token.mjs /path/to/client_secret.json --write-env
```

The helper uses a localhost callback and opens a consent page. If no browser
opens, use the authorization URL printed in the terminal. `--write-env` writes
the returned credentials into your local `.env` without printing their values.
It preserves other entries in that file.

The default requested scopes are read-only:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive.readonly
```

A Web application OAuth client will not work with this helper. Use a Desktop
client. Avoid `--send` for this first setup.

## 3. Configure read-only operation

Add these entries to `.env`, keeping the generated credential values:

```dotenv
GOOGLE_READ_GMAIL=true
GOOGLE_READ_DRIVE=true
GOOGLE_SEND_ENABLED=false
UNPROMPTED_SHADOW_MODE=true
UNPROMPTED_SYNC_INTERVAL_MS=60000
UNPROMPTED_STATE_FILE=./data/google-readonly.json
```

Keep model configuration unset to avoid sending request content to an external
model. Use Node.js 22+ and load the file explicitly:

```sh
node --env-file=.env server.js
```

Open http://127.0.0.1:4173/. The interface must report a live, read-only
workspace. Inspect http://127.0.0.1:4173/api/health and
http://127.0.0.1:4173/api/runtime: expect `mode: "live"`, `shadow: true`, and
`google.sendEnabled: false`. Live mode does not start the simulated scenario.

A positive sync interval polls automatically. With the default interval `0`,
request a sync through the [local API](API.md#sync-connectors). Read-only mode
still writes observed content to your local state file; it does not modify
Google content or send mail.

## 4. Try a synthetic request

In the dedicated account, create a document naming a project and its
requirements. Send that account an email from another person/test account
requesting the deliverable. Use the [built-in scenario](QUICKSTART.md#what-you-will-see)
as an example of wording and evidence.

Check whether discovery, correlation, missing evidence and the prepared reply
match the sources. The run registry is simulated in the built-in demo; a Google
Docs timestamp alone does not establish that experiment results are the latest.
An unsupported freshness claim should remain withheld.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Still in simulation | All three credential settings must be present, and `.env` must be explicitly loaded. Inspect `pendingConfiguration` in `/api/runtime`. |
| Consent denied | Check the enabled APIs, consent configuration, test-user access and Desktop client type. |
| Refresh fails | The token may be expired or revoked. Authorize again; Google consent/testing rules can limit token lifetime. |
| No new events | Check the polling interval, Gmail query, document access and connector status. Incremental sync only processes its current window. |
| Send is refused | This is expected in read-only mode. Use the built-in demo for simulated sending. |
| State is locked | Stop the other process or choose a separate state file. |

## Live send testing for contributors

The live send path is implemented and covered by scripted tests. It is not
presented as a production-validated integration. To test it, use a dedicated
account and a recipient you control. It requires all of:

- a token granted `gmail.send` in addition to the read scopes;
- `GOOGLE_SEND_ENABLED=true`;
- `UNPROMPTED_SHADOW_MODE=false`;
- user approval, or a previously stated grant that explicitly covers the action.

The helper's `--send --write-env` flags request the additional scope. The
application must read the accepted message back before reporting
`verified_live`. An `accepted_live` or uncertain action must remain blocked
until reconciliation; never retry blindly. Confirm one message in the controlled
recipient account and test restart/reconciliation with scripted transports
before conducting a live test.

## Disconnect

Stop the process. Revoke the application in your Google account's connected-app
settings. Remove local credentials and state you no longer need, including any
backups or logs containing account content. Never submit those files as feedback.
