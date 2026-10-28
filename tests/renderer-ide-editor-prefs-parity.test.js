'use strict';

// Row 82: the renderer (renderer-ide-state.js) and the service (workspace-ide-config-schema.js)
// each normalize the editor prefs. This pins them equal for every editor-pref key,
// including the additive row 82 keys and the derived autoSaveEnabled mirror.

const test = require('node:test');
const assert = require('node:assert/strict');

const rendererIdeState = require('../renderer/features/renderer-ide-state');
const { normalizeWorkspaceIdePreferences, DEFAULT_WORKSPACE_IDE } = require('../services/workspace-ide-config-schema');

const ROW82_KEYS = [
  'fontFamily', 'cursorStyle', 'cursorBlinking', 'cursorSmoothCaretAnimation', 'fontLigatures',
  'bracketPairColorization', 'indentGuides', 'stickyScroll', 'folding', 'insertSpaces',
  'detectIndentation', 'autoSaveMode', 'autoSaveDelayMs', 'scrollBeyondLastLine', 'mouseWheelZoom',
  'inlineBlame', 'terminalScrollback', 'terminalDefaultProfile',
];
const LEGACY_EDITOR_KEYS = [
  'wordWrap', 'fontSize', 'tabSize', 'minimap', 'lineNumbers', 'renderWhitespace', 'eol',
  'formatOnSave', 'trimTrailingWhitespace', 'insertFinalNewline', 'rulers',
];
const EDITOR_KEYS = [...LEGACY_EDITOR_KEYS, ...ROW82_KEYS, 'autoSaveEnabled'];

const INPUTS = {
  empty: {},
  legacyAutoSaveOn: { autoSaveEnabled: true },
  explicitOffWithStaleBoolean: { autoSaveMode: 'off', autoSaveEnabled: true },
  everyMode: { autoSaveMode: 'onWindowChange', autoSaveEnabled: false },
  invalidMode: { autoSaveMode: 'sometimes', autoSaveEnabled: 'yes' },
  invalidModeLegacyTrue: { autoSaveMode: 42, autoSaveEnabled: true },
  delayLow: { autoSaveDelayMs: 1 },
  delayHigh: { autoSaveDelayMs: 1e12 },
  delayNaN: { autoSaveDelayMs: NaN },
  delayInfinity: { autoSaveDelayMs: Infinity },
  delayString: { autoSaveDelayMs: '2500' },
  delayBlankString: { autoSaveDelayMs: '  ' },
  delayNull: { autoSaveDelayMs: null },
  delayFraction: { autoSaveDelayMs: 250.9 },
  delayBool: { autoSaveDelayMs: true },
  scrollbackLow: { terminalScrollback: -5 },
  scrollbackHigh: { terminalScrollback: 5e9 },
  scrollbackGarbage: { terminalScrollback: 'lots' },
  scrollbackOk: { terminalScrollback: 20000 },
  fontFamilyOk: { fontFamily: ' "Fira Code", \'JetBrains Mono\', monospace ' },
  fontFamilyHostile: { fontFamily: 'a;b{color:red}' },
  fontFamilyInjection: { fontFamily: 'x</style><script>' },
  fontFamilyTooLong: { fontFamily: 'a'.repeat(201) },
  fontFamilyMaxLen: { fontFamily: 'a'.repeat(200) },
  fontFamilyNonString: { fontFamily: ['Fira'] },
  fontFamilyBlank: { fontFamily: '   ' },
  fontFamilyUnicode: { fontFamily: 'Fira Cöde' },
  profileOk: { terminalDefaultProfile: 'git-bash' },
  profileUpper: { terminalDefaultProfile: 'Pwsh' },
  profileSpace: { terminalDefaultProfile: 'git bash' },
  profileSlash: { terminalDefaultProfile: '../etc' },
  profileLong: { terminalDefaultProfile: 'p'.repeat(33) },
  profileMaxLen: { terminalDefaultProfile: 'p'.repeat(32) },
  profileNonString: { terminalDefaultProfile: 7 },
  enumsOk: { cursorStyle: 'underline', cursorBlinking: 'expand' },
  enumsBad: { cursorStyle: 'BLOCK', cursorBlinking: 'wobble' },
  enumsNonString: { cursorStyle: 1, cursorBlinking: null },
  boolsFalse: Object.fromEntries(['cursorSmoothCaretAnimation', 'fontLigatures', 'bracketPairColorization',
    'indentGuides', 'stickyScroll', 'folding', 'insertSpaces', 'detectIndentation', 'mouseWheelZoom',
    'inlineBlame'].map((key) => [key, false])),
  boolsTruthyJunk: Object.fromEntries(['cursorSmoothCaretAnimation', 'fontLigatures', 'bracketPairColorization',
    'indentGuides', 'stickyScroll', 'folding', 'insertSpaces', 'detectIndentation', 'mouseWheelZoom',
    'inlineBlame'].map((key) => [key, 0])),
  scrollBeyondTrue: { scrollBeyondLastLine: true },
  scrollBeyondJunk: { scrollBeyondLastLine: 'true' },
  legacyHostile: {
    wordWrap: 'sideways', fontSize: 'huge', tabSize: 3, minimap: 'maybe', lineNumbers: 'relative',
    renderWhitespace: 'sometimes', eol: 'cr', formatOnSave: 'yes', trimTrailingWhitespace: 1,
    insertFinalNewline: 'true', rulers: [-1, 0, 600, 'x', 90],
  },
  legacyValid: {
    wordWrap: 'on', fontSize: 18, tabSize: 4, minimap: false, lineNumbers: 'off', renderWhitespace: 'all',
    eol: 'crlf', formatOnSave: true, trimTrailingWhitespace: true, insertFinalNewline: true, rulers: [120, 80, 80],
  },
};

function pickEditorKeys(prefs) {
  return Object.fromEntries(EDITOR_KEYS.map((key) => [key, prefs[key]]));
}

for (const [name, input] of Object.entries(INPUTS)) {
  test(`renderer and service editor-pref normalizers agree: ${name}`, () => {
    const renderer = pickEditorKeys(rendererIdeState.normalizeEditorPrefs(input));
    const service = pickEditorKeys(normalizeWorkspaceIdePreferences(input));
    assert.deepEqual(renderer, service);
    assert.equal(renderer.autoSaveEnabled, renderer.autoSaveMode !== 'off', 'mirror always derives from the mode');
  });
}

test('D1: renderer and service share one scrollback ceiling, 25,000, and clamp a stored 100,000 to it', () => {
  for (const [input, expected] of [[100000, 25000], [25000, 25000], [25001, 25000], [24999, 24999]]) {
    assert.equal(rendererIdeState.normalizeEditorPrefs({ terminalScrollback: input }).terminalScrollback, expected, `renderer ${input}`);
    assert.equal(normalizeWorkspaceIdePreferences({ terminalScrollback: input }).terminalScrollback, expected, `service ${input}`);
  }
});

test('renderer fresh-state defaults equal the service defaults for every editor-pref key', () => {
  const ide = rendererIdeState.createIdeUiState();
  const service = pickEditorKeys(normalizeWorkspaceIdePreferences({}));
  assert.deepEqual(pickEditorKeys(ide), service);
  assert.deepEqual(pickEditorKeys(DEFAULT_WORKSPACE_IDE), service);
});

test('non-object inputs normalize identically on both sides', () => {
  for (const input of [null, undefined, 'x', 5, []]) {
    const renderer = pickEditorKeys(rendererIdeState.normalizeEditorPrefs(input && typeof input === 'object' ? input : {}));
    const service = pickEditorKeys(normalizeWorkspaceIdePreferences(input === null ? undefined : input));
    assert.deepEqual(renderer, service);
  }
});
