'use strict';

// new-test-file: services/team/host/host-key-state.js is a new module (the stored host key's team id and state, extracted
// from host-controller.js, which sits at its size ceiling); the controller tests are about deploy and status, not the key's buffers.

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildHostConfig, prepareHostLayout, writeHostConfig } = require('../services/team/host/host-layout');
const { createHostKeyState } = require('../services/team/host/host-key-state');
const { deriveTeamId, keyPairFromSeed } = require('../server/team/ids');
const { HOST_SEED } = require('./server/helpers/team-host-fixture');
const { createTestHostController } = require('./helpers/team-host-fakes');
const { createMemorySecureStore, tempProfile } = require('./helpers/team-client-host');

// A host key store double that hands out a fresh buffer on every load and keeps each, to see which were zeroed.
function trackingKeys(make) {
  const loaded = [];
  return { loaded, load: () => { const seed = make(); if (seed) loaded.push(seed); return seed; } };
}
const allZeroed = (loaded) => loaded.length > 0 && loaded.every((seed) => seed.every((byte) => byte === 0));

function deployedProfile(t) {
  const userDataPath = tempProfile(t, 'jenny-host-key-state-');
  const layout = prepareHostLayout(userDataPath);
  writeHostConfig(layout, buildHostConfig({ layout, name: 'Studio', directPort: 45123 }));
  return userDataPath;
}

test('the team id is derived once, cached until forgotten, and every loaded seed is zeroed', (t) => {
  const userDataPath = deployedProfile(t);
  const keys = trackingKeys(() => Buffer.from(HOST_SEED));
  const state = createHostKeyState({ userDataPath, keys });
  const expected = deriveTeamId(keyPairFromSeed(Buffer.from(HOST_SEED)).publicKey);
  assert.equal(state.teamId(), expected);
  assert.equal(state.teamId(), expected);
  assert.equal(keys.loaded.length, 1, 'cached: the store is asked once');
  assert.equal(allZeroed(keys.loaded), true);
  state.forget();
  assert.equal(state.teamId(), expected);
  assert.equal(keys.loaded.length, 2, 'asked again after forget');
  state.note('team_other');
  assert.equal(state.teamId(), 'team_other', 'a deploy that just derived it says so');
  assert.equal(allZeroed(keys.loaded), true);
});

test('state: null before any deploy; ok, missing and unknown after, with no seed left unzeroed', (t) => {
  const keys = trackingKeys(() => Buffer.from(HOST_SEED));
  assert.equal(createHostKeyState({ userDataPath: tempProfile(t, 'jenny-host-key-state-'), keys }).state(), null);
  assert.equal(createHostKeyState({ userDataPath: deployedProfile(t), keys }).state(), 'ok');
  assert.equal(createHostKeyState({ userDataPath: deployedProfile(t), keys: trackingKeys(() => null) }).state(), 'missing');
  const odd = trackingKeys(() => Buffer.alloc(3, 7)); // a seed the store holds that no team id comes from
  assert.equal(createHostKeyState({ userDataPath: deployedProfile(t), keys: odd }).state(), 'unknown');
  assert.equal(allZeroed(odd.loaded), true, 'both reads were zeroed');
  assert.equal(allZeroed(keys.loaded), true);
});

test('H7: the controller zeroes every seed the key state check loads, also when it cannot name a team', (t) => {
  const userDataPath = deployedProfile(t);
  const odd = trackingKeys(() => Buffer.alloc(3, 7));
  const { controller } = createTestHostController(t, { userDataPath, secureStore: createMemorySecureStore(), hostKeys: odd });
  assert.equal(controller.snapshot().key, 'unknown');
  assert.equal(allZeroed(odd.loaded), true, 'no loaded buffer was left holding key bytes');
});
