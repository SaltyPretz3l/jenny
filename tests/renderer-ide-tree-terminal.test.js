'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  buildTerminalCdCommand,
  createIdeExplorerWiring,
} = require('../renderer/features/renderer-ide-explorer-wiring');

function createHarness({ qolEnabled = true, terminalAvailable = true, rootContext } = {}) {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.getElementById('host');
  const calls = [];
  const terminalPanel = terminalAvailable ? {
    sendCommand(builder) {
      // The session cwd is deliberately STALE ('/stale-session'): after a
      // workspace-root switch the live root must win, never the session cwd.
      calls.push(`send:${builder('bash', '/stale-session')}`);
      return Promise.resolve(true);
    },
  } : null;
  const context = rootContext === undefined
    ? { rootPath: '/workspace', rootId: 'root-a', generation: 1, phase: 'ready' }
    : rootContext;
  const ide = { openTabs: [], expandedDirs: new Set(), railPanel: 'explorer' };
  const wiring = createIdeExplorerWiring({
    getDom: () => ({ ideRailPanel: host, ideSecondarySidebarPanel: null }),
    getIde: () => ide,
    getWorkspaceFsApi: () => null,
    openFile() {},
    buildFileContextMenuItems: () => [],
    buildPathUtilityMenuItems: () => [
      { separator: true },
      { label: 'Copy Path', action() {} },
    ],
    schedulePersist() {},
    getWorkspaceRootApi: () => ({ captureContext: async () => context }),
    showShellErrorToast() {},
    appendClientLog() {},
    panelDeps: () => ({ getMountEl: () => host, isActivePanel: () => true }),
    getFileLifecycle: () => null,
    getSearchPanel: () => null,
    getCloseOrchestrator: () => null,
    getConfirmDialog: () => null,
    getGitFeature: () => null,
    getFeatureFlags: () => ({ workspace_explorer_qol: qolEnabled }),
    getTerminalPanel: () => terminalPanel,
    getBottomPanel: () => ({ open: (view) => calls.push(`open:${view}`) }),
  });
  wiring.tree.bindEvents();

  function show(kind) {
    host.innerHTML = kind === 'root'
      ? '<div class="ide-tree"></div>'
      : `<div class="ide-tree"><div data-ide-tree-path="src${kind === 'file' ? '/app.js' : ''}" data-ide-tree-kind="${kind}"></div></div>`;
    const target = kind === 'root'
      ? host.querySelector('.ide-tree')
      : host.querySelector('[data-ide-tree-path]');
    target.dispatchEvent(new dom.window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 10, clientY: 20,
    }));
    return [...dom.window.document.querySelectorAll('.inv-context-menu-item')];
  }

  return {
    calls,
    dispose() { wiring.disposeAll(); dom.window.close(); },
    menu(kind) {
      return show(kind).map((item) => ({
        element: item,
        label: item.querySelector('span')?.textContent || '',
      }));
    },
  };
}

async function clickMenuItem(menu, label) {
  const item = menu.find((entry) => entry.label === label);
  assert.ok(item, `${label} is present`);
  item.element.click();
  // openInTerminal resolves the live root context asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('directory menu opens the terminal at the LIVE root, not the session cwd', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const menu = harness.menu('directory');
  const labels = menu.map((item) => item.label);
  assert.ok(labels.indexOf('Find in Folder') < labels.indexOf('Open in Terminal'));
  assert.ok(labels.indexOf('Open in Terminal') < labels.indexOf('Copy Path'));
  await clickMenuItem(menu, 'Open in Terminal');
  assert.deepEqual(harness.calls, ['open:terminal', "send:cd '/workspace/src'"]);
});

test('root menu opens the terminal at the workspace root after Collapse All', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const menu = harness.menu('root');
  const labels = menu.map((item) => item.label);
  assert.ok(labels.indexOf('Collapse All') < labels.indexOf('Open in Terminal'));
  await clickMenuItem(menu, 'Open in Terminal');
  assert.deepEqual(harness.calls, ['open:terminal', "send:cd '/workspace'"]);
});

test('a transitioning or pathless root context sends no terminal command', async (t) => {
  const harness = createHarness({
    rootContext: { rootPath: '/workspace', rootId: 'root-a', generation: 2, phase: 'transitioning' },
  });
  t.after(() => harness.dispose());
  await clickMenuItem(harness.menu('directory'), 'Open in Terminal');
  assert.deepEqual(harness.calls, []);
});

test('file rows, flag-off menus, and unavailable terminals omit Open in Terminal', (t) => {
  const fileHarness = createHarness();
  const flagOffHarness = createHarness({ qolEnabled: false });
  const unavailableHarness = createHarness({ terminalAvailable: false });
  t.after(() => { fileHarness.dispose(); flagOffHarness.dispose(); unavailableHarness.dispose(); });
  assert.equal(fileHarness.menu('file').some((item) => item.label === 'Open in Terminal'), false);
  assert.equal(flagOffHarness.menu('directory').some((item) => item.label === 'Open in Terminal'), false);
  assert.equal(unavailableHarness.menu('directory').some((item) => item.label === 'Open in Terminal'), false);
});

test('terminal cd command quotes powershell, cmd, and POSIX paths safely', () => {
  assert.equal(buildTerminalCdCommand('pwsh.exe', "C:/O'Brien", 'src'),
    "Set-Location -LiteralPath 'C:/O''Brien/src'");
  assert.equal(buildTerminalCdCommand('bash', "/tmp/O'Brien", 'src'), "cd '/tmp/O'\\''Brien/src'");
  assert.equal(buildTerminalCdCommand('C:/Windows/System32/cmd.exe', 'C:/Work', 'src'), 'cd /d "C:/Work/src"');
  assert.equal(buildTerminalCdCommand('powershell', 'C:/Work', '$(evil)/`tick`'),
    "Set-Location -LiteralPath 'C:/Work/$(evil)/`tick`'");
  // -LiteralPath keeps [] literal (plain Set-Location wildcard-matches them).
  assert.equal(buildTerminalCdCommand('powershell', 'C:/Work', 'src[1]'),
    "Set-Location -LiteralPath 'C:/Work/src[1]'");
  assert.equal(buildTerminalCdCommand('zsh', '/work', '$(evil)/`tick`'), "cd '/work/$(evil)/`tick`'");
});
