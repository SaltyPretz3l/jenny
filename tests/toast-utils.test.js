const test = require('node:test');
const assert = require('node:assert/strict');

const { createToastStore } = require('../renderer/shared/toast-utils');

function createTimerHarness() {
  let now = 0;
  let nextId = 1;
  const timers = [];

  function setTimeoutMock(fn, delay) {
    const id = nextId++;
    timers.push({
      id,
      fn,
      dueAt: now + Math.max(Number(delay) || 0, 0),
      active: true,
    });
    return id;
  }

  function clearTimeoutMock(id) {
    const timer = timers.find((entry) => entry.id === id);
    if (timer) {
      timer.active = false;
    }
  }

  function advance(ms) {
    now += Math.max(Number(ms) || 0, 0);
    let executed = true;
    while (executed) {
      executed = false;
      const due = timers
        .filter((entry) => entry.active && entry.dueAt <= now)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id);
      if (!due.length) {
        continue;
      }
      executed = true;
      const timer = due[0];
      timer.active = false;
      timer.fn();
    }
  }

  return {
    advance,
    clearTimeoutMock,
    now: () => now,
    setTimeoutMock,
  };
}

test('toast store auto-dismisses info and success toasts using tone defaults', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  const infoId = store.enqueue({
    title: 'Composer',
    message: 'Draft restored.',
    tone: 'info',
  });
  const successId = store.enqueue({
    title: 'Attachments',
    message: 'Added 2 attachments.',
    tone: 'success',
  });

  assert.deepEqual(
    store.getSnapshot().map((toast) => toast.id),
    [successId, infoId]
  );

  timerHarness.advance(4000);
  assert.deepEqual(
    store.getSnapshot().map((toast) => toast.id),
    [infoId]
  );

  timerHarness.advance(1000);
  assert.equal(store.getSnapshot().length, 0);
});

test('toast store expires warnings on the tone default and keeps danger sticky', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  const warningId = store.enqueue({
    message: '1 attachment skipped because the queue is full.',
    tone: 'warning',
  });
  const dangerId = store.enqueue({
    message: 'Streaming failed.',
    tone: 'danger',
  });

  timerHarness.advance(7999);
  assert.deepEqual(
    store.getSnapshot().map((toast) => toast.id),
    [dangerId, warningId],
    'warning is still on screen one tick before its 8s default'
  );

  timerHarness.advance(2);
  assert.deepEqual(
    store.getSnapshot().map((toast) => toast.id),
    [dangerId],
    'warning expired; danger reports a failed action and stays until acknowledged'
  );

  timerHarness.advance(60000);
  assert.deepEqual(store.getSnapshot().map((toast) => toast.id), [dangerId]);
});

test('toast store supports manual dismiss', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  const toastId = store.enqueue({
    message: 'Composer error.',
    tone: 'danger',
  });

  store.dismiss(toastId);
  assert.equal(store.getSnapshot().length, 0);
});

test('toast store replaces deduped toasts and moves the latest to the front', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  const firstId = store.enqueue({
    title: 'Attachments Updated',
    message: 'Added 1 attachment.',
    tone: 'success',
    dedupeKey: 'shell.attachments:queue',
  });
  store.enqueue({
    title: 'Attachments Updated',
    message: 'Added 2 attachments.',
    tone: 'success',
    dedupeKey: 'shell.attachments:queue',
  });

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].id, firstId);
  assert.equal(snapshot[0].message, 'Added 2 attachments.');
});

test('toast store shows at most maxVisible and queues the rest', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
    maxVisible: 4,
  });

  for (let index = 1; index <= 5; index += 1) {
    store.enqueue({
      message: `Toast ${index}`,
      tone: 'warning',
    });
  }

  assert.deepEqual(
    store.getSnapshot().map((toast) => toast.message),
    ['Toast 5', 'Toast 4', 'Toast 3', 'Toast 2']
  );
});

test('toast store preserves normalized action metadata', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  store.enqueue({
    message: 'Remember this preference?',
    tone: 'warning',
    actions: [
      { id: 'remember', label: 'Remember', kind: 'primary' },
      { id: 'dismiss', label: 'Not now', kind: 'secondary' },
      { id: '', label: 'Implicit Id' },
    ],
  });

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.length, 1);
  assert.deepEqual(snapshot[0].actions, [
    { id: 'remember', label: 'Remember', kind: 'primary' },
    { id: 'dismiss', label: 'Not now', kind: 'secondary' },
    { id: 'toast_action_3', label: 'Implicit Id', kind: 'secondary' },
  ]);
});

test('toast store holds every countdown while paused', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  store.enqueue({ message: 'Draft restored.', tone: 'info' });

  timerHarness.advance(1000);
  store.pauseAll();
  timerHarness.advance(600000);
  assert.equal(store.getSnapshot().length, 1, 'a hovered toast never expires underneath the pointer');

  store.pauseAll();
  store.resumeAll();
  timerHarness.advance(3999);
  assert.equal(store.getSnapshot().length, 1, 'resume restores the 4000ms that were left, not the full 5000ms');

  timerHarness.advance(2);
  assert.equal(store.getSnapshot().length, 0);
});

test('toast store floors the resumed remainder so a toast never vanishes on pointer-out', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  store.enqueue({ message: 'Endpoint saved.', tone: 'success' });

  timerHarness.advance(3990);
  store.pauseAll();
  store.resumeAll();

  timerHarness.advance(599);
  assert.equal(store.getSnapshot().length, 1, '10ms remained but the 600ms floor applies');

  timerHarness.advance(2);
  assert.equal(store.getSnapshot().length, 0);
});

test('toast store banks the full duration for a toast enqueued while paused', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  store.pauseAll();
  store.enqueue({ message: 'Copied.', tone: 'info' });
  timerHarness.advance(600000);
  assert.equal(store.getSnapshot().length, 1, 'the clock has not started yet');

  store.resumeAll();
  timerHarness.advance(4999);
  assert.equal(store.getSnapshot().length, 1);
  timerHarness.advance(2);
  assert.equal(store.getSnapshot().length, 0);
});

test('toast store counts repeats of an identical deduped message', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  store.enqueue({ message: 'Save failed.', tone: 'danger', dedupeKey: 'ide:save' });
  store.enqueue({ message: 'Save failed.', tone: 'danger', dedupeKey: 'ide:save' });
  store.enqueue({ message: 'Save failed.', tone: 'danger', dedupeKey: 'ide:save' });
  assert.equal(store.getSnapshot()[0].repeatCount, 3);

  store.enqueue({ message: 'Delete failed.', tone: 'danger', dedupeKey: 'ide:save' });
  assert.equal(store.getSnapshot()[0].repeatCount, 1, 'a different message is a new event, not a repeat');
  assert.equal(store.getSnapshot()[0].message, 'Delete failed.');
});

test('toast store queues past maxVisible and promotes on dismiss instead of dropping', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
    maxVisible: 4,
  });

  for (let index = 1; index <= 6; index += 1) {
    store.enqueue({ message: `Failure ${index}`, tone: 'danger' });
  }

  assert.equal(store.getSnapshot().length, 4);
  assert.equal(store.getOverflowCount(), 2);

  store.dismiss(store.getSnapshot()[0].id);
  assert.deepEqual(
    store.getSnapshot().map((toast) => toast.message),
    ['Failure 5', 'Failure 4', 'Failure 3', 'Failure 2'],
    'the queued sticky toast is promoted, never silently discarded'
  );
  assert.equal(store.getOverflowCount(), 1);
});

test('toast store drops the oldest non-sticky first at the retention bound', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
    maxVisible: 20,
  });

  const stickyId = store.enqueue({ message: 'Oldest failure.', tone: 'danger' });
  for (let index = 1; index <= 12; index += 1) {
    store.enqueue({ message: `Note ${index}`, tone: 'info' });
  }

  const messages = store.getSnapshot().map((toast) => toast.message);
  assert.equal(messages.length, 12, 'retention is bounded');
  assert.ok(
    store.getSnapshot().some((toast) => toast.id === stickyId),
    'the sticky failure survives; the oldest info toast is what gets dropped'
  );
  assert.ok(!messages.includes('Note 1'));
});

test('toast store dismissAll clears the queue and its timers', () => {
  const timerHarness = createTimerHarness();
  const store = createToastStore({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  store.enqueue({ message: 'One.', tone: 'info' });
  store.enqueue({ message: 'Two.', tone: 'danger' });
  store.dismissAll();

  assert.equal(store.getSnapshot().length, 0);
  assert.equal(store.getOverflowCount(), 0);
  timerHarness.advance(60000);
  assert.equal(store.getSnapshot().length, 0);
});
