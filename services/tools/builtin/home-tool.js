'use strict';

/* services/tools/builtin/home-tool.js — the consolidated `home` tool.
 *
 * ONE model-facing tool covers every Home surface Jenny can touch: the
 * calendar, proactive reminders, and a read-only view of the scratchpad. The
 * consolidation is deliberate — six separate tool ids would burn six catalog
 * slots for one small, tightly-related surface, and the model consistently
 * picks better between `action` enum values than between near-identical tool
 * names.
 *
 * Registered at REGISTRY construction behind the default-on
 * `tools_home_enabled` flag (services/tools/index.js), so a flag-off build
 * (JENNY_ENABLE_TOOLS_HOME=0) never registers it at all.
 *
 * Contracts this tool holds:
 *  - It writes ONLY through context.homeAssistantService, never the calendar
 *    or shell-config services directly, so every write is attributed
 *    (sourceKind 'assistant') and lands in the one-click undo journal.
 *  - Deletes self-gate: without confirm:true they mutate nothing and return
 *    metadata.status 'confirmation_required' naming the exact target.
 *  - The scratchpad has no write path here. v1 is read-only by owner decision.
 *  - No workspace root is required (Home is not a workspace surface), which is
 *    why the manifest sets availability.workspace_required to an explicit
 *    false — services/tools/index.js defaults it to true. */

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeString } = require('../../shared/normalize');
const { HOME_ACTIONS, failure } = require('./home-tool-actions');
const { manifestSchema } = require('./tool-result');

const HOME_TOOL_ACTIONS = Object.freeze(Object.keys(HOME_ACTIONS));

const homeTool = {
  name: 'home',
  // The manifest owns the description and the schema (action enum, field caps).
  ...manifestSchema('home'),
  category: 'builtin',
  readOnly: false,
  workspaceRequired: false,

  summarize(input) {
    const action = typeof input?.action === 'string' ? input.action.trim() : '';
    return `Home: ${Object.hasOwn(HOME_ACTIONS, action) ? action : 'action'}`;
  },

  async execute(input, context) {
    const service = context?.homeAssistantService;
    if (!service || typeof service.listCalendar !== 'function') {
      return failure({
        reason: 'unavailable',
        errorCode: TOOL_ERROR_CODES.DISABLED,
        message: 'Home is unavailable in this session.',
        summary: 'Home unavailable',
      });
    }
    const action = normalizeString(input?.action);
    // Own keys only: a plain-object lookup would hand back Object.prototype
    // members such as 'constructor'.
    const handler = Object.hasOwn(HOME_ACTIONS, action) ? HOME_ACTIONS[action] : null;
    if (!handler) {
      return failure({
        reason: 'unsupported_action',
        message: `action must be one of: ${HOME_TOOL_ACTIONS.join(', ')}.`,
        summary: 'Unsupported Home action',
      });
    }
    const meta = {
      sessionId: normalizeString(context?.sessionId),
      callId: normalizeString(context?.callId),
    };
    try {
      return handler(service, input || {}, meta);
    } catch (error) {
      context?.logger?.('WARN', 'home_tool.action_failed', {
        action,
        error_name: String(error?.name || 'Error').slice(0, 64),
      });
      return failure({
        reason: 'action_failed',
        message: `The Home action could not be completed: ${String(error?.message || error)}`,
        summary: 'Home action failed',
      });
    }
  },
};

module.exports = Object.assign(homeTool, {
  HOME_TOOL_ACTIONS,
});
