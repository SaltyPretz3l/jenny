const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMessageSequence, createControllerHarness } = require('./helpers/send-controller-harness');
const rendererComposerVisionGate = require('../renderer/chat/renderer-composer-vision-gate');

// The session-level run_mode enum projects onto the existing approval_mode /
// plan_mode wire fields at the send path's pre-await snapshot point
// (docs/plans/COMPOSER_RUN_MODE_SPEC.md §2, §3.3). The one-shot
// consumeApprovalMode() grant is retired; the mode is durable session state.

async function capturePayload(t, runtimePreferences) {
  const harness = createControllerHarness(buildMessageSequence(), { runtimePreferences });
  t.after(() => harness.restore());
  const result = await harness.controller.startPromptSend('do it');
  assert.ok(result, 'send starts');
  assert.equal(harness.calls.startStream.length, 1);
  return harness.calls.startStream[0];
}

test('run mode auto projects approval_mode auto_run onto the send payload', async (t) => {
  const payload = await capturePayload(t, { runMode: 'auto' });
  assert.equal(payload.approvalMode, 'auto_run');
  assert.equal(payload.planMode, false);
});

test('run mode plan projects plan_mode true with prompting approvals', async (t) => {
  const payload = await capturePayload(t, { runMode: 'plan' });
  assert.equal(payload.approvalMode, 'prompt');
  assert.equal(payload.planMode, true);
});

test('default run mode is ask: prompting approvals, no plan', async (t) => {
  const payload = await capturePayload(t, {});
  assert.equal(payload.approvalMode, 'prompt');
  assert.equal(payload.planMode, false);
});

test('malformed run mode falls back to ask', async (t) => {
  const payload = await capturePayload(t, { runMode: 'nonsense' });
  assert.equal(payload.approvalMode, 'prompt');
  assert.equal(payload.planMode, false);
});

test('legacy session shape (plan_mode only) still projects plan', async (t) => {
  // Stay-green compatibility pin: old sessions carry planMode without runMode.
  const payload = await capturePayload(t, { planMode: true });
  assert.equal(payload.approvalMode, 'prompt');
  assert.equal(payload.planMode, true);
});

test('a new optimistic session summary records the run mode it was created under', async (t) => {
  const harness = createControllerHarness(buildMessageSequence(), {
    runtimePreferences: { runMode: 'auto' },
  });
  t.after(() => harness.restore());
  harness.state.currentSessionId = '';
  harness.state.sessions = [];
  const result = await harness.controller.startPromptSend('kick off');
  assert.ok(result, 'send starts');
  const summary = harness.state.sessions[0];
  assert.ok(summary, 'optimistic summary upserted');
  assert.equal(summary.run_mode, 'auto');
  assert.equal(summary.plan_mode, false);
});

test('a queued-send snapshot never freezes the run mode: dispatch projects the live session mode (§4a)', async (t) => {
  // User queues a follow-up while in Auto, then flips to Ask mid-turn to stop
  // unattended execution. The queued dispatch replays the frozen model/effort
  // snapshot, but the mode must be read live from the target session — the
  // queue pill copy promises "runs in <current mode>".
  const harness = createControllerHarness(buildMessageSequence(), {
    runtimePreferences: { runMode: 'ask' },
  });
  t.after(() => harness.restore());
  harness.state.sessions = [{ id: 'session-1', title: 'Session 1', run_mode: 'ask', plan_mode: false }];
  const result = await harness.controller.startPromptSend('queued follow-up', {
    runtimePreferencesSnapshot: { preferredModel: 'frozen-model', reasoningEffort: 'high', runMode: 'auto', planMode: false },
  });
  assert.ok(result, 'dispatch starts');
  const payload = harness.calls.startStream[0];
  assert.equal(payload.approvalMode, 'prompt', 'live Ask wins over the frozen Auto snapshot');
  assert.equal(payload.planMode, false);
  assert.equal(payload.preferredModel, 'frozen-model', 'model stays frozen by design');
});

test('a queued-send snapshot dispatching into a plan session projects plan live', async (t) => {
  const harness = createControllerHarness(buildMessageSequence(), {
    runtimePreferences: { runMode: 'ask' },
  });
  t.after(() => harness.restore());
  harness.state.sessions = [{ id: 'session-1', title: 'Session 1', run_mode: 'plan', plan_mode: true }];
  const result = await harness.controller.startPromptSend('queued follow-up', {
    runtimePreferencesSnapshot: { runMode: 'auto', planMode: false },
  });
  assert.ok(result, 'dispatch starts');
  const payload = harness.calls.startStream[0];
  assert.equal(payload.approvalMode, 'prompt');
  assert.equal(payload.planMode, true, 'the target session mode wins at dispatch time');
});

test('vision gate evaluates the resolved send preference snapshot instead of live composer preferences', async (t) => {
  const originalVisionGate = globalThis.rendererComposerVisionGate;
  globalThis.rendererComposerVisionGate = rendererComposerVisionGate;
  t.after(() => { globalThis.rendererComposerVisionGate = originalVisionGate; });

  await t.test('text-only snapshot blocks even when the live preference supports vision', async (t) => {
    const harness = createControllerHarness(buildMessageSequence(), { runtimePreferences: { preferredModel: 'vision-model' } });
    t.after(() => harness.restore());
    harness.state.attachments.queued = [{ id: 'image-1', kind: 'image' }];
    harness.state.modelList = { data: [
      { id: 'text-model', capabilities: { vision: false } },
      { id: 'vision-model', capabilities: { vision: true } },
    ] };

    const result = await harness.controller.startPromptSend('describe it', {
      runtimePreferencesSnapshot: { preferredModel: 'text-model' },
    });

    assert.equal(result, null);
    assert.equal(harness.calls.startStream.length, 0);
    assert.deepEqual(harness.calls.composerNotices.at(-1), {
      message: "text-model can't see images. Switch to a vision model or remove the image.",
      options: { owner: 'attachments.vision', tone: 'warning', at: 0 },
    });
  });

  await t.test('vision-capable snapshot proceeds when the live preference is text-only', async (t) => {
    const harness = createControllerHarness(buildMessageSequence(), { runtimePreferences: { preferredModel: 'text-model' } });
    t.after(() => harness.restore());
    harness.state.attachments.queued = [{ id: 'image-1', kind: 'image' }];
    harness.state.modelList = { data: [
      { id: 'text-model', capabilities: { vision: false } },
      { id: 'vision-model', capabilities: { vision: true } },
    ] };

    const result = await harness.controller.startPromptSend('describe it', {
      runtimePreferencesSnapshot: { preferredModel: 'vision-model' },
    });

    assert.ok(result, 'send proceeds past the vision gate');
    assert.equal(harness.calls.startStream.length, 1);
  });
});

test('send controller works with no approval-mode controller wired at all', async (t) => {
  // The approvalModeController dependency is retired with the one-shot chip;
  // a send must neither require it nor call into it.
  const harness = createControllerHarness(buildMessageSequence(), {
    approvalModeController: {
      consumeApprovalMode() {
        throw new Error('retired consumeApprovalMode must never be called');
      },
    },
    runtimePreferences: { runMode: 'auto' },
  });
  t.after(() => harness.restore());
  const result = await harness.controller.startPromptSend('do it');
  assert.ok(result, 'send starts without consulting the retired controller');
  assert.equal(harness.calls.startStream[0].approvalMode, 'auto_run');
});

test('a disposed controller still rejects the send without starting a stream', async (t) => {
  const harness = createControllerHarness(buildMessageSequence(), {
    runtimePreferences: { runMode: 'auto' },
  });
  t.after(() => harness.restore());
  harness.controller.dispose();
  assert.equal(await harness.controller.startPromptSend('do it'), null);
  assert.equal(harness.calls.startStream.length, 0);
});
