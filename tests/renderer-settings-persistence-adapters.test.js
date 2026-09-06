'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSettingsAdapter,
  createAppearanceAdapter,
  createZoomAdapter,
  createOfflineAdapter,
} = require('../renderer/shell/renderer-settings-persistence-adapters.js');

const appearanceUtils = require('../renderer/shared/appearance-utils.js');
const chatZoomUtils = require('../renderer/chat/chat-zoom-utils.js');

function createFakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    _map: map,
  };
}

// ── createSettingsAdapter contract ────────────────────────────────────────

test('createSettingsAdapter validates the spec', () => {
  assert.throws(() => createSettingsAdapter(), TypeError);
  assert.throws(() => createSettingsAdapter({}), TypeError);
  assert.throws(() => createSettingsAdapter({ id: '' }), /non-empty string/);
  assert.throws(
    () => createSettingsAdapter({ id: 'x', write: () => {}, getDefault: () => {} }),
    /spec\.read must be a function/
  );
  assert.throws(
    () => createSettingsAdapter({ id: 'x', read: () => {}, getDefault: () => {} }),
    /spec\.write must be a function/
  );
  assert.throws(
    () => createSettingsAdapter({ id: 'x', read: () => {}, write: () => {} }),
    /spec\.getDefault must be a function/
  );
  assert.throws(
    () => createSettingsAdapter({
      id: 'x', read: () => {}, write: () => {}, getDefault: () => {}, normalize: 'nope',
    }),
    /spec\.normalize must be a function/
  );
  assert.throws(
    () => createSettingsAdapter({
      id: 'x', read: () => {}, write: () => {}, getDefault: () => {}, redact: 'nope',
    }),
    /spec\.redact must be a function/
  );
  assert.throws(
    () => createSettingsAdapter({
      id: 'x', read: () => {}, write: () => {}, getDefault: () => {}, apply: 'nope',
    }),
    /spec\.apply must be a function/
  );
  assert.throws(
    () => createSettingsAdapter({
      id: 'x', read: () => {}, write: () => {}, getDefault: () => {}, log: 'nope',
    }),
    /spec\.log must be a function/
  );
});

test('createSettingsAdapter defaults normalize/redact to identity and exposes id', () => {
  const adapter = createSettingsAdapter({
    id: 'plain',
    read: () => ({ a: 1 }),
    write: (value) => value,
    getDefault: () => ({ a: 0 }),
  });
  assert.equal(adapter.id, 'plain');
  assert.deepEqual(adapter.normalize({ a: 2 }), { a: 2 });
  assert.equal(adapter.redact('secret'), 'secret');
  assert.deepEqual(adapter.read(), { a: 1 });
  assert.deepEqual(adapter.getDefault(), { a: 0 });
});

test('write() normalizes the input before persisting', async () => {
  const seenByWrite = [];
  const adapter = createSettingsAdapter({
    id: 'norm',
    read: () => 0,
    normalize: (raw) => Math.round(Number(raw) || 0),
    write: (value) => {
      seenByWrite.push(value);
    },
    getDefault: () => 0,
  });
  const result = await adapter.write(3.7);
  assert.equal(result, 4);
  assert.deepEqual(seenByWrite, [4]);
});

test('write() success: no rollback, no log call', async () => {
  const calls = [];
  const logs = [];
  const adapter = createSettingsAdapter({
    id: 'ok',
    read: () => 'previous',
    write: (value) => value,
    getDefault: () => 'default',
    apply: (value) => calls.push(value),
    log: (message) => logs.push(message),
  });
  const result = await adapter.write('next');
  assert.equal(result, 'next');
  assert.deepEqual(calls, ['next']);
  assert.deepEqual(logs, []);
});

test('write() failure: rolls back via apply(previous), logs, and rethrows', async () => {
  const calls = [];
  const logs = [];
  const failure = new Error('persist boom');
  const adapter = createSettingsAdapter({
    id: 'fails',
    read: () => 'previous-value',
    write: () => Promise.reject(failure),
    getDefault: () => 'default-value',
    apply: (value) => calls.push(value),
    log: (message) => logs.push(message),
  });
  await assert.rejects(() => adapter.write('attempted-value'), /persist boom/);
  assert.deepEqual(calls, ['attempted-value', 'previous-value']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"fails"/);
  assert.match(logs[0], /persist boom/);
});

test('write() failure where rollback apply() also throws: logs both, still rethrows the ORIGINAL error', async () => {
  const logs = [];
  const adapter = createSettingsAdapter({
    id: 'double-fault',
    read: () => 'previous',
    write: () => Promise.reject(new Error('original write boom')),
    getDefault: () => 'default',
    apply: (value) => {
      if (value === 'previous') {
        throw new Error('rollback apply boom');
      }
    },
    log: (message) => logs.push(message),
  });
  await assert.rejects(() => adapter.write('next'), /original write boom/);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /rollback apply failed/);
  assert.match(logs[0], /rollback apply boom/);
  assert.match(logs[1], /write failed/);
  assert.match(logs[1], /original write boom/);
});

test('write() failure in the OPTIMISTIC apply: rolls back, logs, and rejects (never throws synchronously)', async () => {
  const calls = [];
  const logs = [];
  let persisted = false;
  const adapter = createSettingsAdapter({
    id: 'apply-fault',
    read: () => 'previous',
    write: (value) => { persisted = true; return value; },
    getDefault: () => 'default',
    apply: (value) => {
      calls.push(value);
      if (value === 'next') throw new Error('optimistic apply boom');
    },
    log: (message) => logs.push(message),
  });
  const pending = adapter.write('next'); // a synchronous throw here would fail the test
  await assert.rejects(() => pending, /optimistic apply boom/);
  assert.equal(persisted, false, 'domain write never runs after a failed optimistic apply');
  assert.deepEqual(calls, ['next', 'previous']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /optimistic apply failed/);
});

test('write() failure with no read()-able previous value falls back to getDefault() for rollback', async () => {
  const calls = [];
  const adapter = createSettingsAdapter({
    id: 'unreadable',
    read: () => {
      throw new Error('read is broken');
    },
    write: () => Promise.reject(new Error('write boom')),
    getDefault: () => 'safe-default',
    apply: (value) => calls.push(value),
  });
  await assert.rejects(() => adapter.write('x'));
  assert.deepEqual(calls, ['x', 'safe-default']);
});

test('write() reconciles: a returned write value is normalized and re-applied when it differs', async () => {
  const calls = [];
  const adapter = createSettingsAdapter({
    id: 'reconcile',
    read: () => 1,
    normalize: (raw) => Number(raw),
    write: (value) => value + 1000, // server "corrects" the value
    getDefault: () => 0,
    apply: (value) => calls.push(value),
  });
  const result = await adapter.write(5);
  assert.equal(result, 1005);
  assert.deepEqual(calls, [5, 1005]);
});

test('write() does not re-apply when the reconciled value matches what was already applied', async () => {
  const calls = [];
  const adapter = createSettingsAdapter({
    id: 'no-reconcile',
    read: () => 1,
    normalize: (raw) => Number(raw),
    write: (value) => value, // echoes the same value back
    getDefault: () => 0,
    apply: (value) => calls.push(value),
  });
  const result = await adapter.write(5);
  assert.equal(result, 5);
  assert.deepEqual(calls, [5]);
});

// ── UIUX-028(b): per-write generation guard against out-of-order rollback ──
// Rapid successive writes to the same adapter (e.g. a Quick Settings user
// clicking a segmented control twice fast) each capture their OWN
// `previous` snapshot and race independently over the network/IPC. Without
// an ordering guard, an OLDER write's failure arriving AFTER a NEWER write
// has already applied successfully rolls the UI back past the newer,
// already-persisted value -- silently reverting a successful change.

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test('write(): a stale write failing after a newer write already succeeded does not roll back the newer value', async () => {
  let currentValue = 'initial';
  const calls = [];
  const logs = [];
  const deferredByValue = new Map();

  const adapter = createSettingsAdapter({
    id: 'raced',
    read: () => currentValue,
    write: (value) => {
      const deferred = createDeferred();
      deferredByValue.set(value, deferred);
      return deferred.promise;
    },
    getDefault: () => 'default',
    apply: (value) => { currentValue = value; calls.push(value); },
    log: (message) => logs.push(message),
  });

  // Older write starts first -- optimistic apply is synchronous.
  const writeA = adapter.write('A');
  assert.equal(currentValue, 'A');

  // Newer write starts second; its OWN `previous` snapshot correctly
  // captures 'A' (the live value at ITS start), not whatever preceded 'A'.
  const writeB = adapter.write('B');
  assert.equal(currentValue, 'B');

  await flushMicrotasks(); // let both spec.write() calls register their deferred

  // The newer write's persist call wins the race and succeeds first.
  deferredByValue.get('B').resolve();
  await writeB;
  assert.equal(currentValue, 'B');

  // The OLDER write's persist call then fails, arriving after B already
  // won. Its rollback must be suppressed -- B is the authoritative result.
  deferredByValue.get('A').reject(new Error('stale write failed'));
  await assert.rejects(() => writeA, /stale write failed/);

  assert.equal(currentValue, 'B', "a stale write's rollback must not clobber a newer write's already-applied success");
  assert.deepEqual(calls, ['A', 'B'], 'no extra rollback apply() call should fire for the stale, superseded write');
  assert.equal(logs.length, 1, 'the stale failure is still logged (caller-visible), it just does not touch the UI');
});

test('write(): a stale write succeeding after a newer write already applied does not reconcile over it', async () => {
  let currentValue = 'initial';
  const calls = [];
  const deferredByValue = new Map();

  const adapter = createSettingsAdapter({
    id: 'raced-reconcile',
    read: () => currentValue,
    normalize: (raw) => raw,
    write: (value) => {
      const deferred = createDeferred();
      deferredByValue.set(value, deferred);
      // Server "corrects" whatever it is handed, forcing the reconcile path.
      return deferred.promise.then(() => value + '-corrected');
    },
    getDefault: () => 'default',
    apply: (value) => { currentValue = value; calls.push(value); },
  });

  const writeA = adapter.write('A');
  const writeB = adapter.write('B');
  assert.equal(currentValue, 'B');

  await flushMicrotasks();

  deferredByValue.get('B').resolve();
  await writeB;
  assert.equal(currentValue, 'B-corrected');

  // Older write's persist call finally resolves too, after B already
  // reconciled -- must not reconcile the UI back to A's corrected value.
  deferredByValue.get('A').resolve();
  await writeA;

  assert.equal(currentValue, 'B-corrected', "a stale write's success reconciliation must not clobber the newer write's result");
  assert.deepEqual(calls, ['A', 'B', 'B-corrected']);
});

test('write(): two overlapping writes BOTH failing roll back to the true pre-group baseline, never a stranded intermediate', async () => {
  // Adversarial-audit finding on d49df22c: `previous` is snapshotted from
  // read(), which in the zoom/offline wirings returns the value apply()
  // mutates -- so the second write's snapshot captures the FIRST write's
  // un-persisted optimistic value. When both writes fail and the older one
  // fails LAST, the generation guard suppressed the only rollback holding
  // the true persisted value, stranding a value never persisted anywhere.
  let currentValue = 100; // the true persisted baseline
  const calls = [];
  const deferredByValue = new Map();

  const adapter = createSettingsAdapter({
    id: 'double-fail',
    read: () => currentValue, // production contamination: read() reflects apply()
    write: (value) => {
      const deferred = createDeferred();
      deferredByValue.set(value, deferred);
      return deferred.promise;
    },
    getDefault: () => 100,
    apply: (value) => { currentValue = value; calls.push(value); },
  });

  const writeSlow = adapter.write(150); // older write, will fail LAST
  assert.equal(currentValue, 150);
  const writeFast = adapter.write(200); // newer write, fails first
  assert.equal(currentValue, 200);

  await flushMicrotasks();

  deferredByValue.get(200).reject(new Error('fast write failed'));
  await assert.rejects(() => writeFast, /fast write failed/);

  deferredByValue.get(150).reject(new Error('slow write failed'));
  await assert.rejects(() => writeSlow, /slow write failed/);

  assert.equal(
    currentValue,
    100,
    'when every overlapping write fails, the applied value must return to the true persisted baseline (100), '
      + 'not strand on an intermediate optimistic value (150) that was never persisted anywhere'
  );
});

test('write(): older write succeeding after a newer one FAILED reconciles to the older, actually-persisted value', async () => {
  // Backend serialization means the persisted final value is the newest
  // SUCCESSFUL write's result -- when the newest write failed, an older
  // success is the persisted truth and must win the group resolution.
  let currentValue = 100;
  const deferredByValue = new Map();

  const adapter = createSettingsAdapter({
    id: 'mixed-outcome',
    read: () => currentValue,
    write: (value) => {
      const deferred = createDeferred();
      deferredByValue.set(value, deferred);
      return deferred.promise;
    },
    getDefault: () => 100,
    apply: (value) => { currentValue = value; },
  });

  const writeSlow = adapter.write(150); // older, will SUCCEED last
  const writeFast = adapter.write(200); // newer, fails first
  assert.equal(currentValue, 200);

  await flushMicrotasks();

  deferredByValue.get(200).reject(new Error('fast write failed'));
  await assert.rejects(() => writeFast, /fast write failed/);

  deferredByValue.get(150).resolve();
  await writeSlow;

  assert.equal(
    currentValue,
    150,
    'the older write persisted (150) while the newer failed -- the applied value must match the persisted one'
  );
});

test("write(): a write with no newer write in flight still rolls back and reconciles normally", async () => {
  // Regression guard for the generation counter itself: a solitary write
  // (the overwhelmingly common case) must behave exactly as before.
  const calls = [];
  const failing = createSettingsAdapter({
    id: 'solo-fail',
    read: () => 'prev',
    write: () => Promise.reject(new Error('boom')),
    getDefault: () => 'default',
    apply: (value) => calls.push(value),
  });
  await assert.rejects(() => failing.write('next'));
  assert.deepEqual(calls, ['next', 'prev']);

  const reconciling = createSettingsAdapter({
    id: 'solo-reconcile',
    read: () => 1,
    normalize: (raw) => Number(raw),
    write: (value) => value + 1000,
    getDefault: () => 0,
    apply: (value) => calls.push(value),
  });
  const result = await reconciling.write(5);
  assert.equal(result, 1005);
  assert.deepEqual(calls, ['next', 'prev', 5, 1005]);
});

// ── createAppearanceAdapter ────────────────────────────────────────────────

test('appearance adapter: read() returns the shared default on empty storage', () => {
  const adapter = createAppearanceAdapter({ storage: createFakeStorage() });
  assert.deepEqual(adapter.read(), appearanceUtils.getDefaultAppearancePreferences());
});

test('appearance adapter: write() then read() round-trips through the fake localStorage shim', async () => {
  const storage = createFakeStorage();
  const adapter = createAppearanceAdapter({ storage });
  const written = await adapter.write({ paletteId: 'pewter', typographyId: 'technical' });
  assert.equal(written.paletteId, 'pewter');
  assert.equal(written.typographyId, 'technical');
  assert.ok(storage.getItem(appearanceUtils.STORAGE_KEY), 'storage key was written');
  assert.deepEqual(adapter.read(), written);
});

test('appearance adapter: normalize coerces a garbage palette to the same fallback as an empty preferences object (not the getDefault() fresh-profile value)', () => {
  const adapter = createAppearanceAdapter({ storage: createFakeStorage() });
  const garbage = adapter.normalize({ paletteId: 'totally-not-a-real-palette', typographyId: 'nonsense' });
  const emptyFallback = appearanceUtils.normalizeAppearancePreferences({});
  assert.equal(garbage.paletteId, emptyFallback.paletteId, 'garbage coerces to the same conservative per-field fallback as {}');
  assert.equal(garbage.typographyId, emptyFallback.typographyId);
  const knownPaletteIds = appearanceUtils.getPalettePresets().map((preset) => preset.id);
  assert.ok(knownPaletteIds.includes(garbage.paletteId), 'coerced palette is a known, valid preset id');
});

test('appearance adapter: redact is lossless identity', () => {
  const adapter = createAppearanceAdapter({ storage: createFakeStorage() });
  const value = adapter.normalize({ paletteId: 'obsidian', motionId: 'expressive' });
  assert.deepEqual(adapter.redact(value), value);
});

test('appearance adapter: write() rolls back and logs when the underlying storage write throws', async () => {
  const calls = [];
  const logs = [];
  const storage = createFakeStorage();
  storage.setItem = () => {
    throw new Error('quota exceeded');
  };
  const adapter = createAppearanceAdapter({
    storage,
    applyAppearance: (value) => calls.push(value.paletteId),
    log: (message) => logs.push(message),
  });
  await assert.rejects(() => adapter.write({ paletteId: 'pewter' }), /quota exceeded/);
  const defaultPaletteId = appearanceUtils.getDefaultAppearancePreferences().paletteId;
  assert.deepEqual(calls, ['pewter', defaultPaletteId]);
  assert.equal(logs.length, 1);
});

test('createAppearanceAdapter requires a localStorage-shaped storage dependency', () => {
  assert.throws(() => createAppearanceAdapter({}), /deps\.storage must be a localStorage-shaped object/);
  assert.throws(() => createAppearanceAdapter({ storage: {} }), /deps\.storage must be a localStorage-shaped object/);
});

// ── createZoomAdapter ──────────────────────────────────────────────────────

function createZoomHarness(overrides) {
  const calls = [];
  const logs = [];
  let current = 100;
  const settings = Object.assign(
    {
      getCurrent: () => current,
      updateSettings: async ({ zoomPercent }) => {
        calls.push(['update', zoomPercent]);
        return { zoomPercent };
      },
      applyZoom: (value) => {
        calls.push(['apply', value]);
        current = value;
      },
      log: (message) => logs.push(message),
    },
    overrides
  );
  const adapter = createZoomAdapter(settings);
  return { adapter, calls, logs, getCurrent: () => current, setCurrent: (v) => { current = v; } };
}

test('zoom adapter: clamp bounds match the real chat-zoom-utils normalize (derived, not hardcoded)', () => {
  const { adapter } = createZoomHarness();
  const probes = [
    chatZoomUtils.MIN_CHAT_ZOOM_PERCENT - 50,
    chatZoomUtils.MIN_CHAT_ZOOM_PERCENT,
    chatZoomUtils.MAX_CHAT_ZOOM_PERCENT,
    chatZoomUtils.MAX_CHAT_ZOOM_PERCENT + 50,
    103, // off-step value
    'not-a-number',
  ];
  for (const probe of probes) {
    assert.equal(
      adapter.normalize(probe),
      chatZoomUtils.normalizeChatZoomPercent(probe),
      `adapter.normalize(${JSON.stringify(probe)}) must match chatZoomUtils.normalizeChatZoomPercent`
    );
  }
  assert.equal(adapter.getDefault(), chatZoomUtils.getDefaultChatZoomPercent());
});

test('zoom adapter: optimistic apply fires with the normalized value before the persist call resolves', async () => {
  const { adapter, calls } = createZoomHarness();
  const result = await adapter.write(122); // normalizes to 120 (step 5)
  assert.equal(result, 120);
  assert.deepEqual(calls, [['apply', 120], ['update', 120]]);
});

test('zoom adapter: reconciles to the persisted response value when it differs from what was applied', async () => {
  const { adapter, calls } = createZoomHarness({
    updateSettings: async ({ zoomPercent }) => {
      calls.push(['update', zoomPercent]);
      return { zoomPercent: 125 }; // server reconciles to a different value
    },
  });
  const result = await adapter.write(110);
  assert.equal(result, 125);
  assert.deepEqual(calls, [['apply', 110], ['update', 110], ['apply', 125]]);
});

test('zoom adapter: on updateSettings rejection, rolls back to the previous value and logs', async () => {
  const { adapter, calls, logs, getCurrent } = createZoomHarness({
    getCurrent: () => 100,
    updateSettings: async ({ zoomPercent }) => {
      calls.push(['update', zoomPercent]);
      throw new Error('ipc unavailable');
    },
  });
  await assert.rejects(() => adapter.write(130), /ipc unavailable/);
  assert.deepEqual(calls, [['apply', 130], ['update', 130], ['apply', 100]]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /chatZoom/);
  assert.match(logs[0], /ipc unavailable/);
  assert.equal(getCurrent(), 100);
});

test('createZoomAdapter requires updateSettings and getCurrent dependencies', () => {
  assert.throws(() => createZoomAdapter({}), /deps\.updateSettings must be a function/);
  assert.throws(
    () => createZoomAdapter({ updateSettings: async () => {} }),
    /deps\.getCurrent must be a function/
  );
});

// ── listEditableKeys() (JSON-editor allowlist capability) ──────────────────

test('createSettingsAdapter: listEditableKeys() defaults to getDefault()\'s own keys', () => {
  const adapter = createSettingsAdapter({
    id: 'defaulted',
    read: () => ({}),
    write: (value) => value,
    getDefault: () => ({ a: 1, b: 2, c: 3 }),
  });
  assert.deepEqual(adapter.listEditableKeys(), ['a', 'b', 'c']);
});

test('createSettingsAdapter: listEditableKeys() returns [] when getDefault() is not a plain object', () => {
  const adapter = createSettingsAdapter({
    id: 'scalar-default',
    read: () => 0,
    write: (value) => value,
    getDefault: () => 0,
  });
  assert.deepEqual(adapter.listEditableKeys(), []);
});

test('createSettingsAdapter: spec.listEditableKeys overrides the default derivation', () => {
  const adapter = createSettingsAdapter({
    id: 'narrowed',
    read: () => ({}),
    write: (value) => value,
    getDefault: () => ({ a: 1, b: 2, secret: 'x' }),
    listEditableKeys: () => ['a', 'b'],
  });
  assert.deepEqual(adapter.listEditableKeys(), ['a', 'b']);
});

// ── createOfflineAdapter ─────────────────────────────────────────────────

function createOfflineHarness(overrides) {
  const calls = [];
  const logs = [];
  let current = { mode: 'disabled', preferredLocalModel: '' };
  const settings = Object.assign(
    {
      getCurrent: () => current,
      updateSettings: async (patch) => {
        calls.push(['update', patch]);
        current = Object.assign({}, current, patch);
        return current;
      },
      log: (message) => logs.push(message),
    },
    overrides
  );
  const adapter = createOfflineAdapter(settings);
  return {
    adapter,
    calls,
    logs,
    getCurrent: () => current,
    setCurrent: (v) => { current = v; },
  };
}

test('offline adapter: getDefault() matches DEFAULT_OFFLINE_INTELLIGENCE (services/shell-config-state.js:70-73)', () => {
  const { adapter } = createOfflineHarness();
  assert.deepEqual(adapter.getDefault(), { mode: 'disabled', preferredLocalModel: '' });
});

test('offline adapter: listEditableKeys() is exactly [mode, preferredLocalModel]', () => {
  const { adapter } = createOfflineHarness();
  assert.deepEqual(adapter.listEditableKeys(), ['mode', 'preferredLocalModel']);
});

test('offline adapter: normalize projects a full IPC echo (readiness fields included) down to {mode, preferredLocalModel}', () => {
  const { adapter } = createOfflineHarness();
  const fullEcho = {
    mode: 'local_only',
    preferredLocalModel: 'llama3',
    localChatReady: true,
    localVisionReady: false,
    summary: 'Local runtime is ready.',
    localCatalog: { available: true, models: ['llama3'] },
    managedSidecar: { mode: 'vllm', phase: 'ready', ready: true },
    currentEngine: 'vllm',
    unavailableReason: '',
  };
  assert.deepEqual(adapter.normalize(fullEcho), { mode: 'local_only', preferredLocalModel: 'llama3' });
});

test('offline adapter: normalize rejects an unrecognized mode down to the safe default "disabled"', () => {
  const { adapter } = createOfflineHarness();
  assert.equal(adapter.normalize({ mode: 'anything-else' }).mode, 'disabled');
  assert.equal(adapter.normalize({ mode: 'LOCAL_ONLY' }).mode, 'local_only');
  assert.equal(adapter.normalize({}).mode, 'disabled');
  assert.equal(adapter.normalize(null).mode, 'disabled');
});

test('offline adapter: write() sends only {mode, preferredLocalModel} to updateSettings and normalizes the echoed response', async () => {
  const { adapter, calls } = createOfflineHarness({
    updateSettings: async (patch) => {
      calls.push(['update', patch]);
      return {
        mode: patch.mode,
        preferredLocalModel: patch.preferredLocalModel,
        localChatReady: true, // extra readiness field in the echo
      };
    },
  });
  const result = await adapter.write({ mode: 'local_only', preferredLocalModel: 'qwen3' });
  assert.deepEqual(result, { mode: 'local_only', preferredLocalModel: 'qwen3' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { mode: 'local_only', preferredLocalModel: 'qwen3' });
});

test('offline adapter: write() rolls back and logs on updateSettings rejection', async () => {
  const { adapter, logs } = createOfflineHarness({
    getCurrent: () => ({ mode: 'disabled', preferredLocalModel: '' }),
    updateSettings: async () => {
      throw new Error('ipc unavailable');
    },
  });
  await assert.rejects(() => adapter.write({ mode: 'local_only', preferredLocalModel: 'qwen3' }), /ipc unavailable/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /offline/);
});

test('createOfflineAdapter requires updateSettings and getCurrent dependencies', () => {
  assert.throws(() => createOfflineAdapter({}), /deps\.updateSettings must be a function/);
  assert.throws(
    () => createOfflineAdapter({ updateSettings: async () => {} }),
    /deps\.getCurrent must be a function/
  );
});
