'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { buildImageReferenceContext, rewriteImageReferences } = require('../renderer/chat/renderer-artifact-image-references');
const documentRef = new JSDOM('').window.document;
const image = { artifact_id: 'image-1', artifact_kind: 'image', session_id: 's1', display_path: '.jenny/artifacts/s1/image-1.png' };
const tool = (artifact = image, turn = 't1') => ({ role: 'tool', turn_id: turn, tool_result: { tool_name: 'image_generate', generated_artifacts: [artifact] } });

test('canonical id and normalized display path become inventory viewer controls; remote images survive', () => {
  const message = { id: 'a', role: 'assistant', turn_id: 't1' };
  const context = { ...buildImageReferenceContext([message, tool()], message, 's1'), documentRef };
  const html = rewriteImageReferences('<p><img src="image-1"><img src="./.jenny\\artifacts\\s1\\image-1.png"><img src="https://example.org/image.png"></p>', context);
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelectorAll('[data-image-viewer-open="artifact"]').length, 2);
  for (const button of doc.querySelectorAll('button')) { assert.equal(button.dataset.sessionId, 's1'); assert.equal(button.dataset.imageId, 'image-1'); }
  assert.equal(doc.querySelectorAll('img').length, 1);
  assert.equal(doc.querySelector('img').src, 'https://example.org/image.png');
});

test('no basename guessing, crossing sessions, traversal, absolute path or unsafe URI authority', () => {
  const context = { sessionId: 's1', artifacts: [image, { ...image, artifact_id: 'other', session_id: 's2' }], hasGeneratedImage: true, documentRef };
  for (const src of ['image-1.png', 'other', '../.jenny/artifacts/s1/image-1.png', '%2e%2e/.jenny/artifacts/s1/image-1.png', 'file:///.jenny/artifacts/s1/image-1.png', 'C:/image-1.png']) {
    const html = rewriteImageReferences(`<img src="${src}">`, context);
    assert.doesNotMatch(html, /<img|<button/);
    assert.match(html, /Image reference unavailable/);
  }
  const mismatch = buildImageReferenceContext([{ ...tool(), session_id: 's2' }], {}, 's1');
  assert.deepEqual(mismatch.artifacts, []);
});

test('generation detection uses turn IDs or the surrounding user boundary including later tool results', () => {
  for (const ids of [false, true]) {
    const a = { role: 'assistant', id: 'a', ...(ids ? { turn_id: 't2' } : {}) };
    const generated = tool(image, 't2'); if (!ids) delete generated.turn_id;
    const messages = [{ role: 'user' }, tool(image, 't1'), { role: 'user' }, a, generated, { role: 'user' }, { role: 'assistant' }];
    assert.equal(buildImageReferenceContext(messages, a, 's1').hasGeneratedImage, true);
    assert.equal(buildImageReferenceContext(messages, messages[6], 's1').hasGeneratedImage, false);
    assert.equal(buildImageReferenceContext(messages, { ...a }, 's1').hasGeneratedImage, true);
  }
});

test('unrelated Markdown stays byte-for-byte and canonical images wrapped in links lose path navigation', () => {
  const unrelated = '<p><img src="report.png">plain &amp; text</p>';
  assert.equal(rewriteImageReferences(unrelated, { sessionId: 's1', artifacts: [], hasGeneratedImage: false, documentRef }), unrelated);
  assert.equal(rewriteImageReferences('no images', { get documentRef() { throw new Error('must not parse'); } }), 'no images');
  const html = rewriteImageReferences('<a href="file:///private"><img src="image-1"></a>', { sessionId: 's1', artifacts: [image], documentRef });
  assert.doesNotMatch(html, /<a|file:/);
  assert.match(html, /View image/);
  const linkedCaption = rewriteImageReferences('<a href="file:///private">Caption <em><img src="image-1"></em></a>', { sessionId: 's1', artifacts: [image], documentRef });
  assert.doesNotMatch(linkedCaption, /<a|file:/);
  assert.match(linkedCaption, /Caption/);
  assert.match(linkedCaption, /View image/);
});


test('remote links and nonlocal URI schemes survive; special display-path characters match exactly',()=>{
  const context={sessionId:'s1',artifacts:[{...image,display_path:'plots/a?b#c%25.png'}],hasGeneratedImage:true,documentRef};
  for(const src of ['ftp://host/a.png','cid:part1','mailto:person@example.org']) assert.match(rewriteImageReferences(`<img src="${src}">`,context),/<img/);
  const html=rewriteImageReferences('<a href="https://example.org/original"><img alt="Original" src="plots/a?b#c%25.png"></a>',context);
  const doc=new JSDOM(html).window.document;assert.equal(doc.querySelector('a').href,'https://example.org/original');
  assert.equal(doc.querySelector('a button'),null);assert.ok(doc.querySelector('button'));
  assert.match(rewriteImageReferences('<img src="plots%2Fa%3Fb%23c%2525.png">',context),/data-image-id="image-1"/);
  assert.doesNotMatch(rewriteImageReferences('<img src="missing.png">',context),/generated image above/);
});

test('ordinary assistant text never scans transcript metadata',()=>{
  const {createRewriter}=require('../renderer/chat/renderer-artifact-image-references');
  const messages=new Proxy([],{get(){throw new Error('transcript scanned');}});
  assert.equal(createRewriter(messages,{},'s1',documentRef)('<p>Hello</p>'),'<p>Hello</p>');
});
