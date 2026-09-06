'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  MAX_TARGET_BYTES,
  catalogEntryFromTarget,
  publicCatalogEntry,
  validateCatalogSource,
} = require('../../../services/plugins/catalog/catalog-contracts');

test('remote sources require HTTPS pinned roots and exact fields', () => {
  const root = Buffer.from('{"signed":{"_type":"root"}}');
  const source = { catalog_source_schema_version: 1, source_id: 'official', kind: 'remote',
    display_name: 'Configured catalog', root_fingerprint: crypto.createHash('sha256').update(root).digest('hex'),
    pinned_root_base64: root.toString('base64'), metadata_base_url: 'https://plugins.example.test/metadata/',
    target_base_url: 'https://plugins.example.test/targets/' };
  assert.equal(validateCatalogSource(source).ok, true);
  assert.equal(validateCatalogSource({ ...source, metadata_base_url: 'http://plugins.example.test/' }).ok, false);
  assert.equal(validateCatalogSource({ ...source, credential: 'secret' }).ok, false);
});

test('offline sources keep native paths private while validating pinned trust', () => {
  const root = Buffer.from('{"signed":{"_type":"root"}}');
  const checked = validateCatalogSource({ catalog_source_schema_version: 1, source_id: 'usb',
    kind: 'offline_mirror', display_name: 'Release USB',
    root_fingerprint: crypto.createHash('sha256').update(root).digest('hex'),
    pinned_root_base64: root.toString('base64'), real_root: 'X:\\private\\mirror' });
  assert.equal(checked.ok, true);
});

test('target metadata is bounded and renderer entries omit target paths', () => {
  const entry = catalogEntryFromTarget('official', 'packages/acme.notes-1.2.3.jenny-plugin', {
    length: 4096, hashes: { sha256: 'c'.repeat(64) }, custom: { publisher_id: 'acme',
      plugin_id: 'notes', display_name: 'Notes', version: '1.2.3', summary: 'Signed notes extension' },
  });
  assert.equal(entry.ok, true);
  const publicEntry = publicCatalogEntry(entry.value);
  assert.equal('target_path' in publicEntry, false);
  assert.equal(JSON.stringify(publicEntry).includes('packages/'), false);
  assert.equal(catalogEntryFromTarget('official', '../escape', {
    length: 1, hashes: { sha256: 'c'.repeat(64) }, custom: { publisher_id: 'acme',
      plugin_id: 'notes', display_name: 'Notes', version: '1.2.3', summary: '' },
  }).ok, false);
  assert.equal(catalogEntryFromTarget('official', 'notes.zip', {
    length: MAX_TARGET_BYTES + 1, hashes: { sha256: 'c'.repeat(64) }, custom: {
      publisher_id: 'acme', plugin_id: 'notes', display_name: 'Notes', version: '1.2.3', summary: '' },
  }).ok, false);
});
