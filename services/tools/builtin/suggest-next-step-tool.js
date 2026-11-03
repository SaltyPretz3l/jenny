'use strict';

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeNextStep } = require('../../backend/next-step-result-metadata');
const { manifestSchema } = require('./tool-result');

const NAME = 'suggest_next_step';
const SUMMARY = 'Suggested a next step';
const CONTENT = 'The next-step card is shown at the end of your reply. Your turn is over: stop now and write '
  + 'nothing more. A button click or typed reply arrives as the user\'s next message.';

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

  async execute(input) {
    const normalized = normalizeNextStep(input);
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
