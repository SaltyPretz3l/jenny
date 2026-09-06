'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ToolPermissionStore,
  normalizeToolName,
} = require('../services/tools/tool-permission-store');
const toolManifest = require('../services/tools/tool-manifest.json');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

function createTempStore() {
  const dir = createTrackedTempDir('jenny-perm-');
  const filePath = path.join(dir, 'tool-permissions.json');
  return { store: new ToolPermissionStore(filePath), dir, filePath };
}

function createLogCollector() {
  const entries = [];
  return {
    entries,
    logger(level, event, details = {}) {
      entries.push({ level, event, details });
    },
  };
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('ToolPermissionStore', () => {
  test('normalizeToolName returns strings for Object.prototype property names', () => {
    assert.equal(normalizeToolName('toString'), 'toString');
    assert.equal(normalizeToolName('constructor'), 'constructor');
  });

  test('getDefaults returns expected default policies', () => {
    const { store } = createTempStore();
    const defaults = store.getDefaults();
    assert.equal(defaults.read_file, 'auto');
    assert.equal(defaults.glob_files, 'auto');
    assert.equal(defaults.grep_search, 'auto');
    assert.equal(defaults.write_file, 'ask');
    assert.equal(defaults.edit_file, 'ask');
    assert.equal(defaults.run_command, 'ask');
    assert.equal(defaults.create_artifact, 'ask');
  });

  test('default permission policies map only to canonical manifest tools', () => {
    const { store } = createTempStore();
    const registeredNames = new Set(toolManifest.tools.map((tool) => tool.name));

    for (const toolName of Object.keys(store.getDefaults())) {
      assert.equal(registeredNames.has(toolName), true, `${toolName} should be registered`);
    }
    assert.equal(Object.hasOwn(store.getDefaults(), 'mermaid_generate'), false);
  });

  test('getPolicy returns undefined when no policy is stored', () => {
    const { store } = createTempStore();
    assert.equal(store.getPolicy('read_file'), undefined);
  });

  test('setPolicy persists and getPolicy reads back', () => {
    const { store } = createTempStore();
    store.setPolicy('write_file', 'auto');
    assert.equal(store.getPolicy('write_file'), 'auto');
  });

  test('setPolicy rejects invalid policy strings', () => {
    const { store } = createTempStore();
    assert.throws(
      () => store.setPolicy('read_file', 'invalid'),
      /Invalid tool policy/
    );
  });

  test('getAllPolicies merges stored over defaults', () => {
    const { store } = createTempStore();
    store.setPolicy('write_file', 'auto');
    store.setPolicy('run_command', 'deny');
    const all = store.getAllPolicies();
    assert.equal(all.read_file, 'auto');    // default
    assert.equal(all.write_file, 'auto');   // overridden
    assert.equal(all.run_command, 'deny');  // overridden
    assert.equal(all.edit_file, 'ask');     // default
  });

  test('rule-list snapshots preserve rules when updating legacy policies', () => {
    const { store, filePath } = createTempStore();
    fs.writeFileSync(filePath, JSON.stringify({
      version: 3,
      legacy_policies: {
        read_file: 'deny',
      },
      rules: [
        {
          id: 'deny-prod',
          decision: 'deny',
          reason: 'prod writes blocked',
          match: { tool_id: 'write_file', path_prefix: 'prod/' },
        },
      ],
    }), 'utf8');

    assert.equal(store.getAllPolicies().read_file, 'deny');

    store.setPolicy('write_file', 'auto');
    const snapshot = store.getSnapshot();

    assert.equal(snapshot.version, 3);
    assert.equal(snapshot.legacy_policies.read_file, 'deny');
    assert.equal(snapshot.legacy_policies.write_file, 'auto');
    // The legacy read_file deny is materialized as a synthetic deny rule so
    // it keeps winning against blanket auto-approve; the stored rule stays
    // first and the synthetic rule is never persisted.
    assert.equal(snapshot.rules.length, 2);
    assert.equal(snapshot.rules[0].id, 'deny-prod');
    assert.equal(snapshot.rules[1].id, 'legacy_deny:read_file');
    assert.equal(snapshot.rules[1].decision, 'deny');
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(persisted.rules.length, 1);
    assert.equal(persisted.rules[0].id, 'deny-prod');
  });

  test('snapshots normalize legacy aliases and bound malformed rule-list documents', () => {
    const { store, filePath } = createTempStore();
    fs.writeFileSync(filePath, JSON.stringify({
      version: -5,
      legacy_policies: {
        Read: 'deny',
      },
      rules: [
        {
          id: `deny-prod-${'x'.repeat(120)}`,
          decision: 'deny',
          reason: `block prod\n${'r'.repeat(400)}`,
          match: {
            tool_id: `write_file_${'n'.repeat(200)}`,
            path_prefix: `C:\\workspace\\${'p'.repeat(2000)}`,
          },
        },
      ],
    }), 'utf8');

    const snapshot = store.getSnapshot();

    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.legacy_policies.read_file, 'deny');
    assert.equal(snapshot.rules[0].id.length, 80);
    assert.equal(snapshot.rules[0].reason.length, 240);
    assert.equal(snapshot.rules[0].match.tool_id.length, 160);
    assert.equal(snapshot.rules[0].match.path_prefix.length, 1024);
  });

  test('persistence survives new store instance', () => {
    const dir = createTrackedTempDir('jenny-perm-');
    const filePath = path.join(dir, 'tool-permissions.json');
    const store1 = new ToolPermissionStore(filePath);
    store1.setPolicy('write_file', 'deny');

    const store2 = new ToolPermissionStore(filePath);
    assert.equal(store2.getPolicy('write_file'), 'deny');
  });

  test('legacy tool names normalize to canonical policy keys', () => {
    const { store } = createTempStore();
    store.setPolicy('Bash', 'deny');

    assert.equal(store.getPolicy('run_command'), 'deny');
    assert.equal(store.getAllPolicies().run_command, 'deny');
  });

  test('persisted blanket rules migrate away while explicit denies survive', () => {
    const { evaluatePolicy } = require('../services/tools/tool-policy-evaluator');
    const { store, filePath } = createTempStore();
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      legacy_policies: { run_command: 'deny' },
      rules: [
        { id: 'blanket_auto_approve', decision: 'auto', reason: 'legacy blanket', match: {} },
        { id: 'deny-secrets', decision: 'deny', reason: 'secrets blocked', match: { tool_id: 'read_secret' } },
      ],
    }), 'utf8');
    const migratedStore = new ToolPermissionStore(filePath);
    const snapshot = migratedStore.getSnapshot();

    const writeDecision = evaluatePolicy({
      descriptor: { name: 'write_file', side_effecting: true },
      snapshot,
    });
    assert.equal(writeDecision.decision, 'ask');
    assert.equal(migratedStore.consumeBlanketRuleRetiredNotice(), true);

    // Explicit deny rule still wins over the blanket auto rule.
    const secretDecision = evaluatePolicy({
      descriptor: { name: 'read_secret', side_effecting: true },
      snapshot,
    });
    assert.equal(secretDecision.decision, 'deny');

    // Legacy per-tool deny is materialized as a rule, so it wins too.
    const shellDecision = evaluatePolicy({
      descriptor: { name: 'run_command', side_effecting: true },
      snapshot,
    });
    assert.equal(shellDecision.decision, 'deny');
    assert.equal(shellDecision.matched_rule_id, 'legacy_deny:run_command');
  });

  test('corrupted permission JSON recovers to defaults and logs diagnostics', () => {
    const dir = createTrackedTempDir('jenny-perm-corrupt-');
    const filePath = path.join(dir, 'tool-permissions.json');
    fs.writeFileSync(filePath, '{bad json', 'utf8');
    const logs = createLogCollector();
    const store = new ToolPermissionStore(filePath, { logger: logs.logger });

    assert.equal(store.getAllPolicies().read_file, 'auto');
    const entry = logs.entries.find((item) => item.event === 'store.corrupted');
    assert.ok(entry);
    assert.equal(entry.level, 'WARN');
    assert.equal(entry.details.filePath, filePath);
  });
});

// W7a-S5: retired-tool grant pruning (browser_*, apply_patch, *_inspect).
// Never-widening doctrine: pruning may only REMOVE grants; a persisted
// *_inspect deny surfaces as a consume-once notice so composition can turn
// the folded rich-files capability off in shell config instead of silently
// widening a per-type denial into an allow.
describe('ToolPermissionStore retired-tool grant pruning', () => {
  function writeDoc(doc) {
    const dir = createTrackedTempDir('jenny-perm-prune-');
    const filePath = path.join(dir, 'tool-permissions.json');
    fs.writeFileSync(filePath, JSON.stringify(doc), 'utf8');
    return filePath;
  }

  test('retired legacy_policies entries are pruned from disk at construction', () => {
    const filePath = writeDoc({
      version: 1,
      legacy_policies: {
        browser_click: 'auto',
        apply_patch: 'ask',
        document_inspect: 'auto',
        read_file: 'auto',
      },
      rules: [],
    });
    const store = new ToolPermissionStore(filePath);
    const snapshot = store.getSnapshot();
    assert.deepEqual(snapshot.legacy_policies, { read_file: 'auto' });
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepEqual(persisted.legacy_policies, { read_file: 'auto' });
  });

  test('rules whose match.tool_id is a retired tool are pruned; others survive', () => {
    const filePath = writeDoc({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'keep_me',
          decision: 'auto',
          match: { tool_id: 'read_file' },
          reason: 'live tool',
        },
        {
          id: 'retired_browser',
          decision: 'auto',
          match: { tool_id: 'browser_open' },
          reason: 'retired tool',
        },
        {
          id: 'retired_patch',
          decision: 'ask',
          match: { tool_id: 'apply_patch' },
          reason: 'retired tool',
        },
      ],
    });
    const store = new ToolPermissionStore(filePath);
    const ruleIds = store.getSnapshot().rules.map((rule) => rule.id);
    assert.deepEqual(ruleIds, ['keep_me']);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepEqual(persisted.rules.map((rule) => rule.id), ['keep_me']);
  });

  test('legacy flat-map documents also get retired entries pruned', () => {
    const filePath = writeDoc({
      browser_screenshot: 'auto',
      spreadsheet_inspect: 'deny',
      write_file: 'ask',
    });
    const store = new ToolPermissionStore(filePath);
    assert.deepEqual(store.getSnapshot().legacy_policies, { write_file: 'ask' });
  });

  test('a document with no retired grants is not rewritten', () => {
    const filePath = writeDoc({
      version: 1,
      legacy_policies: { read_file: 'auto' },
      rules: [],
    });
    const before = fs.readFileSync(filePath, 'utf8');
    const store = new ToolPermissionStore(filePath);
    assert.equal(store.getSnapshot().legacy_policies.read_file, 'auto');
    assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  });

  test('a persisted *_inspect deny raises the consume-once notice', () => {
    const filePath = writeDoc({
      version: 1,
      legacy_policies: { image_inspect: 'deny' },
      rules: [],
    });
    const store = new ToolPermissionStore(filePath);
    assert.equal(store.consumeRetiredInspectDenyNotice(), true);
    assert.equal(store.consumeRetiredInspectDenyNotice(), false);
  });

  test('a pruned deny RULE on an *_inspect tool raises the notice', () => {
    const filePath = writeDoc({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'inspect_deny',
          decision: 'deny',
          match: { tool_id: 'pdf_inspect' },
          reason: 'user denied pdf inspection',
        },
      ],
    });
    const store = new ToolPermissionStore(filePath);
    assert.equal(store.consumeRetiredInspectDenyNotice(), true);
  });

  test('retired non-inspect denials do not raise the inspect notice', () => {
    const filePath = writeDoc({
      version: 1,
      legacy_policies: { browser_eval: 'deny', apply_patch: 'deny' },
      rules: [],
    });
    const store = new ToolPermissionStore(filePath);
    assert.equal(store.consumeRetiredInspectDenyNotice(), false);
    assert.deepEqual(store.getSnapshot().legacy_policies, {});
  });

  test('pruned retired denies are not resurrected as legacy deny rules', () => {
    const filePath = writeDoc({
      version: 1,
      legacy_policies: { browser_eval: 'deny', run_command: 'deny' },
      rules: [],
    });
    const store = new ToolPermissionStore(filePath);
    const ruleIds = store.getSnapshot().rules.map((rule) => rule.id);
    assert.deepEqual(ruleIds, ['legacy_deny:run_command']);
  });
});

// W7b-S4: retired lsp_* per-tool grants migrate at construction to composite
// `lsp:<action>` keys through the S3-validated grammar — never widening: a
// deny on any lsp_* must map to a deny that still binds on that action.
describe('ToolPermissionStore lsp grant migration', () => {
  function writeDoc(doc) {
    const dir = createTrackedTempDir('jenny-perm-lsp-');
    const filePath = path.join(dir, 'tool-permissions.json');
    fs.writeFileSync(filePath, JSON.stringify(doc), 'utf8');
    return filePath;
  }

  test('legacy lsp_* policies migrate to composite lsp:action keys on disk', () => {
    const filePath = writeDoc({
      version: 1,
      legacy_policies: {
        lsp_diagnostics: 'deny',
        lsp_symbols: 'auto',
        lsp_definition: 'ask',
        lsp_references: 'auto',
        read_file: 'auto',
      },
      rules: [],
    });
    const store = new ToolPermissionStore(filePath);
    const expected = {
      'lsp:diagnostics': 'deny',
      'lsp:symbols': 'auto',
      'lsp:definition': 'ask',
      'lsp:references': 'auto',
      read_file: 'auto',
    };
    assert.deepEqual(store.getSnapshot().legacy_policies, expected);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepEqual(persisted.legacy_policies, expected);
  });

  test('rules with retired lsp tool_ids migrate to composite tool_ids', () => {
    const filePath = writeDoc({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'lsp_deny',
          decision: 'deny',
          match: { tool_id: 'lsp_definition' },
          reason: 'owner deny',
        },
        {
          id: 'keep_me',
          decision: 'auto',
          match: { tool_id: 'read_file' },
          reason: 'live tool',
        },
      ],
    });
    const store = new ToolPermissionStore(filePath);
    const rules = store.getSnapshot().rules;
    const migrated = rules.find((rule) => rule.id === 'lsp_deny');
    assert.ok(migrated, 'the deny rule must survive migration');
    assert.equal(migrated.match.tool_id, 'lsp:definition');
    assert.equal(migrated.decision, 'deny');
    assert.ok(rules.find((rule) => rule.id === 'keep_me'));
  });

  test('legacy flat-map documents also get lsp grants migrated', () => {
    const filePath = writeDoc({
      lsp_references: 'deny',
      write_file: 'ask',
    });
    const store = new ToolPermissionStore(filePath);
    assert.equal(store.getSnapshot().legacy_policies['lsp:references'], 'deny');
    assert.equal(store.getSnapshot().legacy_policies.lsp_references, undefined);
    assert.equal(store.getSnapshot().legacy_policies.write_file, 'ask');
  });

  test('migration is idempotent and write-only-on-change', () => {
    const filePath = writeDoc({
      version: 1,
      legacy_policies: { 'lsp:diagnostics': 'deny', read_file: 'auto' },
      rules: [],
    });
    const before = fs.statSync(filePath).mtimeMs;
    const store = new ToolPermissionStore(filePath);
    assert.equal(store.getSnapshot().legacy_policies['lsp:diagnostics'], 'deny');
    const after = fs.statSync(filePath).mtimeMs;
    assert.equal(after, before, 'an already-migrated document must not be rewritten');
  });
});

// W7b-S3(b): composite `tool:action` grant keys respect the injective grammar
// (tool segment colon-free + non-empty; action segment mirroring
// parse_tool_actions limits: 1..64 chars, colon-free, no whitespace or
// non-printable characters). Malformed composite writes are REFUSED with a
// throw, like the existing invalid-policy throw; bare tool names are
// unchanged.
describe('ToolPermissionStore composite grant grammar', () => {
  test('well-formed composite key writes through setPolicy and persists', () => {
    const { store, filePath } = createTempStore();
    store.setPolicy('lsp:hover', 'deny');
    assert.equal(store.getPolicy('lsp:hover'), 'deny');
    const reopened = new ToolPermissionStore(filePath);
    assert.equal(reopened.getPolicy('lsp:hover'), 'deny');
  });

  test('composite action segment at the 64-char boundary is accepted', () => {
    const { store } = createTempStore();
    const action = 'a'.repeat(64);
    store.setPolicy(`lsp:${action}`, 'auto');
    assert.equal(store.getPolicy(`lsp:${action}`), 'auto');
  });

  test('composite key with an empty tool segment is refused', () => {
    const { store } = createTempStore();
    assert.throws(() => store.setPolicy(':hover', 'deny'), /composite/i);
  });

  test('composite key with an empty action segment is refused', () => {
    const { store } = createTempStore();
    assert.throws(() => store.setPolicy('lsp:', 'deny'), /composite/i);
  });

  test('composite key with a colon inside the action segment is refused', () => {
    const { store } = createTempStore();
    assert.throws(() => store.setPolicy('lsp:hover:extra', 'deny'), /composite/i);
  });

  test('composite action segment over 64 chars is refused', () => {
    const { store } = createTempStore();
    assert.throws(
      () => store.setPolicy(`lsp:${'a'.repeat(65)}`, 'deny'),
      /composite/i
    );
  });

  test('composite action segment containing whitespace is refused', () => {
    const { store } = createTempStore();
    assert.throws(() => store.setPolicy('lsp:ho ver', 'deny'), /composite/i);
  });

  test('composite action segment containing non-printable chars is refused', () => {
    const { store } = createTempStore();
    assert.throws(() => store.setPolicy('lsp:ho\u0000ver', 'deny'), /composite/i);
  });

  test('a refused composite write leaves the store untouched', () => {
    const { store, filePath } = createTempStore();
    store.setPolicy('write_file', 'deny');
    assert.throws(() => store.setPolicy('lsp:', 'deny'), /composite/i);
    const reopened = new ToolPermissionStore(filePath);
    assert.equal(reopened.getPolicy('lsp:'), undefined);
    assert.equal(reopened.getPolicy('write_file'), 'deny');
  });

  test('composite validation also guards the legacy flat-map write branch', () => {
    const dir = createTrackedTempDir('jenny-perm-');
    const filePath = path.join(dir, 'tool-permissions.json');
    fs.writeFileSync(filePath, JSON.stringify({ read_file: 'auto' }));
    const store = new ToolPermissionStore(filePath);
    assert.throws(() => store.setPolicy('lsp:hover:extra', 'deny'), /composite/i);
    store.setPolicy('lsp:hover', 'ask');
    assert.equal(store.getPolicy('lsp:hover'), 'ask');
  });

  test('bare tool names are unaffected by the composite grammar', () => {
    const { store } = createTempStore();
    store.setPolicy('write_file', 'deny');
    assert.equal(store.getPolicy('write_file'), 'deny');
    store.setPolicy('some_unusual_tool', 'ask');
    assert.equal(store.getPolicy('some_unusual_tool'), 'ask');
  });
});
