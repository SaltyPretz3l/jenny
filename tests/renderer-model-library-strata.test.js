'use strict';

// new-test-file: a new surface (row 200 D6): the Strata block of Settings > Models, its Engines-table row and its
// Library input. The merge and view cases live in model-library-merge.test.js and model-library-view-library.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createModelLibraryStrataController } = require('../renderer/shell/model-library/model-library-strata');
const { createModelLibraryEngineBlocks } = require('../renderer/shell/model-library/model-library-engine-blocks');
const servicesModule = require('../renderer/shell/model-library/model-library-services');

const COMMAND = 'strata launch --family inkling-2-mini --model SQ-20';
const GB = 1024 * 1024 * 1024;

async function flush() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fitsTable(overrides = {}) {
  const fits = {};
  for (const slots of [1, 2, 4]) for (const kv of ['auto', 'k8v8', 'k8v4']) fits[`${slots}:${kv}`] = { tokens: null, source: 'default' };
  return { ...fits, '1:auto': { tokens: 114432, source: 'measured' }, ...overrides };
}

function strataState(overrides = {}) {
  const { install = {}, setup = {}, packs = {}, progress = {}, manager = {}, settings = {}, model, ...rest } = overrides;
  return {
    eligible: true, reason: '', enabled: true,
    runtime: {
      enabled: true,
      install: { found: true, reason: '', version: '0.1.67', warnings: [], ...install },
      setup: { found: true, reason: '', ...setup },
      packs: { native: 'verified', vision: 'verified', ...packs },
      progress: { native: null, vision: null, ...progress },
      model: model === undefined ? { id: 'inkling-2-mini-sq-20', displayName: 'Inkling 2 Mini', aliases: ['inkling-2-mini'], paramsB: 26.4 } : model,
    },
    pins: { release: '0.2.21', terminal: '0.1.67', engine: '0.1.67' },
    manager: { state: 'stopped', phase: '', port: 0, alias: '', slots: 1, kv: 'auto', contextFit: 0, stoppedBy: '', watchdogWatts: 0, watchdogTempC: 0, identityRetained: false, lastError: '', lastErrorDetail: '', ...manager },
    settings: { slots: 1, kv: 'auto', context: null, vision: true, drafting: 'off', watchdog: { enabled: false, maxWatts: 460, maxTempC: 83 }, ...settings },
    fits: fitsTable(),
    ...rest,
  };
}

function harness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="strata"></div></body>', { url: 'http://localhost/' });
  const calls = [];
  const copied = [];
  const uses = [];
  let state = options.state === null ? null : strataState(options.state);
  let listener = null;
  const result = (name) => async (payload) => { calls.push(payload === undefined ? [name] : [name, payload]); return options.results?.[name] || { ok: true }; };
  const bridge = {
    async getState() { calls.push(['getState']); return options.ineligible ? { eligible: false, reason: 'strata_flag_off' } : state; },
    start: result('start'), stop: result('stop'), restart: result('restart'), reverify: result('reverify'), updateSettings: result('updateSettings'),
    onChanged(fn) { listener = fn; return () => { listener = null; }; },
  };
  dom.window.jennyShell = { strata: bridge };
  if (options.clipboard !== false) Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (text) => { copied.push(text); } }, configurable: true });
  const controller = createModelLibraryStrataController({
    windowRef: dom.window, documentRef: dom.window.document, hostId: 'strata',
    isEnabled: () => options.enabled !== false, onState: () => {}, onUse: (id) => uses.push(id),
  });
  t.after(() => controller.dispose());
  const doc = dom.window.document;
  return {
    dom, doc, calls, copied, uses, controller,
    text: () => doc.getElementById('strata').textContent,
    tone: () => doc.querySelector('.inv-status-row').dataset.statusTone,
    actions: () => [...doc.querySelectorAll('[data-strata-action]')].map((node) => node.dataset.strataAction),
    click: (action) => doc.querySelector(`[data-strata-action="${action}"]`).click(),
    setState: (next) => { state = strataState(next); },
    emit: () => { if (listener) listener({}); },
    mounted: async () => { controller.bind(); await flush(); },
    ipc: () => calls.filter((call) => call[0] !== 'getState'),
  };
}

test('flag off, kill switch and an ineligible state render nothing: no block, no row status, no Library input', async (t) => {
  for (const options of [{ ineligible: true }, { enabled: false }]) {
    const h = harness(t, options);
    await h.mounted();
    assert.equal(h.doc.getElementById('strata').innerHTML, '');
    assert.equal(h.controller.libraryInput(), null);
    assert.equal(h.controller.summary(), null);
  }
  const noBridge = harness(t);
  delete noBridge.dom.window.jennyShell.strata;
  assert.equal(noBridge.controller.summary(), null);
});

test('the Engines row summary: every 3.3 row, its text, tone and whether it counts as set up', async (t) => {
  const cases = [
    [null, 'Checking…', 'busy', true],
    [{ install: { found: false, reason: 'not_installed' } }, 'Not installed', 'off', false],
    [{ setup: { found: false, reason: 'no_setup_config' } }, 'Setup not found', 'off', true],
    [{ packs: { native: 'checking' }, progress: { native: { done: 25, total: 100 } } }, 'Checking the packs · 25%', 'busy', true],
    [{ packs: { native: 'checking', vision: 'checking' }, progress: { native: { done: 50, total: 100 }, vision: { done: 100, total: 300 } } }, 'Checking the packs · 37%', 'busy', true],
    [{ packs: { native: 'failed' } }, 'Inkling 2 Mini pack failed its check', 'warn', true],
    [{ packs: { native: 'missing' } }, 'Inkling 2 Mini pack failed its check', 'warn', true],
    [{ manager: { lastError: 'strata_blocked_by_windows' } }, 'Blocked by Windows', 'warn', true],
    [{ manager: { state: 'starting', phase: 'loading' } }, 'Starting… the first start can take a few minutes', 'busy', true],
    [{ manager: { state: 'stopping' } }, 'Stopping…', 'busy', true],
    [{ manager: { state: 'ready', port: 8035 } }, 'Serving on :8035', 'ready', true],
    [{ manager: { state: 'crashed', stoppedBy: 'watchdog' } }, 'Stopped by the power watchdog', 'warn', true],
    [{ manager: { state: 'crashed' } }, 'Stopped unexpectedly', 'warn', true],
    [{ manager: { lastError: 'strata_exited', lastErrorDetail: '1' } }, 'Could not start', 'warn', true],
    [{ install: { warnings: ['version_unpinned'], version: '0.1.70' } }, 'Ready · 0.1.70 (Jenny checked 0.1.67)', 'warn', true],
    [{}, 'Ready · 0.1.67', 'ready', true],
  ];
  for (const [state, text, tone, set] of cases) {
    const h = harness(t, state === null ? { state: null } : { state });
    if (state !== null) { h.controller.bind(); await flush(); }
    assert.deepEqual(h.controller.summary(), { text, tone, set }, text);
  }
  const unconfirmed = harness(t, { state: { manager: { lastError: 'stop_unconfirmed' } } });
  unconfirmed.controller.bind();
  await flush();
  assert.equal(unconfirmed.controller.summary().text, 'Ready · 0.1.67', 'a stop that could not be confirmed is not a could-not-start row');
});

test('not installed: the literal folder, the three steps with the release, the command, no Install button', async (t) => {
  const h = harness(t, { state: { install: { found: false, reason: 'not_installed', version: '' }, setup: { found: false, reason: 'no_setup_config' } } });
  await h.mounted();
  assert.match(h.text(), /Strata engine/);
  assert.match(h.text(), /Strata is an engine you install yourself/);
  assert.match(h.text(), /Not installed · Jenny looks in %LOCALAPPDATA%\\Strata/);
  assert.equal(h.tone(), 'default');
  const steps = [...h.doc.querySelectorAll('ol.strata-steps > li')].map((node) => node.textContent);
  assert.equal(steps.length, 3);
  assert.match(steps[0], /Install Strata 0\.2\.21 from its release page on github\.com \(Niko1221\/Strata\)\./);
  assert.match(steps[1], /about 20 GB/);
  assert.equal(h.doc.querySelector('.strata-command code').textContent, COMMAND);
  assert.equal(h.doc.querySelector('ol.strata-steps b').textContent, 'Check again');
  assert.deepEqual(h.actions(), ['copy', 'check-again']);
  assert.match(h.text(), /Jenny never installs Strata or downloads its files/);
  assert.equal(/install strata|download strata/i.test([...h.doc.querySelectorAll('button')].map((b) => b.textContent).join('|')), false, 'no Install button');
  h.click('check-again');
  await flush();
  assert.deepEqual(h.ipc(), [['reverify']]);
});

test('install found but no setup: steps 2-3 only; a broken install names the short reason, an unknown one an unexpected layout', async (t) => {
  for (const reason of ['no_setup_config', 'setup_config_invalid']) {
    const h = harness(t, { state: { setup: { found: false, reason } } });
    await h.mounted();
    assert.match(h.text(), /Strata is installed, but the Inkling 2 Mini setup was not found\./);
    assert.equal(h.doc.querySelectorAll('ol.strata-steps > li').length, 2);
    assert.equal(h.text().includes('Install Strata'), false);
    assert.equal(h.text().includes('Not installed'), false);
  }
  const words = { link_refused: 'a linked folder', no_terminal: 'no Terminal folder', no_python: 'no Python', no_engine: 'no Inkling engine', something_new: 'an unexpected layout' };
  for (const [reason, word] of Object.entries(words)) {
    const h = harness(t, { state: { install: { found: false, reason } } });
    await h.mounted();
    assert.match(h.text(), new RegExp(`Strata was found but looks incomplete \\(${word}\\)\\. Reinstall it, then press Check again\\.`), reason);
    assert.equal(h.doc.querySelector('ol.strata-steps'), null);
    assert.deepEqual(h.actions(), ['check-again']);
  }
  const other = harness(t, { state: { setup: { found: false, reason: 'link_refused' } } });
  await other.mounted();
  assert.match(other.text(), /incomplete \(a linked folder\)/);
  // Before main's first install probe answers, install and setup read found:false, reason 'unknown': still checking.
  for (const state of [{ install: { found: false, reason: 'unknown' } }, { setup: { found: false, reason: 'unknown' } }]) {
    const early = harness(t, { state });
    await early.mounted();
    assert.match(early.text(), /Checking…/);
    assert.equal(early.text().includes('incomplete'), false);
    assert.equal(early.controller.summary().text, 'Checking…');
  }
});

test('the first pack check: a progress bar with sizes, the check-once note, no Cancel; no progress yet reads without numbers', async (t) => {
  const h = harness(t, { state: { packs: { native: 'checking' }, progress: { native: { done: 5 * GB, total: 19 * GB } } } });
  await h.mounted();
  assert.equal(h.tone(), 'pending');
  assert.match(h.text(), /Checking the packs · 5 GB of 19 GB/);
  const bar = h.doc.querySelector('[role="progressbar"]');
  assert.equal(bar.getAttribute('aria-label'), 'Pack check');
  assert.equal(bar.getAttribute('aria-valuenow'), String(5 * GB));
  assert.equal(bar.getAttribute('aria-valuemax'), String(19 * GB));
  assert.match(h.text(), /Once per pack\. Later starts skip it while the files are unchanged\./);
  assert.deepEqual(h.actions(), [], 'main has no cancel, so the button is omitted');
  const none = harness(t, { state: { packs: { native: 'checking' } } });
  await none.mounted();
  assert.match(none.text(), /Checking the packs…/);
  assert.equal(none.doc.querySelector('[role="progressbar"]'), null);
});

test('a failed or missing native pack is danger with Check again and Copy command; a vision-only failure is a warning, not a refusal', async (t) => {
  const failed = harness(t, { state: { packs: { native: 'failed' } } });
  await failed.mounted();
  assert.equal(failed.tone(), 'danger');
  assert.match(failed.text(), /Inkling-2-Mini-SQ-20\.strata does not match the fingerprint Jenny was built with\./);
  assert.match(failed.text(), /The image pack is fine\. Nothing was changed\./);
  assert.deepEqual(failed.actions(), ['check-again', 'copy']);
  assert.equal(failed.doc.querySelector('[data-strata-action="copy"]').textContent.trim(), 'Copy command');
  const missing = harness(t, { state: { packs: { native: 'missing', vision: 'missing' } } });
  await missing.mounted();
  assert.match(missing.text(), /Inkling-2-Mini-SQ-20\.strata was not found where Strata's setup says it is\./);
  assert.equal(missing.text().includes('The image pack is fine'), false);
  const visionOnly = harness(t, { state: { packs: { vision: 'failed' } } });
  await visionOnly.mounted();
  assert.equal(visionOnly.tone(), 'success');
  assert.match(visionOnly.text(), /Ready · Strata 0\.1\.67 · Inkling 2 Mini checked \(no image pack\)/);
  assert.match(visionOnly.text(), /The image pack \(Inkling-2-Mini-Vision\.strata\) did not pass its check, so images are off\./);
  const pack = harness(t, { state: { manager: { lastError: 'strata_pack', lastErrorDetail: 'sha256_mismatch' } } });
  await pack.mounted();
  assert.equal(pack.tone(), 'danger');
  assert.equal(pack.text().includes('sha256_mismatch'), false, 'no raw detail');
});

test('blocked by Windows: danger, three steps, Try again restarts, never Strata\'s raw text', async (t) => {
  const h = harness(t, { state: { manager: { lastError: 'strata_blocked_by_windows', lastErrorDetail: 'access_denied' } } });
  await h.mounted();
  assert.equal(h.tone(), 'danger');
  assert.match(h.text(), /Windows blocked the Strata engine\./);
  assert.equal(h.doc.querySelectorAll('ol.strata-steps > li').length, 3);
  assert.match(h.doc.querySelector('ol.strata-steps').textContent, /strata-inkling\.exe/);
  assert.equal(h.text().includes('access_denied'), false);
  assert.deepEqual(h.actions(), ['try-again']);
  h.click('try-again');
  await flush();
  assert.deepEqual(h.ipc(), [['restart']]);
});

test('Stop stays live while a Try again waits on its start; other actions wait', async (t) => {
  const h = harness(t, { state: { manager: { lastError: 'strata_readiness_timeout' } } });
  await h.mounted();
  h.dom.window.jennyShell.strata.restart = () => { h.calls.push(['restart']); return new Promise(() => {}); };
  h.setState({ manager: { state: 'starting', phase: 'loading' } });
  h.click('try-again');
  await flush();
  await h.controller.refresh();
  assert.deepEqual(h.actions(), ['stop']);
  assert.equal(h.doc.querySelector('[data-strata-action="stop"]').disabled, false);
  h.click('stop');
  await flush();
  assert.deepEqual(h.ipc(), [['restart'], ['stop']]);
});

test('starting (verifying and loading), stopping, ready, the version warning and the lease note', async (t) => {
  const verifying = harness(t, { state: { manager: { state: 'starting', phase: 'verifying' }, packs: { native: 'checking' }, progress: { native: { done: 1 * GB, total: 19 * GB } } } });
  await verifying.mounted();
  assert.equal(verifying.tone(), 'pending');
  assert.match(verifying.text(), /Checking the packs before the start…/);
  const loading = harness(t, { state: { manager: { state: 'starting', phase: 'loading' } } });
  await loading.mounted();
  assert.match(loading.text(), /Starting Inkling 2 Mini · the first start can take a few minutes while Strata reads 19 GB from disk/);
  assert.match(loading.text(), /Chats keep working on your other models meanwhile\./);
  assert.match(loading.text(), /While Jenny runs Strata, Strata's own update and calibrate wait until Jenny stops it\./);
  assert.deepEqual([...loading.doc.querySelectorAll('.strata-lease b')].map((node) => node.textContent), ['update', 'calibrate']);
  assert.deepEqual(loading.actions(), ['stop']);
  const stopping = harness(t, { state: { manager: { state: 'stopping' } } });
  await stopping.mounted();
  assert.match(stopping.text(), /Stopping Strata…/);
  assert.deepEqual(stopping.actions(), []);
  const ready = harness(t, { state: { manager: { state: 'ready', port: 8035 } } });
  await ready.mounted();
  assert.equal(ready.tone(), 'success');
  assert.match(ready.text(), /Ready · Strata 0\.1\.67 · serving Inkling 2 Mini on :8035/);
  assert.deepEqual(ready.actions().sort(), ['reverify', 'stop']);
  assert.ok(ready.doc.querySelector('#strataWatchdogEnabled, [data-inv-toggle="strataWatchdogEnabled"]'), 'the watchdog shows while ready');
  const idle = harness(t, { state: {} });
  await idle.mounted();
  assert.equal(idle.tone(), 'success');
  assert.match(idle.text(), /Ready · Strata 0\.1\.67 · Inkling 2 Mini and its image pack checked/);
  assert.equal(idle.text().includes('update and calibrate'), false, 'the lease note is for starting and ready only');
  const warned = harness(t, { state: { install: { version: '0.1.70', warnings: ['engine_version_unpinned'] }, manager: { state: 'ready', port: 8035 } } });
  await warned.mounted();
  assert.equal(warned.tone(), 'warning');
  assert.match(warned.text(), /Strata 0\.1\.70 found\. Jenny was checked with 0\.1\.67; it should still work\. If chats fail, go back to 0\.1\.67 in Strata\./);
});

test('crashed and the power watchdog: Restart now restarts; the watchdog wording carries watts and temperature', async (t) => {
  const crashed = harness(t, { state: { manager: { state: 'crashed' } } });
  await crashed.mounted();
  assert.equal(crashed.tone(), 'danger');
  assert.match(crashed.text(), /Ready · Strata 0\.1\.67 · stopped unexpectedly\. It restarts with your next message\./);
  assert.deepEqual(crashed.actions(), ['restart']);
  assert.equal(crashed.doc.querySelector('[data-strata-action="restart"]').textContent.trim(), 'Restart now');
  crashed.click('restart');
  await flush();
  assert.deepEqual(crashed.ipc(), [['restart']]);
  const dog = harness(t, { state: { manager: { state: 'crashed', stoppedBy: 'watchdog', watchdogWatts: 512, watchdogTempC: 84 } } });
  await dog.mounted();
  assert.match(dog.text(), /Stopped by the power watchdog \(512 W, 84 °C\)\. Restart it once the card has cooled\./);
});

test('every lastError maps to its own sentence; Try again except after an unconfirmed stop; the fallback is 80 characters', async (t) => {
  const cases = [
    [{ lastError: 'strata_port_busy' }, /Another program is using port 8035\. Close it, then press Try again\./, true],
    [{ lastError: 'strata_port_busy', port: 9000 }, /using port 9000/, true],
    [{ lastError: 'strata_readiness_timeout' }, /Strata did not finish starting in time\. Press Try again; the second start is usually faster\./, true],
    [{ lastError: 'strata_exited', lastErrorDetail: '3' }, /Strata stopped while starting \(code 3\)\. Its log is in Jenny's logs folder\./, true],
    [{ lastError: 'vram_in_use' }, /Other programs are using the GPU memory Strata needs\./, true],
    [{ lastError: 'stop_unconfirmed' }, /The last stop could not be confirmed\. Restart Jenny if Strata stays stuck\./, false],
    [{ lastError: 'strata_orphan_cleanup_unconfirmed' }, /The last stop could not be confirmed\./, false],
    [{ lastError: 'llama_server_stop_unconfirmed' }, /The last stop could not be confirmed\./, false],
    [{ lastError: 'strata_weird', lastErrorDetail: 'x'.repeat(120) }, new RegExp(`Strata could not start · strata_weird:x{${80 - 'strata_weird:'.length}}$`), true],
  ];
  for (const [manager, pattern, retry] of cases) {
    const h = harness(t, { state: { manager } });
    await h.mounted();
    assert.equal(h.tone(), 'warning', manager.lastError);
    assert.match(h.doc.querySelector('.inv-status-row').textContent, pattern, manager.lastError);
    assert.deepEqual(h.actions().filter((id) => id === 'try-again'), retry ? ['try-again'] : [], manager.lastError);
  }
});

test('an action that fails writes its own sentence beside the buttons, never the reason; a thrown call too', async (t) => {
  const h = harness(t, { state: { manager: { state: 'crashed' } }, results: { restart: { ok: false, reason: 'strata_secret_reason' } } });
  await h.mounted();
  h.click('restart');
  await flush();
  assert.match(h.doc.querySelector('[aria-live="polite"]').textContent, /^Strata could not be restarted\.$/);
  assert.equal(h.text().includes('strata_secret_reason'), false);
  const stop = harness(t, { state: { manager: { state: 'ready', port: 8035 } }, results: { stop: { ok: false, reason: 'x' } } });
  await stop.mounted();
  stop.click('stop');
  await flush();
  assert.deepEqual(stop.ipc(), [['stop']]);
  assert.equal(stop.doc.querySelector('[aria-live="polite"]').textContent, 'That did not work. Try again.');
  stop.dom.window.jennyShell.strata.reverify = async () => { throw new Error('boom'); };
  stop.click('reverify');
  await flush();
  assert.equal(stop.doc.querySelector('[aria-live="polite"]').textContent, 'That did not work. Try again.');
});

test('Copy puts the command on the clipboard with no IPC call and says Copied for a moment', async (t) => {
  const h = harness(t, { state: { install: { found: false, reason: 'not_installed' } } });
  await h.mounted();
  h.click('copy');
  await flush();
  assert.deepEqual(h.copied, [COMMAND]);
  assert.deepEqual(h.ipc(), [], 'Copy makes no IPC call');
  assert.match(h.text(), /Copied/);
  const none = harness(t, { state: { install: { found: false, reason: 'not_installed' } }, clipboard: false });
  await none.mounted();
  none.click('copy');
  await flush();
  assert.deepEqual(none.ipc(), []);
});

test('the watchdog: the toggle and each limit send updateSettings({ watchdog }) with the bounds applied; a refusal says so', async (t) => {
  const h = harness(t, { state: { manager: { state: 'ready', port: 8035 } } });
  await h.mounted();
  const toggle = h.doc.querySelector('[data-inv-toggle="strataWatchdogEnabled"]');
  toggle.dispatchEvent(new h.dom.window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id: 'strataWatchdogEnabled', checked: true } }));
  await flush();
  assert.deepEqual(h.ipc(), [['updateSettings', { watchdog: { enabled: true, maxWatts: 460, maxTempC: 83 } }]]);
  h.calls.length = 0;
  const watts = h.doc.querySelector('[data-strata-field="watchdog-watts"]');
  watts.value = '5000';
  watts.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(h.ipc(), [['updateSettings', { watchdog: { enabled: false, maxWatts: 1000, maxTempC: 83 } }]]);
  h.calls.length = 0;
  const temp = h.doc.querySelector('[data-strata-field="watchdog-temp"]');
  temp.value = '90';
  temp.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(h.ipc(), [['updateSettings', { watchdog: { enabled: false, maxWatts: 460, maxTempC: 90 } }]]);
  const refused = harness(t, { state: { manager: { state: 'ready', port: 8035 } }, results: { updateSettings: { ok: false, reason: 'invalid_payload' } } });
  await refused.mounted();
  refused.doc.querySelector('[data-inv-toggle="strataWatchdogEnabled"]').dispatchEvent(new refused.dom.window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id: 'strataWatchdogEnabled', checked: true } }));
  await flush();
  assert.equal(refused.doc.querySelector('[aria-live="polite"]').textContent, 'The watchdog setting could not be saved.');
});

test('one getState is in flight at a time and a change event while it runs re-reads once after', async (t) => {
  const h = harness(t);
  let release;
  let reads = 0;
  h.dom.window.jennyShell.strata.getState = () => { reads += 1; return new Promise((resolve) => { release = () => resolve(strataState()); }); };
  const first = h.controller.refresh();
  h.controller.refresh();
  h.controller.refresh();
  await flush();
  assert.equal(reads, 1);
  release();
  await flush();
  assert.equal(reads, 2, 'the queued re-read ran once');
  release();
  await first;
  assert.equal(reads, 2);
});

test('libraryInput: the model facts, the context from the fit table, the pinned pack sizes, the locks; null until install and setup are found', async (t) => {
  const h = harness(t, { state: { manager: { state: 'ready', port: 8035, alias: 'inkling-2-mini-sq-20', contextFit: 0 } } });
  await h.mounted();
  const input = h.controller.libraryInput();
  assert.equal(input.id, 'inkling-2-mini-sq-20');
  assert.equal(input.displayName, 'Inkling 2 Mini');
  assert.equal(input.params, '26.4B');
  assert.equal(input.quant, 'SQ-20');
  assert.equal(input.contextLength, 114432, 'the fit of the saved pairing');
  assert.equal(input.sizeBytes, 19346685952 + 636526592);
  assert.equal(input.manager.state, 'ready');
  assert.equal(input.lock, null);
  assert.equal('vramRequiredMb' in input, false);
  h.setState({ manager: { contextFit: 90000 } });
  await h.controller.refresh();
  assert.equal(h.controller.libraryInput().contextLength, 90000, 'the measured fit wins');
  h.setState({ model: null });
  await h.controller.refresh();
  assert.equal(h.controller.libraryInput(), null, 'no row without the model main names');
  for (const state of [{ install: { found: false, reason: 'not_installed' } }, { setup: { found: false, reason: 'no_setup_config' } }]) {
    h.setState(state);
    await h.controller.refresh();
    assert.equal(h.controller.libraryInput(), null);
  }
  h.setState({ packs: { native: 'failed' } });
  await h.controller.refresh();
  assert.deepEqual(h.controller.libraryInput().lock, { kind: 'pack', message: 'the SQ-20 pack failed its check. See Engines and providers.' });
  h.setState({ packs: { native: 'missing' } });
  await h.controller.refresh();
  assert.equal(h.controller.libraryInput().lock.kind, 'pack');
  h.setState({ manager: { lastError: 'strata_blocked_by_windows' } });
  await h.controller.refresh();
  assert.deepEqual(h.controller.libraryInput().lock, { kind: 'blocked', message: 'Windows blocked the engine. See Engines and providers.' });
});

// --- the Engines and providers row (engine blocks) ---

function engineHarness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="modelServicesHost"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  const doc = dom.window.document;
  const services = servicesModule.createModelLibraryServices({ documentRef: doc, windowRef: dom.window });
  const calls = [];
  let state = strataState(options.state);
  dom.window.jennyShell = {
    strata: {
      async getState() { calls.push('getState'); return options.ineligible ? { eligible: false, reason: 'strata_flag_off' } : state; },
      onChanged() { calls.push('subscribe'); return () => calls.push('unsubscribe'); },
    },
  };
  const states = [];
  const blocks = createModelLibraryEngineBlocks({
    windowRef: dom.window, documentRef: doc, imageEngineEnabled: () => false, ninferEnabled: () => false, llamaServerEnabled: () => false,
    strataEnabled: () => options.enabled !== false, strata: { onState: () => states.push(1), onUse: () => {} }, services: () => services,
  });
  t.after(() => { blocks.dispose(); services.dispose(); });
  const row = () => doc.querySelector('[data-service-id="strata"]');
  return { dom, doc, services, blocks, calls, states, row, setState: (next) => { state = strataState(next); } };
}

test('engine blocks: Strata registers one chat row behind its flag; ineligible or off draws nothing; the drawer holds the block', async (t) => {
  const h = engineHarness(t);
  h.blocks.render();
  await flush();
  assert.ok(h.row());
  assert.equal(h.row().querySelector('.mrow-name').textContent, 'Strata');
  assert.equal(h.row().querySelector('.mrow-meta').textContent, 'Runs Inkling 2 Mini from your own Strata install');
  assert.equal(h.row().querySelector('.srow-status').textContent.trim(), 'Ready · 0.1.67');
  assert.equal(h.row().querySelector('button').textContent.trim(), 'Manage');
  assert.ok(h.states.length > 0, 'the library is told when the state arrives');
  h.services.open('strata', h.row().querySelector('button'));
  assert.match(h.services.drawerBody().textContent, /Strata engine/);
  assert.ok(h.services.drawerBody().querySelector('#modelLibraryStrataHost'));
  const off = engineHarness(t, { enabled: false });
  off.blocks.render();
  await flush();
  assert.equal(off.row(), null);
  assert.equal(off.calls.includes('getState'), false, 'a disabled block never reads');
  const ineligible = engineHarness(t, { ineligible: true });
  ineligible.blocks.render();
  await flush();
  assert.equal(ineligible.row(), null);
});

test('engine blocks: not installed keeps the row with Set up…, and a change event moves it to Manage', async (t) => {
  const h = engineHarness(t, { state: { install: { found: false, reason: 'not_installed' } } });
  h.blocks.render();
  await flush();
  assert.equal(h.row().querySelector('.srow-status').textContent.trim(), 'Not installed');
  assert.equal(h.row().querySelector('button').textContent.trim(), 'Set up…');
  assert.equal(h.row().querySelector('.mp-dot').dataset.tone, 'off');
  h.setState({});
  await h.blocks.strata().refresh();
  assert.equal(h.row().querySelector('button').textContent.trim(), 'Manage');
  h.blocks.dispose();
  assert.equal(h.calls.includes('unsubscribe'), true, 'the row listener ends with the blocks');
});

// --- the Models section wiring ---

const { createModelLibrarySectionController } = require('../renderer/shell/renderer-settings-model-library-section');

const ROW_KEY = 'inkling-2-mini-sq-20:latest';

function sectionHarness(t, { flag = true, state: stateOverrides = {}, ineligible = false, listed = [] } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <nav class="settings-nav"><button data-settings-section="models">Models</button></nav>
    <section class="settings-card settings-section-active" data-settings-section="models">
      <div class="settings-card-header"><h3>Models</h3></div>
      <div id="modelLibrarySectionToolbarHost"></div>
      <div class="settings-note model-library-section-status" aria-live="polite"></div>
      <div id="modelLibrarySectionHost"></div>
    </section></body>`, { pretendToBeVisual: true, url: 'http://localhost/' });
  const { window: windowRef } = dom;
  const calls = [];
  const state = { features: { featureFlags: { strata: flag } }, status: { model: '' }, offline: { preferredLocalModel: '' }, ui: { activeSettingsSection: 'models' } };
  windowRef.jennyShell = {
    models: {
      async list() { return { data: listed }; },
      async listOllamaTags() { return { data: [] }; },
      async load(payload) { calls.push(['load', payload]); return { status: 'ok', model: payload.model }; },
      async unload() { return { status: 'ok', model: '' }; },
    },
    offline: {
      async getDiagnostics() { return { hardwareProfile: { gpu: { type: 'cuda', name: 'NVIDIA GeForce RTX 5090', vram_mb: 32607 } }, memory: { totalMb: 65536, availableMb: 40000 }, modelRecommendations: [], catalogMeta: null }; },
      async updateSettings(payload) { return payload; },
    },
    engines: { async updateSettings(payload) { return { localEngines: { openaiCompatible: { managed: payload.managed } } }; } },
    llamaServer: { async listLocalGgufs() { return { ok: true, entries: [] }; }, async getStatus() { return { ok: true, state: 'stopped' }; } },
    features: { onChanged() { return () => {}; } },
    strata: {
      async getState() { return ineligible ? { eligible: false, reason: 'strata_flag_off' } : strataState(stateOverrides); },
      onChanged() { return () => {}; },
    },
  };
  const controller = createModelLibrarySectionController({
    state, windowRef, documentRef: windowRef.document,
    appendClientLog: () => {}, refreshModelPickers: async () => {}, openModelTuning: (...args) => calls.push(['tune', ...args]), openDiagnostics: () => {},
    setupService: { subscribePullProgress() { return () => {}; }, async startOllamaPull() { return {}; }, async cancelOllamaPull() { return {}; } },
    inventoryContextMenu: { show() {}, hide() {} },
  });
  t.after(() => controller.dispose());
  const row = () => windowRef.document.querySelector(`.mrow[data-model-key="${ROW_KEY}"]`);
  const click = (node) => node.dispatchEvent(new windowRef.MouseEvent('click', { bubbles: true }));
  return { controller, windowRef, document: windowRef.document, calls, row, click };
}

test('section: behind the flag the Inkling row joins the Library once, Load loads its id and Tune carries the Strata hint', async (t) => {
  const h = sectionHarness(t, { listed: [{ id: 'inkling-2-mini-sq-20', managed: 'strata', engine_type: 'openai-compatible' }] });
  h.controller.bind();
  await flush();
  await flush();
  assert.equal(h.document.querySelectorAll(`.mrow[data-model-key="${ROW_KEY}"]`).length, 1, 'the engine model list entry is not a second card');
  assert.equal(h.document.querySelectorAll('.mrow').length, 1);
  assert.match(h.row().querySelector('.mrow-meta').textContent, /^Strata · 26\.4B · SQ-20 · 111\.8K context · 18\.6 GB on disk$/);
  h.click(h.row().querySelector('[data-model-card-action="use"]'));
  await flush();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'load'), [['load', { model: 'inkling-2-mini-sq-20', engine_type: 'openai-compatible' }]], 'Load is the library\'s own; the renderer never starts Strata');
  h.click(h.row().querySelector('[data-model-card-action="tune"]'));
  const tune = h.calls.find((call) => call[0] === 'tune');
  assert.equal(tune[1], 'inkling-2-mini-sq-20');
  assert.equal(tune[3].engineTypeHint, 'openai-compatible');
  assert.deepEqual(tune[3].strata, { modelId: 'inkling-2-mini-sq-20' });
  assert.equal(tune[3].ninfer, null);
});

test('section: a failed native pack greys the row with the reason; flag off and an ineligible state draw no row', async (t) => {
  const locked = sectionHarness(t, { state: { packs: { native: 'failed' } } });
  locked.controller.bind();
  await flush();
  await flush();
  assert.equal(locked.row().dataset.loadFailed, 'true');
  assert.equal(locked.row().querySelector('.model-card-note--failed').textContent, 'Strata: the SQ-20 pack failed its check. See Engines and providers.');
  const off = sectionHarness(t, { flag: false });
  off.controller.bind();
  await flush();
  assert.equal(off.row(), null);
  const ineligible = sectionHarness(t, { ineligible: true });
  ineligible.controller.bind();
  await flush();
  await flush();
  assert.equal(ineligible.row(), null, 'zero Strata DOM on an ineligible state');
});

test('engine blocks in the browser: before the lazy Strata module loads, Monaco\'s throwing require yields no block, not an error', () => {
  // S3 dry run (step 7): the renderer logged "Synchronous require cannot resolve module './model-library-strata'".
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'shell', 'model-library', 'model-library-engine-blocks.js'), 'utf8');
  const sandbox = { require() { throw new Error('Check dependency list! Synchronous require cannot resolve module'); } };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  const blocks = sandbox.modelLibraryEngineBlocks.createModelLibraryEngineBlocks({ strataEnabled: () => true, windowRef: sandbox });
  assert.equal(blocks.strata(), null);
  sandbox.modelLibraryStrata = { createModelLibraryStrataController: () => ({ dispose() {} }) };
  assert.ok(blocks.strata(), 'once the Settings manifest loads it, the block is created');
});
