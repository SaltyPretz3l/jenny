'use strict';

// new-test-file: the pure builders of a shared conversation's timeline (row 169; the channel's in row 171), a new surface

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const timeline = require('../renderer/team/renderer-team-project-timeline');
const questions = require('../renderer/chat/renderer-user-questions-block');

const {
  LIMITS, clean, elapsedText, reasoningText, applyReasoning, questionHtml, collectAnswers, lockQuestion, earlierHtml, heroHtml, mergeMessages,
} = timeline;

const parse = (html) => {
  const dom = new JSDOM('<!doctype html><body></body>');
  dom.window.document.body.innerHTML = html;
  return dom.window.document.body;
};
const ids = (list) => list.map((m) => m.id);
const msg = (id, extra = {}) => ({ id, role: 'user', content: id, ...extra });
const HOSTILE = '<img src=x onerror=alert(1)>"\'&';

// Owner, 2026-11-16: in the app `require` is the editor's AMD loader, and a require at load left the script undefined.
test('the script loads in the app, where require throws for a module the editor does not know', () => {
  const vm = require('node:vm');
  const source = require('node:fs').readFileSync(require.resolve('../renderer/team/renderer-team-project-timeline'), 'utf8');
  const made = [];
  const app = { rendererUserQuestionsBlock: questions, stringUtils: require('../renderer/shared/string-utils'),
    inventory: { actionButton: (options) => { made.push(options); return '<button></button>'; } },
    require: (name) => { throw new Error('Check dependency list! ' + name); } };
  app.globalThis = app;
  vm.runInNewContext(source, app);
  assert.equal(typeof app.rendererTeamProjectTimeline.groupTurns, 'function');
  assert.match(app.rendererTeamProjectTimeline.chipHtml({ turnId: 't1', label: 'Done' }), /button/);
  assert.ok(made.length > 0, 'the button came from the app\'s inventory');
});

test('the module exports exactly the contract surface', () => {
  assert.deepEqual(Object.keys(timeline).sort(), ['ENDS', 'LIMITS', 'applyReasoning', 'applyStream', 'chipHtml', 'chipState', 'clean', 'collectAnswers', 'compactionCount', 'compactionLinesHtml', 'earlierHtml', 'elapsedText', 'failureReason', 'groupTurns',
    'heroHtml', 'lockQuestion', 'mergeMessages', 'projectStream', 'questionHtml', 'reasonText', 'reasoningText', 'savedCursors', 'savedReasoningIds', 'savedTextEnd', 'startStream', 'streamAfter', 'syncQuestion',
    'turnLineHtml'].sort());
  assert.deepEqual({ ...LIMITS }, { held: 400, reasoning: 65536, entries: 128, preview: 120, status: 80, live: 262144, tools: 32 });
  assert.ok(Object.isFrozen(LIMITS));
});

test('clean strips control, bidi and zero-width characters, collapses whitespace and cuts by code point', () => {
  assert.equal(clean('a\u0000b\u0007c\u009fd'), 'abcd');
  assert.equal(clean('a\u202eb\u2066c\u2069d\u200ee\u200ff'), 'abcdef');
  assert.equal(clean('a\u200bb\u200cc\u200dd\ufeffe'), 'abcde');
  assert.equal(clean('  a \n\t  b   c  '), 'a b c');
  assert.equal(clean('x'.repeat(100)).length, 80);
  assert.equal(clean('abcdef', 3), 'abc');
  assert.equal(clean('\u{1F600}\u{1F600}\u{1F600}', 2), '\u{1F600}\u{1F600}');
  assert.equal(clean(42), '42');
  for (const junk of [null, undefined, {}, [], true, () => 1]) assert.equal(clean(junk), '');
});

test('elapsedText counts whole seconds and never goes negative', () => {
  assert.equal(elapsedText(0), '0s');
  assert.equal(elapsedText(59_999), '59s');
  assert.equal(elapsedText(60_000), '1m 00s');
  assert.equal(elapsedText(65_000), '1m 05s');
  assert.equal(elapsedText(3_725_000), '62m 05s');
  assert.equal(elapsedText(-5000), '0s');
  for (const junk of ['5', null, undefined, NaN, {}]) assert.equal(elapsedText(junk), '');
});

test('reasoningText reads a string or the text of each entry, trimmed and bounded', () => {
  assert.equal(reasoningText('  think  '), 'think');
  assert.equal(reasoningText([{ text: 'one' }, { text: '' }, null, 'raw', { text: 7 }, { text: 'two' }]), 'one\n\ntwo');
  for (const junk of [null, undefined, 5, {}, [], [null, {}]]) assert.equal(reasoningText(junk), '');
  assert.equal(reasoningText('x'.repeat(LIMITS.reasoning + 10)).length, LIMITS.reasoning);
  assert.equal(reasoningText([{ text: 'y'.repeat(LIMITS.reasoning) }, { text: 'z' }]).length, LIMITS.reasoning);
});

test('applyReasoning replaces on a full entry and appends a delta at the known length', () => {
  const list = [{ id: 'a', text: 'hello' }];
  assert.deepEqual(applyReasoning(list, [{ id: 'a', text: 'new' }, { id: 'b', text: 'second' }]), [{ id: 'a', text: 'new' }, { id: 'b', text: 'second' }]);
  assert.deepEqual(applyReasoning(list, [{ id: 'a', append: ' world', base_length: 5 }]), [{ id: 'a', text: 'hello world' }]);
  assert.deepEqual(applyReasoning(list, [{ id: 'a', append: '!', base_length: -1 }]), [{ id: 'a', text: 'hello!' }]);
  assert.deepEqual(applyReasoning(list, [{ id: 'a', append: ' w', base_length: 5 }, { id: 'a', append: 'x', base_length: 7 }]), [{ id: 'a', text: 'hello wx' }]);
});

test('applyReasoning cuts a resend, appends across a gap and starts an entry for an unknown id', () => {
  const list = [{ id: 'a', text: 'hello world' }];
  assert.deepEqual(applyReasoning(list, [{ id: 'a', append: 'p', base_length: 5 }]), [{ id: 'a', text: 'hellop' }]);
  assert.deepEqual(applyReasoning(list, [{ id: 'a', append: '?', base_length: 99 }]), [{ id: 'a', text: 'hello world?' }]);
  assert.deepEqual(applyReasoning(list, [{ id: 'z', append: 'fresh', base_length: 40 }]), [{ id: 'a', text: 'hello world' }, { id: 'z', text: 'fresh' }]);
  assert.deepEqual(applyReasoning([], [{ id: 'z', append: 'fresh', base_length: -1 }]), [{ id: 'z', text: 'fresh' }]);
});

test('applyReasoning skips junk, bounds text and entries, and never mutates its input', () => {
  const entry = { id: 'a', text: 'keep' };
  const list = [entry];
  const junk = [null, 'str', 7, [], {}, { id: '', text: 'x' }, { id: 5, text: 'x' }, { id: 'a' }, { id: 'a', text: 5 }, { id: 'a', append: 5 }];
  assert.deepEqual(applyReasoning(list, junk), [{ id: 'a', text: 'keep' }]);
  for (const wire of [null, undefined, 'x', {}]) {
    const copy = applyReasoning(list, wire);
    assert.deepEqual(copy, list);
    assert.notEqual(copy, list);
  }
  assert.deepEqual(applyReasoning('nope', [{ id: 'q', text: 't' }]), [{ id: 'q', text: 't' }]);
  const big = applyReasoning(list, [{ id: 'a', text: 'x'.repeat(LIMITS.reasoning + 5) }, { id: 'b', append: 'y'.repeat(LIMITS.reasoning + 5) }]);
  assert.equal(big[0].text.length, LIMITS.reasoning);
  assert.equal(big[1].text.length, LIMITS.reasoning);
  const many = applyReasoning([], Array.from({ length: LIMITS.entries + 5 }, (_, i) => ({ id: 'e' + i, text: String(i) })));
  assert.equal(many.length, LIMITS.entries);
  assert.equal(many[0].id, 'e5');
  assert.equal(many.at(-1).id, 'e' + (LIMITS.entries + 4));
  applyReasoning(list, [{ id: 'a', append: 'more', base_length: -1 }, { id: 'b', text: 'b' }]);
  assert.deepEqual(list, [{ id: 'a', text: 'keep' }]);
  assert.equal(list[0], entry);
  assert.equal(entry.text, 'keep');
});

test('mergeMessages: an empty held list takes the page, a gap replaces held and says so', () => {
  const page = [msg('c'), msg('d')];
  assert.deepEqual(mergeMessages([], page), { messages: page, dropped: false });
  assert.deepEqual(mergeMessages(null, page), { messages: page, dropped: false });
  assert.deepEqual(mergeMessages([], []), { messages: [], dropped: false });
  const gap = mergeMessages([msg('a'), msg('b')], page);
  assert.deepEqual(ids(gap.messages), ['c', 'd']);
  assert.equal(gap.dropped, true);
});

test('mergeMessages: an overlap keeps the earlier held messages and the page copy wins', () => {
  const held = [msg('a'), msg('b', { content: 'old b' }), msg('c', { content: 'old c' })];
  const page = [msg('b', { content: 'new b' }), msg('c', { content: 'new c' }), msg('d')];
  const merged = mergeMessages(held, page);
  assert.deepEqual(ids(merged.messages), ['a', 'b', 'c', 'd']);
  assert.deepEqual(merged.messages.map((m) => m.content), ['a', 'new b', 'new c', 'd']);
  assert.equal(merged.dropped, false);
  assert.equal(merged.messages[1], page[0]);
});

test('mergeMessages: an empty page keeps held, ids are required in held only, and the cap drops the oldest', () => {
  const held = [msg('a'), { role: 'user' }, msg('b')];
  assert.deepEqual(ids(mergeMessages(held, []).messages), ['a', 'b']);
  assert.equal(mergeMessages(held, []).dropped, false);
  const noId = { role: 'assistant', content: 'x' };
  assert.deepEqual(mergeMessages([msg('a')], [msg('a'), noId]).messages, [msg('a'), noId]);
  const long = Array.from({ length: 6 }, (_, i) => msg('m' + i));
  const capped = mergeMessages(long.slice(0, 4), long.slice(3), 4);
  assert.deepEqual(ids(capped.messages), ['m2', 'm3', 'm4', 'm5']);
  assert.equal(capped.dropped, true);
  const defaults = mergeMessages([], Array.from({ length: LIMITS.held + 1 }, (_, i) => msg('p' + i)));
  assert.equal(defaults.messages.length, LIMITS.held);
  assert.equal(defaults.messages[0].id, 'p1');
  assert.equal(defaults.dropped, true);
});

test('mergeMessages never mutates its arguments', () => {
  const held = [msg('a'), msg('b')];
  const page = [msg('b'), msg('c')];
  const before = JSON.stringify([held, page]);
  mergeMessages(held, page, 2);
  mergeMessages(held, [msg('z')]);
  assert.equal(JSON.stringify([held, page]), before);
});

const PENDING = {
  question_ref: 'ref-1', stream_id: 'stream-1', call_id: 'call-1', prompter_member_id: 'mem-1',
  questions: [{ id: 'tone', prompt: 'Which tone?', options: ['Plain', 'Warm'], allow_other: true }, { id: 'extra', prompt: 'Anything else?' }],
};

test('questionHtml wraps the real questions card with its ids and a who line', () => {
  const root = parse(questionHtml(PENDING, { prompter: 'Maya', mine: false, canAnswer: true }));
  const wrap = root.querySelector('.team-conv__question');
  assert.equal(wrap.dataset.questionRef, 'ref-1');
  assert.equal(wrap.dataset.streamId, 'stream-1');
  const card = wrap.querySelector('.user-questions-block');
  assert.equal(card.dataset.toolCallId, 'call-1');
  assert.equal(card.dataset.questionRef, 'ref-1');
  assert.equal(card.querySelectorAll('[data-user-question-id]').length, 2);
  assert.equal(wrap.firstElementChild, card);
  assert.equal(wrap.querySelector('.team-conv__who').textContent,
    'Maya\u2019s turn asked. Anyone who can write in this project and is viewing this conversation can answer.');
  assert.equal(wrap.querySelector('.team-conv__who').getAttribute('dir'), 'auto');
  assert.equal(wrap.querySelector('.team-composer__hint'), null);
});

test('questionHtml who line: mine, nobody named, read-only; the note; hostile names; no questions', () => {
  const who = (options) => parse(questionHtml(PENDING, options)).querySelector('.team-conv__who').textContent;
  assert.equal(who({ mine: true, prompter: 'Maya' }), 'Your turn asked. Anyone who can write in this project and is viewing this conversation can answer.');
  assert.equal(who({}), 'Anyone who can write in this project and is viewing this conversation can answer.');
  assert.equal(who({ prompter: 'Maya', canAnswer: false }), 'Maya\u2019s turn asked. Only members who can write in this project can answer.');
  assert.equal(who({ mine: true, canAnswer: false }), 'Your turn asked. Only members who can write in this project can answer.');
  const noted = parse(questionHtml(PENDING, { note: 'Someone answered first.' }));
  const hint = noted.querySelector('p.team-composer__hint[role="status"]');
  assert.equal(hint.textContent, 'Someone answered first.');
  assert.equal(noted.querySelector('.team-conv__question').lastElementChild, hint);
  const hostile = parse(questionHtml({ ...PENDING, question_ref: HOSTILE, stream_id: HOSTILE }, { prompter: '\u202e' + HOSTILE + '\u200b', note: HOSTILE }));
  assert.equal(hostile.querySelector('img'), null);
  assert.equal(hostile.querySelector('.team-conv__question').dataset.streamId, HOSTILE);
  assert.ok(hostile.querySelector('.team-conv__who').textContent.startsWith(HOSTILE + '\u2019s turn asked.'));
  assert.equal(hostile.querySelector('.team-composer__hint').textContent, HOSTILE);
  for (const bad of [{ ...PENDING, questions: [] }, { ...PENDING, questions: null }, { ...PENDING, question_ref: '' }, { call_id: 'c' }, null, undefined, 'str']) {
    assert.equal(questionHtml(bad, { prompter: 'Maya' }), '');
  }
});

function card() {
  return parse(questionHtml({ ...PENDING, questions: [
    { id: 'single', prompt: 'Pick one', options: ['A', 'B'], allow_other: true },
    { id: 'multi', prompt: 'Pick some', options: ['X', 'Y', 'Z'], multi_select: true, allow_other: true },
    { id: 'free', prompt: 'Say it' },
  ] }, {})).querySelector('.user-questions-block');
}
const node = (block, id) => block.querySelector('[data-user-question-id="' + id + '"]');
const tick = (el) => { el.checked = true; };

test('collectAnswers reads single, multi, Other and free text in the host shape', () => {
  const block = card();
  assert.deepEqual(collectAnswers(block), [{ question_id: 'single', answer: '' }, { question_id: 'multi', answer: [] }, { question_id: 'free', answer: '' }]);
  tick(node(block, 'single').querySelector('[data-user-question-option][value="B"]'));
  tick(node(block, 'multi').querySelector('[data-user-question-option][value="X"]'));
  tick(node(block, 'multi').querySelector('[data-user-question-option][value="Z"]'));
  node(block, 'free').querySelector('[data-user-question-free-text]').value = 'in my words';
  assert.deepEqual(collectAnswers(block), [{ question_id: 'single', answer: 'B' }, { question_id: 'multi', answer: ['X', 'Z'] }, { question_id: 'free', answer: 'in my words' }]);
});

test('collectAnswers adds Other only when ticked with text, and bounds what it reads', () => {
  const block = card();
  const single = node(block, 'single');
  single.querySelector('[data-user-question-other-input]').value = 'typed but not ticked';
  assert.equal('other' in collectAnswers(block)[0], false);
  tick(single.querySelector('[data-user-question-other-toggle]'));
  assert.deepEqual(collectAnswers(block)[0], { question_id: 'single', answer: '', other: 'typed but not ticked' });
  single.querySelector('[data-user-question-other-input]').value = '   ';
  assert.equal('other' in collectAnswers(block)[0], false);
  const multi = node(block, 'multi');
  tick(multi.querySelector('[data-user-question-option][value="Y"]'));
  tick(multi.querySelector('[data-user-question-other-toggle]'));
  multi.querySelector('[data-user-question-other-input]').value = 'o'.repeat(9000);
  const multiAnswer = collectAnswers(block)[1];
  assert.deepEqual(multiAnswer.answer, ['Y']);
  assert.equal(multiAnswer.other.length, 8000);
  node(block, 'free').querySelector('[data-user-question-free-text]').value = 'f'.repeat(9000);
  assert.equal(collectAnswers(block)[2].answer.length, 8000);
  const wide = parse('<div>' + Array.from({ length: 12 }, (_, i) => '<fieldset data-user-question-id="q' + i + '"><textarea data-user-question-free-text></textarea></fieldset>').join('') + '</div>').firstElementChild;
  assert.equal(collectAnswers(wide).length, 8);
  const longOption = parse('<div><fieldset data-user-question-id="q" data-multi-select="true"><input type="checkbox" data-user-question-option value="' + 'v'.repeat(500) + '" checked></fieldset></div>').firstElementChild;
  assert.equal(collectAnswers(longOption)[0].answer[0].length, 240);
  for (const missing of [null, undefined, {}, 'str']) assert.deepEqual(collectAnswers(missing), []);
});

test('lockQuestion locks every control, and unlocking keeps Submit disabled while nothing is answered', () => {
  const block = card();
  const submit = block.querySelector('.user-questions-submit-btn');
  const controls = [...block.querySelectorAll('button, input, textarea, select')];
  assert.ok(controls.length > 6);
  tick(node(block, 'single').querySelector('[data-user-question-option][value="A"]'));
  questions.syncUserQuestionsState(block);
  assert.equal(submit.disabled, false);
  lockQuestion(block, true);
  assert.equal(block.getAttribute('aria-busy'), 'true');
  assert.ok(controls.every((el) => el.disabled));
  lockQuestion(block, false);
  assert.equal(block.getAttribute('aria-busy'), 'false');
  assert.equal(submit.disabled, false);
  assert.ok(controls.filter((el) => el !== submit).every((el) => !el.disabled));
  const blank = card();
  lockQuestion(blank, true);
  lockQuestion(blank, false);
  assert.equal(blank.querySelector('.user-questions-submit-btn').disabled, true);
  assert.equal(blank.querySelector('.user-questions-progress').textContent, '0 of 3 answered');
  for (const missing of [null, undefined, {}, 'str']) assert.doesNotThrow(() => lockQuestion(missing, true));
});

test('earlierHtml has three states', () => {
  assert.equal(earlierHtml(), '');
  assert.equal(earlierHtml({ more: false, busy: true }), '');
  const idle = parse(earlierHtml({ more: true })).querySelector('button.team-conv__earlier');
  assert.deepEqual([idle.type, idle.dataset.projectAction, idle.title, idle.textContent, idle.disabled],
    ['button', 'earlier', 'Show the messages before these', 'Show earlier messages', false]);
  const busy = parse(earlierHtml({ more: true, busy: true })).querySelector('button.team-conv__earlier');
  assert.deepEqual([busy.disabled, busy.textContent, busy.dataset.projectAction], [true, 'Loading earlier messages\u2026', 'earlier']);
});

test('heroHtml: named project, unnamed project and a reader', () => {
  const lede = 'Everyone in the project can read it. Jenny answers on a GPU a member shares, so that member and the team host can read it too.';
  assert.equal(heroHtml({ projectName: 'jenny-site' }),
    '<div class="team-conv__hero"><h3 class="hero-title">New conversation</h3><p dir="auto">In jenny-site. ' + lede + '</p></div>');
  assert.equal(heroHtml(), '<div class="team-conv__hero"><h3 class="hero-title">New conversation</h3><p dir="auto">' + lede + '</p></div>');
  assert.equal(heroHtml({ projectName: ' \u200b ' }), heroHtml());
  const reader = parse(heroHtml({ projectName: 'jenny-site', canWrite: false })).querySelector('p');
  assert.equal(reader.textContent, 'In jenny-site. ' + lede + ' You can read here; writers and admins can send.');
  assert.equal(parse(heroHtml({ canWrite: false })).querySelector('p').textContent, lede + ' You can read here; writers and admins can send.');
  const hostile = parse(heroHtml({ projectName: '\u202e' + HOSTILE + '\u200b' + 'p'.repeat(200) }));
  assert.equal(hostile.querySelector('img'), null);
  assert.ok(hostile.querySelector('p').textContent.startsWith('In ' + HOSTILE));
  assert.equal(hostile.querySelector('p').textContent.split('. ')[0].length, 'In '.length + 80);
});

// ------------------------------------------------------------ the running turn

const { applyStream, projectStream, streamAfter } = timeline;
const ev = (type, extra = {}) => ({ stream_id: 'stream_1', event: { type, ...extra } });
const play = (events, start = 1000, step = 1000) => events.reduce((stream, event, i) => applyStream(stream, event, start + i * step), null);

test('applyStream: a turn from started to its end, with its times', () => {
  assert.equal(applyStream(null, ev('delta', { content: 'x' }), 5), null, 'no turn begun: nothing');
  const started = applyStream(null, ev('started'), 1000);
  assert.deepEqual(started, { id: 'stream_1', text: '', reasoning: [], status: '', tools: [], ended: '', startedAt: 1000, reasonedAt: 0, reasonLastAt: 0, textAt: 0, endedAt: 0 });
  const status = applyStream(started, ev('thinking_status', { text: '  Reading\u202e the plan  ' }), 2000);
  assert.equal(status.status, 'Reading the plan');
  assert.notEqual(status, started, 'a new object: the controller compares by identity');
  assert.equal(started.status, '', 'the earlier state is not mutated');
  const reasoned = applyStream(status, ev('delta', { reasoning: [{ id: 'r1', text: 'Count the characters.' }] }), 3000);
  assert.deepEqual([reasoned.reasonedAt, reasoned.text, reasoned.textAt], [3000, '', 0]);
  const more = applyStream(reasoned, ev('thinking_status', { text: 'x', reasoning: [{ id: 'r1', append: ' Then answer.', base_length: 21 }] }), 4000);
  assert.deepEqual([more.reasoning[0].text, more.reasonedAt], ['Count the characters. Then answer.', 3000]);
  const first = applyStream(more, ev('delta', { content: 'Hel' }), 9000);
  const second = applyStream(first, ev('delta', { content: 'lo' }), 9500);
  assert.deepEqual([second.text, second.textAt], ['Hello', 9000]);
  assert.equal(applyStream(second, ev('delta', { aggregate: 'Hello there' }), 9600).text, 'Hello there', 'an aggregate replaces');
  const reset = applyStream(second, ev('stream_reset'), 9700);
  assert.deepEqual([reset.text, reset.textAt], ['', 0]);
  const ended = applyStream(second, ev('complete'), 12000);
  assert.deepEqual([ended.ended, ended.endedAt], ['complete', 12000]);
  assert.equal(applyStream(ended, ev('delta', { content: '!' }), 13000), ended, 'after the end nothing changes');
  assert.equal(applyStream(ended, ev('started'), 14000).text, '', 'the next turn starts clean');
});

test('applyStream: tools by call id, capped; text capped; junk ignored', () => {
  let stream = play([ev('started'), ev('tool_use', { call_id: 'c1', tool_name: 'read_file' }), ev('tool_use', { call_id: 'c2', tool_name: 'grep_search' }),
    ev('tool_result', { call_id: 'c1' }), ev('tool_result', { call_id: 'c2', status: 'error' })]);
  assert.deepEqual(stream.tools, [{ id: 'c1', name: 'read_file', state: 'done' }, { id: 'c2', name: 'grep_search', state: 'failed' }]);
  for (let i = 0; i < 40; i += 1) stream = applyStream(stream, ev('tool_use', { call_id: 'x' + i, tool_name: 't' }), 1);
  assert.equal(stream.tools.length, LIMITS.tools);
  assert.equal(stream.tools[stream.tools.length - 1].id, 'x39');
  const big = applyStream(applyStream(null, ev('started'), 1), ev('delta', { aggregate: 'a'.repeat(LIMITS.live + 10) }), 2);
  assert.equal(big.text.length, LIMITS.live);
  assert.equal(applyStream(big, ev('delta', { content: 'more' }), 3).text.length, LIMITS.live);
  for (const junk of [null, undefined, 7, 'x', {}, { event: null }, { event: { type: 42 } }]) assert.equal(applyStream(big, junk, 4).text.length, LIMITS.live);
});

test('projectStream: a turn already running when the snapshot was read', () => {
  assert.equal(projectStream({ active_turn: null, live_projection: { assistant_text: 'x' } }, 1), null);
  assert.equal(projectStream({ active_turn: { stream_id: 's', status: 'complete' }, live_projection: { assistant_text: 'x' } }, 1), null, 'a turn that ended is not running');
  assert.equal(projectStream(null, 1), null);
  // The host's shape (server/session-snapshots.js projectLiveProjection): `assistant_text` and `reasoning` entries.
  const stream = projectStream({ active_turn: { stream_id: 'turn_stream' }, live_projection: { stream_id: 'stream_9', assistant_text: 'So far', current_segment_text: 'So far',
    reasoning: [{ id: 'r1', text: 'Thinking it over.' }] } }, 500);
  assert.deepEqual([stream.id, stream.text, stream.reasoning, stream.textAt, stream.reasonedAt, stream.ended], ['stream_9', 'So far', [{ id: 'r1', text: 'Thinking it over.' }], 500, 500, '']);
  const bare = projectStream({ active_turn: { stream_id: 'turn_stream', status: 'running' }, live_projection: null }, 7);
  assert.deepEqual([bare.id, bare.text, bare.startedAt], ['turn_stream', '', 7], 'a turn with nothing said yet is still a running turn');
});

test('streamAfter: a snapshot read while a turn runs keeps the running reply; an ended reply stays until its answer is saved', () => {
  const running = { active_turn: { stream_id: 's1', status: 'running' }, live_projection: { stream_id: 's1', assistant_text: 'Hel' } };
  const idle = { active_turn: null, live_projection: null };
  const held = applyStream(applyStream(null, { stream_id: 's1', event: { type: 'started' } }, 10), { stream_id: 's1', event: { type: 'delta', content: 'Hello there' } }, 20);
  assert.equal(streamAfter(null, running, 30, false).text, 'Hel', 'nothing held: the snapshot\'s turn');
  assert.equal(streamAfter(held, running, 30, false), held, 'the stream\'s own events are newer than the snapshot');
  const longer = streamAfter(held, { ...running, live_projection: { stream_id: 's1', assistant_text: 'Hello there, Dot' } }, 30, false);
  assert.deepEqual([longer.text, longer.startedAt, longer.textAt], ['Hello there, Dot', 10, 20], 'events were missed: the snapshot\'s words, the turn\'s own times');
  assert.equal(streamAfter(held, { ...running, active_turn: { stream_id: 's2' }, live_projection: { stream_id: 's2', assistant_text: '' } }, 30, false).id, 's2', 'another turn');
  assert.equal(streamAfter(held, idle, 30, false), null, 'the host says no turn runs');
  const ended = applyStream(held, { stream_id: 's1', event: { type: 'complete' } }, 40);
  assert.equal(streamAfter(ended, idle, 50, false), ended, 'a snapshot without the answer keeps the reply');
  assert.equal(streamAfter(ended, idle, 50, true), null, 'the snapshot holds the answer');
  assert.equal(streamAfter({ ...ended, text: '' }, idle, 50, false), null, 'nothing to keep');
});

// ------------------------------------------------------------ the unsaved tail (row 175)

const { savedCursors, savedTextEnd, savedReasoningIds } = timeline;
const seg = (content, extra = {}) => ({ id: 'seg_' + content.length, role: 'assistant', kind: '', content, ...extra });

test('savedTextEnd: a cumulative aggregate after a saved segment leaves only the unsaved remainder', () => {
  let stream = play([ev('started'), ev('delta', { content: 'Let me look.' })]);
  assert.equal(stream.text.slice(savedTextEnd(stream.text, [seg('Let me look.')])), '', 'all of it is saved');
  stream = applyStream(stream, ev('delta', { aggregate: 'Let me look.The file says hello.' }), 5000);
  const end = savedTextEnd(stream.text, [seg('Let me look.'), { role: 'assistant', kind: 'tool_use', content: '' }]);
  assert.equal(stream.text.slice(end), 'The file says hello.');
  assert.equal(savedTextEnd('Let me look.\n\nMore', [seg('Let me look.'), seg('More')]), 'Let me look.\n\nMore'.length, 'two segments, whitespace between them skipped');
  assert.equal(savedTextEnd('A fresh start', [seg('Before the reset.')]), 0, 'a segment from before a reset does not match');
  assert.equal(savedTextEnd('Let me', [seg('Let me look.')]), 6, 'a snapshot ahead of the events covers the words so far');
  assert.equal(savedTextEnd('', null), 0);
});

test('savedReasoningIds: entries a saved message holds are saved (by id or by their words); a reasoning-only segment does not duplicate', () => {
  const entries = [{ id: 'r1', text: 'First thought.' }, { id: 'live-2', text: 'Second  thought.' }, { id: 'r3', text: 'Third.' }];
  const saved = [seg('', { reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'First thought.' }, { id: 'saved-2', text: 'Second thought.' }] } })];
  assert.deepEqual(savedReasoningIds(entries, saved), ['r1', 'live-2']);
  assert.deepEqual(savedCursors({ text: 'x', reasoning: entries }, saved), { textLength: 0, reasoningIds: ['r1', 'live-2'] });
  assert.deepEqual(savedReasoningIds(entries, []), []);
});

test('stream_reset: a preserving reset clears the unsaved words only, a discarding one the live reasoning too', () => {
  const live = play([ev('started'), ev('delta', { content: 'Draft words', reasoning: [{ id: 'r1', text: 'Thinking.' }] }), ev('tool_use', { call_id: 'c1', tool_name: 'read_file' })]);
  assert.equal(live.text, 'Draft words');
  const kept = applyStream(live, ev('stream_reset', { reason: 'tool_continuation', discard_scope: 'none', preserve_prior_segments: true }), 9000);
  assert.deepEqual([kept.text, kept.textAt, kept.reasoning, kept.tools.length], ['', 0, [{ id: 'r1', text: 'Thinking.' }], 1]);
  const byReason = applyStream(live, ev('stream_reset', { reason: 'tool_continuation' }), 9000);
  assert.deepEqual([byReason.text, byReason.reasoning.length], ['', 1], 'a tool continuation with no scope field still preserves');
  for (const extra of [{ discard_scope: 'all', reason: 'provider_retry' }, { discard_scope: 'live_slice', reason: 'model_winddown' }, {}]) {
    const dropped = applyStream(live, ev('stream_reset', extra), 9000);
    assert.deepEqual([dropped.text, dropped.reasoning, dropped.reasonedAt, dropped.reasonLastAt], ['', [], 0, 0], JSON.stringify(extra));
    assert.equal(dropped.tools.length, 1, 'the tools stay');
  }
});

// ------------------------------------------------------------ row 175, wave 2: why a turn failed (F4), the compaction count (F14)

const { failureReason, reasonText, compactionCount, compactionLinesHtml, groupTurns, chipState, turnLineHtml } = timeline;

test('failureReason: a fixed map of codes to reasons; a host field is read in order, and nothing unknown gets through', () => {
  const GROUPS = { timeout: ['timeout', 'turn', 'job_timeout', 'stall_timeout', 'queue_timeout'], node_lost: ['node_lost', 'node_stopped', 'stream_incomplete'],
    pool_busy: ['pool_busy', 'no_eligible_node'], unavailable: ['team_pool_unavailable', 'model_unavailable', 'conversation_model_offline'],
    cancelled: ['service_stop', 'app_shutdown', 'dispose'], context_too_long: ['context_overflow', 'job_request_too_large', 'size_bound'], model_error: ['model_error'] };
  for (const [group, codes] of Object.entries(GROUPS)) for (const code of codes) assert.equal(failureReason({ error_code: code }), group, code);
  assert.equal(failureReason({ error_code: 'CMP-AI-0002' }), 'unavailable', 'the host\u2019s upper-case registry codes read as lower case');
  assert.equal(failureReason({ error_code: 'CMP-AI-0003' }), 'pool_busy');
  assert.equal(failureReason({ error_code: 'CMP-STREAM-INCOMPLETE' }), 'node_lost');
  assert.equal(failureReason({ error_code: 'weird', terminal_subcode: 'node_lost' }), 'node_lost', 'the next field when one is unknown');
  assert.equal(failureReason({ category: 'timeout', status: 'failed' }), 'timeout');
  assert.equal(failureReason({ cancel_reason: 'service_stop' }), 'cancelled');
  for (const bad of [{}, null, 'timeout', 7, { error_code: '' }, { error_code: 'unmapped_code' }, { error_code: '<b>timeout</b>' }, { error_code: 'timeout\n' },
    { error_code: 'x'.repeat(65) }, { error_code: { toString: () => 'timeout' } }, { error_code: ['timeout'] }, { error_code: 'constructor' }, { error_code: '__proto__' }]) {
    assert.equal(failureReason(bad), '', JSON.stringify(bad));
  }
});

test('reasonText: fixed copy for each reason, nothing for an unknown one', () => {
  const copy = ['timeout', 'node_lost', 'pool_busy', 'unavailable', 'cancelled', 'context_too_long', 'model_error'].map(reasonText);
  assert.equal(new Set(copy).size, 7);
  assert.ok(copy.every((c) => /^[A-Z].+\.$/.test(c)), 'a sentence each');
  for (const unknown of ['', 'timeouts', '<b>', null, undefined, 3, 'constructor', '__proto__']) assert.equal(reasonText(unknown), '');
});

test('applyStream: an ending keeps its reason; a completed one has none; each compaction event counts once', () => {
  const failed = play([ev('started'), ev('error', { error_code: 'CMP-AI-0002', message: 'C:\\secret\\path leaked', stack: 'at x' })]);
  assert.equal(failed.ended, 'error');
  assert.equal(failed.reason, 'unavailable');
  assert.equal(JSON.stringify(failed).includes('secret'), false, 'no raw error text is kept');
  assert.equal(play([ev('started'), ev('error', { error_code: 'strange' })]).reason, '');
  assert.equal(play([ev('started'), ev('complete', { error_code: 'timeout' })]).reason, '');
  assert.equal(play([ev('started'), ev('failed', { category: 'timeout' })]).reason, 'timeout');
  const two = play([ev('started'), ev('context_compacted', { strategy: 'micro' }), ev('delta', { content: 'x' }), ev('context_compacted', { strategy: 'summary' })]);
  assert.equal(two.compacted, 2);
  assert.equal(two.text, 'x');
  assert.equal(applyStream(play([ev('started'), ev('complete')]), ev('context_compacted'), 9000).compacted, undefined, 'nothing after the end');
});

test('groupTurns: a failed saved answer carries its reason, and the distinct compactions of the turn are counted', () => {
  const user = { id: 'u1', role: 'user', content: 'Hi', turn_id: 't1' };
  const failed = groupTurns([user, { id: 'a1', role: 'assistant', content: '', status: 'runtime_error', turn_id: 't1', error_code: 'node_lost' }]);
  assert.deepEqual([failed[1].status, failed[1].reason], ['failed', 'node_lost']);
  const done = groupTurns([user, { id: 'a1', role: 'assistant', content: 'ok', status: 'complete', turn_id: 't1', error_code: 'node_lost' }]);
  assert.equal(done[1].reason, '', 'only a failed turn has a reason');
  const timed = groupTurns([user, { id: 'a1', role: 'assistant', content: '', status: 'timeout', turn_id: 't1' }]);
  assert.equal(timed[1].reason, 'timeout', 'the saved status is a code too');
  const note = (n) => ({ strategy: 'micro', tokensBefore: 100 + n, tokensAfter: 10, occurredAt: 't' + n });
  const turn = groupTurns([user, { id: 'a1', role: 'assistant', content: 'x', turn_id: 't1', context_compacted: note(1), context_compactions: [note(1)] },
    { id: 'a2', role: 'assistant', content: 'y', turn_id: 't1', context_compacted: note(2), context_compactions: [note(1), note(2), 'bad', null] },
    { id: 'a3', role: 'assistant', content: 'z', turn_id: 't1', context_compacted: note(2) }])[1];
  assert.equal(turn.compactions, 2, 'the same event on three messages is two events');
  assert.equal(groupTurns([user, { id: 'a1', role: 'assistant', content: 'x', turn_id: 't1' }])[1].compactions, 0);
  assert.equal(compactionCount([{ context_compacted: 'yes' }, { context_compacted: {} }, { context_compactions: 'x' }, null, 3]), 1, 'an empty notice is an event');
});

test('chipState: a failed turn names its reason; the chip words do not change', () => {
  assert.deepEqual(chipState({ turn: { status: 'failed', reason: 'timeout' } }), { state: 'failed', label: 'Jenny could not finish this answer', elapsed: '', reason: 'It took too long to answer.' });
  assert.deepEqual(chipState({ turn: { status: 'failed', reason: 'bogus' } }), { state: 'failed', label: 'Jenny could not finish this answer', elapsed: '' });
  assert.equal('reason' in chipState({ turn: { status: 'stopped', reason: 'timeout' } }), false);
});

test('turnLineHtml and compactionLinesHtml: the reason and the compaction lines are escaped text under the chip', () => {
  const dom = parse(turnLineHtml({ chip: '<i>chip</i>', reason: 'It took <b>too</b> long.' }));
  assert.equal(dom.querySelector('.team-turn-line').nextElementSibling.className, 'team-turn-reason');
  assert.equal(dom.querySelector('.team-turn-reason').textContent, 'It took <b>too</b> long.');
  assert.equal(dom.querySelector('b'), null);
  assert.equal(parse(turnLineHtml({ chip: 'x' })).querySelector('.team-turn-reason'), null);
  assert.equal(compactionLinesHtml(0), '');
  assert.equal(compactionLinesHtml(-2), '');
  assert.equal(compactionLinesHtml(NaN), '');
  const lines = parse(compactionLinesHtml(2)).querySelectorAll('.team-turn-compact');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].textContent, 'Jenny summarised earlier turns to make room. Older details may be forgotten.');
  assert.equal(lines[0].getAttribute('role'), 'note');
  assert.equal(parse(compactionLinesHtml(99)).querySelectorAll('.team-turn-compact').length, 5, 'at most five lines');
});
