'use strict';

// The first sync of a session lands instantly at the bottom (approval prompt
// or not). Tests about later syncs spend that landing first, on an empty
// thread with follow released (no landing, no hold).
function spendOpenLanding(harness) {
  const wasFollowing = harness.state.ui.followLatest;
  harness.state.ui.followLatest = false;
  harness.controller.scheduleMessageViewportSync([], {});
  harness.flushAnimationFrame();
  harness.state.ui.followLatest = wasFollowing;
}

module.exports = { spendOpenLanding };
