# Workspace interface

Unprompted uses a quiet workspace. The task, its current state, and the next
available action take priority over explanatory copy. Field is the default
representation; List, Lanes, Focus and Changes are explicit alternatives over
the same task data. Suggestions never change
the user's view or interrupt an edit.

## Color and hierarchy

The core palette is `#E7E8E4` (canvas), `#B1B2AE` (neutral), `#D3DFF2`
(selected surface), `#93A4C1` (secondary accent) and `#18202B` (ink and
navigation). `public/appearance-model.js` derives shared light and dark tokens;
`public/redesign.css` owns the interface styling. The legacy workspace sheet is
no longer loaded, so competing versions of the same layout do not accumulate.
Derived shades provide readable text and surface contrast. Amber and red are
reserved for decisions and errors. Status must also be written in text.

## User-controlled appearance

- **Space**, the default, uses a narrow rail with visible navigation labels and four Field groups of
  task cards. No task is selected automatically. Selecting a card opens its
  context panel; closing it preserves the draft and returns focus to the card.
- All five representations are chosen in Settings, with Field as the default.
  The workspace shows only the current view name. New tasks, updates and page
  reloads never open task details automatically.
- Home is the single entry for reviewing tasks and following progress. The
  separate Needs you navigation entry is removed; legacy attention links open
  a filtered Home without selecting a task. Status filtering uses one select
  instead of five repeated tabs. Suggestions remain collapsed on Home until
  explicitly opened, with their existing decision actions intact.
- **Classic** uses labeled navigation. **Compact** reduces spacing and corner radii while retaining
  readable content. All three keep the same records, actions and navigation.
- Mist is the supplied five-color default. Sage, Sand and Graphite are optional
  presets. Custom colors accept five HEX values or native color pickers.
  Invalid values stay in an inline error; they are never applied as CSS.
- Mode, style and palette are independent. Preferences persist in the current
  browser, with an explicit restore-defaults action. There is no account or
  cross-device appearance synchronization.
- Contrast is calculated from the chosen colors. Text, action labels and
  selected surfaces adapt to retain at least 4.5:1 contrast. User choices are
  stored as entered; accessible shades are derived for the rendered interface.

## Context and data

- Keep the task list available while inspecting and steering work. Preserve
  drafts, selection, focus and composition across live updates.
- Memory Space shows every saved scope as a card, with its count, a short
  content preview and explicitly saved deliverables. No scope is selected
  automatically. Selecting a scope opens its contextual inspector. Library
  records remain collapsed until opened; search and scope filters keep large
  collections manageable. Facts, rules and execution experiences retain their
  existing management sections.
- Connections group actual sources by state and show access, account, latest
  observation and available actions in place. Read and write permissions must
  remain distinct; neither a source connection nor a prototype implies write
  access.
- Use real counts and records. Clearly label simulated work and verified versus
  unverified outcomes. Explain permission and destructive consequences where a
  user makes that decision.
- Keep loading, empty, offline and error states calm but actionable. Respect
  reduced motion and do not use continuous attention animations.

The browser contracts in `test/browser/workspace-modes.mjs`,
`test/browser/connected-sources.mjs`, `test/browser/redesign-shell.mjs` and
`test/browser/appearance.mjs` cover responsive layouts, navigation, context,
selection, input stability, saved custom colors and connection management.
Run `npm run test:appearance` for the contrast and appearance contracts.
Browser fixtures use simulated providers and do not verify a real account.

## Memory preview

Run `npm run demo -- --memories 100` to start a disposable workspace with 100
distinct sample memories across ten scopes. Records are clearly labeled as
preview data and have no fabricated source-task links. They use the actual
memory store, so search, edit, delete and restore exercise real local behavior.
The seed is restricted to disposable demo mode; normal startup never adds
sample memories. `npm run test:overview` covers the collapsed-first behavior
and this 100-record preview.
