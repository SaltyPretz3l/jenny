'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ShellConfigService } = require('../services/shell-config-service');

const DAMAGED_BYTES = '{"version": 52, "uiLanguage": "fr", "chatUi": {';

function makeUserData(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-corrupt-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  return userDataPath;
}

function createService(userDataPath) {
  const logs = [];
  const service = new ShellConfigService({
    userDataPath,
    logger: (level, event, data) => logs.push({ level, event, data }),
  });
  return { service, logs };
}

function preservedCopies(userDataPath) {
  return fs.readdirSync(userDataPath).filter((name) => name.startsWith('shell-config.json.corrupt-'));
}

function blockCorruptRename(t) {
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).includes('.corrupt-')) {
      const error = new Error('EACCES: permission denied, rename');
      error.code = 'EACCES';
      throw error;
    }
    return realRename(from, to);
  };
  t.after(() => { fs.renameSync = realRename; });
}

for (const [label, bytes] of [
  ['unparseable JSON', DAMAGED_BYTES],
  ['a top-level array', '[]'],
]) {
  test(`a damaged shell config (${label}) is preserved and never overwritten`, (t) => {
    const userDataPath = makeUserData(t);
    const configPath = path.join(userDataPath, 'shell-config.json');
    fs.writeFileSync(configPath, bytes, 'utf8');

    const { service, logs } = createService(userDataPath);
    assert.equal(service.isFreshInstall(), false);
    service.updateUiLanguage('es');

    const copies = preservedCopies(userDataPath);
    assert.equal(copies.length, 1);
    assert.equal(fs.readFileSync(path.join(userDataPath, copies[0]), 'utf8'), bytes);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(written.uiLanguage, 'es');
    assert.equal(service.getState().uiLanguage, 'es');

    const detected = logs.filter((entry) => entry.event === 'shell_config.corrupt_state_detected');
    assert.equal(detected.length, 1);
    assert.equal(detected[0].level, 'ERROR');
    assert.equal(detected[0].data.fileName, 'shell-config.json');
    assert.equal(detected[0].data.preserved, true);
    assert.equal(detected[0].data.preservedName, copies[0]);
    assert.equal(JSON.stringify(detected[0].data).includes('"fr"'), false);
  });
}

test('a damaged shell config that cannot be preserved blocks every write', (t) => {
  const userDataPath = makeUserData(t);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, DAMAGED_BYTES, 'utf8');
  blockCorruptRename(t);

  const { service, logs } = createService(userDataPath);
  assert.equal(service.isFreshInstall(), false);
  service.updateUiLanguage('es');
  service.updateUiLanguage('de');

  assert.equal(fs.readFileSync(configPath, 'utf8'), DAMAGED_BYTES);
  assert.deepEqual(preservedCopies(userDataPath), []);
  const detected = logs.filter((entry) => entry.event === 'shell_config.corrupt_state_detected');
  assert.equal(detected.length, 1);
  assert.equal(detected[0].data.preserved, false);
  assert.equal(detected[0].data.reason, 'EACCES');
  const blocked = logs.filter((entry) => entry.event === 'shell_config.corrupt_write_blocked');
  assert.equal(blocked.length, 1);
});

test('a missing shell config is still a fresh install and writes normally', (t) => {
  const userDataPath = makeUserData(t);
  const { service, logs } = createService(userDataPath);

  assert.equal(service.isFreshInstall(), true);
  service.updateUiLanguage('es');

  const written = JSON.parse(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8'));
  assert.equal(written.uiLanguage, 'es');
  assert.deepEqual(preservedCopies(userDataPath), []);
  assert.equal(logs.some((entry) => entry.event === 'shell_config.corrupt_state_detected'), false);
});

test('a settings file that cannot be read is left in place and never overwritten', (t) => {
  const userDataPath = makeUserData(t);
  const filePath = path.join(userDataPath, 'shell-config.json');
  const healthy = JSON.stringify({ version: 1, uiLanguage: 'fr' });
  fs.writeFileSync(filePath, healthy, 'utf8');
  const realRead = fs.readFileSync;
  fs.readFileSync = (target, ...rest) => {
    if (String(target) === filePath) {
      throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' });
    }
    return realRead(target, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });

  const { service, logs } = createService(userDataPath);
  service.updateUiLanguage('es');
  fs.readFileSync = realRead;

  assert.equal(service.isFreshInstall(), false);
  assert.deepEqual(preservedCopies(userDataPath), []);
  assert.equal(fs.readFileSync(filePath, 'utf8'), healthy);
  const detected = logs.find((entry) => entry.event === 'shell_config.corrupt_state_detected');
  assert.equal(detected.data.reason, 'unreadable');
  assert.equal(detected.data.errorCode, 'EBUSY');
});
