'use strict';

// The Electron side reads the same tool-manifest.json the sidecar validates with
// `validate_manifest_safety` (tool review C1, 2026-10-19). This mirrors those
// fail-closed rules so a manifest edit that the Python gate would reject at
// sidecar startup also fails the Node lane, where the sidecar never runs.

const test = require('node:test');
const assert = require('node:assert/strict');

const manifest = require('../services/tools/tool-manifest.json');

// Owner: sidecar/ai/tools/preconditions.py::PRECONDITION_PROBES (the sidecar runs
// the probes; Electron only forwards the manifest).
const PRECONDITION_PROBES = new Set(['git_root_present', 'python_runtime_ready']);

const ACTION_NAME = /^[\x21-\x7e]{1,64}$/; // printable ASCII, no whitespace
const SEVERITIES = new Set(['blocking', 'advisory']);
const tools = Array.isArray(manifest.tools) ? manifest.tools : manifest;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

test('every manifest entry declares its safety-bearing fields explicitly', () => {
  assert.ok(tools.length > 0);
  for (const entry of tools) {
    const label = entry.name;
    assert.equal(typeof entry.side_effecting, 'boolean', `${label}: side_effecting`);
    if (entry.read_only !== undefined) {
      assert.equal(typeof entry.read_only, 'boolean', `${label}: read_only`);
      assert.ok(!(entry.read_only && entry.side_effecting), `${label}: read_only and side_effecting`);
    }
    assert.ok(isPlainObject(entry.availability), `${label}: availability`);
    assert.ok('workspace_required' in entry.availability, `${label}: workspace_required declared`);
  }
});

test('declared actions follow the locked grammar and agree with the scalar', () => {
  for (const entry of tools) {
    if (entry.actions === undefined) continue;
    const label = entry.name;
    assert.ok(isPlainObject(entry.actions) && Object.keys(entry.actions).length > 0, `${label}: actions`);
    let anyWrite = false;
    for (const [name, spec] of Object.entries(entry.actions)) {
      assert.ok(ACTION_NAME.test(name) && !name.includes(':'), `${label}: action name ${name}`);
      assert.deepEqual(Object.keys(spec), ['side_effecting'], `${label}: action ${name} shape`);
      assert.equal(typeof spec.side_effecting, 'boolean', `${label}: action ${name} flag`);
      anyWrite = anyWrite || spec.side_effecting;
    }
    assert.ok(entry.side_effecting || !anyWrite, `${label}: scalar false with a write action`);
  }
});

test('always_available tools are read-only and action-free; preconditions are well formed', () => {
  for (const entry of tools) {
    const label = entry.name;
    if (entry.availability.always_available === true) {
      assert.ok(!entry.side_effecting && entry.actions === undefined, `${label}: always_available`);
    }
    if (entry.preconditions === undefined) continue;
    assert.ok(Array.isArray(entry.preconditions), `${label}: preconditions list`);
    const seen = new Set();
    for (const item of entry.preconditions) {
      assert.ok(isPlainObject(item), `${label}: precondition object`);
      assert.ok(Object.keys(item).every((key) => ['id', 'probe', 'severity'].includes(key)), `${label}: precondition keys`);
      assert.ok(typeof item.id === 'string' && item.id.trim() === item.id && item.id && !seen.has(item.id), `${label}: precondition id`);
      seen.add(item.id);
      assert.ok(PRECONDITION_PROBES.has(item.probe), `${label}: probe ${item.probe}`);
      if (item.severity !== undefined) assert.ok(SEVERITIES.has(item.severity), `${label}: severity`);
    }
  }
});
