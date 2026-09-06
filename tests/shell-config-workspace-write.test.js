'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONFIG_VERSION,
  ShellConfigService,
} = require('../services/shell-config-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('debounced workspace state writes retry with bounded backoff and persist the latest IDE revision', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-retry-'));
  trackDirectory(userDataPath);
  const pending = [];
  const delays = [];
  const service = new ShellConfigService({
    userDataPath,
    workspaceWriteDelayMs: 10,
    workspaceWriteRetryLimit: 3,
    workspaceWriteRetryMaxDelayMs: 100,
    setTimeoutImpl(callback, delay) {
      const timer = { callback, unref() {} };
      pending.push(timer);
      delays.push(delay);
      return timer;
    },
    clearTimeoutImpl(timer) {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
  });
  const originalWrite = service.store.write.bind(service.store);
  let attempts = 0;
  service.store.write = (value) => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('temporary lock'), { code: 'EBUSY' });
    originalWrite(value);
  };

  const rootId = 'root_000000000000000000000000';
  service.updateWorkspaceIdeState(rootId, { openTabs: ['latest.txt'], activeTabPath: 'latest.txt' });
  for (let turn = 0; turn < 10 && pending.length; turn += 1) pending.shift().callback();

  assert.equal(attempts, 3);
  assert.equal(pending.length, 0);
  assert.deepEqual(delays, [10, 20, 40]);
  assert.equal(service._workspaceWriteDirty, false);
  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getWorkspaceIdeState(rootId).activeTabPath, 'latest.txt');
});

test('workspace IDE preference acknowledgement is durable and includes pending root state', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-pref-durable-'));
  trackDirectory(userDataPath);
  const pending = [];
  const service = new ShellConfigService({
    userDataPath,
    workspaceWriteDelayMs: 10,
    setTimeoutImpl(callback) {
      const timer = { callback, unref() {} };
      pending.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
  });

  const rootId = 'root_000000000000000000000001';
  service.updateWorkspaceIdeState(rootId, { openTabs: ['pending.txt'], activeTabPath: 'pending.txt' });
  assert.equal(service._workspaceWriteDirty, true);
  const outcome = service.tryUpdateWorkspaceIdePreferences({ fontSize: 19 });

  assert.equal(outcome.updated, true);
  assert.equal(outcome.changed, true);
  assert.equal(service._workspaceWriteDirty, false);
  assert.equal(pending.length, 0);
  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getWorkspaceIdeStore().preferences.fontSize, 19);
  assert.equal(reloaded.getWorkspaceIdeState(rootId).activeTabPath, 'pending.txt');
});

test('failed workspace IDE preference persistence does not project or orphan a pending root retry', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-pref-failure-'));
  trackDirectory(userDataPath);
  const pending = [];
  const service = new ShellConfigService({
    userDataPath,
    workspaceWriteDelayMs: 10,
    setTimeoutImpl(callback) {
      const timer = { callback, unref() {} };
      pending.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
  });
  const rootId = 'root_000000000000000000000002';
  service.updateWorkspaceIdeState(rootId, { openTabs: ['pending.txt'], activeTabPath: 'pending.txt' });
  const timer = pending[0];
  const previousFontSize = service.getWorkspaceIdeStore().preferences.fontSize;
  const originalWrite = service.store.write.bind(service.store);
  service.store.write = () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); };

  const outcome = service.tryUpdateWorkspaceIdePreferences({ fontSize: 21 });

  assert.equal(outcome.updated, false);
  assert.equal(outcome.code, 'config_write_failed');
  assert.equal(service.getWorkspaceIdeStore().preferences.fontSize, previousFontSize);
  assert.equal(service.getWorkspaceIdeState(rootId).activeTabPath, 'pending.txt');
  assert.equal(service._workspaceWriteDirty, true);
  assert.equal(pending.length, 1);
  assert.equal(pending[0], timer);

  service.store.write = originalWrite;
  pending.shift().callback();
  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getWorkspaceIdeStore().preferences.fontSize, previousFontSize);
  assert.equal(reloaded.getWorkspaceIdeState(rootId).activeTabPath, 'pending.txt');
});

test('failed acknowledged Home write preserves an unrelated pending workspace retry', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-home-failure-'));
  trackDirectory(userDataPath);
  const pending = [];
  const service = new ShellConfigService({
    userDataPath,
    workspaceWriteDelayMs: 10,
    setTimeoutImpl(callback) {
      const timer = { callback, unref() {} };
      pending.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
  });
  const rootId = 'root_000000000000000000000003';
  service.updateWorkspaceIdeState(rootId, { openTabs: ['pending.txt'], activeTabPath: 'pending.txt' });
  const timer = pending[0];
  const originalWrite = service.store.write.bind(service.store);
  service.store.write = () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); };

  assert.throws(() => service.updateHomeConfig({ showContextualTips: false }), /locked/);
  assert.equal(service.getHomeConfig().showContextualTips, true);
  assert.equal(service._workspaceWriteDirty, true);
  assert.equal(pending.length, 1);
  assert.equal(pending[0], timer);

  service.store.write = originalWrite;
  pending.shift().callback();
  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getWorkspaceIdeState(rootId).activeTabPath, 'pending.txt');
  assert.equal(reloaded.getHomeConfig().showContextualTips, true);
});

test('workspace IDE normalization drop diagnostics expose counts without root ids or paths', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-drops-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  const invalidRoot = 'private-workspace-path';
  fs.writeFileSync(configPath, JSON.stringify({
    version: CONFIG_VERSION,
    workspaceIde: {
      preferences: {},
      rootLru: [invalidRoot],
      roots: { [invalidRoot]: { openTabs: ['secret.txt'] } },
    },
  }));
  const logs = [];

  new ShellConfigService({
    userDataPath,
    logger(level, event, details) { logs.push({ level, event, details }); },
  });

  const diagnostic = logs.find((entry) => entry.event === 'shell_config.workspace_ide_entries_dropped');
  assert.equal(diagnostic.level, 'WARN');
  assert.ok(diagnostic.details.counts.invalid_or_missing_root_id >= 1);
  assert.equal(JSON.stringify(diagnostic).includes(invalidRoot), false);
  assert.equal(JSON.stringify(diagnostic).includes('secret.txt'), false);
});
