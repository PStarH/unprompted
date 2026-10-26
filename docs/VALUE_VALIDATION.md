# Share feedback that helps

[← Documentation](README.md)

We want real, unrequested discoveries that users find useful enough to keep
in their workflow. Begin real-account evaluation with consent and read-only
access. Record usefulness separately from technical success. See
[product direction](PRODUCT_DIRECTION.md).

The most useful feedback explains what Unprompted noticed, what it should have
noticed, and whether the next step actually helped you. A synthetic reproduction is useful for debugging; it is not evidence that a
real user benefited.

## Try a scenario

Start with [your real connected workspace](QUICKSTART.md), then ask:

- Could you see why the work was discovered?
- Did the document and requirements match the request?
- Was missing information or uncertainty clear?
- Was the prepared action useful and understandable?
- Did you know what would happen when you approved it?
- Did anything interrupt you unnecessarily?

You can mark a discovery in the interface and record a missed item. These
judgments remain in your local workspace; they are not uploaded automatically.

## Open a workflow report

Use the [workflow feedback template](https://github.com/PStarH/unprompted/issues/new/choose).
Describe the case using invented names and content:

```text
Situation: A person asks for a proposal with two required figures.
Trigger: The related document is updated with only one figure.
Expected: Keep the request open and identify the missing figure.
Observed: What the application actually did.
Useful next step: What would have reduced your follow-through.
Environment: Demo / read-only Google / optional model; Node and OS versions.
```

A case where the system should remain quiet is useful too. Say whether feedback
comes from a synthetic scenario or actual use. Do not turn demo numbers or
passing tests into claims about time saved or real-world accuracy.

## Keep personal data out of the report

Use fictional people, projects, titles and figures. Do not attach `.env`, state
files, raw email, document contents or links, OAuth tokens, API keys, screenshots
of a real inbox, or account identifiers. If the problem cannot be reproduced
without sensitive content, describe its structure and follow the
[private reporting policy](../SECURITY.md) when appropriate.

Optional account connections are explained in [Google Workspace](LIVE_INTEGRATION.md).
Read the [data-handling section](CONFIGURATION.md#what-stays-on-your-machine)
before trying one. You can disconnect at any time.

## Keep three kinds of evidence separate

| Evidence | What it supports | What it does not establish |
| --- | --- | --- |
| `npm run eval:value` | Scripted workflow outcomes and legacy activity proxies | Real participant usefulness, unrequestedness or willingness to keep the product |
| Explicit review of real findings | Discovery quality, useful/not useful judgments and recorded misses | Missing conditions in the success definition, overall recall or time savings |
| A complete participant case | A self-reported reason to keep the product because of a valuable, unrequested discovery | Independently authenticated interviews or measured longitudinal retention |

The `valuable` JSON key remains for compatibility. It means prepared or verified
activity, and the CLI labels it as a proxy. It must not be reported as the number
of genuinely valuable real discoveries.

## Offline participant-case bookkeeping

This is research bookkeeping, not another product capability. The tool does not
start the engine, connect an account, grant authority or execute work. It reads
a private JSON file and prints aggregate counts without participant IDs, case
IDs, quotes, private evidence references or source content.

```sh
npm run --silent study:value -- --template
npm run --silent study:value -- --input PRIVATE_STUDY.json
```

Save records outside the public file set, for example in the ignored `.internal/`
directory. The template starts empty and explicitly `synthetic`. Only label a
study `real_user` when its actual collection and participant records justify it.
Tests and demonstrations stay synthetic even if every fictional response says yes.

| Record | Required fields and meaning |
| --- | --- |
| Collection | `mode: "read_only_silent"`, ISO `startedAt` and `endedAt` within a one-week window, recorded `externalWrites: 0`, `participantNotifications: 0`, and private `evidenceRef` |
| Participant | Unique `id`, `source: "participant"`, explicit `confirmedRealUser: true`, `consentedAt` and private `consentRef` |
| Discovery case | Unique `id`, `participantId`, `discoveredAt`, `discoveryMode: "environment"`, nonempty `contextEventRefs` and `discoveryEvidenceRef` |
| Case review | `source: "participant"`, matching `participantId`, ISO `reviewedAt` after discovery, and private `evidenceRef` |
| Participant judgments | Explicit booleans `notExplicitlyRequested`, `useful`, `keepBecauseOfDiscovery` on the review; all must be true for a positive case |
| Reported miss | Unique `id`, known `participantId`, `source: "participant"`, `recordedAt`, `evidenceRef`; counted separately, not used to infer recall |

Multiple qualifying cases from one participant count that participant once.
Missing consent, missing references, agent-generated labels, a different reviewer,
future reviews, prompted work, and non-silent or write-enabled collection cannot
qualify. An unreviewed case stays unknown. The tool checks record completeness
and counting rules; people must still audit whether the referenced collection
and interview evidence is genuine.

A sent email is not required to prove a discovery helped: an early, useful
warning can meet the definition. Conversely, a verified send does not establish
the four required participant judgments.

## Narrow read-only connector check

`scripts/live-readonly-check.mjs` is an explicitly invoked operational check of
the existing connector. It reads a **copy** of recorded state and uses only read
credentials explicitly supplied to that process. It does not load `.env`, saved
account setup or model configuration. It forces shadow mode, disables send and
Docs writes, isolates setup, disables automatic observation, and checks the
runtime before requesting exactly one sync.

```sh
node scripts/live-readonly-check.mjs --state PRIVATE_STATE.json
```

Missing credentials cause a skip before process launch. The report contains
aggregate counts, no source text or provider diagnostics. Original file bytes
and metadata are compared after the child exits; a changed source or outbox
fails the check. A successful sync is an operational result, not a participant
case. This narrow check disables remote reasoning and does not measure optional
model discovery quality.

This implementation round tests the checker with local scripted services and
invented records. It does not conduct a real participant trial or the actual
actual product-comparison trial, and records no new validated real-user case.
