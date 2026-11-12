---
title: Security
description: How to report a vulnerability, and the boundaries of this localhost prototype.
---

Unprompted is a pre-1.0 prototype. Fixes land on `main`. There is no separate supported release branch, no bounty, and no promised response time.

Everyday permissions are on [Permissions and privacy](permissions.md). This page is how to report a vulnerability, and what must stay out of a public issue.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/PStarH/unprompted/security/advisories/new). If that page is unavailable, contact [the maintainer](https://github.com/PStarH) through a private method listed on their profile.

Do not post exploit details, credentials, or private content in a public issue. If you cannot find a private channel, open a short issue that only asks for one, and leave the technical detail out.

Include the affected commit, the impact, synthetic steps to reproduce, and the mode or settings involved. Say whether live Google access, the send opt-in, or turning shadow mode off is part of it.

Do not include OAuth credentials, API keys, email, document links, or state files.

The repository policy is [SECURITY.md](https://github.com/PStarH/unprompted/blob/main/SECURITY.md).

## Boundaries

- The server binds to localhost and has no authentication. Do not expose it through a public host, reverse proxy, or tunnel.
- Normal mode is read-only until you grant a write. An explicit `UNPROMPTED_SHADOW_MODE=true` blocks external writes.
- `npm run demo` keeps its own state and only simulates sending.
- A model reply cannot approve an action, widen a permission, or stand in as evidence. A remote model can receive the task content from the sources you connected.
- Local state holds synchronized content and evidence. It is not encrypted.
- Local folders and Apple Notes stay inside the scopes you selected. Apple Notes needs macOS Automation permission. Revoking access invalidates that source evidence. It does not mark the work complete.

A mistake in these pages, or an ordinary product bug, can be a public issue. Use **Report a problem with this page** at the bottom. Keep secrets out of it.
