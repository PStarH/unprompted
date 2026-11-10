# Unprompted 产品合同：完整推进、有界自主、选择性注意力、智能激活

Status: **accepted product contract** (2026-11-10). This is the top-level
acceptance contract for Unprompted. It does not replace locked
implementation specs. Where a locked spec is more precise, that spec wins
for the change it covers.

Locked implementation specs today:

- `docs/SEND_AUTHORITY_LOCKED.md` — send read-back, attestation, authority
  gate, ledger-only unverifiable writes.
- `docs/NEEDS_YOU_ACCURACY_LOCKED.md` — who may enter the Needs you zone.
  This contract does **not** widen or rewind that change.
- `docs/PRODUCT_CLAUSES_LOCKED.md` — implementation lock for Follow Through,
  Bounded Autonomy, Selective Attention, and Intelligent Activation.

This document records the four-question operating system the product owner
accepted, after review of Muse and Grok Bot public feedback and those
products’ published designs. The review samples were third-party summaries,
not a causal experiment; they identify recurring user problems, not
percentage targets.

## What “proactive” means

Do not read “proactive” as starting more tasks or sending more notices.
Read it as: **the agent keeps responsibility for an outcome and moves it as
far as evidence, authority, and risk allow, without the user having to
remind it to continue.**

Satisfaction is highest when the user manages the agent least, and the work
still finishes as a verified result.

## The four clauses

1. **Follow Through** — After work is found, stay responsible until it
   truly closes. An action or a draft is not completion.
2. **Bounded Autonomy** — Each turn, advance to the farthest point that
   current evidence, authority, and risk allow. Never enlarge permission
   because a model “thinks it should continue.”
3. **Selective Attention** — Interrupt the user only when they are
   irreplaceable. Human attention is scarce.
4. **Intelligent Activation** — Start or resume work only on a meaningful
   event, time, or context change, not on every incoming signal and not on
   unbounded polling.

These four must be decided by one WorkEngine lifecycle. Modules do not
each make a private policy.

## Roles (one lifecycle)

| Module | Decides | Must not |
| --- | --- | --- |
| Activation | Whether work is worth advancing, and when to wake | Grant authority or execute |
| WorkEngine | Which step to take now, and when to continue, wait, ask, or close | Breach Authority |
| Authority | How far execution may go | Be bypassed by Harness or the model |
| Evidence | Whether the information is reliable enough to continue | Be invented to force a close |
| Pacer | Whether and when to spend user attention | Hide an urgent safety or terminal-unknown block from the Field |
| Harness | How to actually do the work | Skip WorkEngine or mint its own permission |

The model must not independently decide admission, authority, closure, or
notification.

## 1. Follow Through — outcome, not task

A Situation has a stated goal and a **Closure Condition**. A step finishing
is only a reason to ask whether more work is still required.

Required behavior:

- After each action, decide continue / wait / ask / close.
- While waiting for an external reply, keep responsibility; do not close.
- A later event must be able to resume the same Situation.
- If the user already finished the work, recognize that and stop.
- If the agent cannot continue, say why; never mark the work complete.
- Only a satisfied Closure Condition may become **Verified Done**.
- The user must not be the reminder that the agent should continue.

Acceptance shape (vendor quotes, already used as the end-to-end scene):

1. Slack and mail show the user is waiting on vendor quotes; the agent
   finds that Situation.
2. It gathers quotes on hand, notices one missing, and waits without
   closing.
3. At the promised time, it checks sync, prepares a nudge, and does not
   send it.
4. If the user approves, it sends and read-back verifies (`SEND_AUTHORITY`).
5. The last quote arrives; comparison and a recommendation resume.
6. Needs you appears only when the user must choose the vendor (or another
   irreplaceable step in the locked Needs you predicate).
7. After the choice, authorized follow-through is completed and verified.

The user should not have to poke the next step, and should not receive a
string of progress notifications.

## 2. Bounded Autonomy — farthest safe step

Autonomy is a ceiling for the current evidence, grant, and risk, not a
fixed stop level.

| Level | The agent may | User needed? |
| --- | --- | --- |
| L0 Observe | Watch, link, record | No |
| L1 Investigate | Search, read, analyze, check | No |
| L2 Prepare | Drafts, plans, internal artifacts | No |
| L3 Execute | In-scope, already authorized, bounded operations | Per the grant |
| L4 Consequential Action | Send, publish, buy, delete, or other consequential external effects | Approve by default |

Three deterministic gates, in this order: **Evidence**, **Authority**,
**Risk** (reversibility and impact). A standing grant or YOLO lease may
move a *narrow* L4 action without a fresh click only when the already
locked authority rules allow it. Ask-first / `requiresReview` still beats
auto-allow. Attestation releases a failed send and never lets YOLO auto-send
the replacement (`SEND_AUTHORITY`).

Examples: tidy mail → finish; prepare a reply → draft; a named low-risk
class under an explicit grant → execute in that scope; an important
contract → prepare and wait for approval.

## 3. Selective Attention — the Field, not Grok’s three buckets

Unprompted already has four Field zones. This contract keeps them. Do not
collapse them into Grok Bot’s Needs attention / Unread activity / Working
trio.

| Zone | Meaning |
| --- | --- |
| **Needs you** | The next useful action is the user’s, and the agent cannot usefully continue without it |
| **In motion** | The agent is investigating, preparing, sending, or still verifying an in-flight attempt |
| **Waiting** | Progress depends on an external event, document, or persisted watch |
| **Watching · paused · done** | Observing-only work, pause, or a finished/closed Situation |

**Activity** (completed work, new evidence, a prepared artifact, a move
into Waiting) is a quiet record, not a fifth zone and not a reason to fold
Waiting or In motion away.

Membership of Needs you is exactly
`docs/NEEDS_YOU_ACCURACY_LOCKED.md`. This contract does not add rows, does
not put in-flight verify into Needs you, and does not put ledger-only
unverifiable writes into Needs you.

Notification / Pacer rules:

- Ordinary progress: no notification.
- Low-priority completion: Activity only.
- Important completion: may notify, subject to user preference.
- Waiting on an external reply: watch quietly.
- Approval or other locked must-enter Needs you: Needs you.
- Important block with a tight deadline: interrupt now.
- Low-confidence, low-value finds: no interrupt.
- The same problem recurring: merge; do not repeat.
- No new information on the same Situation: do not remind again.
- Low-priority notices may go to a digest.
- Prefer in-UI presentation when the user is already in that context;
  hold non-urgent cross-context items for a natural switch.
- A Needs you row must say what happened, why now, and what the user must
  do — not a bare “needs your attention.”
- Activation may batch or delay *notifications*; it must not hide a
  must-enter item from the Field (`NEEDS_YOU_ACCURACY`).

## 4. Intelligent Activation — event, time, context; not every signal

Do not rely on polling alone as the long-term design, and do not call a
model on every event. Today the product is still substantially
polling-based; event-driven wake is the direction. Do not claim push
delivery that does not exist.

Trigger classes:

- **Event** — new mail, a Slack reply, a file change: update evidence and
  decide whether to advance.
- **Time** — a promise comes due, a deadline nears: check whether to
  continue.
- **Dependency** — approval, a tool result, restored permission: resume
  waiting work.
- **Context** — the user opens a related project or document: prefetch and
  prepare; do not interrupt by default.

Pipeline: new event / timer / context → deterministic filter (dedupe,
`SELF_ECHO`, irrelevance) → Situation match → semantic evaluation only when
the state change or uncertainty warrants a model call → continue / wait /
ask / close.

Hard limits: a Situation has its own trigger budget and cooldown; failed
triggers back off; no infinite loops; no empty scheduled checks; several
events may be folded into one evaluation; user edits or cancels must stop
related work promptly.

## Metrics (net value, not just success rate)

Do not raise Autonomous Progress by sacrificing safety or accuracy.

1. **Verified Completion Rate** — share of Situations that reach Verified
   Done.
2. **Autonomous Progress Rate** — share that keep moving without the user
   having to remind the agent.
3. **False Interruption Rate** — share of Needs you that should not have
   been there (the Needs you accuracy bar).
4. **Missed Opportunity Rate** — valuable work found late or not at all.
5. **User Supervision Cost** — time spent checking, correcting, and
   re-briefing.
6. **Cost per Verified Outcome** — model and tool spend per verified
   result.

Target:

\[
\text{Net User Value} = \text{Verified Work Completed} - \text{User Supervision} - \text{Interruption} - \text{Rework}
\]

## What this contract does not authorize

- Changing the in-flight Needs you accuracy implementation or reopening
  its locked predicate.
- Claiming a new connector, push channel, calendar, or multi-user runtime
  that does not exist.
- Lowering send/authority locks, or treating unverifiable writes as
  verified completion.
- Merging any branch without an explicit ask.

Implementation of clauses other than the already-locked Needs you work
needs its own design-spec → review → implement pipeline when scheduled.
