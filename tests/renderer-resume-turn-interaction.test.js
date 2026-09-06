const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createResumeTurnInteraction,
} = require('../renderer/chat/renderer-resume-turn-interaction');

function buildHarness(overrides = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + '  <div class="resume-turn-affordance" data-resume-turn="assistant-1" data-resume-kind="tool_cap">'
    + '    <button type="button" data-action="resume-turn" data-resume-message-id="assistant-1"'
    + '      data-resume-session-id="session-1">Resume</button>'
    + '  </div>'
    + '</div>'
    + '<textarea id="chatInput"></textarea>'
    + '<input id="otherInput">'
    + '</body></html>');
  const document = dom.window.document;
  const scopeRoot = document.getElementById('chatTimeline');
  const chatInput = document.getElementById('chatInput');
  const sendCalls = [];
  const sendOptions = [];
  const errorCalls = [];
  const logCalls = [];
  let currentSessionId = 'session-1';
  let sendBusy = false;
  let draftAttachments = false;
  let bubbleKeydownCount = 0;
  chatInput.addEventListener('keydown', () => {
    bubbleKeydownCount += 1;
  });
  const controller = createResumeTurnInteraction({
    document,
    scopeRoot,
    chatInput,
    startPromptSend(prompt, sendSettings) {
      sendCalls.push(prompt);
      sendOptions.push(sendSettings);
      return typeof overrides.startPromptSend === 'function'
        ? overrides.startPromptSend(prompt)
        : Promise.resolve();
    },
    getCurrentSessionId: () => currentSessionId,
    isSessionSendBusy: () => sendBusy,
    hasComposerDraftAttachments: () => draftAttachments,
    appendClientLog(level, event, data) {
      logCalls.push({ level, event, data });
    },
    showComposerActionError(error, title) {
      errorCalls.push({ error, title });
    },
  });

  return {
    dom,
    document,
    scopeRoot,
    chatInput,
    button: scopeRoot.querySelector('[data-action="resume-turn"]'),
    controller,
    sendCalls,
    sendOptions,
    errorCalls,
    logCalls,
    get bubbleKeydownCount() { return bubbleKeydownCount; },
    setCurrentSessionId(value) { currentSessionId = value; },
    setSendBusy(value) { sendBusy = value; },
    setDraftAttachments(value) { draftAttachments = value; },
    keydown(target = chatInput, init = {}) {
      const event = new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...init,
      });
      target.dispatchEvent(event);
      return event;
    },
    cleanup() {
      controller.dispose();
      dom.window.close();
    },
  };
}

function createPendingPromise() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('click sends the literal resume prompt exactly once', async (t) => {
  const harness = buildHarness();
  t.after(() => harness.cleanup());

  harness.button.click();
  await flushAsync();

  assert.deepEqual(harness.sendCalls, ['resume']);
  assert.equal(harness.button.disabled, true);
  assert.equal(harness.button.getAttribute('aria-busy'), 'true');
});

test('two rapid clicks send once while the first activation is pending', async (t) => {
  const pending = createPendingPromise();
  const harness = buildHarness({ startPromptSend: () => pending.promise });
  t.after(() => harness.cleanup());
  const clickEvent = () => new harness.dom.window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });

  harness.button.dispatchEvent(clickEvent());
  harness.button.dispatchEvent(clickEvent());

  assert.deepEqual(harness.sendCalls, ['resume']);
  pending.resolve();
  await flushAsync();
});

test('a click plus Enter cannot double-send across the pending await', async (t) => {
  const pending = createPendingPromise();
  const harness = buildHarness({ startPromptSend: () => pending.promise });
  t.after(() => harness.cleanup());

  harness.button.click();
  harness.button.disabled = false;
  harness.button.removeAttribute('aria-busy');
  const event = harness.keydown();

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(harness.sendCalls, ['resume']);
  pending.resolve();
  await flushAsync();
});

test('Enter on an empty composer activates Resume before the bubble listener', async (t) => {
  const harness = buildHarness();
  t.after(() => harness.cleanup());

  const event = harness.keydown();
  await flushAsync();

  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.bubbleKeydownCount, 0);
  assert.deepEqual(harness.sendCalls, ['resume']);
});

test('Enter with composer text proceeds untouched and does not activate', (t) => {
  const harness = buildHarness();
  t.after(() => harness.cleanup());
  harness.chatInput.value = 'keep normal send behavior';

  const event = harness.keydown();

  assert.equal(event.defaultPrevented, false);
  assert.equal(harness.bubbleKeydownCount, 1);
  assert.deepEqual(harness.sendCalls, []);
});

test('modified, repeated, and composing Enter events do not activate', (t) => {
  const harness = buildHarness();
  t.after(() => harness.cleanup());
  const cases = [
    { shiftKey: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { repeat: true },
    { isComposing: true },
    { keyCode: 229 },
  ];

  for (const init of cases) {
    const event = harness.keydown(harness.chatInput, init);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(harness.sendCalls, []);
});

test('keydown on another input is outside the composer-scoped listener', (t) => {
  const harness = buildHarness();
  t.after(() => harness.cleanup());
  const otherInput = harness.document.getElementById('otherInput');

  const event = harness.keydown(otherInput);

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(harness.sendCalls, []);
});

test('a stale session does not send and restores the button and claim', async (t) => {
  const harness = buildHarness();
  t.after(() => harness.cleanup());
  harness.setCurrentSessionId('session-2');

  harness.button.click();

  assert.deepEqual(harness.sendCalls, []);
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.button.hasAttribute('aria-busy'), false);

  harness.setCurrentSessionId('session-1');
  harness.button.click();
  await flushAsync();
  assert.deepEqual(harness.sendCalls, ['resume']);
});

test('a send-busy session does not send and restores the button and claim', async (t) => {
  const harness = buildHarness();
  t.after(() => harness.cleanup());
  harness.setSendBusy(true);

  harness.button.click();

  assert.deepEqual(harness.sendCalls, []);
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.button.hasAttribute('aria-busy'), false);

  harness.setSendBusy(false);
  harness.button.click();
  await flushAsync();
  assert.deepEqual(harness.sendCalls, ['resume']);
});

test('a rejected send restores the button, surfaces the error, and logs', async (t) => {
  const failure = new Error('send failed');
  const harness = buildHarness({ startPromptSend: () => Promise.reject(failure) });
  t.after(() => harness.cleanup());

  harness.button.click();
  await flushAsync();

  assert.deepEqual(harness.errorCalls, [{ error: failure, title: 'Resume Failed' }]);
  assert.deepEqual(harness.logCalls, [{
    level: 'ERROR',
    event: 'chat.resume_failed',
    data: { messageId: 'assistant-1' },
  }]);
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.button.hasAttribute('aria-busy'), false);
});

test('dispose removes both listeners and is idempotent', async (t) => {
  const harness = buildHarness();
  t.after(() => harness.cleanup());

  harness.controller.dispose();
  assert.doesNotThrow(() => harness.controller.dispose());
  harness.button.click();
  const event = harness.keydown();
  await flushAsync();

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(harness.sendCalls, []);
});

test('missing or invalid required dependencies create a no-op controller', () => {
  assert.equal(typeof createResumeTurnInteraction().dispose, 'function');
  assert.equal(typeof createResumeTurnInteraction({}).dispose, 'function');

  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="timeline">'
    + '  <button type="button" data-action="resume-turn" data-resume-message-id="assistant-1"'
    + '    data-resume-session-id="session-1">Resume</button>'
    + '</div>'
    + '<textarea id="input"></textarea>'
    + '</body></html>');
  const document = dom.window.document;
  const scopeRoot = document.getElementById('timeline');
  const chatInput = document.getElementById('input');
  const listenerTargets = [];
  for (const node of [scopeRoot, chatInput]) {
    const original = node.addEventListener.bind(node);
    node.addEventListener = (type, handler, options) => {
      listenerTargets.push({ id: node.id, type });
      return original(type, handler, options);
    };
  }

  const controller = createResumeTurnInteraction({
    document,
    scopeRoot,
    chatInput,
    startPromptSend: null,
    getCurrentSessionId: () => 'session-1',
    isSessionSendBusy: () => false,
  });

  // A no-op controller must attach NOTHING: a half-wired controller that binds
  // click but has no send path would disable the button on every click.
  assert.deepEqual(listenerTargets, []);
  const button = scopeRoot.querySelector('[data-action="resume-turn"]');
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  chatInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute('aria-busy'), false);

  controller.dispose();
  controller.dispose();
  assert.equal(button.disabled, false);
  dom.window.close();
});

// startPromptSend resolves `null` on its no-send gates (backend reconnecting,
// not authenticated, vision gate) and `{rejected:true}` while compacting. The
// claim is never released on success -- the turn is consumed -- so releasing it
// here is the only thing keeping a later re-rendered button alive.
test('a send that resolves without sending releases the claim for a later retry', async (t) => {
  for (const outcome of [null, { rejected: true, reason: 'session_compacting' }]) {
    const harness = buildHarness({ startPromptSend: () => Promise.resolve(outcome) });
    t.after(() => harness.cleanup());

    harness.button.click();
    await flushAsync();
    assert.deepEqual(harness.sendCalls, ['resume']);
    assert.equal(harness.button.disabled, false);
    assert.equal(harness.button.hasAttribute('aria-busy'), false);

    // The same message id must be activatable again once the gate clears.
    harness.button.click();
    await flushAsync();
    assert.deepEqual(harness.sendCalls, ['resume', 'resume']);
  }
});

test('the send carries an explicit session override so a later switch cannot misroute it', async (t) => {
  const harness = buildHarness({ startPromptSend: () => Promise.resolve({ ok: true }) });
  t.after(() => harness.cleanup());

  harness.button.click();
  await flushAsync();

  assert.deepEqual(harness.sendCalls, ['resume']);
  // startPromptSend re-reads state.currentSessionId AFTER its own await, so the
  // button's session must travel with the call, not just gate it.
  assert.deepEqual(harness.sendOptions, [{ sessionIdOverride: 'session-1' }]);
});

// Empty text with a queued attachment is a real, sendable composer draft, so
// Enter there belongs to the user's own send -- not to Resume.
test('Enter with a queued attachment and empty text does not activate Resume', (t) => {
  const harness = buildHarness();
  t.after(() => harness.cleanup());
  harness.setDraftAttachments(true);

  const event = harness.keydown();

  assert.deepEqual(harness.sendCalls, []);
  assert.equal(event.defaultPrevented, false);
  assert.equal(harness.bubbleKeydownCount, 1);
});
