'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { createHarness, buildChangeTurn, settle } = require('./helpers/renderer-ide-harness');
const { buildJennyChangeLedgerFromTurnViewModels } = require('../renderer/chat/renderer-jenny-change-ledger');
const { VersionedWorkspaceFileService } = require('../services/versioned-workspace-file-service');

// Exercise the real versioned disk reader behind the IDE harness, rather than
// accepting a mock read that cannot reject a path. UI uses the fallback editor.
// Jenny's Changes left the IDE rail in row 34 S5 (its rows now live in the chat
// dock's Changes tab, which opens through the same diffController.openChangeDiff),
// so the changeId-based ledger lookup is the IDE entry exercised here.
for (const relativePath of ['large.txt', 'notes/large résumé.txt', 'notes\\large résumé.txt']) {
  test(`chat ledger lookup: truncated change reads real file ${relativePath}`, async (t) => {
    const root = createTrackedTempDir('jenny-large-change-');
    t.after(() => cleanupTrackedResources());
    const normalized = relativePath.replace(/\\/g, '/');
    const content = 'A long changed line with enough content to exceed inline diff budgets.\n'.repeat(20000);
    await fs.mkdir(path.dirname(path.join(root, normalized)), { recursive: true });
    await fs.writeFile(path.join(root, normalized), content);
    const context = Object.freeze({ rootPath: root, rootId: 'root_fake', generation: 1, phase: 'ready' });
    const rootContext = {
      captureContext: () => context,
      isCurrent: (value) => value === context,
      acquireOperation: () => ({ acquired: true, context, isCurrent: () => true, release() {} }),
    };
    const service = new VersionedWorkspaceFileService({ rootContext });
    const turnViewModels = [buildChangeTurn({ path: relativePath, status: 'created', truncated: true,
      reviewState: 'summary_only', truncationReason: 'line_limit', additions: 20000 })];
    const harness = createHarness({
      bridgeOptions: { rootPath: root, files: { [normalized]: content } },
      turnViewModels,
    });
    t.after(() => { harness.dispose(); harness.dom.window.close(); });
    const reads = [];
    harness.bridge.jennyShell.workspaceFs.readText = async (payload) => {
      reads.push(payload);
      return { ok: true, ...await service.readText(payload) };
    };
    // Settings rendering normalizes this shared state before a later diff click.
    const { normalizeWorkspaceRootState } = require('../renderer/shell/renderer-settings-support');
    await harness.controller.activateIde();
    await settle();
    const ledger = buildJennyChangeLedgerFromTurnViewModels(turnViewModels, {
      sessionId: String(harness.state.currentSessionId || ''),
      workspaceId: String(harness.state.workspaceRoot?.rootId || ''),
    });
    const change = ledger.changes.find((entry) => entry.path === normalized);
    assert.ok(change?.changeId, 'the truncated change remains available for review');
    harness.state.workspaceRoot = normalizeWorkspaceRootState(harness.state.workspaceRoot);
    // This is the IDE entry called by chat's changeId-based open callback.
    assert.equal(await harness.controller.openLedgerChangeById(change.changeId), true, JSON.stringify(harness.toasts));
    for (let attempt = 0; attempt < 100 && !harness.state.ui.ide.activeTabPath.startsWith('diff://change/'); attempt++) {
      await settle(10);
    }
    assert.match(harness.state.ui.ide.activeTabPath, /^diff:\/\/change\//, JSON.stringify(harness.toasts));
    assert.ok(harness.getDom().ideEditorFallback.value.includes(content), 'current file content is rendered, not just an active IDE');
    assert.deepEqual(harness.toasts, []);
    assert.ok(reads.some((payload) => payload.path === normalized && payload.intent === 'edit'));
  });
}
