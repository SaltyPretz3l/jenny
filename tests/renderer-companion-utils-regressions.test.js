const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createCompanionManager } = require('../renderer/features/renderer-companion-utils.js');

test('an open-loop body that strictly extends its title remains visible', () => {
  const dom = new JSDOM('<main id="home"><span id="activeCount"></span><p id="activeStatus"></p><div id="active"></div><section id="deferred"><span id="deferredCount"></span><p id="deferredStatus"></p><div id="deferredList"></div></section><section id="resolved"><span id="resolvedCount"></span><p id="resolvedStatus"></p><div id="resolvedList"></div></section><section id="archived"><span id="archivedCount"></span><p id="archivedStatus"></p><div id="archivedList"></div></section></main>');
  const documentRef = dom.window.document;
  const loop = {
    followUpId: 'loop-1',
    status: 'active',
    title: 'Fix parser',
    body: 'Fix parser when CRLF input is received',
    actions: [],
  };
  const state = {
    ui: { activeView: 'home' },
    companion: {
      loaded: true,
      openLoopsBoard: {
        active: [loop], deferred: [], recentResolved: [], archived: [],
        counts: { active: 1, deferred: 0, recentResolved: 0, archived: 0 },
      },
    },
  };
  const byId = (id) => documentRef.getElementById(id);
  const manager = createCompanionManager({
    state,
    dom: {
      homeView: byId('home'),
      homeOpenLoopCount: byId('activeCount'),
      homeOpenLoopStatus: byId('activeStatus'),
      homeOpenLoopList: byId('active'),
      homeDeferredSection: byId('deferred'),
      homeDeferredLoopCount: byId('deferredCount'),
      homeDeferredLoopStatus: byId('deferredStatus'),
      homeDeferredLoopList: byId('deferredList'),
      homeRecentResolvedSection: byId('resolved'),
      homeRecentResolvedCount: byId('resolvedCount'),
      homeRecentResolvedStatus: byId('resolvedStatus'),
      homeRecentResolvedList: byId('resolvedList'),
      homeArchivedSection: byId('archived'),
      homeArchivedLoopCount: byId('archivedCount'),
      homeArchivedLoopStatus: byId('archivedStatus'),
      homeArchivedLoopList: byId('archivedList'),
    },
    callbacks: {},
  });

  manager.renderHomePanel();

  assert.equal(byId('active').querySelector('.home-card-note')?.textContent, loop.body);
});
