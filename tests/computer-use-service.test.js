'use strict';
// new-test-file: the computer-use service and tool body (row 196 C1b)

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatForModel, stepSummary } = require('../services/computer-use/result-format');
const { createMouseLock } = require('../services/computer-use/mouse-lock');
const { createComputerUseService } = require('../services/computer-use/computer-use-service');
const tool = require('../services/tools/builtin/computer-tool');
const { CLICK, GAME, JENNY, focused, helperError, liveContext, makeFinder, setup, userRow, win } = require('./helpers/computer-use-world');

test('a screenshot with no target answers no_target and calls nothing', async () => {
  const s = setup();
  const outcome = await s.run({ action: 'screenshot' });
  assert.equal(outcome.status, 'no_target');
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /Use focus or open first/);
  assert.equal(s.world.calls.length, 0);
});

test('focus finds an open window by program name or by title, asks once, and returns its picture', async () => {
  const s = setup();
  const byName = await s.run({ action: 'focus', name: 'GAME' });
  assert.equal(byName.status, 'done');
  assert.equal(byName.ok, true);
  assert.equal(byName.program, 'game'); // named by its file, never by the model's words
  assert.deepEqual(s.asks.map((ask) => ask.kind), ['grant']);
  assert.equal(s.asks[0].program, GAME);
  assert.equal(byName.image.mime_type, 'image/png');
  assert.equal(byName.image.buffer.toString(), 'png-0');
  assert.deepEqual([byName.width, byName.height, byName.signature], [1280, 720, 'sig0']);
  assert.equal(s.world.ops('input.focus')[0].args.expect.hwnd, 101);

  const t = setup();
  assert.equal((await t.run({ action: 'focus', name: 'canvas' })).status, 'done');
  assert.equal(t.world.ops('input.focus')[0].args.expect.hwnd, 102);
  t.world.frame = 7;
  const shot = await t.run({ action: 'screenshot' });
  assert.deepEqual([shot.signature, shot.screenChanged], ['sig7', true]);
  assert.equal((await t.run({ action: 'screenshot' })).screenChanged, false);
  assert.deepEqual(t.world.ops('capture').at(-1).args, { hwnd: 102, max_long_edge: 1280, area: 'bounds' });
});

test('focus: no open match answers not_found (with a hint when the finder knows it); hidden, cloaked and tool windows do not count', async () => {
  const s = setup({ finder: makeFinder({ solitaire: [{ name: 'Solitaire', program: 'C:\\Games\\sol.exe', source: 'start' }] }) });
  const unknown = await s.run({ action: 'focus', name: 'nothing' });
  assert.deepEqual([unknown.status, unknown.message], ['not_found', 'No program by that name was found.']);
  const hint = await s.run({ action: 'focus', name: 'Solitaire' });
  assert.deepEqual([hint.status, hint.message], ['not_found', 'It is not open. Use open to start it.']);
  s.world.windows = [win(101, 11, 'Game', { visible: false }), win(105, 15, 'Game tip', { tool_window: true }), win(106, 16, 'Game ghost', { cloaked: true })];
  assert.equal((await s.run({ action: 'focus', name: 'game' })).status, 'not_found');
  assert.equal(s.asks.length, 0);
});

test('a click sends input.click with the guard and the last picture\'s scale, then returns a new picture', async () => {
  const s = setup();
  await focused(s);
  s.world.reset();
  const outcome = await s.run({ action: 'click', x: 100, y: 50, button: 'right', count: 2, modifiers: ['shift', 'shift', 'ctrl'] });
  assert.equal(outcome.status, 'done');
  assert.deepEqual(s.world.ops('input.click')[0].args, {
    expect: { hwnd: 101, program: GAME, deny_pids: [4100, 4188], deny_programs: [JENNY] },
    scale: 0.5, point: { x: 100, y: 50 }, button: 'right', count: 2, modifiers: ['shift', 'ctrl'],
  });
  assert.deepEqual([outcome.screenChanged, outcome.signature, outcome.width], [true, 'sig1', 1280]);
  assert.equal(outcome.image.buffer.toString(), 'png-1');
  assert.ok(s.world.names().indexOf('input.click') < s.world.names().indexOf('capture'), 'the picture is taken after the input');
  s.world.still = true;
  assert.equal((await s.run({ action: 'move', x: 5, y: 6 })).screenChanged, false);
});

test('every input action sends its own helper operation; Jenny\'s identity is read fresh, and a missing one fails closed', async () => {
  let programs = [JENNY];
  const s = setup({ options: { jennyIdentity: () => ({ pids: [1], programs }) } });
  await focused(s);
  s.world.reset();
  for (const input of [{ action: 'drag', x: 1, y: 2, to_x: 30.4, to_y: 40 }, { action: 'scroll', x: 9, y: 9, dy: -3 },
    { action: 'type', text: 'hello\nworld' }, { action: 'key', chord: ' Ctrl+S ', hold_ms: 100 }, { action: 'key', chord: 'Control+Return' }]) {
    assert.equal((await s.run(input)).status, 'done', input.action);
  }
  const args = (op) => s.world.ops(op)[0].args;
  assert.deepEqual([args('input.drag').from, args('input.drag').to, args('input.drag').button, args('input.drag').modifiers], [{ x: 1, y: 2 }, { x: 30, y: 40 }, 'left', []]);
  assert.deepEqual([args('input.scroll').dy, args('input.scroll').dx, args('input.scroll').scale], [-3, 0, 0.5]);
  assert.equal(args('input.type').text, 'hello\nworld');
  assert.deepEqual([args('input.key').chord, args('input.key').hold_ms], ['ctrl+s', 100]);
  assert.equal(s.world.ops('input.key')[1].args.chord, 'ctrl+enter', 'common key names become the helper\'s names');
  assert.equal('scale' in args('input.type'), false, 'keyboard input carries no scale');
  programs = [JENNY, 'C:\\Other\\Jenny2.exe'];
  await s.run(CLICK);
  assert.deepEqual(s.world.ops('input.click')[0].args.expect.deny_programs, programs);
  programs = [];
  assert.equal((await s.run(CLICK)).status, 'refused');
  assert.equal(s.world.ops('input.click').length, 1);
});

test('malformed actions answer invalid and reach no helper', async () => {
  const s = setup();
  await focused(s);
  s.world.reset();
  const bad = [null, 'click', {}, { action: 'zoom' }, { action: 'click' }, { action: 'click', x: 'a', y: 1 }, { action: 'click', x: 1, y: 1, button: 'back' },
    { action: 'click', x: 1, y: 1, count: 4 }, { action: 'click', x: 1, y: 1, modifiers: ['meta'] }, { action: 'drag', x: 1, y: 1 },
    { action: 'scroll', x: 1, y: 1 }, { action: 'scroll', x: 1, y: 1, dy: 21 }, { action: 'type', text: '' }, { action: 'type', text: 'a'.repeat(2001) },
    { action: 'key' }, { action: 'key', chord: 'a', hold_ms: 2001 }, { action: 'key', chord: 'alt' }, { action: 'key', chord: 'meta+s' },
    { action: 'key', chord: 'ctrl+ctrl+s' }, { action: 'key', chord: 'f13' }, { action: 'wait', seconds: 0.1 }, { action: 'wait', seconds: 11 },
    { action: 'open', name: '' }, { action: 'focus', name: 'x'.repeat(121) }];
  for (const input of bad) {
    assert.equal((await s.run(input)).status, 'invalid', JSON.stringify(input));
  }
  assert.equal(s.world.calls.length, 0);
});

test('each helper refusal maps to its status and a plain sentence', async () => {
  const expected = {
    no_watch: /watch/i, secure_desktop: /security|locked/i, outside_window: /outside the window's picture\. Points are pixels in the latest picture, not a 0 to 1,000 scale/, denied: /cannot be used/,
    elevated: /administrator/, unidentified: /which program/, wrong_program: /different program/, password_field: 'That is a password field; the owner fills it in.',
    refused_chord: 'That key combination is never sent.', not_front: /front/,
  };
  for (const [reason, message] of Object.entries(expected)) {
    const s = setup();
    await focused(s);
    s.world.errors['input.click'] = helperError('refused', reason);
    const outcome = await s.run(CLICK);
    assert.equal(outcome.status, 'refused', reason);
    if (message instanceof RegExp) assert.match(outcome.message, message, reason); else assert.equal(outcome.message, message, reason);
    assert.doesNotMatch(outcome.message, /refused|reason/i, 'the helper words stay out of the message');
  }
  const s = setup();
  await focused(s);
  for (const [error, status] of [[helperError('bad_request'), 'invalid'], [helperError('internal'), 'failed'], [new Error('C:\\secret\\place.exe exploded'), 'failed']]) {
    s.world.errors['input.click'] = error;
    const outcome = await s.run(CLICK);
    assert.equal(outcome.status, status);
    assert.doesNotMatch(outcome.message, /secret|place/);
  }
});

test('owner_active pauses the turn: later input answers paused_by_user without a helper call; a new turn goes on', async () => {
  const s = setup();
  await focused(s);
  s.world.errors['input.click'] = helperError('refused', 'owner_active');
  const first = await s.run(CLICK);
  assert.equal(first.status, 'paused_by_user');
  assert.match(first.message, /taken the mouse or keyboard/);
  delete s.world.errors['input.click'];
  s.world.reset();
  for (const input of [CLICK, { action: 'type', text: 'x' }, { action: 'key', chord: 'a' }]) {
    assert.equal((await s.run(input)).status, 'paused_by_user');
  }
  assert.equal(s.world.calls.length, 0, 'no helper call, not even a list or a capture');
  assert.equal((await s.run({ action: 'screenshot' })).status, 'done', 'looking is still allowed');
  s.world.reset(); // the owner's next message is the hand-back: a new turn resumes the watch
  await s.run({ action: 'screenshot' }, { turnId: 'turn-2' });
  assert.equal((await s.run(CLICK, { turnId: 'turn-2' })).status, 'done');
  assert.equal(s.world.ops('watch.resume').length, 1);
});

test('window_gone clears the target', async () => {
  const s = setup();
  await focused(s);
  s.world.errors['input.click'] = helperError('refused', 'window_gone');
  const gone = await s.run(CLICK);
  assert.deepEqual([gone.status, /gone/.test(gone.message)], ['refused', true]);
  delete s.world.errors['input.click'];
  assert.equal((await s.run(CLICK)).status, 'no_target');
  assert.equal((await s.run({ action: 'screenshot' })).status, 'no_target');
});

test('a view-only program allows a screenshot and refuses input; a never program is refused; a decline or no card sets no target', async () => {
  const s = setup();
  assert.equal((await s.run({ action: 'focus', name: 'chrome' })).status, 'done');
  assert.equal(s.asks[0].view_only, true);
  assert.deepEqual(s.world.ops('window.show')[0].args, { hwnd: 103, mode: 'front' });
  assert.equal(s.world.ops('input.focus').length, 0);
  assert.equal((await s.run({ action: 'screenshot' })).status, 'done');
  s.world.reset();
  const click = await s.run(CLICK);
  assert.deepEqual([click.status, /view only/i.test(click.message)], ['refused', true]);
  assert.equal(s.world.ops('input.click').length + s.world.ops('watch.start').length, 0);

  const never = setup();
  assert.equal((await never.run({ action: 'focus', name: 'terminal' })).status, 'refused');
  assert.deepEqual([never.asks.length, never.world.ops('capture').length], [0, 0]);
  const declined = setup({ decline: ['grant'] });
  assert.equal((await declined.run({ action: 'focus', name: 'game' })).status, 'declined');
  assert.equal((await declined.run({ action: 'screenshot' })).status, 'no_target');
  assert.equal((await setup().run({ action: 'focus', name: 'game' }, { authorize: null })).status, 'refused');
});

test('windows lists granted programs only, with no other window', async () => {
  const s = setup();
  assert.doesNotMatch((await s.run({ action: 'windows' })).message, /Game|Paint|Chrome|Terminal/);
  await focused(s);
  await s.run({ action: 'focus', name: 'chrome' });
  const listed = await s.run({ action: 'windows' });
  assert.match(listed.message, /game: Untitled - Game/);
  assert.match(listed.message, /chrome: Docs - Chrome/);
  assert.doesNotMatch(listed.message, /Paint|Terminal/);
});

test('open: not_found, a match without a program file refused before any card, and a decline never starts the program', async () => {
  const finder = makeFinder({ store: [{ name: 'Store App', program: null, source: 'store' }], game: [{ name: 'game', program: GAME, source: 'list' }] });
  const s = setup({ finder, decline: ['open'] });
  const missing = await s.run({ action: 'open', name: 'nothing' });
  assert.deepEqual([missing.status, missing.message], ['not_found', 'No program by that name was found.']);
  const store = await s.run({ action: 'open', name: 'store' });
  assert.deepEqual([store.status, store.message], ['refused', 'That program can be focused once it is open, but not started from here.']);
  assert.equal(s.asks.length, 0);
  assert.equal((await s.run({ action: 'open', name: 'game' })).status, 'declined');
  assert.deepEqual(s.asks.map((ask) => ask.kind), ['open']);
  assert.equal(finder.launched.length, 0);
});

test('open: the program is launched, its window is found, and it becomes the target', async () => {
  let world = null;
  const finder = makeFinder({ newgame: [{ name: 'newgame', program: 'C:\\Games\\New\\client.exe', source: 'list' }] }, {
    onLaunch: () => { world.windows.push(win(201, 21, 'New Game')); world.programs[201] = 'c:/games/new/CLIENT.EXE'; },
  });
  const s = setup({ finder });
  world = s.world;
  world.windows.push(win(200, 21, 'Splash', { tool_window: true }));
  world.programs[200] = 'C:\\Games\\New\\client.exe';
  const outcome = await s.run({ action: 'open', name: 'newgame' });
  assert.equal(outcome.status, 'done', outcome.message);
  assert.equal(outcome.program, 'newgame');
  assert.deepEqual(s.asks.map((ask) => [ask.kind, ask.name]), [['open', 'newgame']]);
  assert.equal(finder.launched.length, 1);
  assert.equal(world.ops('input.focus')[0].args.expect.hwnd, 201);
  assert.equal(outcome.image.mime_type, 'image/png');
  assert.equal((await s.run(CLICK)).status, 'done');
  assert.equal(world.ops('input.click')[0].args.expect.program, 'C:\\Games\\New\\client.exe');
});

test('open: a launch that fails, and a window that never appears, both answer failed', async () => {
  const table = { game: [{ name: 'game', program: 'C:\\Games\\Late\\late.exe', source: 'list' }] };
  const bad = setup({ finder: makeFinder(table, { launchOk: false }) });
  assert.equal((await bad.run({ action: 'open', name: 'game' })).status, 'failed');
  const late = setup({ finder: makeFinder(table) });
  assert.equal((await late.run({ action: 'open', name: 'game' })).status, 'failed');
  const polls = late.world.ops('windows.list').length;
  assert.ok(polls > 10 && polls <= 61, `it polled for the window, then gave up (${polls})`);
});

test('the standard dialog asks a person once per program, and a no stops the input', async () => {
  const s = setup();
  await focused(s);
  s.world.windows.push(win(150, 11, 'Open', { class: '#32770' }), win(160, 99, 'Open', { class: '#32770' }));
  assert.equal((await s.run(CLICK)).status, 'done');
  await s.run({ action: 'type', text: 'a' });
  await s.run({ action: 'key', chord: 'enter' });
  assert.deepEqual(s.asks.map((ask) => ask.kind), ['grant', 'file_dialog']);

  const quiet = setup();
  await focused(quiet);
  quiet.world.windows.push(win(160, 99, 'Open', { class: '#32770' }), win(161, 11, 'No class'));
  await quiet.run(CLICK);
  assert.deepEqual(quiet.asks.map((ask) => ask.kind), ['grant'], 'another process\'s dialog, or no class field, asks nothing');

  const declined = setup({ decline: ['file_dialog'] });
  await focused(declined);
  declined.world.windows.push(win(150, 11, 'Save As', { class: '#32770' }));
  assert.equal((await declined.run({ action: 'type', text: 'a' })).status, 'declined');
  assert.equal(declined.world.ops('input.type').length, 0);
});

test('humanWaitMs is what the cards waited, and the turn clocks are suspended around each ask', async () => {
  const s = setup();
  const counts = { suspended: 0, resumed: 0 };
  const suspendTurnClocks = () => { counts.suspended += 1; return () => { counts.resumed += 1; }; };
  assert.equal((await s.run({ action: 'focus', name: 'game' }, { suspendTurnClocks })).humanWaitMs, 500);
  assert.deepEqual(counts, { suspended: 1, resumed: 1 });
  assert.equal((await s.run({ action: 'screenshot' }, { suspendTurnClocks })).humanWaitMs, undefined);
  s.world.windows.push(win(150, 11, 'Open', { class: '#32770' }));
  assert.equal((await s.run(CLICK, { suspendTurnClocks })).humanWaitMs, 500);
  assert.deepEqual(counts, { suspended: 2, resumed: 2 });
});

test('the mouse lock answers busy to a second chat and frees on onTurnEnd', async () => {
  const s = setup();
  const b = { sessionId: 'chat-b' };
  await focused(s, b);
  await s.service.onTurnEnd('chat-b');
  await focused(s);
  assert.equal(s.service.holder(), 'chat-1');
  const busy = await s.run(CLICK, b);
  assert.deepEqual([busy.status, busy.message], ['busy', 'Another chat is using the mouse.']);
  assert.deepEqual([(await s.run({ action: 'screenshot' }, b)).status, (await s.run({ action: 'focus', name: 'game' }, b)).status], ['done', 'busy']);
  await s.service.onTurnEnd('chat-1');
  assert.equal(s.service.holder(), null);
  assert.equal((await s.run(CLICK, b)).status, 'done');
  assert.equal(s.service.holder(), 'chat-b');
  const lock = createMouseLock();
  assert.deepEqual([lock.acquire('a'), lock.acquire('b'), lock.release('b'), lock.release('a')], [true, false, false, true]);
});

test('the 61st step of a turn answers budget, and a new turn starts again', async () => {
  const s = setup();
  await focused(s);
  for (let step = 2; step <= 60; step += 1) assert.equal((await s.run({ action: 'screenshot' })).status, 'done', `step ${step}`);
  const over = await s.run({ action: 'screenshot' });
  assert.deepEqual([over.status, over.message], ['budget', 'This turn has used its 60 computer steps. Stop and tell the owner what is left; they can say continue.']);
  assert.deepEqual([(await s.run(CLICK)).status, (await s.run({ action: 'screenshot' }, { turnId: 'turn-2' })).status], ['budget', 'done']);
});

test('the watch starts and resumes on the first input action of a turn, and stops at the turn\'s end', async () => {
  const s = setup();
  await s.run({ action: 'screenshot' });
  assert.equal(s.world.ops('watch.start').length, 0, 'looking does not start it');
  await focused(s);
  const names = s.world.names();
  assert.deepEqual(s.world.ops('watch.start')[0].args, { stop_chord: 'ctrl+alt+shift+f12' }, 'the chord the pill and Settings name');
  assert.ok(names.indexOf('watch.start') < names.indexOf('watch.resume') && names.indexOf('watch.resume') < names.indexOf('input.focus'));
  await s.run(CLICK);
  await s.run(CLICK);
  assert.deepEqual([s.world.ops('watch.start').length, s.world.ops('watch.resume').length], [1, 1]);
  s.world.reset();
  await s.service.onTurnEnd('chat-1');
  assert.deepEqual(s.world.names(), ['input.release_all', 'watch.stop']);
  assert.equal(s.service.holder(), null);
  s.world.reset();
  await s.run({ action: 'screenshot' }, { turnId: 'turn-2' });
  await s.run(CLICK, { turnId: 'turn-2' });
  assert.deepEqual([s.world.ops('watch.start').length, s.world.ops('watch.resume').length], [1, 1]);
});

test('the watch keeps running while another chat holds the mouse; forgetChat and shutdown let go of everything', async () => {
  const s = setup();
  await focused(s);
  s.world.reset();
  await s.service.onTurnEnd('chat-b'); // a chat that never held it
  assert.deepEqual([s.world.calls.length, s.service.holder()], [0, 'chat-1']);
  await s.service.forgetChat('chat-1');
  assert.deepEqual(s.world.names(), ['input.release_all', 'watch.stop']);
  assert.deepEqual([s.service.holder(), s.service.grants('chat-1')], [null, []]);
  await focused(s);
  s.world.reset();
  await s.service.shutdown();
  assert.deepEqual([s.world.names(), s.service.holder()], [['input.release_all', 'watch.stop'], null]);
});

test('a stop chord or the owner\'s input event pauses the holder\'s turn; with no holder it changes nothing; a helper restart starts the watch again', async () => {
  const s = setup();
  await focused(s);
  s.world.host.emit('event', 'watch.stop_chord', {});
  s.world.reset();
  const stopped = await s.run(CLICK);
  assert.deepEqual([stopped.status, stopped.message], ['paused_by_user', 'The owner pressed Stop. End the turn now.']);
  assert.equal(s.world.calls.length, 0);

  const t = setup();
  await focused(t);
  t.world.host.emit('event', 'watch.owner_input', { kind: 'key' });
  const paused = await t.run({ action: 'type', text: 'x' });
  assert.deepEqual([paused.status, /taken the mouse or keyboard/.test(paused.message)], ['paused_by_user', true]);

  const u = setup();
  await focused(u);
  await u.service.onTurnEnd('chat-1');
  u.world.host.emit('event', 'watch.stop_chord', {});
  await u.run({ action: 'screenshot' }, { turnId: 'turn-2' });
  assert.equal((await u.run(CLICK, { turnId: 'turn-2' })).status, 'done');
  u.world.host.emit('helper_exited', { code: 1 });
  u.world.reset();
  assert.equal((await u.run(CLICK, { turnId: 'turn-2' })).status, 'done');
  assert.equal(u.world.ops('watch.start').length, 1);
});

test('an abort during a wait answers cancelled and lets go of every key; wait sleeps for its time and ends with a picture', async () => {
  const s = setup();
  await focused(s);
  const slept = [];
  s.world.onSleep = (ms) => slept.push(ms);
  const waited = await s.run({ action: 'wait', seconds: 1.5 });
  assert.deepEqual([waited.status, slept.includes(1500), Boolean(waited.image)], ['done', true, true]);
  const controller = new AbortController();
  s.world.onSleep = () => controller.abort();
  s.world.reset();
  assert.equal((await s.run({ action: 'wait', seconds: 2 }, { abortSignal: controller.signal })).status, 'cancelled');
  assert.deepEqual([s.world.ops('input.release_all').length, s.world.ops('capture').length], [1, 0]);
  s.world.reset();
  assert.equal((await s.run(CLICK, { abortSignal: AbortSignal.abort() })).status, 'cancelled');
  assert.equal(s.world.ops('input.click').length, 0);
});

test('an unavailable helper answers unavailable for every action', async () => {
  for (const getHost of [() => null, () => { throw new Error('no host'); }]) {
    const service = createComputerUseService({ getHost, finder: makeFinder(), jennyIdentity: () => ({ pids: [], programs: [JENNY] }), sleep: async () => {} });
    const ctx = { sessionId: 'c', turnId: 't', callId: 'k', abortSignal: new AbortController().signal };
    for (const action of [{ action: 'screenshot' }, { action: 'windows' }, CLICK, { action: 'focus', name: 'a' }]) {
      assert.equal((await service.execute(action, ctx)).status, 'unavailable');
    }
  }
  const s = setup();
  await focused(s);
  s.world.errors.capture = helperError('helper_unavailable');
  assert.equal((await s.run({ action: 'screenshot' })).status, 'unavailable');
});

test('input in a new turn takes a picture first and answers with it', async () => {
  const s = setup();
  await focused(s);
  s.world.reset();
  const first = await s.run(CLICK, { turnId: 'turn-2' });
  assert.deepEqual([first.status, first.message, Boolean(first.image), s.world.ops('input.click').length], ['done', 'Here is the window; look before acting.', true, 0]);
  assert.equal((await s.run(CLICK, { turnId: 'turn-2' })).status, 'done');
  assert.equal(s.world.ops('input.click').length, 1);
});

test('grants lists what a chat has granted, revoke removes it and its target, and lastRealInputAgeMs reads the helper while the watch runs', async () => {
  const s = setup();
  assert.equal(await s.service.lastRealInputAgeMs(), null);
  await focused(s);
  const original = s.world.host.request;
  s.world.host.request = async (op, args, options) => (op === 'watch.state' ? { running: true, last_real_input_ms: 4200 } : original(op, args, options));
  assert.equal(await s.service.lastRealInputAgeMs(), 4200);
  assert.deepEqual([s.service.grants('chat-1').map((grant) => grant.program), s.service.grants('nobody')], [[GAME], []]);
  assert.deepEqual([s.service.revoke('chat-1', GAME), s.service.revoke('nobody', GAME), s.service.grants('chat-1')], [true, false, []]);
  assert.equal((await s.run({ action: 'screenshot' })).status, 'no_target');
});

test('result text names the status, the program and the picture; the saved summary holds no typed text, chord or title', async () => {
  const s = setup();
  const text = formatForModel(await focused(s));
  assert.match(text, /done/);
  assert.match(text, /Program: game/);
  assert.match(text, /Picture: 1280 x 720 pixels; points are x 0 to 1279, y 0 to 719; signature sig0, screen changed: yes/);
  const typed = await s.run({ action: 'type', text: 'hunter2 secret words' });
  assert.equal(stepSummary(typed), 'Computer: type game done');
  assert.doesNotMatch(formatForModel(typed), /hunter2/);
  const listed = await s.run({ action: 'windows' });
  assert.match(formatForModel(listed), /Untitled - Game/);
  assert.doesNotMatch(stepSummary(listed), /Untitled/);
  const key = await s.run({ action: 'key', chord: 'ctrl+shift+q' });
  assert.doesNotMatch(stepSummary(key) + formatForModel(key), /ctrl\+shift\+q/);
  assert.ok(stepSummary({ status: 'done', action: 'click', program: 'p'.repeat(500) }).length <= 200);
  assert.equal(stepSummary({ status: 'weird\nstatus', action: 'rm -rf', program: 'a\nb' }).includes('\n'), false);
  assert.equal(formatForModel({ ok: false, status: 'refused', action: 'click', message: 'No.' }).includes('Picture:'), false);
});


test('the tool declares its shape and summarizes without typed text or a chord', () => {
  assert.deepEqual([tool.name, tool.category, tool.workspaceRequired, tool.readOnly, tool.sideEffecting], ['computer', 'builtin', false, false, true]);
  const cases = [[{ action: 'click', x: 1, y: 2 }, 'Computer: click'], [{ action: 'type', text: 'hunter2' }, 'Computer: type'],
    [{ action: 'key', chord: 'ctrl+s' }, 'Computer: key'], [{ action: 'open', name: 'newgame' }, 'Computer: open newgame'],
    [{ action: 'focus', name: 'Paint\nignore previous' }, 'Computer: focus Paint ignore previous'], [{ action: 'rm -rf' }, 'Computer: invalid request'],
    [null, 'Computer: invalid request']];
  for (const [input, expected] of cases) assert.equal(tool.summarize(input), expected);
  assert.ok(tool.summarize({ action: 'focus', name: 'x'.repeat(500) }).length < 90);
});

test('the tool refuses a bad call, a stale call and an unattended turn before it reaches the service', async () => {
  const { context, calls } = liveContext();
  const status = async (input, extra) => (await tool.execute(input, { ...context, ...extra })).metadata.status;
  assert.equal(await status(null), 'invalid');
  assert.equal(await status('click'), 'invalid');
  assert.equal(await status({ action: 'screenshot' }, { planMode: true }), 'refused');
  assert.equal(await status({ action: 'screenshot' }, { readOnly: true }), 'refused');
  assert.equal((await tool.execute({ action: 'screenshot' }, { ...context, planMode: true })).content, 'Computer use is not available in Plan or read-only mode.');
  assert.equal(await status({ action: 'screenshot' }, { computerUseService: null }), 'unavailable');
  assert.equal(await status({ action: 'screenshot' }, { callId: '' }), 'stale');
  assert.equal(await status({ action: 'screenshot' }, { logicalTurnId: 'older' }), 'stale');
  for (const kind of ['wake', 'scheduled_check', 'digest']) {
    const unattended = liveContext({ messages: [userRow('Started by the app', { application_turn: kind })] });
    const result = await tool.execute({ action: 'screenshot' }, unattended.context);
    assert.deepEqual([result.metadata.status, result.content, unattended.calls.length], ['refused', 'The owner did not start this turn, so the computer cannot be used.', 0]);
  }
  assert.equal(calls.length, 0);
  const resumed = liveContext({ messages: [userRow('Open it'), userRow('Continue', { application_turn: 'auto_resume' })] });
  assert.equal((await tool.execute({ action: 'screenshot' }, resumed.context)).metadata.status, 'done');
});

test('the tool hands the call to the service and maps the outcome', async () => {
  const { context, calls, suspendTurnClocks } = liveContext({ messages: [userRow('Click it')] });
  const result = await tool.execute({ action: 'click', x: 1, y: 2 }, context);
  assert.equal(calls.length, 1);
  const { options } = calls[0];
  assert.deepEqual([options.sessionId, options.turnId, options.callId], ['chat', 'turn', 'call-1']);
  assert.deepEqual([options.abortSignal, options.authorize, options.suspendTurnClocks], [context.abortSignal, context.authorize, suspendTurnClocks]);
  assert.deepEqual([result.isError, result.summary, result.previewImage], [false, 'Computer: done', undefined]);
  assert.deepEqual(result.metadata, { result_kind: 'computer', status: 'done', step_summary: 'Computer: click game done' });
  assert.match(result.content, /Clicked\./);
});

test('the tool maps statuses to isError, carries the picture, and reports the human wait', async () => {
  const buffer = Buffer.from('png');
  const done = { ok: true, status: 'done', action: 'screenshot', message: 'Here.', image: { buffer, width: 4, height: 3, mime_type: 'image/png' }, width: 4, height: 3, signature: 'ab', screenChanged: true, humanWaitMs: 1200 };
  const recoverable = ['refused', 'declined', 'paused_by_user', 'busy', 'no_target', 'not_found', 'budget'];
  const fatal = ['invalid', 'failed', 'unavailable', 'cancelled'];
  for (const status of ['done', ...recoverable, ...fatal]) {
    const outcome = status === 'done' ? done : { ok: false, status, action: 'click', message: 'No.' };
    const result = await tool.execute({ action: outcome.action }, liveContext({ service: { execute: async () => outcome } }).context);
    assert.equal(result.isError, fatal.includes(status), status);
    assert.deepEqual([result.summary, result.metadata.status, result.metadata.result_kind], [`Computer: ${status}`, status, 'computer']);
  }
  const result = await tool.execute({ action: 'screenshot' }, liveContext({ service: { execute: async () => done } }).context);
  assert.deepEqual(result.previewImage, { buffer, width: 4, height: 3, mime_type: 'image/png' });
  assert.equal(result.metadata.human_wait_ms, 1200);
  assert.match(result.content, /Picture: 4 x 3 pixels; points are x 0 to 3, y 0 to 2; signature ab, screen changed: yes/);
  const thrown = await tool.execute({ action: 'screenshot' }, liveContext({ service: { execute: async () => { throw new Error('C:\\secret\\file.txt'); } } }).context);
  assert.deepEqual([thrown.metadata.status, thrown.isError, /secret/.test(thrown.content)], ['failed', true, false]);
});

test('an input step says done is not proof, and typing and keys wait twice as long before the picture (Sitting B)', async () => {
  const s = setup();
  await focused(s);
  const slept = [];
  s.world.onSleep = (ms) => slept.push(ms);
  const click = await s.run(CLICK);
  const typed = await s.run({ action: 'type', text: 'ab' });
  await s.run({ action: 'key', chord: 'enter' });
  assert.deepEqual(slept, [5, 10, 10], 'settleMs is 5 in the harness');
  assert.match(click.message, /^Sent click\. Done means the input was sent, not that it worked/);
  assert.match(typed.message, /^Typed 2 characters\. Done means the input was sent/);
});

test('a reused window handle refuses the picture; a view-only focus waits for the mouse; an unread dialog list fails closed (REVIEW 2)', async () => {
  const s = setup();
  await focused(s);
  s.world.programs[101] = 'C:\\Other\\other.exe'; // the game closed and another program's window got its handle
  const reused = await s.run({ action: 'screenshot' });
  assert.deepEqual([reused.status, s.world.ops('capture').length], ['refused', 1], 'no picture of the other program');
  assert.equal((await s.run({ action: 'screenshot' })).status, 'no_target');

  const b = { sessionId: 'chat-b' };
  const t = setup();
  await focused(t);
  assert.equal((await t.run({ action: 'focus', name: 'chrome' }, b)).status, 'busy', 'bringing a window forward takes the screen too');
  assert.equal(t.world.ops('window.show').length, 0);

  const d = setup();
  await focused(d);
  d.world.errors['windows.list'] = new Error('helper hiccup');
  const blind = await d.run(CLICK);
  assert.deepEqual([blind.status, d.world.ops('input.click').length], ['failed', 0]);
  assert.match(blind.message, /could not check for an Open or Save window/);
});

test('once a person answers a program\'s file dialog, later steps skip the window list; bad keys and a typed ref are invalid (REVIEW 2)', async () => {
  const s = setup();
  await focused(s);
  s.world.windows.push(win(150, 11, 'Open', { class: '#32770' }));
  await s.run(CLICK);
  assert.deepEqual(s.asks.map((ask) => ask.kind), ['grant', 'file_dialog']);
  s.world.reset();
  assert.equal((await s.run(CLICK)).status, 'done');
  assert.equal(s.world.ops('windows.list').length, 0);

  s.world.reset();
  for (const input of [{ action: 'key', chord: 'constructor' }, { action: 'key', chord: 'ctrl+toString' }, { action: 'type', text: 'a', ref: 'r1' }]) {
    assert.equal((await s.run(input)).status, 'invalid', JSON.stringify(input));
  }
  const badKey = await s.run({ action: 'key', chord: 'f13' });
  assert.equal(badKey.action, 'key');
  assert.match(stepSummary(badKey), /^Computer: key /);
  assert.equal(s.world.calls.length, 0);
});
