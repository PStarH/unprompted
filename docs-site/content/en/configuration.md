---
title: Configuration
description: Run modes, where settings are stored, and the environment variables that change behavior.
---

People using the app set the model and sources in the interface. Environment variables are for operators and local development.

## Modes

| Command | Workspace | Credentials | Writes |
| --- | --- | --- | --- |
| `npm run demo` | Temporary simulation | Saved model and Google setup are ignored | Simulated local outbox only |
| `npm start` | Persistent local workspace | In-app setup, or variables you exported | Read-only until a write is explicitly enabled |
| `node --env-file=.env server.js` | Persistent, or `UNPROMPTED_STATE_FILE` | The `.env` file you name | Read-only unless you enable writes |

`npm start` does not read `.env`. Copy `.env.example` only for the settings you need. The file is gitignored.

## Where files live

Setup is `setup.json` in the platform config directory. On macOS that is `~/Library/Application Support/Unprompted`. Linux uses `${XDG_CONFIG_HOME:-~/.config}/unprompted`. Windows uses `%APPDATA%\Unprompted`. The directory mode is `0700` and the file mode is `0600` where the system supports it.

`UNPROMPTED_CONFIG_DIR` and `UNPROMPTED_SETUP_FILE` override those paths for development. MCP credentials are in `mcp.json` beside the setup file. Tokens, model keys, and connector credentials in those files are encrypted at rest. On macOS the key is in the login keychain. A normal state path ending in `*-state.json` is stored as SQLite and is not encrypted. Do not edit the database while the process is running. The repository's [configuration guide](https://github.com/PStarH/unprompted/blob/main/docs/CONFIGURATION.md#secrets-at-rest) describes migration and the threat model.

## Settings that matter

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `4173` | Listen port. The host stays `127.0.0.1` |
| `UNPROMPTED_SHADOW_MODE` | determined by local setup | Explicit `true` forces read-only mode; writes still require a grant |
| `UNPROMPTED_STATE_FILE` | Platform directory | Workspace location |
| `UNPROMPTED_MODEL_BASE_URL` | unset | OpenAI-compatible endpoint |
| `UNPROMPTED_MODEL_NAME` | unset | Model ID |
| `UNPROMPTED_MODEL_API_KEY` | unset | Optional key |
| `UNPROMPTED_AGENT_HARNESS` | classic | Set to `pi` for the optional Pi loop |
| `GOOGLE_SEND_ENABLED` | `false` | Opt in to the live send path |
| `GOOGLE_DOCS_WRITE_ENABLED` | `false` | Opt in to Docs edits |
| `GOOGLE_DRAFTS_ENABLED` | `false` | Opt in to Gmail drafts |

The full tables, including HTTP limits, are in the repository's [configuration guide](https://github.com/PStarH/unprompted/blob/main/docs/CONFIGURATION.md).

## Ship the connectors

A distribution registers each OAuth application once. People using the app then authorize their own accounts. They do not paste access tokens. The build carries client metadata only. [Connectors](connectors.md) describes that finished path.

| App | What the build includes | What the user does |
| --- | --- | --- |
| GitHub | A public client ID, device flow, and read access to Issues, pull requests, contents, Actions, and Metadata. Do not request the `repo` scope | **Get authorization code** |
| Outlook | A public client ID and browser authorization with PKCE; register `http://localhost/oauth/microsoft` as a mobile and desktop redirect. Delegated `openid`, `profile`, `offline_access`, `User.Read`, and `Mail.Read`. Drafts later add `Mail.ReadWrite` | **Connect**, then sign in and consent |
| Slack | A client ID and secret, with PKCE. Redirect `http://localhost:53682/oauth/slack`. User scopes `im:read`, `im:history`, `mpim:read`, `mpim:history`, and `users:read`. No bot or write scope | **Connect** |
| Notion | A client ID and secret. Redirect `http://localhost:53682/oauth/notion`. Read content, read user information, and **Insert content** when users will create pages | **Connect** |
| Google | A Desktop client file, with no user refresh token | **Connect Google** |

GitHub, Outlook, Slack, and Notion can live in gitignored `connector-clients.json`, or in the file named by `UNPROMPTED_CONNECTOR_CLIENTS_FILE`. The environment names are `UNPROMPTED_GITHUB_CLIENT_ID`, `UNPROMPTED_MICROSOFT_CLIENT_ID`, `UNPROMPTED_SLACK_CLIENT_ID`, `UNPROMPTED_SLACK_CLIENT_SECRET`, `UNPROMPTED_NOTION_CLIENT_ID`, and `UNPROMPTED_NOTION_CLIENT_SECRET`. A browser-login pair is used only when both values are present.

Google uses `google-oauth-client.json`, `--google-client`, or `UNPROMPTED_GOOGLE_DESKTOP_CLIENT_ID` and `UNPROMPTED_GOOGLE_DESKTOP_CLIENT_SECRET`. The macOS app builder accepts `--connector-clients` and `--google-client`, keeps that metadata, and drops account tokens. While a Google app is in Testing, refresh tokens last about seven days, and only listed test users can connect.

Slack and Notion exchange the code on the user's machine, so those secrets travel with the build. They are not held on a confidential server. Registration steps are in the repository's [connector guide](https://github.com/PStarH/unprompted/blob/main/docs/CONNECTORS.md).

## Stop and reset

Ctrl+C stops the process. Stop it before you move the state file. One process may write a state file. The demo can be run again for a fresh simulation. A control that resets the demo is refused when the workspace holds real events.
