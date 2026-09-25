'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const {
  capacityResource,
  filesystemResource,
} = require('./session-runtime/resource-broker');

const cleanupEvidence = new AsyncLocalStorage();

class WorkspaceGitResourceError extends Error {
  constructor(reason, cause = null) {
    super('Workspace Git resource admission is unavailable.');
    this.name = 'WorkspaceGitResourceError';
    this.reason = reason;
    if (cause) this.cause = cause;
  }
}

function validProvider(value) {
  return Boolean(value
    && typeof value.broker?.acquire === 'function'
    && typeof value.broker?.release === 'function'
    && typeof value.pathResolver?.resolve === 'function');
}

function sameDirectoryIdentity(left, right) {
  return Boolean(left && right
    && left.type === 'filesystem' && right.type === 'filesystem'
    && left.exists === true && right.exists === true
    && left.is_directory === true && right.is_directory === true
    && left.identity_key === right.identity_key
    && left.resolved_path === right.resolved_path);
}

function resourceReason(error) {
  if (error?.name === 'AbortError') return 'cancelled';
  if (/authority changed/i.test(String(error?.message || ''))) return 'root_changed';
  return 'resource_admission_unavailable';
}

function createWorkspaceGitResources({
  resourceAdmissionProvider = null,
  createOwnerId = randomUUID,
} = {}) {
  if (resourceAdmissionProvider !== null && typeof resourceAdmissionProvider !== 'function') {
    throw new TypeError('Workspace Git resource admission provider must be a function.');
  }
  if (typeof createOwnerId !== 'function') {
    throw new TypeError('Workspace Git resource owner factory must be a function.');
  }

  function wrapExecutor(executor) {
    if (typeof executor !== 'function') {
      throw new TypeError('Workspace Git executor must be a function.');
    }
    return async (...args) => {
      const evidence = cleanupEvidence.getStore();
      if (!evidence) return executor(...args);
      evidence.assertCurrent();
      evidence.producerStarted = true;
      try {
        let result = await executor(...args);
        if (result?.cleanupConfirmed !== true && typeof result?.retryCleanup === 'function') {
          try {
            const retried = await result.retryCleanup();
            if (retried?.confirmed === true) result = { ...result, cleanupConfirmed: true };
          } catch (_error) {
            // Missing containment proof is retained below and quarantines the lease.
          }
        }
        if (result?.cleanupConfirmed !== true) evidence.cleanupConfirmed = false;
        return result;
      } catch (error) {
        evidence.cleanupConfirmed = false;
        throw error;
      }
    };
  }

  async function run({ root, signal = null, validate }, operation) {
    if (typeof operation !== 'function' || typeof validate !== 'function') {
      throw new TypeError('Workspace Git resource operation is invalid.');
    }
    if (!resourceAdmissionProvider) return operation();

    let provider;
    try { provider = resourceAdmissionProvider(); } catch (error) {
      throw new WorkspaceGitResourceError('resource_admission_unavailable', error);
    }
    if (!validProvider(provider)) {
      throw new WorkspaceGitResourceError('resource_admission_unavailable');
    }

    let rootIdentity;
    try { rootIdentity = provider.pathResolver.resolve(root); } catch (error) {
      throw new WorkspaceGitResourceError('resource_identity_unavailable', error);
    }
    if (rootIdentity?.exists !== true || rootIdentity?.is_directory !== true) {
      throw new WorkspaceGitResourceError('resource_identity_unavailable');
    }
    const assertCurrent = () => {
      let current;
      try {
        if (validate() !== true || signal?.aborted) throw new Error('Workspace root authority changed.');
        current = provider.pathResolver.resolve(root);
      } catch (error) {
        throw new WorkspaceGitResourceError('root_changed', error);
      }
      if (!sameDirectoryIdentity(rootIdentity, current)) {
        throw new WorkspaceGitResourceError('root_changed');
      }
      return true;
    };

    let lease;
    try {
      lease = await provider.broker.acquire({
        ownerId: `git:${createOwnerId()}`,
        resources: [
          capacityResource('native_processes'),
          filesystemResource(rootIdentity),
        ],
        signal,
        validate: () => {
          try { return assertCurrent(); } catch (_error) { return false; }
        },
      });
      assertCurrent();
    } catch (error) {
      if (lease) provider.broker.release(lease, { producerSettled: true });
      throw error instanceof WorkspaceGitResourceError
        ? error
        : new WorkspaceGitResourceError(resourceReason(error), error);
    }

    const evidence = { producerStarted: false, cleanupConfirmed: true, assertCurrent };
    try {
      return await cleanupEvidence.run(evidence, operation);
    } finally {
      provider.broker.release(lease, {
        producerSettled: evidence.producerStarted !== true || evidence.cleanupConfirmed === true,
      });
    }
  }

  return Object.freeze({ run, wrapExecutor });
}

function isWorkspaceGitResourceError(error) {
  return error instanceof WorkspaceGitResourceError;
}

module.exports = {
  WorkspaceGitResourceError,
  createWorkspaceGitResources,
  isWorkspaceGitResourceError,
};
