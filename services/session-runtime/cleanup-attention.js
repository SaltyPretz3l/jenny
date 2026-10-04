'use strict';

// An unproven settlement usually confirms late within milliseconds (a user
// cancel: dogfood TR-003 logged an ERROR that healed 2 ms later). Raise the
// attention only when the entry is still waiting after a short grace.
function deferCleanupAttention({ graceMs, setTimer = setTimeout } = {}, stillWaiting, raise) {
  const raiseIfWaiting = () => { if (stillWaiting()) raise(); };
  if (!(graceMs > 0)) return raiseIfWaiting();
  setTimer(raiseIfWaiting, graceMs)?.unref?.();
  return undefined;
}

module.exports = { deferCleanupAttention };
