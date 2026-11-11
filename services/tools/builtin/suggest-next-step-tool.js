'use strict';

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeNextStep } = require('../../backend/next-step-result-metadata');
const { isPlainObject } = require('../../value-utils');
const { manifestSchema } = require('./tool-result');

const NAME = 'suggest_next_step';
const SUMMARY = 'Suggested a next step';
const CONTENT = 'The next-step card is shown at the end of your reply. Your turn is over: stop now and write '
  + 'nothing more. A button click or typed reply arrives as the user\'s next message.';

const OTHER_MESSAGE_NAMES = ['action', 'text'];

// A button's text arrives as `message`; a model also sends it as `action` or `text`. Read those as
// `message` only when it is absent (a present `message` wins and the others are ignored, as before),
// and refuse two different texts under the two other names.
function withMessageSpelling(input) {
  if (!isPlainObject(input) || !Array.isArray(input.actions)) return { input };
  const actions = [];
  for (const [index, action] of input.actions.entries()) {
    if (!isPlainObject(action) || Object.hasOwn(action, 'message')) { actions.push(action); continue; }
    const given = OTHER_MESSAGE_NAMES.filter((name) => typeof action[name] === 'string');
    if (new Set(given.map((name) => action[name])).size > 1) {
      return { error: `${NAME}: action ${index + 1} sends different text as ${given.join(' and ')}, and those names conflict. `
        + 'Send the button text once, as message.' };
    }
    actions.push(given.length ? { ...action, message: action[given[0]] } : action);
  }
  return { input: { ...input, actions } };
}

// Records a card for the renderer to draw; it never waits and touches no state.
module.exports = {
  name: NAME,
  ...manifestSchema(NAME),
  category: 'builtin',
  readOnly: true,
  sideEffecting: false,
  workspaceRequired: false,

  summarize() {
    return SUMMARY;
  },

  async execute(rawInput) {
    const spelled = withMessageSpelling(rawInput);
    const normalized = spelled.error ? { ok: false, error: spelled.error } : normalizeNextStep(spelled.input);
    if (!normalized.ok) {
      return {
        content: normalized.error,
        summary: 'Next step not shown',
        isError: true,
        errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
      };
    }
    return {
      content: CONTENT,
      summary: SUMMARY,
      isError: false,
      metadata: { schema_version: 1, result_kind: 'next_step', ...normalized.value },
    };
  },
};
