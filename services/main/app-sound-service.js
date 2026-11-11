'use strict';

/**
 * The app-wide sound switch (roadmap row 119). One mute flag for every web contents that is not a
 * managed browser page (those apply it themselves through onMuteChanged), plus a small picture of
 * what is making noise: chats whose browser page is playing, and the main window. Electron arrives
 * through the options, so this loads in plain Node.
 */

const noop = () => {};
const CHANGE_CHANNEL = 'appSound.onChanged';
const AUDIO_EVENT = 'audio-state-changed';
const DEFAULT_SETTLE_MS = 2500;
const CHAT_SOUNDS = new Set(['playing', 'muted']);

function isDestroyed(contents) {
  try {
    return !contents || contents.isDestroyed?.() === true;
  } catch {
    return true;
  }
}

function createAppSound({
  listContents, isManagedPage, sendBridgeEvent, onMuteChanged = noop, logger,
  setTimer = setTimeout, clearTimer = clearTimeout, settleMs = DEFAULT_SETTLE_MS,
} = {}) {
  const chats = new Map();
  let muted = false;
  let mainAudible = false;
  let mainTimer = null;
  let watched = null;
  let lastPushed = '';
  let disposed = false;

  function chatsObject() {
    // defineProperty keeps an id such as __proto__ an ordinary own key.
    const out = {};
    for (const [id, sound] of chats) {
      Object.defineProperty(out, id, { value: sound, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  function isAudible() {
    if (mainAudible) return true;
    for (const sound of chats.values()) if (sound === 'playing') return true;
    return false;
  }

  function state() {
    return { muted, audible: isAudible(), chats: chatsObject() };
  }

  function push() {
    if (disposed) return;
    const snapshot = state();
    const signature = JSON.stringify([snapshot.muted, snapshot.audible, [...chats]]);
    if (signature === lastPushed) return;
    lastPushed = signature;
    try {
      sendBridgeEvent?.(CHANGE_CHANNEL, snapshot);
    } catch {
      logger?.warn?.('App sound change could not be sent.');
    }
  }

  function applyOne(contents) {
    if (isDestroyed(contents)) return;
    try {
      if (isManagedPage(contents)) return;
      contents.setAudioMuted(muted);
    } catch {
      logger?.warn?.('App sound could not be applied to a page.');
    }
  }

  function setMuted(next) {
    if (next === muted) return;
    muted = next;
    let all = [];
    try {
      all = listContents() || [];
    } catch {
      logger?.warn?.('App sound could not list pages.');
    }
    for (const contents of all) applyOne(contents);
    try {
      onMuteChanged();
    } catch {
      logger?.warn?.('App sound mute listener failed.');
    }
    push();
  }

  function noteChatSound(sessionId, sound) {
    const id = String(sessionId);
    if (!CHAT_SOUNDS.has(sound)) {
      if (chats.delete(id)) push();
      return;
    }
    if (chats.get(id) === sound) return;
    chats.set(id, sound);
    push();
  }

  function cancelFall() {
    if (mainTimer === null) return;
    clearTimer(mainTimer);
    mainTimer = null;
  }

  function onMainAudio(event) {
    if (disposed) return;
    if (event?.audible) {
      cancelFall();
      if (!mainAudible) {
        mainAudible = true;
        push();
      }
      return;
    }
    if (!mainAudible || mainTimer !== null) return;
    mainTimer = setTimer(() => {
      mainTimer = null;
      mainAudible = false;
      push();
    }, settleMs);
    mainTimer?.unref?.();
  }

  function watchMainContents(contents) {
    if (disposed || !contents || watched) return;
    watched = contents;
    contents.on(AUDIO_EVENT, onMainAudio);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelFall();
    if (watched) {
      try {
        watched.removeListener(AUDIO_EVENT, onMainAudio);
      } catch {
        // The contents may already be gone.
      }
    }
    watched = null;
  }

  return {
    state, isMuted: () => muted, setMuted, noteChatSound, watchMainContents, applyToContents: applyOne, dispose,
  };
}

module.exports = { createAppSound };
