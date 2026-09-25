'use strict';

// The engine-liveness heartbeat feeds the sidecar's stream-inactivity watchdog
// while a local model composes a buffered tool call. Ollama's embedded runner
// and a standalone llama-server print the same telemetry in two different log
// formats, so one matcher has to read both.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ENGINE_ACTIVITY_THROTTLE_MS,
  createEngineActivityForwarder,
  isEngineActivityLine,
} = require('../services/backend/engine-activity-lines');

const ESC = String.fromCharCode(27);

test('decode and load telemetry counts as activity in both engines log formats', () => {
  for (const line of [
    // Ollama's embedded runner: bare line.
    'slot print_timing: id 0 | task 1 | n_decoded = 10',
    'cmn  common_reaso: deactivated (natural end)',
    'llama_model_loader: loaded meta data',
    'load_tensors: offloading 36 layers to GPU',
    // Managed llama-server: timestamp + level prefix (captured 2026-09-19).
    '13.45.081.978 I slot print_timing: id  2 | task 20326 | n_gen =    159, tg =  52.47 t/s',
    '13.41.451.924 I slot launch_slot_: id  2 | task 20326 | processing task',
    '0.00.041.713 I llama_model_loader: loaded meta data with 44 key-value pairs',
    // ...and the same with --log-colors enabled.
    `${ESC}[34m0.00.041.713${ESC}[0m ${ESC}[31mI slot release: id  2 | task 1${ESC}[0m`,
  ]) {
    assert.equal(isEngineActivityLine(line), true, line);
  }
});

test('ambient server traffic is not activity, prefixed or not', () => {
  for (const line of [
    'srv  update_slots: all slots are idle',
    '15.51.896.797 W srv   operator (): unauthorized: Invalid API Key',
    '[GIN] 2026/09/19 - 09:11:08 | 200 | GET "/api/tags"',
    'main: server is listening on http://127.0.0.1:8033',
    '',
  ]) {
    assert.equal(isEngineActivityLine(line), false, JSON.stringify(line));
  }
});

test('the forwarder fires immediately, then at most once per throttle window', () => {
  let clock = 1000;
  const calls = [];
  const forward = createEngineActivityForwarder({
    onEngineActivity: () => calls.push(clock),
    now: () => clock,
  });
  const decode = '13.45.081.978 I slot print_timing: id 2 | n_gen = 159';

  forward(decode);
  forward(decode);
  clock += ENGINE_ACTIVITY_THROTTLE_MS - 1;
  forward(decode);
  clock += 1;
  forward(decode);
  // Ambient lines never move the clock forward.
  clock += ENGINE_ACTIVITY_THROTTLE_MS;
  forward('srv  update_slots: all slots are idle');

  assert.deepEqual(calls, [1000, 1000 + ENGINE_ACTIVITY_THROTTLE_MS]);
});

test('no sink means no forwarder, and a throwing sink never escapes', () => {
  assert.equal(createEngineActivityForwarder({}), null);
  const forward = createEngineActivityForwarder({
    onEngineActivity: () => {
      throw new Error('sink exploded');
    },
  });
  assert.doesNotThrow(() => forward('slot print_timing: id 0 | task 1'));
});
