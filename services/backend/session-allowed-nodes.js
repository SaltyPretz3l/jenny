'use strict';

/**
 * A conversation's allowed-node list (row 123; session store schema 28).
 *
 * `allowed_nodes` is absent or null (any node) or an array of 1 to the pool
 * scheduler's `maxNodes` distinct node ids. The rule is the scheduler's own
 * `normalizeAllowedNodes` (server/team/scheduler/state.js), not a copy: the
 * store, the host's setter and the lease request read one definition. Node ids
 * are a fixed function of the node's device, so a saved list keeps matching a
 * node that registers again.
 *
 * A stored list that fails the rule never reads as "any node": the record keeps
 * an empty list, a restriction no turn satisfies (the pool refuses it as
 * `allowed_nodes_invalid`), until a writer saves a valid list or clears it with null.
 *
 * Only a team host sets it. The preference patch takes the list only under the
 * `ALLOWED_NODES_PREFERENCE` symbol key, which no IPC payload or JSON body can
 * carry (structured clone and JSON drop symbol keys): a desktop renderer that
 * sends a string `allowed_nodes` key changes nothing. The team host's
 * `sessions.preferences` command maps its checked field onto the symbol after
 * the one authorization function allowed the mutation (server/command-router-preferences.js).
 *
 * Review sweeps, second run (X2b-F03): the scheduler's modules load at the first list there is to read, a team
 * host's use; absent and null (every desktop record and patch) answer "any node" before that, as the rule does,
 * so desktop main loads no server/team module (tests/team-off.test.js).
 */

const ALLOWED_NODES_PREFERENCE = Symbol('allowed_nodes');

/** null for any node, a frozen list, or undefined when the value is not acceptable. */
function readAllowedNodes(value) {
  if (value === undefined || value === null) return null;
  const { DEFAULT_LIMITS } = require('../../server/team/scheduler/limits');
  const { normalizeAllowedNodes } = require('../../server/team/scheduler/state');
  return normalizeAllowedNodes(value, DEFAULT_LIMITS);
}

/**
 * The field a stored record keeps: nothing for absent or null, `{ allowed_nodes: [...] }` for a
 * valid list, and `{ allowed_nodes: [] }` (fails closed) for a value that is present and not acceptable.
 */
function allowedNodesField(value) {
  const list = readAllowedNodes(value);
  if (list === null) return {};
  return { allowed_nodes: list ? [...list] : [] };
}

/**
 * The patch for a preference object that carries the symbol key: `{ allowed_nodes }`
 * (null clears it), or `{}` without the key. A malformed list throws, so nothing is written.
 */
function allowedNodesPatch(preferences) {
  if (!preferences || typeof preferences !== 'object' || !Object.hasOwn(preferences, ALLOWED_NODES_PREFERENCE)) return {};
  const list = readAllowedNodes(preferences[ALLOWED_NODES_PREFERENCE]);
  if (list === undefined) throw Object.assign(new RangeError('allowed_nodes_invalid'), { reason: 'allowed_nodes_invalid' });
  return { allowed_nodes: list ? [...list] : null };
}

// v28 adds the optional `allowed_nodes`. The step changes no record that lacks it
// (absent means any node), never adds the field, and keeps a malformed one as a restriction.
function repairSessionForV28(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  if (!Object.hasOwn(source, 'allowed_nodes')) return { ...source };
  const { allowed_nodes: stored, ...rest } = source;
  return { ...rest, ...allowedNodesField(stored) };
}

module.exports = {
  ALLOWED_NODES_PREFERENCE,
  allowedNodesField,
  allowedNodesPatch,
  readAllowedNodes,
  repairSessionForV28,
};
