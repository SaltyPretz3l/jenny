const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CONTEXT_PREFERENCES,
  inspectContextPreferences,
  normalizeContextPreferences,
  normalizeHistoryScope,
} = require('../services/backend/context-preferences');

/* ── normalizeHistoryScope ── */

test('normalizeHistoryScope accepts valid scopes', () => {
  assert.equal(normalizeHistoryScope('session'), 'session');
  assert.equal(normalizeHistoryScope('recent'), 'recent');
  assert.equal(normalizeHistoryScope('fresh'), 'fresh');
});

test('normalizeHistoryScope is case-insensitive', () => {
  assert.equal(normalizeHistoryScope('SESSION'), 'session');
  assert.equal(normalizeHistoryScope('Recent'), 'recent');
  assert.equal(normalizeHistoryScope('FRESH'), 'fresh');
});

test('normalizeHistoryScope trims whitespace', () => {
  assert.equal(normalizeHistoryScope('  session  '), 'session');
});

test('normalizeHistoryScope falls back to default for empty', () => {
  assert.equal(normalizeHistoryScope(''), DEFAULT_CONTEXT_PREFERENCES.history_scope);
  assert.equal(normalizeHistoryScope(null), DEFAULT_CONTEXT_PREFERENCES.history_scope);
  assert.equal(normalizeHistoryScope(undefined), DEFAULT_CONTEXT_PREFERENCES.history_scope);
});

test('normalizeHistoryScope returns fresh for unknown values', () => {
  assert.equal(normalizeHistoryScope('unknown'), 'fresh');
  assert.equal(normalizeHistoryScope('full'), 'fresh');
});

/* ── normalizeContextPreferences ── */

test('normalizeContextPreferences returns defaults for empty input', () => {
  const result = normalizeContextPreferences({});
  assert.deepEqual(result, DEFAULT_CONTEXT_PREFERENCES);
});

test('normalizeContextPreferences returns defaults for null', () => {
  const result = normalizeContextPreferences(null);
  assert.deepEqual(result, DEFAULT_CONTEXT_PREFERENCES);
});

test('normalizeContextPreferences returns defaults for array', () => {
  const result = normalizeContextPreferences([]);
  assert.deepEqual(result, DEFAULT_CONTEXT_PREFERENCES);
});

test('normalizeContextPreferences normalizes valid input', () => {
  const result = normalizeContextPreferences({
    history_scope: 'recent',
    include_personality: false,
    include_memory: false,
  });
  assert.equal(result.history_scope, 'recent');
  assert.equal(result.include_personality, false);
  assert.equal(result.include_memory, false);
});

test('normalizeContextPreferences accepts camelCase aliases', () => {
  const result = normalizeContextPreferences({
    historyScope: 'fresh',
    includePersonality: false,
    includeMemory: false,
  });
  assert.equal(result.history_scope, 'fresh');
  assert.equal(result.include_personality, false);
  assert.equal(result.include_memory, false);
});

test('normalizeContextPreferences prefers snake_case over camelCase', () => {
  const result = normalizeContextPreferences({
    history_scope: 'session',
    historyScope: 'fresh',
    include_personality: true,
    includePersonality: false,
  });
  assert.equal(result.history_scope, 'session');
  assert.equal(result.include_personality, true);
});

test('normalizeContextPreferences falls back booleans for non-boolean values', () => {
  const result = normalizeContextPreferences({
    include_personality: 'yes',
    include_memory: 1,
  });
  assert.equal(result.include_personality, DEFAULT_CONTEXT_PREFERENCES.include_personality);
  assert.equal(result.include_memory, DEFAULT_CONTEXT_PREFERENCES.include_memory);
});

/* ── inspectContextPreferences ── */

test('inspectContextPreferences returns warnings for invalid values', () => {
  const { normalized, warnings } = inspectContextPreferences({
    history_scope: 'invalid_scope',
    include_personality: 'not_boolean',
    include_memory: 42,
  });
  assert.equal(normalized.history_scope, 'fresh');
  assert.ok(warnings.some((w) => w.includes('history_scope')));
  assert.ok(warnings.some((w) => w.includes('include_personality')));
  assert.ok(warnings.some((w) => w.includes('include_memory')));
});

test('inspectContextPreferences returns no warnings for valid input', () => {
  const { warnings } = inspectContextPreferences({
    history_scope: 'session',
    include_personality: true,
    include_memory: false,
  });
  assert.equal(warnings.length, 0);
});

test('inspectContextPreferences does not warn for missing keys', () => {
  const { warnings } = inspectContextPreferences({});
  assert.equal(warnings.length, 0);
});

test('normalizeContextPreferences drops retired research compatibility keys', () => {
  const result = normalizeContextPreferences({
    include_research_mode: true,
    includeResearchMode: true,
  });
  assert.equal(Object.hasOwn(result, 'include_research_mode'), false);
  assert.equal(Object.hasOwn(result, 'includeResearchMode'), false);
});

/* ── include_codebase_context ── */

test('normalizeContextPreferences defaults include_codebase_context to true', () => {
  const result = normalizeContextPreferences({});
  assert.equal(result.include_codebase_context, true);
});

test('normalizeContextPreferences preserves include_codebase_context false', () => {
  const result = normalizeContextPreferences({ include_codebase_context: false });
  assert.equal(result.include_codebase_context, false);
});

test('normalizeContextPreferences accepts camelCase includeCodebaseContext', () => {
  const result = normalizeContextPreferences({ includeCodebaseContext: false });
  assert.equal(result.include_codebase_context, false);
});

test('normalizeContextPreferences prefers snake_case include_codebase_context over camelCase', () => {
  const result = normalizeContextPreferences({
    include_codebase_context: true,
    includeCodebaseContext: false,
  });
  assert.equal(result.include_codebase_context, true);
});

test('inspectContextPreferences warns on non-boolean include_codebase_context', () => {
  const { warnings } = inspectContextPreferences({ include_codebase_context: 'yes' });
  assert.ok(warnings.some((w) => w.includes('include_codebase_context')));
});

test('inspectContextPreferences does not warn for boolean include_codebase_context', () => {
  const { warnings } = inspectContextPreferences({ include_codebase_context: false });
  assert.ok(!warnings.some((w) => w.includes('include_codebase_context')));
});

/* ── include_active_file_context ── */

test('normalizeContextPreferences defaults include_active_file_context to true', () => {
  const result = normalizeContextPreferences({});
  assert.equal(result.include_active_file_context, true);
});

test('normalizeContextPreferences preserves include_active_file_context false', () => {
  const result = normalizeContextPreferences({ include_active_file_context: false });
  assert.equal(result.include_active_file_context, false);
});

test('normalizeContextPreferences accepts camelCase includeActiveFileContext', () => {
  const result = normalizeContextPreferences({ includeActiveFileContext: false });
  assert.equal(result.include_active_file_context, false);
});

test('normalizeContextPreferences prefers snake_case include_active_file_context over camelCase', () => {
  const result = normalizeContextPreferences({
    include_active_file_context: true,
    includeActiveFileContext: false,
  });
  assert.equal(result.include_active_file_context, true);
});

test('inspectContextPreferences warns on non-boolean include_active_file_context', () => {
  const { warnings } = inspectContextPreferences({ include_active_file_context: 'yes' });
  assert.ok(warnings.some((w) => w.includes('include_active_file_context')));
});

test('inspectContextPreferences does not warn for boolean include_active_file_context', () => {
  const { warnings } = inspectContextPreferences({ include_active_file_context: false });
  assert.ok(!warnings.some((w) => w.includes('include_active_file_context')));
});
