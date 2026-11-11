'use strict';

/**
 * What one page does about sound and ads (roadmap row 119): its mute state, the ad filter that
 * runs inside the page's network guard, and pressing a video site's own Skip button.
 *
 * The filter only ever refuses more, after the guard has already allowed a request. Hiding rules
 * are plain CSS; nothing from a filter list ever runs in a page.
 */

const { createPageAudio } = require('./page-audio');
const { createAdSkipper } = require('./ad-skip');

const noop = () => {};
const MAIN_FRAME = 'mainFrame';
const CLICK = Object.freeze({ button: 'left', clickCount: 1 });

function createPageExtras({
  webContents, getActionContents, worldId, armView, adBlocker, isAppMuted, isModelActing, pageIsLoopback, isExemptRequest,
  onChanged = noop, setTimer = setTimeout, clearTimer = clearTimeout, keptSettings = null,
}) {
  const attempt = (fn) => { try { return fn(); } catch (_error) { return undefined; } };
  const currentUrl = () => String(attempt(() => webContents.getURL()) || '');
  let adBlockOn = keptSettings?.adBlockOn !== false;
  let adBlockBy = keptSettings?.adBlockBy || '';

  async function press({ x, y }, isCurrent) {
    // Sites ignore a scripted click on Skip, so it has to be a real press. A parked page needs arming to take one.
    if (await armView({ paints: () => true }) !== true || !isCurrent()) return false;
    const contents = getActionContents();
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    contents.sendInputEvent({ type: 'mouseDown', x, y, ...CLICK });
    contents.sendInputEvent({ type: 'mouseUp', x, y, ...CLICK });
    return true;
  }

  const skipper = createAdSkipper({
    getUrl: currentUrl,
    runInPage: (code) => webContents.executeJavaScriptInIsolatedWorld(worldId, [{ code }]),
    press,
    canPress: () => adBlockOn && !isModelActing(),
    setTimer,
    clearTimer,
  });

  let audio = null;
  const syncSkipper = () => skipper.setActive(adBlockOn && audio.keepsPageAlive());
  audio = createPageAudio({
    webContents, isAppMuted, setTimer, clearTimer, startMuted: keptSettings?.chatMuted === true,
    onChanged: () => {
      syncSkipper();
      onChanged();
    },
  });

  function blocksAd(details) {
    if (!adBlockOn || !adBlocker || details?.resourceType === MAIN_FRAME) return false;
    if (pageIsLoopback() || isExemptRequest(details)) return false;
    return adBlocker.shouldBlock({ url: String(details.url), sourceUrl: details.referrer || currentUrl(), type: details.resourceType });
  }

  function hideAds() {
    if (!adBlockOn || !adBlocker || pageIsLoopback()) return;
    const styles = adBlocker.stylesFor(currentUrl());
    if (styles) attempt(() => Promise.resolve(webContents.insertCSS(styles, { cssOrigin: 'user' })).catch(noop));
  }

  // Requests already in flight and rules already applied belong to the old setting, so it takes a reload either way.
  function setAdBlock(enabled, by) {
    const next = enabled === true;
    if (next === adBlockOn) return false;
    adBlockOn = next;
    adBlockBy = next ? '' : String(by || '');
    syncSkipper();
    attempt(() => webContents.reload());
    onChanged();
    return true;
  }

  return {
    blocksAd,
    hideAds,
    setAdBlock,
    place: () => audio.place(),
    park: () => audio.park(),
    navigated: () => audio.navigated(),
    toggleSound: () => audio.toggleChat(),
    applyMute: () => audio.applyMute(),
    sound: () => audio.sound(),
    keepsPageAlive: () => audio.keepsPageAlive(),
    info: () => ({ sound: audio.sound(), ad_block: adBlockOn, ad_block_by: adBlockBy }),
    keptSettings: () => ({ adBlockOn, adBlockBy, chatMuted: audio.chatMuted() }),
    dispose() {
      skipper.dispose();
      audio.dispose();
    },
  };
}

module.exports = { createPageExtras };
