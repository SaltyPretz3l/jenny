'use strict';

/**
 * Sound for one browser page (roadmap row 119). A page keeps playing in the background only when it
 * was audible at the moment it left the screen; a page that starts making noise while hidden stays
 * silent. Electron keeps reporting `isCurrentlyAudible()` true while a page is muted, and
 * `audio-state-changed` flickers off for a few hundred ms around ad changes, so the audible flag is
 * smoothed: a rise applies at once, a fall only after `settleMs` of continuous silence.
 */

const noop = () => {};

function createPageAudio({
  webContents,
  isAppMuted = () => false,
  onChanged = noop,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  settleMs = 2500,
  quietMs = 30000,
  startMuted = false,
}) {
  let onScreen = false;
  let heardInBackground = false;
  let chatMuted = startMuted;
  let audible = false;
  let appliedMute = null;
  let lastNotified = 'null/false';
  let fallTimer = null;
  let quietTimer = null;
  let disposed = false;

  const silenced = () => chatMuted || (!onScreen && !heardInBackground);
  const effectiveMuted = () => Boolean(isAppMuted()) || silenced();
  // Electron reports audible through a mute, so this is true for a muted page that is still playing.
  const keepsPageAlive = () => audible && (onScreen || heardInBackground || chatMuted);

  function sound() {
    if (chatMuted) return 'muted';
    if (!audible) return null;
    return effectiveMuted() ? 'muted' : 'playing';
  }

  function cancel(timer) {
    if (timer !== null) clearTimer(timer);
    return null;
  }

  function notify() {
    const current = `${sound()}/${keepsPageAlive()}`;
    if (current === lastNotified) return;
    lastNotified = current;
    try { onChanged(); } catch { /* a listener must not break audio state */ }
  }

  function applyMute() {
    if (disposed) return;
    const muted = effectiveMuted();
    if (muted !== appliedMute) {
      appliedMute = muted;
      try { webContents.setAudioMuted(muted); } catch { /* the page may already be destroyed */ }
    }
    notify();
  }

  // After quietMs of smoothed silence a parked page that was heard stops being allowed to play on.
  function syncQuietTimer() {
    const wanted = !onScreen && heardInBackground && !audible;
    if (!wanted) {
      quietTimer = cancel(quietTimer);
      return;
    }
    if (quietTimer !== null) return;
    quietTimer = setTimer(() => {
      quietTimer = null;
      heardInBackground = false;
      applyMute();
    }, quietMs);
    quietTimer?.unref?.();
  }

  function onAudioState(event) {
    if (disposed) return;
    if (event?.audible === true) {
      fallTimer = cancel(fallTimer);
      audible = true;
      syncQuietTimer();
      notify();
      return;
    }
    if (!audible || fallTimer !== null) return;
    fallTimer = setTimer(() => {
      fallTimer = null;
      audible = false;
      syncQuietTimer();
      notify();
    }, settleMs);
    fallTimer?.unref?.();
  }

  function isHeardNow() {
    try { return webContents.isCurrentlyAudible() === true; } catch { return false; }
  }

  function place() {
    onScreen = true;
    heardInBackground = false;
    syncQuietTimer();
    applyMute();
  }

  function park() {
    // The window mute does not count: unmuting later should bring this page back.
    heardInBackground = (audible || isHeardNow()) && !silenced(); // audible rides out a flicker at the moment of leaving
    onScreen = false;
    syncQuietTimer();
    applyMute();
  }

  function toggleChat() {
    if (isAppMuted()) return;
    if (silenced()) {
      chatMuted = false;
      if (!onScreen) heardInBackground = true;
    } else {
      chatMuted = true;
    }
    syncQuietTimer();
    applyMute();
  }

  // A new document is a new source of sound, so a parked page has to earn the background again.
  function navigated() {
    if (onScreen || !heardInBackground) return;
    heardInBackground = false;
    syncQuietTimer();
    applyMute();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    fallTimer = cancel(fallTimer);
    quietTimer = cancel(quietTimer);
    try { webContents.removeListener('audio-state-changed', onAudioState); } catch { /* destroyed */ }
  }

  webContents.on('audio-state-changed', onAudioState);
  applyMute();

  return {
    place,
    park,
    navigated,
    toggleChat,
    applyMute,
    sound,
    chatMuted: () => chatMuted,
    keepsPageAlive,
    dispose,
  };
}

module.exports = { createPageAudio };
