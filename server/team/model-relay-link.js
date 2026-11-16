'use strict';

// The owner's relay setting on the parent channel (row 123 slice 6-7; TEAM_MODEL_SHARING_SPEC "6-7 as built"). The
// desktop's `model_relay { flowing }` (0 off, 1 to 4 at once) goes to model sharing's `setFlowingLimit` with no restart;
// the host answers `model_relay { flowing, passing }`: the limit the relay holds and how many transfers flow through
// it now. It is sent after each setting (the desktop sends its saved one when the host is running) and whenever either
// number moved since, read from the sharing's `resources()` (counts only: no member, name, hash, path or byte figure)
// on one unref'd timer every `periodMs`. Nothing is sent before the desktop's first setting.
// What a lowered limit does is the relay's own (model-relay.js `setFlowingLimit`): transfers already flowing go on,
// queued ones wait for a free slot; 0 ends every live transfer as `sharing_off`.

const PERIOD_MS = 2000;
const TIMERS = Object.freeze({ setInterval, clearInterval });

/** sharing: the host's model sharing (model-sharing.js). send(message): the parent channel's send. */
function createModelRelayLink({ sharing, send, periodMs = PERIOD_MS, timers = TIMERS } = {}) {
  if (typeof sharing?.setFlowingLimit !== 'function' || typeof sharing.resources !== 'function') throw new TypeError('The relay link needs model sharing.');
  if (typeof send !== 'function') throw new TypeError('The relay link needs a send function.');
  let told = '';
  let timer = null;
  let disposed = false;

  function current() {
    const relay = sharing.resources().relay;
    const passing = relay && relay.transfers && Number.isSafeInteger(relay.transfers.flowing) ? relay.transfers.flowing : 0;
    return { flowing: relay && Number.isSafeInteger(relay.flowingLimit) ? relay.flowingLimit : 0, passing };
  }

  function report(force = false) {
    if (disposed) return;
    let now;
    try { now = current(); } catch { return; }
    const key = now.flowing + ':' + now.passing;
    if (!force && key === told) return;
    told = key;
    try { send({ type: 'model_relay', flowing: now.flowing, passing: now.passing }); } catch { /* the channel's own */ }
  }

  /** The desktop's setting. A refusal leaves the relay as it was; the answer is the state as it now is. */
  function set(flowing) {
    if (disposed) return;
    try { sharing.setFlowingLimit(flowing); } catch { /* answered by the report below */ }
    report(true);
  }

  timer = timers.setInterval(() => { if (told) report(false); }, periodMs);
  timer?.unref?.();

  return Object.freeze({
    set,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) timers.clearInterval(timer);
      timer = null;
    },
    resources: () => ({ timers: timer === null ? 0 : 1, disposed }),
  });
}

module.exports = { createModelRelayLink };
