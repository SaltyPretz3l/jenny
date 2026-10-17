'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createImageViewer } = require('../renderer/features/renderer-image-viewer');
const { createOverlayManager } = require('../renderer/shell/renderer-overlay-manager');
const source = 'data:image/png;base64,aGVsbG8=';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(overrides = {}) {
  const dom = new JSDOM('<main id="appShell"><button id="origin">Image</button><button id="fallback">Fallback</button></main>');
  const doc = dom.window.document;
  const manager = createOverlayManager({ documentRef: doc });
  const calls = [];
  const viewer = createImageViewer({ documentRef: doc, windowRef: dom.window, overlayManager: manager,
    readArtifact: async (...args) => { calls.push(['read', ...args]); return { asset_data_url: source }; },
    getCapabilities: async () => ({ openWith: true }),
    onAction: async (...args) => { calls.push(['action', ...args]); return { ok: true }; },
    fallbackFocusTo: doc.getElementById('fallback'), ...overrides });
  const click = (action) => doc.querySelector(`[data-image-viewer-action="${action}"]`).click();
  const load = (width = 1000, height = 500) => {
    const image = doc.querySelector('.image-viewer-image');
    Object.defineProperties(image, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true } });
    doc.querySelector('.image-viewer-stage').getBoundingClientRect = () => ({ width: 800, height: 600, left: 0, top: 0 });
    image.dispatchEvent(new dom.window.Event('load'));
    return image;
  };
  return { dom, doc, manager, calls, viewer, click, load };
}

test('fits initially, zooms within bounds, rotates view only, resets and delegates original artifact IDs', async (t) => {
  const h = harness();
  t.after(() => { h.viewer.dispose(); h.dom.window.close(); });
  const origin = h.doc.getElementById('origin');
  await h.viewer.open({ sessionId: 'split-session', artifactId: 'screenshot', contextNode: origin });
  assert.equal(h.manager.getDepth(), 1);
  assert.equal(h.doc.querySelector('main').hasAttribute('inert'), true);
  const image = h.load();
  assert.match(image.style.transform, /scale\(0.752\)/);
  assert.equal(h.doc.querySelector('[role="status"]').textContent, '', 'no load-time status note');
  h.click('actual');
  h.click('rotate-right');
  assert.match(image.style.transform, /rotate\(90deg\) scale\(1\)/);
  assert.equal(image.src, source);
  const percent = h.doc.querySelector('.image-viewer-percent');
  percent.value = '1000'; percent.dispatchEvent(new h.dom.window.Event('change'));
  assert.equal(percent.value, '800');
  percent.value = '1'; percent.dispatchEvent(new h.dom.window.Event('change'));
  assert.equal(percent.value, '1');
  h.click('reset');
  assert.match(image.style.transform, /rotate\(0deg\) scale\(0.752\)/);
  for (const action of ['copy', 'save-as', 'open', 'open-with', 'reveal']) { h.click(action); await tick(); }
  assert.deepEqual(h.calls.filter((call) => call[0] === 'action'), ['copy', 'save-as', 'open', 'open-with', 'reveal']
    .map((action) => ['action', action, { kind: 'artifact', sessionId: 'split-session', artifactId: 'screenshot' }]));
  h.doc.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.doc.getElementById('imageViewer'), null);
  assert.equal(h.manager.getDepth(), 0);
  assert.equal(h.doc.querySelector('main').hasAttribute('inert'), false);
  assert.equal(h.doc.activeElement, origin);
  assert.equal(image.hasAttribute('src'), false);
});

test('pointer-centered wheel zoom, drag and keyboard pan adjust only the visible transform', async (t) => {
  const h = harness(); t.after(() => h.viewer.dispose());
  await h.viewer.open({ sessionId: 's', artifactId: 'a' });
  const image = h.load(); h.click('actual');
  const stage = h.doc.querySelector('.image-viewer-stage');
  stage.dispatchEvent(new h.dom.window.WheelEvent('wheel', { deltaY: -100, clientX: 600, clientY: 300, cancelable: true }));
  const scale = Math.exp(0.2);
  assert.match(image.style.transform, new RegExp(`scale\\(${scale}\\)`));
  assert.ok(image.style.transform.includes(`translate(${200 - 200 * scale}px, 0px)`));
  stage.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.ok(image.style.transform.includes(`translate(${200 - 200 * scale + 40}px, 0px)`));
  const pointer = (type, x, y) => {
    const event = new h.dom.window.MouseEvent(type, { button: 0, clientX: x, clientY: y, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 1 }); stage.dispatchEvent(event);
  };
  const before = image.style.transform;
  pointer('pointerdown', 10, 10); pointer('pointermove', 30, 40); pointer('pointerup', 30, 40);
  assert.notEqual(image.style.transform, before);
  assert.equal(stage.classList.contains('image-viewer-stage--dragging'), false);
  assert.equal(image.src, source);
});

test('fit can go below 10%, corrupt and missing reads stay closable with redacted status', async (t) => {
  const h = harness(); t.after(() => h.viewer.dispose());
  await h.viewer.open({ sessionId: 's', artifactId: 'a' });
  h.load(20000, 10000);
  assert.equal(h.doc.querySelector('.image-viewer-percent').value, '3.8');
  h.doc.querySelector('img').dispatchEvent(new h.dom.window.Event('error'));
  assert.match(h.doc.querySelector('[role="status"]').textContent, /unavailable/);
  assert.equal(h.doc.querySelector('[data-image-viewer-action="copy"]').disabled, true);
  h.click('close');
  const failure = harness({ readArtifact: async () => { throw new Error('secret C:/private/path'); } });
  t.after(() => failure.viewer.dispose());
  await failure.viewer.open({ sessionId: 's', artifactId: 'a' });
  assert.doesNotMatch(failure.doc.body.textContent, /secret|private/);
  failure.click('close');
});

test('close/reopen fences stale reads, action results, capabilities, disposal and focus fallback', async (t) => {
  let resolveRead;
  let resolveAction;
  let resolveCapabilities;
  const h = harness({ readArtifact: () => new Promise((resolve) => { resolveRead = resolve; }),
    onAction: () => new Promise((resolve) => { resolveAction = resolve; }),
    getCapabilities: () => new Promise((resolve) => { resolveCapabilities = resolve; }) });
  t.after(() => h.viewer.dispose());
  const first = h.viewer.open({ sessionId: 'old', artifactId: 'old' });
  await tick();
  const staleRead = resolveRead; const staleCapabilities = resolveCapabilities;
  h.viewer.close();
  const origin = h.doc.getElementById('origin');
  const second = h.viewer.open({ sessionId: 'new', artifactId: 'new', contextNode: origin });
  await tick();
  staleRead({ asset_data_url: source }); staleCapabilities({ openWith: true }); await first;
  assert.equal(h.doc.querySelector('img').hasAttribute('src'), false);
  resolveRead({ asset_data_url: source }); resolveCapabilities({ openWith: false }); await second;
  h.load(); h.click('copy');
  origin.remove(); h.viewer.close();
  resolveAction({ ok: false, reason: 'private_path' }); await tick();
  assert.equal(h.doc.activeElement.id, 'fallback');
  assert.equal(h.doc.getElementById('imageViewer'), null);
  h.viewer.dispose();
  assert.equal(await h.viewer.open({ sessionId: 's', artifactId: 'a' }), false);
});

test('file-action failures and cancellation show localized generic statuses and remain usable', async (t) => {
  let result = { ok: false, canceled: true };
  const h = harness({ onAction: async () => result }); t.after(() => h.viewer.dispose());
  await h.viewer.open({ sessionId: 's', artifactId: 'a' }); h.load();
  h.click('save-as'); await tick();
  assert.equal(h.doc.querySelector('[role="status"]').textContent, 'Canceled.');
  result = { ok: false, reason: 'C:/private/path' }; h.click('open'); await tick();
  assert.equal(h.doc.querySelector('[role="status"]').textContent, 'Could not complete this image action.');
  assert.equal(h.doc.querySelector('[data-image-viewer-action="open"]').disabled, false);
});


test('selection requires eligible pixels; Pan Enter does nothing and context menu needs confirmation',async(t)=>{
  const edits=[];const h=harness({getCapabilities:async()=>({imageEditing:true,imageEditSizes:['1024x1024']}),onEdit:async x=>{edits.push(x);return false;}});
  t.after(()=>h.viewer.dispose());await h.viewer.open({sessionId:'s',artifactId:'a'});h.load(1024,1024);await tick();
  const stage=h.doc.querySelector('.image-viewer-stage');stage.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  assert.equal(edits.length,0);h.click('rotate-right');h.click('edit');
  stage.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  stage.dispatchEvent(new h.dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  assert.equal(edits.length,0);assert.equal(h.doc.querySelector('.image-viewer-menu').hidden,false);
  h.doc.querySelector('[data-image-viewer-action=menu-send-edit]').dispatchEvent(new h.dom.window.MouseEvent('pointerdown',{bubbles:true,button:0}));
  h.click('menu-send-edit');await tick();assert.deepEqual(edits[0].region.points,[[256,252],[768,764]]);
  await h.viewer.open({sessionId:'s',artifactId:'large'});h.load(4096,4096);await tick();
  assert.equal(h.doc.querySelector('.image-viewer-edit-actions').hidden,true);
  assert.equal(h.doc.querySelector('canvas').width,0);
});

test('Enter after switching from Box to Pan sends nothing and keeps the viewer open',async(t)=>{
  const edits=[];const h=harness({getCapabilities:async()=>({imageEditing:true,imageEditSizes:['1024x1024']}),onEdit:async x=>{edits.push(x);return {focus(){}};}});
  t.after(()=>h.viewer.dispose());await h.viewer.open({sessionId:'s',artifactId:'a'});h.load(1024,1024);await tick();
  h.click('edit');h.click('select-pan');
  const stage=h.doc.querySelector('.image-viewer-stage');stage.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();
  assert.equal(edits.length,0,'the retained Box region is not sent from Pan');
  assert.ok(h.doc.getElementById('imageViewer'),'the viewer stays open');
  h.click('select-box');stage.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();
  assert.equal(edits.length,1,'Box Enter still sends the region');
});

test('sub-ten-percent Fit zooms smoothly and ignores empty percent and horizontal wheel',async(t)=>{
  const h=harness();t.after(()=>h.viewer.dispose());await h.viewer.open({sessionId:'s',artifactId:'a'});const img=h.load(20000,10000);
  const percent=h.doc.querySelector('input');const fit=Number(percent.value);h.click('in');assert.ok(Number(percent.value)<10);assert.ok(Number(percent.value)>fit);
  const before=img.style.transform;percent.value='';percent.dispatchEvent(new h.dom.window.Event('change'));assert.equal(img.style.transform,before);
  h.click('fit');const stage=h.doc.querySelector('.image-viewer-stage');stage.dispatchEvent(new h.dom.window.WheelEvent('wheel',{deltaX:10,deltaY:0}));
  stage.getBoundingClientRect=()=>({width:600,height:400,left:0,top:0});h.dom.window.dispatchEvent(new h.dom.window.Event('resize'));
  assert.ok(Number(percent.value)<fit);
});

test('stale file action cannot write into a reopened viewer',async(t)=>{
  let settle;const h=harness({onAction:()=>new Promise(resolve=>{settle=resolve;})});t.after(()=>h.viewer.dispose());
  await h.viewer.open({sessionId:'s',artifactId:'a'});h.load();h.click('copy');
  await h.viewer.open({sessionId:'s',artifactId:'b'});h.load();const before=h.doc.querySelector('[role=status]').textContent;
  settle({ok:false});await tick();assert.equal(h.doc.querySelector('[role=status]').textContent,before);
});


test('drag owns one pointer and a failed capture leaves no drag behind', async (t) => {
  const h = harness(); t.after(() => h.viewer.dispose());
  await h.viewer.open({ sessionId: 's', artifactId: 'a' });
  const img = h.load(); h.click('actual');
  const stage = h.doc.querySelector('.image-viewer-stage');
  const pointer = (type, id, x) => {
    const event = new h.dom.window.MouseEvent(type, { button: 0, clientX: x, clientY: 20 });
    Object.defineProperty(event, 'pointerId', { value: id }); stage.dispatchEvent(event);
  };
  const before = img.style.transform;
  stage.setPointerCapture = () => { throw new Error('pointer no longer active'); };
  pointer('pointerdown', 1, 10); pointer('pointermove', 1, 30);
  assert.equal(img.style.transform, before);
  assert.equal(stage.classList.contains('image-viewer-stage--dragging'), false);
  stage.setPointerCapture = () => {};
  pointer('pointerdown', 1, 10);
  pointer('pointerdown', 2, 100); pointer('pointermove', 2, 200); pointer('pointerup', 2, 200);
  assert.equal(img.style.transform, before);
  assert.equal(stage.classList.contains('image-viewer-stage--dragging'), true);
  pointer('pointermove', 1, 30);
  assert.match(img.style.transform, /translate\(20px, 0px\)/);
  pointer('pointerup', 1, 30);
  assert.equal(stage.classList.contains('image-viewer-stage--dragging'), false);
});

const png = (id) => `data:image/png;base64,${Buffer.from(id).toString('base64')}`;
const art = (id, extra = {}) => ({ kind: 'artifact', sessionId: 's', artifactId: id, ...extra });
const key = (h, init) => h.doc.querySelector('.image-viewer-stage').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const escape = (h) => h.doc.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const control = (h, action) => h.doc.querySelector(`[data-image-viewer-action="${action}"]`);
const galleryRead = async (sessionId, artifactId) => ({ asset_data_url: png(artifactId), title: artifactId.toUpperCase() });

test('gallery steps with chevrons and fitted arrows, pans when zoomed, and stops at the ends', async (t) => {
  const h = harness({ readArtifact: galleryRead }); t.after(() => h.viewer.dispose());
  assert.equal(await h.viewer.open({ items: [art('a'), art('b'), art('c')], index: 1 }), true);
  const image = h.load();
  assert.equal(h.doc.querySelector('.image-viewer-meta').textContent, '1000 × 500 · 2 of 3');
  assert.match(image.style.transform, /scale\(0.656\)/, 'gallery fit reserves room for the chevrons');
  h.click('next'); await tick(); h.load();
  assert.equal(image.src, png('c'));
  assert.equal(h.doc.getElementById('imageViewerTitle').textContent, 'C');
  assert.equal(control(h, 'next').disabled, true);
  assert.equal(control(h, 'prev').disabled, false);
  assert.ok(h.doc.getElementById('imageViewer').contains(h.doc.activeElement), 'focus stays inside the viewer');
  key(h, { key: 'ArrowLeft' }); await tick(); h.load();
  assert.equal(image.src, png('b'));
  h.click('actual');
  key(h, { key: 'ArrowLeft' }); await tick();
  assert.equal(image.src, png('b'), 'zoomed arrows pan instead of switching');
  assert.ok(image.style.transform.includes('translate(40px, 0px)'));
  h.click('fit'); key(h, { key: 'ArrowLeft' }); await tick(); h.load();
  assert.equal(image.src, png('a'));
  assert.equal(control(h, 'prev').disabled, true);
  key(h, { key: 'ArrowLeft' }); await tick();
  assert.equal(image.src, png('a'), 'no wrap-around');
});

test('a single image hides the chevrons; invalid requests open nothing', async (t) => {
  const h = harness(); t.after(() => h.viewer.dispose());
  assert.equal(await h.viewer.open({ items: [] }), false);
  assert.equal(await h.viewer.open({ items: [{ kind: 'artifact', sessionId: 's' }] }), false);
  assert.equal(h.doc.getElementById('imageViewer'), null);
  assert.equal(await h.viewer.open({ sessionId: 's', artifactId: 'a' }), true);
  h.load();
  assert.equal(control(h, 'prev').hidden, true);
  assert.equal(control(h, 'next').hidden, true);
  assert.equal(h.doc.querySelector('.image-viewer-meta').textContent, '1000 × 500');
});

test('a stale read from the previous item never paints after navigating', async (t) => {
  const pending = {};
  const h = harness({ readArtifact: (sessionId, artifactId) => new Promise((resolve) => { pending[artifactId] = resolve; }) });
  t.after(() => h.viewer.dispose());
  const opened = h.viewer.open({ items: [art('a'), art('b')] });
  await tick();
  assert.equal(h.doc.querySelector('.image-viewer-placeholder strong').textContent, 'Loading image…');
  h.click('next'); await tick();
  pending.a({ asset_data_url: png('a'), title: 'A' }); await opened;
  assert.equal(h.doc.querySelector('img').hasAttribute('src'), false);
  pending.b({ asset_data_url: png('b'), title: 'B' }); await tick();
  assert.equal(h.doc.querySelector('img').src, png('b'));
  assert.equal(h.doc.getElementById('imageViewerTitle').textContent, 'B');
});

test('details column lists present rows, toggles with i and stays open across images', async (t) => {
  const copies = [];
  const details = { prompt: 'a cat on a sill', seed: 7, steps: 28, cfgScale: 2.5, model: 'Qwen', seconds: 41.2 };
  const h = harness({ readArtifact: galleryRead, copyText: async (text) => { copies.push(text); } });
  t.after(() => h.viewer.dispose());
  await h.viewer.open({ items: [art('a', { details }), art('b', { details: { prompt: 'second' } }), art('c')] });
  h.load();
  assert.equal(h.doc.querySelector('.image-viewer-meta').textContent, '1000 × 500 · seed 7 · 1 of 3');
  const panel = h.doc.querySelector('.image-viewer-details');
  assert.equal(panel.hidden, true);
  key(h, { key: 'i' });
  assert.equal(panel.hidden, false);
  assert.equal(control(h, 'details').getAttribute('aria-pressed'), 'true');
  assert.equal(h.doc.querySelector('.image-viewer-prompt').textContent, 'a cat on a sill');
  assert.equal(h.doc.querySelector('.image-viewer-prompt--avoid').parentElement.hidden, true, 'missing negative prompt is omitted');
  assert.deepEqual([...panel.querySelectorAll('dt')].map((node) => node.textContent), ['Size', 'Seed', 'Steps', 'Model', 'Time']);
  assert.deepEqual([...panel.querySelectorAll('dd')].map((node) => node.textContent), ['1000 × 500', '7', '28 · CFG 2.5', 'Qwen', '41 s']);
  h.click('copy-prompt'); await tick();
  assert.deepEqual(copies, ['a cat on a sill']);
  h.click('next'); await tick(); h.load();
  assert.equal(panel.hidden, false, 'stays open while stepping');
  assert.equal(h.doc.querySelector('.image-viewer-prompt').textContent, 'second');
  h.click('next'); await tick(); h.load();
  assert.equal(control(h, 'details').hidden, true, 'no details object hides the toggle');
  assert.equal(panel.hidden, true);
  assert.equal(control(h, 'menu-copy-prompt').hidden, true);
});

test('Copy prompt is hidden without a copyText option', async (t) => {
  const h = harness(); t.after(() => h.viewer.dispose());
  await h.viewer.open({ items: [art('a', { details: { prompt: 'p' } })] }); h.load();
  assert.equal(control(h, 'copy-prompt').hidden, true);
  assert.equal(control(h, 'menu-copy-prompt').hidden, true);
});

test('edit mode selects Box, hides navigation, and Escape peels region menu, More menu, edit mode, then the viewer', async (t) => {
  const h = harness({ readArtifact: galleryRead, getCapabilities: async () => ({ imageEditing: true, imageEditSizes: ['1024x1024'] }), onEdit: async () => false });
  t.after(() => h.viewer.dispose());
  await h.viewer.open({ items: [art('a'), art('b')] }); h.load(1024, 1024); await tick();
  const editControls = h.doc.querySelector('.image-viewer-edit-actions');
  assert.equal(editControls.hidden, true);
  h.click('edit');
  assert.equal(editControls.hidden, false);
  assert.equal(h.doc.querySelector('.image-viewer-view-actions').hidden, true);
  assert.equal(control(h, 'select-box').getAttribute('aria-pressed'), 'true');
  assert.equal(h.doc.activeElement, control(h, 'select-box'));
  assert.equal(control(h, 'next').hidden, true);
  key(h, { key: 'ArrowRight' }); await tick();
  assert.equal(h.doc.querySelector('img').src, png('a'), 'arrows never switch images in edit mode');
  h.click('edit-cancel');
  assert.equal(editControls.hidden, true);
  assert.equal(h.doc.querySelector('canvas').width, 0, 'cancel clears the selection');
  h.click('edit');
  h.doc.querySelector('.image-viewer-stage').dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  h.click('more');
  assert.equal(h.doc.querySelector('.image-viewer-menu').hidden, false);
  assert.equal(h.doc.querySelector('.image-viewer-more').hidden, false);
  escape(h);
  assert.equal(h.doc.querySelector('.image-viewer-menu').hidden, true);
  assert.equal(h.doc.querySelector('.image-viewer-more').hidden, false);
  escape(h);
  assert.equal(h.doc.querySelector('.image-viewer-more').hidden, true);
  assert.equal(editControls.hidden, false);
  escape(h);
  assert.equal(editControls.hidden, true);
  assert.ok(h.doc.getElementById('imageViewer'));
  escape(h);
  assert.equal(h.doc.getElementById('imageViewer'), null);
});

test('More menu is a keyboard-reachable menu that closes on an outside click', async (t) => {
  const h = harness(); t.after(() => h.viewer.dispose());
  await h.viewer.open({ sessionId: 's', artifactId: 'a' }); h.load(); await tick();
  const more = control(h, 'more');
  assert.equal(more.getAttribute('aria-haspopup'), 'menu');
  h.click('more');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(h.doc.activeElement, control(h, 'open-with'));
  h.doc.activeElement.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(h.doc.activeElement, control(h, 'rotate-left'));
  h.doc.querySelector('.image-viewer-stage').click();
  assert.equal(h.doc.querySelector('.image-viewer-more').hidden, true);
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  h.click('more'); h.click('rotate-left');
  assert.match(h.doc.querySelector('img').style.transform, /rotate\(270deg\)/);
  assert.equal(h.doc.querySelector('.image-viewer-more').hidden, true);
  assert.equal(h.doc.activeElement, more);
});

test('More menu focus and arrows skip entries disabled by a pending file action', async (t) => {
  const h = harness({ onAction: () => new Promise(() => {}) }); t.after(() => h.viewer.dispose());
  await h.viewer.open({ sessionId: 's', artifactId: 'a' }); h.load(); await tick();
  h.click('copy');
  assert.equal(control(h, 'open-with').disabled, true);
  h.click('more');
  assert.equal(h.doc.activeElement, control(h, 'rotate-left'));
  h.doc.activeElement.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.notEqual(h.doc.activeElement, control(h, 'open-with'));
});

test('source items load file URLs, never offer editing, and gate file actions on a ref', async (t) => {
  const h = harness({ getCapabilities: async () => ({ openWith: true, imageEditing: true, imageEditSizes: ['1000x500'] }) });
  t.after(() => h.viewer.dispose());
  await h.viewer.open({ items: [{ kind: 'source', sessionId: 's', src: 'file:///C:/images/a.png', title: 'Pasted' }, { kind: 'source', sessionId: 's', src: source, ref: 'r1' }] });
  const image = h.load(); await tick();
  assert.equal(image.src, 'file:///C:/images/a.png');
  assert.equal(h.doc.getElementById('imageViewerTitle').textContent, 'Pasted');
  for (const action of ['copy', 'save-as', 'reveal', 'open', 'open-with']) assert.equal(control(h, action).hidden, true, action);
  assert.equal(h.doc.querySelector('.image-viewer-edit-entry').hidden, true);
  key(h, { key: 's', ctrlKey: true });
  assert.equal(h.calls.filter((call) => call[0] === 'action').length, 0);
  h.click('next'); await tick(); h.load(); await tick();
  for (const action of ['copy', 'save-as', 'reveal']) assert.equal(control(h, action).hidden, false, action);
  assert.equal(control(h, 'open').hidden, true);
  assert.equal(h.doc.querySelector('.image-viewer-edit-entry').hidden, true, 'a PNG source is still never editable');
  key(h, { key: 's', ctrlKey: true }); await tick();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'action'), [['action', 'save-as', { kind: 'source', sessionId: 's', src: source, ref: 'r1' }]]);
  assert.equal(h.calls.filter((call) => call[0] === 'read').length, 0);
});

test('unsupported source URLs are unavailable; artifacts offer a Show in folder fallback', async (t) => {
  const h = harness(); t.after(() => h.viewer.dispose());
  await h.viewer.open({ items: [{ kind: 'source', sessionId: 's', src: 'https://example.test/a.png' }] });
  assert.match(h.doc.querySelector('[role="status"]').textContent, /unavailable/);
  assert.equal(control(h, 'placeholder-reveal').hidden, true, 'no ref, no reveal');
  const failure = harness({ readArtifact: async () => ({ asset_data_url: 'nope' }) }); t.after(() => failure.viewer.dispose());
  await failure.viewer.open({ sessionId: 's', artifactId: 'a' });
  assert.equal(failure.doc.querySelector('.image-viewer-placeholder strong').textContent, 'Image unavailable');
  assert.equal(failure.doc.querySelector('.image-viewer-pill').hidden, true);
  failure.click('placeholder-reveal'); await tick();
  assert.deepEqual(failure.calls.filter((call) => call[0] === 'action'), [['action', 'reveal', { kind: 'artifact', sessionId: 's', artifactId: 'a' }]]);
});

test('Ctrl+S and Ctrl+C run the file actions; double-click toggles Fit and 100% about the pointer', async (t) => {
  const h = harness(); t.after(() => h.viewer.dispose());
  await h.viewer.open({ sessionId: 's', artifactId: 'a' });
  const image = h.load();
  key(h, { key: 's', ctrlKey: true }); await tick();
  key(h, { key: 'c', metaKey: true }); await tick();
  key(h, { key: 'x', ctrlKey: true }); await tick();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'action').map((call) => call[1]), ['save-as', 'copy']);
  const stage = h.doc.querySelector('.image-viewer-stage');
  stage.dispatchEvent(new h.dom.window.MouseEvent('dblclick', { bubbles: true, clientX: 600, clientY: 300 }));
  assert.match(image.style.transform, /scale\(1\)/);
  assert.ok(image.style.transform.includes(`translate(${200 - 200 / 0.752}px, 0px)`));
  assert.equal(control(h, 'fit').hidden, false);
  assert.equal(control(h, 'actual').hidden, true);
  stage.dispatchEvent(new h.dom.window.MouseEvent('dblclick', { bubbles: true, clientX: 10, clientY: 10 }));
  assert.match(image.style.transform, /translate\(0px, 0px\) rotate\(0deg\) scale\(0.752\)/);
  key(h, { key: '1' });
  assert.match(image.style.transform, /scale\(1\)/);
});

test('success notes clear after 1800 ms while errors stay until the next action', async (t) => {
  const timers = [];
  let result = { ok: true };
  const h = harness({ onAction: async () => result,
    setTimeout: (callback, ms) => timers.push({ callback, ms, live: true }), clearTimeout: (id) => { timers[id - 1].live = false; } });
  t.after(() => h.viewer.dispose());
  await h.viewer.open({ sessionId: 's', artifactId: 'a' }); h.load();
  const status = h.doc.querySelector('[role="status"]');
  h.click('copy'); await tick();
  assert.equal(status.textContent, 'Image copied');
  const live = timers.filter((timer) => timer.live);
  assert.deepEqual(live.map((timer) => timer.ms), [1800]);
  live[0].live = false; live[0].callback();
  assert.equal(status.textContent, '');
  h.click('save-as'); await tick();
  assert.equal(status.textContent, 'Saved');
  result = { ok: false }; h.click('save-as'); await tick();
  assert.equal(status.textContent, 'Could not complete this image action.');
  assert.equal(timers.filter((timer) => timer.live).length, 0, 'errors do not time out');
  h.click('in');
  assert.equal(status.textContent, '', 'the next action clears an error');
});
