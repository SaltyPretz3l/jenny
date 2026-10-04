'use strict';

/* PTY-terminal (xterm) bottom-panel wiring tests. xterm cannot run under jsdom,
 * so the panel injects createTerminal/createFitAddon fakes (plain objects that
 * record calls). These tests assert only the WIRING between the injected terminal,
 * the workspacePty bridge, and the panel lifecycle — never real terminal rendering.
 * Uses the shared jsdom harness only for a real window (ResizeObserver shim). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, settle } = require('./helpers/renderer-ide-harness');
const { fakeTerminal, fakePtyApi, buildPanel } = require('./helpers/pty-terminal-panel-fixture');

test('constructing + rendering never auto-spawns (explicit start only)', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, api } = buildPanel(harness);
  panel.renderTerminalPanel();
  assert.equal(api.calls.spawn.length, 0, 'no spawn on hydrate/render');
  assert.equal(panel.isRunning(), false);
});

test('startSession fits before spawn, spawns measured dims, wires keystrokes and output', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, term, fit, api } = buildPanel(harness);
  panel.renderTerminalPanel();
  const order = [];
  const origFit = fit.fit.bind(fit);
  fit.fit = () => { order.push('fit'); origFit(); };
  const origSpawn = api.spawn.bind(api);
  api.spawn = (d) => { order.push('spawn'); return origSpawn(d); };

  await panel.startSession();

  assert.equal(order[0], 'fit', 'a fit runs first (measure the host)');
  assert.equal(order.indexOf('spawn'), 1, 'spawn follows the initial fit (fit-then-spawn)');
  assert.ok(order.indexOf('fit') < order.indexOf('spawn'), 'fit precedes spawn');
  assert.deepEqual(api.calls.spawn[0], { cols: 80, rows: 24 }, 'spawn got measured dims');
  assert.equal(term.opened !== null, true, 'terminal opened onto a mount element');
  assert.equal(panel.isRunning(), true);

  // User keystroke → api.write with the live session id.
  term._type('ls');
  assert.deepEqual(api.calls.write, [{ sessionId: 'pty-1', data: 'ls' }], 'keystroke forwarded to pty write');

  // Bridge data for this session → term.write; wrong-session ignored.
  api.emitData({ sessionId: 'pty-1', data: 'hello' });
  api.emitData({ sessionId: 'other', data: 'IGNORED' });
  assert.ok(term.written.includes('hello'), 'matching-session data written to term');
  assert.ok(!term.written.includes('IGNORED'), 'wrong-session data dropped');
});

// Gate N8: buildTheme maps no ANSI palette, so PowerShell's yellow command echo
// used xterm's dark-theme #e5e510/#f5f543 (1.0-1.2:1 on Day's #d4e0e3). The
// terminal asks xterm for an AA contrast floor against the live background.
test('the terminal is created with a WCAG AA minimum contrast ratio', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, term } = buildPanel(harness);
  panel.renderTerminalPanel();
  await panel.startSession();
  assert.equal(term.createOptions?.minimumContrastRatio, 4.5);
});

/* UIUX-035: aggregate output backpressure — a burst of output events arriving
 * within one animation frame must coalesce into a single term.write() call
 * (never one xterm reflow per IPC message), stay bounded under a hard byte
 * cap, and count+surface anything dropped. Uses the deferred-frame fixture so
 * the assertions are deterministic (no wall-clock, no real rAF). */

test('UIUX-035: a burst of output events within one frame coalesces into a single term.write() call', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, term, api, flushFrame, pendingFrames } = buildPanel(harness, { deferFrames: true });
  panel.renderTerminalPanel();
  await panel.startSession();
  term.written.length = 0;

  for (let i = 0; i < 200; i += 1) {
    api.emitData({ sessionId: 'pty-1', data: `row-${i}\n` });
  }
  // RED at HEAD: every emitData call reaches term.write() immediately (200
  // separate calls, no queue/frame at all) — there is no frame to flush.
  assert.equal(pendingFrames(), 1, 'one frame owns the whole producer burst');
  assert.equal(term.written.length, 0, 'nothing is written to xterm before the frame flushes');
  flushFrame();
  assert.equal(term.written.length, 1, 'the burst reaches xterm as exactly one coalesced write');
  assert.match(term.written[0], /row-0[\s\S]*row-199/, 'the coalesced write preserves arrival order');
});

test('UIUX-035: the write queue is hard-capped — a runaway burst drops the oldest bytes with a visible counted indicator', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, term, api, mount, flushFrame } = buildPanel(harness, { deferFrames: true });
  panel.renderTerminalPanel();
  await panel.startSession();
  term.written.length = 0;

  // 300KB of queued output — above the 256KB hard cap — sent before the
  // single coalescing frame ever gets to flush.
  const chunk = 'x'.repeat(10 * 1024); // 10KB
  for (let i = 0; i < 30; i += 1) {
    api.emitData({ sessionId: 'pty-1', data: chunk });
  }
  flushFrame();
  const writtenBytes = term.written.reduce((sum, s) => sum + s.length, 0);
  assert.ok(writtenBytes <= 256 * 1024, 'the coalesced write never exceeds the hard byte cap — no unbounded buffering');
  assert.ok(writtenBytes > 0, 'the most recent bytes still make it through (drop-oldest, not drop-everything)');
  const status = mount.querySelector('[data-ide-terminal-status]');
  assert.ok(Number(status.dataset.ptyWriteDroppedBytes) > 0, 'a counted dropped-bytes indicator is recorded');
  assert.match(status.textContent, /dropped/, 'the drop is surfaced visibly, never silent');
});

test('UIUX-035: dispose cancels a pending coalescing frame (no late write after teardown)', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, term, api, pendingFrames } = buildPanel(harness, { deferFrames: true });
  panel.renderTerminalPanel();
  await panel.startSession();
  term.written.length = 0;
  api.emitData({ sessionId: 'pty-1', data: 'queued-before-dispose' });
  assert.equal(pendingFrames(), 1, 'a frame is scheduled for the queued output');
  panel.dispose();
  assert.equal(pendingFrames(), 0, 'dispose cancels the pending coalescing frame');
  assert.ok(!term.written.includes('queued-before-dispose'), 'no late write reaches a disposed terminal');
});

test('UIUX-035: restart discards any not-yet-flushed queued output from the killed session', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount, term, api, flushFrame, pendingFrames } = buildPanel(harness, { deferFrames: true });
  panel.renderTerminalPanel();
  panel.bindEvents();
  await panel.startSession();
  term.written.length = 0;
  // Output from the about-to-be-killed session is queued but not yet flushed.
  api.emitData({ sessionId: 'pty-1', data: 'stale-from-old-session' });
  assert.equal(pendingFrames(), 1);

  api.spawn = async (dims) => {
    api.calls.spawn.push(dims);
    return { ok: true, sessionId: 'pty-2', shell: 'pwsh', cwd: 'C:/ws' };
  };
  mount.querySelector('[data-ide-terminal-action="restart"]').click();
  await settle();
  assert.equal(pendingFrames(), 0, 'restart cancels the stale frame, it does not merely wait for it');

  api.emitData({ sessionId: 'pty-2', data: 'fresh-from-new-session' });
  flushFrame();
  assert.ok(!term.written.some((chunk) => chunk.includes('stale-from-old-session')),
    'no leftover bytes from the killed session ever reach the fresh terminal');
  assert.ok(term.written.some((chunk) => chunk.includes('fresh-from-new-session')),
    'the new session writes normally after restart');
});

test('rapid Restart clicks stay single-flight while the old session kill is pending', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount, term, api } = buildPanel(harness);
  panel.renderTerminalPanel();
  panel.bindEvents();
  await panel.startSession();

  let resolveKill;
  api.kill = (payload) => {
    api.calls.kill.push(payload);
    return new Promise((resolve) => { resolveKill = resolve; });
  };
  api.spawn = async (dims) => {
    api.calls.spawn.push(dims);
    return { ok: true, sessionId: 'pty-2', shell: 'pwsh', cwd: 'C:/ws' };
  };
  const restart = mount.querySelector('[data-ide-terminal-action="restart"]');
  restart.click();
  restart.click();
  await Promise.resolve();

  assert.equal(api.calls.spawn.length, 1, 'no replacement starts until the single kill settles');
  resolveKill({ ok: true });
  await settle();

  assert.equal(api.calls.spawn.length, 2, 'exactly one replacement session starts');
  assert.equal(term.cleared, 1, 'the replacement session is never cleared by an older restart continuation');
  api.emitData({ sessionId: 'pty-2', data: 'replacement-output' });
  assert.ok(term.written.includes('replacement-output'));
});

test('^C toolbar action writes the interrupt byte', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount, api } = buildPanel(harness);
  panel.renderTerminalPanel();
  panel.bindEvents();
  await panel.startSession();
  api.calls.write.length = 0;
  mount.querySelector('[data-ide-terminal-action="signal"]').click();
  assert.deepEqual(api.calls.write, [{ sessionId: 'pty-1', data: '\x03' }], '^C sends the interrupt byte');
});

test('exit payload clears running and writes a session-ended status line', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, term, api } = buildPanel(harness);
  panel.renderTerminalPanel();
  await panel.startSession();
  api.emitExit({ sessionId: 'pty-1', exitCode: 0, signal: '' });
  assert.equal(panel.isRunning(), false, 'exit clears the session');
  assert.ok(term.writtenLines.some((l) => /session ended/.test(l)), 'a session-ended line is written');
});

test('exit banner ordering: data queued in the same frame writes BEFORE the "session ended" banner', async (t) => {
  // Regression: applyExitEvent wrote the exit banner synchronously via
  // term.writeln() while ordinary output goes through the rAF-coalesced
  // write queue (queueWrite/flushWriteQueue). Output queued in the same
  // frame as the exit therefore rendered AFTER the banner. The fix flushes
  // the pending write queue synchronously (cancelling the scheduled frame)
  // before the banner is written.
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, term, api, flushFrame, pendingFrames } = buildPanel(harness, { deferFrames: true });
  panel.renderTerminalPanel();
  await panel.startSession();
  term.written.length = 0;
  term.writtenLines.length = 0;

  const order = [];
  const origWrite = term.write.bind(term);
  const origWriteln = term.writeln.bind(term);
  term.write = (data) => { order.push('write'); origWrite(data); };
  term.writeln = (line) => { order.push('writeln'); origWriteln(line); };

  // Data queues into the coalesced write buffer; no frame has flushed yet.
  api.emitData({ sessionId: 'pty-1', data: 'trailing output\n' });
  assert.equal(pendingFrames(), 1, 'a coalescing frame is scheduled for the queued data');
  assert.equal(term.written.length, 0, 'the data has not reached xterm yet — still queued');

  // The exit arrives in the SAME frame, before the queued data's rAF fires.
  api.emitExit({ sessionId: 'pty-1', exitCode: 0 });

  assert.deepEqual(order, ['write', 'writeln'], 'the queued data flushes BEFORE the exit banner, not after');
  assert.match(term.written[0], /trailing output/, 'the queued data is flushed synchronously by the exit handler');
  assert.match(term.writtenLines[0], /session ended/, 'the exit banner follows the flushed data');
  assert.equal(pendingFrames(), 0, 'the now-redundant coalescing frame was canceled, not left to fire later');
});

test('a session-less spawn result (e.g. a stale {available:false}) surfaces one error without throwing', async (t) => {
  // The workspace_pty_terminal flag is retired (sweep S8): main never answers
  // {available:false} now, so the panel has no "not enabled" state; a result
  // without a session id still settles as one surfaced start failure.
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, errors, logs } = buildPanel(harness, { spawnResult: { available: false } });
  panel.renderTerminalPanel();
  await panel.startSession();
  assert.equal(panel.isRunning(), false);
  assert.equal(errors.length, 1, 'the failed start is surfaced once');
  assert.ok(logs.some((l) => l.level === 'WARN' && l.code === 'ide.pty_start_no_session'), 'a WARN diagnostic is logged');
});

test('{ok:false, code} spawn result surfaces the error', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, errors } = buildPanel(harness, {
    spawnResult: { ok: false, code: 'CMP-TERMINAL-0002', message: 'no root' },
  });
  panel.renderTerminalPanel();
  await panel.startSession();
  assert.equal(panel.isRunning(), false);
  assert.equal(errors.length, 1, 'the failure is surfaced');
});

test('dispose unsubscribes, disposes the term, and disconnects the observer', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, term, api, observers } = buildPanel(harness);
  panel.renderTerminalPanel();
  await panel.startSession();
  panel.dispose();
  assert.equal(api.unsubData, 1, 'onData unsubscribed');
  assert.equal(api.unsubExit, 1, 'onExit unsubscribed');
  assert.equal(term.disposed, 1, 'terminal disposed');
  assert.ok(observers.every((o) => o.disconnected >= 1), 'resize observer disconnected');
});

test('a second startSession while running does not spawn again', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, api } = buildPanel(harness);
  panel.renderTerminalPanel();
  await panel.startSession();
  await panel.startSession();
  assert.equal(api.calls.spawn.length, 1, 'exactly one spawn for a running session');
});

test('wide-033: dispose during delayed spawn kills the late session and rejects post-dispose wiring', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  let resolveSpawn;
  const api = fakePtyApi();
  api.spawn = (dims) => {
    api.calls.spawn.push(dims);
    return new Promise((resolve) => { resolveSpawn = resolve; });
  };
  const { panel, term } = buildPanel(harness, { api });
  panel.renderTerminalPanel();
  const start = panel.startSession();
  panel.dispose();
  resolveSpawn({ ok: true, sessionId: 'pty-late', shell: 'pwsh', cwd: 'C:/ws' });
  assert.equal(await start, false, 'a disposed panel never adopts the late session');
  assert.deepEqual(api.calls.kill, [{ sessionId: 'pty-late' }], 'the late-created session is terminated');
  assert.equal(api.calls.resize.length, 0, 'no post-dispose resize is installed');
  // UIUX-011: subscribeBridge now runs BEFORE spawn (not after), so the
  // subscription already exists by the time a mid-flight dispose() runs and
  // unsubscribes it — the fix for lost pre-ready output/exit requires exactly
  // this early subscribe, so these counts are now 1, not 0.
  assert.equal(api.unsubData, 1, 'the eager pre-spawn data subscription is torn down on dispose');
  assert.equal(api.unsubExit, 1, 'the eager pre-spawn exit subscription is torn down on dispose');
  assert.equal(term.disposed, 1);
  assert.equal(panel.isRunning(), false);
});

test('wide-033: a delayed spawn rejection after dispose stays silent and mutation-free', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  let rejectSpawn;
  const api = fakePtyApi();
  api.spawn = (dims) => {
    api.calls.spawn.push(dims);
    return new Promise((_resolve, reject) => { rejectSpawn = reject; });
  };
  const { panel, errors, logs } = buildPanel(harness, { api });
  panel.renderTerminalPanel();
  const start = panel.startSession();
  panel.dispose();
  rejectSpawn(new Error('bridge disposed'));
  assert.equal(await start, false);
  assert.equal(errors.length, 0, 'late rejection cannot surface a post-dispose toast');
  assert.equal(logs.length, 0, 'late rejection cannot emit a post-dispose diagnostic');
  assert.equal(panel.isRunning(), false);
});

/* UIUX-011: stale-marker reparent + ResizeObserver-follows-live-mount. */

test('UIUX-011: a stale marker after a sibling stomps the shared host is detected — terminal rebuilds, reparents xterm, and the ResizeObserver follows the live mount', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount, term, fit, api, observers } = buildPanel(harness);
  panel.renderTerminalPanel();
  await panel.startSession();
  const firstMountEl = term.opened;
  assert.ok(firstMountEl, 'xterm opened onto the first mount element');
  assert.equal(observers.length, 1, 'one ResizeObserver created');
  assert.equal(observers[0].observed, firstMountEl, 'the observer watches the first mount');
  const fitsBefore = fit.fits;

  // Simulate a sibling view (Problems/Run/Test Runner) replacing the SHARED
  // host's innerHTML the way renderer-ide-bottom-panel.js's other views do.
  // This destroys the xterm host child WITHOUT touching the JS-property
  // sentinel (__jennyIdePtyMarkup lives on the node object; innerHTML swaps
  // never clear it) — reproducing the UIUX-011 marker mismatch at HEAD.
  mount.innerHTML = '<div class="ide-prb">sibling content</div>';
  assert.equal(mount.querySelector('[data-ide-pty-mount]'), null, 'sibling wipe removed the xterm host');

  // Returning to Terminal must detect the missing mount and safely rebuild.
  // The fresh host measures differently, so the re-fit yields new dims (a
  // same-size re-fit sends no PTY resize; see the #11 tests below).
  fit.fit = () => { fit.fits += 1; term.cols = 100; };
  panel.renderTerminalPanel();
  assert.equal(mount.querySelector('.ide-prb'), null, 'sibling DOM is gone once Terminal re-renders (RED at HEAD: stays visible)');
  const secondMountEl = mount.querySelector('[data-ide-pty-mount]');
  assert.ok(secondMountEl, 'a fresh xterm host exists after rebuild');
  assert.equal(term.opened, secondMountEl, 'xterm reparented onto the fresh mount');
  assert.equal(observers.length, 1, 'the SAME ResizeObserver instance is reused (no leak)');
  assert.equal(observers[0].disconnected, 1, 'the stale observation was released before re-observing');
  assert.equal(observers[0].observed, secondMountEl, 'the ResizeObserver now follows the live mount (RED at HEAD: still the detached element)');
  assert.ok(fit.fits > fitsBefore, 'a fit re-measure occurs on remount/resize');
  assert.deepEqual(api.calls.resize, [{ sessionId: 'pty-1', cols: 100, rows: 24 }], 'a pty resize call is issued after remount (the running session is re-measured)');
});

test('UIUX-011: repeated Terminal/sibling cycles never duplicate mounts or leak ResizeObserver instances', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount, observers } = buildPanel(harness);
  panel.renderTerminalPanel();
  await panel.startSession();
  for (let i = 0; i < 5; i += 1) {
    mount.innerHTML = `<div class="ide-prb">cycle ${i}</div>`;
    panel.renderTerminalPanel();
    assert.equal(mount.querySelectorAll('[data-ide-pty-mount]').length, 1, 'exactly one xterm host after each cycle');
    assert.equal(mount.querySelector('.ide-prb'), null, `cycle ${i}: sibling DOM cleared on return`);
  }
  assert.equal(observers.length, 1, 'still one ResizeObserver instance after repeated cycles (no leak)');
  assert.equal(observers[0].observed, mount.querySelector('[data-ide-pty-mount]'), 'observer follows the final live mount');
});

/* UIUX-011: pre-ready event buffer (subscribe before spawn resolves). */

test('UIUX-011: immediate output emitted before spawn resolves is buffered and replayed once the session id is known', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  let resolveSpawn;
  const api = fakePtyApi();
  api.spawn = (dims) => {
    api.calls.spawn.push(dims);
    return new Promise((resolve) => { resolveSpawn = resolve; });
  };
  const { panel, term } = buildPanel(harness, { api });
  panel.renderTerminalPanel();
  const start = panel.startSession();
  // Main can wire + emit data the instant the pty is spawned, synchronously
  // inside its spawn() handler, BEFORE the IPC reply carrying sessionId is
  // even sent — so this can race ahead of the renderer learning its own
  // session id. RED at HEAD: subscribeBridge() only runs after `await spawn`
  // resolves, so no listener exists yet and this event is silently dropped.
  api.emitData({ sessionId: 'pty-1', data: 'immediate output' });
  resolveSpawn({ ok: true, sessionId: 'pty-1', shell: 'pwsh', cwd: 'C:/ws' });
  await start;
  assert.ok(term.written.includes('immediate output'), 'buffered pre-ready output replays once the session id is known');
  assert.equal(panel.isRunning(), true);
});

test('UIUX-011: exit emitted before spawn resolves settles the terminal to exited, never a false running state', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  let resolveSpawn;
  const api = fakePtyApi();
  api.spawn = (dims) => {
    api.calls.spawn.push(dims);
    return new Promise((resolve) => { resolveSpawn = resolve; });
  };
  const { panel, term } = buildPanel(harness, { api });
  panel.renderTerminalPanel();
  const start = panel.startSession();
  // RED at HEAD: the exit listener isn't installed until after spawn resolves,
  // so this event vanishes and the panel ends up isRunning()===true (a false
  // running state) even though the process already exited.
  api.emitExit({ sessionId: 'pty-1', exitCode: 0, signal: '' });
  resolveSpawn({ ok: true, sessionId: 'pty-1', shell: 'pwsh', cwd: 'C:/ws' });
  const result = await start;
  assert.equal(panel.isRunning(), false, 'exit-before-subscribe settles to not-running');
  assert.equal(result, false, 'startSession reports the session as not left running');
  assert.ok(term.writtenLines.some((l) => /session ended/.test(l)), 'a session-ended line is still written despite the race');
});

test('UIUX-011: a burst of pre-ready output beyond the buffer cap drops the oldest events with a visible counter, never grows unbounded', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  let resolveSpawn;
  const api = fakePtyApi();
  api.spawn = (dims) => {
    api.calls.spawn.push(dims);
    return new Promise((resolve) => { resolveSpawn = resolve; });
  };
  const { panel, term, logs } = buildPanel(harness, { api });
  panel.renderTerminalPanel();
  const start = panel.startSession();
  const total = 70; // beyond the 64-event bound
  for (let i = 0; i < total; i += 1) {
    api.emitData({ sessionId: 'pty-1', data: `x${i}` });
  }
  resolveSpawn({ ok: true, sessionId: 'pty-1', shell: 'pwsh', cwd: 'C:/ws' });
  await start;
  assert.equal(term.written.length, 64, 'only the bounded (most recent) events replay — the buffer never grows unbounded');
  assert.equal(term.written[0], 'x6', 'the oldest events were dropped, not the newest');
  assert.ok(logs.some((l) => l.level === 'WARN' && l.code === 'ide.pty_prereadybuffer_dropped'),
    'a visible WARN diagnostic records the drop (AGENTS.md section 9: oldest-entry eviction with visible counters)');
});

test('UIUX-011: dispose during a delayed spawn discards any buffered pre-ready output (no leak, no late replay)', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  let resolveSpawn;
  const api = fakePtyApi();
  api.spawn = (dims) => {
    api.calls.spawn.push(dims);
    return new Promise((resolve) => { resolveSpawn = resolve; });
  };
  const { panel, term } = buildPanel(harness, { api });
  panel.renderTerminalPanel();
  const start = panel.startSession();
  api.emitData({ sessionId: 'pty-late', data: 'buffered-before-dispose' });
  panel.dispose();
  resolveSpawn({ ok: true, sessionId: 'pty-late', shell: 'pwsh', cwd: 'C:/ws' });
  await start;
  assert.ok(!term.written.includes('buffered-before-dispose'), 'a disposed panel never replays buffered pre-ready output');
});

// IDE-016: sendCommand only reports a command as sent when main accepted the
// whole write ({ ok: true } and not truncated); a refused or short write is false.
async function sendWithWriteResult(t, writeResult) {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const api = fakePtyApi();
  api.write = async function write(payload) { this.calls.write.push(payload); return writeResult; };
  const { panel, logs } = buildPanel(harness, { api });
  panel.renderTerminalPanel();
  const sent = await panel.sendCommand('echo hi');
  return { sent, logs, api };
}

test('IDE-016: sendCommand returns true only when the write result is ok and complete', async (t) => {
  const bytes = Buffer.byteLength('echo hi\r\n', 'utf8');
  const accepted = await sendWithWriteResult(t, { ok: true, written: bytes });
  assert.equal(accepted.sent, true);
  assert.equal(accepted.logs.filter((l) => l.code === 'ide.pty_send_command_refused').length, 0);
  const noCount = await sendWithWriteResult(t, { ok: true });
  assert.equal(noCount.sent, true, 'an ok result without a byte count is accepted');
});

test('IDE-016: a refused write ({ ok: false }) returns false and logs the code', async (t) => {
  const { sent, logs, api } = await sendWithWriteResult(t, { ok: false, code: 'CMP-PTY-0001' });
  assert.equal(sent, false);
  assert.equal(api.calls.write.length, 1, 'the write was attempted once');
  assert.deepEqual(logs.filter((l) => l.code === 'ide.pty_send_command_refused'),
    [{ level: 'WARN', code: 'ide.pty_send_command_refused', data: { code: 'CMP-PTY-0001' } }]);
});

test('IDE-016: a truncated write (written < UTF-8 byte length) and a non-object result are not "sent"', async (t) => {
  const truncated = await sendWithWriteResult(t, { ok: true, written: 3 });
  assert.equal(truncated.sent, false, 'a truncated command must never be treated as sent');
  const undef = await sendWithWriteResult(t, undefined);
  assert.equal(undef.sent, false, 'a write that resolves nothing is not confirmed');
  // 'é' is 2 UTF-8 bytes: a char-count "written" would wrongly pass.
  const harness = createHarness();
  t.after(() => harness.dispose());
  const api = fakePtyApi();
  api.write = async () => ({ ok: true, written: 'é\r\n'.length });
  const { panel } = buildPanel(harness, { api });
  panel.renderTerminalPanel();
  assert.equal(await panel.sendCommand('é'), false, 'the byte length, not the character count, is compared');
});

test('a command longer than one terminal write is refused before anything reaches the shell', async (t) => {
  const { SEND_COMMAND_MAX_BYTES } = require('../renderer/features/renderer-ide-pty-terminal-panel');
  const { MAX_WRITE_BYTES } = require('../services/workspace-pty-service');
  assert.equal(SEND_COMMAND_MAX_BYTES, MAX_WRITE_BYTES, 'the renderer cap mirrors the main-process write cap');

  const harness = createHarness();
  t.after(() => harness.dispose());
  const api = fakePtyApi();
  const { panel, logs } = buildPanel(harness, { api });
  panel.renderTerminalPanel();
  const before = api.calls.write.length;
  assert.equal(await panel.sendCommand('x'.repeat(MAX_WRITE_BYTES)), false);
  assert.equal(api.calls.write.length, before, 'no partial command is typed into the shell line');
  assert.deepEqual(logs.filter((l) => l.code === 'ide.pty_send_command_refused').map((l) => l.data), [{ code: 'too_long' }]);
});
