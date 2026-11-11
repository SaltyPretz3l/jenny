'use strict';

/**
 * Recording stand-in for the Electron webContents a browser-use view exposes.
 *
 * Every call is appended to a shared call log as { who, name, args }, so a test
 * that also logs its fake reader and gate into the same array can assert the
 * order in which the action layer touched them.
 */

function createCallLog() {
  return [];
}

function logNames(log) {
  return log.map(entry => `${entry.who}.${entry.name}`);
}

function makePngBuffer(width = 8, height = 6) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function createFakeNativeImage(width = 8, height = 6) {
  const png = makePngBuffer(width, height);
  return { toPNG: () => png, resize: () => createFakeNativeImage(width, height) };
}

/**
 * options:
 *   log            shared call log (default: a fresh one, exposed as .log)
 *   loading        initial isLoading() answer
 *   url            initial getURL() answer
 *   canGoBack / canGoForward   navigation history answers
 *   loadURL        async (url) => void; defaults to resolving
 *   capturePage    async (...args) => image; defaults to a tiny PNG image
 *   executeJavaScript  async (script) => value; defaults to true
 *   executeJavaScriptInIsolatedWorld  async (worldId, scripts) => value
 *   sendInputEvent / insertText  optional hooks run after recording
 */
function createFakeWebContents(options = {}) {
  const log = options.log || createCallLog();
  const state = {
    loading: Boolean(options.loading),
    url: options.url || 'https://example.test/',
    canGoBack: Boolean(options.canGoBack),
    canGoForward: Boolean(options.canGoForward),
  };
  const record = (name, args) => log.push({ who: 'wc', name, args });

  const contents = {
    log,
    state,
    inputEvents: [],
    insertedText: [],
    isLoading() {
      record('isLoading', []);
      return state.loading;
    },
    getURL() {
      record('getURL', []);
      return state.url;
    },
    sendInputEvent(event) {
      record('sendInputEvent', [event]);
      contents.inputEvents.push(event);
      return options.sendInputEvent?.(event);
    },
    async insertText(text) {
      record('insertText', [text]);
      contents.insertedText.push(text);
      return options.insertText?.(text);
    },
    async loadURL(url) {
      record('loadURL', [url]);
      if (options.loadURL) return options.loadURL(url);
      state.url = url;
      return undefined;
    },
    reload() {
      record('reload', []);
    },
    navigationHistory: {
      canGoBack() {
        record('canGoBack', []);
        return state.canGoBack;
      },
      canGoForward() {
        record('canGoForward', []);
        return state.canGoForward;
      },
      goBack() {
        record('goBack', []);
      },
      goForward() {
        record('goForward', []);
      },
    },
    async capturePage(...args) {
      record('capturePage', args);
      if (options.capturePage) return options.capturePage(...args);
      return createFakeNativeImage();
    },
    async executeJavaScript(script) {
      record('executeJavaScript', [script]);
      if (options.executeJavaScript) return options.executeJavaScript(script);
      return true;
    },
    async executeJavaScriptInIsolatedWorld(worldId, scripts) {
      record('executeJavaScriptInIsolatedWorld', [worldId, scripts]);
      if (options.executeJavaScriptInIsolatedWorld) {
        return options.executeJavaScriptInIsolatedWorld(worldId, scripts);
      }
      return undefined;
    },
    invalidate() {
      record('invalidate', []);
    },
    beginFrameSubscription(onlyDirty, callback) {
      record('beginFrameSubscription', [onlyDirty, typeof callback]);
    },
    endFrameSubscription() {
      record('endFrameSubscription', []);
    },
  };
  return contents;
}

module.exports = {
  createCallLog,
  createFakeNativeImage,
  createFakeWebContents,
  logNames,
  makePngBuffer,
};
