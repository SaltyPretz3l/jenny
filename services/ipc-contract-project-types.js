/**
 * @typedef {Object} ProjectRecord
 * @property {string} id
 * @property {string} name
 * @property {string|null} root_path
 * @property {string|null} root_id
 * @property {number} root_revision
 * @property {Object} runtime_preferences
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string} authority_key Opaque hash of the current captured root authority.
 */

/**
 * @typedef {Object} ProjectRootBindingPayload
 * @property {string} project_id
 * @property {string|null} root_path
 * @property {number} expected_root_revision
 */

/**
 * @typedef {Object} PermissionReviewResolutionPayload
 * @property {string} review_id
 * @property {'auto'|'ask'|'deny'|'dismiss'} decision
 * @property {string} [project_id] Required for auto.
 * @property {number} [expected_root_revision] Required for auto.
 * @property {string} [expected_authority_key] Required for auto.
 */

module.exports = {};
