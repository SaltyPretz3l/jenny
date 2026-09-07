'use strict';

// node:test on Node 22 (the `.nvmrc` runner) lets the event loop drain while a
// test awaits a promise that only an unref'd timer can settle, then fails the
// test with "Promise resolution is still pending but the event loop has already
// resolved". Node 24's runner keeps the loop alive on its own, which is why the
// failure only shows in CI. Production timers are unref'd on purpose (the app
// must be able to exit with a timer pending), so the TEST holds the reference
// instead of the product growing one.
//
// Usage at the top of a test file, right after the node:test require:
//
//   holdEventLoopUntilTestsFinish(test);

// The largest delay Node accepts; the callback never runs before release.
const HOLD_INTERVAL_MS = 0x7fffffff;

function holdEventLoop() {
  const handle = setInterval(() => {}, HOLD_INTERVAL_MS);
  let released = false;
  return function releaseEventLoop() {
    if (released) return;
    released = true;
    clearInterval(handle);
  };
}

function holdEventLoopUntilTestsFinish(test) {
  const release = holdEventLoop();
  test.after(release);
  return release;
}

module.exports = {
  holdEventLoop,
  holdEventLoopUntilTestsFinish,
};
