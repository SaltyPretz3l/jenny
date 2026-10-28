'use strict';

/* `preview_test` bounded events and surfaced console detail (split from
 * preview-test-tool.test.js so each file stays under the test-size ratchet).
 * The lifecycle, failure-class and validation-gate cases live there. */

const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const {
  callsOf,
  makeContext,
  makeTool,
  makeWorkspace,
  stubService,
} = require('./helpers/preview-test-tool-fixture');
const { holdEventLoopUntilTestsFinish } = require('./helpers/event-loop-hold');

// Service wait timers are unref'd on purpose; Node 22's runner would drain the loop under them.
holdEventLoopUntilTestsFinish(test);

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('preview_test / bounded events', () => {
  test('click and type events are forwarded in order on the same session', async () => {
    const root = makeWorkspace();
    const service = stubService({ clickResult: { status: 'selector_miss' } });
    const result = await makeTool().execute(
      {
        path: 'index.html',
        events: [
          { action: 'click', selector: '#go' },
          { action: 'type', selector: '#name', text: 'jenny', press_enter: true },
        ],
      },
      makeContext(root, service)
    );

    assert.equal(result.isError, false, 'a selector miss is a finding, not a tool failure');
    const openSessionId = callsOf(service, 'open')[0][1].sessionId;
    const clicks = callsOf(service, 'click');
    const types = callsOf(service, 'type');
    assert.equal(clicks.length, 1);
    assert.equal(types.length, 1);
    assert.equal(clicks[0][1], openSessionId);
    assert.equal(types[0][1], openSessionId);
    assert.equal(clicks[0][2].selector, '#go');
    assert.equal(types[0][2].text, 'jenny');
    assert.equal(types[0][2].press_enter, true);
    assert.deepEqual(
      result.metadata.events.map((entry) => entry.status),
      ['selector_miss', 'typed']
    );
    // A text-only provider reads this, not the metadata: a miss must not
    // read as a successful interaction.
    assert.match(result.content, /applied 1 of 2 event\(s\)/);
    assert.match(result.content, /1\. click "#go" → selector_miss/);
    assert.match(result.content, /2\. type "#name" → typed/);
  });

  test('hover, focus and press events are forwarded in order with their arguments', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute(
      {
        path: 'index.html',
        events: [
          { action: 'hover', selector: '#menu' },
          { action: 'focus', selector: '#name' },
          { action: 'press', key: 'Enter', selector: '#name' },
          { action: 'press', key: 'Escape' },
        ],
      },
      makeContext(root, service)
    );

    assert.equal(result.isError, false);
    const sessionId = callsOf(service, 'open')[0][1].sessionId;
    assert.deepEqual(callsOf(service, 'hover').map((c) => c.slice(1)), [[sessionId, { selector: '#menu' }]]);
    assert.deepEqual(callsOf(service, 'focus').map((c) => c.slice(1)), [[sessionId, { selector: '#name' }]]);
    assert.deepEqual(
      callsOf(service, 'press').map((c) => c.slice(1)),
      [[sessionId, { key: 'Enter', selector: '#name' }], [sessionId, { key: 'Escape', selector: '' }]]
    );
    assert.deepEqual(
      result.metadata.events.map((entry) => `${entry.action}:${entry.status}`),
      ['hover:hovered', 'focus:focused', 'press:pressed', 'press:pressed']
    );
    assert.equal(result.metadata.events[2].key, 'Enter');
    assert.match(result.content, /applied 4 of 4 event\(s\)/);
    assert.match(result.content, /press Enter/);
  });

  test('press requires an allowlisted key; other actions still require a selector', async () => {
    const root = makeWorkspace();
    for (const bad of [
      [{ action: 'press' }],
      [{ action: 'press', key: 'F5' }],
      [{ action: 'press', key: 'enter' }],
      [{ action: 'hover' }],
      [{ action: 'focus' }],
      [{ action: 'click' }],
      [{ action: 'click', selector: '#x', key: 'Enter' }],
    ]) {
      const service = stubService();
      const result = await makeTool().execute(
        { path: 'index.html', events: bad },
        makeContext(root, service)
      );
      assert.equal(result.isError, true, `${JSON.stringify(bad)} must be rejected`);
      assert.equal(result.metadata.reason, 'invalid_event');
      assert.equal(callsOf(service, 'open').length, 0);
    }
  });

  test('a literal " " or Spacebar press is sent as Space (gate recheck 2026-10-05)', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute(
      { path: 'index.html', events: [{ action: 'press', key: ' ' }, { action: 'press', key: 'Spacebar' }] },
      makeContext(root, service)
    );
    assert.equal(result.isError, false);
    assert.deepEqual(callsOf(service, 'press').map((c) => c[2].key), ['Space', 'Space']);
    assert.deepEqual(result.metadata.events.map((event) => event.key), ['Space', 'Space']);
  });

  test('every allowlisted press key is accepted without a selector', async () => {
    const root = makeWorkspace();
    const keys = ['Enter', 'Space', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    const service = stubService();
    const result = await makeTool().execute(
      { path: 'index.html', events: keys.map((key) => ({ action: 'press', key })) },
      makeContext(root, service)
    );
    assert.equal(result.isError, false);
    assert.deepEqual(callsOf(service, 'press').map((c) => c[2].key), keys);
  });

  test('more than 10 events fails closed before any window opens', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const events = Array.from({ length: 11 }, () => ({ action: 'click', selector: '#x' }));
    const result = await makeTool().execute(
      { path: 'index.html', events },
      makeContext(root, service)
    );
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'too_many_events');
    assert.equal(callsOf(service, 'open').length, 0);
  });

  test('malformed events fail closed before any window opens', async () => {
    const root = makeWorkspace();
    for (const bad of [
      [{ action: 'eval', selector: '#x' }],
      [{ action: 'click' }],
      ['not-an-object'],
    ]) {
      const service = stubService();
      const result = await makeTool().execute(
        { path: 'index.html', events: bad },
        makeContext(root, service)
      );
      assert.equal(result.isError, true, `${JSON.stringify(bad)} must be rejected`);
      assert.equal(result.metadata.reason, 'invalid_event');
      assert.equal(callsOf(service, 'open').length, 0);
    }
  });
});

describe('preview_test / surfaced console detail', () => {
  test('console error locations use basename and preserve messages without locations', async () => {
    const root = makeWorkspace();
    const service = stubService({
      inspectResult: {
        console_messages: [
          {
            level: 3,
            message: 'Uncaught ReferenceError: lastFrame is not defined',
            line: 241,
            source_id: 'file:///C:/Users/x/Desktop/Test/bench_world.html?preview=1#frame',
          },
          {
            level: 3,
            message: 'Failure with a source only',
            source_id: 'https://example.test/assets/worker.js?cache=1#load',
          },
          { level: 3, message: 'Failure without a location' },
        ],
        page_errors: [],
      },
    });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(
      result.metadata.console_errors[0],
      'Uncaught ReferenceError: lastFrame is not defined (bench_world.html:241)'
    );
    assert.equal(
      result.metadata.console_errors[1],
      'Failure with a source only (worker.js)'
    );
    assert.equal(result.metadata.console_errors[2], 'Failure without a location');
    assert.ok(!JSON.stringify(result).includes('C:/Users'));
  });

  test('page error stacks append the first location line with basename only', async () => {
    const root = makeWorkspace();
    const service = stubService({
      inspectResult: {
        console_messages: [],
        page_errors: [
          {
            message: 'ReferenceError: lastFrame is not defined',
            stack: [
              'ReferenceError: lastFrame is not defined',
              '    at renderFrame (file:///C:/Users/x/Desktop/Test/bench_world.html:241:17)',
              '    at file:///C:/Users/x/Desktop/Test/app.js:12:3',
            ].join('\n'),
          },
          {
            message: 'SyntaxError: unexpected token',
            line: 9,
            source_id: 'file:///C:/Users/x/Desktop/Test/page.js',
          },
        ],
      },
    });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(
      result.metadata.page_errors[0],
      'ReferenceError: lastFrame is not defined (at renderFrame (bench_world.html:241:17))'
    );
    assert.equal(
      result.metadata.page_errors[1],
      'SyntaxError: unexpected token (page.js:9)'
    );
    assert.ok(!JSON.stringify(result).includes('C:/Users'));
  });
});
