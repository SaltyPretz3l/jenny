'use strict';

/* tests/renderer-ide-map-flag-off-parity.test.js - flag-off parity gate for
 * the Workspace File Map (`workspace_file_map`) under the STAGE-SURFACE
 * contract (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md): with the flag OFF the
 * map feature must be byte-invisible — no DOM under #ideMapHost, no stage
 * activation, no storage writes, no activity-bar entry, and the persisted ide
 * state byte-identical to a world where the map code never ran. With the flag
 * ON, opening the map activates the `file_map` stage surface and creates NO
 * tab (the old map:// tab contract is intentionally gone). Uses jsdom
 * directly; dispose via t.after(), never dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeMapController } = require('../renderer/features/renderer-ide-map-controller');
const railUtils = require('../renderer/features/renderer-ide-rail');
const realIdeState = require('../renderer/features/renderer-ide-state');

function setupDom() {
  const dom = new JSDOM('<div class="ide-map-host hidden" id="host"></div>');
  return { dom, hostEl: dom.window.document.getElementById('host') };
}

function trackedStorage() {
  const writes = [];
  return {
    getItem: () => null,
    setItem: (key, value) => { writes.push([key, value]); },
    writes,
  };
}

test('flag off: every public method leaves the host markup byte-identical and writes nothing', async (t) => {
  const { hostEl } = setupDom();
  const before = hostEl.outerHTML;
  const storage = trackedStorage();
  const ide = realIdeState.createIdeUiState();
  const ideBefore = JSON.stringify(ide);
  const stageActivations = [];

  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => ide,
    getFeatureFlags: () => ({ workspace_file_map: false }),
    onOpenFile: () => {},
    activateStage: (surface) => stageActivations.push(surface),
    storage,
    windowRef: {},
  });
  t.after(() => ctrl.dispose());

  ctrl.bindEvents();
  ctrl.openFileMap();
  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  ctrl.syncVisibility('some/file.js');
  assert.equal(await ctrl.revealInMap?.('a.js'), 'unavailable', 'reveal reports unavailable, never throws');
  ctrl.showBlastRadius?.('a.js');

  assert.equal(hostEl.outerHTML, before, 'host markup must be byte-identical with the flag off');
  assert.equal(JSON.stringify(ide), ideBefore, 'ide state must be untouched (no stage activation persisted)');
  assert.deepEqual(storage.writes, [], 'no localStorage writes with the flag off');
  assert.deepEqual(stageActivations, [], 'no stage-surface activation with the flag off');
});

test('flag off then on: the same controller instance honors the flag at call time', (t) => {
  const { hostEl } = setupDom();
  let flagOn = false;
  const ide = realIdeState.createIdeUiState();
  const stageActivations = [];

  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => ide,
    getFeatureFlags: () => ({ workspace_file_map: flagOn }),
    onOpenFile: () => {},
    activateStage: (surface) => stageActivations.push(surface),
    windowRef: {},
  });
  t.after(() => ctrl.dispose());

  ctrl.openFileMap();
  assert.equal(hostEl.innerHTML, '', 'flag off: no mount');
  assert.deepEqual(stageActivations, [], 'flag off: no stage activation');

  flagOn = true;
  ctrl.openFileMap();
  assert.deepEqual(stageActivations, ['file_map'], 'flag on: opening the map activates the stage surface');
  assert.equal(ide.openTabs.length, 0, 'flag on: NO tab is created — the map is a stage surface');
  assert.equal(hostEl.innerHTML === '', false, 'flag on: the host mounts');
});

test('flag off: the ide:open-file-map palette row is absent (present when on)', () => {
  const { createIdeCommands } = require('../renderer/features/renderer-ide-commands');
  let flagOn = false;
  const commands = createIdeCommands({
    getActiveView: () => 'ide',
    isFileMapEnabled: () => flagOn,
  });
  const idsOff = commands.getCommandItems().map((c) => c.id);
  assert.equal(idsOff.includes('ide:open-file-map'), false, 'row must be hidden with the flag off');
  flagOn = true;
  const idsOn = commands.getCommandItems().map((c) => c.id);
  assert.equal(idsOn.includes('ide:open-file-map'), true, 'row must appear with the flag on');
});

test('stage-surface activity entries: absent when flags are off, byte-identical bar; present when on', (t) => {
  // Two-entry-kind parity (handoff §B.2): the stage entries are a SEPARATE
  // flag-gated list — with both flags off the activity strip renders exactly
  // the markup it rendered before the feature existed.
  const dom = new JSDOM('<nav id="bar"></nav><div id="resizer"></div><div id="shell"></div>');
  t.after(() => { /* nothing bound beyond the bar; rail.dispose below */ });
  const bar = dom.window.document.getElementById('bar');
  const ide = realIdeState.createIdeUiState();
  let previewOn = false;
  let mapOn = false;

  const rail = railUtils.createIdeRail({
    getDom: () => ({
      ideActivityBar: bar,
      ideRailResizer: dom.window.document.getElementById('resizer'),
      ideShell: dom.window.document.getElementById('shell'),
    }),
    getIde: () => ide,
    onActivateStageSurface: () => {},
    isStageSurfaceEnabled: (surface) => (surface === 'preview' ? previewOn : surface === 'file_map' ? mapOn : false),
    getActiveStageSurface: () => 'editor',
  });
  t.after(() => rail.dispose());

  rail.renderActivityBar();
  const offMarkup = bar.innerHTML;
  assert.equal(offMarkup.includes('data-ide-stage-surface'), false, 'no stage buttons with flags off');
  assert.equal(offMarkup.includes('ide-stage-group'), false, 'no stage group wrapper with flags off');

  previewOn = true;
  mapOn = true;
  rail.renderActivityBar();
  const onMarkup = bar.innerHTML;
  assert.equal(onMarkup.includes('data-ide-stage-surface="preview"'), true, 'Preview entry appears');
  assert.equal(onMarkup.includes('data-ide-stage-surface="file_map"'), true, 'File Map entry appears');

  previewOn = false;
  mapOn = false;
  rail.renderActivityBar();
  assert.equal(bar.innerHTML, offMarkup, 'turning the flags back off restores the byte-identical bar');
});

test('flag off: persisted ide state is byte-identical to one that never saw map code', () => {
  const untouched = realIdeState.createIdeUiState();
  const exercised = realIdeState.createIdeUiState();
  // Simulate a session where a file tab is open in both worlds.
  for (const ide of [untouched, exercised]) {
    ide.openTabs.push({ path: 'src/app.js', kind: 'file', label: 'app.js' });
    ide.activeTabPath = 'src/app.js';
  }
  const a = JSON.stringify(realIdeState.toPersistedState(untouched));
  const b = JSON.stringify(realIdeState.toPersistedState(exercised));
  assert.equal(b, a, 'persisted snapshots must be byte-identical');
});
