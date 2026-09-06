'use strict';

// Middle-hop export contract for the lifecycle composition.
//
// Bug class (hit live 2026-07-19, owner smoke): a handler defined in the
// service registry and consumed in app.js silently arrives as `undefined`
// when renderer-app-lifecycle-composition.js forgets to pluck + re-export
// it — the with(ctx) composition then carries the KEY with an undefined
// value, so nothing fails at wiring time and the first real click throws
// "X is not a function" (openIdeFileAtLineSafe, W1-4 path chips).
//
// This test walks app.js's `} = lifecycleComposition;` destructure and
// asserts every key is at least mentioned in the lifecycle composition
// module. Presence is a proxy for "plucked and re-exported", but a wholly
// absent identifier — the failure mode above — can never pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_PATH = path.join(__dirname, '..', 'renderer', 'app.js');
const LIFECYCLE_PATH = path.join(
  __dirname, '..', 'renderer', 'app', 'renderer-app-lifecycle-composition.js'
);

function extractLifecycleDestructureKeys(appSource) {
  const anchor = '} = lifecycleComposition;';
  const end = appSource.indexOf(anchor);
  assert.ok(end > 0, 'app.js must contain the lifecycleComposition destructure');
  const start = appSource.lastIndexOf('const {', end);
  assert.ok(start >= 0, 'destructure opener must precede the anchor');
  const block = appSource.slice(start + 'const {'.length, end);
  const keys = [];
  for (const rawEntry of block.split(',')) {
    // Key is the identifier before any rename (:) or default (=).
    const key = rawEntry.split(':')[0].split('=')[0].trim();
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
      keys.push(key);
    }
  }
  return keys;
}

test('every key app.js destructures from lifecycleComposition exists in the lifecycle composition module', () => {
  const appSource = fs.readFileSync(APP_PATH, 'utf8');
  const lifecycleSource = fs.readFileSync(LIFECYCLE_PATH, 'utf8');
  const keys = extractLifecycleDestructureKeys(appSource);

  // Oracle guards: the extraction must have found the real block, including
  // the identifier whose omission motivated this test.
  assert.ok(keys.length > 80, `expected a large destructure, got ${keys.length} keys`);
  assert.ok(keys.includes('openIdeFileAtLineSafe'), 'extraction must see the W1-4 handler');

  const missing = keys.filter((key) => !new RegExp(`\\b${key}\\b`).test(lifecycleSource));
  assert.deepEqual(
    missing,
    [],
    'keys consumed by app.js but absent from renderer-app-lifecycle-composition.js '
      + '(forgotten middle-hop pluck/re-export — each arrives as undefined in the ctx)'
  );
});
