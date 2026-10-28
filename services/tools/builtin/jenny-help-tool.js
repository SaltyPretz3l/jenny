'use strict';

// `jenny_help` (row 69 W4b): read-only search and read over the bundled app guide
// (services/app-guide-service.js). It touches no chat, store or file outside config/app-guide, so it
// needs no caller binding. Guide text is reference data for the model, never an instruction.
const { manifestSchema } = require('./tool-result');
const { jsonToolResult } = require('./session-directory-tool-support');

const NAME = 'jenny_help';
const SEARCH_KEYS = ['action', 'query'];
const READ_KEYS = ['action', 'page'];

function boundedString(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const keys = Object.keys(input);
  if (input.action === 'search') {
    return keys.length === SEARCH_KEYS.length && keys.every(key => SEARCH_KEYS.includes(key)) && boundedString(input.query, 200);
  }
  if (input.action === 'read') {
    return keys.length === READ_KEYS.length && keys.every(key => READ_KEYS.includes(key)) && boundedString(input.page, 64);
  }
  return false;
}

const result = (value) => jsonToolResult(NAME, 'Jenny help', value);

function guideFor(context) {
  const injected = context.appGuideService;
  return injected || require('../../app-guide-service').getAppGuideService();
}

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: true, sideEffecting: false,
  summarize: (input) => (input?.action === 'read' ? 'Jenny help: read' : 'Jenny help: search'),
  async execute(input = {}, context = {}) {
    if (!validInput(input)) return result({ ok: false, reason: 'invalid_request' });
    try {
      const guide = guideFor(context);
      return result(input.action === 'search' ? guide.search(input.query.trim()) : guide.read(input.page));
    } catch (_error) {
      return result({ ok: false, reason: 'unavailable' });
    }
  },
};
