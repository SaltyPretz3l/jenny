'use strict';

// The bridge descriptor table is composed from per-domain modules
// (services/ipc-contract/descriptors-*.js). These pins keep the composition
// honest: a duplicate method path fails at load, and no domain module can be
// left out of (or partly dropped from) the composed table.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { JENNY_SHELL_BRIDGE_DESCRIPTORS } = require('../services/ipc-contract');
const {
  composeBridgeDescriptors,
  invokeMethod,
  localMethod,
  sendMethod,
  subscribeMethod,
} = require('../services/ipc-contract/bridge-methods');

const DOMAIN_DIR = path.join(__dirname, '..', 'services', 'ipc-contract');

function loadDomainModules() {
  return fs.readdirSync(DOMAIN_DIR)
    .filter((name) => /^descriptors-[a-z-]+\.js$/.test(name))
    .sort()
    .map((name) => [name, require(path.join(DOMAIN_DIR, name))]);
}

test('composition rejects a method path defined by two domain modules', () => {
  const first = Object.freeze({ 'demo.get': invokeMethod('demo:get') });
  const second = Object.freeze({
    'demo.onChanged': subscribeMethod('demo:changed'),
    'demo.get': invokeMethod('demo:get-again'),
  });
  assert.throws(
    () => composeBridgeDescriptors([['first', first], ['second', second]]),
    /"demo\.get" is defined by both the "first" and "second" descriptor modules/
  );
});

test('composition keeps domain order then each table order, frozen', () => {
  const composed = composeBridgeDescriptors([
    ['b', Object.freeze({ 'b.one': sendMethod('b:one'), 'b.two': localMethod('two') })],
    ['a', Object.freeze({ 'a.one': invokeMethod('a:one') })],
  ]);
  assert.deepEqual(Object.keys(composed), ['b.one', 'b.two', 'a.one']);
  assert.equal(Object.isFrozen(composed), true);
  assert.deepEqual(composed['b.two'], { kind: 'local', impl: 'two' });
});

test('every domain module is frozen and fully present in the composed table', () => {
  const domains = loadDomainModules();
  assert.ok(domains.length >= 8, `expected the domain modules, found ${domains.length}`);
  let total = 0;
  for (const [name, table] of domains) {
    assert.equal(Object.isFrozen(table), true, `${name} must export a frozen table`);
    const keys = Object.keys(table);
    assert.ok(keys.length > 0, `${name} is empty`);
    for (const methodPath of keys) {
      assert.equal(
        JENNY_SHELL_BRIDGE_DESCRIPTORS[methodPath],
        table[methodPath],
        `${name} -> ${methodPath} is missing from JENNY_SHELL_BRIDGE_DESCRIPTORS`
      );
    }
    total += keys.length;
  }
  // Equal totals plus the per-key identity above mean every composed path comes
  // from exactly one domain module (a module not wired into the entry fails here).
  assert.equal(total, Object.keys(JENNY_SHELL_BRIDGE_DESCRIPTORS).length);
});
