'use strict';

/**
 * Schema version constant for the Electron-owned worktree registry.
 *
 * Mirrors the pattern from `services/scheduler-schema-version.js`. When the
 * registry shape changes, bump this constant and document the migration in
 * the worktree-isolation plan addendum so older installs read the file with
 * forward-version safety (log + return empty state) instead of throwing.
 */
const WORKTREE_REGISTRY_SCHEMA_VERSION = 1;

module.exports = {
  WORKTREE_REGISTRY_SCHEMA_VERSION,
};
