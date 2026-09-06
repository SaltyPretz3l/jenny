'use strict';

/* Stage-surface state model (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md Phase 1).
 * Pure-state coverage for the `activeStageSurface` enum + `previewPath` target
 * on renderer/features/renderer-ide-state.js, and the persisted-slice
 * normalization on services/workspace-ide-config-schema.js. Follows the
 * standalone-state-file precedent of tests/renderer-ide-map-tab.test.js and
 * the schema-block precedent of tests/renderer-ide-explode-state.test.js. */

const test = require('node:test');
const assert = require('node:assert');

const ideState = require('../renderer/features/renderer-ide-state');
const {
  normalizeWorkspaceIde,
  WORKSPACE_IDE_STAGE_SURFACES,
} = require('../services/workspace-ide-config-schema');

// ── renderer-ide-state.js: shape + coercion ─────────────────────────────────

test('createIdeUiState seeds the editor surface and an empty preview target', () => {
  const ide = ideState.createIdeUiState();
  assert.equal(ide.activeStageSurface, 'editor');
  assert.equal(ide.previewPath, '');
});

test('STAGE_SURFACES names exactly the four stage surfaces', () => {
  assert.deepEqual(ideState.STAGE_SURFACES, ['editor', 'preview', 'file_map', 'exploded']);
});

test('coerceStageSurface accepts only the enum and falls back to editor', () => {
  for (const surface of ideState.STAGE_SURFACES) {
    assert.equal(ideState.coerceStageSurface(surface), surface);
  }
  for (const bad of ['map', 'preview://x', '', null, undefined, 42, {}, 'EDITOR']) {
    assert.equal(ideState.coerceStageSurface(bad), 'editor');
  }
});

test('setStageSurface mutates only through the enum and reports the applied surface', () => {
  const ide = ideState.createIdeUiState();
  assert.equal(ideState.setStageSurface(ide, 'file_map'), 'file_map');
  assert.equal(ide.activeStageSurface, 'file_map');
  assert.equal(ideState.setStageSurface(ide, 'bogus'), 'file_map', 'invalid input is a no-op');
  assert.equal(ide.activeStageSurface, 'file_map');
  assert.equal(ideState.setStageSurface(ide, 'editor'), 'editor');
});

test('setPreviewPath normalizes workspace-relative paths and clears on invalid', () => {
  const ide = ideState.createIdeUiState();
  assert.equal(ideState.setPreviewPath(ide, 'docs\\readme.md'), 'docs/readme.md');
  assert.equal(ide.previewPath, 'docs/readme.md');
  assert.equal(ideState.setPreviewPath(ide, 'C:\\evil.md'), '');
  assert.equal(ide.previewPath, '');
  assert.equal(ideState.setPreviewPath(ide, '../escape.md'), '');
  assert.equal(ideState.setPreviewPath(ide, 'preview://old-tab-id'), '');
});

// ── persist / apply round-trip ──────────────────────────────────────────────

test('toPersistedState carries the stage surface and preview target', () => {
  const ide = ideState.createIdeUiState();
  ideState.setStageSurface(ide, 'preview');
  ideState.setPreviewPath(ide, 'notes/todo.md');
  const persisted = ideState.toPersistedState(ide);
  assert.equal(persisted.activeStageSurface, 'preview');
  assert.equal(persisted.previewPath, 'notes/todo.md');
});

test('toPersistedState sanitizes a corrupted in-memory surface/path', () => {
  const ide = ideState.createIdeUiState();
  ide.activeStageSurface = 'garbage';
  ide.previewPath = '../../etc/passwd';
  const persisted = ideState.toPersistedState(ide);
  assert.equal(persisted.activeStageSurface, 'editor');
  assert.equal(persisted.previewPath, '');
});

test('applyPersistedState restores the enum and coerces unknown/legacy values to editor', () => {
  const ide = ideState.createIdeUiState();
  ideState.applyPersistedState(ide, { activeStageSurface: 'file_map', previewPath: 'a.md' });
  assert.equal(ide.activeStageSurface, 'file_map');
  assert.equal(ide.previewPath, 'a.md');

  const stale = ideState.createIdeUiState();
  ideState.applyPersistedState(stale, { activeStageSurface: 'map://workspace', previewPath: 'preview://a.md' });
  assert.equal(stale.activeStageSurface, 'editor');
  assert.equal(stale.previewPath, '');

  const absent = ideState.createIdeUiState();
  ideState.applyPersistedState(absent, {});
  assert.equal(absent.activeStageSurface, 'editor');
  assert.equal(absent.previewPath, '');
});

// ── legacy transient-id cleanup (kept guards) ───────────────────────────────

test('legacy map:// and preview:// ids never survive persistence', () => {
  const ide = ideState.createIdeUiState();
  ideState.openTab(ide, 'src/app.js');
  // Simulate a stale in-memory session that still carries the old synthetic tabs.
  ide.openTabs.push({ path: ideState.MAP_TAB_ID, kind: 'map', label: 'Map' });
  ide.openTabs.push({ path: 'preview://docs/readme.md', kind: 'preview', label: 'readme (preview)' });
  ide.activeTabPath = ideState.MAP_TAB_ID;
  const persisted = ideState.toPersistedState(ide);
  assert.deepEqual(persisted.openTabs.map((tab) => tab.path), ['src/app.js']);
  assert.equal(persisted.activeTabPath, '');
});

// ── services/workspace-ide-config-schema.js: normalizeWorkspaceIde ─────────

test('schema: stage-surface whitelist accepts the enum and resets unknown ids to editor', () => {
  assert.deepEqual([...WORKSPACE_IDE_STAGE_SURFACES], ['editor', 'preview', 'file_map', 'exploded']);
  for (const surface of WORKSPACE_IDE_STAGE_SURFACES) {
    assert.equal(normalizeWorkspaceIde({ activeStageSurface: surface }).activeStageSurface, surface);
  }
  for (const bad of ['map', 'Preview', '', null, 7, ['preview']]) {
    assert.equal(normalizeWorkspaceIde({ activeStageSurface: bad }).activeStageSurface, 'editor');
  }
});

test('schema: previewPath normalizes workspace-relative and drops escapes/absolutes', () => {
  assert.equal(normalizeWorkspaceIde({ previewPath: 'docs\\readme.md' }).previewPath, 'docs/readme.md');
  assert.equal(normalizeWorkspaceIde({ previewPath: '../up.md' }).previewPath, '');
  assert.equal(normalizeWorkspaceIde({ previewPath: 'C:/abs.md' }).previewPath, '');
  assert.equal(normalizeWorkspaceIde({ previewPath: 42 }).previewPath, '');
});

test('schema: absent keys backfill to safe defaults (additive, no CONFIG_VERSION bump)', () => {
  const normalized = normalizeWorkspaceIde({ openTabs: [{ path: 'a.js' }] });
  assert.equal(normalized.activeStageSurface, 'editor');
  assert.equal(normalized.previewPath, '');
});

test('schema: pre-existing fields are unaffected by the new keys', () => {
  const before = normalizeWorkspaceIde({ railPanel: 'search', railWidth: 320 });
  const after = normalizeWorkspaceIde({
    railPanel: 'search', railWidth: 320, activeStageSurface: 'preview', previewPath: 'a.md',
  });
  assert.equal(after.railPanel, before.railPanel);
  assert.equal(after.railWidth, before.railWidth);
  assert.equal(after.activeStageSurface, 'preview');
});
