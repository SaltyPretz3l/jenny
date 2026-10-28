'use strict';

// Row 77: the Components draft rides on the File Map scan. The worker attaches
// graph.components when the payload asks for it and never fails the map on a
// draft error; the service asks per scan through `componentsEnabled`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildGraphFromPayload } = require('../services/workspace-file-map-worker');
const { WorkspaceFileMapService } = require('../services/workspace-file-map-service');

const PAYLOAD = Object.freeze({
  files: ['app/a.js', 'app/b.js', 'lib/c.js', 'lib/d.js', 'tests/a.test.js'],
  contentEntries: [
    ['app/a.js', "require('../lib/c');\nrequire('../lib/d');\n"],
    ['app/b.js', "require('./a');\n"],
    ['lib/c.js', ''],
    ['lib/d.js', ''],
    ['tests/a.test.js', "require('../app/a');\n"],
  ],
  cochangeCommits: [],
});

test('the worker attaches the component tree when the payload asks for it', () => {
  const graph = buildGraphFromPayload({ ...PAYLOAD, components: true });
  assert.equal(graph.components.version, 1);
  const roots = graph.components.components.filter((c) => c.parentId === null);
  assert.deepEqual(roots.map((c) => [c.name, c.fileCount, c.files]), [['app', 2, ['app/a.js', 'app/b.js']], ['lib', 2, ['lib/c.js', 'lib/d.js']]]);
  const ids = Object.fromEntries(roots.map((c) => [c.name, c.id]));
  assert.deepEqual(graph.components.relations, [{ scopeId: 'root', from: ids.app, to: ids.lib, weight: 2 }]);
  assert.deepEqual(graph.components.outside, [{ id: 'tests', fileCount: 1 }]);
  assert.deepEqual(graph.components.outsideRelations, [{ from: 'tests', to: ids.app, files: 1 }]);
});

test('the worker leaves the graph unchanged when the payload does not ask', () => {
  const graph = buildGraphFromPayload({ ...PAYLOAD });
  assert.equal('components' in graph, false);
  assert.equal(graph.nodes.length, 5);
});

test('a failed draft never fails the map', (t) => {
  const modulePath = require.resolve('../services/workspace-file-map-components');
  const components = require(modulePath);
  const original = components.draftComponents;
  components.draftComponents = () => { throw new Error('draft exploded'); };
  t.after(() => { components.draftComponents = original; });

  const graph = buildGraphFromPayload({ ...PAYLOAD, components: true });
  assert.equal(graph.components, null);
  assert.equal(graph.meta.componentsError, 'draft exploded');
  assert.equal(graph.nodes.length, 5);
});

function fakeIdeService(files) {
  return {
    async acquireRootOperation() {
      return {
        acquired: true,
        context: { rootId: 'root-a', generation: 1 },
        root: { configuredPath: 'root-a', realPath: 'root-a' },
        signal: new AbortController().signal,
        isCurrent: () => true,
        release: () => {},
      };
    },
    async listAllFiles() {
      return { files, truncated: false };
    },
    async stat() {
      return { exists: false, kind: 'missing', size: 0, mtimeMs: 0 };
    },
    versionedFileService: {
      async readText({ path }) {
        return { path, content: '', fileVersion: 'v1', rootId: 'root-a', generation: 1 };
      },
    },
  };
}

async function scanPayload(componentsEnabled) {
  const payloads = [];
  const options = {
    ideService: fakeIdeService(['app/a.js']),
    gitService: {
      async getChangedFilesByCommit() {
        return { ok: true, commits: [], truncated: false };
      },
    },
    graphBuilder: async (payload) => {
      payloads.push(payload);
      return { nodes: [], edges: [], findings: { hubs: [], cycles: [], orphans: [] }, meta: {} };
    },
    scanRules: { isDependencyContentPath: () => true },
  };
  if (componentsEnabled !== undefined) options.componentsEnabled = componentsEnabled;
  const service = new WorkspaceFileMapService(options);
  try {
    const result = await service.getGraph('caller');
    assert.equal(result.ok, true);
  } finally {
    service.dispose();
  }
  assert.equal(payloads.length, 1);
  return payloads[0];
}

test('the service asks for the draft by default and per scan through its provider', async () => {
  assert.equal((await scanPayload()).components, true);
  assert.equal((await scanPayload(() => true)).components, true);
  assert.equal((await scanPayload(() => false)).components, false);
  assert.equal((await scanPayload(false)).components, false);
});
