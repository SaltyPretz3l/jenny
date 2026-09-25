'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  assignFreshChatProject,
  FRESH_CHAT_ASSIGN_TIMEOUT_MS,
} = require('../scripts/demo/record-demo-clips');

function idleSnapshot(sessionId = 'session_fresh') {
  return {
    currentSessionId: sessionId,
    messageCount: 0,
    activeTurn: { phase: 'idle', streaming: false },
    pendingStreamIds: [],
    bufferedStreamCount: 0,
  };
}

function fakePage({ snapshot = idleSnapshot(), assignmentResult, openResult } = {}) {
  const calls = [];
  const getSnapshot = typeof snapshot === 'function' ? snapshot : () => snapshot;
  const win = {
    __jennyAgent: {
      getStateSnapshot: getSnapshot,
      openSession: async (sessionId) => {
        calls.push(['open', sessionId]);
        return openResult === undefined ? { ok: true, sessionId } : openResult;
      },
    },
    jennyShell: {
      projects: {
        assignSession: async (payload) => {
          calls.push(['assign', payload]);
          return assignmentResult === undefined
            ? { ok: true, session: { id: payload.session_id, project_id: payload.project_id } }
            : assignmentResult;
        },
      },
    },
  };
  async function inRenderer(callback, argument) {
    const priorWindow = global.window;
    global.window = win;
    try {
      return await callback(argument);
    } finally {
      if (priorWindow === undefined) delete global.window;
      else global.window = priorWindow;
    }
  }
  return {
    calls,
    async waitForFunction(predicate, argument, options) {
      calls.push(['wait', options]);
      if (!await inRenderer(predicate, argument)) throw new Error('wait predicate did not match');
    },
    evaluate: inRenderer,
  };
}

test('fresh demo chat is assigned and reopened before recording continues', async () => {
  const page = fakePage();
  const sessionId = await assignFreshChatProject(page, {
    previousSessionId: 'session_seeded',
    projectId: 'project_ledger',
    timeoutMs: 1234,
  });
  assert.strictEqual(sessionId, 'session_fresh');
  assert.deepStrictEqual(page.calls, [
    ['wait', { timeout: 1234 }],
    ['assign', { session_id: 'session_fresh', project_id: 'project_ledger' }],
    ['open', 'session_fresh'],
  ]);
});

test('fresh demo chat assignment caps its wait at the recorder bound', async () => {
  const page = fakePage();
  await assignFreshChatProject(page, {
    previousSessionId: 'session_seeded',
    projectId: 'project_ledger',
    timeoutMs: Number.MAX_SAFE_INTEGER,
  });
  assert.deepStrictEqual(page.calls[0], ['wait', { timeout: FRESH_CHAT_ASSIGN_TIMEOUT_MS }]);
});

test('fresh demo chat assignment fails closed on stale, refused, or mismatched state', async (t) => {
  await t.test('new chat must be a different empty idle session', async () => {
    const page = fakePage({ snapshot: idleSnapshot('session_seeded') });
    await assert.rejects(
      assignFreshChatProject(page, {
        previousSessionId: 'session_seeded',
        projectId: 'project_ledger',
      }),
      /wait predicate did not match/
    );
    assert.deepStrictEqual(page.calls.slice(1), []);
  });

  await t.test('assignment result must identify the requested session and project', async () => {
    const page = fakePage({
      assignmentResult: { ok: true, session: { id: 'session_other', project_id: 'project_ledger' } },
    });
    await assert.rejects(
      assignFreshChatProject(page, {
        previousSessionId: 'session_seeded',
        projectId: 'project_ledger',
      }),
      /project assignment failed/
    );
    assert.strictEqual(page.calls.some(([operation]) => operation === 'open'), false);
  });

  await t.test('selection must remain on the assigned session while assignment is in flight', async () => {
    const snapshots = [
      idleSnapshot('session_fresh'),
      idleSnapshot('session_fresh'),
      idleSnapshot('session_other'),
    ];
    const page = fakePage({ snapshot: () => snapshots.shift() || idleSnapshot('session_other') });
    await assert.rejects(
      assignFreshChatProject(page, {
        previousSessionId: 'session_seeded',
        projectId: 'project_ledger',
      }),
      /project assignment failed/
    );
    assert.strictEqual(page.calls.some(([operation]) => operation === 'open'), false);
  });

  await t.test('refresh must reopen the assigned session', async () => {
    const page = fakePage({ openResult: { ok: false, sessionId: 'session_fresh' } });
    await assert.rejects(
      assignFreshChatProject(page, {
        previousSessionId: 'session_seeded',
        projectId: 'project_ledger',
      }),
      /chat refresh failed/
    );
  });
});
