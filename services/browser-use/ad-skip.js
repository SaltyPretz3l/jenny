'use strict';

/* global document, window, getComputedStyle */

/**
 * Presses YouTube's Skip button for the model (roadmap row 119). The button ignores a scripted
 * element.click(), so the page only reports where the button is and the caller sends a real mouse
 * press at that spot. Timers are injected so this runs on a virtual clock in tests.
 */

const SKIP_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const MAX_PRESSES = 3;

function isSkipSite(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' && parsed.port === '' && SKIP_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Serialised with String(fn) and run in the page's isolated world, so it may only touch page
 * globals. Evaluates to the Skip button's centre in CSS pixels, or null.
 */
function skipQuery() {
  const player = document.querySelector('#movie_player.ad-showing');
  const button = player ? player.querySelector('.ytp-skip-ad-button') : null;
  if (!button || button.getClientRects().length === 0) return null;
  // A hidden or faded ancestor hides the button too, so walk up to the player.
  for (let node = button; node && node !== player.parentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || !(parseFloat(style.opacity) > 0.1)) return null;
  }
  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (!(x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight)) return null;
  return { x, y };
}

const SKIP_QUERY = `(${String(skipQuery)})()`;

const isPoint = (hit) => Boolean(hit) && Number.isFinite(hit.x) && Number.isFinite(hit.y);

function createAdSkipper({
  getUrl, runInPage, press, canPress,
  setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 1000, cooldownMs = 2000,
}) {
  let active = false;
  let busy = false;
  let presses = 0;
  let pollTimer = null;
  let coolTimer = null;

  function stopTimers() {
    if (pollTimer !== null) clearTimer(pollTimer);
    if (coolTimer !== null) clearTimer(coolTimer);
    pollTimer = null;
    coolTimer = null;
  }

  function startCooldown() {
    coolTimer = setTimer(() => { coolTimer = null; }, cooldownMs);
    coolTimer?.unref?.();
  }

  function ready() {
    return isSkipSite(getUrl()) && canPress() && coolTimer === null;
  }

  async function look() {
    const url = getUrl();
    const hit = await runInPage(SKIP_QUERY);
    if (!isPoint(hit)) {
      presses = 0;
      return;
    }
    // Checked again by the press itself, after arming: the input must never land on a page that has moved on.
    const isCurrent = () => active && getUrl() === url && canPress();
    if (!isCurrent() || presses >= MAX_PRESSES) return;
    startCooldown();
    if (await press({ x: hit.x, y: hit.y }, isCurrent) !== false) presses += 1;
  }

  async function tick() {
    pollTimer = null;
    busy = true;
    try {
      if (ready()) await look();
    } catch {
      // A failed look or press must not end polling; the next tick tries again.
    } finally {
      busy = false;
      schedule();
    }
  }

  function schedule() {
    if (!active || busy || pollTimer !== null) return;
    pollTimer = setTimer(tick, intervalMs);
    pollTimer?.unref?.();
  }

  function setActive(on) {
    const next = Boolean(on);
    if (next === active) return;
    active = next;
    if (active) schedule();
    else stopTimers();
  }

  function dispose() {
    active = false;
    stopTimers();
  }

  return { setActive, dispose };
}

module.exports = { createAdSkipper, SKIP_QUERY, isSkipSite };
