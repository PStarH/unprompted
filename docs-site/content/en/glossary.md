---
title: Glossary
description: The words these pages use, and what each one means in the app.
---

## Source

A place the app is allowed to read. Local folders, Apple Notes, Google, GitHub, Outlook, Slack, and Notion are sources. Connecting one does not allow a write.

## Observation

A read of a connected source. Connecting checks once, then repeats on the interval saved in Connections. The default is 5 minutes. The choices are 1 minute, 5 minutes, 15 minutes, and 1 hour. You can pause it, or choose **Check now**. The process has to stay running. An empty read can be a real result. This is polling, not a webhook.

## Evidence

The source material a requirement is checked against. Missing or stale evidence keeps the work open. A model reply is not evidence by itself.

## Review token

The exact value attached to a prepared draft. Approval sends that token. If the draft or its input changed, the old token is refused and the task needs another review.

## Readback

The provider result read after a permitted write. Only that readback counts as a verified result. An uncertain result is reconciled before another try.

## Shadow mode

An explicit `UNPROMPTED_SHADOW_MODE=true` blocks external writes. The connector still needs its own grant.

## Primary interpretation

The mode after a model connection is saved, or when `UNPROMPTED_MODEL_ROLE=primary`. Rules may still recognize a request. The model is still called, and the original verifiable requirements stay in force.

## Assist mode

The older mode used when the model role is unset. The model adds interpretation only where the deterministic coverage is incomplete.

## Pi harness

The optional loop selected with `UNPROMPTED_AGENT_HARNESS=pi`. It uses Pi Agent Core 1.4.0, needs Node.js 22.19 or newer, and is capped at four model requests, eight tool attempts, and 60 seconds. The default harness is classic.

## Automatic follow-up

A lease you start so a prepared reply can be sent, or a prepared document patch applied, without another click. Shadow mode refuses it. It does not grant a connector write. See [Automatic follow-up](follow-up.md).

## Standing goal

A confirmed instruction to observe or prepare inside a scope. It stays local until you review it. It does not grant a connector write. Create and pause goals on the Memory page.

## Disconnect

Stops new reads from a source. The local copy stays until you choose **Disconnect and clear local copy**.

## Forget

Removes one chosen local record and reports cleanup that is still pending. It does not erase the provider's copy or a request already sent to a model.

## Work artifact

Something the app creates in a destination you granted separately: a Gmail draft, an Outlook draft, a Notion child page, or an Apple Note. Saving one does not send mail or complete the source task.

## MCP

An optional tool lookup under Connections. Tools and resources stay off until you allow a read. Writable and destructive tools stay blocked. It is not a source of tasks.

## Demo

`npm run demo`. A disposable simulation with invented data. It ignores saved accounts and is not the persistent workspace.
