'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const manifest = require('../services/tools/tool-manifest.json');
const { evaluatePolicy } = require('../services/tools/tool-policy-evaluator');
const {
  ToolPermissionStore,
  normalizeToolName,
} = require('../services/tools/tool-permission-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

function createTempPath(prefix = 'jenny-perm-') {
  return path.join(createTrackedTempDir(prefix), 'tool-permissions.json');
}

function createTempStore() {
  const filePath = createTempPath();
  return { store: new ToolPermissionStore(filePath), filePath };
}

function createLogCollector() {
  const entries = [];
  return {
    entries,
    logger(level, event, details) { entries.push({ level, event, details }); },
  };
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('ToolPermissionStore', () => {
  test('normalizeToolName safely handles aliases and prototype names', () => {
    assert.equal(normalizeToolName('Read'), 'read_file');
    assert.equal(normalizeToolName('constructor'), 'constructor');
    assert.equal(normalizeToolName('__proto__'), '__proto__');
  });

  test('defaults contain only current canonical manifest tools', () => {
    const { store } = createTempStore();
    const toolNames = new Set(manifest.tools.map((tool) => tool.name));
    assert.deepEqual(store.getDefaults(), {
      read_file: 'auto', glob_files: 'auto', grep_search: 'auto', write_file: 'ask',
      edit_file: 'ask', run_command: 'ask', create_artifact: 'ask',
    });
    for (const name of Object.keys(store.getDefaults())) assert.equal(toolNames.has(name), true);
  });

  test('global deny and ask decisions persist with schema metadata', () => {
    const { store, filePath } = createTempStore();
    store.setPolicy('write_file', 'deny');
    store.setPolicy('Bash', 'ask');

    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(persisted.schema_version, 2);
    assert.ok(persisted.migration.migrated_at);
    assert.deepEqual(persisted.legacy_policies, { write_file: 'deny', run_command: 'ask' });
    const reopened = new ToolPermissionStore(filePath);
    assert.equal(reopened.getPolicy('write_file'), 'deny');
    assert.equal(reopened.getPolicy('run_command'), 'ask');
    assert.equal(reopened.getAllPolicies().read_file, 'auto');
  });

  test('invalid decisions and malformed composite tool names are refused', () => {
    const { store } = createTempStore();
    assert.throws(() => store.setPolicy('read_file', 'maybe'), /Invalid tool policy/);
    assert.throws(() => store.setPolicy('lsp:', 'deny'), /composite/i);
    assert.throws(() => store.setPolicy('lsp:hover:extra', 'deny'), /composite/i);
    assert.throws(() => store.setPolicy(`lsp:${'a'.repeat(65)}`, 'deny'), /composite/i);
    assert.throws(() => store.setPolicy('lsp:ho ver', 'deny'), /composite/i);
    assert.throws(() => store.setPolicy('lsp:ho\u0000ver', 'deny'), /composite/i);
    assert.doesNotThrow(() => store.setPolicy(`lsp:${'a'.repeat(64)}`, 'ask'));
  });

  test('legacy flat maps migrate autos to review while preserving denials', () => {
    const filePath = createTempPath();
    fs.writeFileSync(filePath, JSON.stringify({ Read: 'auto', Bash: 'deny' }), 'utf8');
    const store = new ToolPermissionStore(filePath);

    assert.deepEqual(store.getSnapshot().legacy_policies, { run_command: 'deny' });
    assert.equal(store.getReviewState().pending_count, 1);
    assert.equal(store.getReviewState().pending[0].tool_name, 'read_file');
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(persisted.schema_version, 2);
    assert.equal(persisted.migration.source_format, 'legacy_flatmap');
  });

  test('inline documents preserve policy version, deny rules, and retirement notices', () => {
    const filePath = createTempPath();
    fs.writeFileSync(filePath, JSON.stringify({
      version: 3,
      legacy_policies: { run_command: 'deny', lsp_symbols: 'auto' },
      rules: [
        { id: 'blanket_auto_approve', decision: 'auto', match: {}, reason: 'old blanket' },
        { id: 'deny-prod', decision: 'deny', match: { path_prefix: 'prod/' }, reason: 'blocked' },
      ],
    }), 'utf8');
    const store = new ToolPermissionStore(filePath);
    const snapshot = store.getSnapshot();

    assert.equal(snapshot.version, 3);
    assert.equal(snapshot.legacy_policies.run_command, 'deny');
    assert.ok(snapshot.rules.some((rule) => rule.id === 'deny-prod'));
    assert.equal(store.getReviewState().pending[0].tool_name, 'lsp:symbols');
    assert.equal(store.consumeBlanketRuleRetiredNotice(), true);
    assert.equal(store.consumeBlanketRuleRetiredNotice(), false);
  });

  test('retired inspect denial stays inert history and raises a one-time notice', () => {
    const filePath = createTempPath();
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      legacy_policies: { image_inspect: 'deny', browser_eval: 'ask' },
      rules: [],
    }), 'utf8');
    const store = new ToolPermissionStore(filePath);

    assert.deepEqual(store.getSnapshot().legacy_policies, {});
    assert.equal(store.getReviewState().history.length, 2);
    assert.equal(store.consumeRetiredInspectDenyNotice(), true);
    assert.equal(store.consumeRetiredInspectDenyNotice(), false);
  });

  test('retired rule grants remain inert history while live denials survive', () => {
    const filePath = createTempPath();
    fs.writeFileSync(filePath, JSON.stringify({
      schema_version: 1,
      version: 1,
      legacy_policies: {},
      rules: [
        { id: 'retired-browser', decision: 'auto', match: { tool_id: 'browser_open' }, reason: 'old' },
        { id: 'retired-pdf-deny', decision: 'deny', match: { tool_id: 'pdf_inspect' }, reason: 'old deny' },
        { id: 'live-deny', decision: 'deny', match: { tool_id: 'read_secret' }, reason: 'keep' },
      ],
    }), 'utf8');
    const store = new ToolPermissionStore(filePath);

    assert.deepEqual(store.getSnapshot().rules.map((rule) => rule.id), ['live-deny']);
    assert.deepEqual(
      store.getReviewState().history.map((record) => record.decision),
      ['retired', 'retired']
    );
    assert.equal(store.consumeRetiredInspectDenyNotice(), true);
  });

  test('legacy lsp policy and rule names migrate without widening decisions', () => {
    const filePath = createTempPath();
    fs.writeFileSync(filePath, JSON.stringify({
      schema_version: 1,
      version: 3,
      legacy_policies: { lsp_diagnostics: 'deny' },
      rules: [
        {
          id: 'lsp-definition-deny', decision: 'deny', reason: 'keep deny',
          match: { tool_id: 'lsp_definition' },
        },
        {
          id: 'lsp-references-auto', decision: 'auto', reason: 'review auto',
          match: { tool_id: 'lsp_references' },
        },
      ],
    }), 'utf8');
    const store = new ToolPermissionStore(filePath);

    assert.equal(store.getSnapshot().legacy_policies['lsp:diagnostics'], 'deny');
    assert.equal(store.getSnapshot().rules[0].match.tool_id, 'lsp');
    assert.equal(store.getSnapshot().rules[0].match.action, 'definition');
    assert.equal(store.getReviewState().pending[0].tool_name, 'lsp:references');
  });

  test('corrupt JSON preserves bytes, exposes read-only state, and denies all tools', () => {
    const filePath = createTempPath('jenny-perm-corrupt-');
    const original = '{bad json';
    fs.writeFileSync(filePath, original, 'utf8');
    const logs = createLogCollector();
    const store = new ToolPermissionStore(filePath, { logger: logs.logger });

    const snapshot = store.getSnapshot();
    for (const descriptor of [
      { name: 'read_file', read_only: true, side_effecting: false },
      { name: 'write_file', read_only: false, side_effecting: true },
    ]) {
      const result = evaluatePolicy({ descriptor, snapshot });
      assert.equal(result.decision, 'deny');
      assert.equal(result.matched_rule_id, 'permission-store-unavailable');
    }
    assert.equal(store.getReviewState().read_only_reason, 'unreadable_or_corrupt');
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
    assert.ok(logs.entries.some((entry) => entry.event === 'store.corrupted'));
  });
});
