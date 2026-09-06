const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createViewPanelRegistry,
  PANEL_DESCRIPTORS,
  AUTO_COLLAPSE_MAX_WIDTH,
} = require('../renderer/shell/renderer-view-panel-registry');

const CONSTANTS = {
  PANEL_STORAGE_KEY: 'jenny.panels.v2',
  SIDEBAR_STORAGE_KEY: 'jenny.sidebar.v1',
  SIDEBAR_MIN_WIDTH: 248,
  SIDEBAR_MAX_WIDTH: 420,
  SIDEBAR_COLLAPSED_WIDTH: 84,
  SIDEBAR_MAIN_STAGE_MIN_WIDTH: 720,
};

function createFakeStorage(initial = {}) {
  const backing = new Map(Object.entries(initial));
  const writes = [];
  return {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => {
      writes.push(key);
      backing.set(key, String(value));
    },
    dump: () => Object.fromEntries(backing.entries()),
    writes: () => [...writes],
  };
}

function createFakeWorkspace({ width = 1400 } = {}) {
  let currentWidth = width;
  const classes = new Set(['workspace', 'view-shell']);
  const styleProps = new Map();
  return {
    classes,
    styleProps,
    classList: {
      toggle: (name, on) => {
        if (on === undefined) {
          on = !classes.has(name);
        }
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    style: {
      setProperty: (name, value) => styleProps.set(name, value),
      getPropertyValue: (name) => styleProps.get(name) || '',
    },
    getBoundingClientRect: () => ({ width: currentWidth }),
    setWidth: (nextWidth) => { currentWidth = nextWidth; },
  };
}

function createRegistry({ storage, workspace, callbacks } = {}) {
  return createViewPanelRegistry({
    dom: { workspace: workspace || createFakeWorkspace() },
    storage: storage || createFakeStorage(),
    constants: CONSTANTS,
    callbacks: callbacks || {},
  });
}

test('descriptor lookup: chat declares the only panel, the rest are full-bleed', () => {
  const registry = createRegistry({});
  assert.equal(registry.getPanelDescriptor('chat').panel, 'chat-sessions');
  assert.equal(registry.getPanelDescriptor('chat').collapsible, true);
  // Workspace is full-bleed: the IDE owns its internal explorer rail; the
  // dockable workspace-files host is the follow-on that restores a panel here.
  assert.equal(registry.getPanelDescriptor('ide').panel, null);
  assert.equal(registry.getPanelDescriptor('home').panel, null);
  assert.equal(registry.getPanelDescriptor('logs').panel, null);
  assert.equal(registry.getPanelDescriptor('settings').panel, null);
  assert.equal(registry.getPanelDescriptor('not-a-view').panel, null);
  assert.equal(PANEL_DESCRIPTORS.artifacts.panel, null);
});

test('first load seeds v2 state from legacy jenny.sidebar.v1 and leaves v1 in place', () => {
  const storage = createFakeStorage({
    'jenny.sidebar.v1': JSON.stringify({ width: 352, collapsed: true }),
  });
  const registry = createRegistry({ storage });

  const chatState = registry.getViewPanelState('chat');
  assert.equal(chatState.width, 352, 'chat inherits the legacy sidebar width');
  assert.equal(chatState.collapsed, true, 'chat inherits the legacy collapsed flag');
  assert.equal(chatState.dock, 'left');

  const persisted = JSON.parse(storage.dump()['jenny.panels.v2']);
  assert.equal(persisted.version, 2);
  assert.equal(persisted.byView.chat.width, 352);
  assert.equal(persisted.byView.ide, undefined, 'panel-less ide does not seed an entry');
  assert.ok(storage.dump()['jenny.sidebar.v1'], 'legacy v1 key stays for rollback');
  assert.deepEqual(storage.writes(), ['jenny.panels.v2'], 'migration writes only the v2 registry key');
});

test('existing v2 state wins over legacy and survives a reload round-trip', () => {
  const storage = createFakeStorage({
    'jenny.sidebar.v1': JSON.stringify({ width: 300, collapsed: false }),
    'jenny.panels.v2': JSON.stringify({
      version: 2,
      byView: { chat: { width: 400, collapsed: true, dock: 'left' } },
    }),
  });
  const registry = createRegistry({ storage });
  assert.equal(registry.getViewPanelState('chat').width, 400, 'v2 state is authoritative');

  const reloaded = createRegistry({ storage });
  assert.equal(reloaded.getViewPanelState('chat').collapsed, true);
});

test('same-version unknown panel preferences survive known-panel writes', () => {
  const futurePanel = {
    width: 377,
    collapsed: true,
    dock: 'right',
    custom: { layout: 'future' },
  };
  const storage = createFakeStorage({
    'jenny.panels.v2': JSON.stringify({
      version: 2,
      byView: {
        chat: { width: 320, collapsed: false, dock: 'left' },
        future_panel: futurePanel,
      },
    }),
  });
  const registry = createRegistry({ storage });
  registry.setPanelCollapsed('chat', true, { apply: false });
  const persisted = JSON.parse(storage.dump()['jenny.panels.v2']);
  assert.deepEqual(persisted.byView.future_panel, futurePanel);
  assert.equal(persisted.byView.chat.collapsed, true);
});

test('unknown panel ids are preserved as data without mutating object prototypes', () => {
  const byView = Object.fromEntries([
    ['chat', { width: 320, collapsed: false, dock: 'left' }],
    ['__proto__', { custom: 'future' }],
  ]);
  const storage = createFakeStorage({
    'jenny.panels.v2': JSON.stringify({ version: 2, byView }),
  });
  const registry = createRegistry({ storage });
  registry.setPanelCollapsed('chat', true, { apply: false });
  const persisted = JSON.parse(storage.dump()['jenny.panels.v2']);
  assert.deepEqual(persisted.byView.__proto__, { custom: 'future' });
  assert.equal(Object.prototype.custom, undefined);
});

test('malformed, blank, fractional, negative, and oversized stored widths degrade safely', () => {
  for (const invalidWidth of [null, '', 319.5, -10, Number.NaN]) {
    const storage = createFakeStorage({
      'jenny.panels.v2': JSON.stringify({
        version: 2,
        byView: { chat: { width: invalidWidth, collapsed: false, dock: 'left' } },
      }),
    });
    assert.equal(createRegistry({ storage }).getViewPanelState('chat').width, 320);
  }

  const oversized = createFakeStorage({
    'jenny.panels.v2': JSON.stringify({
      version: 2,
      byView: { chat: { width: 9999, collapsed: false, dock: 'left' } },
    }),
  });
  assert.equal(createRegistry({ storage: oversized }).getViewPanelState('chat').width, 420);
});

test('setPanelWidth clamps to bounds derived from workspace width and persists', () => {
  const storage = createFakeStorage();
  const workspace = createFakeWorkspace({ width: 1400 });
  const registry = createRegistry({ storage, workspace });

  registry.setPanelWidth('chat', 9999);
  assert.equal(registry.getViewPanelState('chat').width, 420, 'clamped to SIDEBAR_MAX_WIDTH');

  registry.setPanelWidth('chat', 10);
  assert.equal(registry.getViewPanelState('chat').width, 248, 'clamped to SIDEBAR_MIN_WIDTH');

  const persisted = JSON.parse(storage.dump()['jenny.panels.v2']);
  assert.equal(persisted.byView.chat.width, 248);

  registry.setPanelWidth('home', 300);
  assert.equal(
    JSON.parse(storage.dump()['jenny.panels.v2']).byView.home,
    undefined,
    'panel-less views ignore width writes'
  );
});

test('setPanelWidth rounds fractional live values before persistence and reload', () => {
  const storage = createFakeStorage();
  const registry = createRegistry({ storage });
  registry.setPanelWidth('chat', 351.5, { apply: false });
  assert.equal(registry.getViewPanelState('chat').width, 352);
  assert.equal(JSON.parse(storage.dump()['jenny.panels.v2']).byView.chat.width, 352);
  assert.equal(createRegistry({ storage }).getViewPanelState('chat').width, 352);
});

test('narrow workspaces shrink the max bound to protect the main stage', () => {
  const workspace = createFakeWorkspace({ width: 1000 });
  const registry = createRegistry({ workspace });
  const bounds = registry.getPanelWidthBounds('chat');
  assert.equal(bounds.max, 280, 'max = workspaceWidth - SIDEBAR_MAIN_STAGE_MIN_WIDTH');
  registry.setPanelWidth('chat', 419);
  assert.equal(registry.getViewPanelState('chat').width, 280);
});

test('collapse round-trip applies the strip width and class, then restores', () => {
  const workspace = createFakeWorkspace();
  const registry = createRegistry({ workspace });

  registry.setPanelCollapsed('chat', true);
  let applied = registry.applyPanelForView('chat');
  assert.equal(applied.collapsed, true);
  assert.equal(applied.currentWidth, 84);
  assert.equal(workspace.classList.contains('panel-collapsed'), true);
  assert.equal(workspace.style.getPropertyValue('--view-panel-current-width'), '84px');
  assert.equal(workspace.style.getPropertyValue('--sidebar-current-width'), '84px');

  registry.togglePanelCollapsed('chat');
  applied = registry.applyPanelForView('chat');
  assert.equal(applied.collapsed, false);
  assert.equal(applied.currentWidth, 320);
  assert.equal(workspace.classList.contains('panel-collapsed'), false);

  registry.setPanelCollapsed('home', true);
  assert.equal(registry.getViewPanelState('home').collapsed, false, 'non-collapsible views ignore collapse');
});

test('phone-width workspaces auto-collapse without mutating the persisted preference', () => {
  const storage = createFakeStorage();
  const workspace = createFakeWorkspace({ width: AUTO_COLLAPSE_MAX_WIDTH });
  const registry = createRegistry({ storage, workspace });

  const applied = registry.applyPanelForView('chat');
  assert.equal(applied.autoCollapsed, true);
  assert.equal(applied.collapsed, true);
  assert.equal(applied.currentWidth, 84);
  assert.equal(workspace.classList.contains('panel-collapsed'), true);
  assert.equal(registry.getViewPanelState('chat').collapsed, false, 'responsive collapse is not persisted');

  const persisted = JSON.parse(storage.dump()['jenny.panels.v2']);
  assert.equal(persisted.byView.chat.collapsed, false);
});

test('an explicit narrow-width expansion overrides auto-collapse only for the current runtime', () => {
  const storage = createFakeStorage();
  const workspace = createFakeWorkspace({ width: AUTO_COLLAPSE_MAX_WIDTH });
  const registry = createRegistry({ storage, workspace });
  assert.equal(registry.applyPanelForView('chat').autoCollapsed, true);

  registry.setPanelCollapsed('chat', false);
  const expanded = registry.applyPanelForView('chat');
  assert.equal(expanded.autoCollapsed, false);
  assert.equal(expanded.collapsed, false);

  workspace.setWidth(860);
  registry.applyPanelForView('chat');
  workspace.setWidth(AUTO_COLLAPSE_MAX_WIDTH);
  assert.equal(registry.applyPanelForView('chat').autoCollapsed, true, 'the transient override resets after leaving the narrow layout');
  assert.equal(JSON.parse(storage.dump()['jenny.panels.v2']).byView.chat.collapsed, false);
});

test('panel-none views zero the column and report hasPanel=false to onLayoutChanged', () => {
  const workspace = createFakeWorkspace();
  const layoutEvents = [];
  const registry = createRegistry({
    workspace,
    callbacks: {
      onLayoutChanged: (payload) => layoutEvents.push(payload),
      updateComposerSafeOffset: () => layoutEvents.push({ composerSync: true }),
    },
  });

  const applied = registry.applyPanelForView('home');
  assert.equal(applied.hasPanel, false);
  assert.equal(applied.currentWidth, 0);
  assert.equal(workspace.classList.contains('panel-none'), true);
  assert.equal(workspace.style.getPropertyValue('--view-panel-current-width'), '0px');

  const layoutPayload = layoutEvents.find((entry) => entry.viewId === 'home');
  assert.ok(layoutPayload, 'onLayoutChanged fires with the view id');
  assert.equal(layoutPayload.hasPanel, false);
  assert.equal(layoutPayload.sidebarVisible, false, 'legacy payload field stays present');
  assert.ok(layoutEvents.some((entry) => entry.composerSync), 'composer safe-offset resyncs');

  registry.applyPanelForView('chat');
  assert.equal(workspace.classList.contains('panel-none'), false, 'panel views clear panel-none');
});

test('corrupt storage fails open to defaults and logs a warning', () => {
  const warnings = [];
  const storage = {
    getItem: () => {
      throw new Error('storage exploded');
    },
    setItem: () => {},
  };
  const registry = createRegistry({
    storage,
    callbacks: {
      appendClientLog: (level, eventName) => warnings.push(`${level}:${eventName}`),
    },
  });
  const chatState = registry.getViewPanelState('chat');
  assert.equal(chatState.width, 320, 'falls back to the descriptor default');
  assert.ok(
    warnings.some((entry) => entry === 'WARN:viewpanel.preferences_read_failed'),
    'read failure is logged'
  );
});

test('falls open to a no-op backend when no storage is injected (no window.localStorage)', () => {
  // Previously `deps.storage || window.localStorage` threw at construction when
  // window was absent; resolveDefaultStorage must degrade to a no-op instead.
  let registry;
  assert.doesNotThrow(() => {
    registry = createViewPanelRegistry({
      dom: { workspace: createFakeWorkspace() },
      constants: CONSTANTS,
      callbacks: {},
    });
  });
  let panelState;
  assert.doesNotThrow(() => { panelState = registry.loadPanelState(); }, 'reads degrade to defaults via the no-op backend');
  assert.equal(panelState.version, 2, 'no-op backend seeds a valid v2 state schema');
  assert.equal(registry.getViewPanelState('chat').width, 320, 'chat falls back to its descriptor default width');
});

test('falls open when window.localStorage access throws (storage disabled)', () => {
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const originalWindow = global.window;
  global.window = { get localStorage() { throw new Error('SecurityError: storage disabled'); } };
  let registryUnderTest;
  try {
    assert.doesNotThrow(() => {
      registryUnderTest = createViewPanelRegistry({
        dom: { workspace: createFakeWorkspace() },
        constants: CONSTANTS,
        callbacks: {},
      });
      registryUnderTest.loadPanelState();
    });
    assert.equal(registryUnderTest.getViewPanelState('chat').width, 320, 'chat defaults to descriptor width even when localStorage is inaccessible');
  } finally {
    if (hadWindow) { global.window = originalWindow; } else { delete global.window; }
  }
});
