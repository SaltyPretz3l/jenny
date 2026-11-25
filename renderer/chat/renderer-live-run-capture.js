/* renderer/chat/renderer-live-run-capture.js - the Live panel's picture (row 197, C8): the capture and the stage it fills.
 *
 * One capture at a time. Main is asked to arm a one-use slot for the run's window; the window is requested in
 * the same task as the answer, never before it, and never without it. The track runs only while the panel asks
 * for it (tab showing, window visible, run live) and every stop ends all of its tracks. The panel never names a
 * source: main's handler grants only the window it armed. Loaded lazily with the Live panel.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererLiveRunCapture = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FRAME_RATE = 30;
  const RETRY_MS = 400; // one more try for a slot a replaced request still held
  const SLOT_MS = 2000; // how long main keeps an armed slot
  const STALE_MS = 1500; // an answer later than this may find its slot gone
  const keyOf = (want) => `${want.projectId}|${want.generation}|${want.sourceId}`;

  // The fractions of the window's drawn bounds that lie outside the client area, or null when they cannot be trusted:
  // main's own rule, each edge under half.
  function validCrop(crop) {
    if (!crop || typeof crop !== 'object') return null;
    const { left, top, right, bottom } = crop;
    if (![left, top, right, bottom].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 0.5)) return null;
    return left + right < 1 && top + bottom < 1 ? { left, top, right, bottom } : null;
  }
  const percent = (n) => `${n.toFixed(4)}%`;

  // deps = { windowRef, arm(projectId) -> { ok }, onChange(), createCanvas?(), now?() }
  function createLiveRunCapture(deps) {
    const { windowRef, arm, onChange } = deps;
    const doc = windowRef.document;
    const createCanvas = deps.createCanvas || (() => doc.createElement('canvas'));
    const now = deps.now || Date.now;
    let key = '';
    let stream = null;
    let video = null;
    let clip = null; // the box the video sits in; it cuts away what a crop removes
    let crop = null;
    let failed = false;
    let token = 0;
    let busy = 0; // requests between their arm and the end of their window request
    let endBusy = null;

    const el = (tag, className) => Object.assign(doc.createElement(tag), { className });
    const stopTracks = (media) => (media?.getTracks?.() || []).forEach((track) => track.stop());

    function release() {
      token += 1; // a request still on its way finds itself superseded
      stopTracks(stream);
      stream = null;
      clip?.remove();
      video = null;
      clip = null;
    }

    // Shows only the client area: the clip box takes the visible shape and the video is sized and moved so that area fills it.
    function applyCrop() {
      if (!video || !clip) return;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!crop || !(width > 0) || !(height > 0)) {
        delete clip.dataset.cropped;
        clip.style.removeProperty('--lv-aspect');
        for (const name of ['--lv-vw', '--lv-vh', '--lv-left', '--lv-top']) video.style.removeProperty(name);
        return;
      }
      const across = 1 - crop.left - crop.right;
      const down = 1 - crop.top - crop.bottom;
      clip.dataset.cropped = 'true';
      clip.style.setProperty('--lv-aspect', ((width * across) / (height * down)).toFixed(4));
      video.style.setProperty('--lv-vw', percent(100 / across));
      video.style.setProperty('--lv-vh', percent(100 / down));
      video.style.setProperty('--lv-left', percent((-crop.left / across) * 100));
      video.style.setProperty('--lv-top', percent((-crop.top / down) * 100));
    }

    function setCrop(next) {
      const valid = validCrop(next);
      if (JSON.stringify(valid) === JSON.stringify(crop)) return; // every state push carries it
      crop = valid;
      applyCrop();
    }

    function makeVideo(media) {
      const el = doc.createElement('video');
      el.muted = true;
      el.setAttribute('muted', '');
      el.autoplay = true;
      el.setAttribute('autoplay', '');
      el.setAttribute('playsinline', '');
      el.className = 'lv-game';
      el.srcObject = media;
      el.addEventListener('loadedmetadata', applyCrop);
      el.addEventListener('resize', applyCrop);
      return el;
    }

    const takeSlot = () => windowRef.navigator.mediaDevices.getDisplayMedia({ video: { frameRate: FRAME_RATE }, audio: false });
    const armOnce = async (projectId) => {
      try { return await arm(projectId); } catch (_error) { return null; }
    };

    // While a request is between its arm and the end of its window request the window says so, for the composer's own capture.
    function beginBusy() {
      if (busy++ > 0) return;
      windowRef.__jennyLiveCaptureIdle = new Promise((resolve) => { endBusy = resolve; });
    }
    function finishBusy() {
      if (--busy > 0) return;
      windowRef.__jennyLiveCaptureIdle = null;
      endBusy?.();
      endBusy = null;
    }

    async function start(want, mine, retried = false) {
      beginBusy();
      try {
        await startOnce(want, mine, retried);
      } finally {
        finishBusy();
      }
    }

    async function startOnce(want, mine, retried) {
      const armedAt = now();
      const armed = await armOnce(want.projectId);
      // An answer that took long may name a slot main has dropped: using it would open the picker or take a newer slot.
      const usable = armed?.ok === true && now() - armedAt <= STALE_MS;
      if (mine !== token) {
        // Superseded: use the one-time slot now so the newer request is not refused while it lives.
        if (usable) await Promise.resolve().then(takeSlot).then(stopTracks, () => {});
        return;
      }
      if (!usable) {
        // The slot may still be held by a request that was just replaced: try once more shortly. A slot armed for a
        // late answer stays armed until it times out, so that retry waits until just after it has.
        const delay = armed?.ok === true ? Math.max(RETRY_MS, SLOT_MS + 100 - (now() - armedAt)) : RETRY_MS;
        if (!retried) { windowRef.setTimeout(() => { if (mine === token) void start(want, mine, true); }, delay); return; }
        failed = true; onChange(); return;
      }
      let media;
      try {
        // Right after the answer, in the same task: the slot is one use and short lived.
        media = await takeSlot();
      } catch (_error) { media = null; }
      if (mine !== token) { stopTracks(media); return; }
      if (!media) { failed = true; onChange(); return; }
      stream = media;
      video = makeVideo(media);
      clip = el('div', 'lv-clip');
      clip.append(video);
      applyCrop();
      onChange();
    }

    // want: { projectId, sourceId, generation } while a picture is wanted, else null.
    function sync(want) {
      if (!want) {
        if (key || stream || failed) { key = ''; failed = false; release(); }
        return;
      }
      const next = keyOf(want);
      if (next === key) return;
      release();
      key = next;
      failed = false;
      void start(want, token);
    }

    // Puts the live video in `host`; true when there is one to show.
    function attach(host) {
      if (!clip) return false;
      if (clip.parentNode !== host) host.appendChild(clip);
      return true;
    }

    // The still shown under the states that use the last frame: not clickable.
    function stillPicture(url) {
      const picture = el('div', 'lv-picture');
      picture.dataset.static = 'true';
      const image = el('img', 'lv-game');
      image.alt = '';
      image.src = url;
      picture.append(image);
      return picture;
    }

    // The live picture: a button that brings the real window forward; the video joins it when there is one.
    function livePicture(label) {
      const picture = el('div', 'lv-picture');
      picture.setAttribute('role', 'button');
      picture.tabIndex = 0;
      picture.title = label;
      picture.setAttribute('aria-label', label);
      attach(picture);
      return picture;
    }

    // The frame on screen now as a picture (a data URL), or '' when there is none.
    function still() {
      if (!video || !(video.videoWidth > 0)) return '';
      try {
        const canvas = createCanvas();
        const { videoWidth: width, videoHeight: height } = video;
        if (crop) { // the client area only, the same rectangle the live video shows
          const sx = crop.left * width;
          const sy = crop.top * height;
          const sw = width * (1 - crop.left - crop.right);
          const sh = height * (1 - crop.top - crop.bottom);
          canvas.width = Math.round(sw);
          canvas.height = Math.round(sh);
          canvas.getContext('2d')?.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        } else {
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d')?.drawImage(video, 0, 0);
        }
        return canvas.toDataURL('image/png');
      } catch (_error) {
        return '';
      }
    }

    return { sync, setCrop, attach, still, stillPicture, livePicture, hasFailed: () => failed, hasVideo: () => video !== null, dispose: () => sync(null) };
  }

  // The 16:9 stage: a picture or still, text laid over it, or one line of words; `load` adds the sliding bar.
  function stageNodes(doc, { look = '', picture = null, overlay = null, text = '', load = false }) {
    const box = doc.createElement('div');
    box.className = 'bu-stage lv-stage';
    box.dataset.look = look;
    if (picture) box.append(picture);
    if (overlay) box.append(overlay);
    if (text) {
      const wrap = doc.createElement('div');
      wrap.className = 'lv-stage-text';
      const line = doc.createElement('span');
      line.textContent = text;
      line.setAttribute('role', 'status');
      wrap.append(line);
      box.append(wrap);
    }
    if (!load) return [box];
    const bar = doc.createElement('span');
    bar.className = 'bu-load';
    bar.setAttribute('aria-hidden', 'true');
    return [bar, box];
  }

  return { createLiveRunCapture, stageNodes, FRAME_RATE };
});
