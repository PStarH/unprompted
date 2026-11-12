---
title: How work moves
description: From an authorized change to evidence, a prepared action, your decision, and a verified result.
---

A change in a source you authorized is the trigger. You do not write a prompt for each item.

```text
event → request → evidence → prepared action → your decision
      → external action, if permitted → readback
```

The model can interpret and draft. Deterministic checks own identity, permissions, review tokens, dispatch, and verification. A model reply cannot approve an action or mark a task done.

## What a pass looks like

1. A connector records a message, a file change, an issue, or a note.
2. The app looks for a request and for evidence in the sources you allowed.
3. Missing or stale evidence keeps the work open. It does not become a confident answer.
4. A prepared reply or patch appears under **To review**, with the evidence beside it.
5. Approval uses the current review token. A changed source returns a conflict and needs another review.
6. If the write is permitted, the app reads the provider result back. An uncertain result is not retried blindly.

A newer source result can withdraw a draft that has not been sent. Saying a task was handled does not invent a receipt.

## Standing goals

A standing goal can **observe** or **prepare** inside a scope you confirm. Preparation uses the model when one is connected, and otherwise prepares a source brief. Both stay local until you review them. A standing goal does not gain a general write permission, even if some other destination grant exists.

The Memory page creates and pauses goals. The workspace shows the prepared draft and the review.

## What completion means

A closed source item stops being tracked. That is not the agent finishing the work. A verified result requires a readback after a permitted action. `npm run demo` can exercise this loop with invented data. It is not your workspace.
