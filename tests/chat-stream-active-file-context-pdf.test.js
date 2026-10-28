'use strict';

// Row 65: PDF payloads (kind:'pdf') through chat-stream context assembly.

const test = require('node:test');
const assert = require('node:assert/strict');

const { assembleContextForChat, blockOfKind, makeOptions, makeService } = require('./helpers/chat-stream-active-file-harness');

const PDF_ACTIVE = {
  path: 'docs/q3-review.pdf',
  kind: 'pdf',
  pages: { start: 4, end: 4, total: 38 },
  selection: false,
  scanned: false,
  slice: 'Revenue grew 12% quarter over quarter.',
};

test('a valid PDF payload in the bound workspace reaches the active-file block', async () => {
  const options = makeOptions({ activeFileContext: { ...PDF_ACTIVE } });
  const result = await assembleContextForChat(makeService(true), options);
  const activeFile = blockOfKind(result, 'active_file');
  assert.ok(activeFile, 'PDF active-file block emitted');
  assert.match(activeFile, /Active document context/);
  assert.match(activeFile, /File: docs\/q3-review\.pdf \(page 4 of 38\)/);
  assert.match(activeFile, /Revenue grew 12%/);
  assert.equal(result.contextAssemblyBreakdown.includedActiveFileContext, true);
});

test('a scanned PDF payload (empty slice) still reaches the block alongside @-mentions', async () => {
  const options = makeOptions({
    activeFileContext: { ...PDF_ACTIVE, scanned: true, slice: '' },
    mentionContents: [{ path: 'src/util.js', content: 'export const ok = true;' }],
  });
  const result = await assembleContextForChat(makeService(true), options);
  const activeFile = blockOfKind(result, 'active_file');
  assert.match(activeFile, /no text layer/);
  assert.match(activeFile, /=== src\/util\.js ===/);
});

test('a scanned or not-yet-extracted PDF page alone (no mentions) still sends its read_file pointer', async () => {
  for (const flag of ['scanned', 'pending']) {
    const options = makeOptions({ activeFileContext: { ...PDF_ACTIVE, [flag]: true, slice: '' } });
    const result = await assembleContextForChat(makeService(true), options);
    const activeFile = blockOfKind(result, 'active_file');
    assert.ok(activeFile, `${flag} PDF block emitted`);
    assert.match(activeFile, /read_file with pages="4"/);
    assert.equal(result.contextAssemblyBreakdown.includedActiveFileContext, true);
  }
});

test('PDF payloads outside the bound workspace are dropped', async () => {
  const dropped = [
    { ...PDF_ACTIVE, workspace_id: 'some-other-root' },
    { ...PDF_ACTIVE, path: '../outside/secret.pdf' },
    { ...PDF_ACTIVE, path: 'a/../../outside/secret.pdf' },
    { ...PDF_ACTIVE, path: '/etc/secret.pdf' },
  ];
  for (const activeFileContext of dropped) {
    const options = makeOptions({ activeFileContext });
    const result = await assembleContextForChat(makeService(true), options);
    assert.deepEqual(result.contextBlocks, [], JSON.stringify(activeFileContext.path));
    assert.equal(result.contextAssemblyBreakdown.includedActiveFileContext, false);
  }
});
