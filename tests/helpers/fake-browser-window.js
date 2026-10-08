'use strict';

// Fake BrowserWindow factory shared by the BrowserSessionService suites:
// records executed page scripts and input events, and serves canned script
// results and screenshot buffers.

function makePngBuffer(width = 2, height = 3) {
  const header = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
  ]);
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32BE(width, 0);
  dimensions.writeUInt32BE(height, 4);
  return Buffer.concat([
    header,
    dimensions,
    Buffer.from([
      0x08, 0x06, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x49, 0x45, 0x4e, 0x44,
      0x00, 0x00, 0x00, 0x00,
    ]),
  ]);
}

function createFakeBrowserWindowFactory({
  screenshotBuffer = makePngBuffer(),
  captureResultFactory = null,
  scriptResults = [],
  scriptHandler = null,
} = {}) {
  const windows = [];
  const factory = (options = {}) => {
    const listeners = new Map();
    const browserSession = {
      permissionRequestHandler: undefined,
      permissionCheckHandler: undefined,
      devicePermissionHandler: undefined,
      webRequest: {
        beforeRequestListener: undefined,
        onBeforeRequest(listener) {
          this.beforeRequestListener = listener || undefined;
        },
      },
      setPermissionRequestHandler(handler) {
        this.permissionRequestHandler = handler || undefined;
      },
      setPermissionCheckHandler(handler) {
        this.permissionCheckHandler = handler || undefined;
      },
      setDevicePermissionHandler(handler) {
        this.devicePermissionHandler = handler || undefined;
      },
    };
    const window = {
      options,
      loadedUrl: '',
      destroyed: false,
      windowOpenHandler: null,
      captureArgs: null,
      executedScripts: [],
      executedScriptArgs: [],
      inputEvents: [],
      insertedText: [],
      browserSession,
      emit(eventName, ...args) {
        const handlers = listeners.get(eventName) || [];
        for (const handler of handlers) {
          handler(...args);
        }
      },
      webContents: {
        session: browserSession,
        on(eventName, handler) {
          if (!listeners.has(eventName)) listeners.set(eventName, []);
          listeners.get(eventName).push(handler);
        },
        removeAllListeners(eventName) {
          if (eventName) listeners.delete(eventName);
          else listeners.clear();
        },
        setWindowOpenHandler(handler) {
          window.windowOpenHandler = handler;
        },
        async loadURL(url) {
          window.loadedUrl = url;
        },
        getURL() {
          return window.loadedUrl;
        },
        async capturePage(...args) {
          window.captureArgs = args;
          if (typeof captureResultFactory === 'function') {
            return captureResultFactory(window);
          }
          return {
            toPNG() {
              return Buffer.from(screenshotBuffer);
            },
          };
        },
        async executeJavaScript(...args) {
          const [script] = args;
          window.executedScripts.push(script);
          window.executedScriptArgs.push(args);
          if (typeof scriptHandler === 'function') {
            return scriptHandler(script, window);
          }
          return scriptResults.shift();
        },
        sendInputEvent(event) {
          window.inputEvents.push(event);
        },
        async insertText(text) {
          window.insertedText.push(text);
        },
      },
      isDestroyed() {
        return this.destroyed;
      },
      destroy() {
        this.destroyed = true;
      },
    };
    windows.push(window);
    return window;
  };
  factory.windows = windows;
  return factory;
}

module.exports = { createFakeBrowserWindowFactory, makePngBuffer };
