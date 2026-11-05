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

- Navigation has four destinations in the rail: Work, Memory, Connections and
  Settings, with Settings pinned to the bottom.
- **Space**, the default, uses a narrow rail with visible navigation labels.
- Work follows the Field reference. The head is one number (all tasks) and
  one sentence saying what the agent is doing, with the single next action
  when there is one. Four zones always stay in place, even when empty: Needs
  you, In motion, Waiting, and Watching · paused · done. A task is a quiet
  line with a status mark, its title and what is happening now. Zones that
  mix states also name the state in text. On phones the zones stack and an
  empty zone is one line.
- Below the zones, a background panel shows what the agent is doing, from
  recorded state only: the sources it watches (with item counts and last
  observation), its four most recent actions, and how many memories it keeps.
  With no sources it says so and links to Connections.
- Form controls (selects, inputs, checkboxes, switches, segmented filters)
  share one style defined in `public/workbench.css`; nothing uses the browser
  default.
- Selecting a task opens a dedicated task page without a persistent task
  index or dashboard content. The page uses a readable, centered width on
  wide screens and the full width on phones. The left
  column holds any non-final outcome first (result not confirmed, failed,
  source disconnected, state unknown), then the decision, then steering. On
  non-approval tasks, steering is a secondary disclosure unless it holds a
  draft or error. Outstanding requirements remain visible; satisfied evidence
  can be expanded on demand. Approval review keeps its full context visible.
  Sources stay compact and open in the bounded source
  dialog rather than stretching the page. Closing the page preserves the draft
  and returns focus to the row. Unsent directions trigger the browser's leave
  warning without persisting their text. No task is selected automatically.
- Shared waits (one answer that unblocks several tasks) appear as one band
  above the zones, because they are real decisions.
- All five representations are chosen in Settings, with Field as the default.
  New tasks, updates and page reloads never open task details automatically.
- The Activity page interleaves real source changes and agent follow-through
  in date groups. Each event is a quiet timeline row with its category and
  time; supporting details and task links expand in place. Routine,
  intervention, failure and verified states retain distinct labels and marks.
  Legacy `#attention`
  links open a filtered Work view, and legacy `#activity` links open the
  record.
- Memory Explorer starts with search and five recent memories. Search results
  show an excerpt, the matching field/terms, and the originating context/date.
  Selection opens a shared Inspector without opening a graph. Optional local
  exploration has an explicit center: selecting a node changes only the Inspector;
  Explore from here changes the center and records a return path. Edges explain
  their recorded evidence. Project/person references and source tasks have distinct
  labels and shapes. Scope buckets never create memory-to-memory connections.
- Connections follows the Access Map reference. Each source row states its
  access in words (read on, modify on or off, needs attention, or connect).
  The counts double as filters. The page does not list observed context. In
  demo mode it lists the simulated sources with item counts and the latest
  observation.
- `J` and `K` move between tasks that need the user, in on-screen order. On an
  open task page, the left and right arrow keys move between all cards in the
  same order as the workspace. They do nothing while typing, and live updates
  never change the open task.
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

- Keep task navigation available while inspecting and steering work. Preserve
  drafts, selection, focus and composition across live updates.
- Memory is maintained by the Agent; retrieval is search-led, while exploration and correction are optional.
  Explicit relationships retain provenance. Shared scope/source connections are
  deterministic projections and never widen retrieval applicability. Generic
  global scope does not connect unrelated memories. The Inspector separates
  origins, actual task-run usage, version history and technical metadata.
  Disable, archive and recoverable delete remain distinct from permanent Forget.
  On phones, the Inspector is a scrollable bottom sheet above navigation.
  Advanced filters, rules and experience controls use progressive disclosure.
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
