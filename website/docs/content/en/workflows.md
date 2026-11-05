---
title: Workflows
description: How Unprompted moves from an observed change to evidence, a prepared action, approval, and a verified outcome.
---

## The pipeline

A meaningful change in authorized context is the trigger, not a new prompt:

```text
authorized change → commitment discovered → evidence checked
                  → next step prepared → you decide
                  → external action (if permitted) → readback
```

The model interprets and prepares. Deterministic code owns source identity, permission checks, review tokens, dispatch, and verification. A model response cannot approve an action or mark a task done.

## Example: an email request

1. An email asks for a project update by Friday.
2. The connector records the message. The model identifies the request, the deadline, and the missing evidence.
3. The agent looks for a current project document, recent results, and prior replies in the sources you authorized.
4. The task appears in **Needs you** only when there is something to decide. The detail shows the proposed reply, its destination, the requirement checklist, and evidence excerpts.
5. Approving the review token dispatches the prepared reply, if sending is authorized. Otherwise the task stays prepared and unsent.
6. After dispatch, the app reads the accepted message back. Only a confirmed readback becomes **verified**. An accepted-but-unconfirmed result remains visible and blocked from retry.

A newer source result can withdraw a prepared draft automatically. Missing or stale evidence keeps work open rather than producing a confident-sounding answer.

## Example: a GitHub review request

GitHub supplies assigned issues, review requests, recent commits, and Actions runs. The agent can correlate a review request with the issue, the changed files' metadata, and a failing check. It prepares a summary or a review response for you to inspect. The connector remains read-only: no comment, review, merge, or workflow rerun.

## Example: a version-checked document change

For a source-backed document, the agent prepares a patch against the version it read. Approval is bound to that source, payload, version, and destination. If the document changes before dispatch, the task returns `REVIEW_CHANGED` and must be reviewed again. After a permitted write, the app reads the document back before reporting success.

## Standing goals and waits

A standing goal lets the agent keep preparing work in a defined scope. It can observe and prepare; it does not gain a general external write permission. Persisted waits are used when progress depends on a person, a source, or an external result. A wait survives restarts and can unblock several tasks at once.

Corrections are recorded rather than hidden. If a later message replaces an earlier commitment, the trusted revision wins. If the work is withdrawn, the prepared action is withdrawn too.

## When the agent asks

External actions need one of:

- **Individual approval** — the default.
- **Task YOLO** — automatic approval for one task until it completes, is cancelled, declined, or becomes unavailable.
- **Time YOLO** — automatic approval for the whole workspace for 1–1440 minutes, including newly discovered tasks.

YOLO is stored user authorization. A model response or tool argument cannot create it. Paused tasks and tasks whose guidance changed still stop for review. Shadow mode refuses YOLO writes. Revoking stops operations not yet dispatched; it cannot undo a result a provider already accepted.

## What success means

| State | Meaning |
| --- | --- |
| Prepared | The next step and requirements are ready for review. Nothing external has happened. |
| Awaiting approval | The action is valid but needs a person or a standing grant. |
| In motion | The action was dispatched and is being processed. |
| Accepted, unconfirmed | The provider accepted something, but the result has not been read back. Retry is blocked. |
| Verified | Readback confirmed the outcome. |
| Failed | The action failed. The task remains visible with the error. |
| Waiting | Progress depends on a person, source, or external result. |
| Done | All requirements are satisfied and no follow-up remains. |

An empty result is a valid outcome. A source closure stops tracking; it does not create a verified completion.

## Related reading

- [Permissions & privacy](permissions.md) — read, write, approval, and YOLO boundaries.
- [Workspace](workspace.md) — where prepared work and evidence appear.
- [Architecture](architecture.md) — the execution and verification layers.
- [Local API](api.md) — script the review and approval flow.
