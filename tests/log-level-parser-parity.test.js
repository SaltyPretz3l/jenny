'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// P11 drift guard. `resolveStructuredLogLevel` is implemented twice — once in
// the main-process CJS module (services/log-level-utils.js) and once in the
// renderer's sandboxed UMD (renderer/shared/log-view-utils.js) — because the
// two layers cannot share a runtime module across the process boundary. The
// structured-line PARSE (split on " msg=", extract level="…") must stay
// identical; only the output CASING differs by design (services → UPPERCASE
// canonical levels, renderer → lowercase view tokens). This test fails the
// moment one copy's parse drifts from the other.

const services = require('../services/log-level-utils');
const renderer = require('../renderer/shared/log-view-utils');

const LINES = [
  'level=ERROR msg="boom" foo=bar',
  'level="warn" component=ollama msg=slow',
  '  level=INFO  msg=ok',
  'time=2026 level=FATAL msg="panic" stack=...',
  'level=trace msg=verbose',
  'level=WARNING msg="careful"',
  'no level here msg=whatever',
  'msg="level=ERROR is inside the message, not a field"',
  '',
  'level=DEBUG',
];

test('both resolveStructuredLogLevel copies parse the same level token (case-normalized)', () => {
  for (const line of LINES) {
    const fromServices = services.resolveStructuredLogLevel({ line, defaultLevel: 'INFO' });
    const fromRenderer = renderer.resolveStructuredLogLevel(line, 'info');
    assert.equal(
      String(fromServices).toLowerCase(),
      String(fromRenderer).toLowerCase(),
      `parse drift for line: ${JSON.stringify(line)} (services=${fromServices}, renderer=${fromRenderer})`,
    );
  }
});

test('mapStructuredLogLevelToken agrees on the canonical bucket (case-normalized)', () => {
  for (const token of ['TRACE', 'debug', 'Info', 'warn', 'WARNING', 'error', 'FATAL', 'PANIC', 'bogus']) {
    const svc = services.mapStructuredLogLevelToken(token, 'INFO');
    const rnd = renderer.mapStructuredLogLevelToken(token, 'info');
    assert.equal(String(svc).toLowerCase(), String(rnd).toLowerCase(), `map drift for token: ${token}`);
  }
});

test('the message body is never mistaken for a level field (parse boundary holds in both)', () => {
  const line = 'level=ERROR msg="level=DEBUG appears here"';
  assert.equal(services.resolveStructuredLogLevel({ line, defaultLevel: 'INFO' }), 'ERROR');
  assert.equal(renderer.resolveStructuredLogLevel(line, 'info'), 'error');
});
