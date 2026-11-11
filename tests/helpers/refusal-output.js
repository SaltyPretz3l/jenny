'use strict';

// The shared refusal JSON carries a fixed sentence per reason (row 129, A9;
// tests/tool-refusal-sentences.test.js pins the sentences). Tool tests assert the reason and the
// tool's own fields, so this parses a result and drops only that fixed sentence.
const { REFUSAL_SENTENCES } = require('../../services/tools/builtin/session-directory-tool-support');

function parseToolOutput(result) {
  const value = JSON.parse(result.content);
  if (value && value.ok === false && Object.hasOwn(REFUSAL_SENTENCES, value.reason)
    && value.message === REFUSAL_SENTENCES[value.reason]) {
    delete value.message;
  }
  return value;
}

module.exports = { parseToolOutput };
