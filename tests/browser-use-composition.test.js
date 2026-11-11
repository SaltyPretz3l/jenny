'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createLazyBrowserUse, installAppHooks } = require('../services/main/browser-use-composition');

function setup() {
  const app = new EventEmitter();
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  const page = {};
  const seen = { hides: 0 };
  const service = { ownsContents: (candidate) => candidate === page, hideAll: () => { seen.hides += 1; } };
  const release = installAppHooks(app, contents, service);
  return { app, contents, page, seen, release };
}

test('a browser page is never handed a client certificate from the OS store', () => {
  const { app, page } = setup();
  let prevented = 0;
  const answers = [];
  app.emit('select-client-certificate', { preventDefault: () => { prevented += 1; } }, page, 'https://x.example', [{ subjectName: 'me' }], (...args) => answers.push(args));
  assert.equal(prevented, 1);
  assert.deepEqual(answers, [[]], 'answered with no certificate');
});

test('any other window keeps its ordinary certificate behaviour', () => {
  const { app } = setup();
  let prevented = 0;
  let answered = 0;
  app.emit('select-client-certificate', { preventDefault: () => { prevented += 1; } }, {}, 'https://x.example', [], () => { answered += 1; });
  assert.deepEqual([prevented, answered], [0, 0]);
});

test('a Stop asking about a browser wait never starts the browser', () => {
  assert.equal(createLazyBrowserUse({}).waitedOnUser('chat-a', 'c1'), false);
});

test('only a full reload of the app parks the pages', () => {
  const { contents, seen } = setup();
  contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.equal(seen.hides, 0);
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(seen.hides, 1);
  contents.emit('did-start-navigation', {}, 'file:///index.html', false, true);
  assert.equal(seen.hides, 2, 'the older positional arguments work too');
  contents.emit('did-start-navigation', {}, 'file:///index.html', true, true);
  assert.equal(seen.hides, 2);
});

test('releasing the hooks removes them, and a destroyed window is left alone', () => {
  const { app, contents, release } = setup();
  release();
  assert.equal(app.listenerCount('select-client-certificate'), 0);
  assert.equal(contents.listenerCount('did-start-navigation'), 0);
  const next = setup();
  next.contents.isDestroyed = () => true;
  next.release();
  assert.equal(next.contents.listenerCount('did-start-navigation'), 1);
});

test('closing a deleted chat does not start the service just to find nothing', async () => {
  const lazy = createLazyBrowserUse({ getMainWindow: () => null });
  assert.equal(lazy.closeSession('chat-a'), null);
  assert.equal(lazy.closeFinished('chat-a'), false, 'nor does a chat reporting back');
  await lazy.dispose();
});
