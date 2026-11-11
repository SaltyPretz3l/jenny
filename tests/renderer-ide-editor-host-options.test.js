'use strict';

/* The editor-level option state split out of renderer-ide-editor-host.js: setEditorOptions
 * fans a change out to the primary editor, the diff pane, the group editors and the group diffs,
 * and every editor created later starts from the applied level options. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { IDE_EDITOR_OPTIONS, createEditorOptions } = require('../renderer/features/renderer-ide-editor-host-options');

function build({ largeFile = false } = {}) {
  const seen = { editor: [], wrap: [], font: [], groups: [], groupDiffs: [] };
  const options = createEditorOptions({
    monacoUtils: { IDE_DIFF_EDITOR_OPTIONS: { renderSideBySide: true } },
    getEditor: () => ({ updateOptions: (value) => seen.editor.push(value) }),
    getDiffPane: () => ({ applyWrap: (mode) => seen.wrap.push(mode), updateFontSize: (size) => seen.font.push(size) }),
    getGroupEditors: () => ({ updateOptions: (value) => seen.groups.push(value) }),
    getGroupDiffs: () => ({ updateOptions: (value) => seen.groupDiffs.push(value) }),
    isActiveLargeFile: () => largeFile,
  });
  return { options, seen };
}

test('base options start from the defaults and follow wrap, minimap and applied preferences', () => {
  const { options } = build();
  assert.deepEqual(options.baseEditorOptions(), { ...IDE_EDITOR_OPTIONS, wordWrap: 'off', minimap: { enabled: true } });
  options.setEditorOptions({ wordWrap: 'on', fontSize: 17, minimap: { enabled: false } });
  const base = options.baseEditorOptions();
  assert.equal(base.wordWrap, 'on');
  assert.equal(base.fontSize, 17);
  assert.deepEqual(base.minimap, { enabled: false });
  assert.equal(options.getWrapMode(), 'on');
  assert.deepEqual(options.getDiffOptions(), { renderSideBySide: true, wordWrap: 'on', fontSize: 17, minimap: { enabled: false } });
});

test('setEditorOptions fans out; a large active file only mutes the primary minimap', () => {
  const { options, seen } = build({ largeFile: true });
  options.setEditorOptions({ wordWrap: 'bogus', fontSize: 12, minimap: { enabled: true } });
  assert.deepEqual(seen.wrap, ['off']);
  assert.deepEqual(seen.font, [12]);
  assert.deepEqual(seen.editor[0].minimap, { enabled: false }, 'the primary editor drops the minimap for a large file');
  assert.deepEqual(seen.groups[0].minimap, { enabled: true }, 'group editors follow the preference only');
  assert.deepEqual(seen.groupDiffs[0], seen.groups[0]);
  options.setWordWrap('on');
  assert.deepEqual(seen.wrap, ['off', 'on']);
  assert.equal(options.getLevelOptions().wordWrap, 'on');
});
