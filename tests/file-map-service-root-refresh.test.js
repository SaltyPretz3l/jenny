'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WorkspaceFileMapService } = require('../services/workspace-file-map-service');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a queued forced refresh does not escape to a newly committed root', async () => {
  const gate = deferred();
  let currentContext = { rootId: 'root-a', generation: 1 };
  let listCalls = 0;
  const ideService = {
    async acquireRootOperation() {
      const captured = currentContext;
      let released = false;
      return {
        acquired: true,
        context: captured,
        root: { configuredPath: captured.rootId, realPath: captured.rootId },
        signal: new AbortController().signal,
        isCurrent: () => !released && captured === currentContext,
        release: () => { released = true; },
      };
    },
    async listAllFiles() {
      listCalls += 1;
      if (listCalls === 1) await gate.promise;
      return { files: [], truncated: false };
    },
    versionedFileService: { async readText() { throw new Error('unexpected read'); } },
  };
  const service = new WorkspaceFileMapService({
    ideService,
    gitService: {
      async getChangedFilesByCommit() {
        return { ok: true, commits: [], truncated: false };
      },
    },
    engine: {
      buildGraph() {
        return {
          nodes: [], edges: [], findings: { hubs: [], cycles: [], orphans: [] }, meta: {},
        };
      },
    },
    scanRules: { isDependencyContentPath: () => false },
  });

  const initial = service.getGraph('caller-a');
  const queued = service.refresh('caller-b');
  await Promise.resolve();
  currentContext = { rootId: 'root-b', generation: 2 };
  gate.resolve();

  assert.equal((await initial).ok, false);
  assert.equal((await queued).ok, false);
  assert.equal(listCalls, 1, 'the stale queued refresh must not enumerate the new root');
});
