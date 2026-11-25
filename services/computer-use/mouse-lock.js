'use strict';

/* services/computer-use/mouse-lock.js: one chat holds the real mouse at a time (row 196).
 *
 * A chat takes the lock with its first input action and keeps it until its turn ends (or the chat is
 * forgotten). Looking (screenshot, windows, wait) never needs it. Taking is synchronous, so two calls
 * that race for the lock cannot both win. */

function createMouseLock() {
  let holder = null;
  return {
    /** True when the chat now holds the lock (or already did); false while another chat has it. */
    acquire(sessionId) {
      if (holder !== null && holder !== sessionId) return false;
      holder = sessionId;
      return true;
    },
    /** Only the holder can let go. */
    release(sessionId) {
      if (holder !== sessionId) return false;
      holder = null;
      return true;
    },
    holder: () => holder,
  };
}

module.exports = { createMouseLock };
