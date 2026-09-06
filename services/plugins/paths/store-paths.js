'use strict';

// The control-plane path map: one pure module that knows how every on-disk
// path under the plugin store's baseDir is spelled, so no second call site
// ever re-derives (and risks re-deriving wrong, or inconsistently) a path
// another store module already owns.
//
// PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md, "Package, identity, and
// storage" names the store layout this module maps: `generations/`,
// `packages/<sha256>/`, `operations/`, `data/`, `staging/<operation_id>/`
// (in-flight package materialization while a package is being verified --
// invariant 15: "Restricted execution and view serving use the exact
// verified bytes ... Reopening an untrusted mutable package path is never an
// execution primitive," which is exactly why staging is a distinct namespace
// from `packages/<sha256>/`), `quarantine/<sha256>/` (rejected/failed
// packages retained for forensics, never reopened as an execution
// primitive), plus the pointer/journal/audit/lease files the Stage 2 store
// modules already name and own.
//
// This module NEVER re-declares a path-segment string another module already
// exports as its own constant (POINTER_FILE, PRIOR_POINTER_FILE,
// GENERATIONS_DIR, PACKAGES_DIR, OPERATIONS_DIR, JOURNAL_FILE, AUDIT_FILE,
// LEASE_FILE, DATA_DIR, CLEANUP_STATE_FILE): a second hand-typed copy of any
// of those strings is exactly the drift this module exists to prevent. Only
// `staging/` and `quarantine/` are declared here, because no existing module
// owns those namespaces yet.
//
// Pure string work only: no fs, no facade I/O. `stagingDir`/`quarantineDir`
// return a structured `{ok:false, reason}` rather than interpolating an
// unvalidated operation id or digest into a path, because a `..` or a path
// separator smuggled through either is a path-escape attack, not a
// formatting detail (PLUG-D22 posture: every filesystem-adjacent module
// treats its inputs as hostile).

const { joinPath, normalizePath } = require('../store/fs-facade');
const { DATA_DIR } = require('../store/cleanup-state');

// New namespaces this module owns (no existing store module names these).
const STAGING_DIR = 'staging';

// Strict operation-id shape. Deliberately narrower than any UUID/ULID/nanoid
// generator would ever produce -- the point is to REJECT anything that could
// smuggle a path separator or a `..` segment through, not to validate that an
// id was minted by a particular generator.
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Path containment is the thing an attacker attacks: this is the one
 * predicate every path-producing function below is checked against before it
 * hands a path back to a caller.
 * @param {string} baseDir
 * @param {string} candidate
 * @returns {boolean} true iff `candidate` (after normalization) is `baseDir`
 *   itself or a descendant of it.
 */
function isContainedIn(baseDir, candidate) {
  const root = normalizePath(baseDir);
  const target = normalizePath(candidate);
  if (root === '') return true; // '' is the facade root; everything is under it
  return target === root || target.startsWith(`${root}/`);
}

// Internal-only assertion. A containment failure here means THIS module has
// a bug -- every parameterized input is validated (isValidOperationId /
// isValidDigest) before it ever reaches joinPath -- so this throws rather
// than returning a result object, matching generation-store.js's convention
// of throwing on a structurally-impossible-if-this-module-is-correct
// condition rather than on an ordinary business-fail-closed one.
function assertContained(baseDir, candidate) {
  if (!isContainedIn(baseDir, candidate)) {
    throw new Error(`store-paths: derived path escapes baseDir: ${candidate}`);
  }
  return candidate;
}

function isValidOperationId(value) {
  return typeof value === 'string' && OPERATION_ID_PATTERN.test(value);
}

// --- Static (unparameterized) roots and files -------------------------------

function stagingRootDir(baseDir) {
  return assertContained(baseDir, joinPath(baseDir, STAGING_DIR));
}

// Per-plugin host-owned data directory/file, mirroring cleanup-state.js's own
// `data/<publisher_id>/<plugin_id>/` layout exactly (same DATA_DIR constant,
// same join order). Publisher/plugin id SHAPE validation is
// identity/authority-id.js's job, not this module's -- this is pure path
// composition, same division of responsibility cleanup-state.js itself uses.
function pluginDataDir(baseDir, publisherId, pluginId) {
  return assertContained(baseDir, joinPath(baseDir, DATA_DIR, publisherId, pluginId));
}

function pluginSettingsDir(baseDir, publisherId, pluginId) {
  return assertContained(baseDir, joinPath(pluginDataDir(baseDir, publisherId, pluginId), 'settings'));
}

// --- Parameterized namespaces: validate first, never interpolate -----------

// Staging is where a package's bytes are materialized WHILE it is being
// verified -- before it is proven safe, never after. `operationId` must
// already be in its validated form; a `..` or separator anywhere in it is a
// path escape, so this rejects rather than interpolates.
function stagingDir(baseDir, operationId) {
  if (!isValidOperationId(operationId)) {
    return { ok: false, reason: 'invalid_operation_id' };
  }
  const dirPath = joinPath(baseDir, STAGING_DIR, operationId);
  return { ok: true, path: assertContained(baseDir, dirPath) };
}

module.exports = {
  OPERATION_ID_PATTERN,
  STAGING_DIR,
  isContainedIn,
  isValidOperationId,
  stagingRootDir,
  pluginDataDir,
  pluginSettingsDir,
  stagingDir,
};
