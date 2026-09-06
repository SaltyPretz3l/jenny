'use strict';

const LIMITS = Object.freeze({
  packageBytes: 64 * 1024 * 1024, metadataDocumentBytes: 2 * 1024 * 1024,
  refreshBytes: 16 * 1024 * 1024, refreshMs: 60000, gitMs: 120000,
  gitOutputBytes: 64 * 1024, rootRotations: 32, delegatedRoles: 64, targets: 10000,
  solverNodes: 64, dependenciesPerNode: 16, candidatesPerPlugin: 64,
  solverDecisions: 4096, solverIncompatibilities: 8192, solverMs: 2000,
  cacheBytes: 512 * 1024 * 1024, installedBytes: 4 * 1024 * 1024 * 1024,
  installedPluginBytes: 512 * 1024 * 1024, retainedGenerations: 3,
  snapshotsPerPlugin: 2, terminalReceiptMs: 30 * 24 * 60 * 60 * 1000,
});

module.exports = { LIMITS };
