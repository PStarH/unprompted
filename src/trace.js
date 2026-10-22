/**
 * Decision trace.
 *
 * Every important decision should be traceable to its input, the
 * evidence behind it, the reasoning that connected them, the policy that allowed
 * or refused it, and the result. The history log answers "what happened"; it does
 * not answer "why, on what evidence, and under which permission" in a form that
 * can be checked.
 *
 * A trace entry is one stage of one decision, and it is self-contained: it names
 * the event, the document version and the evidence signature it saw, the plan it
 * used, the policy decision it took, and what came of it. Stages share a task id,
 * so `explainDecision` can reconstruct the whole chain for a piece of work
 * without any module having to remember another module's internals.
 *
 * It is bounded on purpose. An unbounded audit log is a resource leak, and the
 * framework treats cost control as a cross-cutting concern, so the oldest entries
 * are dropped once the cap is reached.
 */

export const TRACE_STAGES = ['discovery', 'assessment', 'policy', 'execution'];

/** Cap on retained entries. Old entries are dropped, newest kept. */
export const MAX_TRACE_ENTRIES = 400;

let counter = 0;
const nextId = () => `t-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;

/**
 * Build one trace entry.
 *
 * `input` and `outcome` are always required: a stage that cannot say what it saw
 * and what it produced is not a trace, it is a log line. The remaining sections
 * are stage-specific and optional so a discovery entry is not forced to invent
 * evidence it never examined.
 */
export function traceEntry({
  stage,
  taskId = null,
  eventId = null,
  input = {},
  evidence = null,
  reasoning = null,
  policy = null,
  outcome = {},
  note = null,
  at = new Date().toISOString()
}) {
  if (!TRACE_STAGES.includes(stage)) throw new Error(`Unknown trace stage: ${stage}`);
  if (!input || typeof input !== 'object') throw new Error('A trace entry requires its input');
  if (!outcome || typeof outcome !== 'object') throw new Error('A trace entry requires its outcome');
  return { id: nextId(), at, stage, taskId, eventId, input, evidence, reasoning, policy, outcome, note };
}

/** Append an entry, keeping the trace bounded. */
export function appendTrace(trace, entry, max = MAX_TRACE_ENTRIES) {
  trace.push(entry);
  if (trace.length > max) trace.splice(0, trace.length - max);
  return entry;
}

/** The full chain for one piece of work, oldest stage first. */
export function explainDecision(trace, taskId) {
  return (trace || [])
    .filter(entry => entry.taskId === taskId)
    .slice()
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/**
 * A one-line account of the chain, for an interface or a report. Returns null
 * when a stage that should be present is missing, so an incomplete trace is
 * visible rather than described as if it were complete.
 */
export function summariseDecision(trace, taskId) {
  const chain = explainDecision(trace, taskId);
  // Unique, in the order the work first reached each stage. A task is normally
  // assessed more than once — once before its document exists, again after — and
  // that is a count, not a stage.
  const stages = [...new Set(chain.map(entry => entry.stage))];
  if (!stages.length) return { taskId, stages: [], complete: false, missing: [...TRACE_STAGES] };
  const missing = TRACE_STAGES.filter(stage => !stages.includes(stage));
  return {
    taskId,
    stages,
    complete: missing.length === 0,
    missing,
    entries: chain.length,
    lastAt: chain.at(-1)?.at || null
  };
}

export const traceApi = { TRACE_STAGES, MAX_TRACE_ENTRIES, traceEntry, appendTrace, explainDecision, summariseDecision };
