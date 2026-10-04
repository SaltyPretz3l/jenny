'use strict';

// Preload for scripts/report-lingering-tests.js (NODE_OPTIONS=--require=...).
// In each test-file process it records how long the process stayed alive after
// its last test finished and which handle kinds held it open, then appends one
// JSON line to JENNY_LINGER_REPORT when that was over a second. A leaked
// referenced timer is the usual cause: the tests pass, but the file occupies a
// runner slot until the timer fires (two files each sat 30 s, 2026-10-04).

const fs = require('fs');

const LINGER_THRESHOLD_MS = 1000;
const IGNORED_RESOURCES = /^(PipeWrap|TTYWrap|FSReqCallback)$/;
const out = process.env.JENNY_LINGER_REPORT;

// NODE_TEST_CONTEXT is set only in the per-file child `node --test` spawns.
if (out && process.env.NODE_TEST_CONTEXT) {
  let doneAt = null;
  let resources = [];
  try {
    require('node:test').after(() => {
      doneAt = Date.now();
      setTimeout(() => {
        try {
          resources = process.getActiveResourcesInfo().filter((name) => !IGNORED_RESOURCES.test(name));
        } catch {
          // the report is best-effort
        }
      }, 300).unref();
    });
  } catch {
    // not a test process
  }
  process.on('exit', () => {
    if (doneAt === null) return;
    const lingerMs = Date.now() - doneAt;
    if (lingerMs < LINGER_THRESHOLD_MS) return;
    try {
      fs.appendFileSync(out, `${JSON.stringify({ file: process.argv[1], lingerMs, resources })}\n`);
    } catch {
      // the report is best-effort
    }
  });
}
