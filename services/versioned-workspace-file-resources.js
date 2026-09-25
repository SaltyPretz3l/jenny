'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { filesystemResource } = require('./session-runtime/resource-broker');

const cleanupEvidence = new AsyncLocalStorage();

function markResourceCleanupUncertain(value) {
  const evidence = cleanupEvidence.getStore();
  if (evidence) evidence.confirmed = false;
  return value;
}

function assertAdmittedResourceTarget(targetPath) {
  const evidence = cleanupEvidence.getStore();
  if (!evidence?.targetIdentity) return;
  const expected = evidence.targetIdentity;
  const current = evidence.pathResolver.resolve(targetPath, { allowMissing: false });
  if (current.identity_key !== expected.identity_key) {
    throw new Error('Workspace file resource identity changed after admission.');
  }
}

function validAdmission(admission) {
  return Boolean(admission
    && typeof admission.broker?.acquire === 'function'
    && typeof admission.broker?.release === 'function'
    && typeof admission.pathResolver?.resolve === 'function');
}

function pathIsWithin(rootIdentity, targetIdentity) {
  const root = String(rootIdentity?.comparison_path || '');
  const target = String(targetIdentity?.comparison_path || '');
  return Boolean(root && target && (target === root || target.startsWith(
    root.endsWith('/') ? root : `${root}/`
  )));
}

function createVersionedWorkspaceFileResources({
  resourceAdmissionProvider = null,
  pathImpl,
  createOwnerId = randomUUID,
} = {}) {
  if (resourceAdmissionProvider !== null && typeof resourceAdmissionProvider !== 'function') {
    throw new TypeError('resourceAdmissionProvider must be a function');
  }
  if (!pathImpl || typeof pathImpl.resolve !== 'function') {
    throw new TypeError('Versioned workspace resources require a path implementation');
  }

  async function run({ relPath, capturedContext, rootLease }, operation) {
    const evidence = { confirmed: true };
    return cleanupEvidence.run(evidence, async () => {
      let admission = null;
      let resourceLease = null;
      try {
        if (resourceAdmissionProvider) {
          admission = resourceAdmissionProvider();
          if (!validAdmission(admission)) {
            throw new Error('Workspace file resource admission is unavailable.');
          }
          const candidate = pathImpl.resolve(capturedContext.rootPath, ...relPath.split('/'));
          const rootIdentity = admission.pathResolver.resolve(capturedContext.rootPath);
          const targetIdentity = admission.pathResolver.resolve(candidate);
          if (!pathIsWithin(rootIdentity, targetIdentity)) {
            throw new Error('Workspace file resource resolves outside the active root.');
          }
          resourceLease = await admission.broker.acquire({
            ownerId: `vfs:${createOwnerId()}`,
            resources: [filesystemResource(targetIdentity)],
            signal: rootLease.signal || null,
            validate: () => {
              if (rootLease.isCurrent() !== true) return false;
              const currentRoot = admission.pathResolver.resolve(capturedContext.rootPath);
              const currentTarget = admission.pathResolver.resolve(candidate);
              return pathIsWithin(currentRoot, currentTarget)
                && currentTarget.identity_key === targetIdentity.identity_key;
            },
          });
          evidence.pathResolver = admission.pathResolver;
          evidence.targetIdentity = targetIdentity;
          if (rootLease.isCurrent() !== true) {
            throw new Error('Workspace root changed before file resource admission.');
          }
        }
        return await operation();
      } finally {
        try { rootLease.release(); } catch (_error) { evidence.confirmed = false; }
        if (resourceLease) {
          admission.broker.release(resourceLease, { producerSettled: evidence.confirmed });
        }
      }
    });
  }

  return Object.freeze({ run });
}

module.exports = {
  assertAdmittedResourceTarget,
  createVersionedWorkspaceFileResources,
  markResourceCleanupUncertain,
};
