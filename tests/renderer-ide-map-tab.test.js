'use strict';

/* tests/renderer-ide-map-tab.test.js — legacy map:// id CLEANUP contract.
 * The Workspace File Map is a stage surface (activeStageSurface) since
 * WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md: the old openMapTab reducer is
 * intentionally GONE, and what remains of the map-tab model is the guard set
 * that keeps older transient ids from leaking back in — isMapTabId itself,
 * persistence exclusion, and hydrate coercion. Pure state-module tests. */

const test = require('node:test');
const assert = require('node:assert/strict');

const ideState = require('../renderer/features/renderer-ide-state');

test('isMapTabId recognizes only map:// ids (the legacy-guard predicate)', () => {
  assert.equal(ideState.isMapTabId(ideState.MAP_TAB_ID), true);
  assert.equal(ideState.isMapTabId('map://workspace'), true);
  assert.equal(ideState.isMapTabId('src/app.js'), false);
  assert.equal(ideState.isMapTabId('diff://change/1'), false);
  assert.equal(ideState.isMapTabId('preview://docs/readme.md'), false);
  assert.equal(ideState.isMapTabId(''), false);
});

test('the openMapTab reducer is intentionally removed (tabs can never be created)', () => {
  assert.equal('openMapTab' in ideState, false, 'no reducer may re-create map tabs');
});

test('a stale in-memory map tab never survives persistence', () => {
  const ide = ideState.createIdeUiState();
  ideState.openTab(ide, 'src/app.js');
  // Simulate a pre-upgrade session that still carries the synthetic tab.
  ide.openTabs.push({ path: ideState.MAP_TAB_ID, kind: 'map', label: 'Map' });
  ide.activeTabPath = ideState.MAP_TAB_ID;
  const persisted = ideState.toPersistedState(ide);
  assert.deepEqual(persisted.openTabs.map((tab) => tab.path), ['src/app.js']);
  assert.equal(persisted.activeTabPath, '', 'a map id never persists as the active tab');
});

test('hydrating a payload carrying legacy map values coerces them away', () => {
  const ide = ideState.createIdeUiState();
  ideState.applyPersistedState(ide, {
    openTabs: [{ path: 'src/app.js' }],
    activeTabPath: 'src/app.js',
    // A pre-upgrade profile could only ever hold the surface enum or nothing;
    // a raw legacy id here is hostile/hand-edited input and must coerce.
    activeStageSurface: 'map://workspace',
    previewPath: 'preview://docs/readme.md',
  });
  assert.equal(ide.openTabs.some((tab) => tab.path === ideState.MAP_TAB_ID), false);
  assert.equal(ide.activeTabPath, 'src/app.js');
  assert.equal(ide.activeStageSurface, 'editor', 'a legacy id in the surface slot coerces to editor');
  assert.equal(ide.previewPath, '', 'a legacy preview:// id in the preview slot coerces to empty');
});
