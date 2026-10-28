'use strict';

// The shell config `memory` section (memory v2, row 58 W1): three global
// switches, normalized on load and merged by updateFeatureSettings with reason
// memory_settings_updated.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService, normalizeState } = require('../services/shell-config-service');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('shell config memory section defaults the v2 switches and drops the retired captureSuggestions', () => {
  const defaults = { takeNotes: true, askBeforeSaving: false, pauseSaving: false, useInChats: true };
  assert.deepEqual(normalizeState({ version: 40 }).memory, defaults);
  for (const stored of [{ captureSuggestions: false }, { captureSuggestions: true }, null, 'x', []]) {
    assert.deepEqual(normalizeState({ version: 41, memory: stored }).memory, defaults);
  }
  for (const malformed of [null, 0, 'true', [], {}]) {
    const normalized = normalizeState({ memory: { takeNotes: malformed, askBeforeSaving: malformed, pauseSaving: malformed, useInChats: malformed } });
    assert.deepEqual(normalized.memory, { takeNotes: true, askBeforeSaving: false, pauseSaving: false, useInChats: true });
  }
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-memory-v2-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  const reasons = [];
  service.on('changed', (_snapshot, meta) => { reasons.push(meta?.reason); });
  const next = service.updateFeatureSettings({ memory: { pauseSaving: true, useInChats: false, captureSuggestions: false } });
  assert.deepEqual(next.memory, { takeNotes: true, askBeforeSaving: false, pauseSaving: true, useInChats: false });
  assert.deepEqual(reasons, ['memory_settings_updated']);
  service.updateFeatureSettings({ memory: { pauseSaving: true } });
  assert.deepEqual(reasons, ['memory_settings_updated'], 'an unchanged section writes nothing');
  assert.deepEqual(new ShellConfigService({ userDataPath, env: {} }).getState().memory,
    { takeNotes: true, askBeforeSaving: false, pauseSaving: true, useInChats: false });
});

test('"Jenny takes notes automatically" defaults on and persists only an explicit false', () => {
  for (const stored of [undefined, null, 'false', 0, {}]) {
    assert.equal(normalizeState({ memory: { takeNotes: stored } }).memory.takeNotes, true);
  }
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-take-notes-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  assert.equal(service.updateFeatureSettings({ memory: { takeNotes: false } }).memory.takeNotes, false);
  assert.equal(new ShellConfigService({ userDataPath, env: {} }).getState().memory.takeNotes, false);
});

test('takeNotesSince is stamped main-side when notes turn back on and only kept as a valid ISO instant', () => {
  for (const stored of ['2026-10-15T10:00:00Z', '2026-10-15T10:00:00.000Z']) {
    assert.equal(normalizeState({ memory: { takeNotes: true, takeNotesSince: stored } }).memory.takeNotesSince,
      '2026-10-15T10:00:00.000Z');
  }
  for (const stored of ['yesterday', '2026-10-15', 1760522400000, '2026-13-40T99:00:00Z', null]) {
    assert.equal(Object.hasOwn(normalizeState({ memory: { takeNotesSince: stored } }).memory, 'takeNotesSince'), false, String(stored));
  }
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-notes-since-'));
  trackDirectory(userDataPath);
  let now = new Date('2026-10-15T09:00:00.000Z');
  const service = new ShellConfigService({ userDataPath, env: {}, nowProvider: () => now });
  assert.equal(Object.hasOwn(service.updateFeatureSettings({ memory: { pauseSaving: true } }).memory, 'takeNotesSince'), false,
    'never stamped while notes stay on');
  service.updateFeatureSettings({ memory: { takeNotes: false, takeNotesSince: '2020-01-01T00:00:00.000Z' } });
  assert.equal(Object.hasOwn(service.getState().memory, 'takeNotesSince'), false, 'the renderer cannot set it');
  now = new Date('2026-10-15T10:00:00.000Z');
  assert.equal(service.updateFeatureSettings({ memory: { takeNotes: true } }).memory.takeNotesSince, '2026-10-15T10:00:00.000Z');
  now = new Date('2026-10-15T11:00:00.000Z');
  service.updateFeatureSettings({ memory: { takeNotes: true, askBeforeSaving: true } });
  assert.equal(service.getState().memory.takeNotesSince, '2026-10-15T10:00:00.000Z', 'untouched while notes stay on');
  service.updateFeatureSettings({ memory: { takeNotes: false } });
  assert.equal(service.getState().memory.takeNotesSince, '2026-10-15T10:00:00.000Z', 'untouched when notes turn off');
  assert.equal(new ShellConfigService({ userDataPath, env: {} }).getState().memory.takeNotesSince, '2026-10-15T10:00:00.000Z');
});

test('a non-boolean memory switch is rejected, not coerced, and nothing is written', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-memory-invalid-'));
  trackDirectory(userDataPath);
  const reasons = [];
  const service = new ShellConfigService({ userDataPath, env: {} });
  service.on('changed', (_state, context) => reasons.push(context.reason));
  for (const bad of ['false', 0, null, {}, 'true']) {
    assert.throws(() => service.updateFeatureSettings({ memory: { takeNotes: bad } }), /invalid/i, String(bad));
    assert.throws(() => service.updateFeatureSettings({ memory: { pauseSaving: bad } }), /invalid/i, String(bad));
  }
  assert.deepEqual(reasons, []);
  assert.deepEqual(service.getState().memory,
    { takeNotes: true, askBeforeSaving: false, pauseSaving: false, useInChats: true });
  assert.equal(service.updateFeatureSettings({ memory: { takeNotes: false } }).memory.takeNotes, false);
});
