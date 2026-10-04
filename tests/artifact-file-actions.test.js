'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJennyShellBridge } = require('../services/ipc-contract');
const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');

const artifact = {
  status: 'available',
  artifact_kind: 'image',
  mime_type: 'image/png',
  file_name: 'generated.png',
  absolute_path: path.join(os.tmpdir(), 'resolved-image.png'),
};

function createHarness(overrides = {}) {
  const calls = [];
  const image = { isEmpty: () => false };
  const dependencies = {
    artifactService: {
      async resolveArtifact(...args) {
        calls.push(['resolve', ...args]);
        return artifact;
      },
    },
    dialog: {
      async showSaveDialog(...args) {
        calls.push(['dialog', ...args]);
        return { canceled: false, filePath: 'chosen.png' };
      },
    },
    clipboard: { writeImage: (value) => calls.push(['clipboard', value]) },
    nativeImage: {
      createFromPath(filePath) {
        calls.push(['image', filePath]);
        return image;
      },
    },
    fs: { promises: { copyFile: async (...args) => calls.push(['copy', ...args]) } },
    ...overrides,
  };
  const { createArtifactFileActions } = require('../services/artifact-file-actions');
  return { actions: createArtifactFileActions(dependencies), calls, image, dependencies };
}

test('saveAs copies the resolved file to the selected destination with a live parent window', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jenny-artifact-actions-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.png');
  const destination = path.join(directory, 'saved.png');
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
  await fs.promises.writeFile(source, bytes);
  const win = { isDestroyed: () => false };
  const { actions, calls } = createHarness({
    fs,
    getMainWindow: () => win,
    artifactService: {
      async resolveArtifact(...args) {
        calls.push(['resolve', ...args]);
        return { ...artifact, absolute_path: source };
      },
    },
    dialog: {
      async showSaveDialog(...args) {
        calls.push(['dialog', ...args]);
        return { canceled: false, filePath: destination };
      },
    },
  });
  assert.deepEqual(await actions.saveAs('session-a', 'artifact-a'), { ok: true });
  assert.deepEqual(await fs.promises.readFile(destination), bytes);
  assert.deepEqual(await fs.promises.readFile(source), bytes);
  assert.deepEqual(calls, [
    ['resolve', 'session-a', 'artifact-a'],
    ['dialog', win, {
      defaultPath: 'generated.png', filters: [{ name: 'PNG image', extensions: ['png'] }],
    }],
  ]);
});

test('saveAs cancellation or a missing destination copies nothing', async () => {
  for (const result of [{ canceled: true, filePath: 'ignored.png' }, { canceled: false }]) {
    const { actions, calls } = createHarness({ dialog: { showSaveDialog: async () => result } });
    assert.deepEqual(await actions.saveAs('session-a', 'artifact-a'), { ok: false, canceled: true });
    assert.deepEqual(calls, [['resolve', 'session-a', 'artifact-a']]);
  }
});

test('both actions short-circuit unavailable artifacts before dialog, decoding, or copying', async () => {
  for (const method of ['saveAs', 'copyImage']) {
    const { actions, calls } = createHarness({
      artifactService: { resolveArtifact: async () => ({ ...artifact, status: 'missing' }) },
    });
    assert.deepEqual(await actions[method]('session-a', 'artifact-a'), {
      ok: false, reason: 'artifact_unavailable',
    });
    assert.deepEqual(calls, []);
  }
});

test('saveAs uses PNG MIME filters, other file extensions, or no filters without an extension', async () => {
  for (const [fileName, mimeType, filters] of [
    ['generated.bin', 'image/png', [{ name: 'PNG image', extensions: ['png'] }]],
    ['generated.jpeg', 'image/jpeg', [{ name: 'File', extensions: ['jpeg'] }]],
    ['generated', 'application/octet-stream', undefined],
  ]) {
    const { actions, calls } = createHarness({
      artifactService: {
        resolveArtifact: async () => ({ ...artifact, file_name: fileName, mime_type: mimeType }),
      },
    });
    assert.deepEqual(await actions.saveAs('session-a', 'artifact-a'), { ok: true });
    const options = { defaultPath: fileName };
    if (filters) options.filters = filters;
    assert.deepEqual(calls, [['dialog', options], ['copy', artifact.absolute_path, 'chosen.png']]);
  }
});

test('saveAs uses the unparented dialog overload without a live BrowserWindow', async () => {
  for (const getMainWindow of [undefined, () => null, () => ({ isDestroyed: () => true }), () => ({})]) {
    const { actions, calls } = createHarness({ getMainWindow });
    await actions.saveAs('session-a', 'artifact-a');
    assert.deepEqual(calls[1], ['dialog', {
      defaultPath: 'generated.png', filters: [{ name: 'PNG image', extensions: ['png'] }],
    }]);
  }
});

test('copyImage decodes the resolved image and writes it to the clipboard', async () => {
  const { actions, calls, image } = createHarness();
  assert.deepEqual(await actions.copyImage('session-a', 'artifact-a'), { ok: true });
  assert.deepEqual(calls, [
    ['resolve', 'session-a', 'artifact-a'], ['image', artifact.absolute_path], ['clipboard', image],
  ]);
});

test('copyImage refuses a non-image artifact before decoding', async () => {
  const { actions, calls } = createHarness({
    artifactService: { resolveArtifact: async () => ({ ...artifact, artifact_kind: 'text' }) },
  });
  assert.deepEqual(await actions.copyImage('session-a', 'artifact-a'), { ok: false, reason: 'not_an_image' });
  assert.deepEqual(calls, []);
});

test('copyImage reports empty images without writing the clipboard', async () => {
  const { actions, calls } = createHarness({
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  });
  assert.deepEqual(await actions.copyImage('session-a', 'artifact-a'), { ok: false, reason: 'image_unreadable' });
  assert.deepEqual(calls, [['resolve', 'session-a', 'artifact-a']]);
});

test('both actions propagate the original resolveArtifact rejection without side effects', async () => {
  const error = Object.assign(new Error('Artifact lookup rejected'), { code: 'CMP-ARTIFACT-0001' });
  for (const method of ['saveAs', 'copyImage']) {
    const { actions, calls } = createHarness({
      artifactService: { resolveArtifact: async () => { throw error; } },
    });
    await assert.rejects(actions[method]('session-a', 'artifact-a'), (caught) => caught === error);
    assert.deepEqual(calls, []);
  }
});

test('saveAs reports a copy failure without the paths from the Node error', async () => {
  const error = new Error("EPERM: operation not permitted, copyfile 'C:/scratch/img.png' -> 'D:/out.png'");
  const { actions } = createHarness({ fs: { promises: { copyFile: async () => { throw error; } } } });
  assert.deepEqual(await actions.saveAs('session-a', 'artifact-a'), { ok: false, reason: 'copy_failed' });
});

test('preload artifact actions invoke the registered main handlers with session and artifact IDs', async () => {
  const handlers = new Map();
  const calls = [];
  const image = { isEmpty: () => false };
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle: (channel, handler) => handlers.set(channel, handler) },
    backendService: { chatgptAuthService: {} },
    artifactService: {
      async resolveArtifact(...args) {
        calls.push(['resolve', ...args]);
        return artifact;
      },
    },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    clipboard: { writeImage: (value) => calls.push(['clipboard', value]) },
    nativeImage: { createFromPath: () => image },
  });
  const bridge = createJennyShellBridge({
    ipcRenderer: {
      invoke(channel, ...args) {
        calls.push(['invoke', channel, ...args]);
        return handlers.get(channel)({}, ...args);
      },
    },
  });
  assert.deepEqual(await bridge.artifacts.saveAs('session-a', 'artifact-a'), { ok: false, canceled: true });
  assert.deepEqual(await bridge.artifacts.copyImage('session-a', 'artifact-a'), { ok: true });
  assert.deepEqual(calls, [
    ['invoke', 'artifacts:save-as', 'session-a', 'artifact-a'],
    ['resolve', 'session-a', 'artifact-a'],
    ['invoke', 'artifacts:copy-image', 'session-a', 'artifact-a'],
    ['resolve', 'session-a', 'artifact-a'],
    ['clipboard', image],
  ]);
});
