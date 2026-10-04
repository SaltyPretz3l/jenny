'use strict';

// Split view W3-4 (docs/plans/split-view/W3_SPEC_2026-09-26.md §6, decision 1
// variant B): the Explorer stays on the one Workspace folder and shows one
// line under its header when the reference chat works in another project with
// a folder. Reference chat = pane 0's session while the IDE chat dock shows it,
// else the focused chat. The action runs the existing switch-by-project.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeExplorerWiring, resolveExplorerNudge } = require('../renderer/features/renderer-ide-explorer-wiring');
const { createProjectSwitcher } = require('../renderer/features/renderer-project-switcher');
const paneVisibilityUtils = require('../renderer/chat/renderer-pane-visibility-utils');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { buildIdeDom, createBridgeStub, settle } = require('./helpers/ide-tree-harness');

const PROJECTS = [
  { id: 'alpha', name: 'Alpha', root_path: '/w/alpha' },
  { id: 'beta', name: 'Beta <b> & "co"', root_path: '/w/beta' },
  { id: 'gamma', name: 'Gamma', root_path: null },
  { id: 'project_general', name: 'General', root_path: null },
];

const LIST = [
  { id: 'alpha', name: 'Alpha', rootPath: '/w/alpha' },
  { id: 'beta', name: 'Beta', rootPath: '/w/beta' },
  { id: 'gamma', name: 'Gamma', rootPath: '' },
];

function makeState(overrides) {
  return {
    workspaceRoot: { path: '/w/alpha' },
    currentSessionId: 's-beta',
    panes: { panes: [{ sessionId: '' }], focusedPaneId: 0, splitRatio: 0.5 },
    sessions: [
      { id: 's-alpha', project_id: 'alpha' },
      { id: 's-beta', project_id: 'beta' },
      { id: 's-gamma', project_id: 'gamma' },
      { id: 's-blank', project_id: '' },
      { id: 's-general', project_id: 'project_general' },
    ],
    ui: {},
    ...overrides,
  };
}

const stubMenu = { isOpen: () => false, close() {}, show() { return null; }, dispose() {} };

async function createHarness({ state = makeState(), dockFlag = true, dockOpen = false, loadList = true, withSwitcher = true } = {}) {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files: { 'a.txt': 'x' } });
  const ide = ideStateUtils.createIdeUiState();
  ide.chatDockOpen = dockOpen;
  const previousWindow = globalThis.window;
  globalThis.window = domHarness.dom.window;
  const switchCalls = [];
  const logs = [];
  let listResolve = null;
  const switcher = createProjectSwitcher({
    state,
    windowRef: domHarness.dom.window,
    menu: stubMenu,
    paneVisibilityUtils,
    getProjectsApi: () => ({
      list: () => (loadList ? Promise.resolve(PROJECTS) : new Promise((resolve) => { listResolve = resolve; })),
    }),
    workspaceRootService: {
      async switchToProject(projectId, request) {
        switchCalls.push({ projectId, request });
        return { committed: false };
      },
    },
  });
  const switcherDeps = withSwitcher
    ? { getProjectSwitcher: () => switcher, peekProjectSwitcher: () => switcher }
    : {};
  const wiring = createIdeExplorerWiring({
    getDom: domHarness.getDom,
    getIde: () => ide,
    getWorkspaceFsApi: () => bridge.jennyShell.workspaceFs,
    openFile: () => {},
    buildFileContextMenuItems: () => [],
    buildPathUtilityMenuItems: () => [],
    schedulePersist: () => {},
    showShellErrorToast: () => {},
    appendClientLog: (level, event, payload) => logs.push({ level, event, payload }),
    getGitFeature: () => null,
    getFeatureFlags: () => ({ ide_chat_dock: dockFlag }),
    panelDeps: () => ({
      getMountEl: () => domHarness.getDom().ideRailPanel,
      isActivePanel: () => true,
    }),
    ...switcherDeps,
  });
  wiring.bindAll();
  wiring.tree.refreshRoot();
  await settle(30);
  const panel = domHarness.getDom().ideRailPanel;
  return {
    state,
    ide,
    switcher,
    switchCalls,
    logs,
    wiring,
    panel,
    window: domHarness.dom.window,
    resolveList: () => listResolve?.(PROJECTS),
    nudge: () => panel.querySelector('.ide-explorer-project-nudge'),
    dispatch(type) {
      domHarness.dom.window.dispatchEvent(new domHarness.dom.window.CustomEvent(type, { detail: { source: 'switcher' } }));
    },
    observe() {
      const records = [];
      const observer = new domHarness.dom.window.MutationObserver((list) => records.push(...list));
      observer.observe(panel, { childList: true, subtree: true, characterData: true, attributes: true });
      return () => { records.push(...observer.takeRecords()); observer.disconnect(); return records.length; };
    },
    dispose() {
      wiring.disposeAll();
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      domHarness.dom.window.close();
    },
  };
}

test('resolveExplorerNudge: shown only for a listed project with a folder that is not the Workspace project', () => {
  const base = { workspaceProjectId: 'alpha', projects: LIST };
  assert.deepEqual(resolveExplorerNudge({ ...base, sessionProjectId: 'beta' }), { projectId: 'beta', projectName: 'Beta' });
  assert.equal(resolveExplorerNudge({ ...base, sessionProjectId: 'alpha' }), null, 'same project');
  assert.equal(resolveExplorerNudge({ ...base, sessionProjectId: 'gamma' }), null, 'no folder');
  assert.equal(resolveExplorerNudge({ ...base, sessionProjectId: 'project_general' }), null, 'General');
  assert.equal(resolveExplorerNudge({ ...base, sessionProjectId: '' }), null, 'blank = General');
  assert.equal(resolveExplorerNudge({ ...base, sessionProjectId: 'missing' }), null, 'unknown project');
  assert.equal(resolveExplorerNudge({ ...base, sessionProjectId: 'beta', projects: [] }), null, 'list not loaded');
  assert.deepEqual(resolveExplorerNudge({ sessionProjectId: 'beta', workspaceProjectId: '', projects: LIST }),
    { projectId: 'beta', projectName: 'Beta' }, 'a Workspace folder that is no project still nudges');
});

test('the focused chat in another project shows one escaped line under the header with an inventory button', async () => {
  const h = await createHarness();
  try {
    const nudge = h.nudge();
    assert.ok(nudge, 'nudge line rendered');
    assert.equal(nudge.tagName, 'P');
    assert.ok(nudge.previousElementSibling.classList.contains('ide-tree-header'), 'directly under the header');
    assert.equal(nudge.textContent, 'The focused chat is in Beta <b> & "co". Open Beta <b> & "co"');
    assert.equal(nudge.querySelector('b'), null, 'the project name is escaped');
    const button = nudge.querySelector('.ide-explorer-project-nudge-action');
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.dataset.ideProjectId, 'beta');
  } finally {
    h.dispose();
  }
});

for (const [label, sessionId] of [
  ['the matching project', 's-alpha'],
  ['a project without a folder', 's-gamma'],
  ['General (blank project id)', 's-blank'],
  ['General (project_general)', 's-general'],
  ['an unknown session', 's-missing'],
]) {
  test(`absent for ${label}`, async () => {
    const h = await createHarness({ state: makeState({ currentSessionId: sessionId }) });
    try {
      assert.ok(h.panel.querySelector('.ide-tree-header'), 'header rendered');
      assert.equal(h.nudge(), null);
    } finally {
      h.dispose();
    }
  });
}

test('absent until the project list loads, then the list load repaints it in place', async () => {
  const h = await createHarness({ loadList: false });
  try {
    assert.equal(h.nudge(), null, 'not loaded: no nudge');
    const titleButton = h.panel.querySelector('[data-ide-tree-action="project-menu"]');
    h.resolveList();
    await settle(20);
    assert.ok(h.nudge(), 'the first list load shows the nudge');
    assert.equal(h.panel.querySelector('[data-ide-tree-action="project-menu"]'), titleButton, 'the title button stays attached');
  } finally {
    h.dispose();
  }
});

test('absent without a project switcher', async () => {
  const h = await createHarness({ withSwitcher: false });
  try {
    assert.equal(h.nudge(), null);
  } finally {
    h.dispose();
  }
});

test('dock rule: with the IDE chat dock open the reference is pane 0, else the focused pane', async () => {
  const twoPanes = () => makeState({
    currentSessionId: 's-beta',
    panes: { panes: [{ sessionId: 's-alpha' }, { sessionId: 's-beta' }], focusedPaneId: 1, splitRatio: 0.5 },
  });
  const docked = await createHarness({ state: twoPanes(), dockOpen: true });
  try {
    assert.equal(docked.nudge(), null, 'docked pane 0 is in the Workspace project');
    docked.ide.chatDockOpen = false;
    docked.wiring.tree.renderExplorer();
    assert.ok(docked.nudge(), 'dock closed: the focused pane 1 chat is in Beta');
  } finally {
    docked.dispose();
  }
  const flagOff = await createHarness({ state: twoPanes(), dockOpen: true, dockFlag: false });
  try {
    assert.ok(flagOff.nudge(), 'dock flag off: the focused chat decides');
  } finally {
    flagOff.dispose();
  }
  const reversed = makeState({
    currentSessionId: 's-alpha',
    panes: { panes: [{ sessionId: 's-beta' }, { sessionId: 's-alpha' }], focusedPaneId: 1, splitRatio: 0.5 },
  });
  const h = await createHarness({ state: reversed, dockOpen: true });
  try {
    assert.equal(h.nudge()?.querySelector('button').dataset.ideProjectId, 'beta', 'docked pane 0 in Beta nudges');
  } finally {
    h.dispose();
  }
  const onePane = await createHarness({ state: makeState(), dockOpen: true });
  try {
    assert.ok(onePane.nudge(), 'one pane: pane 0 is the focused chat');
  } finally {
    onePane.dispose();
  }
});

test('the action logs once and runs switchToProject with the project id', async () => {
  const h = await createHarness();
  try {
    h.nudge().querySelector('button').click();
    await settle(10);
    assert.deepEqual(h.switchCalls.map((call) => call.projectId), ['beta']);
    const opened = h.logs.filter((entry) => entry.event === 'ide.explorer.project_nudge_open');
    assert.deepEqual(opened, [{ level: 'INFO', event: 'ide.explorer.project_nudge_open', payload: { projectId: 'beta' } }]);
  } finally {
    h.dispose();
  }
});

test('repaint triggers: projects-changed and a root commit update the line in place; an unchanged state writes nothing', async () => {
  const h = await createHarness({ state: makeState({ currentSessionId: 's-alpha' }) });
  try {
    assert.equal(h.nudge(), null);
    const titleButton = h.panel.querySelector('[data-ide-tree-action="project-menu"]');

    // A chat moved to another project (the switcher raises projects-changed).
    h.state.sessions[0].project_id = 'beta';
    h.dispatch('jenny:projects-changed');
    assert.ok(h.nudge(), 'projects-changed repaints the line');
    assert.equal(h.panel.querySelector('[data-ide-tree-action="project-menu"]'), titleButton, 'in place: the title button stays');

    let done = h.observe();
    h.dispatch('jenny:projects-changed');
    assert.equal(done(), 0, 'an unchanged repaint writes nothing');

    // A Workspace root commit onto the chat's project clears it.
    h.state.workspaceRoot.path = '/w/beta';
    h.dispatch('ide:workspace-root-committed');
    assert.equal(h.nudge(), null, 'root commit repaints the line');

    // The render pass (focus change, dock toggle) still agrees with the DOM
    // after an in-place swap, then settles to no writes.
    h.state.workspaceRoot.path = '/w/alpha';
    h.wiring.tree.renderExplorer();
    assert.ok(h.nudge(), 'a render after in-place swaps repaints from state');
    done = h.observe();
    h.wiring.tree.renderExplorer();
    assert.equal(done(), 0, 'an unchanged render does not rewrite the DOM');
  } finally {
    h.dispose();
  }
});

test('a render reflects a focus change and drops the line when the chat moves back', async () => {
  const h = await createHarness({ state: makeState({ currentSessionId: 's-alpha' }) });
  try {
    h.state.currentSessionId = 's-beta';
    h.wiring.tree.renderExplorer();
    assert.ok(h.nudge(), 'focus moved to a Beta chat');
    // In-place removal, then a render back to the SAME state the host key
    // holds must not leave the removed line's DOM stale.
    h.state.currentSessionId = 's-alpha';
    h.dispatch('jenny:projects-changed');
    assert.equal(h.nudge(), null);
    h.state.currentSessionId = 's-beta';
    h.wiring.tree.renderExplorer();
    assert.ok(h.nudge(), 'render repaints after the in-place removal');
  } finally {
    h.dispose();
  }
});

// Owner gate §D open P3: a focus change, a docked-chat switch or a chat moved to
// another project left the line stale until the next full tree render. The pane
// composition raises jenny:focused-chat-changed on those; the header repaints
// in place without a tree render.
test('repaint trigger: jenny:focused-chat-changed updates the line in place without a tree render', async () => {
  const h = await createHarness({ state: makeState({ currentSessionId: 's-alpha' }) });
  try {
    assert.equal(h.nudge(), null);
    const titleButton = h.panel.querySelector('[data-ide-tree-action="project-menu"]');
    h.state.currentSessionId = 's-beta'; // focus / docked chat moved to a Beta chat
    h.dispatch('jenny:focused-chat-changed');
    assert.ok(h.nudge(), 'the focused-chat change repaints the line');
    assert.equal(h.panel.querySelector('[data-ide-tree-action="project-menu"]'), titleButton, 'in place: the title button stays');
    h.state.sessions[1].project_id = 'alpha'; // the chat moved into the Workspace project
    h.dispatch('jenny:focused-chat-changed');
    assert.equal(h.nudge(), null, 'a project move of the reference chat drops the line');
    h.wiring.disposeAll();
    h.state.sessions[1].project_id = 'beta';
    h.dispatch('jenny:focused-chat-changed');
    assert.equal(h.nudge(), null, 'disposed: the listener is gone');
  } finally {
    h.dispose();
  }
});
