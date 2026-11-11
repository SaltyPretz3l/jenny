'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { png } = require('./helpers/image-generate-fixture');
const { fileSymlinkSkip } = require('./helpers/platform-skips');
const { fillRecipeGraph, runComfyGeneration } = require('../services/comfyui-runner');

const fixture = (name) => require(`./fixtures/comfyui/${name}.json`);
const shipped = require('../config/comfyui-recipes.json').recipes.minimax_h3_image;
const OP_ID = 'img_0123456789ab';
const PORT = 8191;

// A shipped-recipe copy that also accepts the small sizes the tests render.
const recipe = { ...shipped, resolutions: [...shipped.resolutions, '64x64', '32x32'] };
const LOADERS = { diffusion: 'm.safetensors', text_encoder: 'te.safetensors', vae: 'vae.safetensors' };

function makeSocketClass({ useProperties = false } = {}) {
  return class FakeWebSocket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.listeners = {};
      if (useProperties) this.addEventListener = undefined;
      FakeWebSocket.instances.push(this);
    }
    addEventListener(type, listener) {
      (this.listeners[type] ||= []).push(listener);
    }
    removeEventListener() {}
    fire(type, event) {
      for (const listener of this.listeners[type] || []) listener(event);
      if (typeof this[`on${type}`] === 'function') this[`on${type}`](event);
    }
    open() { this.fire('open', {}); }
    emit(value) { this.fire('message', { data: typeof value === 'string' ? value : JSON.stringify(value) }); }
    error() { this.fire('error', {}); }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.fire('close', {});
    }
  };
}

function until(check, label = 'condition') {
  return new Promise((resolve, reject) => {
    let spins = 0;
    const step = () => {
      if (check()) resolve();
      else if (++spins > 500) reject(new Error(`timed out waiting for ${label}`));
      else setImmediate(step);
    };
    step();
  });
}

function startRun(t, overrides = {}) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-comfy-runner-'));
  const SocketClass = makeSocketClass({ useProperties: overrides.useProperties });
  const controller = new AbortController();
  const calls = [];
  const progress = [];
  const logs = [];
  const clock = { time: 0 };
  const routes = {
    prompt: () => ({ status: 200, body: { prompt_id: overrides.promptId, number: 1, node_errors: {} } }),
    history: () => ({ status: 404, body: {} }),
    interrupt: () => ({ status: 200, body: {} }),
    ...overrides.routes,
  };
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(url).pathname.split('/')[1];
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, url, method: init.method || 'GET', body });
    const reply = await routes[route](url, body);
    const text = JSON.stringify(reply.body);
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, text: async () => text };
  };
  const options = {
    server: { baseUrl: `http://127.0.0.1:${PORT}`, port: PORT, outputDir, opId: OP_ID },
    recipe, loaderNames: LOADERS,
    params: { prompt: 'a lighthouse', width: 64, height: 64, seed: 7 },
    deadlineMs: 60000, abortSignal: controller.signal,
    onProgress: (event) => progress.push(event), log: (...args) => logs.push(args),
    fetchImpl, WebSocketImpl: SocketClass, now: () => clock.time,
    interruptGraceMs: 25, connectTimeoutMs: 1000,
    ...overrides.options,
  };
  if (overrides.server) options.server = { ...options.server, ...overrides.server };
  if (overrides.params) options.params = { ...options.params, ...overrides.params };
  const promise = runComfyGeneration(options);
  const run = {
    promise, outputDir, calls, progress, logs, clock, controller, SocketClass,
    get ws() { return SocketClass.instances[0]; },
    count: (route) => calls.filter((call) => call.route === route).length,
    // Opens the socket and waits until the prompt has been queued.
    async queued() {
      run.ws.open();
      await until(() => run.count('prompt') > 0, 'POST /prompt');
      await new Promise((resolve) => setImmediate(resolve));
    },
    replay(events) {
      for (const event of events) {
        clock.time = event.at_ms ?? clock.time;
        run.ws.emit({ type: event.type, data: event.data });
      }
    },
  };
  t.after(async () => {
    controller.abort();
    await promise;
    fs.rmSync(outputDir, { recursive: true, force: true });
  });
  return run;
}

const promptIdOf = (events) => events.find((event) => event.data?.prompt_id).data.prompt_id;

test('an execution_error replay fails with one sanitized line and no path', async (t) => {
  const { events } = fixture('execution-error-events');
  const run = startRun(t, { promptId: promptIdOf(events) });
  await run.queued();
  run.replay(events);
  const result = await run.promise;
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'image_comfyui_failed');
  assert.equal(result.png, null);
  assert.equal(result.stderrTail.length, 1);
  assert.match(result.stderrTail[0], /VAEDecode/);
  assert.match(result.stderrTail[0], /IndexError/);
  assert.doesNotMatch(result.stderrTail[0], /:\\/);
});

const writePng = (run, name, width = 64, height = 64) => {
  fs.writeFileSync(path.join(run.outputDir, name), png(width, height));
};

// A short synthetic run: start, the output node's image, success.
function syntheticEvents(promptId, image) {
  return [
    { type: 'execution_start', data: { prompt_id: promptId } },
    { type: 'executed', data: { node: '9', prompt_id: promptId, output: { images: [image] } } },
    { type: 'execution_success', data: { prompt_id: promptId } },
  ];
}
const goodImage = { filename: 'jenny_00001_.png', subfolder: '', type: 'output' };

test('a full MiniMax replay publishes the PNG, removes the file and reports ordered phases', async (t) => {
  const { events } = fixture('minimax-run-events');
  const run = startRun(t, { promptId: promptIdOf(events) });
  writePng(run, 'jenny_00001_.png');
  await run.queued();
  run.replay(events);
  const result = await run.promise;
  assert.equal(result.status, 'ok');
  assert.equal(result.reason, '');
  assert.equal(result.png.width, 64);
  assert.equal(result.png.height, 64);
  assert.equal(result.png.bytes, result.png.buffer.length);
  assert.equal(result.promptId, promptIdOf(events));
  assert.deepEqual(result.stderrTail, []);
  assert.equal(fs.existsSync(path.join(run.outputDir, 'jenny_00001_.png')), false);
  const phases = run.progress.map((event) => event.phase);
  assert.equal(phases[0], 'load');
  assert.equal(phases.at(-1), 'decode');
  assert.deepEqual(phases.filter((phase) => phase === 'load' || phase === 'decode'), ['load', 'decode']);
  const samples = run.progress.filter((event) => event.phase === 'sample');
  assert.deepEqual(samples.at(-1), { phase: 'sample', step: 6, steps: 6, fraction: 1 });
  assert.equal(phases.lastIndexOf('sample') < phases.indexOf('decode'), true);
  assert.equal(result.seconds.load, (39052 - 2) / 1000);
  assert.equal(result.seconds.sample, (40932 - 39052) / 1000);
  assert.equal(result.seconds.total, 43.835);
  assert.equal(run.logs.length, 1);
  assert.deepEqual(run.logs[0], ['INFO', 'comfyui_runner.settled', { opId: OP_ID, status: 'ok', reason: '' }]);
  const queued = run.calls.find((call) => call.route === 'prompt');
  assert.equal(queued.method, 'POST');
  assert.equal(queued.body.client_id, OP_ID);
  assert.equal(queued.body.prompt['7'].inputs.steps, 6);
  assert.equal(queued.body.prompt['5'].inputs.prompt, 'a lighthouse');
  assert.equal(run.ws.url, `ws://127.0.0.1:${PORT}/ws?clientId=${OP_ID}`);
  assert.equal(run.ws.closed, true);
});

test('sample progress is throttled to one per 250 ms except the last step', async (t) => {
  const id = 'prompt-1';
  const run = startRun(t, { promptId: id });
  await run.queued();
  const step = (value) => run.ws.emit({ type: 'progress', data: { prompt_id: id, node: '7', value, max: 6 } });
  for (const value of [1, 2, 3, 4, 5, 6]) step(value);
  run.ws.emit({ type: 'execution_error', data: { prompt_id: id, node_type: 'X', exception_type: 'Y', exception_message: 'z' } });
  await run.promise;
  assert.deepEqual(run.progress.map((event) => event.step), [1, 6]);
});

test('out-of-range or foreign progress is ignored', async (t) => {
  const id = 'prompt-1';
  const run = startRun(t, { promptId: id });
  await run.queued();
  const bad = [{ value: 0, max: 6, node: '7' }, { value: 7, max: 6, node: '7' }, { value: 1, max: 1001, node: '7' },
    { value: 1.5, max: 6, node: '7' }, { value: 1, max: 6, node: '5' }];
  for (const data of bad) run.ws.emit({ type: 'progress', data: { prompt_id: id, ...data } });
  run.ws.emit({ type: 'execution_interrupted', data: { prompt_id: id } });
  const result = await run.promise;
  assert.deepEqual(run.progress, []);
  assert.deepEqual(result.stderrTail, ['ComfyUI interrupted the job']);
  assert.equal(result.reason, 'image_comfyui_failed');
});

test('a refused prompt (400) fails with the model-file message and needs no socket events', async (t) => {
  const refused = fixture('refused-prompt');
  const run = startRun(t, { promptId: 'x', routes: { prompt: () => ({ status: 400, body: refused }) } });
  await run.queued();
  const result = await run.promise;
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'image_comfyui_failed');
  assert.equal(result.stderrTail.length, 1);
  assert.match(result.stderrTail[0], /Prompt outputs failed validation/);
  assert.match(result.stderrTail[0], /missing_model\.safetensors/);
});

test('other prompt failures are failed results', async (t) => {
  const cases = {
    'a 500': { prompt: () => ({ status: 500, body: {} }) },
    'a reply without a prompt_id': { prompt: () => ({ status: 200, body: { number: 1 } }) },
    'a prompt_id with separators': { prompt: () => ({ status: 200, body: { prompt_id: '../x' } }) },
    'a network error': { prompt: () => { throw new Error('ECONNREFUSED'); } },
  };
  for (const [label, routes] of Object.entries(cases)) {
    const run = startRun(t, { routes });
    await run.queued();
    const result = await run.promise;
    assert.equal(result.status, 'failed', label);
    assert.equal(result.reason, 'image_comfyui_failed', label);
    assert.equal(result.png, null, label);
  }
});

test('the event connection failing before open, or never opening, is a failed result', async (t) => {
  const early = startRun(t, { promptId: 'x' });
  early.ws.error();
  const first = await early.promise;
  assert.deepEqual([first.status, first.reason, first.stderrTail], ['failed', 'image_comfyui_failed', ['ComfyUI event connection failed']]);
  assert.equal(early.calls.length, 0);

  const closed = startRun(t, { promptId: 'x' });
  closed.ws.close();
  assert.deepEqual((await closed.promise).stderrTail, ['ComfyUI event connection failed']);

  const silent = startRun(t, { promptId: 'x', options: { connectTimeoutMs: 15 } });
  const third = await silent.promise;
  assert.deepEqual([third.status, third.stderrTail], ['failed', ['ComfyUI event connection failed']]);
  assert.equal(silent.calls.length, 0);
});

test('the socket may use on* properties instead of addEventListener', async (t) => {
  const id = 'prompt-1';
  const run = startRun(t, { promptId: id, useProperties: true });
  await run.queued();
  run.ws.emit({ type: 'execution_error', data: { prompt_id: id, node_type: 'KSampler', exception_type: 'OOM', exception_message: 'out of memory' } });
  const result = await run.promise;
  assert.deepEqual(result.stderrTail, ['KSampler: OOM: out of memory']);
});

test('abort after the first progress interrupts once and settles as cancelled when ComfyUI confirms', async (t) => {
  const { events } = fixture('minimax-cancel-events');
  const id = promptIdOf(events);
  const run = startRun(t, { promptId: id });
  await run.queued();
  const firstPrompt = events.filter((event) => event.data?.prompt_id === id);
  const interrupted = firstPrompt.find((event) => event.type === 'execution_interrupted');
  run.replay(firstPrompt.slice(0, firstPrompt.indexOf(interrupted)));
  assert.equal(run.progress.some((event) => event.phase === 'sample'), true);
  run.controller.abort();
  assert.equal(run.count('interrupt'), 1);
  run.ws.emit({ type: interrupted.type, data: interrupted.data });
  const result = await run.promise;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'image_cancelled');
  assert.equal(result.interruptSettled, true);
  assert.equal(result.png, null);
  assert.equal(run.count('interrupt'), 1);
  assert.equal(run.calls.find((call) => call.route === 'interrupt').method, 'POST');
});

test('abort with no interrupted event settles after the grace period', async (t) => {
  const run = startRun(t, { promptId: 'prompt-1' });
  await run.queued();
  run.controller.abort();
  const result = await run.promise;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'image_cancelled');
  assert.equal(result.interruptSettled, false);
  assert.equal(run.count('interrupt'), 1);
});

test('the deadline interrupts and settles as timeout', async (t) => {
  const { events } = fixture('minimax-cancel-events');
  const id = promptIdOf(events);
  const interrupted = events.find((event) => event.type === 'execution_interrupted');
  let run;
  const answer = () => {
    setImmediate(() => run.ws.emit({ type: interrupted.type, data: interrupted.data }));
    return { status: 200, body: {} };
  };
  run = startRun(t, { promptId: id, options: { deadlineMs: 20 }, routes: { interrupt: answer } });
  await run.queued();
  const result = await run.promise;
  assert.equal(result.status, 'timeout');
  assert.equal(result.reason, 'image_timeout');
  assert.equal(result.interruptSettled, true);
  assert.equal(run.count('interrupt'), 1);

  const silent = startRun(t, { promptId: id, options: { deadlineMs: 10 } });
  await silent.queued();
  const second = await silent.promise;
  assert.deepEqual([second.status, second.interruptSettled], ['timeout', false]);
});

test('a success that races in after the interrupt still settles cancelled, with the file removed', async (t) => {
  const id = 'prompt-1';
  let run;
  const answer = () => {
    setImmediate(() => { for (const event of syntheticEvents(id, goodImage).slice(1)) run.ws.emit(event); });
    return { status: 200, body: {} };
  };
  run = startRun(t, { promptId: id, routes: { interrupt: answer } });
  writePng(run, 'jenny_00001_.png');
  await run.queued();
  run.ws.emit({ type: 'executed', data: { node: '9', prompt_id: id, output: { images: [goodImage] } } });
  run.controller.abort();
  const result = await run.promise;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.png, null);
  assert.equal(result.interruptSettled, true);
  assert.equal(fs.existsSync(path.join(run.outputDir, 'jenny_00001_.png')), false);
});

test('an abort while the prompt is being queued interrupts and settles at once', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const held = async () => { await gate; return { status: 200, body: { prompt_id: 'prompt-1' } }; };
  const run = startRun(t, { promptId: 'prompt-1', routes: { prompt: held } });
  run.ws.open();
  await until(() => run.count('prompt') > 0, 'POST /prompt');
  run.controller.abort();
  const result = await run.promise;
  release();
  assert.deepEqual([result.status, result.interruptSettled], ['cancelled', false]);
  assert.equal(run.count('interrupt'), 1);
});

test('an abort before the socket opens, or before the call, makes no network request', async (t) => {
  const run = startRun(t, { promptId: 'x' });
  run.controller.abort();
  const result = await run.promise;
  assert.deepEqual([result.status, result.reason], ['cancelled', 'image_cancelled']);
  assert.equal(run.calls.length, 0);

  const aborted = new AbortController();
  aborted.abort();
  const before = startRun(t, { promptId: 'x', options: { abortSignal: aborted.signal } });
  assert.equal((await before.promise).status, 'cancelled');
  assert.equal(before.SocketClass.instances.length + before.calls.length, 0);
});

test('the socket closing mid-run is a lost connection', async (t) => {
  const run = startRun(t, { promptId: 'prompt-1' });
  await run.queued();
  run.ws.emit({ type: 'execution_start', data: { prompt_id: 'prompt-1' } });
  run.ws.close();
  const result = await run.promise;
  assert.deepEqual([result.status, result.reason, result.stderrTail], ['failed', 'image_comfyui_failed', ['ComfyUI connection lost']]);
});

test('an interruption we did not ask for fails the job', async (t) => {
  const { events } = fixture('minimax-cancel-events');
  const id = promptIdOf(events);
  const run = startRun(t, { promptId: id });
  await run.queued();
  run.replay(events);
  const result = await run.promise;
  assert.deepEqual([result.status, result.stderrTail], ['failed', ['ComfyUI interrupted the job']]);
  assert.equal(run.count('interrupt'), 0);
});

test('events for another prompt, binary frames, junk and oversized messages are ignored', async (t) => {
  const { events } = fixture('minimax-run-events');
  const other = fixture('execution-error-events').events.find((event) => event.type === 'execution_error');
  const run = startRun(t, { promptId: promptIdOf(events) });
  writePng(run, 'jenny_00001_.png');
  await run.queued();
  run.ws.emit({ type: other.type, data: other.data });
  run.ws.emit('not json');
  run.ws.emit('{"type":"execution_error"}');
  run.ws.emit(`{"type":"execution_error","pad":"${'x'.repeat(1024 * 1024)}"}`);
  run.ws.fire('message', { data: Buffer.from('binary') });
  run.ws.fire('message', {});
  run.replay(events);
  assert.equal((await run.promise).status, 'ok');
});

test('events that arrive before the prompt reply are replayed once the id is known', async (t) => {
  const id = 'prompt-1';
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const held = async () => { await gate; return { status: 200, body: { prompt_id: id } }; };
  const run = startRun(t, { promptId: id, routes: { prompt: held } });
  writePng(run, 'jenny_00001_.png');
  run.ws.open();
  await until(() => run.count('prompt') > 0, 'POST /prompt');
  for (const event of syntheticEvents(id, goodImage)) run.ws.emit(event);
  run.ws.emit({ type: 'execution_error', data: { prompt_id: 'someone-else', node_type: 'X' } });
  release();
  assert.equal((await run.promise).status, 'ok');
});

test('without an executed image the output is looked up in /history', async (t) => {
  const id = 'prompt-1';
  const history = () => ({ status: 200, body: { [id]: { outputs: { 9: { images: [goodImage] } } } } });
  const run = startRun(t, { promptId: id, routes: { history } });
  writePng(run, 'jenny_00001_.png');
  await run.queued();
  run.ws.emit({ type: 'execution_success', data: { prompt_id: id } });
  const result = await run.promise;
  assert.equal(result.status, 'ok');
  assert.equal(run.count('history'), 1);
  assert.equal(fs.existsSync(path.join(run.outputDir, 'jenny_00001_.png')), false);

  const none = startRun(t, { promptId: id });
  await none.queued();
  none.ws.emit({ type: 'execution_success', data: { prompt_id: id } });
  const missing = await none.promise;
  assert.deepEqual([missing.status, missing.reason], ['failed', 'image_output_missing']);
});

test('hostile output entries are never read', async (t) => {
  const id = 'prompt-1';
  const attacks = [
    { ...goodImage, filename: '../x.png' }, { ...goodImage, filename: 'sub/x.png' }, { ...goodImage, filename: 'sub\\x.png' },
    { ...goodImage, filename: 'x.exe' }, { ...goodImage, filename: 'x.png.exe' }, { ...goodImage, subfolder: 'a' },
    { ...goodImage, type: 'temp' }, { ...goodImage, filename: 7 }, 'jenny_00001_.png',
  ];
  for (const image of attacks) {
    const run = startRun(t, { promptId: id });
    writePng(run, 'jenny_00001_.png');
    fs.mkdirSync(path.join(run.outputDir, 'sub'));
    await run.queued();
    for (const event of syntheticEvents(id, image)) run.ws.emit(event);
    const result = await run.promise;
    assert.deepEqual([result.status, result.reason, result.png], ['failed', 'image_output_invalid', null], JSON.stringify(image));
    assert.equal(fs.existsSync(path.join(run.outputDir, 'jenny_00001_.png')), true, 'the real file stays untouched');
  }
});

test('a symlinked output file is refused and its target is left alone', { skip: fileSymlinkSkip() }, async (t) => {
  const id = 'prompt-1';
  const run = startRun(t, { promptId: id });
  const target = path.join(os.tmpdir(), `jenny-comfy-target-${process.pid}.png`);
  fs.writeFileSync(target, png(64, 64));
  t.after(() => fs.rmSync(target, { force: true }));
  fs.symlinkSync(target, path.join(run.outputDir, 'jenny_00001_.png'), 'file');
  await run.queued();
  for (const event of syntheticEvents(id, goodImage)) run.ws.emit(event);
  const result = await run.promise;
  assert.deepEqual([result.status, result.reason, result.png], ['failed', 'image_output_invalid', null]);
  assert.equal(fs.existsSync(target), true);
});

test('an output entry that lstat reports as a link is refused even where real symlinks are unavailable', async (t) => {
  const id = 'prompt-1';
  const linked = Object.create(fs);
  linked.lstatSync = (target, ...rest) => {
    const stat = fs.lstatSync(target, ...rest);
    return path.basename(String(target)) === 'jenny_00001_.png' ? Object.create(stat, { isSymbolicLink: { value: () => true } }) : stat;
  };
  const run = startRun(t, { promptId: id, options: { fsImpl: linked } });
  writePng(run, 'jenny_00001_.png');
  await run.queued();
  for (const event of syntheticEvents(id, goodImage)) run.ws.emit(event);
  const result = await run.promise;
  assert.deepEqual([result.status, result.reason, result.png], ['failed', 'image_output_invalid', null]);
});

test('a missing, wrong-size, corrupt or directory output is a failed result', async (t) => {
  const id = 'prompt-1';
  const file = (run) => path.join(run.outputDir, 'jenny_00001_.png');
  const cases = [
    ['missing', () => {}, 'image_output_missing'],
    ['wrong size', (run) => writePng(run, 'jenny_00001_.png', 32, 32), 'image_output_mismatch'],
    ['corrupt', (run) => fs.writeFileSync(file(run), 'not a png'), 'image_output_invalid'],
    ['empty', (run) => fs.writeFileSync(file(run), ''), 'image_output_invalid'],
    ['directory', (run) => fs.mkdirSync(file(run)), 'image_output_invalid'],
  ];
  for (const [label, setup, reason] of cases) {
    const run = startRun(t, { promptId: id });
    setup(run);
    await run.queued();
    for (const event of syntheticEvents(id, goodImage)) run.ws.emit(event);
    const result = await run.promise;
    assert.deepEqual([result.status, result.reason, result.png], ['failed', reason, null], label);
  }
});

test('invalid options fail with image_invalid_params before any network call', async (t) => {
  const bad = {
    'a foreign host': { server: { baseUrl: 'http://example.com:8191' } },
    'a mismatched port': { server: { baseUrl: 'http://127.0.0.1:9999' } },
    'a non-integer port': { server: { port: 8191.5, baseUrl: 'http://127.0.0.1:8191.5' } },
    'a bad op id': { server: { opId: 'img_xyz' } },
    'a relative output dir': { server: { outputDir: 'relative/dir' } },
    'a missing output dir': { server: { outputDir: path.join(os.tmpdir(), 'jenny-comfy-does-not-exist') } },
    'a zero deadline': { options: { deadlineMs: 0 } },
    'a size outside the recipe': { params: { width: 100, height: 100 } },
    'a negative seed': { params: { seed: -1 } },
    'an empty prompt': { params: { prompt: '' } },
    'an empty loader name': { options: { loaderNames: { ...LOADERS, vae: '' } } },
  };
  for (const [label, overrides] of Object.entries(bad)) {
    const run = startRun(t, { promptId: 'x', ...overrides });
    const result = await run.promise;
    assert.deepEqual([result.status, result.reason], ['failed', 'image_invalid_params'], label);
    assert.equal(run.calls.length + run.SocketClass.instances.length, 0, label);
  }
});

test('no absolute path reaches stderrTail or the log', async (t) => {
  const id = 'prompt-1';
  const run = startRun(t, { promptId: id });
  await run.queued();
  run.ws.emit({ type: 'execution_error', data: { prompt_id: id, node_type: 'KSampler', exception_type: 'FileNotFoundError',
    exception_message: 'missing C:\\Users\\me\\models\\a.safetensors and /home/me/models/b.safetensors\u0007' } });
  const result = await run.promise;
  assert.equal(result.stderrTail[0], 'KSampler: FileNotFoundError: missing <path> and <path>');
  assert.doesNotMatch(JSON.stringify(run.logs), /Users|home/);
});

test('fillRecipeGraph fills the shipped recipe slots and leaves the locked settings alone', () => {
  const before = JSON.stringify(shipped);
  const graph = fillRecipeGraph(shipped, { loaderNames: LOADERS, prompt: 'a fox', width: 2304, height: 1792, seed: 4294967295 });
  assert.equal(graph['1'].inputs.unet_name, LOADERS.diffusion);
  assert.equal(graph['2'].inputs.clip_name, LOADERS.text_encoder);
  assert.equal(graph['3'].inputs.vae_name, LOADERS.vae);
  assert.equal(graph['5'].inputs.prompt, 'a fox');
  assert.equal(graph['5'].inputs.width, 2304);
  assert.equal(graph['5'].inputs.height, 1792);
  assert.equal(graph['7'].inputs.seed, 4294967295);
  assert.equal(graph['7'].inputs.steps, 6);
  assert.equal(graph['7'].inputs.cfg, 1);
  assert.equal(graph['7'].inputs.sampler_name, 'euler');
  assert.equal(JSON.stringify(shipped), before);
  assert.equal(shipped.graph['5'].inputs.prompt, '');
});

test('fillRecipeGraph rejects bad values and recipes with a broken slot', () => {
  const good = { loaderNames: LOADERS, prompt: 'a fox', width: 2048, height: 2048, seed: 1 };
  const refuses = (recipeValue, overrides = {}) => assert.throws(
    () => fillRecipeGraph(recipeValue, { ...good, ...overrides }), { message: 'image_invalid_params' });
  refuses(shipped, { width: 1024, height: 1024 });
  refuses(shipped, { width: 2048, height: 2047 });
  refuses(shipped, { seed: -1 });
  refuses(shipped, { seed: 4294967296 });
  refuses(shipped, { seed: 1.5 });
  refuses(shipped, { prompt: '' });
  refuses(shipped, { prompt: 'x'.repeat(4001) });
  refuses(shipped, { prompt: 'a\0b' });
  refuses(shipped, { loaderNames: { ...LOADERS, diffusion: '' } });
  refuses(shipped, { loaderNames: { ...LOADERS, vae: 'x'.repeat(1025) } });
  refuses(shipped, { loaderNames: { ...LOADERS, text_encoder: 'a\0b' } });
  refuses(shipped, { loaderNames: undefined });
  refuses({ ...shipped, slots: { ...shipped.slots, seed: ['99', 'seed'] } });
  refuses({ ...shipped, slots: { ...shipped.slots, seed: ['7', 'missing_input'] } });
  refuses({ ...shipped, slots: { ...shipped.slots, seed: ['__proto__', 'seed'] } });
  refuses({ ...shipped, slots: { ...shipped.slots, vae: undefined } });
  refuses(null);
});
