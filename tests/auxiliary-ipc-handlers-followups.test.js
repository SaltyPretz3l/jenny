'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const { getBridgeChannel } = require('../services/ipc-contract');
const { ShellConfigService } = require('../services/shell-config-service');

// Only the follow-up handlers are exercised; the other services are inert stubs.
function registerMinimalHandlers(overrides = {}) {
  const handlers = new Map();
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle(channel, handler) { handlers.set(channel, handler); } },
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload: () => ({}),
    shellConfigService: { getState: () => ({}) },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions: () => [],
    offlineIntelligenceService: {},
    dialog: {},
    getMainWindow: () => null,
    chooseWorkspaceRoot: async () => null,
    clearWorkspaceRoot: () => null,
    prepareAttachmentEntries: () => ({ accepted: [], rejected: [] }),
    attachmentAssetStore: null,
    processRef: { cwd: () => process.cwd() },
    os: {},
    isChildPath: () => false,
    clipboard: { writeText() {} },
    log: () => null,
    getMainLifecycle: () => null,
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
    ...overrides,
  });
  return handlers;
}

test('companion follow-up mutations reject a stale id with the not-found code; delete stays idempotent', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-aux-ipc-followup-'));
  try {
    const shellConfigService = new ShellConfigService({
      userDataPath,
      nowProvider: () => new Date('2026-03-19T15:00:00.000Z'),
    });
    shellConfigService.upsertFollowUp({ id: 'followup-1', label: 'Present', status: 'active' });
    const handlers = registerMinimalHandlers({
      shellConfigService,
      companionService: { getState: () => ({ ok: true }) },
      personalityWorkspace: {},
    });
    const calls = [
      ['companion.updateFollowUp', ['gone', { label: 'x' }]],
      ['companion.deferFollowUp', ['gone', 'tomorrow']],
      ['companion.activateFollowUp', ['gone']],
      ['companion.resolveFollowUp', ['gone']],
      ['companion.archiveFollowUp', ['gone']],
      ['companion.unarchiveFollowUp', ['gone']],
    ];
    for (const [method, args] of calls) {
      await assert.rejects(
        async () => handlers.get(getBridgeChannel(method, 'invoke'))({}, ...args),
        (error) => error.code === 'CMP-COMPANION-0002'
          && error.message.startsWith('CMP-COMPANION-0002: '),
        method
      );
    }
    const before = JSON.stringify(shellConfigService.getState().followUps);
    assert.deepEqual(
      await handlers.get(getBridgeChannel('companion.deleteFollowUp', 'invoke'))({}, 'gone'),
      { ok: true }
    );
    assert.deepEqual(
      await handlers.get(getBridgeChannel('companion.resolveFollowUp', 'invoke'))({}, 'followup-1'),
      { ok: true }
    );
    assert.notEqual(JSON.stringify(shellConfigService.getState().followUps), before);
    assert.equal(shellConfigService.getState().followUps[0].status, 'resolved');
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('companion.updateFollowUp keeps only renderer-editable fields and drops non-editable statuses', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-aux-ipc-followup-patch-'));
  try {
    const shellConfigService = new ShellConfigService({
      userDataPath,
      nowProvider: () => new Date('2026-03-19T15:00:00.000Z'),
    });
    shellConfigService.upsertFollowUp({
      id: 'followup-1',
      label: 'Present',
      status: 'active',
      sessionId: 'session-1',
      sourceMeta: { sessionTitle: 'Origin' },
    });
    const original = shellConfigService.getState().followUps[0];
    const handlers = registerMinimalHandlers({
      shellConfigService,
      companionService: { getState: () => ({ ok: true }) },
    });
    const update = handlers.get(getBridgeChannel('companion.updateFollowUp', 'invoke'));

    await update({}, 'followup-1', {
      label: 'Renamed',
      status: 'resolved',
      resolved: true,
      resolvedAt: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
      sessionId: 'hijacked',
      sourceMeta: { sessionTitle: 'Forged' },
      sourceKind: 'agent_task',
      history: [{ kind: 'resolved', at: '2020-01-01T00:00:00.000Z', detail: 'forged' }],
    });
    let record = shellConfigService.getState().followUps[0];
    assert.equal(record.label, 'Renamed');
    assert.equal(record.status, 'active');
    assert.equal(record.resolvedAt, '');
    assert.equal(record.createdAt, original.createdAt);
    assert.equal(record.sessionId, 'session-1');
    assert.equal(record.sourceKind, original.sourceKind);
    assert.deepEqual(record.sourceMeta, original.sourceMeta);
    assert.equal(record.history.some((entry) => entry.detail === 'forged'), false);
    assert.equal(record.history[0].kind, 'edited');

    await update({}, 'followup-1', { status: 'deferred', deferPreset: 'tomorrow' });
    record = shellConfigService.getState().followUps[0];
    assert.equal(record.status, 'deferred');
    assert.equal(record.deferPreset, 'tomorrow');
    assert.ok(record.deferredUntil);
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
