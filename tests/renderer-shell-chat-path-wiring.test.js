'use strict';

// Row 95: the shell runtime hands the chat path controller a folder-reveal dep, so a folder chip
// opens the IDE explorer tree (createShellRuntimeController -> createChatPathOpenController).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils');

function captureChatPathDeps(callbacks) {
  let captured = null;
  const windowRef = {
    document: { getElementById: () => null },
    rendererChatPathOpen: {
      createChatPathOpenController(deps) {
        captured = deps;
        return { attach() {} };
      },
    },
  };
  createShellRuntimeController({ state: {}, windowRef, callbacks });
  return captured;
}

test('revealInIdeTree reveals the relative folder in the explorer with expandSelf and resolves true', async () => {
  const revealed = [];
  const deps = captureChatPathDeps({
    revealIdePath: async (relPath, options) => { revealed.push({ relPath, options }); return true; },
  });
  assert.equal(typeof deps.revealInIdeTree, 'function');
  assert.equal(await deps.revealInIdeTree('src/lib'), true);
  assert.deepEqual(revealed, [{ relPath: 'src/lib', options: { expandSelf: true } }]);
});

test('revealInIdeTree resolves false when the IDE declines or is not wired', async () => {
  assert.equal(await captureChatPathDeps({ revealIdePath: async () => false }).revealInIdeTree('src'), false);
  assert.equal(await captureChatPathDeps({}).revealInIdeTree('src'), false);
});

test('project link hooks pass through to the chat path controller and stay absent when unwired', async () => {
  const seen = [];
  const deps = captureChatPathDeps({
    openProjectFileInIde: async (target) => { seen.push(target); return true; },
    getProjectRoots: () => [{ id: 'p1', rootPath: 'D:/notes' }],
  });
  assert.equal(await deps.openProjectFileInIde({ projectId: 'p1', path: 'a.md' }), true);
  assert.deepEqual(seen, [{ projectId: 'p1', path: 'a.md' }]);
  assert.deepEqual(deps.getProjectRoots(), [{ id: 'p1', rootPath: 'D:/notes' }]);
  const bare = captureChatPathDeps({});
  assert.equal(bare.openProjectFileInIde, null);
  assert.equal(bare.getProjectRoots, null);
});

test('the composition builds the project link hooks once and hands them to the shell runtime', () => {
  const composition = fs.readFileSync(path.join(__dirname, '..', 'renderer/app/renderer-app-controller-composition.js'), 'utf8');
  assert.match(composition, /createProjectLinkHooks\?\.\(/);
  assert.match(composition, /openProjectFileInIde: projectLinkHooks\.openProjectFileInIde/);
  assert.match(composition, /getProjectRoots: projectLinkHooks\.getProjectRoots/);
});

test('the reveal handler is threaded through every composition hop', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const registry = read('renderer/shell/renderer-shell-service-registry.js');
  assert.match(registry, /revealIdePathSafe = openIdeAfterLoad\('revealInExplorer'\)/);
  assert.match(registry, /openIdeFileAtLineSafe, openIdeTestOutputSafe[^\n]*revealIdePathSafe/);
  assert.match(read('renderer/app/renderer-app-lifecycle-composition.js'), /openIdeFileAtLineSafe, revealIdePathSafe/);
  assert.match(read('renderer/app.js'), /openIdeFileAtLineSafe, revealIdePathSafe/);
  assert.match(read('renderer/app/renderer-app-controller-composition.js'), /revealIdePath: \(\.\.\.a\) => revealIdePathSafe\(\.\.\.a\)/);
  assert.match(read('renderer/features/renderer-ide-controller.js'), /revealInExplorer: \(path, options\)/);
});

test('index.html loads the shared path rules before the chat path controller', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const shared = html.indexOf('renderer/shared/workspace-path-resolve.js');
  const controller = html.indexOf('renderer/chat/renderer-chat-path-open.js');
  assert.ok(shared > 0 && controller > shared);
});
