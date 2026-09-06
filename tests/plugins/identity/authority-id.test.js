'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalAuthorityTuple,
  authorityKey,
} = require('../../../services/plugins/identity/authority-id.js');

test('canonicalAuthorityTuple accepts a well-formed tuple', () => {
  const result = canonicalAuthorityTuple({
    publisherId: 'acme-labs',
    pluginId: 'widgets',
    contributionId: 'render',
  });
  assert.deepEqual(result, { ok: true });
});

test('canonicalAuthorityTuple rejects a malformed publisher_id', () => {
  const result = canonicalAuthorityTuple({
    publisherId: 'Acme_Labs',
    pluginId: 'widgets',
    contributionId: 'render',
  });
  assert.equal(result.ok, false);
  assert.equal(result.field, 'publisher_id');
});

test('canonicalAuthorityTuple rejects a malformed plugin_id', () => {
  const result = canonicalAuthorityTuple({
    publisherId: 'acme-labs',
    pluginId: 'Widgets!',
    contributionId: 'render',
  });
  assert.equal(result.ok, false);
  assert.equal(result.field, 'plugin_id');
});

test('canonicalAuthorityTuple rejects a malformed contribution_id', () => {
  const result = canonicalAuthorityTuple({
    publisherId: 'acme-labs',
    pluginId: 'widgets',
    contributionId: '',
  });
  assert.equal(result.ok, false);
  assert.equal(result.field, 'contribution_id');
});

test('authorityKey joins the tuple with slashes', () => {
  const key = authorityKey({ publisherId: 'acme-labs', pluginId: 'widgets', contributionId: 'render' });
  assert.equal(key, 'acme-labs/widgets/render');
});
