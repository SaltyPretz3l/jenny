const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attachMainWindowNavigationGuards,
  isHttpUrl,
  isSameDocumentNavigation,
} = require('../services/main-window-navigation-guard');

const APP_URL = 'file:///C:/Projects/jenny/index.html';
// What main loads: index.html with its launch query (services/main/main-window-composition.js).
const LAUNCH_URL = `${APP_URL}?jennyAppearance=%7B%22paletteId%22%3A%22default%22%7D&jennyUiLanguage=en&jennyStartupAnimation=off`;

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

  // Same document: exact reload and hash routing. A query change is a new load of the page
  // with someone else's query (R13-F01), so it is not "same document".
  assert.equal(isSameDocumentNavigation(APP_URL, APP_URL), true);
  assert.equal(isSameDocumentNavigation('file:///C:/Projects/jenny/index.html#x', APP_URL), true);
  assert.equal(isSameDocumentNavigation('file:///C:/Projects/jenny/index.html?v=1', APP_URL), false);
  assert.equal(isSameDocumentNavigation('', APP_URL), true);
  assert.equal(isSameDocumentNavigation(LAUNCH_URL, LAUNCH_URL), true, 'the app reloading its own URL');
  assert.equal(isSameDocumentNavigation(`${LAUNCH_URL}#a`, LAUNCH_URL), true, 'a hash on the launch URL');
  assert.equal(isSameDocumentNavigation(`${LAUNCH_URL}#b`, `${LAUNCH_URL}#a`), true, 'hash to hash');
  assert.equal(isSameDocumentNavigation(APP_URL, LAUNCH_URL), false, 'dropping the launch query reloads');
  assert.equal(isSameDocumentNavigation(`${APP_URL}#a`, LAUNCH_URL), false, 'a hash link that also drops the query');

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

test('hash-only same-document navigations and the app reloading its own URL are still allowed', () => {
  const webContents = createFakeWebContents();
  const shell = createCaptureShell();
  attachMainWindowNavigationGuards({ windowRef: createFakeWindow(webContents), shell });

  for (const url of [
    APP_URL,
    'file:///C:/Projects/jenny/index.html#settings',
  ]) {
    const event = createNavEvent();
    webContents.emit('will-navigate', event, url);
    assert.equal(event.prevented, false, `in-document navigation must not be blocked: ${url}`);
  }
  assert.deepEqual(shell.opened, []);
});

// Team review R13-F01: a link in rendered markdown (`[x](?jennyUiLanguage=qps-ploc)`) resolves to the
// app's own page with another query. Main's own launch and reloads are programmatic (loadFile,
// reloadIgnoringCache: no will-navigate) or go to exactly the current URL (location.reload()), so a
// query-changing navigation that reaches this guard came from the page and is refused.
test('a page-started navigation that changes the query of the app page is blocked', () => {
  const webContents = createFakeWebContents(LAUNCH_URL);
  const shell = createCaptureShell();
  const logs = [];
  attachMainWindowNavigationGuards({
    windowRef: createFakeWindow(webContents),
    shell,
    log: (level, event, details) => logs.push({ level, event, details }),
  });
  const navigate = (url) => { const event = createNavEvent(); webContents.emit('will-navigate', event, url); return event.prevented; };
  for (const href of ['?lang=xx', 'index.html?x', './?x', '?', 'index.html', `${APP_URL}?jennyUiLanguage=ar`, 'index.html#a']) {
    const url = new URL(href, LAUNCH_URL).href;
    assert.equal(navigate(url), true, `blocked: ${href}`);
  }
  assert.deepEqual(shell.opened, [], 'nothing local is handed to the OS browser');
  assert.ok(logs.every((entry) => entry.details.scheme === 'file' && entry.details.external === false));
  assert.equal(JSON.stringify(logs).includes('jennyUiLanguage'), false, 'the query is never logged');

  assert.equal(navigate(LAUNCH_URL), false, 'location.reload() of the launch URL passes');
  assert.equal(navigate(new URL('#a', LAUNCH_URL).href), false, 'a hash-only link passes');
  assert.equal(navigate('https://example.com/x'), true, 'a web link is stopped in the window');
  assert.deepEqual(shell.opened, ['https://example.com/x'], 'and opened in the OS browser as before');
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
