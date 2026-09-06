'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  REQUEST_TIMEOUT_MS_BY_METHOD,
} = require('../services/backend/sidecar-request-timeouts');

test('inline completion sidecar timeout narrowly outlives the client timeout', () => {
  const clientMs = REQUEST_TIMEOUT_MS_BY_METHOD['inline.complete'];
  assert.equal(Number.isFinite(clientMs), true, 'inline.complete client timeout must be finite');

  const repoRoot = path.join(__dirname, '..');
  const source = fs.readFileSync(
    path.join(repoRoot, 'sidecar/runtime/inline_completion.py'),
    'utf8'
  );
  const match = source.match(/_ENGINE_TIMEOUT_SECONDS\s*=\s*(\d+(?:\.\d+)?)/);
  assert.ok(
    match,
    '_ENGINE_TIMEOUT_SECONDS moved/renamed; this timeout-margin gate must be updated'
  );

  const sidecarMs = Number(match[1]) * 1000;
  assert.ok(sidecarMs > clientMs, 'sidecar timeout must remain strictly above the client timeout');

  const marginMs = sidecarMs - clientMs;
  assert.ok(
    marginMs >= 500 && marginMs <= 3000,
    'sidecar must outlive the client so an abandoned round degrades cleanly, but not by so much '
      + `that the serial request loop is held hostage (margin ${marginMs}ms)`
  );
});
