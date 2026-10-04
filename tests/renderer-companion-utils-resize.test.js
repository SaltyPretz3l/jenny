'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createCompanionManager } = require('../renderer/features/renderer-companion-utils.js');

/* A list resize (card width, zoom, type scale) re-measures the clamped
 * bodies on the next frame; teardown disconnects the observer. */
test('a list resize re-measures Show more on the next frame and dispose disconnects', (t) => {
  const observers = [];
  const frames = [];
  const saved = { ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame };
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  };
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  t.after(() => Object.assign(globalThis, saved));

  const dom = new JSDOM('<main id="home"><span id="c"></span><p id="s"></p><div id="active"></div></main>');
  const document = dom.window.document;
  const byId = (id) => document.getElementById(id);
  const loop = { followUpId: 'f1', status: 'active', title: 'Loop', body: 'Short note', actions: [] };
  const manager = createCompanionManager({
    state: {
      ui: { activeView: 'home' },
      companion: { loaded: true, openLoopsBoard: { active: [loop], deferred: [], recentResolved: [], archived: [], counts: { active: 1 } } },
    },
    dom: { homeView: byId('home'), homeOpenLoopCount: byId('c'), homeOpenLoopStatus: byId('s'), homeOpenLoopList: byId('active') },
    callbacks: {},
  });
  manager.renderHomePanel();
  manager.renderHomePanel();
  assert.equal(observers.length, 1, 'one observer for the board');
  assert.deepEqual(observers[0].targets, [byId('active')]);

  const toggle = byId('active').querySelector('[data-loop-body-toggle]');
  assert.equal(toggle.hidden, true, 'short text: the length guess hides the toggle');
  const body = byId('active').querySelector('.home-loop-body');
  Object.defineProperty(body, 'clientHeight', { value: 40 });
  Object.defineProperty(body, 'scrollHeight', { value: 90 });

  observers[0].callback([{ target: byId('active') }]);
  observers[0].callback([{ target: byId('active') }]);
  assert.equal(frames.length, 1, 'bursts coalesce into one frame');
  assert.equal(toggle.hidden, true, 'nothing is written inside the observer callback');
  frames[0]();
  assert.equal(toggle.hidden, false, 'narrower list: the clamp now cuts text, so the toggle shows');

  manager.dispose();
  assert.equal(observers[0].disconnected, true);
});
