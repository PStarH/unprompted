# Share feedback that helps

[← Documentation](README.md)

The most useful feedback explains what Unprompted noticed, what it should have
noticed, and whether the next step actually helped you. Feedback on the local
demo is welcome; connecting a real account is not required.

## Try a scenario

Start with the [demo](QUICKSTART.md), then ask:

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
