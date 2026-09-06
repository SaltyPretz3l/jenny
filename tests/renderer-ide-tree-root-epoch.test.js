'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTree } = require('../renderer/features/renderer-ide-tree');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('delete settlement after a root switch cannot notify the new-root controller', async () => {
  const listing = deferred();
  const listingStarted = deferred();
  const deleted = [];
  const ide = { expandedDirs: new Set(), showGenerated: false };
  const tree = createIdeTree({
    getIde: () => ide,
    getMountEl: () => null,
    isActivePanel: () => false,
    getWorkspaceFsApi: () => ({
      async delete() { return { deleted: true }; },
      async listDirectory() {
        listingStarted.resolve();
        return listing.promise;
      },
    }),
    getMutationContext: async () => ({ phase: 'ready', rootId: 'root-a', generation: 1 }),
    confirmDelete: async () => true,
    onEntryDeleted: (path, kind) => deleted.push({ path, kind }),
  });

  const pendingDelete = tree.deleteEntry('src/a.js', 'file');
  await listingStarted.promise;
  tree.resetForRoot();
  listing.resolve({ entries: [] });
  await pendingDelete;

  assert.deepEqual(deleted, [], 'the stale root-A delete cannot close a matching root-B tab');
  tree.dispose();
});
