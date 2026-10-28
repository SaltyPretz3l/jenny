'use strict';

/* Row 82 slice T2, renderer half: the default shell preference
 * (workspaceIde.terminalDefaultProfile, '' = platform default) in both normalizers,
 * the Settings > Editor select fed by workspacePty.listProfiles, the PTY panel's
 * profileId/cwd spawn fields (absent unless set, so the default payload is
 * unchanged; Restart reuses them), and the terminal set passing them through
 * newTerminal({ start, cwd, profileId }). Explorer "Open in Terminal" lives in
 * renderer-ide-tree-terminal.test.js. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers/renderer-ide-harness');
const { fakeTerminal, fakeFit, fakePtyApi } = require('./helpers/pty-terminal-panel-fixture');
const { createIdePtyTerminalPanel } = require('../renderer/features/renderer-ide-pty-terminal-panel');
const { createIdeTerminalSet } = require('../renderer/features/renderer-ide-terminal-set');
const model = require('../renderer/shared/workbench-layout-model');
const ideState = require('../renderer/features/renderer-ide-state');
const { normalizeWorkspaceIde } = require('../services/workspace-ide-config-schema');
const { withGlobalsAsync, makeContainer, flush } = require('./helpers/settings-editor-section-harness');

test('terminalDefaultProfile normalizes to a profile-id shape or the default in main and the renderer', () => {
  assert.equal(normalizeWorkspaceIde({}).terminalDefaultProfile, '');
  assert.equal(normalizeWorkspaceIde({ terminalDefaultProfile: 'git-bash' }).terminalDefaultProfile, 'git-bash');
  for (const bad of ['C:\\Windows\\cmd.exe', 'PWSH', 'a b', 42, null, 'x'.repeat(33)]) {
    assert.equal(normalizeWorkspaceIde({ terminalDefaultProfile: bad }).terminalDefaultProfile, '', String(bad));
  }
  const ide = ideState.createIdeUiState();
  ideState.applyPersistedState(ide, { terminalDefaultProfile: 'pwsh' });
  assert.equal(ide.terminalDefaultProfile, 'pwsh');
  ideState.applyPersistedState(ide, { terminalDefaultProfile: '/bin/sh' });
  assert.equal(ide.terminalDefaultProfile, '');
});

function buildPanel(harness, { ide = {}, api } = {}) {
  const win = harness.dom.window;
  const mount = win.document.createElement('div');
  win.document.body.appendChild(mount);
  const ptyApi = api || fakePtyApi({ ok: true, sessionId: 'pty-2', shell: 'bash.exe', cwd: 'C:/ws/src', slot: 2 });
  const panel = createIdePtyTerminalPanel({
    getDom: () => ({}),
    getIde: () => ide,
    getMountEl: () => mount,
    isActivePanel: () => true,
    getWorkspacePtyApi: () => ptyApi,
    createTerminal: () => fakeTerminal(),
    createFitAddon: () => fakeFit(),
    windowRef: win,
    slot: 2,
  });
  return { panel, api: ptyApi };
}

test('the panel sends the Settings shell, a per-start cwd and profile, and Restart reuses them', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());

  const plain = buildPanel(harness, { ide: { terminalDefaultProfile: 'git-bash' } });
  await plain.panel.startSession();
  assert.deepEqual(plain.api.calls.spawn[0], { cols: 80, rows: 24, slot: 2, profileId: 'git-bash' });

  const scoped = buildPanel(harness, { ide: { terminalDefaultProfile: 'git-bash' } });
  await scoped.panel.startSession({ cwd: 'src/app', profileId: 'cmd' });
  assert.deepEqual(scoped.api.calls.spawn[0], { cols: 80, rows: 24, slot: 2, profileId: 'cmd', cwd: 'src/app' });
  // Restart (and a later Start) calls startSession() with no options: the panel keeps them.
  await scoped.panel.stopSession();
  await scoped.panel.startSession();
  assert.deepEqual(scoped.api.calls.spawn[1], { cols: 80, rows: 24, slot: 2, profileId: 'cmd', cwd: 'src/app' }, 'a restart keeps the start folder and shell');
});

test('a refused start folder surfaces CMP-TERMINAL-0005 as a start failure', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const api = fakePtyApi({ ok: false, code: 'CMP-TERMINAL-0005', reason: 'path_outside_workspace', message: 'The terminal can only start in a folder inside the workspace.' });
  const { panel } = buildPanel(harness, { api });
  assert.equal(await panel.startSession({ cwd: '../outside' }), false);
  assert.equal(panel.getSessionId(), '');
});

test('newTerminal({ start, cwd, profileId }) hands the start folder and shell to the new panel', () => {
  const starts = [];
  const views = ['terminal'];
  const set = createIdeTerminalSet({
    ptyTerminalPanelUtils: {
      createIdePtyTerminalPanel: (deps) => ({
        getSessionId: () => '',
        getSlot: () => deps.slot,
        isRunning: () => false,
        startSession: (opts) => { starts.push({ slot: deps.slot, opts }); return Promise.resolve(true); },
        dispose() {},
        renderTerminalPanel() {},
        bindEvents() {},
      }),
    },
    baseDeps: { getWorkspacePtyApi: () => ({ onData: () => () => {} }) },
    viewDeps: () => ({ getMountEl: () => null, isActivePanel: () => true }),
    listTerminalViews: () => views.slice(),
    addTerminalView: (id) => views.push(id),
    removeTerminalView: () => {},
    revealView: () => {},
    model,
  });
  set.newTerminal({ start: true });
  set.newTerminal({ start: true, cwd: 'src', profileId: 'pwsh' });
  set.newTerminal({ cwd: 'docs' });
  assert.deepEqual(starts, [
    { slot: 2, opts: undefined },
    { slot: 3, opts: { cwd: 'src', profileId: 'pwsh' } },
  ], 'a terminal not asked to start stays unstarted (the consent posture)');
});

test('Settings > Editor lists the detected shells once, keeping a stored id that is not detected', async () => {
  // Fresh module instance: the profile list is fetched once per renderer.
  const sectionPath = require.resolve('../renderer/shell/renderer-settings-editor-section');
  delete require.cache[sectionPath];
  const editorSection = require(sectionPath);
  let listCalls = 0;
  const previous = globalThis.jennyShell;
  globalThis.jennyShell = {
    workspacePty: {
      listProfiles: async () => {
        listCalls += 1;
        return { ok: true, profiles: [{ id: 'powershell', label: 'Windows PowerShell' }, { id: 'git-bash', label: 'Git Bash' }], defaultId: 'powershell' };
      },
    },
  };
  try {
    await withGlobalsAsync(async () => {
      const { container } = makeContainer();
      const ide = { terminalDefaultProfile: 'wsl' };
      editorSection.renderEditorSection({ container, ide });
      const values = () => [...container.querySelectorAll('#editorTerminalProfileSelect option')].map((o) => o.value);
      assert.deepEqual(values(), ['', 'wsl'], 'before the list arrives: Default plus the stored id');
      await flush();
      await flush();
      assert.deepEqual(values(), ['', 'powershell', 'git-bash', 'wsl']);
      assert.equal(container.querySelector('#editorTerminalProfileSelect').value, 'wsl');
      editorSection.renderEditorSection({ container, ide });
      assert.equal(listCalls, 1);
    });
  } finally {
    globalThis.jennyShell = previous;
    delete require.cache[sectionPath];
  }
});
