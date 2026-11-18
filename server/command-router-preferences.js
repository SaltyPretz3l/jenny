'use strict';

// The preference object `sessions.preferences` hands the backend. Only the given keys
// change: entering Propose leaves plan_mode alone. `allowed_nodes` is accepted only on a
// team host, after the one authorization function allowed the mutation; any other host,
// or a malformed list, is refused before anything is written. Why the list rides a symbol
// key: services/backend/session-allowed-nodes.js. Row 172's model, effort and tool switches follow the same
// rule (server/team-conversation-preferences.js); `team` carries the backend and the authorized author.

const { hostFailure } = require('./api-contract');
const { ALLOWED_NODES_PREFERENCE, readAllowedNodes } = require('../services/backend/session-allowed-nodes');
const { teamPreferenceChange, withTeamPreferences } = require('./team-conversation-preferences');

function refused(command) {
  const failure = hostFailure('invalid', 'allowed_nodes_invalid', command.request_id);
  return Object.assign(new Error('allowed_nodes_invalid'), { routerFailure: failure });
}

function preferencesFor(command, teamHost, team = {}) {
  const { allowed_nodes: allowedNodes, ...params } = command.params;
  const { rest, change } = teamPreferenceChange(command, params, { ...team, teamHost });
  if (!Object.hasOwn(command.params, 'allowed_nodes')) return withTeamPreferences(rest, change);
  const list = teamHost === true ? readAllowedNodes(allowedNodes) : undefined;
  if (list === undefined) throw refused(command);
  return withTeamPreferences({ ...rest, [ALLOWED_NODES_PREFERENCE]: list }, change);
}

module.exports = { preferencesFor };
