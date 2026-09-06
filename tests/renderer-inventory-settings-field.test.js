const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const settingsField = require('../renderer/inventory/settings-field');

/* ── Rendering / anatomy ── */

test('settingsField renders the CSS-contract anatomy: text block, control slot, hidden error slot', () => {
  const html = settingsField({
    id: 'exampleToggle',
    label: 'Example setting',
    help: 'Demonstrate the inventory anatomy.',
    controlHtml: '<button class="inv-toggle-track" role="switch"></button>',
  });

  const dom = new JSDOM(`<div>${html}</div>`);
  const { document } = dom.window;
  const root = document.querySelector('.settings-field');
  assert.ok(root, 'root .settings-field renders');
  assert.equal(root.getAttribute('data-settings-field'), 'exampleToggle');
  assert.ok(root.classList.contains('settings-field--inline'), 'defaults to inline variant');

  const text = root.querySelector('.settings-field-text');
  assert.ok(text, 'text wrapper present');
  const title = text.querySelector('.settings-field-title');
  const help = text.querySelector('.settings-field-help');
  assert.equal(title.textContent, 'Example setting');
  assert.equal(help.textContent, 'Demonstrate the inventory anatomy.');

  const control = root.querySelector('.settings-field-control');
  assert.ok(control, 'control slot present');
  assert.ok(control.querySelector('.inv-toggle-track'), 'controlHtml rendered inside the control slot');

  const errorEl = root.querySelector('.settings-field-error');
  assert.ok(errorEl, 'error slot present');
  assert.equal(errorEl.hidden, true, 'error slot hidden by default');
  assert.equal(errorEl.textContent, '');

  // Anatomy order: text, control, error — matches the CSS doc comment.
  const children = [...root.children].map((el) => el.className);
  assert.deepEqual(children, [
    'settings-field-text',
    'settings-field-control',
    'settings-field-error',
  ]);
});

test('settingsField requires an id: missing/invalid id renders nothing', () => {
  assert.equal(settingsField({ label: 'No id' }), '');
  assert.equal(settingsField({ id: '', label: 'Empty id' }), '');
  assert.equal(settingsField({ id: 'has spaces', label: 'Bad id' }), '');
});

test('settingsField omits the text wrapper entirely when label and help are both absent', () => {
  const html = settingsField({ id: 'bareField', controlHtml: '<input>' });
  const dom = new JSDOM(`<div>${html}</div>`);
  const root = dom.window.document.querySelector('.settings-field');
  assert.equal(root.querySelector('.settings-field-text'), null);
});

/* ── Escaping ── */

test('settingsField HTML-escapes label and help but inserts controlHtml verbatim (unescaped)', () => {
  const html = settingsField({
    id: 'escapeField',
    label: '<script>alert(1)</script>',
    help: '<img src=x onerror=alert(2)>',
    controlHtml: '<span data-trusted="yes">trusted markup</span>',
  });

  assert.ok(!html.includes('<script>alert(1)</script>'), 'label script tag must not appear raw');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'label is escaped');
  assert.ok(!html.includes('<img src=x onerror=alert(2)>'), 'help markup must not appear raw');
  assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'), 'help is escaped');

  // controlHtml is a trusted slot: inserted verbatim, not escaped.
  assert.ok(html.includes('<span data-trusted="yes">trusted markup</span>'), 'controlHtml passes through unescaped');

  const dom = new JSDOM(`<div>${html}</div>`);
  const { document } = dom.window;
  assert.equal(document.querySelectorAll('script').length, 0, 'no live <script> element was created');
  assert.ok(document.querySelector('.settings-field-control span[data-trusted="yes"]'), 'trusted control markup rendered as real DOM');
});

test('settingsField error option is HTML-escaped when it pre-populates the error slot', () => {
  const html = settingsField({
    id: 'errField',
    error: '<b>bad</b> value',
  });
  const dom = new JSDOM(`<div>${html}</div>`);
  const root = dom.window.document.querySelector('.settings-field');
  assert.equal(root.getAttribute('data-state'), 'error');
  const errorEl = root.querySelector('.settings-field-error');
  assert.equal(errorEl.hidden, false);
  assert.equal(errorEl.textContent, '<b>bad</b> value');
  assert.equal(root.querySelectorAll('b').length, 0, 'error text did not become live markup');
});

/* ── Meta slot ── */

test('settingsField metaHtml renders on the title line, trusted, and only when given', () => {
  const plain = settingsField({ id: 'm1', label: 'Palette', help: 'Pick one' });
  const plainRoot = new JSDOM(`<div>${plain}</div>`).window.document.querySelector('.settings-field');
  assert.equal(plainRoot.querySelector('.settings-field-title-row'), null, 'no wrapper without meta');
  assert.ok(plainRoot.querySelector('.settings-field-text > .settings-field-title'));

  const withMeta = settingsField({
    id: 'm2', label: 'Palette', help: 'Pick one',
    metaHtml: '<span class="settings-field-meta"><span class="settings-field-meta-default">Default 20</span></span>',
  });
  const root = new JSDOM(`<div>${withMeta}</div>`).window.document.querySelector('.settings-field');
  const row = root.querySelector('.settings-field-text > .settings-field-title-row');
  assert.ok(row, 'title row wraps title + meta');
  assert.equal(row.children[0].className, 'settings-field-title');
  assert.ok(row.querySelector('.settings-field-meta-default'), 'meta markup inserted verbatim (trusted slot)');
  assert.ok(root.querySelector('.settings-field-text > .settings-field-help'), 'help still follows the title line');
  assert.equal(root.querySelector('.settings-field-control .settings-field-meta'), null, 'meta is not in the control column');
});

/* ── Variants ── */

test('settingsField variant classes: inline (default), stacked, toggle', () => {
  const inline = settingsField({ id: 'v1' });
  const stacked = settingsField({ id: 'v2', variant: 'stacked' });
  const toggle = settingsField({ id: 'v3', variant: 'toggle' });
  const row = settingsField({ id: 'v5', variant: 'row' });
  const bogus = settingsField({ id: 'v4', variant: 'not-a-real-variant' });

  const classesOf = (html) => new JSDOM(`<div>${html}</div>`).window.document.querySelector('.settings-field').className;

  assert.ok(classesOf(inline).includes('settings-field--inline'));
  assert.ok(classesOf(stacked).includes('settings-field--stacked'));
  assert.ok(classesOf(toggle).includes('settings-field--toggle'));
  assert.ok(classesOf(row).includes('settings-field--row'), 'row is the flat list variant');
  assert.ok(classesOf(bogus).includes('settings-field--inline'), 'unknown variant falls back to inline');
});

/* ── data-state precedence at render time ── */

test('settingsField initial data-state: error wins over busy when both are set', () => {
  const html = settingsField({ id: 'stateField', error: 'Something broke', busy: true });
  const dom = new JSDOM(`<div>${html}</div>`);
  const root = dom.window.document.querySelector('.settings-field');
  assert.equal(root.getAttribute('data-state'), 'error');
});

test('settingsField initial data-state: busy alone sets data-state="busy"', () => {
  const html = settingsField({ id: 'busyField', busy: true });
  const dom = new JSDOM(`<div>${html}</div>`);
  const root = dom.window.document.querySelector('.settings-field');
  assert.equal(root.getAttribute('data-state'), 'busy');
});

/* ── setFieldError / setFieldBusy / findField (imperative) ── */

function buildFieldDom() {
  const html = settingsField({ id: 'liveField', label: 'Live field', controlHtml: '<input>' });
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { pretendToBeVisual: true });
  const { document } = dom.window;
  return { dom, document, root: document.querySelector('.settings-field') };
}

test('setFieldError sets data-state="error" and unhides/populates the error slot', () => {
  const { root } = buildFieldDom();
  settingsField.setFieldError(root, 'Value must be a number');
  assert.equal(root.getAttribute('data-state'), 'error');
  const errorEl = root.querySelector('.settings-field-error');
  assert.equal(errorEl.hidden, false);
  assert.equal(errorEl.textContent, 'Value must be a number');
});

test('setFieldError with null/empty clears the error state and hides the slot', () => {
  const { root } = buildFieldDom();
  settingsField.setFieldError(root, 'Boom');
  settingsField.setFieldError(root, null);
  assert.equal(root.hasAttribute('data-state'), false);
  const errorEl = root.querySelector('.settings-field-error');
  assert.equal(errorEl.hidden, true);
  assert.equal(errorEl.textContent, '');

  settingsField.setFieldError(root, 'Boom again');
  settingsField.setFieldError(root, '   ');
  assert.equal(root.hasAttribute('data-state'), false, 'whitespace-only message also clears');
});

test('setFieldBusy toggles data-state="busy" on and off', () => {
  const { root } = buildFieldDom();
  settingsField.setFieldBusy(root, true);
  assert.equal(root.getAttribute('data-state'), 'busy');
  settingsField.setFieldBusy(root, false);
  assert.equal(root.hasAttribute('data-state'), false);
});

test('setFieldBusy does not clobber an existing error state — error wins', () => {
  const { root } = buildFieldDom();
  settingsField.setFieldError(root, 'Already broken');
  settingsField.setFieldBusy(root, true);
  assert.equal(root.getAttribute('data-state'), 'error', 'busy must not override error');

  // Clearing the error does not auto-restore busy — caller must re-request it.
  settingsField.setFieldError(root, null);
  assert.equal(root.hasAttribute('data-state'), false);
  settingsField.setFieldBusy(root, true);
  assert.equal(root.getAttribute('data-state'), 'busy', 'busy applies once error is cleared');
});

test('setFieldError/setFieldBusy are no-ops on a null root (no throw, no side effects)', () => {
  const { root } = buildFieldDom();
  settingsField.setFieldError(root, 'existing error');

  assert.equal(settingsField.setFieldError(null, 'x'), undefined);
  assert.equal(settingsField.setFieldBusy(null, true), undefined);

  // The null-root calls must not have leaked onto the unrelated real field.
  assert.equal(root.getAttribute('data-state'), 'error');
  assert.equal(root.querySelector('.settings-field-error').textContent, 'existing error');
});

test('findField locates a rendered field by id, and returns null when absent', () => {
  const { document } = buildFieldDom();
  const found = settingsField.findField(document, 'liveField');
  assert.ok(found);
  assert.equal(found.getAttribute('data-settings-field'), 'liveField');
  assert.equal(settingsField.findField(document, 'nope'), null);
  assert.equal(settingsField.findField(null, 'liveField'), null);
});

/* ── Barrel wiring ── */

test('inventory barrel exposes settingsField with setFieldError/setFieldBusy/findField', () => {
  const prevInventory = global.inventory;
  const prevDocument = global.document;
  const prevHandlersInstalled = global.__inventoryHandlersInstalled;
  const prevSettingsField = global.inventorySettingsField;

  const dom = new JSDOM('<div></div>', { pretendToBeVisual: true });
  global.document = dom.window.document;
  global.__inventoryHandlersInstalled = false;
  global.inventorySettingsField = settingsField;

  delete require.cache[require.resolve('../renderer/inventory/index')];
  const inventory = require('../renderer/inventory/index');

  assert.equal(typeof inventory.settingsField, 'function', 'settingsField reachable via barrel');
  assert.equal(typeof inventory.settingsField.setFieldError, 'function');
  assert.equal(typeof inventory.settingsField.setFieldBusy, 'function');
  assert.equal(typeof inventory.settingsField.findField, 'function');

  global.inventory = prevInventory;
  global.document = prevDocument;
  global.__inventoryHandlersInstalled = prevHandlersInstalled;
  global.inventorySettingsField = prevSettingsField;
});
