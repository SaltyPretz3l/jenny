const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Wiring-parity pin: renderer-stream-handler-dispatch.js invokes
// `handlers.<name>(...)` for each stream payload type, but the handlers
// object is assembled by hand in renderer-stream-handler.js. A handler added
// to the terminal/tool modules and the dispatch WITHOUT the stream-handler
// enumeration fails at runtime with "handlers.<name> is not a function"
// (exactly how the live plan_proposal turn broke). This test extracts every
// handler name the dispatch calls and asserts the stream handler wires it.

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('every handler the stream dispatch invokes is wired by renderer-stream-handler.js', () => {
  const dispatchSource = readSource('renderer/chat/renderer-stream-handler-dispatch.js');
  const wiringSource = readSource('renderer/chat/renderer-stream-handler.js');

  const invoked = new Set();
  for (const match of dispatchSource.matchAll(/\bhandlers\.(handle[A-Za-z0-9_]+)\s*\(/g)) {
    invoked.add(match[1]);
  }
  assert.ok(invoked.size >= 10, `expected to find dispatch handler calls, got ${invoked.size}`);

  // The handlers object literal passed to the dispatch router.
  const handlersBlockMatch = wiringSource.match(/handlers:\s*\{([\s\S]*?)\}/);
  assert.ok(handlersBlockMatch, 'renderer-stream-handler.js should pass a handlers object to the dispatch router');
  const handlersBlock = handlersBlockMatch[1];

  const missing = [...invoked].filter((name) => !new RegExp(`\\b${name}\\b`).test(handlersBlock));
  assert.deepEqual(
    missing,
    [],
    `dispatch invokes handlers the stream handler never wires: ${missing.join(', ')}`
  );
});
