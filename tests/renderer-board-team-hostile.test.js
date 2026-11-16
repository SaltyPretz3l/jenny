'use strict';

// new-test-file: a new lane (row 151 hardening, slice P5-B, pass 1): every text another member, a team host or a compromised host can
// put on the team half of the Board page (names, titles, presence, answers, lists) is fed through the real page by every inert string of
// tests/helpers/board-hostile-fixtures.js. It only reads what the page drew. The page is mounted once per place, not once per pair.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const fx = require('./helpers/board-hostile-fixtures');
const K = require('./helpers/board-team-page-kit');
const actionButton = require('../renderer/inventory/action-button');
const { createProposalsView } = require('../renderer/features/board/board-proposals-view');

const { host, TEAM, PROJECT, DOT, MAYA, mount, items, heads, uid, boardId, teamBoard, flush } = K;
const BLANKS = ['', '   ', '\u0000‮\t\n'];
const VALUES = [...fx.HOSTILE.map((entry) => entry.value), ...BLANKS];
const FORMER = new Set(['Former member', 'a former member', 'Someone']);
const ISO = /⁨([^⁨⁩]*)⁩/;
const FORBIDDEN = 'script, iframe, object, embed, link, style, meta, base, img, a';
const CANARY = 'x, [onerror], [onload], [onmouseover], [onclick]';
const BAD_SCHEME = /^(javascript:|vbscript:|data:|file:)/;
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data'];
const OWNED = '.inv-context-menu, [data-board-project], [data-board-team-foot], .board-team-conv, [data-board-team-presence], [data-board-team-live], [data-board-list] [data-board-id], .inv-board-layer [data-card-id]';
const LONE_HALF = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;
const BIDI = /[‎‏‪-‮⁦⁧]/;
const pid = (i) => `project_${String(i).padStart(12, '0')}`;
const sid = (i) => `sess_${String(i).padStart(32, '0')}`;
const mid = (i) => `member_fx${String(i).padStart(4, '0')}`;
const hasControl = (text) => [...text].some((ch) => { const c = ch.charCodeAt(0); return c < 32 || (c >= 127 && c < 160) || c === 0x2028 || c === 0x2029; });

// The sentence with its one isolated name taken out: { said: 'Copied to {x}.', name }. A text that does not isolate exactly one name has no `name`.
function split(text) {
  const found = ISO.exec(text);
  return found ? { said: text.replace(ISO, '{x}'), name: found[1] } : { said: text, name: null };
}
// Every rule that holds for any string the team half draws: bounded, no split pair, no override, balanced isolates; `owned` ones carry no control character.
function checkText(text, label, owned) {
  assert.ok(text.length <= 1200, `${label}: ${text.length} characters in one string`);
  assert.ok(!/A{201}/.test(text), `${label}: a long name is cut`);
  assert.ok(!LONE_HALF.test(text), `${label}: a surrogate pair was split`);
  if (!owned) return;
  assert.ok(!BIDI.test(text), `${label}: an override or mark came through`);
  assert.equal((text.match(/⁨/g) || []).length, (text.match(/⁩/g) || []).length, `${label}: isolates are balanced`);
  assert.ok(!hasControl(text), `${label}: a control or line separator came through`);
}

function audit(m, label, toasts = true) {
  const { doc } = m;
  assert.equal(doc.querySelectorAll(FORBIDDEN).length, m.baseline, `${label}: no element a fixture's markup would make`);
  assert.equal(doc.querySelector(CANARY), null, `${label}: no canary element`);
  doc.querySelectorAll('*').forEach((el) => {
    const owned = Boolean(el.closest(OWNED));
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      assert.ok(!name.startsWith('on'), `${label}: <${el.tagName}> has ${attr.name}`);
      if (URL_ATTRS.includes(name)) assert.ok(!BAD_SCHEME.test(attr.value.trim().toLowerCase()), `${label}: <${el.tagName} ${name}>`);
      checkText(attr.value, `${label} ${el.tagName}[${name}]`, owned && !['style', 'class'].includes(name));
    }
    [...el.childNodes].filter((node) => node.nodeType === 3).forEach((node) => checkText(node.data, `${label} text`, owned && /\S/.test(node.data))); // the markup's own line breaks are not text
  });
  if (toasts) m.toasts.forEach((toast) => checkText(String(toast.message), `${label} toast`, true));
}
const mounted = async (t, options) => {
  const m = await mount(t, options);
  m.baseline = m.doc.querySelectorAll(FORBIDDEN).length;
  return m;
};
const hide = (m) => m.window.inventoryContextMenu.hide({ restoreFocus: false });
const teamName = (v) => host.memberTeam({ team_name: v });
const projectRows = () => VALUES.map((v, i) => host.project(pid(i), v, 'writer'));
const listOf = (over = {}) => host.listAnswer({ projects: projectRows(), conversations: [], ...over });
const seedTeam = (m, v) => m.window.rendererTeamStore.getTeamStore().seed({ teams: [teamName(v)] });

test('a team name and a project name are text, bounded and isolated: the menu group, its rows, the heading, the foot line and the access toast', async (t) => {
  const m = await mounted(t, { boards: [teamBoard(1, 'Plan')], answers: { projectList: () => listOf() } });
  for (const [i, v] of VALUES.entries()) {
    seedTeam(m, v);
    await K.openMenu(m);
    audit(m, `team name ${i}`);
    const group = split(heads(m)[1]);
    assert.equal(group.said, '{x} team', `group label ${i}`);
    if (BLANKS.includes(v)) assert.equal(group.name, 'Unnamed team');
    hide(m);
  }
  seedTeam(m, 'Studio');
  for (const [i] of VALUES.entries()) {
    await K.openMenu(m);
    const label = items(m)[2 + i];
    assert.ok(label, `row ${i}`);
    audit(m, `menu row ${i}`);
    assert.equal(items(m).length <= 202, true, 'bounded');
    label.click();
    await K.settle(m);
    audit(m, `project ${i}`);
    assert.equal(m.page.getProject().team.id, TEAM);
    const foot = split(m.q('[data-board-team-foot]').textContent);
    assert.deepEqual([foot.said, foot.name === m.page.getProject().name], ['Shared with the members of {x}. The host can read it.', true], `foot ${i}`);
    assert.ok(m.page.getProject().name.trim().length > 0, 'a name is shown for a project with a blank one');
    assert.ok(m.button().textContent.includes(m.page.getProject().name), 'the heading button names it');
    const rest = host.listAnswer({ projects: projectRows().filter((row) => row.id !== pid(i)), conversations: [] });
    m.bridge.push('onProject', { team_id: TEAM, kind: 'projects', ...rest });
    await K.tick();
    const lost = split(m.toasts.at(-1).message);
    assert.equal(lost.said, 'You no longer have access to {x}.', `toast ${i}`);
    assert.equal(m.page.getTeamSource(), null);
    m.bridge.push('onProject', { team_id: TEAM, kind: 'projects', ...host.listAnswer({ projects: projectRows(), conversations: [] }) });
    await K.tick();
  }
  audit(m, 'after the team project names');
});

test('Copy to a team project: the copy menu and the "Copied to" toast with every project name', async (t) => {
  const copy = teamBoard(7, 'Mine');
  const m = await mounted(t, { ownBoard: true, answers: { projectList: () => listOf(), boardImport: { ok: true, board: K.row(copy), pictures: [] } } });
  for (const [i] of VALUES.entries()) {
    m.q('[data-board-id] [data-board-action="export"]').click();
    await K.tick();
    items(m).find((el) => el.textContent.trim() === 'Copy to a team project…').click();
    await K.tick();
    if (i === 0) { audit(m, 'copy menu'); assert.equal(items(m).length <= 200, true, 'bounded'); }
    items(m)[i].click();
    await K.tick();
    const said = split(m.toasts.at(-1).message);
    assert.equal(said.said, 'Copied to {x}.', `copied ${i}`);
    assert.ok(said.name.length > 0 && said.name.length <= 201);
  }
  audit(m, 'after the copies');
});

test('a conversation title and the project name in its picker: the trigger, the rows, the group label and the empty line', async (t) => {
  const conversations = VALUES.map((v, i) => host.conversation(sid(i), pid(i), v));
  const projects = [...projectRows(), host.project(pid(900), 'Empty one', 'writer')];
  const m = await mounted(t, { boards: [teamBoard(1, 'Plan')], answers: { projectList: () => host.listAnswer({ projects, conversations }) } });
  for (const [i, v] of VALUES.entries()) {
    await K.openMenu(m);
    items(m)[2 + i].click();
    await K.settle(m);
    assert.equal(m.captured.part.openChat(), true);
    await K.tick();
    K.picker(m).click();
    await K.tick();
    audit(m, `picker ${i}`);
    const group = split(heads(m)[0]);
    assert.equal(group.said, 'Conversations in {x}', `picker group ${i}`);
    const rows = items(m).map((el) => el.textContent.trim());
    assert.equal(rows.at(-1), 'New conversation');
    assert.equal(rows.length, 2);
    assert.ok([...rows[0]].length > 0 && [...rows[0]].length <= 80, 'a title is bounded and never empty');
    if (BLANKS.includes(v)) assert.equal(rows[0], 'Untitled conversation');
    assert.equal(K.picker(m).textContent.trim(), rows[0]);
    hide(m);
  }
  await K.openMenu(m);
  items(m)[2 + VALUES.length].click();
  await K.settle(m);
  assert.deepEqual([m.q('.board-team-conv__empty').textContent, m.q('[data-board-team-conv="new"]') !== null], ['No conversation in this project yet.', true]);
  audit(m, 'empty project');
});

test('a board name from the host is cut, one line and text in the boards list, the row labels and the rename field', async (t) => {
  const boards = VALUES.map((v, i) => ({ id: `board_${uid(3000 + i)}`, name: v, rev: 1, created_at: K.NOW, updated_at: K.NOW, created_by: DOT }));
  const m = await mounted(t, { boards: [teamBoard(1, 'Plan')], answers: { boardList: { ok: true, boards } } });
  await K.pickTeam(m);
  m.qa('[data-board-id]').forEach((li, i) => {
    const name = li.getAttribute('data-board-name');
    assert.ok([...name].length <= 201, `board ${i} name is bounded`);
    assert.equal(li.querySelector('.session-row__title-text').textContent, name);
  });
  audit(m, 'board names');
  assert.equal(m.qa('[data-board-id]').length, VALUES.length);
});

// A board of one note a member, each by its own actor; every member of the roster has a hold on their note.
function authored(count) {
  let board = K.model.createBoard({ id: boardId(1), project_id: PROJECT, name: 'Plan', now: K.NOW }).board;
  for (let k = 0; k < count; k += 1) {
    const made = K.model.applyBatch(board, { batch_id: `a${k}`, board_id: board.id, actor: mid(k), ops: [{ op: 'card.add', card: { id: uid(100 + k), kind: 'note', data: { text: `n${k}` }, x: (k % 10) * 200, y: Math.floor(k / 10) * 150 } }] }, { now: K.NOW });
    assert.equal(made.ok, true, JSON.stringify(made));
    board = made.board;
  }
  // Each note is changed last by the next member, so "Last changed by" names a member too.
  for (let k = 0; k < count; k += 1) {
    const made = K.model.applyBatch(board, { batch_id: `e${k}`, board_id: board.id, actor: mid((k + 1) % count), ops: [{ op: 'card.edit', id: uid(100 + k), content_rev: 0, data: { text: `e${k}` } }] }, { now: K.NOW });
    assert.equal(made.ok, true, JSON.stringify(made));
    board = made.board;
  }
  return board;
}
const roster = () => K.members([[DOT, 'Dot'], ...VALUES.map((v, i) => [mid(i), v])]);
const memberMount = async (t) => {
  const board = authored(VALUES.length);
  const m = await mounted(t, { boards: [board], answers: { members: roster(), boardOpen: K.opened(board, { viewers: [DOT], cursors: [], locks: [] }) } });
  await K.pickTeam(m);
  assert.equal(m.captured.part.openChat(), true);
  await K.tick();
  return m;
};
const noteOf = (k) => uid(100 + k);

test('a member name: the viewers line in its three forms, the pointer and the typing label', async (t) => {
  const m = await memberMount(t);
  const line = () => m.q('.board-team-conv__viewers').textContent;
  const live = () => (m.q('[data-board-team-live]') || {}).textContent || '';
  for (const [i, v] of VALUES.entries()) {
    const ids = [mid(i), mid((i + 1) % VALUES.length), mid((i + 2) % VALUES.length)];
    for (const [n, said] of [[1, '{x} and you are viewing'], [2, '{x}, {x2} and you are viewing'], [3, '{x}, {x2} and 1 more are viewing']]) {
      K.pushPresence(m, { viewers: [DOT, ...ids.slice(0, n)], cursors: [], locks: [] });
      const text = line();
      const first = ISO.exec(text);
      assert.ok(first, `viewers ${n} ${i}: the first name is isolated`);
      assert.equal(text.replace(/⁨[^⁨⁩]*⁩/g, (x, offset) => (offset === first.index ? '{x}' : '{x2}')), said, `viewers form ${n} ${i}`);
      if (n === 1 && BLANKS.includes(v)) assert.equal(first[1], 'a former member');
    }
    audit(m, `viewers ${i}`, false);
    assert.equal(live().includes('\u0000'), false);
  }
  // Pointers, eight at a time (the team's size): the label is the name, or the unknown-member words.
  for (let from = 0; from < VALUES.length; from += 8) {
    const slice = VALUES.slice(from, from + 8).map((v, j) => ({ member_id: mid(from + j), x: 10 * j, y: 5, selected: [] }));
    K.pushPresence(m, { viewers: [DOT], cursors: slice, locks: [] });
    const labels = m.qa('.board-team-cursor').map((el) => el.textContent);
    assert.equal(labels.length, slice.length);
    labels.forEach((label, j) => { assert.ok([...label].length > 0 && [...label].length <= 64, `pointer ${from + j}`); if (BLANKS.includes(VALUES[from + j])) assert.ok(FORMER.has(label)); });
    audit(m, `pointers ${from}`, false);
  }
  // Typing: every note held by its own member.
  K.pushPresence(m, { viewers: [DOT], cursors: [], locks: VALUES.map((_v, i) => ({ card_id: noteOf(i), member_id: mid(i) })) });
  const holds = m.qa('.board-team-hold').map((el) => el.textContent);
  assert.equal(holds.length, VALUES.length);
  holds.forEach((text, i) => {
    const said = split(text);
    assert.equal(said.said, '{x} is typing', `typing ${i}`);
    assert.ok(said.name.length > 0, 'never a bare "is typing"');
    if (BLANKS.includes(VALUES[i])) assert.ok(FORMER.has(said.name));
  });
  audit(m, 'typing');
});

test('a member name: who added a card, who holds a note, who asked Jenny', async (t) => {
  const m = await memberMount(t);
  const tip = (k) => m.q(`[data-card-id="${noteOf(k)}"]`).getAttribute('title');
  K.pushPresence(m, { viewers: [DOT], cursors: [], locks: VALUES.map((_v, i) => ({ card_id: noteOf(i), member_id: mid(i) })) });
  for (const [i, v] of VALUES.entries()) {
    const said = tip(i).replace(/⁨([^⁨⁩]*)⁩/g, (_all, name) => { assert.ok([...name].length > 0 && [...name].length <= 64, `a name of ${i} is bounded`); return '{x}'; });
    assert.match(said, /^Added by (\{x\}|a former member)(\. Last changed by (\{x\}|a former member))?\.?$/, `added by ${i}: ${said}`);
    if (BLANKS.includes(v)) assert.ok(said.includes('a former member'), `a blank name is a former member (${i})`);
    m.captured.ctx.canvas.startEdit(noteOf(i));
    await K.tick();
    const held = split(m.toasts.at(-1).message);
    assert.ok(['{x} is editing this note.', 'Someone is editing this note.'].includes(held.said), `held ${i}: ${held.said}`);
    if (held.name === null) assert.ok(BLANKS.includes(v));
  }
  audit(m, 'who added and held');
  // The proposals view of this page asks the part for the name, as the page does.
  const { window } = new JSDOM('<!doctype html><body><div class="canvas"><div class="layer"></div></div><div id="host"></div></body>', { url: 'https://jenny.invalid/' });
  const doc = window.document;
  t.after(() => window.close());
  for (const [i, v] of VALUES.entries()) {
    const view = createProposalsView({ document: doc, windowRef: window, actionButton, notify() {}, log() {},
      editor: { getBoard: () => ({ id: boardId(1) }), onChange: () => () => {} },
      source: { listProposals: async () => ({ ok: true, proposals: [{ id: 'p1', sessionId: K.S1, messageId: 'm1', state: 'pending', open: true, createdAt: K.NOW, madeAgainstRev: 1, overflow: 0, prompterMemberId: mid(i),
        counts: { total: 1, pending: 1, additions: 1, edits: 0, removals: 0, applied: 0, refused: 0, skipped: 0, rejected: 0 }, changes: [{ n: 1, line: 'note', type: 'note', class: 'addition', state: 'pending', reason: '', summary: { text: 'A', group: '' } }], preview: null }] }),
        decideProposal: async () => ({ ok: true }), onChanged: () => () => {} },
      surface: { element: doc.querySelector('.canvas'), layer: doc.querySelector('.layer') },
      context: { getChangesHost: () => doc.getElementById('host'), revealChanges: () => true, getTeamSource: () => ({ whyNot: () => '' }),
        nameOfMember: (id) => m.captured.part.nameOf(id), isSelfMember: (id) => m.captured.part.isSelf(id) } });
    await flush();
    const bar = doc.querySelector('.board-proposal-bar__by');
    const line = doc.querySelector('.board-changes__asked');
    if (bar) {
      assert.equal(split(bar.textContent).said, 'asked by {x}', `asked by ${i}`);
      assert.equal(split(line.textContent).said, '{x} asked. Anyone who can write in this project and is viewing this board can answer.');
    } else assert.ok(BLANKS.includes(v), `a name drew no asked line only when it is blank (${i})`);
    view.dispose();
    doc.getElementById('host').textContent = '';
  }
});

test('a member, project, board, card or conversation id named like a property of Object never reads one', async (t) => {
  const KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
  for (const key of KEYS) {
    const team = await mounted(t, { boards: [teamBoard(1, 'Plan')], rows: [host.memberTeam({ team_id: key })] });
    await K.openMenu(team);
    assert.equal(items(team).length, 4, `a team named ${key}: its projects are listed`);
    await K.chooseAt(team, 2);
    assert.equal(team.page.getProject().team.id, key);
    audit(team, `team id ${key}`);
  }
  const board = teamBoard(1, 'Plan', K.note(1, 'hello'));
  const conversations = KEYS.map((key) => host.conversation(key, KEYS[0] === key ? pid(1) : PROJECT, `Chat ${key}`));
  const people = K.members([[DOT, 'Dot'], ...KEYS.map((key) => [key, `Name of ${key}`])]);
  const m = await mounted(t, { boards: [board], answers: { members: people, projectList: host.listAnswer({ projects: [host.project(PROJECT, 'jenny-site', 'writer'), ...KEYS.map((key) => host.project(key, `Project ${key}`, 'writer'))], conversations }),
    boardOpen: K.opened(board, { viewers: [DOT], cursors: [], locks: [] }),
    boardList: { ok: true, boards: [K.row(board), ...KEYS.map((key) => ({ ...K.row(board), id: key, name: `Board ${key}` }))] } } });
  await K.openMenu(m);
  assert.ok(items(m).length >= 3, 'the menu is drawn with such project ids');
  hide(m);
  await K.pickTeam(m);
  assert.equal(m.captured.part.openChat(), true);
  await K.tick();
  K.pushPresence(m, { viewers: [DOT, ...KEYS], cursors: KEYS.map((key, i) => ({ member_id: key, x: i, y: i, selected: [] })), locks: KEYS.map((key) => ({ card_id: key, member_id: key })) });
  assert.deepEqual(m.qa('.board-team-cursor').map((el) => el.textContent).sort(), KEYS.map((key) => `Name of ${key}`).sort());
  assert.equal(m.qa('.board-team-hold').length, 0, 'a card id that is a property name is no card');
  // Answers whose reason words are property names are the generic sentence, never a function or a prototype.
  const source = m.page.getTeamSource();
  for (const reason of KEYS) {
    m.bridge.answers.boardCreate = { ok: false, error: { reason }, board: { reason } };
    const result = await source.create({ name: 'x' });
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string', `reason ${reason}`);
    assert.ok(result.message === undefined || typeof result.message === 'string');
  }
  audit(m, 'prototype keys');
});

test('a name keeps what joins its letters and emoji; direction controls leave no gap; joiners alone are no name', () => {
  const { cleanText } = require('../renderer/features/board/board-source-team');
  const coder = '\u{1f469}‍\u{1f4bb} Dev';
  const persian = 'می‌خواهم';
  assert.deepEqual([cleanText(coder), cleanText(persian), cleanText('ab‮cd​'), cleanText('a b'), cleanText('‍‌ '), cleanText('‮⁦')], [coder, persian, 'abcd', 'a b', '', '']);
});

const cursors = (m) => m.qa('.inv-board-layer .board-team-cursor');
const holds = (m) => m.qa('.inv-board-layer .board-team-hold');

test('presence pushes that are malformed, too many, for someone else or for another board draw nothing wrong and later pushes still draw', async (t) => {
  const people = K.members([[DOT, 'Dot'], [MAYA, 'Maya'], ...Array.from({ length: 7 }, (_x, i) => [`member_p${i}`, `P${i}`])]);
  const m = await K.presenceMount(t, { answers: { members: people, boardOpen: K.opened(teamBoard(1, 'Plan', K.note(1, 'hello')), K.PRESENCE) } });
  await K.pickTeam(m);
  await K.tick();
  assert.equal(cursors(m).length, 1, 'this member own pointer is not drawn');
  const bad = [NaN, Infinity, -Infinity, '5', null, undefined, {}, 1e308, -1e308, 1e7];
  for (const value of bad) {
    K.pushPresence(m, { viewers: [DOT, MAYA], cursors: [{ member_id: MAYA, x: value, y: 5, selected: [] }, { member_id: MAYA, x: 5, y: value, selected: [] }], locks: [] });
    assert.equal(cursors(m).length, 0, `x or y ${String(value)} draws no pointer`);
  }
  K.pushPresence(m, { viewers: [DOT, MAYA], cursors: [{ member_id: MAYA }, null, 7, 'x', { x: 1, y: 1 }, { member_id: 5, x: 1, y: 1 }, { member_id: {}, x: 1, y: 1 }], locks: [] });
  assert.equal(cursors(m).length, 0);
  K.pushPresence(m, { viewers: [DOT, MAYA], cursors: [{ member_id: MAYA, x: 30, y: 40, selected: [] }], locks: [] });
  assert.deepEqual(cursors(m).map((el) => [el.textContent, el.style.left]), [['Maya', '30px']], 'a valid push after the bad ones draws');
  // 10,000 pointers and viewers: at most the team's eight members, no id as a name, this member never.
  const many = Array.from({ length: 10000 }, (_x, i) => ({ member_id: i === 5000 ? DOT : `member_zz${i}`, x: i % 500, y: 3, selected: [] }));
  K.pushPresence(m, { viewers: [DOT, ...many.map((c) => c.member_id)], cursors: [...many, ...Array.from({ length: 7 }, (_x, i) => ({ member_id: `member_p${i}`, x: 1, y: 1, selected: [] }))], locks: [] });
  assert.ok(cursors(m).length <= 8, `${cursors(m).length} pointers`);
  cursors(m).forEach((el) => { assert.ok(!el.textContent.includes('member_'), 'no id is shown as a name'); assert.equal(el.getAttribute('aria-hidden'), 'true'); });
  assert.equal(cursors(m).some((el) => el.textContent === 'You'), false);
  assert.equal(m.qa('.inv-board-layer .board-team-cursor, .board-team-presence').length <= 9, true);
  if (m.captured.part.openChat()) { await K.tick(); const text = m.q('.board-team-conv__viewers').textContent; assert.ok(!/\d{3,}/.test(text), `no count above the team's size: ${text}`); }
  K.pushPresence(m, { viewers: [DOT, MAYA], cursors: [{ member_id: MAYA, x: 9, y: 9, selected: [] }], locks: [] });
  assert.deepEqual(cursors(m).map((el) => el.textContent), ['Maya']);
  // Another board, another project, another team: nothing changes.
  const before = m.q('.inv-board-layer').innerHTML;
  K.pushPresence(m, { viewers: [DOT, MAYA], cursors: [{ member_id: MAYA, x: 500, y: 500, selected: [] }], locks: [] }, boardId(99));
  m.bridge.push('onBoard', { kind: 'presence', team_id: TEAM, project_id: K.P2, board_id: boardId(1), viewers: [], cursors: [{ member_id: MAYA, x: 600, y: 6, selected: [] }], locks: [] });
  m.bridge.push('onBoard', { kind: 'presence', team_id: 'team_other', project_id: PROJECT, board_id: boardId(1), viewers: [], cursors: [{ member_id: MAYA, x: 600, y: 6, selected: [] }], locks: [] });
  assert.equal(m.q('.inv-board-layer').innerHTML, before);
  m.captured.part.dispose();
});

test('lock pushes for a card that is not there, with a holder that is no string, or 10,000 of them: one label a card and none for unknown cards', async (t) => {
  const m = await K.presenceMount(t);
  await K.pickTeam(m);
  await K.tick();
  assert.equal(holds(m).length, 1);
  for (const member_id of [123, null, undefined, {}, [], true]) {
    K.pushPresence(m, { viewers: [DOT], cursors: [], locks: [{ card_id: uid(101), member_id }] });
    holds(m).forEach((el) => assert.ok(!/undefined|null|\[object|true|123/.test(el.textContent), `holder ${String(member_id)}: ${el.textContent}`));
    assert.ok(holds(m).length <= 1);
  }
  K.pushPresence(m, { viewers: [DOT], cursors: [], locks: [{ card_id: uid(777), member_id: MAYA }, { card_id: 5, member_id: MAYA }, null, 'x', { member_id: MAYA }, { card_id: 'constructor', member_id: MAYA }, { card_id: '__proto__', member_id: MAYA }] });
  assert.equal(holds(m).length, 0, 'no label for a card that is not on the board');
  const locks = [{ card_id: uid(101), member_id: MAYA }, { card_id: uid(101), member_id: DOT }, { card_id: uid(101), member_id: 'member_x' }, ...Array.from({ length: 10000 }, (_x, i) => ({ card_id: uid(5000 + i), member_id: MAYA }))];
  K.pushPresence(m, { viewers: [DOT], cursors: [], locks });
  assert.deepEqual(holds(m).map((el) => split(el.textContent).said), ['{x} is typing'], 'one label for the one card');
  K.pushPresence(m, { viewers: [DOT], cursors: [], locks: [] });
  assert.equal(holds(m).length, 0);
});

const SHAPES = [null, 'text', 5, [], {}, { ok: true }, { ok: true, board: 'x', asset: 5, bytes: 0, proposal: 'x' }, { ok: false }, { ok: false, error: 'x' }, { ok: false, error: { reason: 5 } },
  { ok: false, error: { reason: 'q'.repeat(100000) } }, { ok: false, error: { reason: 'team_board_refused' }, board: { reason: 'x'.repeat(100000), detail: 'y'.repeat(100000), limit: 'z'.repeat(100000) } },
  ...fx.HOSTILE.flatMap(({ value }) => [{ ok: false, error: { reason: value, code: value }, message: value }, { ok: false, error: { reason: 'team_board_refused' }, board: { reason: value, detail: value, limit: value } }])];

test('answers from the host that are not what was asked for become the file\'s own sentences, never the host\'s words', async (t) => {
  const m = await mounted(t, { boards: [teamBoard(1, 'Plan')] });
  await K.pickTeam(m);
  const source = m.page.getTeamSource();
  await K.tick();
  m.bridge.answers.boardOpen = K.opened(teamBoard(1, 'Plan'));
  const calls = { create: { name: 'x' }, rename: { boardId: boardId(1), name: 'x' }, delete: { boardId: boardId(1) }, restore: { boardId: boardId(1) }, apply: { boardId: boardId(1), batch: { batch_id: 'b', ops: [] } },
    importBoard: teamBoard(2, 'Copy'), addAsset: { boardId: boardId(1), bytes: new Uint8Array(1) }, readAsset: { boardId: boardId(1), asset: 'a'.repeat(64) },
    decideProposal: { boardId: boardId(1), proposalId: 'p', action: 'accept_additions' }, listProposals: { boardId: boardId(1) }, get: { boardId: boardId(1) } };
  const bridgeOf = { create: 'boardCreate', rename: 'boardRename', delete: 'boardDelete', restore: 'boardRestore', apply: 'boardApply', importBoard: 'boardImport', addAsset: 'boardAssetAdd', readAsset: 'boardAssetRead',
    decideProposal: 'boardProposalAccept', listProposals: 'boardProposals', get: 'boardOpen' };
  const needs = { create: 'board', restore: 'board', importBoard: 'board', get: 'board' };
  const WORDS = /^[a-z_]{1,40}$/;
  const generic = (await (async () => { m.bridge.answers.boardCreate = { ok: false, error: { reason: 'zz_unknown_reason' } }; return source.create({ name: 'x' }); })()).message || '';
  for (const [name, request] of Object.entries(calls)) {
    for (const [i, shape] of SHAPES.entries()) {
      m.bridge.answers[bridgeOf[name]] = shape;
      const result = await (name === 'importBoard' ? source.importBoard(request) : source[name](request));
      const label = `${name} shape ${i}`;
      assert.equal(typeof result, 'object', label);
      assert.equal(typeof result.ok, 'boolean', label);
      if (result.ok) {
        if (needs[name]) assert.ok(result.board && typeof result.board === 'object' || result.readOnly === true, `${label}: ok with no board`);
        if (name === 'addAsset') assert.equal(typeof result.asset, 'string', label);
        if (name === 'readAsset') assert.ok(result.bytes, label);
        if (name === 'decideProposal') assert.equal(typeof result.proposal, 'object', label);
        continue;
      }
      assert.match(result.reason, WORDS, `${label}: reason is one of the board's words`);
      ['detail', 'limit'].forEach((key) => { if (result[key] !== undefined) assert.match(String(result[key]), /^[A-Za-z0-9_.:-]{1,60}$/, `${label}: ${key}`); });
      if (result.message !== undefined) {
        assert.equal(typeof result.message, 'string', label);
        assert.ok(result.message.length <= 300, `${label}: a sentence, not the host's 100,000 characters`);
        assert.ok(!fx.HOSTILE.some(({ value }) => value.length > 5 && result.message.includes(value)), `${label}: the host's words came through`);
        if (!SHAPES[i] || !SHAPES[i].error || typeof SHAPES[i].error.reason !== 'string' || !/^team_/.test(SHAPES[i].error.reason)) assert.ok(result.message === generic || result.message === '' || /^[A-Z]/.test(result.message), label);
      }
    }
  }
  // Through the page: New board with a shape draws the page's sentence in a toast.
  for (const shape of SHAPES.slice(0, 14)) {
    m.bridge.answers.boardCreate = shape;
    m.q('[data-board-action="new"]').click();
    await K.tick();
  }
  m.toasts.forEach((toast) => { assert.ok(String(toast.message).length <= 300); });
  audit(m, 'after the answers');
});

const LISTS = [['not an array', 'x'], ['objects', { a: 1 }], ['null entries', [null, 5, 'x', undefined, []]], ['no id', [{ name: 'No id' }, { id: 5, name: 'Number id' }, { id: '', name: 'Empty id' }]],
  ['duplicates', [{ id: 'p', name: 'One' }, { id: 'p', name: 'Two' }]], ['10,000 entries', Array.from({ length: 10000 }, (_x, i) => ({ id: pid(i), name: `Project ${i}` }))]];
const uniqueValues = (els) => { const seen = els.map((el) => el.getAttribute('data-value')); return new Set(seen).size === seen.length; };

test('a project list that is not what the store expects: no throw, rows without an id are skipped, a duplicate is shown once, and the menu is bounded', async (t) => {
  for (const [label, shape] of LISTS) {
    const projects = Array.isArray(shape) ? shape.map((row) => (row && typeof row === 'object' && !Array.isArray(row) ? host.project(row.id, row.name || 'x', 'writer') : row)) : shape;
    const m = await mounted(t, { answers: { projectList: { ok: true, projects, conversations: [], files_supported: true, truncated: false } } });
    const timers = [];
    m.window.setTimeout = (fn) => { timers.push(fn); return timers.length; }; // the wait for a list that never comes is the test's own clock
    await K.openMenu(m);
    timers.splice(0).forEach((fn) => fn());
    await K.tick();
    const rows = items(m);
    assert.ok(rows.length >= 2 && rows.length <= 410, `${label}: ${rows.length} rows`);
    assert.ok(uniqueValues(rows), `${label}: a project once`);
    assert.ok(rows.every((el) => el.textContent.trim().length > 0), `${label}: no empty row`);
    assert.ok(!rows.some((el) => /No id|Number id|Empty id/.test(el.textContent)), `${label}: rows without a usable id are skipped`);
    audit(m, label);
  }
});

test('a conversation list and a board list that are not what the store expects: no throw, skipped, shown once, bounded', async (t) => {
  for (const [label, shape] of LISTS) {
    const conv = Array.isArray(shape) ? shape.map((row) => (row && typeof row === 'object' && !Array.isArray(row) ? { session_id: row.id, title: row.name || 'x', project_id: PROJECT } : row)) : shape;
    const boards = Array.isArray(shape) ? shape.map((row) => (row && typeof row === 'object' && !Array.isArray(row) ? { id: row.id, name: row.name || 'x', rev: 1, created_at: K.NOW, updated_at: K.NOW, created_by: DOT } : row)) : shape;
    const m = await mounted(t, { boards: [teamBoard(1, 'Plan')], answers: { projectList: { ok: true, projects: [host.project(PROJECT, 'jenny-site', 'writer')], conversations: conv, files_supported: true, truncated: false }, boardList: { ok: true, boards } } });
    await K.pickTeam(m);
    assert.equal(m.captured.part.openChat(), true, label);
    await K.tick();
    K.picker(m).click();
    await K.tick();
    const rows = items(m);
    assert.ok(rows.length >= 1 && rows.length <= 201, `${label}: ${rows.length} conversation rows`);
    assert.ok(uniqueValues(rows), `${label}: a conversation once`);
    assert.ok(!rows.some((el) => /No id|Number id|Empty id/.test(el.textContent)), `${label}: skipped`);
    hide(m);
    const names = m.qa('[data-board-id]').map((el) => el.getAttribute('data-board-id'));
    assert.ok(names.length <= 200 && new Set(names).size === names.length, `${label}: ${names.length} board rows`);
    assert.ok(!m.qa('[data-board-id]').some((el) => /No id|Number id|Empty id/.test(el.textContent)), `${label}: boards without an id are skipped`);
    audit(m, label);
  }
});

test('dispose after all of it leaves no node and no listener of the team half', async (t) => {
  const m = await K.presenceMount(t);
  const baseline = m.bridge.listeners();
  await K.pickTeam(m);
  assert.equal(m.captured.part.openChat(), true);
  await K.tick();
  K.pushPresence(m, { viewers: [DOT, ...Array.from({ length: 50 }, (_x, i) => `member_d${i}`)], cursors: [{ member_id: MAYA, x: NaN, y: 1 }, { member_id: MAYA, x: 4, y: 4 }], locks: [{ card_id: uid(101), member_id: MAYA }, { card_id: 'constructor', member_id: 1 }] });
  K.picker(m).click();
  await K.tick();
  assert.ok(m.bridge.listeners() > baseline);
  m.page.dispose();
  assert.deepEqual([m.bridge.listeners(), m.qa('[data-board-team-presence], .board-team-conv, [data-board-team-live], .board-team-cursor, .board-team-hold, .inv-context-menu').length], [baseline, 0]);
});
