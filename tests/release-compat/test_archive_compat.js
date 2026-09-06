'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { verifyArchive } = require('../../services/data-lifecycle/archive-service');

test('archive v1 plain fixture remains readable and immutable', async () => {
  const fixture = path.join(__dirname, 'fixtures', 'jenny-archive-v1-plain');
  const result = await verifyArchive(fixture);
  assert.equal(result.ok, true);
  assert.equal(result.manifest.format_version, 1);
  assert.equal(result.manifest.entries[0].logical_path, 'preferences/fixture.txt');
  assert.equal(result.manifest.entries[0].sha256, 'e80b71cd14d3cbd65f4173abcbfcf01a545dbca32a72d575108b553a648cc96f');
});
