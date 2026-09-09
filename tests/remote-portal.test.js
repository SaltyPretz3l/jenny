'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const contracts = require('../services/remote/remote-contracts');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE_PATH = path.join(ROOT, 'remote', 'relay', 'src', 'portal-bundle.js');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadPortalSource(entry) {
  const built = buildSync({
    absWorkingDir: ROOT,
    entryPoints: [`remote/portal/${entry}`],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    write: false,
  }).outputFiles[0].text;
  const filename = path.join(ROOT, `.tmp-${entry}.cjs`);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded._compile(built, filename);
  return loaded.exports;
}

function portalDom() {
  return new JSDOM(read('remote/portal/index.html'), { url: 'https://relay.test/' });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function generatedExports() {
  const source = fs.readFileSync(BUNDLE_PATH, 'utf8');
  const value = (name) => {
    const match = source.match(new RegExp(`export const ${name} = (.+);`));
    assert.ok(match, `missing generated export ${name}`);
    return JSON.parse(match[1]);
  };
  return {
    source,
    html: value('PORTAL_HTML'),
    scriptHash: value('PORTAL_SCRIPT_SHA256'),
    styleHash: value('PORTAL_STYLE_SHA256'),
  };
}

test('committed remote portal bundle is current', () => {
  const result = spawnSync(process.execPath, ['scripts/build-remote-portal.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /current/);
});

test('generated portal has one inline script/style with matching CSP hashes', () => {
  const { html, scriptHash, styleHash } = generatedExports();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  assert.equal(scripts.length, 1);
  assert.equal(styles.length, 1);
  assert.equal(createHash('sha256').update(scripts[0][1]).digest('base64'), scriptHash);
  assert.equal(createHash('sha256').update(styles[0][1]).digest('base64'), styleHash);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
});

test('portal artifact and sources contain no dynamic markup or code execution sinks', () => {
  const { html } = generatedExports();
  const sourceFiles = fs.readdirSync(path.join(ROOT, 'remote', 'portal'))
    .filter((name) => /\.(?:js|html)$/.test(name));
  const combinedSources = sourceFiles.map((name) => read(`remote/portal/${name}`)).join('\n');
  for (const pattern of [
    /innerHTML/,
    /insertAdjacentHTML/,
    /document\.write/,
    /eval\s*\(/,
    /new\s+Function/,
  ]) {
    assert.doesNotMatch(combinedSources, pattern);
    assert.doesNotMatch(html, pattern);
  }
  assert.doesNotMatch(html, /http:\/\//);
  assert.doesNotMatch(html, /https:\/\//);
});

test('owner runbook installs the pinned relay tool and describes visible handshake metadata', () => {
  const runbook = read('docs/operations/REMOTE_CONTROL.md');
  assert.match(runbook, /npm --prefix remote\/relay ci/);
  assert.match(runbook, /npm --prefix remote\/relay exec wrangler login/);
  assert.match(runbook, /`hs1` and `hs2` envelopes expose pairing or device IDs/);
  assert.match(runbook, /Handshake proof,[\s\S]+application frames are encrypted/);
});

test('browser Buffer shim turns malformed base64url into the canonical validation error', () => {
  const original = globalThis.Buffer;
  try {
    delete globalThis.Buffer;
    const { installContractBufferShim } = loadPortalSource('portal-store.js');
    installContractBufferShim();
    assert.equal(globalThis.Buffer.from('%%%', 'base64url').toString('base64url'), '');
    const result = contracts.validateFrameHeader({
      v: 1,
      route_id: 'route_test_1234',
      connection_id: 'connection_test_1234',
      epoch: 'epoch_test_1234',
      seq: 1,
      ciphertext: '%%%',
    });
    assert.equal(result.reason, 'base64url_invalid');
  } finally {
    globalThis.Buffer = original;
  }
});

test('portal store serializes forget behind an in-flight credential save', async () => {
  let stored = null;
  let releaseEncrypt;
  let encryptStarted = false;
  const database = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const transaction = {};
      const complete = () => queueMicrotask(() => transaction.oncomplete?.());
      transaction.objectStore = () => ({
        put(value) { stored = value; complete(); },
        delete() { stored = null; complete(); },
        get() {
          const request = {};
          queueMicrotask(() => { request.result = stored; request.onsuccess?.(); });
          return request;
        },
      });
      return transaction;
    },
  };
  const indexedDB = {
    open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  const crypto = {
    getRandomValues: (value) => value.fill(7),
    subtle: {
      generateKey: async () => ({ type: 'secret' }),
      encrypt: async () => {
        encryptStarted = true;
        await new Promise((resolve) => { releaseEncrypt = resolve; });
        return new ArrayBuffer(48);
      },
    },
  };
  const { createPortalStore } = loadPortalSource('portal-store.js');
  const store = createPortalStore({ indexedDB, crypto });
  const saving = store.saveCredential({
    routeId: 'route_test_1234',
    deviceId: 'device_test_1234',
    label: 'Phone',
    relayOrigin: 'wss://relay.test',
    secret: new Uint8Array(32),
  });
  while (!encryptStarted) await tick();
  const forgetting = store.forgetThisPhone();
  releaseEncrypt();
  await Promise.all([saving, forgetting]);
  assert.equal(stored, null);
});

test('snapshot pending rows open decisions and free-text questions require valid answers', async () => {
  const dom = portalDom();
  const calls = [];
  let release;
  const pendingResult = new Promise((resolve) => { release = resolve; });
  const connection = {
    sendCommand: (...args) => { calls.push(args); return pendingResult; },
  };
  const { createPortalDecisions } = loadPortalSource('portal-decisions.js');
  const { createPortalChat } = loadPortalSource('portal-chat.js');
  const decisions = createPortalDecisions({ document: dom.window.document, connection });
  const session = {
    id: 'session_test_1234',
    title: 'Shared',
    pending: {
      tool: [{
        stream_id: 'stream_test_1234', approval_id: 'approval_test_1234',
        decision_revision: 1, tool_name: 'read_file', facts: { path: 'bounded' },
      }],
      questions: [],
      plan: [],
    },
  };
  decisions.setProjectedPending([{ session_id: session.id, pending: session.pending }]);
  const chat = createPortalChat({
    document: dom.window.document,
    connection: { sendCommand: async () => ({ ok: true, data: { sessions: [
      { id: session.id, title: 'Refreshed' },
    ] } }) },
    openPending: (sessionId, index) => decisions.openPending(sessionId, index),
  });
  chat.applySnapshot({
    sessions: [{ id: session.id, title: session.title }], transcripts: [],
    pending: [{ session_id: session.id, pending: session.pending, active_turn: null }],
  });
  await chat.refreshSessions();
  assert.equal(dom.window.document.querySelectorAll('.decision-needed').length, 1);
  dom.window.document.querySelector('.decision-needed').click();
  assert.equal(dom.window.document.getElementById('decision-sheet').hidden, false);
  assert.match(dom.window.document.getElementById('decision-title').textContent, /read_file/);
  chat.handleEvent({
    type: 'plan_proposed', session_id: session.id,
    payload: { approval_id: 'approval_plan_1234', plan: { title: 'Plan' } },
  });
  assert.equal(dom.window.document.querySelectorAll('.decision-needed').length, 2);
  chat.handleEvent({ type: 'complete', session_id: session.id, payload: {} });
  assert.equal(dom.window.document.querySelectorAll('.decision-needed').length, 0);

  decisions.handleEvent({
    v: 1,
    kind: 'event',
    event_seq: 4,
    type: 'user_questions_requested',
    session_id: session.id,
    payload: {
      question_ref: 'question_test_1234',
      batch_id: 'batch_test_1234',
      questions: [
        { id: 'free', prompt: 'Why?', options: [], multi_select: false, allow_other: false },
        {
          id: 'choice', prompt: 'Pick one', multi_select: false, allow_other: true,
          options: [{ id: 'yes', label: 'Yes' }],
        },
      ],
    },
  });
  const submit = dom.window.document.querySelector('[data-action="answer"]');
  const free = dom.window.document.querySelector('[data-free-text]');
  const other = dom.window.document.querySelector('[data-other]');
  assert.equal(free.maxLength, 500);
  assert.equal(submit.disabled, true);
  free.value = 'Because it is safe.';
  free.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(submit.disabled, true);
  other.value = 'A different choice';
  other.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(submit.disabled, false);
  submit.click();
  assert.equal(submit.disabled, true);
  assert.equal(calls[0][2].answers[0].value, 'Because it is safe.');
  assert.equal(calls[0][2].answers[1].other, 'A different choice');
  release({ ok: true });
  await tick();
});

test('snapshot recovery honors per-session truncation without a replay flag', async () => {
  const calls = [];
  const snapshots = [];
  const { createPortalReconciler } = loadPortalSource('portal-reconcile.js');
  const reconciler = createPortalReconciler({
    contracts,
    validId: (value) => typeof value === 'string' && value.length >= 8,
    rawCommand: async (operation, sessionId) => {
      calls.push([operation, sessionId]);
      return { ok: true, data: { messages: [{ role: 'assistant', content: `page:${sessionId}` }] } };
    },
    onEvent() {},
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    closeCurrent: () => assert.fail('recovery must not close'),
  });
  reconciler.beginReady(5, false);
  reconciler.handleEvent({
    v: 1, kind: 'event', event_seq: 5, type: 'session_shared',
    payload: { event_seq_head: 5, sessions: [
      { session_id: 'session_null_1234', transcript: null },
      {
        session_id: 'session_short_1234', transcript_truncated: true,
        transcript: { messages: [{ role: 'assistant', content: 'partial' }] },
      },
    ] },
  });
  while (!snapshots.length) await tick();
  assert.deepEqual(calls, [
    ['transcript.page', 'session_null_1234'],
    ['transcript.page', 'session_short_1234'],
  ]);
  assert.equal(snapshots[0].transcripts.length, 2);
  assert.equal(reconciler.getLastEventSeq(), 5);
});

test('snapshot active turn reuses the recovered assistant row for its next delta', async () => {
  const dom = portalDom();
  const sessionId = 'session_test_1234';
  const { createPortalChat } = loadPortalSource('portal-chat.js');
  const chat = createPortalChat({
    document: dom.window.document,
    connection: { sendCommand: async () => ({ ok: true, data: { messages: [] } }) },
  });
  chat.setSessions([{ id: sessionId, title: 'Open' }]);
  dom.window.document.querySelector('.session-button').click();
  await tick();
  chat.applySnapshot({
    sessions: [{ id: sessionId, title: 'Open' }],
    transcripts: [{ session_id: sessionId, page: {
      messages: [{ id: 'message_test_1234', role: 'assistant', content: 'partial' }],
    } }],
    pending: [{
      session_id: sessionId, pending: { tool: [], questions: [], plan: [] },
      active_turn: { stream_id: 'stream_test_1234', turn_id: 'turn_test_1234', status: 'running' },
    }],
  });
  chat.handleEvent({
    type: 'delta', session_id: sessionId, stream_id: 'stream_test_1234', payload: { text: ' tail' },
  });
  const rows = dom.window.document.querySelectorAll('.message.assistant');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /partial tail/);
});

test('sharing events refresh lists and unsharing an open conversation returns to the list', async () => {
  const dom = portalDom();
  let listCalls = 0;
  const connection = {
    async sendCommand(operation) {
      if (operation === 'session.list') {
        listCalls += 1;
        return { ok: true, data: { sessions: [] } };
      }
      return { ok: true, data: { messages: [] } };
    },
  };
  const { createPortalChat } = loadPortalSource('portal-chat.js');
  const chat = createPortalChat({ document: dom.window.document, connection });
  chat.setSessions([{ id: 'session_test_1234', title: 'Open' }]);
  dom.window.document.querySelector('.session-button').click();
  await tick();
  chat.handleEvent({ type: 'session_shared', session_id: 'session_other_1234', payload: {} });
  await tick();
  chat.setSessions([{ id: 'session_test_1234', title: 'Open' }]);
  chat.handleEvent({ type: 'session_unshared', session_id: 'session_test_1234', payload: {} });
  await tick();
  assert.equal(listCalls, 2);
  assert.equal(dom.window.document.getElementById('conversations-view').hidden, false);
  assert.equal(dom.window.document.getElementById('conversation-view').hidden, true);
});

test('send receipts preserve edited drafts, report failures, and never repaint another session', async () => {
  const dom = portalDom();
  const sends = [];
  const toasts = [];
  const connection = {
    async sendCommand(operation, sessionId) {
      if (operation === 'transcript.page') return { ok: true, data: { messages: [] } };
      return new Promise((resolve) => sends.push({ sessionId, resolve }));
    },
  };
  const { createPortalChat } = loadPortalSource('portal-chat.js');
  const chat = createPortalChat({
    document: dom.window.document, connection, toast: (message) => toasts.push(message),
  });
  chat.setSessions([{ id: 'session_test_1234', title: 'First' }]);
  dom.window.document.querySelector('.session-button').click();
  await tick();
  const composer = dom.window.document.getElementById('composer');
  composer.value = 'original';
  composer.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.getElementById('send-button').click();
  await tick();
  composer.value = 'edited';
  composer.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  sends[0].resolve({ ok: true, request_id: 'request_test_1234' });
  await tick();
  assert.equal(composer.value, 'edited');
  assert.match(dom.window.document.getElementById('transcript').textContent, /original/);

  dom.window.document.getElementById('send-button').click();
  await tick();
  chat.setSessions([
    { id: 'session_test_1234', title: 'First' },
    { id: 'session_other_1234', title: 'Second' },
  ]);
  dom.window.document.querySelectorAll('.session-button')[1].click();
  await tick();
  sends[1].resolve({ ok: true, request_id: 'request_other_1234' });
  await tick();
  assert.doesNotMatch(dom.window.document.getElementById('transcript').textContent, /edited/);

  composer.value = 'failure draft';
  composer.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.getElementById('send-button').click();
  await tick();
  sends[2].resolve({ ok: false, error: { reason: 'not_reachable' } });
  await tick();
  assert.equal(composer.value, 'failure draft');
  assert.deepEqual(toasts, ['not_reachable']);
});

test('stream updates follow only a reader already within 48 pixels of latest', async () => {
  const dom = portalDom();
  const { createPortalChat } = loadPortalSource('portal-chat.js');
  const chat = createPortalChat({
    document: dom.window.document,
    connection: { sendCommand: async () => ({ ok: true, data: { messages: [] } }) },
  });
  chat.setSessions([{ id: 'session_test_1234', title: 'Open' }]);
  dom.window.document.querySelector('.session-button').click();
  await tick();
  const transcript = dom.window.document.getElementById('transcript');
  const jump = dom.window.document.getElementById('jump-button');
  Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 1_000 });
  Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 200 });
  transcript.scrollTop = 100;
  chat.handleEvent({
    type: 'delta', session_id: 'session_test_1234', stream_id: 'stream_test_1234', payload: { text: 'x' },
  });
  assert.equal(transcript.scrollTop, 100);
  assert.equal(jump.hidden, false);
  jump.click();
  assert.equal(transcript.scrollTop, 1_000);
  assert.equal(jump.hidden, true);
  transcript.scrollTop = 760;
  chat.handleEvent({
    type: 'delta', session_id: 'session_test_1234', stream_id: 'stream_test_1234', payload: { text: 'y' },
  });
  assert.equal(transcript.scrollTop, 1_000);
});
