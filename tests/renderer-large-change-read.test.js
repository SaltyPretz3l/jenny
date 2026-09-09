'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { createHarness, buildChangeTurn, settle } = require('./helpers/renderer-ide-harness');
const { VersionedWorkspaceFileService } = require('../services/versioned-workspace-file-service');

// Exercise the real versioned disk reader behind the IDE harness, rather than
// accepting a mock read that cannot reject a path. UI uses the fallback editor.
for (const entry of ['chat ledger lookup', 'Changes row click']) {
  for (const relativePath of ['large.txt', 'notes/large résumé.txt', 'notes\\large résumé.txt']) {
    test(`${entry}: truncated change reads real file ${relativePath}`, async (t) => {
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
      const harness = createHarness({
        bridgeOptions: { rootPath: root, files: { [normalized]: content } },
        turnViewModels: [buildChangeTurn({ path: relativePath, status: 'created', truncated: true,
          reviewState: 'summary_only', truncationReason: 'line_limit', additions: 20000 })],
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
      harness.state.ui.ide.panelLocations = { ...harness.state.ui.ide.panelLocations, changes: 'primary' };
      harness.state.ui.ide.railPanel = 'changes';
      harness.controller.renderIde();
      await settle();
      const row = harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]');
      assert.ok(row, 'the truncated change remains available for review');
      harness.state.workspaceRoot = normalizeWorkspaceRootState(harness.state.workspaceRoot);
      if (entry === 'chat ledger lookup') {
        // This is the IDE entry called by chat's changeId-based open callback.
        const changeId = row.getAttribute('data-ide-changes-open').slice('root_fake:'.length, -(normalized.length + 1));
        assert.equal(await harness.controller.openLedgerChangeById(changeId), true, JSON.stringify(harness.toasts));
      } else {
        row.dispatchEvent(new harness.dom.window.MouseEvent('click', { bubbles: true }));
      }
      for (let attempt = 0; attempt < 100 && !harness.state.ui.ide.activeTabPath.startsWith('diff://change/'); attempt++) {
        await settle(10);
      }
      assert.match(harness.state.ui.ide.activeTabPath, /^diff:\/\/change\//, JSON.stringify(harness.toasts));
      assert.ok(harness.getDom().ideEditorFallback.value.includes(content), 'current file content is rendered, not just an active IDE');
      assert.deepEqual(harness.toasts, []);
      assert.ok(reads.some((payload) => payload.path === normalized && payload.intent === 'edit'));
    });
  }
}
