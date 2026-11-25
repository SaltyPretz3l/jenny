'use strict';
// new-test-file: the live run view panel (row 197 S3) is a new renderer surface with its own fake bridge and harness.

// The Live tab's panel: every run state's words and bar buttons, the command form and its exact-text confirm,
// Wide, the capture order and its stopping, the keep-last-frame still, and the restart switch.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createShellArtifactRails } = require('../renderer/shell/renderer-shell-artifact-rails');
const { settle, gate, setup, snap, confirmed, COMMAND } = require('./helpers/live-run-panel-harness');

// state -> [primary action, its label, primary enabled, restart enabled, show enabled] (the spec's table).
const BAR_TABLE = {
  idle: ['run', 'Run', true, false, false],
  closed: ['run', 'Run', true, false, false],
  ended_early: ['run', 'Run again', true, false, false],
  build_failed: ['run', 'Run again', true, false, false],
  building: ['stop', 'Stop', true, false, false],
  starting: ['stop', 'Stop', true, true, false],
  no_window: ['stop', 'Stop', true, true, false],
  running: ['stop', 'Stop', true, true, true],
  minimized: ['stop', 'Stop', true, true, true],
  stopping: ['stop', 'Stop', false, false, false],
  close_refused: ['stop', 'Stop', false, false, true],
};
// state -> text the panel shows (body or state line), with the snapshot fields that state needs.
const COPY = [
  ['building', { }, ['Building… 0:00'], 'Building'],
  ['build_failed', { exitCode: 101, buildTail: 'a\nb\nc\nd\ne\nf\ng' }, ['Build failed (exit code 101)', 'Send the error to Jenny', 'The error goes into your message box; nothing is sent until you send it.', 'g'], ''],
  ['starting', {}, ['Starting… waiting for its window'], 'Starting'],
  ['ended_early', { exitCode: 3 }, ['The program ended before showing a window (exit code 3).', 'fatal: no adapter'], ''],
  ['no_window', {}, ['Running, but no window has appeared after 15 seconds.', 'fatal: no adapter'], 'Running · no window'],
  ['running', { sourceId: 'w1', hwnd: 5 }, [], 'Running · started just now'],
  ['minimized', { sourceId: 'w1', hwnd: 5 }, ['The window is minimised, so there is no picture.', 'Show window'], 'Minimised'],
  ['closed', { exitCode: 0 }, ['The program closed (exit code 0).'], ''],
  ['stopping', {}, ['Stopping…'], 'Stopping'],
  ['close_refused', { hwnd: 5 }, ['The program did not close. It may be asking a question in its window.', 'Show window', 'Force stop'], ''],
];

test('every run state shows its words and its state line', async () => {
  for (const [state, extra, texts, line] of COPY) {
    const ctx = setup();
    ctx.answers.output = { ok: true, lines: ['x1', 'x2', 'fatal: no adapter'], droppedBytes: 0 };
    await ctx.loadWith(snap(state, extra));
    for (const text of texts) assert.ok(ctx.text().includes(text), `${state}: ${text}`);
    assert.equal(ctx.stateLine(), line, `${state}: state line`);
    ctx.close();
  }
});

test('a missing screen helper is named, by checkout or packaged build; a real early exit keeps its words', async () => {
  const cases = [
    [{ reason: 'helper_unavailable', helperBuildHint: true }, "Jenny's screen helper is missing, so it cannot show this window. Build it with npm run build:computer-helper."],
    [{ reason: 'helper_unavailable', helperBuildHint: false }, "Jenny's screen helper is missing. Reinstall Jenny."],
    [{ reason: 'start_failed', exitCode: 3 }, 'The program ended before showing a window (exit code 3).'],
  ];
  for (const [extra, sentence] of cases) {
    const ctx = setup();
    ctx.answers.output = { ok: true, lines: ['stale line'], droppedBytes: 0 };
    await ctx.loadWith(snap('ended_early', extra));
    assert.ok(ctx.text().includes(sentence), sentence);
    const helper = extra.reason === 'helper_unavailable';
    assert.equal(ctx.text().includes('The program ended before showing a window'), !helper, 'old sentence only for a real exit');
    assert.equal(ctx.text().includes('stale line'), !helper, 'no output lines for a missing helper');
    assert.equal(ctx.text().includes('Run again'), true, 'Run again stays');
    assert.equal(ctx.doc.querySelector('.lv-bar .lv-primary').dataset.liveAction, 'run');
    ctx.close();
  }
});

test('a failed build shows the last five lines only', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('build_failed', { exitCode: 1, buildTail: 'l1\nl2\nl3\nl4\nl5\nl6\nl7' }));
  const shown = ctx.text('.lv-mono');
  assert.ok(!shown.includes('l2') && shown.includes('l3') && shown.includes('l7'));
});

test('the bar buttons are enabled exactly as the state table says', async () => {
  for (const [state, [action, label, primary, restart, show]] of Object.entries(BAR_TABLE)) {
    const ctx = setup();
    await ctx.loadWith(snap(state, { sourceId: 'w1', hwnd: 5 }));
    const button = ctx.doc.querySelector('.lv-bar .lv-primary');
    assert.equal(button.dataset.liveAction, action, `${state}: primary`);
    assert.equal(button.getAttribute('aria-label'), label, `${state}: label`);
    assert.equal(button.disabled, !primary, `${state}: primary enabled`);
    assert.equal(ctx.bar('restart').disabled, !restart, `${state}: restart`);
    assert.equal(ctx.bar('show').disabled, !show, `${state}: show window`);
    ctx.close();
  }
});

test('no command shows the form, not a bar action; a command to confirm again says why', async () => {
  const ctx = setup();
  await ctx.loadWith(null, { status: 'none' });
  assert.ok(ctx.text().includes('No run command yet'));
  assert.ok(ctx.text().includes('Tell Jenny how to start your program. It runs in its own window, behind this one.'));
  assert.equal(ctx.doc.querySelector('.lv-bar .lv-primary').classList.contains('hidden'), true);
  assert.equal(ctx.bar('restart').disabled, true);
  assert.equal(ctx.bar('show').disabled, true);
  ctx.close();
  const lines = { rebind: 'The project folder changed, so confirm the command again.', worktree: 'This chat is in another worktree, so confirm the command again.', restore: 'Your profile was restored, so confirm the command again.' };
  for (const [reason, sentence] of Object.entries(lines)) {
    const again = setup();
    await again.loadWith(null, { status: 'needs_confirmation', reason, command: COMMAND });
    assert.ok(again.text().includes(sentence), reason);
    assert.equal(again.field('program').value, COMMAND.program, 'saved values are filled in');
    again.close();
  }
});

test('the four unavailable reasons say so and disable every bar button; disabled closes the panel', async () => {
  const copy = {
    unsupported_platform: 'The live view needs Windows for now.',
    sandbox_only: 'Commands are set to run only in the sandbox, so the live view is off.',
    no_project: 'Open a chat in a project to run its program.',
  };
  for (const [reason, sentence] of Object.entries(copy)) {
    const ctx = setup();
    ctx.answers.get = { ok: false, reason };
    await ctx.open();
    assert.ok(ctx.text().includes(sentence), reason);
    ctx.doc.querySelectorAll('.artifact-panel-header [data-live-action]').forEach((button) => assert.equal(button.disabled, true, `${reason}: ${button.dataset.liveAction}`));
    ctx.close();
  }
  const off = setup();
  off.answers.get = { ok: false, reason: 'disabled' };
  await off.open();
  assert.equal(off.toggles, 1);
});

test('bar actions call the bridge with the focused chat and project', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('idle'));
  await ctx.click(ctx.bar('run'));
  assert.deepEqual(ctx.named('start')[0][1], { projectId: 'p1', chatId: 'c1' });
  await ctx.push(snap('running', { sourceId: 'w1', hwnd: 5 }));
  await ctx.click(ctx.bar('restart'));
  assert.deepEqual(ctx.named('restart')[0][1], { projectId: 'p1', chatId: 'c1' });
  await ctx.click(ctx.bar('show'));
  assert.deepEqual(ctx.named('showWindow')[0][1], { projectId: 'p1', place: 'front' });
  await ctx.click(ctx.bar('stop'));
  assert.deepEqual(ctx.named('stop')[0][1], { projectId: 'p1', mode: 'ask' });
  await ctx.push(snap('close_refused', { hwnd: 5 }));
  await ctx.click(ctx.body('force'));
  assert.deepEqual(ctx.named('stop')[1][1], { projectId: 'p1', mode: 'force' });
});

test('Send behind Jenny is in More; a click or Enter on the picture brings the window forward', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  await ctx.click(ctx.bar('more'));
  await ctx.click(ctx.doc.querySelector('.lv-pop [data-live-action="behind"]'));
  assert.deepEqual(ctx.named('showWindow')[0][1], { projectId: 'p1', place: 'behind' });
  const picture = ctx.doc.querySelector('.lv-picture');
  assert.equal(picture.getAttribute('role'), 'button');
  assert.equal(picture.title, 'Bring the window forward');
  await ctx.click(picture);
  assert.deepEqual(ctx.named('showWindow')[1][1], { projectId: 'p1', place: 'front' });
  ctx.key(picture, 'Enter');
  await settle();
  assert.equal(ctx.named('showWindow').length, 3);
});

test('a snapshot for another project is ignored; another chat started the run: its title is named', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('idle'));
  await ctx.push(snap('building', { projectId: 'p2' }));
  assert.equal(ctx.bar('run').getAttribute('aria-label'), 'Run');
  await ctx.push(snap('running', { chatId: 'c2', sourceId: 'w1', hwnd: 5 }));
  assert.equal(ctx.stateLine(), 'Running · started in “Map editor”');
  await ctx.push(snap('running', { generation: 2, chatId: 'gone', sourceId: 'w1', hwnd: 5 }));
  assert.equal(ctx.stateLine(), 'Running · started just now');
});

test('the relative start time refreshes at most once a minute while visible', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  assert.equal(ctx.stateLine(), 'Running · started just now');
  await ctx.tick(30_000);
  assert.equal(ctx.stateLine(), 'Running · started just now', 'no refresh before the minute');
  await ctx.tick(90_000);
  assert.equal(ctx.stateLine(), 'Running · started 2 min ago');
});

test('the build timer ticks each second while the tab shows and not while it is hidden', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('building'));
  await ctx.tick(1000);
  await ctx.tick(1000);
  assert.ok(ctx.text().includes('Building… 0:02'));
  await ctx.hide();
  assert.equal(ctx.timers.length, 0, 'nothing is scheduled while hidden');
  await ctx.tick(5000);
  await ctx.show();
  assert.ok(ctx.text().includes('Building… 0:07'), 'it counts from when the build was first seen');
  assert.equal(ctx.timers.length, 1);
});

test('the form parses arguments, environment and folders into the command; the confirm block shows invisible characters', async () => {
  const ctx = setup();
  await ctx.loadWith(null, { status: 'none' });
  ctx.setField('build', 'cargo build --release');
  ctx.setField('program', 'client\u202E.exe');
  ctx.setField('args', '--windowed\n--title=My game\n');
  ctx.setField('cwd', 'game');
  ctx.setField('env', 'SAVE_DIR=C:\\saves\nOPTS=a=b\n');
  ctx.setField('watch', 'src, assets/maps ,');
  await ctx.click(ctx.body('review'));
  const block = ctx.text('.lv-confirm');
  assert.ok(block.includes('Build:  cargo build --release'));
  assert.ok(block.includes('Start:  client⟨U+202E⟩.exe --windowed "--title=My game"'));
  assert.ok(block.includes('In:     game'));
  assert.ok(block.includes('Env:    SAVE_DIR=C:\\saves OPTS=a=b'));
  assert.ok(block.includes('Jenny may restart this command after it changes your code. It is asked for again if the project folder moves.'));
  assert.equal(ctx.named('confirmCommand').length, 0, 'nothing is saved until Confirm');
  ctx.answers.confirmCommand = { ok: true, command: confirmed(), run: snap('idle') };
  await ctx.click(ctx.body('confirm'));
  assert.deepEqual(ctx.named('confirmCommand')[0][1], {
    projectId: 'p1',
    command: { build: 'cargo build --release', program: 'client\u202E.exe', args: ['--windowed', '--title=My game'], cwd: 'game', env: { SAVE_DIR: 'C:\\saves', OPTS: 'a=b' }, watch: ['src', 'assets/maps'] },
  });
  assert.equal(ctx.bar('run').disabled, false, 'the confirmed command can be run');
});

test('Edit returns from the confirm block to the form with the typed values', async () => {
  const ctx = setup();
  await ctx.loadWith(null, { status: 'none' });
  ctx.setField('program', 'game.exe');
  await ctx.click(ctx.body('review'));
  await ctx.click(ctx.body('amend'));
  assert.equal(ctx.field('program').value, 'game.exe');
});

test('a refusal shows its sentence under the field it concerns', async () => {
  const ctx = setup();
  await ctx.loadWith(null, { status: 'none' });
  ctx.setField('program', 'game.exe');
  await ctx.click(ctx.body('review'));
  ctx.answers.confirmCommand = { ok: false, reason: 'program_invalid' };
  await ctx.click(ctx.body('confirm'));
  const error = ctx.doc.querySelector('[data-lv-error="program"]');
  assert.equal(error.textContent, 'Enter the program to run.');
  assert.ok(ctx.field('program'), 'the form is back so it can be fixed');
  ctx.answers.confirmCommand = { ok: false, reason: 'plaintext_secret' };
  await ctx.click(ctx.body('review'));
  await ctx.click(ctx.body('confirm'));
  assert.ok(ctx.doc.querySelector('[data-lv-error="env"]').textContent.length > 0);
});

test('a line without NAME=value is refused before anything is sent', async () => {
  const ctx = setup();
  await ctx.loadWith(null, { status: 'none' });
  ctx.setField('program', 'game.exe');
  ctx.setField('env', 'NOEQUALS');
  await ctx.click(ctx.body('review'));
  assert.ok(ctx.doc.querySelector('[data-lv-error="env"]').textContent.length > 0);
  assert.equal(ctx.named('confirmCommand').length, 0);
});

test('Edit run command reopens the form with the saved values, and is refused while a run is live', async () => {
  const idle = setup();
  await idle.loadWith(snap('idle'));
  await idle.click(idle.bar('more'));
  await idle.click(idle.doc.querySelector('.lv-pop [data-live-action="edit"]'));
  assert.equal(idle.field('program').value, COMMAND.program);
  assert.equal(idle.field('args').value, '--windowed\n--size 1280x720');
  assert.equal(idle.field('env').value, 'SAVE=C:\\s');
  const live = setup();
  await live.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  await live.click(live.bar('more'));
  await live.click(live.doc.querySelector('.lv-pop [data-live-action="edit"]'));
  assert.ok(live.text().includes('Stop the program to change its command.'));
  assert.equal(live.field('program'), null, 'the form did not open');
});

test('Send the error to Jenny fills the message box with the exit code and the tail and sends nothing', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('build_failed', { exitCode: 101, buildTail: 'error[E0425]: no tile_w' }));
  await ctx.click(ctx.body('send-error'));
  assert.equal(ctx.inserts.length, 1);
  assert.equal(ctx.inserts[0].text, 'The build failed (exit code 101):\n\n```\nerror[E0425]: no tile_w\n```');
  assert.deepEqual(ctx.sends, []);
  assert.equal(ctx.named('start').length, 0);
});

test('Wide takes half the window (at least 480px) and Narrow puts the earlier width back', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  await ctx.click(ctx.bar('wide'));
  assert.deepEqual(ctx.layout.sets, [700]);
  assert.equal(ctx.bar('wide').getAttribute('aria-pressed'), 'true');
  assert.equal(ctx.bar('wide').getAttribute('aria-label'), 'Narrow');
  await ctx.click(ctx.bar('wide'));
  assert.deepEqual(ctx.layout.sets, [700, 340]);
  ctx.layout.room = 800;
  await ctx.click(ctx.bar('wide'));
  assert.equal(ctx.layout.sets[2], 480, 'never narrower than 480px');
  await ctx.hide();
  assert.equal(ctx.layout.sets[3], 340, 'closing the panel restores the width');
});

test('capture asks main to arm and requests the window only after the arm is answered', async () => {
  const ctx = setup();
  ctx.gates.armCapture = gate();
  await ctx.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  assert.ok(ctx.events.includes('call:armCapture'));
  assert.ok(!ctx.events.includes('gdm'), 'no request while the arm is pending');
  ctx.gates.armCapture.resolve();
  await settle();
  await settle();
  assert.ok(ctx.events.indexOf('done:armCapture') < ctx.events.indexOf('gdm'));
  assert.deepEqual(ctx.streams[0].constraints, { video: { frameRate: 30 }, audio: false });
  const video = ctx.doc.querySelector('.lv-picture video');
  assert.ok(video && video.muted && video.autoplay && video.hasAttribute('playsinline'));
});

test('the watch folders field is greyed out with its reason until something reads it', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('idle'), { status: 'none' });
  const field = ctx.doc.querySelector('[data-lv-field="watch"]');
  assert.ok(field, 'the field is still shown');
  assert.equal(field.disabled, true);
  assert.match(ctx.doc.body.textContent, /Not used yet/);
});

test('a failed arm never requests the window', async () => {
  const ctx = setup();
  ctx.answers.armCapture = { ok: false, reason: 'arm_refused' };
  await ctx.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  assert.equal(ctx.streams.length, 0);
  assert.ok(!ctx.events.includes('gdm'));
  await ctx.tick(450);
  await settle();
  await settle();
  assert.equal(ctx.named('armCapture').length, 2, 'a refused arm is tried once more, shortly');
  assert.equal(ctx.streams.length, 0);
});

test('a request replaced while its arm was answered uses the slot at once and lets the new window through', async () => {
  const ctx = setup();
  ctx.gates.armCapture = gate();
  await ctx.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  delete ctx.gates.armCapture;
  const first = ctx.named('armCapture').length;
  await ctx.push(snap('running', { sourceId: 'w2', hwnd: 6 }));
  assert.equal(ctx.named('armCapture').length, first + 1);
  await settle();
  await settle();
  assert.ok(ctx.streams.length >= 1, 'the new window got its picture');
  const live = ctx.streams.filter((stream) => !stream.track.stopped);
  assert.equal(live.length, 1, 'only the new window is playing');
});

test('hiding the tab stops every track, and showing it again asks again', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  assert.equal(ctx.streams.length, 1);
  await ctx.hide();
  assert.equal(ctx.streams[0].track.stopped, true);
  await ctx.show();
  assert.equal(ctx.streams.length, 2);
  ctx.visibility = 'hidden';
  ctx.doc.dispatchEvent(new ctx.window.Event('visibilitychange'));
  await settle();
  assert.equal(ctx.streams[1].track.stopped, true, 'a hidden window stops it too');
});

test('a new window (a new source) arms again and the old track is stopped; leaving the live states stops it', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  await ctx.push(snap('running', { sourceId: 'w2', hwnd: 6 }));
  assert.equal(ctx.named('armCapture').length, 2);
  assert.equal(ctx.streams[0].track.stopped, true);
  assert.equal(ctx.streams.length, 2);
  await ctx.push(snap('stopping', { sourceId: 'w2', hwnd: 6 }));
  assert.equal(ctx.streams[1].track.stopped, true);
});

test('keep-last-frame for the current run leaves a still under Stopping', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  const video = ctx.doc.querySelector('.lv-picture video');
  Object.defineProperty(video, 'videoWidth', { value: 640 });
  Object.defineProperty(video, 'videoHeight', { value: 360 });
  ctx.pushKeep({ projectId: 'p1', generation: 9 });
  ctx.pushKeep({ projectId: 'p1', generation: 1 });
  await ctx.push(snap('stopping', { sourceId: 'w1', hwnd: 5 }));
  const still = ctx.doc.querySelector('.lv-stage img');
  assert.equal(still.getAttribute('src'), 'data:image/png;base64,AAAA');
  assert.equal(ctx.doc.querySelector('.lv-stage').dataset.look, 'still');
  assert.ok(ctx.text().includes('Stopping…'));
});

test('the restart switch is greyed out with its reason until the bridge has it, then sends its value', async () => {
  const pending = setup({ restartSwitch: false });
  await pending.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  const off = pending.doc.querySelector('.lv-line [role="switch"]');
  assert.equal(off.disabled, true);
  assert.equal(pending.doc.querySelector('.lv-line .inv-toggle').title, 'Restart after changes is not available yet.');
  const ctx = setup();
  await ctx.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  const track = ctx.doc.querySelector('.lv-line [role="switch"]');
  assert.equal(track.getAttribute('aria-checked'), 'true', 'starts on');
  await ctx.click(track);
  assert.deepEqual(ctx.named('setRestartAfterChanges')[0][1], { projectId: 'p1', on: false });
});

test('the restart switch shows the value main answers with, and stays on when main sends none', async () => {
  const off = setup();
  await off.loadWith(snap('running', { sourceId: 'w1', hwnd: 5 }));
  assert.equal(off.doc.querySelector('.lv-line [role="switch"]').getAttribute('aria-checked'), 'true', 'no field: on');
  off.answers.get = { ok: true, command: confirmed(), run: snap('running', { sourceId: 'w1', hwnd: 5 }), restartAfterChanges: false };
  await off.panel.refresh();
  const track = off.doc.querySelector('.lv-line [role="switch"]');
  assert.equal(track.getAttribute('aria-checked'), 'false');
  assert.equal(track.closest('.inv-toggle').classList.contains('inv-toggle--on'), false);
  await off.click(track);
  assert.deepEqual(off.named('setRestartAfterChanges')[0][1], { projectId: 'p1', on: true });
  assert.equal(track.getAttribute('aria-checked'), 'true');
});

test('a project change while open asks again; closing unsubscribes', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('idle'));
  assert.equal(ctx.named('get').length, 1);
  ctx.state.currentSessionId = 'c3';
  ctx.panel.renderRailContent(ctx.surface);
  await settle();
  assert.deepEqual(ctx.named('get')[1][1], { projectId: 'p2' });
  ctx.close();
  assert.equal(ctx.offState, 1);
  assert.equal(ctx.offKeep, 1);
});

test('a rejected bridge call reads like an internal error and does not break the panel', async () => {
  const ctx = setup();
  ctx.answers.get = () => { throw new Error('boom'); };
  await ctx.open();
  assert.ok(ctx.doc.querySelector('.lv-shell'));
  assert.equal(ctx.bar('wide').disabled, true);
});
test('a Run into less graphics memory than last time asks first; Start anyway starts, Cancel leaves it stopped', async () => {
  const ctx = setup();
  ctx.answers.start = { ok: false, reason: 'low_gpu_memory', needMb: 1843, freeMb: 922 };
  await ctx.loadWith(snap('idle'));
  await ctx.click(ctx.bar('run'));
  assert.deepEqual(ctx.named('start')[0][1], { projectId: 'p1', chatId: 'c1' });
  const shown = ctx.text();
  assert.ok(shown.includes('Not much graphics memory is free'));
  assert.ok(shown.includes('Last time this program used about 1.8 GB of graphics memory, and 0.9 GB is free now. Starting it may slow down or stop the model.'));
  assert.equal(ctx.doc.querySelector('.lv-flash').textContent, '', 'the generic failure line stays quiet');
  assert.ok(ctx.body('start-anyway') && ctx.body('cancel-gpu'));
  assert.equal(ctx.body('start-anyway').textContent.trim(), 'Start anyway');
  assert.equal(ctx.body('cancel-gpu').textContent.trim(), 'Cancel');
  for (const action of ['start-anyway', 'cancel-gpu']) assert.ok(!/danger/.test(ctx.body(action).className), action);
  ctx.answers.start = { ok: true, run: snap('building', { generation: 2 }) };
  await ctx.click(ctx.body('start-anyway'));
  assert.deepEqual(ctx.named('start')[1][1], { projectId: 'p1', chatId: 'c1', anyway: true });
  assert.equal(ctx.body('start-anyway'), null, 'the notice is gone once answered');
  assert.ok(ctx.text().includes('Building'));
  ctx.close();

  const again = setup();
  again.answers.start = { ok: false, reason: 'low_gpu_memory', needMb: 1843, freeMb: 922 };
  await again.loadWith(snap('idle'));
  await again.click(again.bar('run'));
  assert.ok(again.body('cancel-gpu'));
  await again.click(again.body('cancel-gpu'));
  assert.equal(again.body('cancel-gpu'), null);
  assert.equal(again.named('start').length, 1, 'Cancel starts nothing');
  assert.equal(again.stateLine(), '');
  again.close();
});

test('the graphics memory notice goes when the run changes state; other refusals still say they did not work', async () => {
  const ctx = setup();
  ctx.answers.start = { ok: false, reason: 'low_gpu_memory', needMb: 1843, freeMb: 922 };
  await ctx.loadWith(snap('idle'));
  await ctx.click(ctx.bar('run'));
  assert.ok(ctx.body('cancel-gpu'));
  await ctx.push(snap('building', { generation: 2 }));
  assert.equal(ctx.body('cancel-gpu'), null, 'a push that changes the state clears it');
  ctx.answers.start = { ok: false, reason: 'low_gpu_memory', needMb: 'lots', freeMb: 1 };
  await ctx.push(snap('closed', { generation: 2, exitCode: 0 }));
  await ctx.click(ctx.body('run'));
  assert.equal(ctx.body('cancel-gpu'), null, 'numbers that are not numbers are an ordinary failure');
  assert.equal(ctx.doc.querySelector('.lv-flash').textContent, 'That did not work. Try again.');
});

// The shell's lazy loader: three scripts on the first render of the tab, the flag, and a failed load.
const LIVE_GLOBALS = {
  'renderer/chat/renderer-live-run-form.js': 'rendererLiveRunForm',
  'renderer/chat/renderer-live-run-capture.js': 'rendererLiveRunCapture',
  'renderer/chat/renderer-live-run-panel.js': 'rendererLiveRunPanel',
};

function railsFor({ flags = {}, loadFails = false } = {}) {
  const h = { loaded: [], painted: [], logs: [], repaints: 0 };
  const windowRef = {
    scriptLoaderUtils: { ensureScript: async ({ src }) => {
      h.loaded.push(src);
      if (loadFails) return false;
      windowRef[LIVE_GLOBALS[src]] = { connectLiveRunPanel: () => ({ renderRailContent: (surface) => { h.painted.push(surface); return true; } }) };
      return true;
    } },
  };
  h.rails = createShellArtifactRails({
    state: { features: { featureFlags: flags } }, windowRef, callbacks: {}, codeReviewRailDeps: {}, registerCleanup() {},
    sidePanel: { getSessionId: () => 's1' }, appendClientLog: (...args) => h.logs.push(args), showToastMessage() {},
    renderAll() {}, setActiveView() {}, getSurface: () => null, resolveArtifactReviewPanelEl: () => null,
    ensureArtifactSurface: () => ({ renderArtifactReviewPanel: () => { h.repaints += 1; } }),
  });
  return h;
}

test('the Live scripts load on the first render of the tab, panel last, and the panel paints once ready', async () => {
  const h = railsFor();
  const surface = {};
  assert.equal(h.rails.renderLiveSurface(surface), true, 'the mode stays while its panel loads');
  assert.equal(h.rails.renderLiveSurface(surface), true);
  await settle();
  assert.deepEqual(h.loaded, Object.keys(LIVE_GLOBALS));
  assert.equal(h.repaints, 1, 'the load asks the panel to paint');
  assert.equal(h.rails.renderLiveSurface(surface), true);
  assert.deepEqual(h.painted, [surface]);
});

test('with the flag off nothing loads and the mode resets; a failed load resets it once and says so', async () => {
  const off = railsFor({ flags: { live_run_view: false } });
  assert.equal(off.rails.renderLiveSurface({}), false);
  assert.deepEqual(off.loaded, []);
  const bad = railsFor({ loadFails: true });
  assert.equal(bad.rails.renderLiveSurface({}), true);
  await settle();
  assert.equal(bad.rails.renderLiveSurface({}), false);
  assert.equal(bad.loaded.length, 1, 'no retry on every render');
  assert.equal(bad.logs.filter((entry) => entry[1] === 'live_run.panel_init_failed').length, 1);
  assert.equal(bad.repaints, 1, 'a failed load repaints so the blank panel resets');
});
