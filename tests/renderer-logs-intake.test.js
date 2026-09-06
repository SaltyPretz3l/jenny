'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

/* End-to-end intake hardening: drive the real jennyShell.logs.onAppend wiring
   (pushIncomingLog) with hostile payloads and assert the buffer stays clean. */
test('onAppend intake clamps malformed ts, coerces level/event, and size-caps details', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => {
    await app.dispose();
  });
  const { window, shell } = app;

  const huge = 'x'.repeat(40000);
  await shell.__emitLogAppend({
    entry_id: 'log-hostile',
    ts: 'not-a-date',
    level: 42,
    event: { nested: true },
    details: { blob: huge },
  });
  await waitForUi(window, 10);

  const landed = window.__rendererState.logs.find((entry) => entry.entry_id === 'log-hostile');
  assert.ok(landed, 'hostile entry should still land in the buffer');
  assert.ok(
    Number.isFinite(new Date(landed.ts).getTime()),
    'malformed ts must be clamped to a parseable date so the newest-first sort stays stable'
  );
  assert.equal(typeof landed.level, 'string', 'non-string level coerced');
  assert.equal(typeof landed.event, 'string', 'non-string event coerced');
  assert.equal(landed.details._truncated, true, 'oversized details replaced with a truncation marker');
  assert.ok(landed.details._originalSize > 32768, 'truncation marker records the original size');
  assert.doesNotThrow(() => JSON.stringify(landed.details), 'stored details must be serializable');
});
