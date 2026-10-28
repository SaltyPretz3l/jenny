'use strict';

// Row 65 W4: a password-protected PDF saved from the Workspace IDE pane stays
// encrypted. The pane runs on the real pinned pdf.js core (only the viewer is
// faked): the tab's prompt unlocks the real document, one form value goes into
// its real annotationStorage, and the pane's own export path calls the real
// saveDocument(). The saved bytes must refuse to open without the password and
// carry the value when reopened with it. Fixtures come from
// tests/fixtures/documents/make_encrypted_pdfs.js (never run at test time).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FakePDFViewer, keydown, makePane, makePdfjsHarness, tick } = require('./helpers/ide-pdf-pane-harness');

const PASSWORD = 'secret';
const PAGE_TEXT = 'Password-protected fixture page';
const NOTE = 'Encrypted round trip 42';
const FIXTURES = [
  ['RC4 128-bit (R3)', 'encrypted-rc4.pdf'],
  ['AES-256 (R6)', 'encrypted-aes256.pdf'],
];

async function waitFor(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await tick();
  }
}

// The fake viewer harness with getDocument handed to the real pdf.js core.
function makeRealCoreHarness(pdfjs, t) {
  const harness = makePdfjsHarness();
  harness.pdfjs.PasswordResponses = pdfjs.PasswordResponses;
  harness.pdfjs.getDocument = (params) => {
    harness.params.push(params);
    const task = pdfjs.getDocument(params);
    harness.tasks.push(task);
    task.promise.then((document) => harness.documents.push(document), () => {});
    t.after(() => task.destroy());
    return task;
  };
  return harness;
}

async function open(pdfjs, t, bytes, password) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...(password ? { password } : {}) });
  t.after(() => task.destroy());
  return task.promise;
}

async function noteField(document) {
  return (await (await document.getPage(1)).getAnnotations()).find((item) => item.fieldName === 'note');
}

for (const [label, name] of FIXTURES) {
  test(`an ${label} PDF saved from the pane stays encrypted and keeps the annotation`, async (t) => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/documents', name));
    assert.equal(fixture.includes(PAGE_TEXT), false, 'the fixture page text is encrypted at rest');
    await assert.rejects(open(pdfjs, t, fixture), pdfjs.PasswordException, 'the fixture itself needs the password');

    const logs = [];
    const env = makePane({ harness: makeRealCoreHarness(pdfjs, t), log: (...entry) => logs.push(entry) });
    t.after(() => { env.pane.dispose(); env.dom.window.close(); });
    const filePath = `docs/${name}`;
    const result = await env.pane.load(filePath, { base64: fixture.toString('base64'), size: fixture.length, mtimeMs: 123 });
    assert.deepEqual(result, { ok: true, pageCount: 0, locked: true });
    env.pane.show(filePath);
    const input = env.host.querySelector('.ide-pdf-password input');
    assert.ok(input, 'the tab prompts for the password in place');
    input.value = PASSWORD;
    keydown(env, input, { key: 'Enter' });
    await waitFor(() => FakePDFViewer.instances.length === 1 && env.pane.getState(filePath)?.pageCount === 1, 'the unlocked viewer');
    assert.equal(env.host.querySelector('.ide-pdf-password'), null);

    const document = env.harness.documents[0];
    document.annotationStorage.setValue((await noteField(document)).id, { value: NOTE });
    assert.equal(env.pane.isDirty(filePath), true);
    const saved = Buffer.from(await env.pane.exportBytes(filePath), 'base64');

    assert.ok(saved.length > fixture.length, 'saveDocument wrote the edit');
    assert.equal(saved.includes(NOTE), false, 'the new value is not written in plaintext');
    assert.equal(saved.includes(Buffer.from(NOTE, 'utf16le')), false);
    await assert.rejects(open(pdfjs, t, saved), (error) => {
      assert.ok(error instanceof pdfjs.PasswordException, `expected a PasswordException, got ${error?.name}`);
      assert.equal(error.code, pdfjs.PasswordResponses.NEED_PASSWORD);
      return true;
    }, 'the saved file still needs the password');
    const reopened = await open(pdfjs, t, saved, PASSWORD);
    assert.equal((await noteField(reopened)).fieldValue, NOTE, 'the annotation survives the encrypted round trip');
    const text = (await (await reopened.getPage(1)).getTextContent()).items.map((item) => item.str).join('');
    assert.equal(text, PAGE_TEXT);
    assert.equal(JSON.stringify(logs).includes(PASSWORD), false, 'the password is never logged');
  });
}
