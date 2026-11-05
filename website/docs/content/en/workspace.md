---
title: Workspace
description: Review work, inspect evidence, manage memory and connections, and change the view without losing context.
---

## Four destinations

The navigation rail has **Work**, **Memory**, **Connections**, and **Settings**. Settings stays at the bottom. The workspace is designed to stay quiet: new tasks and live updates do not open details, steal focus, or interrupt typing.

## Work

The head of the page is one total and one sentence describing what the agent is doing, with the single next action when one exists. Four zones stay in place even when empty:

- **Needs you** — a decision, missing evidence, a permission prompt, or a changed destination.
- **In motion** — authorized work that is being prepared or dispatched.
- **Waiting** — a persisted wait on a person, source, or external result.
- **Watching · paused · done** — sources being observed, paused work, and verified outcomes.

Each task is a quiet line with a status mark, its title, and what is happening now. Mixed-state zones also name the state in text. Below the zones, a background panel shows what the agent watches, its four most recent actions, and how many memories it keeps. With no sources it says so and links to Connections.

### Review a task

Selecting a task opens its detail in place below the zones. Nothing is selected automatically. The left column puts a non-final outcome first — result not confirmed, failed, source disconnected, state unknown — then the decision, then steering. The right column holds the requirement checklist with evidence excerpts, sources, and the task's own history.

![A task detail with the outcome, decision, and evidence checklist.](../../assets/ui-task.png)

Closing the detail preserves the draft and returns focus to the row. A shared wait — one answer that unblocks several tasks — appears as one band above the zones.

### Five views

Choose the representation in Settings. All five use the same task data:

| View | Use |
| --- | --- |
| **Field** | Default overview with the four zones and source summary. |
| **List** | Dense scan of every task. |
| **Lanes** | Task state side by side. |
| **Focus** | One decision at a time. |
| **Changes** | The record of what changed, including preparation and follow-through. |

On a task list, `J` and `K` move between tasks that need you, in on-screen order. They do nothing while typing. Live updates never change the open task.

## Memory

Memory stores what the agent learned about your work. The overview shows every scope with a count, a short preview, and explicitly saved deliverables. Opening a scope turns the scopes into a narrow index and gives the memories the main width.

Library groups records by scope and can sort by recent update or content. Facts, rules, and execution experiences keep their management sections. You can edit, delete, search, filter, and restore records. Relations between scopes are not drawn because the store keeps no explicit relation records.

What memory is not:

- It is not a transcript of every source event.
- It is not a provider copy. Deleting a record does not delete the source document or email.
- It cannot grant permissions or stand in for missing evidence.

The **Forget this context** action removes selected memory and task context behind an explicit confirmation. Review [Permissions & privacy](permissions.md) before storing sensitive details.

## Connections

Connections groups actual sources by state and states access in words: read on, modify on, off, needs attention, or connect. Each row shows the account, latest observation, item counts, and available actions. The counts also filter the view. Observed context is not listed here.

You can connect more than one source, pause observation, retry a failed read, and disconnect one account while keeping the others. A separate destination grant is required before a draft, new note, or document patch can be prepared for that destination.

MCP servers appear in a separate section. Tool grants are per tool, and resource-only servers require selecting each resource. See [Connectors](connectors.md#external-mcp-tools).

## Settings

Settings holds:

- Appearance: mode, style, palette, light or dark theme.
- Language: English or Chinese.
- Model: endpoint, model ID, key, harness, and connection status.
- Standing agreements: scoped authorization for future follow-ups.
- Temporary YOLO authorization, with a visible revoke action while active.
- The five work views and restore-defaults controls.

Appearance preferences persist in the current browser. There is no account or cross-device synchronization. Model and connector settings stay in local private files.

## Loading, empty, and error states

The workspace favors recorded state over explanatory copy. A loading or empty source stays calm but tells you what is happening and what you can do. Unknown or unconfirmed outcomes are labeled as such. Simulated demo records are clearly labeled and never appear in normal startup.

For the data model behind the interface, read [Architecture](architecture.md). For task outcomes and approvals, read [Workflows](workflows.md).
