'use strict';

const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { linkDirectory } = require('./helpers/platform-skips');
const { WORKSPACE_FS_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { GENERAL_PROJECT_ID } = require('../services/projects/project-schema');
const { getBridgeChannel } = require('../services/ipc-contract');
const { registerWorkspaceFsIpcHandlers } = require('../services/main/workspace-ipc-registration');
const {
  createProjectFilePreviewService,
} = require('../services/project-file-preview-service');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('payload'),
]);

afterEach(cleanupTrackedResources);

function setup(extraProjects = {}, options = {}) {
  const root = createTrackedTempDir('jenny-proj-preview-');
  const projects = {
    project_a: { id: 'project_a', root_path: root },
    project_noroot: { id: 'project_noroot', root_path: '' },
    project_gone: { id: 'project_gone', root_path: path.join(root, 'missing-folder') },
    [GENERAL_PROJECT_ID]: { id: GENERAL_PROJECT_ID, root_path: root },
    ...extraProjects,
  };
  const service = createProjectFilePreviewService({
    projectService: { get: (id) => projects[id] || null },
    ...options,
  });
  return { root, service };
}

function createFakeIpcMain() {
  const invoke = new Map();
  return { handle: (channel, handler) => invoke.set(channel, handler), on() {}, invoke };
}

const invokeChannel = (methodPath) => getBridgeChannel(methodPath, 'invoke');

async function codeOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return null;
}

describe('project file preview: text', () => {
  test('reads a text file inside a registered project', async () => {
    const { root, service } = setup();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'hello \u00e9\nworld');
    const result = await service.readText({ projectId: 'project_a', path: 'src/a.txt', intent: 'preview' });
    assert.deepEqual(result, {
      ok: true, content: 'hello \u00e9\nworld', truncated: false, editable: true,
      size: Buffer.byteLength('hello \u00e9\nworld'), fileVersion: result.fileVersion,
    });
    assert.match(result.fileVersion, /^\d+:\d+$/, 'size:mtime, so a same-size edit is a new version');
  });

  test('truncates at the requested cap without splitting a UTF-8 character', async () => {
    const { root, service } = setup();
    fs.writeFileSync(path.join(root, 'big.txt'), `ab${'\u00e9'.repeat(10)}`);
    const result = await service.readText({ projectId: 'project_a', path: 'big.txt', maxBytes: 5 });
    assert.equal(result.truncated, true);
    assert.equal(result.editable, true);
    assert.equal(result.content, 'ab\u00e9');
    assert.equal(result.size, 22);
  });

  test('the service cap bounds a larger requested maxBytes', async () => {
    const { root, service } = setup({}, { maxReadBytes: 8 });
    fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(20));
    const result = await service.readText({ projectId: 'project_a', path: 'big.txt', maxBytes: 1000 });
    assert.equal(result.content.length, 8);
    assert.equal(result.truncated, true);
  });

  test('binary and non-UTF-8 files come back non-editable and empty', async () => {
    const { root, service } = setup();
    fs.writeFileSync(path.join(root, 'nul.dat'), Buffer.from([0x41, 0x00, 0x42]));
    fs.writeFileSync(path.join(root, 'bad.txt'), Buffer.from([0xff, 0xfe, 0x41, 0x80]));
    for (const name of ['nul.dat', 'bad.txt']) {
      const result = await service.readText({ projectId: 'project_a', path: name });
      assert.deepEqual(result, { ok: true, content: '', editable: false, truncated: false, size: result.size, fileVersion: result.fileVersion });
    }
  });

  test('an invalid maxBytes is refused', async () => {
    const { root, service } = setup();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    assert.equal(
      await codeOf(service.readText({ projectId: 'project_a', path: 'a.txt', maxBytes: -1 })),
      CODES.PATH_INVALID
    );
  });
});

describe('project file preview: images', () => {
  test('reads an image with its mime and base64', async () => {
    const { root, service } = setup();
    fs.writeFileSync(path.join(root, 'logo.PNG'), PNG);
    const result = await service.readImage({ projectId: 'project_a', path: 'logo.PNG' });
    assert.deepEqual(result, {
      ok: true, mime: 'image/png', base64: PNG.toString('base64'), size: PNG.length,
    });
  });

  test('refuses an over-cap image', async () => {
    const { root, service } = setup({}, { maxImageBytes: 16 });
    fs.writeFileSync(path.join(root, 'big.png'), Buffer.concat([PNG, Buffer.alloc(64)]));
    assert.equal(
      await codeOf(service.readImage({ projectId: 'project_a', path: 'big.png' })),
      CODES.IMAGE_TOO_LARGE
    );
  });

  test('refuses a non-image extension and mismatched magic bytes', async () => {
    const { root, service } = setup();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.writeFileSync(path.join(root, 'fake.png'), 'not a png');
    assert.equal(
      await codeOf(service.readImage({ projectId: 'project_a', path: 'a.txt' })),
      CODES.IMAGE_UNSUPPORTED
    );
    assert.equal(
      await codeOf(service.readImage({ projectId: 'project_a', path: 'fake.png' })),
      CODES.IMAGE_UNSUPPORTED
    );
  });
});

describe('project file preview: project resolution', () => {
  test('refuses missing, unknown, General, rootless, and vanished projects', async () => {
    const { root, service } = setup();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    for (const projectId of ['', undefined, 'project_unknown', GENERAL_PROJECT_ID, 'project_noroot', 'project_gone']) {
      assert.equal(
        await codeOf(service.readText({ projectId, path: 'a.txt' })),
        CODES.ROOT_MISSING,
        `text ${String(projectId)}`
      );
      assert.equal(
        await codeOf(service.readImage({ projectId, path: 'a.png' })),
        CODES.ROOT_MISSING,
        `image ${String(projectId)}`
      );
    }
  });

  test('a root that is a file, not a folder, is refused', async () => {
    const { root } = setup();
    const filePath = path.join(root, 'plain.txt');
    fs.writeFileSync(filePath, 'x');
    const svc = createProjectFilePreviewService({
      projectService: { get: () => ({ id: 'project_file', root_path: filePath }) },
    });
    assert.equal(await codeOf(svc.readText({ projectId: 'project_file', path: 'a.txt' })), CODES.ROOT_MISSING);
  });
});

describe('project file preview: path containment', () => {
  test('refuses .. escapes, absolute paths, control characters, and empty paths', async () => {
    const { root, service } = setup();
    fs.writeFileSync(path.join(path.dirname(root), 'outside.txt'), 'secret');
    const outside = path.join(path.dirname(root), 'outside.txt');
    for (const bad of [
      '../outside.txt', 'a/../../outside.txt', outside, '/etc/passwd', 'C:\\Windows\\win.ini',
      'a\u0001b.txt', 'a\nb.txt', '', '   ',
    ]) {
      assert.equal(
        await codeOf(service.readText({ projectId: 'project_a', path: bad })),
        CODES.PATH_INVALID,
        JSON.stringify(bad)
      );
    }
    fs.rmSync(outside, { force: true });
  });

  test('refuses a junction or symlink that escapes the project root', async (t) => {
    const { root, service } = setup();
    const outsideDir = createTrackedTempDir('jenny-proj-outside-');
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
    fs.writeFileSync(path.join(outsideDir, 'secret.png'), PNG);
    try {
      linkDirectory(outsideDir, path.join(root, 'link'));
    } catch (_error) {
      t.skip('platform cannot create a directory link here');
      return;
    }
    assert.equal(
      await codeOf(service.readText({ projectId: 'project_a', path: 'link/secret.txt' })),
      CODES.PATH_OUTSIDE_ROOT
    );
    assert.equal(
      await codeOf(service.readImage({ projectId: 'project_a', path: 'link/secret.png' })),
      CODES.PATH_OUTSIDE_ROOT
    );
  });

  test('a link that stays inside the root is allowed', async (t) => {
    const { root, service } = setup();
    fs.mkdirSync(path.join(root, 'real'));
    fs.writeFileSync(path.join(root, 'real', 'in.txt'), 'inside');
    try {
      linkDirectory(path.join(root, 'real'), path.join(root, 'alias'));
    } catch (_error) {
      t.skip('platform cannot create a directory link here');
      return;
    }
    const result = await service.readText({ projectId: 'project_a', path: 'alias/in.txt' });
    assert.equal(result.content, 'inside');
  });

  test('refuses a directory and reports a missing file', async () => {
    const { root, service } = setup();
    fs.mkdirSync(path.join(root, 'dir'));
    assert.equal(await codeOf(service.readText({ projectId: 'project_a', path: 'dir' })), CODES.NOT_A_FILE);
    assert.equal(await codeOf(service.readImage({ projectId: 'project_a', path: 'dir.png' })), CODES.NOT_FOUND);
    assert.equal(await codeOf(service.readText({ projectId: 'project_a', path: 'nope.txt' })), CODES.NOT_FOUND);
    assert.equal(await codeOf(service.readText({ projectId: 'project_a', path: 'nope/deep.txt' })), CODES.NOT_FOUND);
  });
});

describe('project file preview: IPC envelope', () => {
  test('IPC: project preview handlers use the envelope and fail closed without a service', async () => {
    const ipc = createFakeIpcMain();
    const proxy = {};
    const calls = [];
    registerWorkspaceFsIpcHandlers(ipc, proxy, {
      projectFilePreviewService: {
        async readText(payload) {
          calls.push(['readText', payload]);
          return { content: 'hi', truncated: false, editable: true, size: 2 };
        },
        async readImage(payload) {
          calls.push(['readImage', payload]);
          const error = new Error('Path resolves outside the project folder.');
          error.code = 'CMP-WORKSPACEFS-0003';
          throw error;
        },
      },
    });
    assert.deepEqual(
      await ipc.invoke.get(invokeChannel('workspaceFs.readProjectText'))({}, {
        projectId: 'project_a', path: 'a.txt', intent: 'preview',
      }),
      { ok: true, content: 'hi', truncated: false, editable: true, size: 2 }
    );
    const refused = await ipc.invoke.get(invokeChannel('workspaceFs.readProjectImage'))({}, {
      projectId: 'project_a', path: 'a.png',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.error_code, 'CMP-WORKSPACEFS-0003');
    assert.deepEqual(calls.map(([name]) => name), ['readText', 'readImage']);

    const closedIpc = createFakeIpcMain();
    registerWorkspaceFsIpcHandlers(closedIpc, proxy, {});
    for (const name of ['workspaceFs.readProjectText', 'workspaceFs.readProjectImage']) {
      const result = await closedIpc.invoke.get(invokeChannel(name))({}, { projectId: 'project_a', path: 'a.txt' });
      assert.equal(result.ok, false, name);
      assert.match(result.error_code, /^CMP-WORKSPACEFS-\d{4}$/);
    }
  });
});
