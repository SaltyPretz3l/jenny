'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBundledPluginRecord } = require('../../../services/plugins/provider/bundled-plugin-inventory');

const identity = { publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription' };
const base = { ...identity, version: '1.0.0', package_resource: 'plugins/chatgpt-subscription.jenny-plugin',
  signing_key_id: 'a'.repeat(64) };

test('unsigned and pinned official inventory states are explicit and mutually consistent', () => {
  assert.deepEqual(resolveBundledPluginRecord({ plugins: [{ ...base, package_sha256: null,
    status: 'awaiting_owner_signature' }] }, identity), {
    ok: false, reason: 'bundled_package_awaiting_owner_signature',
  });
  const pinned = { ...base, package_sha256: 'b'.repeat(64), status: 'pinned' };
  assert.deepEqual(resolveBundledPluginRecord({ plugins: [pinned] }, identity), { ok: true, record: pinned });
});

test('contradictory status, unsafe resource, or missing identity fails closed', () => {
  for (const record of [
    { ...base, package_sha256: 'b'.repeat(64), status: 'awaiting_owner_signature' },
    { ...base, package_sha256: null, status: 'pinned' },
    { ...base, package_sha256: 'b'.repeat(64), status: 'pinned', package_resource: '../secret' },
  ]) assert.equal(resolveBundledPluginRecord({ plugins: [record] }, identity).reason,
    'bundled_package_inventory_invalid');
  assert.equal(resolveBundledPluginRecord({ plugins: [] }, identity).reason,
    'bundled_package_inventory_invalid');
});
