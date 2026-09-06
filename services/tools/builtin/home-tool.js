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
const { HOME_CALENDAR_COLOR_IDS } = require('../../home-config-schema');
const {
  HOME_CALENDAR_RECURRENCE_PRESETS,
  MAX_CALENDAR_EVENT_NOTES_CHARS,
  MAX_CALENDAR_EVENT_TITLE_CHARS,
} = require('../../home-calendar-schema');
const {
  MAX_PROACTIVE_REMINDER_LABEL_CHARS,
  MAX_PROACTIVE_REMINDER_PROMPT_CHARS,
} = require('../../shell-config-followups-schema');
const { HOME_ACTIONS, failure } = require('./home-tool-actions');

const HOME_TOOL_ACTIONS = Object.freeze(Object.keys(HOME_ACTIONS));

const homeToolParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: [...HOME_TOOL_ACTIONS],
      description: 'Which Home operation to perform.',
    },
    id: {
      type: 'string',
      maxLength: 128,
      description: 'Existing event or reminder id. Omit on an upsert to create a new record.',
    },
    title: {
      type: 'string',
      maxLength: MAX_CALENDAR_EVENT_TITLE_CHARS,
      description: 'Calendar event title.',
    },
    start: {
      type: 'string',
      description: 'Event start as a local wall-clock "YYYY-MM-DDTHH:MM" string (no timezone).',
    },
    end: {
      type: 'string',
      description: 'Event end as a local wall-clock "YYYY-MM-DDTHH:MM" string. Defaults to 30 minutes after start.',
    },
    all_day: {
      type: 'boolean',
      description: 'True for an all-day event.',
    },
    category: {
      type: 'string',
      enum: [...HOME_CALENDAR_COLOR_IDS],
      description: 'Calendar category, which also selects the event color.',
    },
    notes: {
      type: 'string',
      maxLength: MAX_CALENDAR_EVENT_NOTES_CHARS,
      description: 'Free-form event notes.',
    },
    recurrence: {
      type: 'string',
      enum: [...HOME_CALENDAR_RECURRENCE_PRESETS],
      description: 'Event recurrence preset.',
    },
    label: {
      type: 'string',
      maxLength: MAX_PROACTIVE_REMINDER_LABEL_CHARS,
      description: 'Reminder label shown on Home.',
    },
    prompt: {
      type: 'string',
      maxLength: MAX_PROACTIVE_REMINDER_PROMPT_CHARS,
      description: 'Optional text to raise with the user when the reminder is surfaced.',
    },
    remind_at: {
      type: 'string',
      description: 'Reminder time: "YYYY-MM-DDTHH:MM" for a one-shot, or "HH:MM" for a daily reminder.',
    },
    range_start: {
      type: 'string',
      description: 'Optional local "YYYY-MM-DDTHH:MM" lower bound for calendar_list.',
    },
    range_end: {
      type: 'string',
      description: 'Optional local "YYYY-MM-DDTHH:MM" upper bound for calendar_list.',
    },
    confirm: {
      type: 'boolean',
      description: 'Required true to actually perform a delete. Without it the tool only reports what would be deleted.',
    },
  },
  required: ['action'],
};

const homeTool = {
  name: 'home',
  description: 'Read and update the user\'s Home surfaces: list calendar events, create/update/delete events and reminders, and read the Home scratchpad. Every write is attributed to Jenny and one-click undoable; deletes require a confirm round-trip.',
  category: 'builtin',
  readOnly: false,
  workspaceRequired: false,
  parameters: homeToolParameters,

  summarize(input) {
    const action = normalizeString(input?.action);
    return `Home: ${action || 'action'}`;
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
    const handler = HOME_ACTIONS[action];
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
  homeToolParameters,
});
