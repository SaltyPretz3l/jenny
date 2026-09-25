'use strict';

const { randomUUID } = require('node:crypto');
const { capacityResource, filesystemResource } = require('./session-runtime/resource-broker');

function validProviderResult(value) {
  return Boolean(value
    && typeof value.broker?.acquire === 'function'
    && typeof value.broker?.release === 'function'
    && typeof value.broker?.confirmCleanup === 'function'
    && typeof value.pathResolver?.resolve === 'function');
}

function isContained(root, candidate) {
  const rootPath = String(root?.comparison_path || '');
  const candidatePath = String(candidate?.comparison_path || '');
  return Boolean(rootPath && candidatePath && (candidatePath === rootPath
    || candidatePath.startsWith(rootPath.endsWith('/') ? rootPath : `${rootPath}/`)));
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.identity_key === right.identity_key
    && left.resolved_path === right.resolved_path && left.is_directory === true
    && right.is_directory === true);
}

function createWorkspaceTestRunnerResources({
  resourceAdmissionProvider = null,
  createOwnerId = randomUUID,
} = {}) {
  if (resourceAdmissionProvider !== null && typeof resourceAdmissionProvider !== 'function') {
    throw new TypeError('resourceAdmissionProvider must be a function');
  }

  function admit({ root, cwd, initiator, signal, validate, toolClaim = null }) {
    if (!resourceAdmissionProvider) {
      if (toolClaim) throw new Error('Workspace test resource admission is unavailable.');
      return null;
    }
    const provider = resourceAdmissionProvider();
    if (!validProviderResult(provider)) {
      throw new Error('Workspace test resource admission is unavailable.');
    }
    const rootIdentity = provider.pathResolver.resolve(root);
    if (rootIdentity.exists !== true || rootIdentity.is_directory !== true) {
      throw new Error('Workspace test root resource is unavailable.');
    }
    const cwdIdentity = provider.pathResolver.resolve(cwd);
    if (cwdIdentity.exists !== true || cwdIdentity.is_directory !== true
      || !isContained(rootIdentity, cwdIdentity)) {
      throw new Error('Workspace test working directory is unavailable or outside the workspace.');
    }
    const resources = [
      capacityResource('tests'),
      capacityResource('native_processes'),
      filesystemResource(rootIdentity),
    ];
    if (initiator === 'jenny') resources.push(capacityResource('tool_operations'));
    const assertCurrent = () => {
      if (validate() !== true) return false;
      const currentRoot = provider.pathResolver.resolve(root);
      const currentCwd = provider.pathResolver.resolve(cwd);
      return sameIdentity(rootIdentity, currentRoot)
        && sameIdentity(cwdIdentity, currentCwd)
        && isContained(currentRoot, currentCwd);
    };
    if (toolClaim) return toolClaim.admit().then(() => {
      let outcome = 'failed';
      return Object.freeze({
        resolvedCwd: cwdIdentity.resolved_path,
        assertCurrent() {
          if (signal?.aborted || assertCurrent() !== true) throw new Error('Workspace test authority changed.');
        },
        settle(terminationConfirmed, status = 'failed') {
          outcome = status;
          return toolClaim.settle({ status, cleanup: terminationConfirmed ? 'confirmed' : 'uncertain' });
        },
        confirmCleanup() { return toolClaim.settle({ status: outcome, cleanup: 'confirmed' }); },
      });
    });
    return provider.broker.acquire({
      ownerId: `test:${createOwnerId()}`,
      resources,
      signal,
      validate: assertCurrent,
    }).then((lease) => {
      let released = false;
      return Object.freeze({
        resolvedCwd: cwdIdentity.resolved_path,
        assertCurrent() {
          if (assertCurrent() !== true) throw new Error('Workspace test authority changed.');
        },
        settle(terminationConfirmed) {
          if (released) return true;
          const result = provider.broker.release(lease, {
            producerSettled: terminationConfirmed === true,
          });
          if (result) released = true;
          return result;
        },
        confirmCleanup() {
          if (released) return true;
          const result = provider.broker.confirmCleanup(lease);
          if (result) released = true;
          return result;
        },
      });
    });
  }

  return Object.freeze({ admit });
}

module.exports = { createWorkspaceTestRunnerResources };
