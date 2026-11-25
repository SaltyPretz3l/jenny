'use strict';
// new-test-file: services/backend/managed-server-facet.js is a new module (split out of jenny-status-composer.js,
// which sits at the file-size ceiling) and gains the Strata branch (row 200 S2 step 8).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLlamaServerFacet, buildManagedServerFacet } = require('../services/backend/managed-server-facet');

const manager = (status) => () => ({ getStatus: () => status });
const service = ({ strata = null, ninfer = null, llama = null } = {}) => ({ options: {
  getStrataManager: strata ? manager(strata) : () => null,
  getNinferManager: ninfer ? manager(ninfer) : () => null,
  getLlamaServerManager: llama ? manager(llama) : () => null,
} });
const strataReady = { state: 'ready', alias: 'inkling-2-mini-sq-20', port: 8035, drafting: 'off', runtimeLabel: '0.1.67',
  lastError: '', stoppedBy: '', watchdogWatts: 0, changedAt: 7, pid: 99, apiKey: 'k'.repeat(32) };
const facetFor = (options) => {
  const svc = service(options);
  return buildManagedServerFacet(svc, null, buildLlamaServerFacet(svc, null));
};

test('a live Strata wins over NInfer and llama-server, as an allowlist without key or pid', () => {
  const facet = facetFor({ strata: strataReady, ninfer: { state: 'crashed', lastError: 'x' }, llama: { state: 'ready', port: 8033 } });
  assert.deepEqual(facet, {
    kind: 'strata', state: 'ready', alias: 'inkling-2-mini-sq-20', port: 8035, acceleration_mode: 'off',
    last_error: '', runtime_label: '0.1.67', stopped_by: '', watchdog_watts: 0, changed_at: 7,
  });
  assert.equal(facetFor({ strata: { ...strataReady, drafting: 'dspark' } }).acceleration_mode, 'dspark');
});

test('a retained Strata failure shows only while nothing below it serves', () => {
  const crashed = { ...strataReady, state: 'crashed', stoppedBy: 'watchdog', watchdogWatts: 512.4 };
  assert.deepEqual([facetFor({ strata: crashed }).kind, facetFor({ strata: crashed }).stopped_by,
    facetFor({ strata: crashed }).watchdog_watts], ['strata', 'watchdog', 512]);
  assert.equal(facetFor({ strata: crashed, ninfer: { state: 'ready', mtp: true } }).kind, 'ninfer');
  assert.equal(facetFor({ strata: crashed, llama: { state: 'starting' } }).kind, 'llama-server');
  const failed = { ...strataReady, state: 'stopped', lastError: 'strata_blocked_by_windows' };
  assert.deepEqual([facetFor({ strata: failed }).kind, facetFor({ strata: failed }).last_error], ['strata', 'strata_blocked_by_windows']);
});

test('a cleanly stopped Strata changes nothing: NInfer and llama-server rank as before', () => {
  const stopped = { ...strataReady, state: 'stopped' };
  assert.equal(facetFor({ strata: stopped, ninfer: { state: 'ready', mtp: true } }).acceleration_mode, 'mtp');
  assert.equal(facetFor({ strata: stopped, ninfer: { state: 'stopped' }, llama: { state: 'ready' } }).kind, 'llama-server');
  assert.equal(facetFor({ strata: stopped, ninfer: { state: 'crashed' }, llama: { state: 'stopped' } }).kind, 'ninfer');
  assert.equal(facetFor({ strata: stopped }), null);
  assert.equal(facetFor({}), null);
});

test('a throwing manager reads as absent', () => {
  const svc = { options: { getStrataManager: () => { throw new Error('boom'); }, getNinferManager: () => null } };
  assert.equal(buildManagedServerFacet(svc, null, null), null);
});
