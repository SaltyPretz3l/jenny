'use strict';

// new-test-file: the outside-files IPC surface (row 137) is a new domain module; ipc-contract.test.js sits at its line cap.
// A closed descriptor list, one trusted-sender handler per invoke method, and
// grant ids as the only addressing: no handler accepts or returns a raw path.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { JENNY_SHELL_BRIDGE_DESCRIPTORS, getBridgeChannel } = require('../services/ipc-contract');
const OUTSIDE_DESCRIPTORS = require('../services/ipc-contract/descriptors-outside-files');
const { registerOutsideFileIpc } = require('../services/main/outside-files/outside-file-ipc');

const INVOKE = ['takePending', 'readText', 'writeText', 'readImage', 'setOpenSet', 'reveal', 'attach', 'pick'];
const SUBSCRIBE = { onRequest: 'outside-files:request', onChange: 'outside-files:changed' };

function kebab(name) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, handler) => handlers.set(channel, handler) };
}

test('the outside-files descriptor list is closed and composed into the bridge', () => {
  const expected = [...INVOKE.map((name) => `outsideFiles.${name}`), ...Object.keys(SUBSCRIBE).map((name) => `outsideFiles.${name}`)];
  assert.deepEqual(Object.keys(OUTSIDE_DESCRIPTORS), expected);
  for (const name of INVOKE) {
    assert.equal(getBridgeChannel(`outsideFiles.${name}`, 'invoke'), `outside-files:${kebab(name)}`);
  }
  for (const [name, channel] of Object.entries(SUBSCRIBE)) {
    assert.equal(getBridgeChannel(`outsideFiles.${name}`, 'subscribe'), channel);
  }
  assert.ok(Object.keys(JENNY_SHELL_BRIDGE_DESCRIPTORS).includes('outsideFiles.readText'));
});

test('every invoke method is registered under the trusted-sender authorizer', async () => {
  const ipcMain = fakeIpcMain();
  let allow = false;
  const { service } = registerOutsideFileIpc(ipcMain, {
    app: { getPath: () => '' },
    workspaceAuthorization: { authorize: () => allow, unauthorizedResult: () => ({ ok: false, authorized: false }) },
  });
  t_after(() => service.dispose());
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), INVOKE.map((name) => `outside-files:${kebab(name)}`).sort());
  const denied = await ipcMain.handlers.get('outside-files:read-text')({}, { id: 'o000000000000000000000000' });
  assert.deepEqual(denied, { ok: false, authorized: false });
  allow = true;
  const unknown = await ipcMain.handlers.get('outside-files:read-text')({}, { id: 'C:\\Windows\\win.ini' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'CMP-WORKSPACEFS-0017', 'a path is not a grant id');
});

test('a file reaches the renderer only as a grant; reading it needs that id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-outside-ipc-'));
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, '# ok');
  const ipcMain = fakeIpcMain();
  const { service } = registerOutsideFileIpc(ipcMain, {
    app: { getPath: () => '' },
    workspaceAuthorization: { authorize: () => true },
  });
  try {
    await service.intake([file]);
    const pending = await ipcMain.handlers.get('outside-files:take-pending')({});
    const [item] = pending.requests[0].items;
    assert.equal(item.kind, 'outside');
    const read = await ipcMain.handlers.get('outside-files:read-text')({}, { id: item.id });
    assert.equal(read.ok, true);
    assert.equal(read.content, '# ok');
    assert.ok(!('realPath' in read) && !('path' in read));
  } finally {
    service.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const cleanups = [];
function t_after(fn) { cleanups.push(fn); }
test.after(() => { for (const fn of cleanups) fn(); });
