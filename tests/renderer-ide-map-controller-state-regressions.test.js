'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  setupDom, makeSpies, stubSiblings, graphA, okResult,
  windowStubFor, makeController, mountAndScan,
} = require('./helpers/ide-map-controller-harness');

function selectByHover(hostEl, id) {
  const tile = hostEl.ownerDocument.createElement('button');
  tile.setAttribute('data-map-node', id);
  hostEl.querySelector('.ide-map-content').appendChild(tile);
  tile.dispatchEvent(new hostEl.ownerDocument.defaultView.MouseEvent('mouseover', { bubbles: true }));
}

function pressEscape(hostEl) {
  hostEl.querySelector('.ide-map-viewport').dispatchEvent(
    new hostEl.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
}

async function setupController(t, options = {}) {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies, options.siblingOverrides || {});
  t.after(restore);
  if (typeof options.patchViewFactory === 'function') options.patchViewFactory(globalThis.rendererIdeMapAtlasView);
  const exited = [];
  const ctrl = makeController(hostEl, {
    activateStage: (stage) => exited.push(stage),
    ...(options.controllerOverrides || {}),
  });
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);
  return { hostEl, spies, exited, controls: spies.controlsDepsList.at(-1) };
}

test('turning the Deps layer off reconciles controller selection before Escape', async (t) => {
  const { hostEl, controls, exited } = await setupController(t);
  selectByHover(hostEl, 'a.js');
  controls.onLayerToggle('deps', false);
  pressEscape(hostEl);

  assert.deepEqual(exited, ['editor']);
});

test('clearing search reconciles controller selection before Escape', async (t) => {
  const { hostEl, controls, exited } = await setupController(t);
  selectByHover(hostEl, 'a.js');
  controls.onSearchClear();
  pressEscape(hostEl);

  assert.deepEqual(exited, ['editor']);
});

test('hiding the selected test reconciles controller selection before Escape', async (t) => {
  const graph = {
    nodes: [{ id: 'a.test.js', label: 'a.test.js', x: 0, y: 0, isTest: true }],
    edges: [], findings: {}, meta: {},
  };
  const { hostEl, controls, exited } = await setupController(t, {
    siblingOverrides: { graphNodes: graph.nodes },
    controllerOverrides: { windowRef: windowStubFor(graph) },
    patchViewFactory(atlasModule) {
      const create = atlasModule.createAtlasView;
      atlasModule.createAtlasView = () => {
        const view = create();
        let hideTests = false;
        const setHideTests = view.setHideTests;
        view.setHideTests = (next) => { hideTests = next === true; setHideTests(next); };
        view.isNodeNavigable = (id) => !(hideTests && id === 'a.test.js');
        return view;
      };
    },
  });
  selectByHover(hostEl, 'a.test.js');
  controls.onHideTestsChange(true);
  pressEscape(hostEl);

  assert.deepEqual(exited, ['editor']);
});

test('search submit ranks the submitted value before the debounce fires', async (t) => {
  const graph = graphA();
  const { controls, spies } = await setupController(t, {
    siblingOverrides: { graphNodes: graph.nodes },
    controllerOverrides: { windowRef: windowStubFor(graph, { getGraph: async () => okResult(graph) }) },
  });

  controls.onSearchSubmit('b.js');

  assert.equal(spies.selectionCalls.at(-1)[0], 'b.js');
  assert.match(spies.setStatusCalls.at(-1).msg, /^1\/1 · b\.js$/);
});
