const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMessageSequence, createControllerHarness } = require('./helpers/send-controller-harness');

test('audio-only send surfaces a composer notice instead of silently no-oping', async (t) => {
  const harness = createControllerHarness(buildMessageSequence());
  t.after(() => harness.restore());
  harness.state.attachments.queued = [
    {
      id: 'audio_1',
      kind: 'audio',
      displayName: 'clip.wav',
      mimeType: 'audio/wav',
      sizeBytes: 2048,
      durationMs: 1200,
    },
  ];

  const result = await harness.controller.startPromptSend('', {});

  assert.equal(result, null);
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.composerNotices.length, 1);
  assert.match(harness.calls.composerNotices[0].message, /typed message/i);
  assert.equal(harness.calls.composerNotices[0].options.tone, 'warning');
  assert.equal(
    harness.calls.logs.some((entry) => entry.event === 'chat.audio_only_send_blocked'),
    true
  );
  // The queued clip stays in the tray for the user to pair with text.
  assert.equal(harness.state.attachments.queued.length, 1);
});

test('handleRegenerateMessage blocks replay when the source turn has text attachments', async (t) => {
  const harness = createControllerHarness([
    {
      id: 'user_1',
      role: 'user',
      content: 'Summarize this attachment',
      attachments: [
        {
          id: 'attachment_1',
          kind: 'text',
          displayName: 'notes.txt',
          promptName: 'notes.txt',
          extension: '.txt',
          sizeBytes: 128,
          truncated: false,
        },
      ],
    },
    {
      id: 'assistant_1',
      role: 'assistant',
      status: 'complete',
      content: 'Summary ready.',
    },
  ]);
  t.after(() => harness.restore());

  const result = await harness.controller.handleRegenerateMessage('assistant_1');

  assert.equal(result, null);
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.errors.length, 1);
  assert.equal(harness.calls.errors[0].title, 'Regenerate Unavailable');
  assert.match(harness.calls.errors[0].message, /text file attachments/i);
  assert.equal(
    harness.calls.logs.some((entry) => entry.event === 'chat.regenerate_blocked'),
    true
  );
});

test('handleRegenerateMessage replays the source prompt and persisted image attachments without clearing the composer draft', async (t) => {
  const harness = createControllerHarness([
    {
      id: 'user_1',
      role: 'user',
      content: 'Describe this screenshot',
      attachments: [
        {
          id: 'image_1',
          kind: 'image',
          displayName: 'capture.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          width: 320,
          height: 200,
          assetPath: 'C:/attachments/capture.png',
          sourceKind: 'capture',
        },
      ],
    },
    {
      id: 'assistant_1',
      role: 'assistant',
      status: 'complete',
      content: 'It looks like a terminal window.',
    },
  ], {
    chatInputValue: 'keep my draft',
  });
  t.after(() => harness.restore());

  const result = await harness.controller.handleRegenerateMessage('assistant_1');

  assert.equal(result.streamId, 'stream-regen');
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.editAndRegenerate.length, 1);
  assert.equal(harness.calls.editAndRegenerate[0].prompt, 'Describe this screenshot');
  assert.equal(harness.calls.editAndRegenerate[0].editedMessageId, 'user_1');
  assert.equal(harness.calls.editAndRegenerate[0].attachments.length, 1);
  assert.equal(harness.calls.editAndRegenerate[0].attachments[0].assetPath, 'C:/attachments/capture.png');
  assert.deepEqual(harness.state.messagesBySession.get('session-1').map((message) => message.id), ['user_1']);
  assert.deepEqual(harness.calls.clearedProjectionSessions, ['session-1']);
  assert.equal(harness.chatInput.value, 'keep my draft');
  assert.equal(harness.calls.resetQueue, 0);
  assert.equal(
    harness.calls.logs.some((entry) => entry.event === 'chat.regenerate_requested'),
    true
  );
  assert.equal(
    harness.calls.logs.some((entry) => entry.event === 'chat.regenerate_replayed'),
    true
  );
});

test('handleRegenerateMessage surfaces an explicit error when auth is unavailable', async (t) => {
  const harness = createControllerHarness(buildMessageSequence(), {
    authenticated: false,
  });
  t.after(() => harness.restore());

  const result = await harness.controller.handleRegenerateMessage('assistant_1');

  assert.equal(result, null);
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.errors.length, 1);
  assert.equal(harness.calls.errors[0].title, 'Regenerate Unavailable');
  assert.match(harness.calls.errors[0].message, /sign in/i);
  assert.equal(
    harness.calls.logs.some((entry) => entry.event === 'chat.regenerate_blocked'),
    true
  );
});

test('handleRegenerateMessage surfaces an explicit error when the backend is not ready', async (t) => {
  const harness = createControllerHarness(buildMessageSequence(), {
    backendPhase: 'starting',
  });
  t.after(() => harness.restore());

  const result = await harness.controller.handleRegenerateMessage('assistant_1');

  assert.equal(result, null);
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.errors.length, 1);
  assert.equal(harness.calls.errors[0].title, 'Regenerate Unavailable');
  assert.match(harness.calls.errors[0].message, /finish connecting/i);
  assert.equal(
    harness.calls.logs.some((entry) => entry.event === 'chat.regenerate_blocked'),
    true
  );
});

test('handleElaborateMessage surfaces an explicit error when auth is unavailable', async (t) => {
  const harness = createControllerHarness(buildMessageSequence(), {
    authenticated: false,
  });
  t.after(() => harness.restore());

  const result = await harness.controller.handleElaborateMessage('assistant_1');

  assert.equal(result, null);
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.errors.length, 1);
  assert.equal(harness.calls.errors[0].title, 'Elaborate Unavailable');
  assert.match(harness.calls.errors[0].message, /sign in/i);
  assert.equal(
    harness.calls.logs.some((entry) => entry.event === 'chat.elaborate_blocked'),
    true
  );
});

test('handleElaborateMessage surfaces an explicit error when the backend is not ready', async (t) => {
  const harness = createControllerHarness(buildMessageSequence(), {
    backendPhase: 'starting',
  });
  t.after(() => harness.restore());

  const result = await harness.controller.handleElaborateMessage('assistant_1');

  assert.equal(result, null);
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.errors.length, 1);
  assert.equal(harness.calls.errors[0].title, 'Elaborate Unavailable');
  assert.match(harness.calls.errors[0].message, /finish connecting/i);
  assert.equal(
    harness.calls.logs.some((entry) => entry.event === 'chat.elaborate_blocked'),
    true
  );
});

test('startPromptSend abandons a discarded optimistic session when handoff resolves late', async (t) => {
  const harness = createControllerHarness([], {
    chatInputValue: '',
  });
  harness.state.currentSessionId = '';
  harness.state.sessions = [];
  harness.state.messagesBySession = new Map();
  global.window.jennyShell.chat.startStream = async (payload) => {
    harness.calls.startStream.push(payload);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { sessionId: 'session-real', streamId: 'stream-late' };
  };
  t.after(() => harness.restore());

  const sendPromise = harness.controller.startPromptSend('Fresh chat');
  await new Promise((resolve) => setTimeout(resolve, 5));

  const optimisticSessionId = harness.multiStreamController.getPreflightSessionIds()[0];
  assert.ok(optimisticSessionId);
  harness.state.sessions = [];
  harness.state.currentSessionId = '';
  harness.state.messagesBySession.delete(optimisticSessionId);

  const result = await sendPromise;

  assert.equal(result, null);
  assert.deepEqual(harness.calls.cancelStream, ['stream-late']);
  assert.equal(harness.state.currentSessionId, '');
  assert.equal(
    harness.state.ui.chatSendLifecycleBySession.has(optimisticSessionId),
    false
  );
});

test('startPromptSend restores the composer draft when a fresh session is discarded mid-send', async (t) => {
  const harness = createControllerHarness([], {
    chatInputValue: 'keep this draft',
  });
  harness.state.currentSessionId = '';
  harness.state.sessions = [];
  harness.state.messagesBySession = new Map();
  global.window.jennyShell.chat.startStream = async (payload) => {
    harness.calls.startStream.push(payload);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { sessionId: 'session-real', streamId: 'stream-late' };
  };
  t.after(() => harness.restore());

  const sendPromise = harness.controller.startPromptSend('keep this draft');
  await new Promise((resolve) => setTimeout(resolve, 5));

  const optimisticSessionId = harness.multiStreamController.getPreflightSessionIds()[0];
  assert.ok(optimisticSessionId);
  // The brand-new chat is discarded (deleted / navigated away) while the send is
  // still in flight, driving the optimistic-discard early return.
  harness.state.sessions = [];
  harness.state.currentSessionId = '';
  harness.state.messagesBySession.delete(optimisticSessionId);

  const result = await sendPromise;

  assert.equal(result, null);
  assert.deepEqual(harness.calls.cancelStream, ['stream-late']);
  // The typed message is returned to the composer instead of being silently lost.
  assert.equal(harness.chatInput.value, 'keep this draft');
});

test('slow send completion preserves newer navigation and offers Open', async (t) => {
  const harness = createControllerHarness([], { chatInputValue: 'Send in background' });
  harness.state.sessions.push({ id: 'session-2', title: 'Other' });
  harness.state.messagesBySession.set('session-2', []);
  let resolveStart;
  global.window.jennyShell.chat.startStream = (payload) => {
    harness.calls.startStream.push(payload);
    return new Promise((resolve) => { resolveStart = resolve; });
  };
  t.after(() => harness.restore());

  const sendPromise = harness.controller.startPromptSend('Send in background');
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.state.currentSessionId = 'session-2';
  harness.state.navigationIntentOwner.noteUserNavigation();
  resolveStart({ sessionId: 'session-1', streamId: 'stream-background' });
  await sendPromise;

  assert.equal(harness.state.currentSessionId, 'session-2');
  assert.deepEqual(harness.calls.activations, []);
  assert.equal(harness.calls.toasts.length, 1);
  assert.equal(harness.calls.toasts[0].options.actions[0].label, 'Open');
  await harness.calls.toasts[0].options.actions[0].onClick();
  assert.deepEqual(harness.calls.activations, ['session-1']);
});

test('startPromptSend snapshots a queued follow-up and clears the live composer draft', async (t) => {
  const harness = createControllerHarness([], {
    chatInputValue: 'Queue this follow-up',
  });
  harness.multiStreamController.registerStream('session-1', 'stream-active');
  harness.state.attachments.queued = [{
    id: 'image-queued',
    kind: 'image',
    displayName: 'queued.png',
    mimeType: 'image/png',
    sizeBytes: 10,
    assetPath: 'C:/attachments/queued.png',
    sourceKind: 'capture',
  }];
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('Queue this follow-up');

  assert.deepEqual(result, { queued: true, sessionId: 'session-1' });
  assert.equal(harness.calls.startStream.length, 0);
  const queuedSend = harness.state.queuedSendBySession.get('session-1');
  assert.ok(queuedSend);
  assert.equal(queuedSend.prompt, 'Queue this follow-up');
  assert.equal(queuedSend.attachments.length, 1);
  assert.equal(queuedSend.attachments[0].assetPath, 'C:/attachments/queued.png');
  assert.equal(queuedSend.runtimePreferences.conversationMode, 'chat');
  assert.equal(harness.chatInput.value, '');
  assert.deepEqual(harness.state.attachments.queued, []);
  assert.equal(harness.calls.cometUserSendStarted.length, 0);
});

test('a plugin command is refused while busy and is never written to the send queue', async (t) => {
  const harness = createControllerHarness([], { chatInputValue: 'Run summary' });
  harness.multiStreamController.registerStream('session-1', 'stream-active');
  t.after(() => harness.restore());
  const invocation = {
    invocation_schema_version: 2,
    publisher_id: 'jenny-official', plugin_id: 'starter', command_id: 'command-main',
    observed_generation_id: 'gen-7', observed_registry_revision: 7, inputs: [],
  };

  const result = await harness.controller.startPromptSend('Run summary', {
    pluginCommandInvocation: invocation,
  });

  assert.deepEqual(result, { rejected: true, reason: 'session_busy', sessionId: 'session-1' });
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.state.queuedSendBySession.has('session-1'), false);
  assert.match(harness.calls.composerNotices.at(-1).message, /active response/i);
});

test('startPromptSend queues a follow-up sent during the terminal post-work window', async (t) => {
  const harness = createControllerHarness([], { chatInputValue: 'After the answer' });
  // The stream has ended and the lifecycle is already reset to idle — only the
  // terminal post-work (hydration round-trip) is still running. Before the fix
  // this looked fully idle, so the send escaped the queue, started a doomed
  // concurrent turn, and got hoisted below the settled response.
  harness.multiStreamController.beginTerminalPostworkGeneration('session-1');
  assert.equal(harness.multiStreamController.isSessionStreaming('session-1'), false);
  assert.equal(harness.multiStreamController.isSessionInPreflight('session-1'), false);
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('After the answer');

  assert.deepEqual(result, { queued: true, sessionId: 'session-1' });
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.optimisticAppend.length, 0);
  const queuedSend = harness.state.queuedSendBySession.get('session-1');
  assert.ok(queuedSend);
  assert.equal(queuedSend.prompt, 'After the answer');
  assert.equal(harness.chatInput.value, '');
});

test('startPromptSend queues a follow-up sent during preflight instead of dropping it', async (t) => {
  const harness = createControllerHarness([], { chatInputValue: 'During preflight' });
  // Preflight = send accepted, first token not yet streamed. isSessionBusy was
  // already true here, but canQueueForSession was gated on isSessionStreaming
  // only, so the send fell to `return null` and was silently dropped.
  harness.multiStreamController.registerPreflight('session-1', { pending: true, sessionId: 'session-1' });
  assert.equal(harness.multiStreamController.isSessionStreaming('session-1'), false);
  assert.equal(harness.multiStreamController.isSessionInPreflight('session-1'), true);
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('During preflight');

  assert.deepEqual(result, { queued: true, sessionId: 'session-1' });
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.optimisticAppend.length, 0);
  assert.ok(harness.state.queuedSendBySession.get('session-1'));
});

test('dispatchQueuedSendForSession re-checks busy state before auto-dispatch and leaves the queue intact', async (t) => {
  const harness = createControllerHarness([]);
  harness.multiStreamController.registerStream('session-1', 'stream-busy');
  harness.state.queuedSendBySession.set('session-1', {
    sessionId: 'session-1',
    prompt: 'Run later',
    attachments: [],
    runtimePreferences: {
      preferredModel: '',
      reasoningEffort: 'default',
      conversationMode: 'chat',
      contextPreferences: {
        historyScope: 'session',
        includePersonality: true,
        includeMemory: true,
      },
      planMode: false,
    },
    createdAt: Date.now(),
  });
  t.after(() => harness.restore());

  const result = await harness.controller.dispatchQueuedSendForSession('session-1');

  assert.equal(result, null);
  assert.equal(harness.calls.startStream.length, 0);
  assert.ok(harness.state.queuedSendBySession.has('session-1'));
});

test('startPromptSend stashes queued context synchronously (atomic) and backfills @-mention contents on settle', async (t) => {
  const harness = createControllerHarness([], { chatInputValue: 'Queue with context' });
  harness.multiStreamController.registerStream('session-1', 'stream-active');
  // A still-pending mention read proves the stash is SYNCHRONOUS: the stream-terminal
  // handler dispatches queued sends on settle, so an await before it would strand this send.
  let resolveMentions;
  const acceptedPaths = [];
  global.window.rendererIdeMentionAutocomplete = {
    collectMentionPaths: () => ['src/util.js'],
    collectMentionContents: () => new Promise((r) => { resolveMentions = r; }),
  };
  global.window.rendererIdeActiveFileContext = {
    readActiveFileContextForTurn: () => ({ path: 'renderer/foo.js', slice: 'foo' }),
    markTurnAccepted: (path) => acceptedPaths.push(path),
  };
  t.after(() => harness.restore());

  const sendPromise = harness.controller.startPromptSend('Queue with context');
  const early = harness.state.queuedSendBySession.get('session-1');
  assert.ok(early, 'stashed synchronously, before the mention read settles');
  assert.deepEqual(early.meta.activeFileContextSnapshot, { path: 'renderer/foo.js', slice: 'foo' });
  assert.deepEqual(early.meta.mentionContentsSnapshot, []);
  assert.equal(harness.chatInput.value, '');
  assert.deepEqual(await sendPromise, { queued: true, sessionId: 'session-1' });
  assert.deepEqual(acceptedPaths, ['renderer/foo.js'], 'queue snapshot consumes the one-send opt-in');
  resolveMentions([{ path: 'src/util.js', content: 'ok' }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(harness.state.queuedSendBySession.get('session-1').meta.mentionContentsSnapshot, [{ path: 'src/util.js', content: 'ok' }]);
});

test('dispatchQueuedSendForSession replays the queued mention + active-file snapshot instead of re-reading live', async (t) => {
  const harness = createControllerHarness([]);
  harness.state.queuedSendBySession.set('session-1', {
    sessionId: 'session-1',
    prompt: 'Replay me',
    attachments: [],
    runtimePreferences: {
      preferredModel: '',
      reasoningEffort: 'default',
      conversationMode: 'chat',
      contextPreferences: { historyScope: 'session', includePersonality: true, includeMemory: true },
      planMode: false,
    },
    createdAt: Date.now(),
    meta: {
      mentionContentsSnapshot: [{ path: 'QUEUED.js', content: 'queued body' }],
      activeFileContextSnapshot: { path: 'QUEUED-file.js', slice: 'queued slice' },
    },
  });
  // Live readers return DIFFERENT values; the queue-time snapshot must win.
  global.window.rendererIdeMentionAutocomplete = {
    collectMentionContents: async () => [{ path: 'LIVE-WRONG.js', content: 'live body' }],
  };
  global.window.rendererIdeActiveFileContext = {
    readActiveFileContextForTurn: () => ({ path: 'LIVE-WRONG-file.js', slice: 'live slice' }),
  };
  t.after(() => harness.restore());

  const result = await harness.controller.dispatchQueuedSendForSession('session-1');

  assert.equal(result?.streamId, 'stream-regen');
  assert.equal(harness.calls.startStream.length, 1);
  const payload = harness.calls.startStream[0];
  assert.deepEqual(payload.mentionContents, [{ path: 'QUEUED.js', content: 'queued body' }]);
  assert.deepEqual(payload.activeFileContext, { path: 'QUEUED-file.js', slice: 'queued slice' });
});

test('queued active-file snapshot is kept when its @-mention FAILS to resolve (deduped vs resolved, not requested)', async (t) => {
  const harness = createControllerHarness([], { chatInputValue: '@renderer/foo.js explain' });
  harness.multiStreamController.registerStream('session-1', 'stream-active');
  // The user @-mentions the file they are focused on, but the read FAILS
  // (collectMentionContents skips failed reads). The live send path still sends
  // the active-file slice as a fallback; the queued path must match.
  global.window.rendererIdeMentionAutocomplete = {
    collectMentionPaths: () => ['renderer/foo.js'],
    collectMentionContents: async () => [],
  };
  global.window.rendererIdeActiveFileContext = {
    readActiveFileContextForTurn: (queryArgs) => {
      // Mention dedupe is deferred to the backfill, so the reader is queried with
      // an EMPTY mentionedPaths (only attachment dedupe here).
      assert.deepEqual(queryArgs.mentionedPaths, []);
      return { path: 'renderer/foo.js', slice: 'function foo() {}' };
    },
  };
  t.after(() => harness.restore());

  await harness.controller.startPromptSend('@renderer/foo.js explain');
  await new Promise((r) => setTimeout(r, 0));

  const queued = harness.state.queuedSendBySession.get('session-1');
  assert.deepEqual(queued.meta.activeFileContextSnapshot, { path: 'renderer/foo.js', slice: 'function foo() {}' });
  assert.deepEqual(queued.meta.mentionContentsSnapshot, []);
});

test('queued active-file snapshot IS deduped when its @-mention resolves', async (t) => {
  const harness = createControllerHarness([], { chatInputValue: '@renderer/foo.js explain' });
  harness.multiStreamController.registerStream('session-1', 'stream-active');
  global.window.rendererIdeMentionAutocomplete = {
    collectMentionPaths: () => ['renderer/foo.js'],
    collectMentionContents: async () => [{ path: 'renderer/foo.js', content: 'function foo() {}' }],
  };
  global.window.rendererIdeActiveFileContext = {
    readActiveFileContextForTurn: () => ({ path: 'renderer/foo.js', slice: 'function foo() {}' }),
  };
  t.after(() => harness.restore());

  await harness.controller.startPromptSend('@renderer/foo.js explain');
  await new Promise((r) => setTimeout(r, 0));

  const queued = harness.state.queuedSendBySession.get('session-1');
  assert.equal(queued.meta.activeFileContextSnapshot, null, 'active-file dropped: it arrives via the resolved @-mention');
  assert.deepEqual(queued.meta.mentionContentsSnapshot, [{ path: 'renderer/foo.js', content: 'function foo() {}' }]);
});

test('slow queued backfills settle their exact FIFO entries without cross-item clobbering', async (t) => {
  const harness = createControllerHarness([], { chatInputValue: 'A' });
  harness.multiStreamController.registerStream('session-1', 'stream-active');
  global.window.rendererIdeActiveFileContext = { readActiveFileContextForTurn: () => null };
  let resolveA;
  global.window.rendererIdeMentionAutocomplete = {
    collectMentionPaths: () => ['A.js'],
    collectMentionContents: () => new Promise((r) => { resolveA = r; }),
  };
  t.after(() => harness.restore());

  await harness.controller.startPromptSend('A');
  const entryA = harness.state.queuedSendBySession.get('session-1');

  // A second queue for the same busy session overwrites A's slot with a new
  // object whose mention resolves immediately.
  global.window.rendererIdeMentionAutocomplete = {
    collectMentionPaths: () => ['B.js'],
    collectMentionContents: async () => [{ path: 'B.js', content: 'B body' }],
  };
  await harness.controller.startPromptSend('B');
  await new Promise((r) => setTimeout(r, 0));
  const queuedBeforeASettles = harness.state.sendOutboxBySession.get('session-1');
  assert.equal(queuedBeforeASettles.length, 2);
  const entryB = queuedBeforeASettles[1];
  assert.notEqual(entryB.id, entryA.id);
  assert.deepEqual(entryB.meta.mentionContentsSnapshot, [{ path: 'B.js', content: 'B body' }]);

  // A's slow read finally resolves — it must NOT overwrite B (identity mismatch).
  resolveA([{ path: 'A.js', content: 'A body' }]);
  await new Promise((r) => setTimeout(r, 0));
  const settledQueue = harness.state.sendOutboxBySession.get('session-1');
  assert.deepEqual(settledQueue[0].meta.mentionContentsSnapshot, [{ path: 'A.js', content: 'A body' }]);
  assert.deepEqual(settledQueue[1].meta.mentionContentsSnapshot, [{ path: 'B.js', content: 'B body' }]);
});

test('handleStopActiveStream cancels only the current session stream', async (t) => {
  const harness = createControllerHarness([]);
  t.after(() => harness.restore());

  harness.multiStreamController.registerStream('session-1', 'stream-current');
  harness.multiStreamController.registerStream('session-2', 'stream-background');
  harness.state.currentSessionId = 'session-1';

  const result = await harness.controller.handleStopActiveStream();

  assert.deepEqual(result, { streamId: 'stream-current', sessionId: 'session-1' });
  assert.deepEqual(harness.calls.cancelStream, ['stream-current']);
});

test('startPromptSend allows concurrent sends for a different session', async (t) => {
  const harness = createControllerHarness([]);
  t.after(() => harness.restore());

  harness.multiStreamController.registerStream('session-2', 'stream-background');
  harness.state.sessions.push({ id: 'session-2', title: 'Session 2' });
  harness.state.messagesBySession.set('session-2', []);
  harness.state.currentSessionId = 'session-1';

  const result = await harness.controller.startPromptSend('Send here');

  assert.equal(result?.streamId, 'stream-regen');
  assert.equal(harness.calls.startStream.length, 1);
  assert.equal(harness.calls.startStream[0].sessionId, 'session-1');
  assert.equal(typeof harness.calls.startStream[0].clientTiming?.send_started_at_ms, 'number');
  assert.equal(typeof harness.calls.startStream[0].clientTiming?.optimistic_rendered_at_ms, 'number');
  assert.equal(typeof harness.calls.startStream[0].clientTiming?.local_render_latency_ms, 'number');
  assert.equal(harness.calls.cometUserSendStarted.length, 1);
  assert.deepEqual(harness.calls.cometUserSendStarted[0], {
    sessionId: 'session-1',
    prompt: 'Send here',
    attachmentCount: 0,
  });
  assert.equal(harness.state.ui.chatSendLifecycleBySession.get('session-1'), 'streaming');
});

test('startPromptSend keeps the optimistic transcript to a single user entry until stream content arrives', async (t) => {
  const harness = createControllerHarness([], {
    chatInputValue: '',
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('Hello there');

  assert.equal(result?.streamId, 'stream-regen');
  assert.deepEqual(
    harness.state.messagesBySession.get('session-1').map((message) => ({
      role: message.role,
      content: message.content,
    })),
    [{ role: 'user', content: 'Hello there' }]
  );
  assert.equal(harness.state.pendingStreams.size, 0);
  assert.equal(harness.state.ui.chatSendLifecycleBySession.get('session-1'), 'streaming');
});

test('startPromptSend adopts the backend deterministic user id (user_<streamId>) for the optimistic bubble', async (t) => {
  const harness = createControllerHarness([], {
    chatInputValue: '',
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('Hello there');
  assert.equal(result?.streamId, 'stream-regen');

  const messages = harness.state.messagesBySession.get('session-1');
  assert.equal(messages.length, 1, 'still a single optimistic user entry');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'Hello there');
  // The random user_local_* id is rewritten to the backend's deterministic id so
  // terminal hydration reconciles it by id instead of re-appending a duplicate.
  assert.equal(messages[0].id, 'user_stream-regen');
  assert.equal(messages[0].client_message_id, 'user_stream-regen');
  assert.equal(
    String(messages[0].id).startsWith('user_local_'),
    false,
    'no orphan user_local_* id should remain after a successful send'
  );
});

test('startPromptSend annotates the RENAMED user row when a post-adoption step throws', async (t) => {
  // Guards the success-block reassignment `optimisticUserMessageId = persistedUserId`:
  // adoption renames the bubble to user_<streamId>, then a later awaited step
  // (flushBufferedStreamEvents) rejects. The catch-path send-failure annotation must
  // follow the renamed id — if the reassignment were dropped it would target the now
  // defunct user_local_* id and silently no-op, leaving the failed bubble unmarked.
  const harness = createControllerHarness([], {
    chatInputValue: '',
    flushBufferedStreamEvents: async () => {
      throw new Error('buffered flush rejected after adoption');
    },
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('Hello there');
  assert.equal(result, null, 'the send fails (catch path) and returns null');

  const messages = harness.state.messagesBySession.get('session-1');
  assert.equal(messages.length, 1, 'still a single user entry (renamed, not duplicated)');
  assert.equal(messages[0].id, 'user_stream-regen', 'the row was renamed before the throw');
  assert.deepEqual(harness.calls.cancelStream, ['stream-regen'], 'the accepted stream is cancelled exactly once');
  assert.equal(
    messages[0].send_failure?.state,
    'failed',
    'the failure annotation landed on the renamed row, not the orphan user_local_* id'
  );
});

test('startPromptSend does not title a new optimistic session from an explicit hidden prompt', async (t) => {
  const harness = createControllerHarness([], {
    chatInputValue: '',
  });
  harness.state.currentSessionId = '';
  harness.state.sessions = [];
  harness.state.messagesBySession = new Map();
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('Guardrail prompt', {
    visiblePrompt: '',
  });

  assert.equal(result?.streamId, 'stream-regen');
  assert.equal(harness.calls.startStream.length, 1);
  assert.equal(harness.calls.startStream[0].prompt, 'Guardrail prompt');
  assert.equal(harness.calls.startStream[0].visiblePrompt, '');
  const created = harness.state.sessions[0];
  assert.ok(created);
  assert.equal(created.title, 'New Chat');
  assert.equal(created.message_count, 0);
  assert.equal((harness.state.messagesBySession.get(created.id) || []).length, 0);
});

test('startPromptSend keeps a durable failed thread for the first-send preflight failure path', async (t) => {
  const harness = createControllerHarness([], {
    chatInputValue: '',
  });
  harness.state.currentSessionId = '';
  harness.state.sessions = [];
  harness.state.messagesBySession = new Map();
  harness.state.turnClockBySession = new Map();
  global.window.jennyShell.chat.startStream = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw new Error('backend unavailable');
  };
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('Keep this failed prompt');

  assert.equal(result, null);
  // A failed send never reaches finishPostworkWindow; completeFailedSend must
  // stamp the turn clock so an off-screen failure can't keep ticking.
  const failedTurnClock = harness.state.turnClockBySession.get(harness.state.currentSessionId);
  assert.ok(failedTurnClock, 'the failed send seeded a turn-clock entry under the surviving session id');
  assert.equal(Number.isFinite(failedTurnClock.endedAt), true, 'failed send stamps endedAt');
  assert.equal(String(harness.state.currentSessionId || '').startsWith('session_local_'), true);
  const messages = harness.state.messagesBySession.get(harness.state.currentSessionId) || [];
  assert.deepEqual(
    messages.map((message) => ({
      role: message.role,
      content: message.content,
      status: message.status,
      stream_error: message.stream_error || '',
      error_code: message.error_code || '',
    })),
    [
      {
        role: 'user',
        content: 'Keep this failed prompt',
        status: undefined,
        stream_error: '',
        error_code: '',
      },
      {
        role: 'assistant',
        content: '',
        status: 'error',
        stream_error: 'backend unavailable',
        error_code: 'CMP-CHAT-0002',
      },
    ]
  );
  assert.equal(harness.chatInput.value, 'Keep this failed prompt');
  assert.equal(harness.calls.errors.length, 0);
  assert.equal(harness.calls.resetQueue, 0);
  assert.equal(harness.state.ui.chatSendLifecycleBySession.get(harness.state.currentSessionId), 'failed');
  const activeSession = harness.state.sessions.find(
    (session) => String(session?.id || '').trim() === String(harness.state.currentSessionId || '').trim()
  );
  assert.equal(activeSession?.message_count, 2);
  assert.equal(activeSession?.last_message_preview, 'Keep this failed prompt');
});

test('startPromptSend clears queued attachments and preserves a usable preview for image-only first-turn failures', async (t) => {
  const harness = createControllerHarness([], {
    chatInputValue: '',
  });
  harness.state.currentSessionId = '';
  harness.state.sessions = [];
  harness.state.messagesBySession = new Map();
  harness.state.attachments.queued = [
    {
      id: 'image_queued_1',
      kind: 'image',
      displayName: 'capture.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      width: 320,
      height: 200,
      assetPath: 'C:/attachments/capture.png',
      sourceKind: 'capture',
    },
  ];
  global.window.jennyShell.chat.startStream = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw new Error('backend unavailable');
  };
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('');

  assert.equal(result, null);
  assert.deepEqual(harness.state.attachments.queued, [
    {
      id: 'image_queued_1',
      kind: 'image',
      displayName: 'capture.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      width: 320,
      height: 200,
      assetPath: 'C:/attachments/capture.png',
      sourceKind: 'capture',
    },
  ]);
  assert.equal(harness.calls.resetQueue, 0);
  assert.equal(harness.state.ui.chatSendLifecycleBySession.get(harness.state.currentSessionId), 'failed');
  const activeSession = harness.state.sessions.find(
    (session) => String(session?.id || '').trim() === String(harness.state.currentSessionId || '').trim()
  );
  assert.equal(activeSession?.message_count, 2);
  assert.equal(activeSession?.last_message_preview, 'backend unavailable');
});

test('handleRegenerateMessage replays the prompt of the latest failed (error-only) turn (EH-W4)', async (t) => {
  const harness = createControllerHarness([
    { id: 'user_1', role: 'user', content: 'Prompt that failed' },
    {
      id: 'assistant_1',
      role: 'assistant',
      status: 'runtime_error',
      content: '',
      stream_error: 'Provider exploded',
      error_code: 'CMP-AI-0005',
    },
  ]);
  t.after(() => harness.restore());

  const result = await harness.controller.handleRegenerateMessage('assistant_1');

  assert.equal(result.streamId, 'stream-regen');
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.editAndRegenerate.length, 1);
  assert.equal(harness.calls.editAndRegenerate[0].prompt, 'Prompt that failed');
  assert.equal(harness.calls.editAndRegenerate[0].editedMessageId, 'user_1');
  assert.deepEqual(
    harness.state.messagesBySession.get('session-1').map((message) => message.id),
    ['user_1'],
    'the accepted retry removes the superseded error without duplicating the user turn'
  );
  assert.equal(
    harness.calls.logs.some((entry) => entry.event === 'chat.regenerate_requested'),
    true
  );
});

test('handleRegenerateMessage preserves the failed turn when anchored retry admission rejects', async (t) => {
  const originalMessages = [
    { id: 'user_1', role: 'user', content: 'Prompt that failed' },
    { id: 'assistant_1', role: 'assistant', status: 'error', stream_error: 'Provider failed' },
  ];
  const harness = createControllerHarness(originalMessages, {
    editAndRegenerateError: new Error('retry admission rejected'),
  });
  t.after(() => harness.restore());

  const result = await harness.controller.handleRegenerateMessage('assistant_1');

  assert.equal(result, null);
  assert.equal(harness.calls.editAndRegenerate.length, 1);
  assert.deepEqual(harness.state.messagesBySession.get('session-1'), originalMessages);
  assert.deepEqual(harness.calls.clearedProjectionSessions, []);
});

test('handleRegenerateMessage cancels a mismatched anchored retry and preserves the failed turn', async (t) => {
  const originalMessages = [
    { id: 'user_1', role: 'user', content: 'Prompt that failed' },
    { id: 'assistant_1', role: 'assistant', status: 'error', stream_error: 'Provider failed' },
  ];
  const harness = createControllerHarness(originalMessages, {
    editAndRegenerateResult: {
      sessionId: 'session-1',
      streamId: 'stream-mismatch',
      identity: { userMessageId: 'different-user' },
    },
  });
  t.after(() => harness.restore());

  const result = await harness.controller.handleRegenerateMessage('assistant_1');

  assert.equal(result, null);
  assert.equal(harness.calls.cancelStream.length, 1);
  assert.deepEqual(harness.state.messagesBySession.get('session-1'), originalMessages);
  assert.deepEqual(harness.calls.clearedProjectionSessions, []);
});

// ---- Workspace Chat Dock approval-steer (ide_chat_dock, plan §11 #9) --------

const dockSurfaceLiveUtils = require('../renderer/chat/renderer-chat-surface-live-utils');

function withDockSurfaceLive(t) {
  const previous = globalThis.rendererChatSurfaceLiveUtils;
  globalThis.rendererChatSurfaceLiveUtils = dockSurfaceLiveUtils;
  t.after(() => {
    if (previous === undefined) {
      delete globalThis.rendererChatSurfaceLiveUtils;
    } else {
      globalThis.rendererChatSurfaceLiveUtils = previous;
    }
  });
}

function armDockApprovalState(harness, { view }) {
  harness.state.ui.activeView = view;
  harness.state.ui.ideChatDockOpen = true;
  harness.state.features = { featureFlags: { ide_chat_dock: true } };
  // Mid-turn approval gate: the session owns an active stream.
  harness.multiStreamController.registerStream('session-1', 'stream-approval');
}

test('a send typed during a docked approval gate queues one-deep (not dropped)', async (t) => {
  withDockSurfaceLive(t);
  const dockOptions = { hasPendingToolApproval: true };
  const harness = createControllerHarness(buildMessageSequence(), dockOptions);
  t.after(() => harness.restore());
  armDockApprovalState(harness, { view: 'ide' });
  harness.chatInput.value = 'steer note';

  const result = await harness.controller.startPromptSend('steer note', {});

  assert.ok(result, 'the send is stashed, not silently dropped');
  assert.equal(result.queued, true, 'startPromptSend reports the queued outcome');
  const queued = harness.state.queuedSendBySession.get('session-1');
  assert.ok(queued, 'a one-deep queued send exists for the session');
  assert.equal(queued.prompt, 'steer note');
  assert.equal(harness.calls.startStream.length, 0, 'nothing streams while the gate is pending');

  // Allow/Deny resolves + the stream settles: the stash drains through the
  // EXISTING dispatchQueuedSendForSession machinery.
  dockOptions.hasPendingToolApproval = false;
  harness.multiStreamController.clearSessionStream('session-1');
  await harness.controller.dispatchQueuedSendForSession('session-1');
  assert.equal(harness.calls.startStream.length, 1, 'the queued send drains once the gate resolves');
  assert.equal(harness.state.queuedSendBySession.has('session-1'), false, 'the one-deep slot is consumed');
});

test('the same send in MAIN CHAT during an approval gate stays dropped (unchanged lock)', async (t) => {
  withDockSurfaceLive(t);
  const harness = createControllerHarness(buildMessageSequence(), { hasPendingToolApproval: true });
  t.after(() => harness.restore());
  armDockApprovalState(harness, { view: 'chat' });
  harness.chatInput.value = 'should drop';

  const result = await harness.controller.startPromptSend('should drop', {});

  assert.equal(result, null, 'main chat keeps the pre-dock behavior');
  assert.equal(harness.state.queuedSendBySession.has('session-1'), false, 'no queue entry appears');
  assert.equal(harness.calls.startStream.length, 0);
});

test('flag-off keeps the docked approval gate dropping sends (byte-identical)', async (t) => {
  withDockSurfaceLive(t);
  const harness = createControllerHarness(buildMessageSequence(), { hasPendingToolApproval: true });
  t.after(() => harness.restore());
  armDockApprovalState(harness, { view: 'ide' });
  harness.state.features.featureFlags.ide_chat_dock = false;
  harness.chatInput.value = 'still dropped';

  const result = await harness.controller.startPromptSend('still dropped', {});

  assert.equal(result, null);
  assert.equal(harness.state.queuedSendBySession.has('session-1'), false);
});

test('a dock-queued send drains even if the pending-approval flag survives past the stream going idle', async (t) => {
  // Regression for the queue #24 item-7 drive FAIL: Allow resolves and the
  // stream settles (not busy), but state.pendingToolApprovals still carries a
  // stale entry for the session (cleanup lag / a second in-flight approval
  // read). Unlike the sibling test above, this does NOT flip
  // dockOptions.hasPendingToolApproval to false before draining — the queued
  // send must not be silently swallowed back into the composer by a stale
  // approval flag once the turn has structurally ended.
  withDockSurfaceLive(t);
  const dockOptions = { hasPendingToolApproval: true };
  const harness = createControllerHarness(buildMessageSequence(), dockOptions);
  t.after(() => harness.restore());
  armDockApprovalState(harness, { view: 'ide' });
  harness.chatInput.value = 'steer note';

  const result = await harness.controller.startPromptSend('steer note', {});
  assert.equal(result.queued, true, 'still stashes one-deep during the gate');

  // Turn settles: the stream ends (not busy) but the approval flag lingers.
  harness.multiStreamController.clearSessionStream('session-1');
  const dispatchResult = await harness.controller.dispatchQueuedSendForSession('session-1');

  assert.ok(dispatchResult, 'the drain must not bail on a stale pending-approval read once the stream is idle');
  assert.equal(harness.calls.startStream.length, 1, 'the queued send actually dispatches');
  assert.equal(harness.state.queuedSendBySession.has('session-1'), false, 'the one-deep slot is consumed by dispatch');
});

test('main chat still refuses to drain while the session is genuinely busy, dock relaxation notwithstanding', async (t) => {
  // Guardrail: the dock-scoped relaxation only ignores a STALE approval flag
  // once isSessionBusy is false. A genuinely busy session (still streaming)
  // must keep blocking the drain regardless of view or approval state.
  withDockSurfaceLive(t);
  const harness = createControllerHarness(buildMessageSequence(), { hasPendingToolApproval: false });
  t.after(() => harness.restore());
  harness.multiStreamController.registerStream('session-1', 'stream-still-busy');
  harness.state.queuedSendBySession.set('session-1', {
    sessionId: 'session-1',
    prompt: 'Run later',
    attachments: [],
    runtimePreferences: null,
    createdAt: Date.now(),
  });

  const result = await harness.controller.dispatchQueuedSendForSession('session-1');

  assert.equal(result, null, 'busy still blocks the drain');
  assert.equal(harness.calls.startStream.length, 0);
  assert.ok(harness.state.queuedSendBySession.has('session-1'), 'the queue entry is left intact for a later drain');
});
