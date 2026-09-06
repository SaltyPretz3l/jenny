'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { WorkspaceIdeService } = require('../services/workspace-ide-service');
const { GENERATED_DIRECTORY_NAMES } = require('../services/workspace-ide-generated-directories');
const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');

function createService(root, platform = process.platform) {
  const coordinator = new WorkspaceRootCoordinator({
    initialRootPath: root,
    normalizeRootPath: (value) => String(value || ''),
    rootIdFactory: (value) => value ? `root:${String(value).toLowerCase()}` : null,
  });
  return new WorkspaceIdeService({
    platform,
    rootContextProvider: () => coordinator,
    configService: {
      getToolsWorkspaceRoot: () => root,
      getState: () => ({ toolsWorkspaceRoot: root }),
      getWorkspaceRootStatus: () => ({ state: 'ready', message: '' }),
    },
  });
}

test.afterEach(async () => cleanupTrackedResources());

test('listDirectory hides the conservative generated set unless explicitly shown', async () => {
  const root = createTrackedTempDir('jenny-generated-visibility-');
  for (const name of GENERATED_DIRECTORY_NAMES) fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'source'), { recursive: true });
  fs.writeFileSync(path.join(root, 'source', 'dist'), 'ordinary file', 'utf8');
  // The manifest marks this directory as a package root, so the ambiguous
  // names (build/dist/out/target) hide alongside the unambiguous set.
  fs.writeFileSync(path.join(root, 'package.json'), '{}', 'utf8');
  const service = createService(root);

  const hidden = await service.listDirectory();
  assert.deepEqual(hidden.entries.map((entry) => entry.name), ['source', 'package.json']);
  const malformedOptIn = await service.listDirectory({ showGenerated: 'true' });
  assert.deepEqual(malformedOptIn.entries.map((entry) => entry.name), ['source', 'package.json']);

  const shown = await service.listDirectory({ showGenerated: true });
  const shownNames = new Set(shown.entries.map((entry) => entry.name));
  for (const name of GENERATED_DIRECTORY_NAMES) assert.equal(shownNames.has(name), true, name);
  assert.equal(shownNames.has('.git'), false);
  const nested = await service.listDirectory({ path: 'source' });
  assert.deepEqual(nested.entries.map((entry) => ({ name: entry.name, kind: entry.kind })), [
    { name: 'dist', kind: 'file' },
  ]);
});

test('ambiguous generated names stay visible without a build-manifest sibling', async () => {
  const root = createTrackedTempDir('jenny-generated-ambiguous-');
  // A hand-authored src/build module: no package/build manifest next to it.
  fs.mkdirSync(path.join(root, 'src', 'build'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'out'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.js'), '', 'utf8');
  const service = createService(root);

  const listing = await service.listDirectory({ path: 'src' });
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ['build', 'out', 'index.js']
  );
});

test('ambiguous generated names hide at a package root even when the manifest sorts after them', async () => {
  const root = createTrackedTempDir('jenny-generated-package-root-');
  // Monorepo-style package dir: dist/ + target/ next to a manifest.
  fs.mkdirSync(path.join(root, 'packages', 'app', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'app', 'target'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'app', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'app', 'package.json'), '{}', 'utf8');
  const service = createService(root);

  const listing = await service.listDirectory({ path: 'packages/app' });
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ['lib', 'package.json']
  );

  const shown = await service.listDirectory({ path: 'packages/app', showGenerated: true });
  assert.deepEqual(
    shown.entries.map((entry) => entry.name),
    ['dist', 'lib', 'target', 'package.json']
  );
});

test('generated-directory matching follows platform casing rules', async () => {
  const root = createTrackedTempDir('jenny-generated-casing-');
  fs.mkdirSync(path.join(root, 'BUILD'));
  fs.writeFileSync(path.join(root, 'PACKAGE.JSON'), '{}', 'utf8');
  // win32: case-insensitive — BUILD is ambiguous-generated, PACKAGE.JSON is a
  // manifest, so the directory hides. POSIX: neither name matches.
  assert.deepEqual(
    (await createService(root, 'win32').listDirectory()).entries.map((entry) => entry.name),
    ['PACKAGE.JSON']
  );
  assert.deepEqual(
    (await createService(root, 'linux').listDirectory()).entries.map((entry) => entry.name),
    ['BUILD', 'PACKAGE.JSON']
  );
});
