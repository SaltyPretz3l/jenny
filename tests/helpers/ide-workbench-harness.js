'use strict';

/* Shared JSDOM rig for the renderer-ide-workbench tests: the real layout model/ops, a fake
 * #ideMain, and a commitLayout that stores the layout and calls render() (the owner's job). */

const { JSDOM } = require('jsdom');

const model = require('../../renderer/shared/workbench-layout-model');
const ops = require('../../renderer/shared/workbench-layout-ops');
const { createIdeWorkbench } = require('../../renderer/features/renderer-ide-workbench');

const LABELS = {
  explorer: 'Explorer',
  search: 'Search',
  'source-control': 'Source Control',
  terminal: 'Terminal',
  problems: 'Problems',
  run: 'Run',
  'test-runner': 'Test Runner',
  chat: 'Chat',
  changes: 'Changes',
};

function setup(opts = {}) {
  const dom = new JSDOM(
    '<!doctype html><html' + (opts.rtl ? ' dir="rtl"' : '') + '><body>'
      + '<div id="ideWorkbench"></div>'
      + '<div id="ideMain"><input id="mainInput"></div>'
      + '<input id="outside">'
      + '</body></html>',
    { pretendToBeVisual: true },
  );
  const win = dom.window;
  const doc = win.document;
  const rootEl = doc.getElementById('ideWorkbench');
  const mainEl = doc.getElementById('ideMain');
  const state = {
    layout: opts.layout || model.createDefaultLayout(),
    commits: [],
    unavailable: new Set(opts.unavailable || []),
    counts: {},
    shown: [],
    rendered: [],
    editorFocus: 0,
    menus: [],
  };
  const views = {};
  Object.keys(LABELS).forEach((id) => {
    views[id] = {
      label: () => LABELS[id],
      icon: '<svg data-icon="' + id + '"></svg>',
      count: () => state.counts[id] || 0,
      onShow: () => state.shown.push(id),
    };
  });
  const contextMenu = { show: (menuOpts) => state.menus.push(menuOpts) };
  let wb = null;
  const deps = {
    getRoot: () => rootEl,
    getLayout: () => state.layout,
    commitLayout: (next) => {
      state.layout = next;
      state.commits.push(next);
      wb.render();
    },
    views,
    isViewAvailable: (id) => !state.unavailable.has(id),
    getEditorElement: () => mainEl,
    focusEditor: () => {
      state.editorFocus += 1;
      return true;
    },
    getFontScale: () => 1,
    now: (() => {
      let t = 1000;
      return () => (t += 1);
    })(),
    contextMenu,
    onRendered: (info) => state.rendered.push(info),
  };
  Object.assign(deps, opts.deps || {});
  wb = createIdeWorkbench(deps);
  if (opts.render !== false) wb.render();

  const q = (sel) => doc.querySelector(sel);
  return {
    dom,
    win,
    doc,
    rootEl,
    mainEl,
    state,
    wb,
    model,
    ops,
    q,
    qa: (sel) => Array.from(doc.querySelectorAll(sel)),
    tab: (id) => q('[data-wb-tab="' + id + '"]'),
    strip: (id) => q('[data-wb-strip="' + id + '"]'),
    stackOf: (viewId) => model.findView(state.layout, viewId).stackId,
    stackEl: (stackId) => q('[data-wb-stack="' + stackId + '"]'),
    action: (stackId, name) => q('[data-wb-stack="' + stackId + '"] [data-wb-action="' + name + '"]'),
    sash: (key) => q('[data-wb-sash="' + key + '"]'),
    setLayout: (layout) => {
      state.layout = layout;
    },
    key: (el, key, init = {}) => {
      const ev = new win.KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, init));
      el.dispatchEvent(ev);
      return ev;
    },
    click: (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })),
  };
}

// row(left | editor over two bottom stacks | right): two views stacks share one col split.
function twoBottomLayout() {
  const { stk, editor, spl, ch, LEFT, CHAT } = require('./workbench-layout-fixtures');
  return model.normalizeLayout({
    v: 1,
    root: spl(
      'r',
      'row',
      ch(stk('L', LEFT), 300),
      ch(spl('c', 'col', ch(editor(), null), ch(stk('B1', ['terminal', 'run']), 200), ch(stk('B2', ['problems', 'test-runner']), 150)), null),
      ch(stk('R', CHAT, { collapsed: true }), 380),
    ),
  });
}

module.exports = { setup, twoBottomLayout, LABELS, model, ops };
