const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attachMainWindowNavigationGuards,
  isHttpUrl,
  isSameDocumentNavigation,
} = require('../services/main-window-navigation-guard');

const APP_URL = 'file:///C:/Projects/jenny/index.html';

function createFakeWebContents(currentUrl = APP_URL) {
  const listeners = new Map();
  return {
    _windowOpenHandler: null,
    on(eventName, listener) {
      if (!listeners.has(eventName)) listeners.set(eventName, []);
      listeners.get(eventName).push(listener);
      return this;
    },
    getURL() {
      return currentUrl;
    },
    setWindowOpenHandler(handler) {
      this._windowOpenHandler = handler;
    },
    emit(eventName, ...args) {
      (listeners.get(eventName) || []).forEach((listener) => listener(...args));
    },
    listenerCount(eventName) {
      return (listeners.get(eventName) || []).length;
    },
  };
}

function createFakeWindow(webContents) {
  return { isDestroyed: () => false, webContents };
}

function createNavEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

function createCaptureShell() {
  const opened = [];
  return {
    opened,
    openExternal(url) {
      opened.push(url);
      return Promise.resolve();
    },
  };
}

test('isHttpUrl / isSameDocumentNavigation classify targets correctly', () => {
  assert.equal(isHttpUrl('https://example.com'), true);
  assert.equal(isHttpUrl('HTTP://example.com'), true);
  assert.equal(isHttpUrl('file:///C:/x/index.html'), false);
  assert.equal(isHttpUrl('mailto:a@b.com'), false);

  // Same document: exact reload, hash routing, query-only change.
  assert.equal(isSameDocumentNavigation(APP_URL, APP_URL), true);
  assert.equal(isSameDocumentNavigation('file:///C:/Projects/jenny/index.html#x', APP_URL), true);
  assert.equal(isSameDocumentNavigation('file:///C:/Projects/jenny/index.html?v=1', APP_URL), true);
  assert.equal(isSameDocumentNavigation('', APP_URL), true);

  // External schemes leave.
  assert.equal(isSameDocumentNavigation('https://example.com', APP_URL), false);

  // Different local files must be blocked — they would replace the frameless
  // app window with a foreign document, stranding the user with no back button.
  assert.equal(
    isSameDocumentNavigation('file:///C:/Projects/jenny/report.html', APP_URL),
    false,
    'relative link to a different local file must not be treated as same-document'
  );
  assert.equal(
      isSameDocumentNavigation('file:///C:/Users/example/secret.txt', APP_URL),
    false,
    'arbitrary local file must be blocked'
  );
  assert.equal(
    isSameDocumentNavigation('file:///C:/Projects/jenny/docs/notes.html', APP_URL),
    false,
    'file in a subdirectory of the app root must be blocked'
  );
});

test('external http(s) link click is blocked and handed to the OS browser', () => {
  const webContents = createFakeWebContents();
  const shell = createCaptureShell();
  const logs = [];
  const attached = attachMainWindowNavigationGuards({
    windowRef: createFakeWindow(webContents),
    shell,
    log: (level, event, details) => logs.push({ level, event, details }),
  });
  assert.equal(attached, true);

  const event = createNavEvent();
  webContents.emit('will-navigate', event, 'https://example.com/page?token=secret');

  assert.equal(event.prevented, true, 'navigation away from the app must be prevented');
  assert.deepEqual(shell.opened, ['https://example.com/page?token=secret']);
  const blocked = logs.find((entry) => entry.event === 'window.navigation_blocked');
  assert.ok(blocked, 'a redacted diagnostic should be emitted');
  assert.equal(blocked.details.scheme, 'https');
  assert.equal(blocked.details.external, true);
  // Redaction: the full URL (with its token) must not be logged.
  assert.equal(JSON.stringify(blocked.details).includes('secret'), false);
});

test('will-redirect to an external origin is also blocked', () => {
  const webContents = createFakeWebContents();
  const shell = createCaptureShell();
  const attached = attachMainWindowNavigationGuards({
    windowRef: createFakeWindow(webContents),
    shell,
  });
  assert.equal(attached, true);

  const event = createNavEvent();
  webContents.emit('will-redirect', event, 'http://malicious.example/landing');
  assert.equal(event.prevented, true);
  assert.deepEqual(shell.opened, ['http://malicious.example/landing']);
});

test('same-document reload is allowed (not prevented, not opened externally)', () => {
  const webContents = createFakeWebContents();
  const shell = createCaptureShell();
  attachMainWindowNavigationGuards({ windowRef: createFakeWindow(webContents), shell });

  const event = createNavEvent();
  webContents.emit('will-navigate', event, APP_URL);
  assert.equal(event.prevented, false, 'reloading our own document must pass through');
  assert.deepEqual(shell.opened, []);
});

test('window.open is denied; http(s) opens externally, other schemes just denied', () => {
  const webContents = createFakeWebContents();
  const shell = createCaptureShell();
  attachMainWindowNavigationGuards({ windowRef: createFakeWindow(webContents), shell });

  assert.equal(typeof webContents._windowOpenHandler, 'function');

  const httpResult = webContents._windowOpenHandler({ url: 'https://example.com' });
  assert.deepEqual(httpResult, { action: 'deny' });
  assert.deepEqual(shell.opened, ['https://example.com']);

  const otherResult = webContents._windowOpenHandler({ url: 'about:blank' });
  assert.deepEqual(otherResult, { action: 'deny' });
  // about:blank is not http(s); nothing new handed to the OS browser.
  assert.deepEqual(shell.opened, ['https://example.com']);
});

test('will-navigate to a different local file is blocked and not opened externally', () => {
  const webContents = createFakeWebContents();
  const shell = createCaptureShell();
  const logs = [];
  attachMainWindowNavigationGuards({
    windowRef: createFakeWindow(webContents),
    shell,
    log: (level, event, details) => logs.push({ level, event, details }),
  });

  // A relative markdown link like [report](report.html) resolves against
  // file:///…/index.html and fires will-navigate with a different file path.
  const event = createNavEvent();
  webContents.emit('will-navigate', event, 'file:///C:/Projects/jenny/report.html');

  assert.equal(event.prevented, true, 'navigation to a different local file must be prevented');
  // Not http(s) — must NOT be handed to the OS browser.
  assert.deepEqual(shell.opened, [], 'different-file navigation must not open in OS browser');
  const blocked = logs.find((entry) => entry.event === 'window.navigation_blocked');
  assert.ok(blocked, 'a diagnostic must be emitted');
  assert.equal(blocked.details.scheme, 'file');
  assert.equal(blocked.details.external, false, 'local-file navigation is not "external"');
});

test('hash-only and query-only same-document navigations are still allowed', () => {
  const webContents = createFakeWebContents();
  const shell = createCaptureShell();
  attachMainWindowNavigationGuards({ windowRef: createFakeWindow(webContents), shell });

  for (const url of [
    APP_URL,
    'file:///C:/Projects/jenny/index.html#settings',
    'file:///C:/Projects/jenny/index.html?v=2',
  ]) {
    const event = createNavEvent();
    webContents.emit('will-navigate', event, url);
    assert.equal(event.prevented, false, `in-document navigation must not be blocked: ${url}`);
  }
  assert.deepEqual(shell.opened, []);
});

test('guard fails closed (returns false, no throw) on malformed window refs', () => {
  const shell = createCaptureShell();
  assert.equal(attachMainWindowNavigationGuards({ windowRef: null, shell }), false);
  assert.equal(
    attachMainWindowNavigationGuards({ windowRef: { isDestroyed: () => true, webContents: {} }, shell }),
    false
  );
  assert.equal(
    attachMainWindowNavigationGuards({ windowRef: { isDestroyed: () => false, webContents: null }, shell }),
    false
  );
});

test('missing shell does not break guard wiring', () => {
  const webContents = createFakeWebContents();
  const attached = attachMainWindowNavigationGuards({ windowRef: createFakeWindow(webContents) });
  assert.equal(attached, true);
  const event = createNavEvent();
  // Still prevents navigation away even when it cannot open externally.
  assert.doesNotThrow(() => webContents.emit('will-navigate', event, 'https://example.com'));
  assert.equal(event.prevented, true);
});
