'use strict';

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');

const LIMITS = Object.freeze({ title: 120, summary: 1200, steps: 20, step: 300, notes: 4000, verification: 1200 });
const DECISIONS = new Set(['approved', 'approved_auto', 'rejected']);
const ELLIPSIS = '…';

// Size limits protect the context budget and the renderer, and truncation
// satisfies both — so an over-long field is CLAMPED, never rejected. A plan
// that is merely verbose must still reach the user; discarding it strands the
// turn (the model's proposal vanishes after the user has already approved it).
// `null` is reserved for structurally invalid input — wrong type, or a required
// field that is absent/empty — which is the only case worth failing.
function boundedString(value, limit, { required = false } = {}) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (required && !normalized) return null;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - ELLIPSIS.length)).trimEnd()}${ELLIPSIS}`;
}

function normalizePlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const title = boundedString(input.title, LIMITS.title, { required: true });
  const summary = boundedString(input.summary, LIMITS.summary);
  const notes = boundedString(input.notes, LIMITS.notes);
  const verification = boundedString(input.verification, LIMITS.verification);
  if (title == null || summary == null || notes == null || verification == null) return null;
  if (!Array.isArray(input.steps) || input.steps.length < 1) return null;
  // Over-count clamps like over-length does: keep the first LIMITS.steps.
  const steps = input.steps
    .slice(0, LIMITS.steps)
    .map((step) => boundedString(step, LIMITS.step, { required: true }));
  if (steps.some((step) => step == null)) return null;
  return { title, summary, steps, notes, verification };
}

function failure(content, errorCode = TOOL_ERROR_CODES.EXECUTION_FAILED) {
  return {
    content,
    summary: 'Plan mode transition failed',
    isError: true,
    errorCode,
    metadata: { result_kind: 'plan_mode_transition', plan_mode_cleared: false },
  };
}

module.exports = {
  name: 'exit_plan_mode',
  description: 'Submit the completed implementation plan for review and, when approved, leave Plan Mode and continue execution in the same turn.',
  category: 'builtin',
  readOnly: true,
  sideEffecting: false,
  planModeOnly: true,
  workspaceRequired: false,
  parameters: {},

  summarize(input) {
    return `Review plan: ${boundedString(input?.title, LIMITS.title) || 'Untitled plan'}`;
  },

  async execute(input, context = {}) {
    const originalPlan = normalizePlan(input);
    if (!originalPlan) return failure('The plan proposal is malformed or exceeds its size limits.');
    const editedSource = context.planEditedPlan;
    const editedPlan = editedSource && typeof editedSource === 'object' && !Array.isArray(editedSource)
      ? normalizePlan({ ...originalPlan, title: editedSource.title, steps: editedSource.steps })
      : null;
    const plan = editedPlan || originalPlan;
    const planEdited = Boolean(editedPlan);
    if (context.planMode !== true || context.readOnly !== true) {
      return failure('exit_plan_mode is only available while Plan Mode is active.', TOOL_ERROR_CODES.DISABLED);
    }
    const streamId = String(context.streamId || '').trim();
    const callId = String(context.callId || '').trim();
    const activeProposal = streamId && context.backendService?._planDocumentsByStream instanceof Map
      ? context.backendService._planDocumentsByStream.get(streamId)
      : null;
    if (activeProposal && String(activeProposal.callId || '') !== callId
      && ['pending', 'approved', 'approved_auto'].includes(String(activeProposal.state || ''))) {
      return failure('A plan proposal is already pending or approved for this turn.', TOOL_ERROR_CODES.DISABLED);
    }
    const decision = String(context.planDecision || '').trim();
    if (!DECISIONS.has(decision)) return failure('The plan proposal did not receive a valid decision.');
    const feedback = boundedString(context.planFeedback, 800) ?? '';
    if (decision === 'rejected') {
      return {
        content: feedback || '<no feedback given>',
        summary: 'Plan needs revision',
        isError: false,
        metadata: {
          result_kind: 'plan_mode_transition',
          plan_decision: decision,
          plan_feedback: feedback || '<no feedback given>',
          plan_mode_cleared: false,
          plan,
          ...(planEdited ? { plan_edited: true } : {}),
        },
      };
    }
    const sessionId = String(context.sessionId || '').trim();
    const service = context.backendService;
    if (!sessionId || !service || typeof service.setSessionPreferences !== 'function') {
      return failure('Plan Mode could not be cleared because session persistence is unavailable.');
    }
    try {
      const preferencePatch = decision === 'approved_auto'
        ? { plan_mode: false, run_mode: 'auto' }
        : { plan_mode: false };
      const updated = await service.setSessionPreferences(sessionId, preferencePatch);
      if (!updated) return failure('Plan Mode could not be cleared because the session write was refused.');
    } catch (_error) {
      return failure('Plan Mode could not be cleared because the session write failed.');
    }
    // The session write has already succeeded; a read-back miss must not fail
    // the exit (that would strand the store out of Plan while telling the model
    // the exit failed). Degrade to 'ask' — the renderer's own fallback direction.
    let restoredSession;
    try {
      restoredSession = await Promise.resolve(service.sessionStore?.getSession?.(sessionId));
    } catch (_error) {
      restoredSession = null;
    }
    const runModeRestored = ['ask', 'auto'].includes(restoredSession?.run_mode)
      ? restoredSession.run_mode
      : 'ask';
    return {
      content: decision === 'approved_auto'
        ? 'Plan approved. Continue building without ordinary approval prompts for the remainder of this run.'
        : 'Plan approved. Continue building now under the normal approval policy.',
      summary: 'Plan approved',
      isError: false,
      metadata: {
        result_kind: 'plan_mode_transition',
        plan_decision: decision,
        plan_feedback: feedback,
        plan_mode_cleared: true,
        run_mode_restored: runModeRestored,
        plan,
        ...(planEdited ? { plan_edited: true } : {}),
      },
    };
  },

  normalizePlan,
  LIMITS,
};
