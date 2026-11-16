'use strict';

// The preference object `sessions.preferences` hands the backend. Only the given keys
// change: entering Propose leaves plan_mode alone. `allowed_nodes` is accepted only on a
// team host, after the one authorization function allowed the mutation; any other host,
// or a malformed list, is refused before anything is written. Why the list rides a symbol
// key: services/backend/session-allowed-nodes.js.

const { hostFailure } = require('./api-contract');
const { ALLOWED_NODES_PREFERENCE, readAllowedNodes } = require('../services/backend/session-allowed-nodes');

function refused(command) {
  const failure = hostFailure('invalid', 'allowed_nodes_invalid', command.request_id);
  return Object.assign(new Error('allowed_nodes_invalid'), { routerFailure: failure });
}

function preferencesFor(command, teamHost) {
  const { allowed_nodes: allowedNodes, ...rest } = command.params;
  if (!Object.hasOwn(command.params, 'allowed_nodes')) return rest;
  const list = teamHost === true ? readAllowedNodes(allowedNodes) : undefined;
  if (list === undefined) throw refused(command);
  return { ...rest, [ALLOWED_NODES_PREFERENCE]: list };
}

module.exports = { preferencesFor };
