/* W13 - the hero ask line's keyboard and submit contract.
 *
 * Split out of tests/renderer-home-daybook.test.js to keep that file under the
 * 600-line test ratchet. Everything here runs against a STUBBED onAsk, so the
 * launcher's own behaviour (session create, tool overrides, the composer send)
 * is out of the picture and only the delegated handler is under test; the
 * launcher half is pinned in tests/renderer-home-ask-config.test.js.
 *
 * What these tests pin - the three defects this handler owned:
 *  - F1: an ask could be fired twice concurrently. startAsk spans two IPC
 *    round-trips and there was no latch anywhere on the path, so a second
 *    Enter inside that window created a second session and a second send.
 *  - F3: Escape ran `target.value = ''` unconditionally, so dismissing the
 *    settings panel while the field had focus destroyed the draft, with no undo.
 *  - F5: Enter was the ONLY submit affordance, advertised by a hint that was
 *    invisible until the field had focus. A pointer-only user could not send
 *    from Home at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const daybookModule = require('../renderer/features/renderer-dashboard-daybook.js');
const widgetsCore = require('../renderer/features/renderer-dashboard-widgets-core.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');

function createDom() {
  const dom = new JSDOM(''
    + '<main><div class="home-daybook" id="homeDaybook">'
    + '<div id="homeInfoStrip" hidden></div>'
    + '</div></main>');
  return { dom, window: dom.window, documentRef: dom.window.document };
}

/* W13 keyboard + submit contract, against a stubbed onAsk so the launcher's own
 * behaviour is out of the picture. These pin the three defects the delegated
 * handler owned: a concurrent double-fire (F1), Escape eating the draft while
 * the settings panel is open (F3), and no pointer path to submit at all (F5). */
function mountAskLine(t, onAsk) {
  const dom = createDom();
  const infoStrip = dom.documentRef.getElementById('homeInfoStrip');
  const daybook = dom.documentRef.getElementById('homeDaybook');
  // The strip renderer directly, NOT the dashboard manager: the manager binds a
  // daybook controller of its own, and two controllers on one strip would both
  // handle every event - the second one reading a field the first already
  // cleared. The region markup is the only thing needed here.
  const renderer = widgetsCore.createInfoStripRenderer({
    nowProvider: () => new Date(2026, 5, 11, 8, 5),
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
  });
  renderer.render(infoStrip, { state: {} });

  const region = infoStrip.querySelector('.home-info-strip__ask');
  const pill = dom.documentRef.getElementById('homeAskPill');
  const controller = daybookModule.createDaybookController({
    documentRef: dom.documentRef,
    dom: { homeDaybook: daybook, homeInfoStrip: infoStrip },
    getHomeConfig: () => ({}),
    onAsk,
  });
  t.after(() => controller.dispose());
  const press = (key, init = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...init,
    });
    pill.dispatchEvent(event);
    return event;
  };
  return { dom, region, pill, press, controller };
}

test('F1: a second Enter during an in-flight ask is ignored', async (t) => {
  const asks = [];
  let release;
  const { region, pill, press } = mountAskLine(t, (text, options) => {
    asks.push({ text, options });
    return new Promise((resolve) => { release = resolve; });
  });

  pill.value = 'why is the build red?';
  press('Enter');
  assert.equal(asks.length, 1, 'the first Enter starts the ask');
  assert.equal(region.dataset.askBusy, '1', 'and the region advertises the busy state to CSS');
  // readOnly, never disabled: a disabled field would drop focus and grey the
  // text out, and a failed send has to hand the question straight back.
  assert.equal(pill.readOnly, true, 'the field is held while the request is out');
  assert.equal(pill.disabled, false);

  // startAsk spans two IPC round-trips. A second Enter inside that window used
  // to create a SECOND session and fire a SECOND send.
  press('Enter');
  press('Enter');
  assert.equal(asks.length, 1, 'no second ask is started while one is in flight');

  release(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pill.value, '', 'the settled ask still clears the field');
  assert.equal(region.dataset.askBusy, undefined, 'and the latch releases');
  assert.equal(pill.readOnly, false, 'the field is typable again');

  pill.value = 'and now another';
  press('Enter');
  assert.equal(asks.length, 2, 'the next ask is free to start');
});

test('F1: a synchronous throw out of onAsk still releases the latch', (t) => {
  let calls = 0;
  const { region, pill, press } = mountAskLine(t, () => {
    calls += 1;
    throw new Error('onAsk exploded');
  });

  pill.value = 'first';
  press('Enter');
  assert.equal(calls, 1);
  assert.equal(region.dataset.askBusy, undefined,
    'a throw before any promise exists must not strand the field busy forever');
  assert.equal(pill.readOnly, false, 'nor leave it read-only forever');
  press('Enter');
  assert.equal(calls, 2, 'the field is usable again');
});

test('F3: Escape with the settings panel open closes the panel and keeps the draft', (t) => {
  const { dom, region, pill, press } = mountAskLine(t, () => true);

  // Stand in for the ask-config panel: the handler keys off the class and the
  // hidden flag, exactly as the popover primitive maintains them.
  const panel = dom.documentRef.createElement('div');
  panel.className = 'inv-popover home-ask__panel';
  region.querySelector('.home-ask__meta').append(panel);

  pill.value = 'keep me';
  pill.focus();
  press('Escape');
  assert.equal(pill.value, 'keep me', 'the draft survives');
  assert.equal(dom.documentRef.activeElement, pill,
    'and the field keeps focus - the popover primitive owns this Escape');

  panel.hidden = true;
  press('Escape');
  assert.equal(pill.value, 'keep me', 'still no clear');
  assert.notEqual(dom.documentRef.activeElement, pill, 'now it blurs');
});

test('F5: clicking the send button routes through the same onAsk path as Enter', (t) => {
  const asks = [];
  const { dom, region, pill } = mountAskLine(t, (text, options) => {
    asks.push({ text, options });
    return true;
  });

  const send = dom.documentRef.getElementById('homeAskSend');
  assert.ok(send, 'the meta row carries a pointer path to submit');
  assert.equal(send.getAttribute('aria-label'), 'Send');

  pill.value = 'pointer only';
  pill.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(region.dataset.askFilled, '1', 'text reveals the send button');

  send.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(asks, [{ text: 'pointer only', options: { send: true } }]);
  assert.equal(pill.value, '', 'and it clears on success like Enter does');
  assert.equal(region.dataset.askFilled, undefined,
    'the cleared field drops the flag, so the send button hides again');
});
