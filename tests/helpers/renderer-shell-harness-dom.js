const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const {
  SCRIPT_ORDER,
  createCanvasContext,
  createPretextLayoutMock,
} = require('./renderer-shell-harness-support');

const UI_TICK_MS = 25;
const RENDERER_READY_TIMEOUT_MS = 1000;
const RAF_FRAME_MS = 16;

async function waitForUi(window, ms = UI_TICK_MS) {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readySignalCount(shellState) {
  return Number(shellState?.lifecycleReadySignals || 0);
}

// Waits for a ready signal STRICTLY NEWER than `afterSignals`, and throws when one
// never arrives. Both halves matter: the counter is cumulative, so a reload that
// compared against 0 saw the previous run's signal and returned before the new
// renderer had booted; and the old loop simply fell out at the timeout and returned
// normally, so a renderer that never became ready let the whole suite proceed green.
async function waitForRendererReady(
  window,
  shellState,
  { timeoutMs = RENDERER_READY_TIMEOUT_MS, afterSignals = 0 } = {},
) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    if (readySignalCount(shellState) > afterSignals) {
      await waitForUi(window);
      return;
    }
    await waitForUi(window);
  }
  throw new Error(
    `renderer never signalled ready within ${timeoutMs}ms: lifecycleReadySignals `
    + `stayed at ${readySignalCount(shellState)}, needed > ${afterSignals}`,
  );
}

async function loadRendererApp({
  options = {},
  root,
  createShellStub,
} = {}) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const { window } = dom;
  const settings = options || {};
  // Optional viewport-width override applied BEFORE the renderer scripts run, so
  // the very first bootstrap renderAll() sees a real stage width. jsdom defaults
  // window.innerWidth to 1024 and getBoundingClientRect() to 0, which keeps the
  // artifact review panel below its 1080px min-stage width and thus never
  // "visible" at cold boot -- masking any boot-time visibility race. Tests that
  // need the panel visible during the pre-hydration render pass set this.
  for (const [prop, key] of [['innerWidth', 'windowInnerWidth'], ['innerHeight', 'windowInnerHeight']]) {
    const value = Number(settings[key]);
    if (Number.isFinite(value)) {
      Object.defineProperty(window, prop, { configurable: true, value });
    }
  }
  let closed = false;
  let allowNewTimers = true;
  let disposePromise = null;
  let closePromise = null;
  const timeoutTimers = new Map();
  const intervalTimers = new Map();

  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  window.setTimeout = (callback, ms = 0, ...args) => {
    if (!allowNewTimers) {
      return 0;
    }
    const id = nativeSetTimeout(() => {
      timeoutTimers.delete(id);
      if (!closed && typeof callback === 'function') {
        callback(...args);
      }
    }, ms);
    timeoutTimers.set(id, true);
    return id;
  };
  window.clearTimeout = (id) => {
    timeoutTimers.delete(id);
    nativeClearTimeout(id);
  };

  window.matchMedia = () => ({
    matches: Boolean(settings.reducedMotion),
    addEventListener() {},
    removeEventListener() {},
  });

  let rafId = 0;
  const rafTimers = new Map();
  window.requestAnimationFrame = (callback) => {
    if (!allowNewTimers) {
      return 0;
    }
    const id = ++rafId;
    const timer = window.setTimeout(() => {
      rafTimers.delete(id);
      if (typeof callback === 'function') {
        callback(Date.now());
      }
    }, RAF_FRAME_MS);
    rafTimers.set(id, timer);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    const timer = rafTimers.get(id);
    if (!timer) {
      return;
    }
    rafTimers.delete(id);
    window.clearTimeout(timer);
  };

  if (typeof settings.requestAnimationFrame === 'function') {
    const customRaf = settings.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      if (!allowNewTimers) return 0;
      return customRaf(callback);
    };
  }
  if (typeof settings.cancelAnimationFrame === 'function') {
    const customCancel = settings.cancelAnimationFrame;
    window.cancelAnimationFrame = (handle) => customCancel(handle);
  }

  window.setInterval = (callback, ms = 0, ...args) => {
    if (!allowNewTimers) {
      return 0;
    }
    const id = nativeSetTimeout(() => {
      intervalTimers.delete(id);
      if (!closed && typeof callback === 'function') {
        callback(...args);
      }
    }, ms);
    intervalTimers.set(id, true);
    return id;
  };
  window.clearInterval = (id) => {
    intervalTimers.delete(id);
    nativeClearTimeout(id);
  };

  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.HTMLCanvasElement.prototype.getContext = () => createCanvasContext();
  window.HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type) {
    const payload = new window.Blob([Uint8Array.from([137, 80, 78, 71])], {
      type: type || 'image/png',
    });
    callback(payload);
  };
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  window.prompt = () => null;
  window.confirm = () => false;
  window.performance.now = () => Date.now();
  const mediaDeviceListeners = new Map();
  const mediaDevices = {
    getDisplayMedia:
      typeof settings.displayMedia === 'function'
        ? settings.displayMedia
        : async () => ({
            getVideoTracks() {
              return [{
                getSettings() {
                  return { width: 640, height: 360, displaySurface: 'monitor' };
                },
                stop() {},
              }];
            },
            getTracks() {
              return this.getVideoTracks();
            },
          }),
    getUserMedia:
      typeof settings.getUserMedia === 'function'
        ? settings.getUserMedia
        : async () => ({
            getTracks() {
              return [{
                kind: 'audio',
                stop() {},
              }];
            },
          }),
    enumerateDevices:
      typeof settings.enumerateDevices === 'function'
        ? settings.enumerateDevices
        : async () => (Array.isArray(settings.enumerateDevices) ? settings.enumerateDevices : []),
    addEventListener(eventName, listener) {
      const listeners = mediaDeviceListeners.get(eventName) || [];
      listeners.push(listener);
      mediaDeviceListeners.set(eventName, listeners);
    },
    removeEventListener(eventName, listener) {
      const listeners = mediaDeviceListeners.get(eventName) || [];
      mediaDeviceListeners.set(
        eventName,
        listeners.filter((candidate) => candidate !== listener)
      );
    },
    __emit(eventName, payload) {
      const listeners = mediaDeviceListeners.get(eventName) || [];
      for (const listener of listeners) {
        listener(payload);
      }
    },
  };
  window.navigator.mediaDevices = mediaDevices;
  window.__jennyTestMediaDevices = mediaDevices;
  class MockMediaRecorder {
    static isTypeSupported(type) {
      return String(type || '').startsWith('audio/webm');
    }

    constructor(stream, options = {}) {
      this.stream = stream;
      this.mimeType = options.mimeType || 'audio/webm;codecs=opus';
      this.state = 'inactive';
      this._listeners = new Map();
    }

    addEventListener(eventName, listener, options = {}) {
      const listeners = this._listeners.get(eventName) || [];
      listeners.push({
        listener,
        once: options?.once === true,
      });
      this._listeners.set(eventName, listeners);
    }

    removeEventListener(eventName, listener) {
      const listeners = this._listeners.get(eventName) || [];
      this._listeners.set(eventName, listeners.filter((entry) => entry.listener !== listener));
    }

    _emit(eventName, payload) {
      const listeners = this._listeners.get(eventName) || [];
      const retained = [];
      for (const entry of listeners) {
        entry.listener(payload);
        if (!entry.once) {
          retained.push(entry);
        }
      }
      this._listeners.set(eventName, retained);
    }

    start() {
      this.state = 'recording';
    }

    stop() {
      if (this.state === 'inactive') {
        return;
      }
      this.state = 'inactive';
      const blob = typeof settings.mediaRecorderBlobFactory === 'function'
        ? settings.mediaRecorderBlobFactory(window, this)
        : new window.Blob([Uint8Array.from([82, 73, 70, 70])], {
            type: this.mimeType || 'audio/webm;codecs=opus',
          });
      window.setTimeout(() => {
        this._emit('dataavailable', { data: blob });
        this._emit('stop');
      }, 0);
    }
  }
  window.MediaRecorder =
    typeof settings.MediaRecorder === 'function' ? settings.MediaRecorder : MockMediaRecorder;
  window.HTMLMediaElement.prototype.play = async function play() {
    Object.defineProperty(this, 'paused', {
      configurable: true,
      value: false,
    });
    Object.defineProperty(this, 'readyState', {
      configurable: true,
      value: 4,
    });
    Object.defineProperty(this, 'videoWidth', {
      configurable: true,
      value: 640,
    });
    Object.defineProperty(this, 'videoHeight', {
      configurable: true,
      value: 360,
    });
    this.dispatchEvent(new window.Event('play'));
  };
  window.HTMLMediaElement.prototype.pause = function pause() {
    Object.defineProperty(this, 'paused', {
      configurable: true,
      value: true,
    });
    this.dispatchEvent(new window.Event('pause'));
  };
  try {
    window.marked = require('marked');
  } catch (_err) {
    window.marked = undefined;
  }
  try {
    const createDOMPurify = require('dompurify');
    window.DOMPurify = createDOMPurify(window);
  } catch (_err) {
    window.DOMPurify = undefined;
  }
  try {
    window.jsyaml = require('js-yaml');
  } catch (_err) {
    window.jsyaml = undefined;
  }
  window.pretextLayout = createPretextLayoutMock();

  window.__jennyTestHooks = {
    captureRendererState(rendererState) {
      window.__rendererState = rendererState;
    },
  };
  if (Number.isFinite(Number(settings.startupOverlayMaxVisibleMs))) {
    window.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = Number(settings.startupOverlayMaxVisibleMs);
  }
  if (Number.isFinite(Number(settings.startupOverlaySlowMs))) {
    window.__JENNY_STARTUP_OVERLAY_SLOW_MS = Number(settings.startupOverlaySlowMs);
  }
  window.jennyShell = createShellStub(settings.shell);
  if (settings.legacyMemoryCapturePreference !== undefined) {
    window.localStorage.setItem(
      'jenny.memory.captureSuggestions',
      String(settings.legacyMemoryCapturePreference)
    );
  }
  if (settings.appearance) {
    window.localStorage.setItem('jenny.appearance.v2', JSON.stringify(settings.appearance));
  }
  if (settings.facePreferences) {
    window.localStorage.setItem('jenny.face.v2', JSON.stringify(settings.facePreferences));
  }
  if (typeof settings.persistedActiveView === 'string' && settings.persistedActiveView) {
    window.localStorage.setItem('jenny.ui.activeView', settings.persistedActiveView);
  }
  if (settings.sidebarHistoryPreferences) {
    window.localStorage.setItem(
      'jenny.sidebarHistory.v1',
      JSON.stringify(settings.sidebarHistoryPreferences)
    );
  }
  if (settings.artifactReviewPreferences) {
    window.localStorage.setItem(
      'jenny.artifactReview.v1',
      JSON.stringify(settings.artifactReviewPreferences)
    );
  }
  if (settings.reasoningPhaseExpansionPreferences) {
    window.localStorage.setItem(
      'jenny.reasoningPhaseExpansionBySession.v1',
      JSON.stringify(settings.reasoningPhaseExpansionPreferences)
    );
  }

  const nativeWindowClose = window.close.bind(window);
  function clearTrackedTimers() {
    for (const timer of rafTimers.values()) {
      window.clearTimeout(timer);
    }
    rafTimers.clear();
    for (const id of timeoutTimers.keys()) {
      nativeClearTimeout(id);
    }
    timeoutTimers.clear();
    for (const id of intervalTimers.keys()) {
      nativeClearTimeout(id);
    }
    intervalTimers.clear();
  }
  function beginWindowClose() {
    if (closed) {
      return;
    }
    allowNewTimers = false;
    closed = true;
    clearTrackedTimers();
  }
  function finalizeWindowClose() {
    if (!closed) {
      beginWindowClose();
    }
    nativeWindowClose();
  }
  function closeWindow() {
    if (closePromise) {
      return closePromise;
    }
    if (closed) {
      return Promise.resolve();
    }
    beginWindowClose();
    closePromise = Promise.resolve(
      typeof window.__disposeRenderer === 'function' ? window.__disposeRenderer() : null
    )
      .catch(() => {})
      .finally(() => {
        finalizeWindowClose();
      });
    return closePromise;
  }

  window.close = closeWindow;
  async function dispose() {
    if (disposePromise) {
      return disposePromise;
    }
    disposePromise = (async () => {
      if (closed) {
        return;
      }
      await new Promise((resolve) => nativeSetTimeout(resolve, UI_TICK_MS));
      await closeWindow();
    })();
    return disposePromise;
  }

  const context = dom.getInternalVMContext();
  async function runRendererScript() {
    const appScriptPath = path.join(root, 'renderer/app.js');
    const rendererScriptContent = fs.readFileSync(appScriptPath, 'utf8');
    // Use the ABSOLUTE on-disk path as the vm script filename so c8/NODE_V8_COVERAGE
    // can reconcile the V8 coverage URL against its source files and attribute the
    // execution. With a repo-relative filename, c8 cannot map the profile back to
    // the file and every harness-loaded renderer script reads 0% despite being
    // exercised here. See docs/process/COVERAGE_BASELINE.md (renderer attribution).
    // Snapshot BEFORE the run: reloads re-enter this function and the counter never
    // resets, so the wait has to be for a signal newer than the one already there.
    const signalsBeforeRun = readySignalCount(window.jennyShell?.__state);
    vm.runInContext(rendererScriptContent, context, { filename: appScriptPath });
    await waitForUi(window);
    await waitForRendererReady(window, window.jennyShell?.__state, {
      afterSignals: signalsBeforeRun,
    });
  }
  for (const scriptName of SCRIPT_ORDER) {
    const scriptPath = path.join(root, scriptName);
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    vm.runInContext(scriptContent, context, { filename: scriptPath });
  }
  // jsdom (runScripts:'outside-only', no resource loading) cannot fetch or run
  // a dynamically injected <script>, so the lazy loader can never bring Monaco
  // or the Mermaid runtime into the harness. Overwrite the real loader (just
  // run from SCRIPT_ORDER) with a stub that resolves false on a microtask, so
  // the renderer falls back to its textarea/source-only paths exactly as it did
  // when these libs were eager-but-absent here — and without the extra async
  // latency that would otherwise delay render-gating setDocument() awaits.
  // Real injection (Monaco on artifact edit, Mermaid mid-stream) is owner GUI smoke.
  window.scriptLoaderUtils = {
    ensureScript() { return Promise.resolve(false); },
    _resetForTests() {},
  };
  // Optional window globals seeded BEFORE the renderer scripts run, for state a
  // test needs the renderer to observe at boot rather than after it. The one
  // case this exists for: because ensureScript() above always resolves false,
  // Monaco is unavailable BY CONSTRUCTION here and the renderer logs a genuine
  // WARN renderer.monaco_fallback into its client-log ring during boot. That is
  // a harness artifact, not a product signal, but it still reaches surfaces that
  // read the ring (Diagnostics Overview groups it as an issue). A test that
  // needs a quiet ring seeds the shared Monaco state as already-reported:
  //   windowGlobals: { __jennyMonacoSharedState: { failed: true, loggedFailure: true } }
  // It is opt-in, not automatic: tests/renderer-artifacts-mermaid-shell.test.js
  // asserts that the fallback DOES log exactly once per window.
  if (settings.windowGlobals && typeof settings.windowGlobals === 'object') {
    for (const [key, value] of Object.entries(settings.windowGlobals)) {
      window[key] = value;
    }
  }
  await runRendererScript();
  return {
    dom,
    window,
    shell: window.jennyShell,
    dispose,
    reloadRendererApp: runRendererScript,
  };
}

module.exports = {
  loadRendererApp,
  waitForUi,
};
