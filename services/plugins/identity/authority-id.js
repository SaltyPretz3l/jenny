'use strict';

// Stable authority identity: the tuple publisher_id/plugin_id/contribution_id
// (PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md, "Package, identity, and
// storage": "Stable authority identity is the tuple
// publisher_id/plugin_id/contribution_id ... Package version, artifact
// digest, and source identity remain separate lock attributes. Signature
// proves publisher continuity, not safety.").
//
// Pure functions only: no fs/net/child_process, no ambient clock, no ambient
// storage.

// Kept in sync with the closed publisher_id/plugin_id/contribution_id string
// formats baked into scripts/generate_plugin_contracts.py's FORMATS table.
// Duplicated locally (rather than imported from the generated contract
// module) so this module has no dependency on contract generation and stays
// usable even before any contract references these ids.
const PUBLISHER_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CONTRIBUTION_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * @param {unknown} value
 * @param {RegExp} pattern
 */
function isValidIdString(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

/**
 * Validates the shape of a stable authority tuple. Does not consult any
 * registry; this is a pure structural check.
 * @param {{publisherId:unknown,pluginId:unknown,contributionId:unknown}} tuple
 * @returns {{ok:true}|{ok:false,code:string,field:string}}
 */
function canonicalAuthorityTuple({ publisherId, pluginId, contributionId }) {
  if (!isValidIdString(publisherId, PUBLISHER_ID_RE)) {
    return { ok: false, code: 'malformed_authority_field', field: 'publisher_id' };
  }
  if (!isValidIdString(pluginId, PLUGIN_ID_RE)) {
    return { ok: false, code: 'malformed_authority_field', field: 'plugin_id' };
  }
  if (!isValidIdString(contributionId, CONTRIBUTION_ID_RE)) {
    return { ok: false, code: 'malformed_authority_field', field: 'contribution_id' };
  }
  return { ok: true };
}

/**
 * The flat authority key used for map/set membership (registries, tombstone
 * lookups). Distinct from the derived tool id: this key is for Jenny-internal
 * bookkeeping and is never presented as a channel/protocol identifier.
 * @param {{publisherId:string,pluginId:string,contributionId:string}} tuple
 */
function authorityKey({ publisherId, pluginId, contributionId }) {
  return `${publisherId}/${pluginId}/${contributionId}`;
}

module.exports = {
  PUBLISHER_ID_RE,
  PLUGIN_ID_RE,
  CONTRIBUTION_ID_RE,
  canonicalAuthorityTuple,
  authorityKey,
};
