'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CONFIG_VERSION,
  DEFAULT_WORKSPACE_IDE,
  normalizeWorkspaceIde,
  normalizeState,
  serializeState,
} = require('../services/shell-config-state');
const {
  normalizeWorkspaceIdeStore,
  touchWorkspaceIdeRoot,
  updateWorkspaceIdeStore,
  workspaceIdeStateForRoot,
} = require('../services/workspace-ide-config-schema');
const { workspaceRootId } = require('../services/workspace-root-identity');

const TEST_WORKSPACE_ROOT = 'C:/dev/workspace-ide-config-test';

function ideState(state) {
  return workspaceIdeStateForRoot(
    state.workspaceIde,
    workspaceRootId(state.toolsWorkspaceRoot) || ''
  );
}

function rootId(index) {
  return `root_${String(index).padStart(24, '0')}`;
}

function tenRootStore() {
  let store = { preferences: {}, roots: {}, rootLru: [] };
  for (let index = 1; index <= 10; index += 1) {
    store = updateWorkspaceIdeStore(store, rootId(index), { openTabs: [`${index}.txt`] });
  }
  return store;
}

test('normalizeWorkspaceIdeStore does not report accepted ids repeated by roots', () => {
  const ids = [rootId(3), rootId(1), rootId(2)];
  const roots = Object.fromEntries(ids.map((id) => [id, {}]));
  const drops = [];

  const normalized = normalizeWorkspaceIdeStore(
    { preferences: {}, rootLru: ids, roots },
    { onDrop: (...args) => drops.push(args) }
  );

  assert.deepEqual(drops, []);
  assert.deepEqual(normalized.rootLru, ids);
  assert.deepEqual(Object.keys(normalized.roots), ids);
});

test('normalizeWorkspaceIdeStore reports one invalid root id without dropping valid ids', () => {
  const ids = [rootId(2), rootId(1)];
  const roots = Object.fromEntries(ids.map((id) => [id, {}]));
  const drops = [];

  const normalized = normalizeWorkspaceIdeStore(
    { preferences: {}, rootLru: [ids[0], 'not-a-root', ids[1]], roots },
    { onDrop: (...args) => drops.push(args) }
  );

  assert.deepEqual(drops, [['invalid_or_missing_root_id']]);
  assert.deepEqual(normalized.rootLru, ids);
});

test('normalizeWorkspaceIdeStore counts a malformed root once even when doubly referenced', () => {
  const id = rootId(1);
  const drops = [];

  normalizeWorkspaceIdeStore(
    { preferences: {}, rootLru: [id], roots: { [id]: 'not-an-object' } },
    { onDrop: (...args) => drops.push(args) }
  );

  assert.deepEqual(drops, [['malformed_root_state']]);
});

test('normalizeWorkspaceIdeStore still reports overflow and malformed root state', () => {
  const ids = Array.from({ length: 12 }, (_, index) => rootId(index + 1));
  const roots = Object.fromEntries(ids.map((id) => [id, {}]));
  roots[rootId(99)] = null;
  const drops = [];

  const normalized = normalizeWorkspaceIdeStore(
    { preferences: {}, rootLru: ids.slice(0, 6), roots },
    { onDrop: (...args) => drops.push(args) }
  );

  assert.deepEqual(drops, [
    ['malformed_root_state'],
    ['root_lru_overflow', 2],
  ]);
  assert.deepEqual(normalized.rootLru, ids.slice(0, 10));
});

test('runtime IDE store updates return evicted root ids without changing the legacy return shape', () => {
  const store = tenRootStore();
  const outcome = updateWorkspaceIdeStore(
    store,
    rootId(11),
    { openTabs: ['11.txt'] },
    { includeEvictions: true }
  );
  assert.deepEqual(outcome.evictedRootIds, [rootId(1)]);
  assert.equal(outcome.store.rootLru[0], rootId(11));
  assert.deepEqual(
    updateWorkspaceIdeStore(outcome.store, rootId(11), {}, { includeEvictions: true }).evictedRootIds,
    []
  );
  assert.ok(Array.isArray(updateWorkspaceIdeStore(store, rootId(11), {}).rootLru));
});

test('runtime IDE root touches return evicted ids and an empty list when no eviction occurs', () => {
  const store = tenRootStore();
  const outcome = touchWorkspaceIdeRoot(store, rootId(11), { includeEvictions: true });
  assert.deepEqual(outcome.evictedRootIds, [rootId(1)]);
  assert.equal(outcome.store.rootLru[0], rootId(11));
  assert.deepEqual(
    touchWorkspaceIdeRoot(outcome.store, rootId(11), { includeEvictions: true }).evictedRootIds,
    []
  );
  assert.ok(Array.isArray(touchWorkspaceIdeRoot(store, rootId(11)).rootLru));
});

test('normalizeWorkspaceIde applies defaults and clamps', () => {
  assert.deepEqual(normalizeWorkspaceIde(undefined), {
    openTabs: [],
    activeTabPath: '',
    expandedDirs: [],
    // Editor-stage surface + preview target (additive, no CONFIG_VERSION bump).
    activeStageSurface: 'editor',
    previewPath: '',
    replaceJournal: null,
    railPanel: 'explorer',
    railSide: 'left',
    railWidth: 300,
    bottomPanelOpen: false,
    bottomPanelHeight: 220,
    bottomPanelActiveView: 'terminal',
    secondaryPanelOpen: false,
    secondaryPanel: 'changes',
    secondaryWidth: 260,
    chatDockOpen: false,
    chatDockSide: 'right',
    chatDockWidth: 380,
    panelLocations: {
      explorer: 'primary',
      search: 'primary',
      changes: 'secondary',
      'source-control': 'secondary',
    },
    showGenerated: false,
    explorerSortMode: 'name',
    wordWrap: 'off',
    fontSize: 13,
    tabSize: 2,
    minimap: true,
    lineNumbers: 'on',
    renderWhitespace: 'selection',
    eol: '',
    inlineSuggestEnabled: true,
    inlineSuggestModel: '',
    autoSaveEnabled: false,
    formatOnSave: false,
    trimTrailingWhitespace: false,
    insertFinalNewline: false,
    rulers: [],
  });
  // save-time hygiene: all DEFAULT-OFF (only a literal true enables).
  for (const key of ['formatOnSave', 'trimTrailingWhitespace', 'insertFinalNewline']) {
    assert.equal(normalizeWorkspaceIde({ [key]: true })[key], true);
    assert.equal(normalizeWorkspaceIde({ [key]: 'yes' })[key], false);
    assert.equal(normalizeWorkspaceIde(undefined)[key], false);
  }
  // auto-save: DEFAULT-OFF (writes files) — only a literal true enables it, the
  // inverse of the default-on minimap/inlineSuggestEnabled toggles.
  assert.equal(normalizeWorkspaceIde({ autoSaveEnabled: true }).autoSaveEnabled, true);
  assert.equal(normalizeWorkspaceIde({ autoSaveEnabled: false }).autoSaveEnabled, false);
  assert.equal(normalizeWorkspaceIde({ autoSaveEnabled: 'yes' }).autoSaveEnabled, false);
  assert.equal(normalizeWorkspaceIde({ autoSaveEnabled: 1 }).autoSaveEnabled, false);
  assert.equal(normalizeWorkspaceIde(undefined).autoSaveEnabled, false);
  assert.equal(normalizeWorkspaceIde({ showGenerated: true }).showGenerated, true);
  assert.equal(normalizeWorkspaceIde({ showGenerated: 'yes' }).showGenerated, false);
  assert.equal(normalizeWorkspaceIde({ explorerSortMode: 'type' }).explorerSortMode, 'type');
  assert.equal(normalizeWorkspaceIde({ explorerSortMode: 'garbage' }).explorerSortMode, 'name');
  // column rulers: dedupe + sort + drop out-of-range; garbage -> []; bounded count.
  assert.deepEqual(normalizeWorkspaceIde({ rulers: [120, 80, 80] }).rulers, [80, 120]);
  assert.deepEqual(normalizeWorkspaceIde({ rulers: [-1, 0, 600, 'x', 100] }).rulers, [100]);
  assert.deepEqual(normalizeWorkspaceIde({ rulers: 'nope' }).rulers, []);
  assert.deepEqual(normalizeWorkspaceIde({ rulers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }).rulers.length, 8);
  // inline autocomplete: enabled default-on (only literal false disables), model
  // is a sanitized Ollama tag ('' when unset/invalid); compute placement is not persisted.
  assert.equal(normalizeWorkspaceIde({ inlineSuggestEnabled: false }).inlineSuggestEnabled, false);
  assert.equal(normalizeWorkspaceIde({ inlineSuggestEnabled: 'no' }).inlineSuggestEnabled, true);
  assert.equal('inlineSuggestUseGpu' in normalizeWorkspaceIde({ inlineSuggestUseGpu: true }), false);
  assert.equal(
    normalizeWorkspaceIde({ inlineSuggestModel: 'qwen2.5-coder:1.5b-base' }).inlineSuggestModel,
    'qwen2.5-coder:1.5b-base'
  );
  assert.equal(
    normalizeWorkspaceIde({ inlineSuggestModel: 'JetBrains/Mellum-4b-sft-all:latest' }).inlineSuggestModel,
    'JetBrains/Mellum-4b-sft-all:latest'
  );
  // reject control chars / shell metacharacters / leading separators.
  assert.equal(normalizeWorkspaceIde({ inlineSuggestModel: 'bad model;rm -rf' }).inlineSuggestModel, '');
  assert.equal(normalizeWorkspaceIde({ inlineSuggestModel: '/leading-slash' }).inlineSuggestModel, '');
  assert.equal(normalizeWorkspaceIde({ inlineSuggestModel: 'has\u0000nul' }).inlineSuggestModel, '');
  assert.equal(normalizeWorkspaceIde({ inlineSuggestModel: 'x'.repeat(201) }).inlineSuggestModel, '');
  // bottom panel: open only on literal true; height clamps; view enum.
  assert.equal(normalizeWorkspaceIde({ bottomPanelOpen: true }).bottomPanelOpen, true);
  assert.equal(normalizeWorkspaceIde({ bottomPanelOpen: 'yes' }).bottomPanelOpen, false);
  assert.equal(normalizeWorkspaceIde({ bottomPanelHeight: 320 }).bottomPanelHeight, 320);
  assert.equal(normalizeWorkspaceIde({ bottomPanelHeight: 9999 }).bottomPanelHeight, 600);
  assert.equal(normalizeWorkspaceIde({ bottomPanelHeight: 10 }).bottomPanelHeight, 80);
  assert.equal(normalizeWorkspaceIde({ bottomPanelHeight: 'tall' }).bottomPanelHeight, 220);
  assert.equal(normalizeWorkspaceIde({ bottomPanelActiveView: 'problems' }).bottomPanelActiveView, 'problems');
  assert.equal(normalizeWorkspaceIde({ bottomPanelActiveView: 'run' }).bottomPanelActiveView, 'run');
  // S18/Wave C: the Test Runner bottom-panel view is an accepted value (additive,
  // forward-validated — no CONFIG_VERSION bump; default 'terminal' stays valid).
  assert.equal(normalizeWorkspaceIde({ bottomPanelActiveView: 'test-runner' }).bottomPanelActiveView, 'test-runner');
  assert.equal(normalizeWorkspaceIde({ bottomPanelActiveView: 'bogus' }).bottomPanelActiveView, 'terminal');
  // secondary sidebar: secondaryPanel is the ACTIVE panel among the secondary-
  // located ids, cross-validated against panelLocations. By default Changes +
  // Source Control home there, so an explicit secondaryPanelOpen:true sticks, and
  // an active id that isn't secondary-located recomputes to the first secondary
  // panel ('changes').
  assert.equal(normalizeWorkspaceIde({ secondaryPanelOpen: true }).secondaryPanelOpen, true);
  assert.equal(normalizeWorkspaceIde({ secondaryPanel: 'explorer' }).secondaryPanel, 'changes');
  // With the panel located secondary, the active id + open flag carry through.
  const located = normalizeWorkspaceIde({
    panelLocations: { search: 'secondary' },
    secondaryPanel: 'search',
    secondaryPanelOpen: true,
  });
  assert.equal(located.panelLocations.search, 'secondary');
  assert.equal(located.secondaryPanel, 'search');
  assert.equal(located.secondaryPanelOpen, true);
  // An active id that isn't located secondary recomputes to the first secondary
  // panel; a railPanel pushed into the secondary recomputes to a primary id.
  const drift = normalizeWorkspaceIde({
    panelLocations: { changes: 'secondary' },
    secondaryPanel: 'explorer',
    secondaryPanelOpen: true,
    railPanel: 'changes',
  });
  assert.equal(drift.secondaryPanel, 'changes');
  assert.equal(drift.railPanel, 'explorer');
  // panelLocations: full 4-key map; unknown keys dropped; an ABSENT or invalid
  // value falls to that panel's default home (Explorer/Search primary, Changes/
  // Source Control secondary); never all-secondary (the rail keeps >=1 panel).
  assert.deepEqual(normalizeWorkspaceIde({ panelLocations: { bogus: 'secondary', terminal: 'secondary' } }).panelLocations, {
    explorer: 'primary', search: 'primary', changes: 'secondary', 'source-control': 'secondary',
  });
  assert.equal(normalizeWorkspaceIde({ panelLocations: { search: 'sideways' } }).panelLocations.search, 'primary');
  assert.equal(normalizeWorkspaceIde({ panelLocations: 'nope' }).panelLocations.explorer, 'primary');
  assert.equal(
    normalizeWorkspaceIde({
      panelLocations: { explorer: 'secondary', search: 'secondary', changes: 'secondary', 'source-control': 'secondary' },
    }).panelLocations.explorer,
    'primary'
  );
  assert.equal(normalizeWorkspaceIde({ secondaryWidth: 320 }).secondaryWidth, 320);
  // Max widened 480 → 600 (Phase 5 viewport-safe wide resize).
  assert.equal(normalizeWorkspaceIde({ secondaryWidth: 9999 }).secondaryWidth, 600);
  assert.equal(normalizeWorkspaceIde({ secondaryWidth: 10 }).secondaryWidth, 160);
  assert.equal(normalizeWorkspaceIde({ secondaryWidth: 320.7 }).secondaryWidth, 320);
  assert.equal(normalizeWorkspaceIde({ secondaryWidth: 'wide' }).secondaryWidth, 260);
  // 'terminal'/'problems' are no longer valid rail panels (re-homed to the bottom panel).
  assert.equal(normalizeWorkspaceIde({ railPanel: 'terminal' }).railPanel, 'explorer');
  assert.equal(normalizeWorkspaceIde({ railPanel: 'problems' }).railPanel, 'explorer');
  // source-control is a valid rail panel, but it now homes to the secondary side
  // by default — locate it primary to make it the active rail panel.
  assert.equal(
    normalizeWorkspaceIde({ railPanel: 'source-control', panelLocations: { 'source-control': 'primary' } }).railPanel,
    'source-control'
  );
  assert.equal(normalizeWorkspaceIde({ wordWrap: 'on' }).wordWrap, 'on');
  assert.equal(normalizeWorkspaceIde({ wordWrap: 'bogus' }).wordWrap, 'off');
  // fontSize: valid passes, out-of-range clamps to bounds, non-finite -> default.
  assert.equal(normalizeWorkspaceIde({ fontSize: 18 }).fontSize, 18);
  assert.equal(normalizeWorkspaceIde({ fontSize: 18.7 }).fontSize, 18);
  assert.equal(normalizeWorkspaceIde({ fontSize: 100 }).fontSize, 40);
  assert.equal(normalizeWorkspaceIde({ fontSize: 4 }).fontSize, 8);
  assert.equal(normalizeWorkspaceIde({ fontSize: 0 }).fontSize, 8);
  assert.equal(normalizeWorkspaceIde({ fontSize: -5 }).fontSize, 8);
  assert.equal(normalizeWorkspaceIde({ fontSize: 'big' }).fontSize, 13);
  assert.equal(normalizeWorkspaceIde({ fontSize: NaN }).fontSize, 13);
  // tabSize: enum {2,4,8}; non-members (incl. 3) -> default 2.
  assert.equal(normalizeWorkspaceIde({ tabSize: 4 }).tabSize, 4);
  assert.equal(normalizeWorkspaceIde({ tabSize: 8 }).tabSize, 8);
  assert.equal(normalizeWorkspaceIde({ tabSize: 3 }).tabSize, 2);
  assert.equal(normalizeWorkspaceIde({ tabSize: 0 }).tabSize, 2);
  assert.equal(normalizeWorkspaceIde({ tabSize: 'x' }).tabSize, 2);
  // minimap: only literal false disables.
  assert.equal(normalizeWorkspaceIde({ minimap: false }).minimap, false);
  assert.equal(normalizeWorkspaceIde({ minimap: true }).minimap, true);
  assert.equal(normalizeWorkspaceIde({ minimap: 'no' }).minimap, true);
  assert.equal(normalizeWorkspaceIde({ minimap: 0 }).minimap, true);
  // lineNumbers enum.
  assert.equal(normalizeWorkspaceIde({ lineNumbers: 'off' }).lineNumbers, 'off');
  assert.equal(normalizeWorkspaceIde({ lineNumbers: 'relative' }).lineNumbers, 'on');
  // renderWhitespace enum.
  assert.equal(normalizeWorkspaceIde({ renderWhitespace: 'all' }).renderWhitespace, 'all');
  assert.equal(normalizeWorkspaceIde({ renderWhitespace: 'none' }).renderWhitespace, 'none');
  assert.equal(normalizeWorkspaceIde({ renderWhitespace: 'bogus' }).renderWhitespace, 'selection');
  // eol enum, including the '' (follow-file) default round-trip.
  assert.equal(normalizeWorkspaceIde({ eol: 'lf' }).eol, 'lf');
  assert.equal(normalizeWorkspaceIde({ eol: 'crlf' }).eol, 'crlf');
  assert.equal(normalizeWorkspaceIde({ eol: '' }).eol, '');
  assert.equal(normalizeWorkspaceIde({ eol: 'cr' }).eol, '');
  const normalized = normalizeWorkspaceIde({
    openTabs: [
      { path: 'src\\app.js' },
      'docs/readme.md',
      { path: 'src/app.js' }, // duplicate after separator normalization
      { path: '../escape.js' },
      { path: 'C:/abs.js' },
      { path: '/rooted.js' },
    ],
    activeTabPath: 'docs/readme.md',
    expandedDirs: ['src', 'src/../../up', 'src'],
    railPanel: 'search',
    railSide: 'left',
    railWidth: 9999,
  });
  assert.deepEqual(normalized.openTabs, [
    { path: 'src/app.js', pinned: false },
    { path: 'docs/readme.md', pinned: false },
  ]);
  assert.equal(normalized.activeTabPath, 'docs/readme.md');
  assert.deepEqual(normalized.expandedDirs, ['src']);
  assert.equal(normalized.railPanel, 'search');
  assert.equal(normalized.railSide, 'left');
  // Max reconciled 560 → 600 with the UI drag ceiling (Phase 5).
  assert.equal(normalized.railWidth, 600);
  assert.equal(normalizeWorkspaceIde({ railWidth: 10 }).railWidth, 200);
  // An active tab that is not an open tab collapses to empty.
  assert.equal(
    normalizeWorkspaceIde({ openTabs: [{ path: 'a.txt' }], activeTabPath: 'b.txt' }).activeTabPath,
    ''
  );
});

test('Windows path identity deduplicates case and dot aliases while preserving display casing', () => {
  const normalized = normalizeWorkspaceIde({
    openTabs: [
      { path: 'Src/A.txt', pinned: true },
      { path: 'src/./a.txt' },
      { path: 'src/B.txt' },
    ],
    activeTabPath: 'SRC/a.TXT',
    expandedDirs: ['Src', 'src/.', 'src/lib', 'SRC/LIB'],
  }, { platform: 'win32' });

  assert.deepEqual(normalized.openTabs, [
    { path: 'Src/A.txt', pinned: true },
    { path: 'src/B.txt', pinned: false },
  ]);
  assert.equal(normalized.activeTabPath, 'Src/A.txt');
  assert.deepEqual(normalized.expandedDirs, ['Src', 'src/lib']);
});

test('workspaceIde slice survives normalize/serialize round-trips and v23 migration', () => {
  const persisted = {
    version: 23, // pre-workspaceIde payload
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspace: { activeSessionId: null, openSessionIds: [] },
  };
  const migrated = normalizeState(persisted);
  assert.equal(migrated.version, CONFIG_VERSION);
  assert.deepEqual(ideState(migrated), { ...DEFAULT_WORKSPACE_IDE, openTabs: [], expandedDirs: [] });

  const withState = normalizeState({
    ...persisted,
    workspaceIde: {
      openTabs: [{ path: 'src/index.js' }],
      activeTabPath: 'src/index.js',
      expandedDirs: ['src'],
      railPanel: 'search',
      railSide: 'right',
      railWidth: 340,
    },
  });
  const serialized = serializeState(withState);
  const roundTripped = normalizeState(serialized);
  assert.deepEqual(roundTripped.workspaceIde, withState.workspaceIde);
  assert.equal(ideState(roundTripped).railPanel, 'search');
  assert.equal(ideState(roundTripped).railWidth, 340);
});

test('v24 -> v25 migration fills editor-pref defaults while preserving tabs/rail', () => {
  const persisted = {
    version: 24, // pre-editor-prefs payload
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspace: { activeSessionId: null, openSessionIds: [] },
    workspaceIde: {
      openTabs: [{ path: 'src/index.js' }],
      activeTabPath: 'src/index.js',
      expandedDirs: ['src'],
      railPanel: 'search',
      railSide: 'right',
      railWidth: 340,
      wordWrap: 'on',
    },
  };
  const migrated = normalizeState(persisted);
  assert.equal(migrated.version, CONFIG_VERSION);
  // Existing fields survive the bump.
  assert.deepEqual(ideState(migrated).openTabs, [{ path: 'src/index.js', pinned: false }]);
  assert.equal(ideState(migrated).activeTabPath, 'src/index.js');
  assert.equal(ideState(migrated).railPanel, 'search');
  assert.equal(ideState(migrated).railWidth, 340);
  assert.equal(ideState(migrated).wordWrap, 'on');
  // New editor-pref defaults are filled in.
  assert.equal(ideState(migrated).fontSize, 13);
  assert.equal(ideState(migrated).tabSize, 2);
  assert.equal(ideState(migrated).minimap, true);
  assert.equal(ideState(migrated).lineNumbers, 'on');
  assert.equal(ideState(migrated).renderWhitespace, 'selection');
  assert.equal(ideState(migrated).eol, '');
});

test('v25 -> v26 migration fills bottom-panel defaults while preserving tabs/rail/prefs', () => {
  const persisted = {
    version: 25, // pre-bottom-panel payload
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspace: { activeSessionId: null, openSessionIds: [] },
    workspaceIde: {
      openTabs: [{ path: 'src/index.js' }],
      activeTabPath: 'src/index.js',
      expandedDirs: ['src'],
      railPanel: 'search',
      railSide: 'right',
      railWidth: 340,
      wordWrap: 'on',
      fontSize: 16,
    },
  };
  const migrated = normalizeState(persisted);
  assert.equal(migrated.version, CONFIG_VERSION);
  // Tabs / rail / v25 editor prefs survive the bump.
  assert.deepEqual(ideState(migrated).openTabs, [{ path: 'src/index.js', pinned: false }]);
  assert.equal(ideState(migrated).railPanel, 'search');
  assert.equal(ideState(migrated).railWidth, 340);
  assert.equal(ideState(migrated).fontSize, 16);
  // New bottom-panel defaults arrive.
  assert.equal(ideState(migrated).bottomPanelOpen, false);
  assert.equal(ideState(migrated).bottomPanelHeight, 220);
  assert.equal(ideState(migrated).bottomPanelActiveView, 'terminal');
});

test('v26 -> v27 migration fills secondary-sidebar defaults while preserving tabs/rail/prefs/bottom-panel', () => {
  const persisted = {
    version: 26, // pre-secondary-sidebar payload
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspace: { activeSessionId: null, openSessionIds: [] },
    workspaceIde: {
      openTabs: [{ path: 'src/index.js' }],
      activeTabPath: 'src/index.js',
      expandedDirs: ['src'],
      railPanel: 'search',
      railSide: 'right',
      railWidth: 340,
      wordWrap: 'on',
      fontSize: 16,
      bottomPanelOpen: true,
      bottomPanelHeight: 300,
      bottomPanelActiveView: 'problems',
    },
  };
  const migrated = normalizeState(persisted);
  assert.equal(migrated.version, CONFIG_VERSION);
  // Tabs / rail / editor prefs / bottom-panel state survive the bump.
  assert.deepEqual(ideState(migrated).openTabs, [{ path: 'src/index.js', pinned: false }]);
  assert.equal(ideState(migrated).railPanel, 'search');
  assert.equal(ideState(migrated).railWidth, 340);
  assert.equal(ideState(migrated).fontSize, 16);
  assert.equal(ideState(migrated).bottomPanelOpen, true);
  assert.equal(ideState(migrated).bottomPanelHeight, 300);
  assert.equal(ideState(migrated).bottomPanelActiveView, 'problems');
  // New secondary-sidebar defaults arrive: Changes + Source Control home to the
  // secondary side (the split default), which stays collapsed; the active
  // secondary tab resolves to the first secondary panel ('changes').
  assert.equal(ideState(migrated).secondaryPanelOpen, false);
  assert.equal(ideState(migrated).secondaryPanel, 'changes');
  assert.equal(ideState(migrated).secondaryWidth, 260);
  assert.deepEqual(ideState(migrated).panelLocations, {
    explorer: 'primary', search: 'primary', changes: 'secondary', 'source-control': 'secondary',
  });
});

test('v27 -> v28 migration adds panelLocations (split default; Changes/Source Control secondary)', () => {
  const persisted = {
    version: 27, // pre-Move-View payload: secondaryPanel pinned a CLONE, not a location
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspace: { activeSessionId: null, openSessionIds: [] },
    workspaceIde: {
      openTabs: [{ path: 'src/index.js' }],
      activeTabPath: 'src/index.js',
      expandedDirs: ['src'],
      railPanel: 'explorer',
      railSide: 'right',
      railWidth: 340,
      secondaryPanelOpen: true,
      secondaryPanel: 'changes',
      secondaryWidth: 300,
    },
  };
  const migrated = normalizeState(persisted);
  assert.equal(migrated.version, CONFIG_VERSION);
  // Tabs / rail / width survive the bump.
  assert.deepEqual(ideState(migrated).openTabs, [{ path: 'src/index.js', pinned: false }]);
  assert.equal(ideState(migrated).railPanel, 'explorer');
  assert.equal(ideState(migrated).secondaryWidth, 300);
  // panelLocations defaults to the split (Changes + Source Control secondary).
  // The old v27 clone fields are still not a location source, but since 'changes'
  // now homes secondary by default, the persisted secondaryPanel:'changes' + open
  // flag land on a populated secondary side (active 'changes', open).
  assert.deepEqual(ideState(migrated).panelLocations, {
    explorer: 'primary', search: 'primary', changes: 'secondary', 'source-control': 'secondary',
  });
  assert.equal(ideState(migrated).secondaryPanel, 'changes');
  assert.equal(ideState(migrated).secondaryPanelOpen, true);
});

test('v28 -> v29 migration adds inline-suggest defaults while preserving prior IDE state', () => {
  const persisted = {
    version: 28, // pre-inline-autocomplete payload
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspace: { activeSessionId: null, openSessionIds: [] },
    workspaceIde: {
      openTabs: [{ path: 'src/index.js' }],
      activeTabPath: 'src/index.js',
      expandedDirs: ['src'],
      railPanel: 'changes',
      railSide: 'right',
      railWidth: 340,
      wordWrap: 'on',
      fontSize: 16,
      panelLocations: { explorer: 'primary', search: 'secondary', changes: 'primary', 'source-control': 'primary' },
    },
  };
  const migrated = normalizeState(persisted);
  assert.equal(migrated.version, CONFIG_VERSION);
  // Tabs / rail / editor prefs / panel locations survive the bump.
  assert.deepEqual(ideState(migrated).openTabs, [{ path: 'src/index.js', pinned: false }]);
  assert.equal(ideState(migrated).railPanel, 'changes');
  assert.equal(ideState(migrated).fontSize, 16);
  assert.equal(ideState(migrated).panelLocations.search, 'secondary');
  // New inline-autocomplete defaults arrive (enabled-on, no model, CPU-pinned).
  assert.equal(ideState(migrated).inlineSuggestEnabled, true);
  assert.equal(ideState(migrated).inlineSuggestModel, '');
  assert.equal('inlineSuggestUseGpu' in ideState(migrated), false);
});

test('v30 -> v31 migration defaults autoSaveEnabled OFF while preserving prior IDE state', () => {
  const persisted = {
    version: 30, // pre-auto-save payload
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspace: { activeSessionId: null, openSessionIds: [] },
    workspaceIde: {
      openTabs: [{ path: 'src/index.js' }],
      activeTabPath: 'src/index.js',
      expandedDirs: ['src'],
      railPanel: 'search',
      railSide: 'right',
      railWidth: 340,
      wordWrap: 'on',
      fontSize: 16,
      inlineSuggestEnabled: false,
      inlineSuggestModel: 'qwen2.5-coder:1.5b-base',
    },
  };
  const migrated = normalizeState(persisted);
  assert.equal(migrated.version, CONFIG_VERSION); // 31
  // Prior IDE state survives the bump.
  assert.deepEqual(ideState(migrated).openTabs, [{ path: 'src/index.js', pinned: false }]);
  assert.equal(ideState(migrated).railPanel, 'search');
  assert.equal(ideState(migrated).fontSize, 16);
  assert.equal(ideState(migrated).inlineSuggestEnabled, false);
  assert.equal(ideState(migrated).inlineSuggestModel, 'qwen2.5-coder:1.5b-base');
  // An existing config must NOT silently start auto-writing: the new field
  // defaults OFF (only a literal true would enable it).
  assert.equal(ideState(migrated).autoSaveEnabled, false);

  // A persisted opt-in survives the migration + a serialize round-trip.
  const optedIn = normalizeState({
    ...persisted,
    workspaceIde: { ...persisted.workspaceIde, autoSaveEnabled: true },
  });
  assert.equal(ideState(optedIn).autoSaveEnabled, true);
  const roundTripped = normalizeState(serializeState(optedIn));
  assert.equal(ideState(roundTripped).autoSaveEnabled, true);
  // Idempotent: re-normalizing the v31 default state leaves it OFF.
  assert.equal(ideState(normalizeState(serializeState(migrated))).autoSaveEnabled, false);
});

test('v31 -> v32 migration persists pinned tabs while preserving prior IDE state', () => {
  const persisted = {
    version: 31, // pre-pinned-persistence payload (normalizer used to strip `pinned`)
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspace: { activeSessionId: null, openSessionIds: [] },
    workspaceIde: {
      openTabs: [
        { path: 'src/index.js' }, // no `pinned` field -> hydrates unpinned
        { path: 'src/pinned.js', pinned: true }, // an existing pin survives
      ],
      activeTabPath: 'src/pinned.js',
      expandedDirs: ['src'],
      railPanel: 'search',
      railSide: 'right',
      railWidth: 340,
      fontSize: 16,
      autoSaveEnabled: true,
    },
  };
  const migrated = normalizeState(persisted);
  assert.equal(migrated.version, CONFIG_VERSION); // 32
  // Pinned tabs now persist: the bare tab hydrates pinned:false, the pinned one
  // survives pinned:true. (pinned-first clamp is a renderer concern; the
  // normalizer preserves order + the pinned flag.)
  const expectedTabs = [
    { path: 'src/index.js', pinned: false },
    { path: 'src/pinned.js', pinned: true },
  ];
  assert.deepEqual(ideState(migrated).openTabs, expectedTabs);
  // Prior IDE state survives the bump.
  assert.equal(ideState(migrated).activeTabPath, 'src/pinned.js');
  assert.deepEqual(ideState(migrated).expandedDirs, ['src']);
  assert.equal(ideState(migrated).railPanel, 'search');
  assert.equal(ideState(migrated).railWidth, 340);
  assert.equal(ideState(migrated).fontSize, 16);
  assert.equal(ideState(migrated).autoSaveEnabled, true);
  // The pin survives a serialize round-trip (the strip site is gone).
  const roundTripped = normalizeState(serializeState(migrated));
  assert.deepEqual(ideState(roundTripped).openTabs, expectedTabs);
});

test('v34 -> v35 migration flips a prior-default rail to the split, preserving customized layouts', () => {
  // A v34 profile sitting on the PRIOR default (rail right + all four panels
  // primary) adopts the new split: Explorer + Search stay primary (left rail),
  // Changes + Source Control move to the secondary sidebar (right, collapsed),
  // with the active secondary tab = 'changes'. Tabs / editor prefs ride along.
  const priorDefault = normalizeState({
    version: 34,
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspaceIde: {
      openTabs: [{ path: 'src/index.js' }],
      activeTabPath: 'src/index.js',
      railPanel: 'explorer',
      railSide: 'right',
      railWidth: 340,
      fontSize: 16,
      panelLocations: {
        explorer: 'primary', search: 'primary', changes: 'primary', 'source-control': 'primary',
      },
      secondaryPanelOpen: false,
      secondaryPanel: '',
    },
  });
  assert.equal(priorDefault.version, CONFIG_VERSION);
  assert.equal(ideState(priorDefault).railSide, 'left');
  assert.deepEqual(ideState(priorDefault).panelLocations, {
    explorer: 'primary', search: 'primary', changes: 'secondary', 'source-control': 'secondary',
  });
  assert.equal(ideState(priorDefault).secondaryPanel, 'changes');
  assert.equal(ideState(priorDefault).secondaryPanelOpen, false);
  // Non-layout state survives the flip.
  assert.deepEqual(ideState(priorDefault).openTabs, [{ path: 'src/index.js', pinned: false }]);
  assert.equal(ideState(priorDefault).railWidth, 340);
  assert.equal(ideState(priorDefault).fontSize, 16);

  // A customized layout (any explicit 'secondary', or a flipped railSide) is NOT
  // a prior-default match and rides through untouched.
  const movedPanel = normalizeState({
    version: 34,
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspaceIde: {
      railSide: 'right',
      panelLocations: {
        explorer: 'primary', search: 'secondary', changes: 'primary', 'source-control': 'primary',
      },
      secondaryPanelOpen: true,
      secondaryPanel: 'search',
    },
  });
  assert.equal(ideState(movedPanel).railSide, 'right');
  assert.equal(ideState(movedPanel).panelLocations.search, 'secondary');
  assert.equal(ideState(movedPanel).panelLocations.changes, 'primary');

  const flippedLeft = normalizeState({
    version: 34,
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspaceIde: {
      railSide: 'left',
      panelLocations: {
        explorer: 'primary', search: 'primary', changes: 'primary', 'source-control': 'primary',
      },
    },
  });
  assert.equal(ideState(flippedLeft).railSide, 'left');
  assert.deepEqual(ideState(flippedLeft).panelLocations, {
    explorer: 'primary', search: 'primary', changes: 'primary', 'source-control': 'primary',
  });

  // Idempotent: the flipped (now v35) slice re-normalizes to itself.
  const reRun = normalizeState(serializeState(priorDefault));
  assert.equal(ideState(reRun).railSide, 'left');
  assert.deepEqual(ideState(reRun).panelLocations, ideState(priorDefault).panelLocations);
  assert.equal(ideState(reRun).secondaryPanel, 'changes');
});

test('normalizeWorkspaceIde keeps pinned tabs and defaults a bare tab to unpinned', () => {
  // Regression guard for the CONFIG_VERSION 32 strip-site fix: `pinned` rides
  // inside each tab object and is materialized (default false) rather than
  // stripped, mirroring the renderer round-trip.
  const normalized = normalizeWorkspaceIde({
    openTabs: [
      { path: 'a.js', pinned: true },
      { path: 'b.js' }, // no flag -> unpinned
      'c.js', // string entry has no `pinned` -> unpinned
      { path: 'd.js', pinned: 'yes' }, // only literal true pins
    ],
  });
  assert.deepEqual(normalized.openTabs, [
    { path: 'a.js', pinned: true },
    { path: 'b.js', pinned: false },
    { path: 'c.js', pinned: false },
    { path: 'd.js', pinned: false },
  ]);
  // An old v31-era slice carrying only `{ path }` tabs normalizes with `pinned`
  // defaulting false (old configs stay valid, hydrate unpinned).
  assert.deepEqual(
    normalizeWorkspaceIde({ openTabs: [{ path: 'legacy.js' }] }).openTabs,
    [{ path: 'legacy.js', pinned: false }]
  );
});

test('normalizeWorkspaceIde validates and bounds replaceJournal as root-scoped state', () => {
  assert.equal(normalizeWorkspaceIde().replaceJournal, null);
  assert.equal(normalizeWorkspaceIde({ replaceJournal: null }).replaceJournal, null);
  for (const replaceJournal of [
    {},
    [],
    { startedAt: NaN, query: 'x', total: 1, applied: [] },
    { startedAt: 1, query: 2, total: 1, applied: [] },
    { startedAt: 1, query: 'x', total: -1, applied: [] },
    { startedAt: 1, query: 'x', total: 1, applied: 'a.txt' },
  ]) {
    assert.equal(normalizeWorkspaceIde({ replaceJournal }).replaceJournal, null);
  }

  const applied = Array.from({ length: 205 }, (_, index) => `src/${index}.js`);
  applied.splice(2, 0, '../escape.js', 'C:/absolute.js', '/rooted.js');
  const normalized = normalizeWorkspaceIde({
    replaceJournal: {
      startedAt: 123.5,
      query: 'q'.repeat(501),
      total: 205.9,
      applied,
    },
  }).replaceJournal;

  assert.equal(normalized.startedAt, 123.5);
  assert.equal(normalized.query.length, 500);
  assert.equal(normalized.total, 205.9);
  assert.equal(normalized.applied.length, 200);
  assert.equal(normalized.applied.includes('../escape.js'), false);
  assert.equal(normalized.truncated, true);
});

// Asserts the end-to-end user-facing contract (a stale v25 rail value never
// survives a load), not the v26 migration block in isolation — normalizeState
// always re-normalizes workspaceIde, so the narrowed RAIL_PANELS whitelist does
// the coercion regardless of which migration block ran.
test('v26 migration coerces a stale railPanel:terminal/problems to explorer', () => {
  assert.equal(
    ideState(normalizeState({ version: 25, workspaceIde: { railPanel: 'terminal' } })).railPanel,
    'explorer'
  );
  assert.equal(
    ideState(normalizeState({ version: 25, workspaceIde: { railPanel: 'problems' } })).railPanel,
    'explorer'
  );
});

test('normalizeWorkspaceIde backfills + clamps the chat dock triad (no CONFIG_VERSION bump)', () => {
  // Fresh defaults: closed, right side, 380 wide.
  const defaults = normalizeWorkspaceIde(undefined);
  assert.equal(defaults.chatDockOpen, false);
  assert.equal(defaults.chatDockSide, 'right');
  assert.equal(defaults.chatDockWidth, 380);

  // Additive backfill: a pre-dock config missing all three keys resolves to the
  // safe defaults, idempotently (normalize(normalize(x)) === normalize(x)).
  const legacy = normalizeWorkspaceIde({ railSide: 'left', railWidth: 333 });
  assert.equal(legacy.chatDockOpen, false);
  assert.equal(legacy.chatDockSide, 'right');
  assert.equal(legacy.chatDockWidth, 380);
  assert.deepEqual(normalizeWorkspaceIde(legacy), legacy);

  // Open: only the literal boolean true. Side: {left,right} whitelist.
  assert.equal(normalizeWorkspaceIde({ chatDockOpen: true }).chatDockOpen, true);
  assert.equal(normalizeWorkspaceIde({ chatDockOpen: 'yes' }).chatDockOpen, false);
  assert.equal(normalizeWorkspaceIde({ chatDockSide: 'left' }).chatDockSide, 'left');
  assert.equal(normalizeWorkspaceIde({ chatDockSide: 'middle' }).chatDockSide, 'right');

  // Width: the dock's OWN 280/2400/380 bounds (not the secondary 160/480/260).
  assert.equal(normalizeWorkspaceIde({ chatDockWidth: 400 }).chatDockWidth, 400);
  assert.equal(normalizeWorkspaceIde({ chatDockWidth: 9999 }).chatDockWidth, 2400);
  assert.equal(normalizeWorkspaceIde({ chatDockWidth: 10 }).chatDockWidth, 280);
  assert.equal(normalizeWorkspaceIde({ chatDockWidth: 400.7 }).chatDockWidth, 400);
  assert.equal(normalizeWorkspaceIde({ chatDockWidth: 'wide' }).chatDockWidth, 380);
});

test('v36 migration adds the generated-directory preference and preserves explicit opt-in', () => {
  const hidden = normalizeState({
    version: 36,
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspaceIde: { preferences: { fontSize: 17 }, roots: {}, rootLru: [] },
  });
  assert.equal(hidden.version, CONFIG_VERSION);
  assert.equal(ideState(hidden).showGenerated, false);
  assert.equal(ideState(hidden).fontSize, 17);

  const shown = normalizeState({
    version: 36,
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspaceIde: { preferences: { showGenerated: true }, roots: {}, rootLru: [] },
  });
  assert.equal(ideState(normalizeState(serializeState(shown))).showGenerated, true);
});

test('explorer sort mode round-trips as an additive global preference', () => {
  assert.equal(CONFIG_VERSION, 51);
  const state = normalizeState({
    version: CONFIG_VERSION,
    toolsWorkspaceRoot: TEST_WORKSPACE_ROOT,
    workspaceIde: { preferences: { explorerSortMode: 'modified' }, roots: {}, rootLru: [] },
  });
  const roundTrip = normalizeState(serializeState(state));
  assert.equal(ideState(roundTrip).explorerSortMode, 'modified');
  assert.equal(roundTrip.workspaceIde.preferences.explorerSortMode, 'modified');
  assert.equal(normalizeWorkspaceIde({ explorerSortMode: null }).explorerSortMode, 'name');
});
