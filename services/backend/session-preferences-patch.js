'use strict';

// Maps a caller-supplied session-preferences object onto a session-record
// patch (only the keys the caller actually passed). Extracted from
// electron-session-store.js (`_preferencesPatch`) to keep the store under the
// file-size ceiling; the store delegates here and remains the only caller.

const {
  normalizeContextPreferences,
} = require('./context-preferences');
const {
  normalizePendingPlanProposal,
} = require('./message-normalization');
const {
  normalizeLinkedSessionIds,
} = require('./session-store-migrations');
const {
  normalizeSessionStartDate,
  normalizeToolCategoryOverrides,
} = require('./session-normalizers');

const PASSTHROUGH_PREFERENCE_KEYS = [
  'preferred_model',
  'reasoning_effort',
  'conversation_mode',
  'pending_question_batch',
  'interactive_sequence_state',
  'interactive_round_count',
  'diagnostic_mode',
  'diagnostic_run_id',
  'diagnostic_provider',
  'diagnostic_model',
];
const BOOLEAN_PREFERENCE_KEYS = ['lockdown'];

const RUN_MODES = new Set(['ask', 'auto', 'plan']);

// Keep in sync with the renderer twin in renderer-composer-v2-state.js.
function normalizeRunMode(value, { planModeFallback = false } = {}) {
  const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return RUN_MODES.has(token) ? token : (planModeFallback === true ? 'plan' : 'ask');
}

function buildSessionPreferencesPatch(preferences = {}, currentRecord = {}) {
  const source = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? preferences
    : {};
  const record = currentRecord && typeof currentRecord === 'object' && !Array.isArray(currentRecord)
    ? currentRecord
    : {};
  const patch = {};
  for (const key of PASSTHROUGH_PREFERENCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      patch[key] = source[key];
    }
  }
  for (const key of BOOLEAN_PREFERENCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      patch[key] = source[key] === true;
    }
  }
  const currentMode = normalizeRunMode(record.run_mode, {
    planModeFallback: record.plan_mode === true,
  });
  if (Object.prototype.hasOwnProperty.call(source, 'run_mode')) {
    patch.run_mode = normalizeRunMode(source.run_mode);
    patch.plan_mode = patch.run_mode === 'plan';
    if (patch.plan_mode && currentMode !== 'plan') {
      patch.pre_plan_run_mode = currentMode;
    } else if (!patch.plan_mode && currentMode === 'plan') {
      patch.pre_plan_run_mode = '';
    }
  } else if (Object.prototype.hasOwnProperty.call(source, 'plan_mode')) {
    patch.plan_mode = source.plan_mode === true;
    if (patch.plan_mode) {
      patch.run_mode = 'plan';
      if (currentMode !== 'plan') {
        patch.pre_plan_run_mode = currentMode;
      }
    } else if (currentMode === 'plan') {
      // Leaving plan restores the captured pre-plan mode; a plan_mode:false
      // echo from a routine pref save (session not in plan) changes nothing.
      patch.run_mode = normalizeRunMode(record.pre_plan_run_mode);
      patch.pre_plan_run_mode = '';
    }
  }
  if (Object.prototype.hasOwnProperty.call(source, 'pending_plan_proposal')) {
    patch.pending_plan_proposal = normalizePendingPlanProposal(source.pending_plan_proposal);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'context_preferences')) {
    patch.context_preferences = normalizeContextPreferences(source.context_preferences);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'linked_session_ids')) {
    patch.linked_session_ids = normalizeLinkedSessionIds(source.linked_session_ids);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'session_start_date')) {
    patch.session_start_date = normalizeSessionStartDate(source.session_start_date);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'tool_category_overrides')) {
    patch.tool_category_overrides = normalizeToolCategoryOverrides(source.tool_category_overrides);
  }
  return patch;
}

module.exports = {
  buildSessionPreferencesPatch,
  normalizeRunMode,
};
