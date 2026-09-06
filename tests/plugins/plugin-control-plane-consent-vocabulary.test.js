'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const {
  defaultRequireConsent,
  LIFECYCLE_TO_CONSENT_OPERATION,
} = require('../../services/plugins/plugin-control-plane-service');
const { PLUGIN_ERROR_CODES } = require('../../services/backend/error-codes');
const { classifyOperation } = require('../../services/plugins/consent/high-consequence');

// Scan the lifecycle source rather than maintaining a second verb list that
// could drift from the fail-closed consent map.
describe('lifecycle -> consent vocabulary cannot drift', () => {
  const LIFECYCLE_SOURCES = ['install-operation.js', 'uninstall-operation.js'];
  const CONSENT_VERB_RE = /requireConsent\(\{\s*operation:\s*'([a-z_]+)'/g;

  function scanLifecycleVerbs() {
    const verbs = new Set();
    for (const name of LIFECYCLE_SOURCES) {
      const file = nodePath.join(
        __dirname,
        '..',
        '..',
        'services',
        'plugins',
        'lifecycle',
        name
      );
      const text = nodeFs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(CONSENT_VERB_RE)) {
        verbs.add(match[1]);
      }
    }
    return verbs;
  }

  test('the scan finds verbs at all', () => {
    const verbs = scanLifecycleVerbs();
    assert.ok(verbs.size >= 2, `expected at least 2 lifecycle consent verbs, found ${verbs.size}`);
    assert.ok(verbs.has('install'));
    assert.ok(verbs.has('uninstall'));
  });

  test('every lifecycle consent verb maps to an ordinary operation', () => {
    for (const verb of scanLifecycleVerbs()) {
      const mapped = LIFECYCLE_TO_CONSENT_OPERATION[verb];
      assert.ok(mapped !== undefined, `unmapped lifecycle consent verb: ${verb}`);
      assert.equal(classifyOperation(mapped), 'ordinary');
      assert.deepEqual(defaultRequireConsent({ operation: verb }), { ok: true });
    }
  });

  test('an unmapped verb fails closed', () => {
    const result = defaultRequireConsent({ operation: 'enable_full_host' });
    assert.equal(result.ok, false);
    assert.equal(result.code, PLUGIN_ERROR_CODES.CONSENT_REQUIRED);
  });
});
