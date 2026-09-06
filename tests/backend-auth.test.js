const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { updateLocalProfile } = require('../services/backend/backend-auth');

function createManagedAuthService() {
  const store = new Map();
  const service = new EventEmitter();
  service.accessToken = '';
  service.secureStore = {
    get(key) {
      return store.get(key) || '';
    },
    set(key, value) {
      store.set(key, String(value || ''));
    },
    delete(key) {
      store.delete(key);
    },
  };
  return service;
}

test('managed local profile update persists one bounded display name without changing chat access', () => {
  const service = createManagedAuthService();
  const state = updateLocalProfile(service, { displayName: '  Brendan  ' });
  assert.equal(state.authenticated, true);
  assert.equal(state.user.display_name, 'Brendan');
  assert.equal(JSON.parse(service.secureStore.get('user_json')).display_name, 'Brendan');
  assert.throws(() => updateLocalProfile(service, { displayName: '' }), /between 1 and 80/);
});
