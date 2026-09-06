'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const toolManifest = require('../services/tools/tool-manifest.json');

const {
  buildPolicyDecisionMetadata,
  DEFAULT_TOOL_DEFAULTS,
  evaluatePolicy,
  normalizePolicySnapshot,
} = require('../services/tools/tool-policy-evaluator');

function descriptor(overrides = {}) {
  return {
    name: 'read_file',
    side_effecting: false,
    read_only: true,
    tool_family: 'filesystem',
    source_kind: 'builtin',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Legacy compatibility — evaluator returns the same decision a flat per-tool
// policy map would, so existing user configurations keep working unchanged.
// ---------------------------------------------------------------------------

describe('evaluatePolicy / legacy parity', () => {
  test('respects default auto for read-only tools when no policy stored', () => {
    const snapshot = normalizePolicySnapshot({});
    const result = evaluatePolicy({ descriptor: descriptor(), snapshot });
    assert.equal(result.decision, 'auto');
    assert.equal(result.stage, 'tool_default');
    assert.equal(result.matched_rule_id, null);
  });

  test('respects default ask for side-effecting builtins', () => {
    const snapshot = normalizePolicySnapshot({});
    const result = evaluatePolicy({
      descriptor: descriptor({
        name: 'write_file',
        side_effecting: true,
        read_only: false,
      }),
      snapshot,
    });
    assert.equal(result.decision, 'ask');
    assert.equal(result.stage, 'tool_default');
  });

  // `home` writes, so without a built-in default it would fall through to the
  // side-effecting/unknown 'ask' branch on every call. The entry exists because
  // every Home write is attributed, one-click-undoable, and deletes self-gate
  // behind an explicit confirm round-trip inside the tool.
  test('home defaults to auto on an empty policy snapshot', () => {
    assert.equal(DEFAULT_TOOL_DEFAULTS.home, 'auto');
    const result = evaluatePolicy({
      descriptor: descriptor({
        name: 'home',
        side_effecting: false,
        read_only: false,
        tool_family: 'home',
      }),
      snapshot: normalizePolicySnapshot({}),
    });
    assert.equal(result.decision, 'auto');
    assert.equal(result.stage, 'tool_default');
    assert.equal(result.matched_rule_id, null);
  });

  test('an explicit user policy still overrides the home default', () => {
    const result = evaluatePolicy({
      descriptor: descriptor({
        name: 'home',
        side_effecting: false,
        read_only: false,
        tool_family: 'home',
      }),
      snapshot: normalizePolicySnapshot({ home: 'deny' }),
    });
    assert.equal(result.decision, 'deny');
  });

  // `verify` is honestly side-effecting (tests write snapshots and coverage), so
  // without a built-in default it would prompt on every verification — which
  // would make the verification gate useless. The entry exists because the model
  // can only pick WHICH of the user's own saved Test Runner configurations to
  // run: no argument passthrough, no command composition, so the executed string
  // is always one the user authored.
  test('verify defaults to auto despite being side-effecting', () => {
    assert.equal(DEFAULT_TOOL_DEFAULTS.verify, 'auto');
    const result = evaluatePolicy({
      descriptor: descriptor({
        name: 'verify',
        side_effecting: true,
        read_only: false,
        tool_family: 'workspace',
      }),
      snapshot: normalizePolicySnapshot({}),
    });
    assert.equal(result.decision, 'auto');
    assert.equal(result.stage, 'tool_default');
    assert.equal(result.matched_rule_id, null);
  });

  test('an explicit user policy still overrides the verify default', () => {
    for (const [stored, expected] of [['ask', 'ask'], ['deny', 'deny']]) {
      const result = evaluatePolicy({
        descriptor: descriptor({
          name: 'verify',
          side_effecting: true,
          read_only: false,
          tool_family: 'workspace',
        }),
        snapshot: normalizePolicySnapshot({ verify: stored }),
      });
      assert.equal(result.decision, expected, `stored ${stored}`);
    }
  });

  test('legacy flat map deny wins over built-in default', () => {
    const snapshot = normalizePolicySnapshot({ read_file: 'deny' });
    const result = evaluatePolicy({ descriptor: descriptor(), snapshot });
    assert.equal(result.decision, 'deny');
    assert.equal(result.stage, 'tool_default');
  });

  test('legacy flat map auto promotes side-effecting tool', () => {
    const snapshot = normalizePolicySnapshot({ write_file: 'auto' });
    const result = evaluatePolicy({
      descriptor: descriptor({
        name: 'write_file',
        side_effecting: true,
        read_only: false,
      }),
      snapshot,
    });
    assert.equal(result.decision, 'auto');
    assert.equal(result.stage, 'tool_default');
  });

  test('delegate preserves legacy subagent policies with conservative conflicts', () => {
    for (const [snapshot, expected] of [
      [{ subagent_run: 'deny' }, 'deny'],
      [{ subagent_batch: 'ask' }, 'ask'],
      [{ delegate: 'auto', subagent_run: 'ask' }, 'ask'],
      [{ delegate: 'auto', subagent_run: 'ask', subagent_batch: 'deny' }, 'deny'],
    ]) {
      const result = evaluatePolicy({
        descriptor: descriptor({ name: 'delegate', tool_family: 'runtime' }),
        snapshot: normalizePolicySnapshot(snapshot),
      });
      assert.equal(result.decision, expected);
    }
  });

  test('delegate matches structured rules targeting hidden legacy subagent ids', () => {
    const result = evaluatePolicy({
      descriptor: descriptor({ name: 'delegate', tool_family: 'runtime' }),
      snapshot: normalizePolicySnapshot({
        version: 2,
        legacy_policies: {},
        rules: [{
          id: 'ask-legacy-batch',
          decision: 'ask',
          reason: 'Retained during the delegation compatibility window',
          match: { tool_id: 'subagent_batch' },
        }],
      }),
    });

    assert.equal(result.decision, 'ask');
    assert.equal(result.matched_rule_id, 'ask-legacy-batch');
  });

  test('DEFAULT_TOOL_DEFAULTS covers every legacy built-in', () => {
    const expected = [
      'read_file',
      'glob_files',
      'grep_search',
      'write_file',
      'edit_file',
      'run_command',
      'monitor',
      'create_artifact',
    ];
    for (const name of expected) {
      assert.ok(
        Object.hasOwn(DEFAULT_TOOL_DEFAULTS, name),
        `${name} should have a built-in default`
      );
    }
  });

  test('every DEFAULT_TOOL_DEFAULTS key exists in the canonical manifest', () => {
    const manifestToolNames = new Set(toolManifest.tools.map((tool) => tool.name));
    for (const toolName of Object.keys(DEFAULT_TOOL_DEFAULTS)) {
      assert.ok(manifestToolNames.has(toolName), `${toolName} must exist in tool-manifest.json`);
    }
  });

  test('monitor defaults to ask as a side-effecting shell tool', () => {
    const snapshot = normalizePolicySnapshot({});
    const result = evaluatePolicy({
      descriptor: descriptor({
        name: 'monitor',
        side_effecting: true,
        read_only: false,
        tool_family: 'shell',
        source_kind: 'synthetic',
      }),
      snapshot,
    });

    assert.equal(result.decision, 'ask');
    assert.equal(result.stage, 'tool_default');
    assert.equal(result.reason, 'built-in default for monitor');
  });

  test('pins JS policy precedence for exit_plan_mode, task_board:list, and read_file', () => {
    const descriptors = new Map(toolManifest.tools.map((tool) => [tool.name, tool]));
    const snapshot = normalizePolicySnapshot({});
    const cases = [
      ['exit_plan_mode', {}, 'ask', 'built-in default for exit_plan_mode'],
      ['task_board', { action: 'list' }, 'auto', 'read-only action defaults to auto'],
      ['read_file', {}, 'auto', 'built-in default for read_file'],
    ];

    for (const [name, args, decision, reason] of cases) {
      const result = evaluatePolicy({ descriptor: descriptors.get(name), args, snapshot });
      assert.equal(result.decision, decision, name);
      assert.equal(result.reason, reason, name);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule list — explicit user rules with ordered precedence.
// ---------------------------------------------------------------------------

describe('evaluatePolicy / rule list', () => {
  test('user deny rule wins over legacy auto policy', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: { run_command: 'auto' },
      rules: [
        {
          id: 'deny-rm',
          decision: 'deny',
          reason: 'no destructive shell',
          match: { tool_id: 'run_command' },
        },
      ],
    });
    const result = evaluatePolicy({
      descriptor: descriptor({
        name: 'run_command',
        side_effecting: true,
        read_only: false,
        tool_family: 'shell',
      }),
      snapshot,
    });
    assert.equal(result.decision, 'deny');
    assert.equal(result.stage, 'user_deny');
    assert.equal(result.matched_rule_id, 'deny-rm');
  });

  test('user auto rule promotes side-effecting tool over built-in ask', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'auto-edit',
          decision: 'auto',
          reason: 'trusted workspace',
          match: { tool_family: 'filesystem' },
        },
      ],
    });
    const result = evaluatePolicy({
      descriptor: descriptor({
        name: 'edit_file',
        side_effecting: true,
        read_only: false,
        tool_family: 'filesystem',
      }),
      snapshot,
    });
    assert.equal(result.decision, 'auto');
    assert.equal(result.stage, 'user_allow');
    assert.equal(result.matched_rule_id, 'auto-edit');
  });

  test('deny precedence: deny rule beats allow rule on the same tool', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'auto-fs',
          decision: 'auto',
          reason: 'broad allow',
          match: { tool_family: 'filesystem' },
        },
        {
          id: 'deny-write',
          decision: 'deny',
          reason: 'no writes',
          match: { tool_id: 'write_file' },
        },
      ],
    });
    const result = evaluatePolicy({
      descriptor: descriptor({
        name: 'write_file',
        side_effecting: true,
        read_only: false,
        tool_family: 'filesystem',
      }),
      snapshot,
    });
    assert.equal(result.decision, 'deny');
    assert.equal(result.stage, 'user_deny');
    assert.equal(result.matched_rule_id, 'deny-write');
  });

  test('mode-restricted rule only fires in matching mode', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'deny-shell-autonomous',
          decision: 'deny',
          reason: 'shell blocked in autonomous mode',
          match: { tool_id: 'run_command', mode: ['autonomous'] },
        },
      ],
    });
    const denied = evaluatePolicy({
      descriptor: descriptor({
        name: 'run_command',
        side_effecting: true,
        read_only: false,
      }),
      mode: 'autonomous',
      snapshot,
    });
    assert.equal(denied.decision, 'deny');

    const allowed = evaluatePolicy({
      descriptor: descriptor({
        name: 'run_command',
        side_effecting: true,
        read_only: false,
      }),
      mode: 'assist',
      snapshot,
    });
    // No matching rule in 'assist' mode -> falls through to default 'ask'.
    assert.equal(allowed.decision, 'ask');
    assert.equal(allowed.stage, 'tool_default');
  });

  test('path_prefix rule narrows to a specific subtree', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'deny-prod',
          decision: 'deny',
          reason: 'production paths protected',
          match: { tool_id: 'edit_file', path_prefix: 'prod/' },
        },
      ],
    });
    const blocked = evaluatePolicy({
      descriptor: descriptor({
        name: 'edit_file',
        side_effecting: true,
        read_only: false,
      }),
      args: { file_path: 'prod/secrets.env' },
      snapshot,
    });
    assert.equal(blocked.decision, 'deny');

    const ok = evaluatePolicy({
      descriptor: descriptor({
        name: 'edit_file',
        side_effecting: true,
        read_only: false,
      }),
      args: { file_path: 'src/main.py' },
      snapshot,
    });
    assert.equal(ok.decision, 'ask'); // falls through to legacy/default
    assert.equal(ok.stage, 'tool_default');
  });

  test('path_prefix rule requires a normalized path boundary', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'auto-safe-tree',
          decision: 'auto',
          reason: 'trusted path',
          match: { tool_id: 'write_file', path_prefix: 'C:\\workspace\\safe' },
        },
      ],
    });
    const writeDescriptor = descriptor({
      name: 'write_file',
      side_effecting: true,
      read_only: false,
    });

    const sibling = evaluatePolicy({
      descriptor: writeDescriptor,
      args: { file_path: 'C:\\workspace\\safe2\\notes.md' },
      snapshot,
    });
    assert.equal(sibling.decision, 'ask');
    assert.equal(sibling.stage, 'tool_default');

    const traversal = evaluatePolicy({
      descriptor: writeDescriptor,
      args: { file_path: 'C:\\workspace\\safe\\..\\secret.md' },
      snapshot,
    });
    assert.equal(traversal.decision, 'ask');
    assert.equal(traversal.stage, 'tool_default');

    const child = evaluatePolicy({
      descriptor: writeDescriptor,
      args: { file_path: 'c:/workspace/safe/notes.md' },
      snapshot,
    });
    assert.equal(child.decision, 'auto');
    assert.equal(child.matched_rule_id, 'auto-safe-tree');
  });

  test('path_prefix rule supports filesystem roots without losing boundary checks', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'deny-posix-root',
          decision: 'deny',
          reason: 'all absolute posix paths protected',
          match: { tool_id: 'edit_file', path_prefix: '/' },
        },
        {
          id: 'deny-windows-root',
          decision: 'deny',
          reason: 'all drive paths protected',
          match: { tool_id: 'write_file', path_prefix: 'C:\\' },
        },
      ],
    });

    const posix = evaluatePolicy({
      descriptor: descriptor({
        name: 'edit_file',
        side_effecting: true,
        read_only: false,
      }),
      args: { file_path: '/tmp/work/file.txt' },
      snapshot,
    });
    assert.equal(posix.decision, 'deny');
    assert.equal(posix.matched_rule_id, 'deny-posix-root');

    const windows = evaluatePolicy({
      descriptor: descriptor({
        name: 'write_file',
        side_effecting: true,
        read_only: false,
      }),
      args: { file_path: 'c:/tmp/work/file.txt' },
      snapshot,
    });
    assert.equal(windows.decision, 'deny');
    assert.equal(windows.matched_rule_id, 'deny-windows-root');
  });

  test('path_prefix root rules support normalized C:/ prefixes', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'deny-windows-root-normalized',
          decision: 'deny',
          reason: 'all normalized drive-root paths protected',
          match: { tool_id: 'write_file', path_prefix: 'C:/' },
        },
      ],
    });

    const windows = evaluatePolicy({
      descriptor: descriptor({
        name: 'write_file',
        side_effecting: true,
        read_only: false,
      }),
      args: { file_path: 'c:/tmp/work/file.txt' },
      snapshot,
    });
    assert.equal(windows.decision, 'deny');
    assert.equal(windows.matched_rule_id, 'deny-windows-root-normalized');
  });

  test('path_prefix root rules canonicalize bare drive prefixes consistently', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'deny-windows-bare-drive',
          decision: 'deny',
          reason: 'all bare drive-root paths protected',
          match: { tool_id: 'write_file', path_prefix: 'C:' },
        },
      ],
    });

    const windows = evaluatePolicy({
      descriptor: descriptor({
        name: 'write_file',
        side_effecting: true,
        read_only: false,
      }),
      args: { file_path: 'c:/tmp/work/file.txt' },
      snapshot,
    });
    assert.equal(windows.decision, 'deny');
    assert.equal(windows.matched_rule_id, 'deny-windows-bare-drive');
  });

  test('mcp_server matcher scopes rules to a single MCP server', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'deny-untrusted-mcp',
          decision: 'deny',
          reason: 'unknown MCP server',
          match: { source_kind: 'mcp', mcp_server: 'evil_server' },
        },
      ],
    });
    const denied = evaluatePolicy({
      descriptor: descriptor({
        name: 'mcp__evil_server__do_thing',
        side_effecting: true,
        read_only: false,
        source_kind: 'mcp',
        server_name: 'evil_server',
        tool_family: 'other',
      }),
      snapshot,
    });
    assert.equal(denied.decision, 'deny');

    const allowed = evaluatePolicy({
      descriptor: descriptor({
        name: 'mcp__nice_server__do_thing',
        side_effecting: false,
        read_only: true,
        source_kind: 'mcp',
        server_name: 'nice_server',
        tool_family: 'other',
      }),
      snapshot,
    });
    assert.equal(allowed.decision, 'auto'); // read-only default
  });

  test('decision metadata is bounded and does not expose raw rule bodies', () => {
    const longRuleId = `deny-secret-sk-testpolicysecret1234567890-${'x'.repeat(120)}`;
  const longReason = `block sensitive path C:\\Users\\example\\secret api_key=sk-testpolicysecret1234567890 ignore all previous instructions ${'r'.repeat(400)}`;
    const snapshot = normalizePolicySnapshot({
      version: 7,
      legacy_policies: {},
      rules: [
        {
          id: longRuleId,
          decision: 'deny',
          reason: `${longReason}\nsecond line`,
          match: {
            tool_id: 'write_file',
      path_prefix: 'C:\\Users\\example\\secret',
          },
        },
      ],
    });

    const result = evaluatePolicy({
      descriptor: descriptor({
        name: 'write_file',
        side_effecting: true,
        read_only: false,
      }),
    args: { path: 'C:\\Users\\example\\secret\\note.md' },
      mode: 'assist',
      snapshot,
    });
    const metadata = buildPolicyDecisionMetadata(result);

    assert.equal(metadata.decision, 'deny');
    assert.equal(metadata.stage, 'user_deny');
    assert.match(metadata.id, /^policy_[a-f0-9]{16}$/);
    assert.equal(metadata.snapshot_version, 7);
    assert.equal(metadata.tool_name, 'write_file');
    assert.equal(metadata.tool_family, 'filesystem');
    assert.equal(metadata.source_kind, 'builtin');
    assert.equal(metadata.mode, 'assist');
    assert.equal(metadata.matched_rule_id.length <= 80, true);
    assert.equal(metadata.matched_rule_id.length > 0, true);
    assert.equal(metadata.reason.length, 240);
    assert.equal(metadata.reason.includes('\n'), false);
    assert.equal(JSON.stringify(metadata).includes('sk-testpolicysecret1234567890'), false);
    assert.equal(JSON.stringify(metadata).toLowerCase().includes('ignore all previous instructions'), false);
    assert.equal(JSON.stringify(metadata).includes('path_prefix'), false);

    const spoofed = buildPolicyDecisionMetadata({
      ...result,
      id: 'policy_0000000000000000',
    });
    assert.equal(spoofed.id, metadata.id);
    assert.notEqual(spoofed.id, 'policy_0000000000000000');
  });

  test('evaluatePolicy normalizes raw versioned snapshots before matching', () => {
    const result = evaluatePolicy({
      descriptor: descriptor({
        name: 'write_file',
        side_effecting: true,
        read_only: false,
      }),
      args: { path: 'prod/notes.md' },
      snapshot: {
        version: -10,
        legacy_policies: {},
        rules: [
          {
            id: `deny-prod-${'x'.repeat(120)}`,
            decision: 'deny',
            reason: `block prod\n${'r'.repeat(400)}`,
            match: { tool_id: 'write_file', path_prefix: 'prod/' },
          },
        ],
      },
    });

    assert.equal(result.decision, 'deny');
    assert.equal(result.snapshot_version, 1);
    assert.equal(result.matched_rule_id.length, 80);
    assert.equal(result.reason.length, 240);
    assert.equal(result.reason.includes('\n'), false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot normalization — malformed input must not crash.
// ---------------------------------------------------------------------------

describe('normalizePolicySnapshot / robustness', () => {
  test('null input returns an empty snapshot', () => {
    const snapshot = normalizePolicySnapshot(null);
    assert.equal(snapshot.version, 1);
    assert.deepEqual(snapshot.legacy_policies, {});
    assert.deepEqual(snapshot.rules, []);
  });

  test('array input is treated as empty snapshot', () => {
    const snapshot = normalizePolicySnapshot([]);
    assert.deepEqual(snapshot.legacy_policies, {});
    assert.deepEqual(snapshot.rules, []);
  });

  test('legacy entries with invalid decisions are dropped silently', () => {
    const snapshot = normalizePolicySnapshot({
      read_file: 'auto',
      write_file: 'not_a_decision',
      glob_files: 'deny',
    });
    assert.deepEqual(snapshot.legacy_policies, {
      read_file: 'auto',
      glob_files: 'deny',
    });
  });

  test('rule entries without an id are dropped', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        { decision: 'deny', match: {} },
        { id: '   ', decision: 'deny', match: {} },
        { id: 'good-rule', decision: 'deny', match: {} },
      ],
    });
    assert.equal(snapshot.rules.length, 1);
    assert.equal(snapshot.rules[0].id, 'good-rule');
  });

  test('rule entries with invalid decisions are dropped', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        { id: 'bad', decision: 'foo', match: {} },
        { id: 'good', decision: 'auto', match: {} },
      ],
    });
    assert.equal(snapshot.rules.length, 1);
    assert.equal(snapshot.rules[0].id, 'good');
  });

  test('snapshot normalization bounds malformed versions and oversized policy lists', () => {
    const legacyEntries = Object.fromEntries(
      Array.from({ length: 1005 }, (_entry, index) => [`tool_${index}`, 'auto'])
    );
    const snapshot = normalizePolicySnapshot({
      version: -42,
      legacy_policies: legacyEntries,
      rules: Array.from({ length: 1005 }, (_entry, index) => ({
        id: `rule_${index}_${'x'.repeat(120)}`,
        decision: 'deny',
        reason: `line one\n${'r'.repeat(400)}`,
        match: {
          tool_id: `tool_${index}_${'n'.repeat(200)}`,
          tool_family: 'filesystem',
          source_kind: 'builtin',
          mode: Array.from({ length: 20 }, (_mode, modeIndex) => `mode_${modeIndex}`),
          path_prefix: `C:\\workspace\\${'p'.repeat(2000)}`,
          mcp_server: `server_${'s'.repeat(200)}`,
        },
      })),
    });

    assert.equal(snapshot.version, 1);
    assert.equal(Object.keys(snapshot.legacy_policies).length, 1000);
    assert.equal(snapshot.rules.length, 1000);
    assert.equal(snapshot.rules[0].id.length, 80);
    assert.equal(snapshot.rules[0].reason.length, 240);
    assert.equal(snapshot.rules[0].reason.includes('\n'), false);
    assert.equal(snapshot.rules[0].match.tool_id.length, 160);
    assert.equal(snapshot.rules[0].match.path_prefix.length, 1024);
    assert.equal(snapshot.rules[0].match.mode.length, 16);
    assert.equal(snapshot.rules[0].match.mcp_server.length, 160);
  });

  test('snapshot is frozen against mutation', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: { read_file: 'auto' },
      rules: [{ id: 'x', decision: 'deny', match: {} }],
    });
    assert.throws(() => {
      snapshot.legacy_policies.read_file = 'deny';
    });
    assert.throws(() => {
      snapshot.rules[0].decision = 'auto';
    });
  });
});

// ---------------------------------------------------------------------------
// Descriptor guards
// ---------------------------------------------------------------------------

describe('evaluatePolicy / descriptor guards', () => {
  test('missing descriptor name defaults to ask', () => {
    const result = evaluatePolicy({
      descriptor: { side_effecting: true },
      snapshot: normalizePolicySnapshot({}),
    });
    assert.equal(result.decision, 'ask');
    assert.equal(result.stage, 'hard_safety_deny');
  });

  test('unknown tool without descriptor defaults defaults to ask', () => {
    const result = evaluatePolicy({
      descriptor: descriptor({
        name: 'wholly_new_tool',
        side_effecting: false,
        read_only: false,
      }),
      snapshot: normalizePolicySnapshot({}),
    });
    assert.equal(result.decision, 'ask');
  });
});

// ---------------------------------------------------------------------------
// W7b-S2 — action-aware parity with the Python evaluator (policy.py, W6).
// A mixed descriptor declares actions as the plain manifest shape:
// { status: { side_effecting: false }, apply: { side_effecting: true } }.
// Contract mirrored from evaluate_tool_policy: composite legacy lane wins
// outright when the action resolves; unresolvable actions fail closed to ask
// with ONLY deny hits honored; fallback defaults consult the per-action class.
// ---------------------------------------------------------------------------

function mixedDescriptor(overrides = {}) {
  return {
    name: 'mixer',
    side_effecting: true, // W6 coercion invariant: any write action ⇒ scalar true
    read_only: false,
    tool_family: 'workspace',
    source_kind: 'builtin',
    actions: {
      status: { side_effecting: false },
      apply: { side_effecting: true },
    },
    ...overrides,
  };
}

describe('evaluatePolicy / action awareness (W7b-S2)', () => {
  test('resolved read action falls back to auto, not the scalar ask', () => {
    const snapshot = normalizePolicySnapshot({});
    const result = evaluatePolicy({
      descriptor: mixedDescriptor(),
      args: { action: 'status' },
      snapshot,
    });
    assert.equal(result.decision, 'auto');
    assert.equal(result.stage, 'tool_default');
  });

  test('resolved write action still defaults to ask', () => {
    const snapshot = normalizePolicySnapshot({});
    const result = evaluatePolicy({
      descriptor: mixedDescriptor(),
      args: { action: 'apply' },
      snapshot,
    });
    assert.equal(result.decision, 'ask');
  });

  test('missing action on an actioned tool fails closed to ask', () => {
    const snapshot = normalizePolicySnapshot({});
    const result = evaluatePolicy({
      descriptor: mixedDescriptor(),
      args: {},
      snapshot,
    });
    assert.equal(result.decision, 'ask');
    assert.match(result.reason, /fail|not declared/i);
  });

  test('undeclared action fails closed to ask even against an auto rule', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'auto_mixer',
          decision: 'auto',
          match: { tool_id: 'mixer' },
          reason: 'blanket auto for mixer',
        },
      ],
    });
    const result = evaluatePolicy({
      descriptor: mixedDescriptor(),
      args: { action: 'explode' },
      snapshot,
    });
    assert.equal(result.decision, 'ask');
  });

  test('a deny rule is honored even when the action is unresolvable', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: {},
      rules: [
        {
          id: 'deny_mixer',
          decision: 'deny',
          match: { tool_id: 'mixer' },
          reason: 'denied',
        },
      ],
    });
    const result = evaluatePolicy({
      descriptor: mixedDescriptor(),
      args: {},
      snapshot,
    });
    assert.equal(result.decision, 'deny');
    assert.equal(result.matched_rule_id, 'deny_mixer');
  });

  test('a legacy deny is honored when the action is unresolvable', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: { mixer: 'deny' },
      rules: [],
    });
    const result = evaluatePolicy({
      descriptor: mixedDescriptor(),
      args: {},
      snapshot,
    });
    assert.equal(result.decision, 'deny');
  });

  test('a legacy auto grant is NOT honored when the action is unresolvable', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: { mixer: 'auto' },
      rules: [],
    });
    const result = evaluatePolicy({
      descriptor: mixedDescriptor(),
      args: {},
      snapshot,
    });
    assert.equal(result.decision, 'ask');
  });

  test('composite legacy key wins outright over the bare tool key', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: { 'mixer:apply': 'auto', mixer: 'deny' },
      rules: [],
    });
    const result = evaluatePolicy({
      descriptor: mixedDescriptor(),
      args: { action: 'apply' },
      snapshot,
    });
    assert.equal(result.decision, 'auto');
    assert.match(result.reason, /mixer:apply/);
  });

  test('bare legacy key still applies to a resolved action without a composite', () => {
    const snapshot = normalizePolicySnapshot({
      version: 1,
      legacy_policies: { mixer: 'deny' },
      rules: [],
    });
    const result = evaluatePolicy({
      descriptor: mixedDescriptor(),
      args: { action: 'status' },
      snapshot,
    });
    assert.equal(result.decision, 'deny');
  });

  test('actionless descriptors keep their exact current behavior', () => {
    const snapshot = normalizePolicySnapshot({});
    const result = evaluatePolicy({
      descriptor: descriptor({ name: 'blaster', side_effecting: true, read_only: false }),
      args: {},
      snapshot,
    });
    assert.equal(result.decision, 'ask');
    assert.equal(result.reason, 'side-effecting tool defaults to ask');
  });
});
