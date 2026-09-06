const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderApprovalBlock } = require('../renderer/chat/renderer-approval-block');

function parseFragment(html) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`);
  return dom.window.document.getElementById('root');
}

test('renderApprovalBlock (inline) wraps the block in approval-gap-row with both call-id attributes', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_42',
    approvalId: 'approval_stream_42_call_42',
    toolName: 'Read',
    displayToolName: 'Read',
    prompt: 'Approve file read?',
    mode: 'inline',
  });
  const root = parseFragment(html);
  const gap = root.querySelector('.approval-gap-row');
  assert.ok(gap, 'expected approval-gap-row wrapper');
  assert.equal(gap.getAttribute('data-tool-call-id'), 'call_42');
  assert.equal(gap.getAttribute('data-call-id'), 'call_42');
  assert.equal(gap.getAttribute('data-approval-id'), 'approval_stream_42_call_42');
  assert.equal(gap.getAttribute('role'), 'status');
  assert.equal(gap.getAttribute('aria-live'), 'polite');

  const block = gap.querySelector('.tool-approval-block');
  assert.ok(block, 'expected nested tool-approval-block');
  assert.equal(block.getAttribute('data-tool-call-id'), 'call_42');
  assert.equal(block.getAttribute('data-call-id'), 'call_42');
  assert.equal(block.getAttribute('data-approval-id'), 'approval_stream_42_call_42');

  const prompt = block.querySelector('.tool-approval-prompt');
  assert.ok(prompt && prompt.tagName.toLowerCase() === 'p', 'inline prompt should be a <p>');
  assert.equal(prompt.textContent, 'Approve file read?');
});

test('renderApprovalBlock (card) returns the block without the gap wrapper', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_7',
    toolName: 'WriteFile',
    displayToolName: 'Write',
    prompt: 'Allow Write?',
    mode: 'card',
  });
  const root = parseFragment(html);
  assert.equal(root.querySelector('.approval-gap-row'), null, 'card mode should not emit approval-gap-row');
  const block = root.querySelector('.tool-approval-block');
  assert.ok(block, 'expected tool-approval-block');
  assert.equal(block.getAttribute('data-tool-call-id'), 'call_7');
  assert.equal(block.getAttribute('data-call-id'), 'call_7');
  const prompt = block.querySelector('.tool-approval-prompt');
  assert.ok(prompt && prompt.tagName.toLowerCase() === 'div', 'card prompt should be a <div>');
  assert.equal(prompt.textContent, 'Allow Write?');
});

test('renderApprovalBlock emits Allow once / Always allow / Deny buttons', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_9',
    approvalId: 'approval_stream_9_call_9',
    toolName: 'Bash',
    displayToolName: 'Bash',
    prompt: 'Run npm test?',
    mode: 'card',
  });
  const root = parseFragment(html);

  const approveBtn = root.querySelector('.tool-approve-btn');
  assert.ok(approveBtn, 'expected approve button');
  assert.equal(approveBtn.textContent.trim(), 'Allow once');
  assert.equal(approveBtn.getAttribute('data-approval-scope'), 'once');
  assert.equal(approveBtn.getAttribute('data-tool-call-id'), 'call_9');
  assert.equal(approveBtn.getAttribute('data-call-id'), 'call_9');
  assert.equal(approveBtn.getAttribute('data-approval-id'), 'approval_stream_9_call_9');
  assert.equal(approveBtn.getAttribute('data-action'), 'approve');
  assert.match(approveBtn.getAttribute('aria-label'), /Allow Bash/);

  const denyBtn = root.querySelector('.tool-deny-btn');
  assert.ok(denyBtn, 'expected deny button');
  assert.equal(denyBtn.textContent.trim(), 'Deny');
  assert.equal(denyBtn.getAttribute('data-tool-call-id'), 'call_9');
  assert.equal(denyBtn.getAttribute('data-call-id'), 'call_9');
  assert.equal(denyBtn.getAttribute('data-approval-id'), 'approval_stream_9_call_9');
  assert.equal(denyBtn.getAttribute('data-action'), 'deny');

  // The persistent decision is its own button, not a modifier on Allow: a
  // checkbox ticked earlier and forgotten flipped a tool to auto for good.
  const alwaysBtn = root.querySelector('.tool-approve-always-btn');
  assert.ok(alwaysBtn, 'expected an Always allow button');
  assert.equal(alwaysBtn.textContent.trim(), 'Always allow');
  assert.ok(alwaysBtn.classList.contains('tool-approve-btn'), 'it is an approve button too');
  assert.equal(alwaysBtn.getAttribute('data-action'), 'approve');
  assert.equal(alwaysBtn.getAttribute('data-approval-scope'), 'always');
  assert.equal(alwaysBtn.getAttribute('data-call-id'), 'call_9');
  assert.equal(alwaysBtn.getAttribute('data-approval-id'), 'approval_stream_9_call_9');
  assert.match(alwaysBtn.getAttribute('aria-label'), /Always allow Bash/);
  assert.match(alwaysBtn.getAttribute('title'), /stop asking for Bash/);
  assert.equal(root.querySelector('input[type="checkbox"]'), null, 'no checkbox remains');
  assert.equal(root.querySelectorAll('.tool-approval-actions > button').length, 3);
});

test('renderApprovalBlock falls back to a default prompt when none is supplied', () => {
  const inlineHtml = renderApprovalBlock({
    toolCallId: 'call_1',
    toolName: 'Read',
    mode: 'inline',
  });
  const cardHtml = renderApprovalBlock({
    toolCallId: 'call_1',
    toolName: 'Read',
    displayToolName: 'Read',
    mode: 'card',
  });
  assert.match(parseFragment(inlineHtml).querySelector('.tool-approval-prompt').textContent, /Approval is required/);
  assert.match(parseFragment(cardHtml).querySelector('.tool-approval-prompt').textContent, /Approve Read\?/);
});

test('renderApprovalBlock orders headline, consequence and facts before the raw preview', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_policy',
    toolName: 'write_file',
    displayToolName: 'Write file',
    prompt: 'Approve the requested write?',
    policyScope: 'Workspace files',
    policyConsequence: 'May change data in this scope.',
    facts: [{ kind: 'write', label: 'Writes notes.md' }],
    commandText: 'notes.md',
    mode: 'inline',
  });
  const root = parseFragment(html);
  const block = root.querySelector('.tool-approval-block');
  const headline = block.querySelector('.tool-approval-prompt');
  const consequence = block.querySelector('.tool-approval-consequence');
  const facts = block.querySelector('.tool-approval-facts');
  const command = block.querySelector('.tool-approval-command');
  const actions = block.querySelector('.tool-approval-actions');

  assert.equal(headline.textContent, 'Approve the requested write?');
  assert.equal(consequence.textContent, 'May change data in this scope.');
  assert.deepEqual(
    [...facts.querySelectorAll('.tool-approval-fact')].map((chip) => chip.textContent),
    ['Write file', 'Workspace files', 'Writes notes.md']
  );
  assert.ok(
    headline.compareDocumentPosition(command) & root.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
    'context should precede the raw preview'
  );
  assert.ok(
    command.compareDocumentPosition(actions) & root.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
    'raw preview should precede actions'
  );
});

test('renderApprovalBlock replaces the generic consequence with the specific approval reason', () => {
  const reason = 'This command can delete or overwrite files (rm). Approve to continue.';
  const html = renderApprovalBlock({
    toolCallId: 'call_reason',
    toolName: 'run_command',
    policyScope: 'Local command execution',
    policyConsequence: 'May change data in this scope.',
    reason,
    mode: 'card',
  });
  const consequence = parseFragment(html).querySelector('.tool-approval-consequence');

  assert.equal(consequence.textContent, reason);
  assert.doesNotMatch(html, /May change data in this scope\./);
});

test('renderApprovalBlock without a reason or purpose renders the derived card exactly', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_no_reason',
    approvalId: 'approval_no_reason',
    toolName: 'write_file',
    displayToolName: 'Write file',
    prompt: 'Approve the requested write?',
    policyScope: 'Workspace files',
    policyConsequence: 'May change data in this scope.',
    mode: 'card',
  });
  const expectedMarkup = '<div class="tool-approval-block" data-tool-call-id="call_no_reason" data-call-id="call_no_reason" data-approval-id="approval_no_reason">'
    + '<div class="tool-approval-prompt" data-approval-intent="derived">Approve the requested write?</div>'
    + '<div class="tool-approval-consequence">May change data in this scope.</div>'
    + '<ul class="tool-approval-facts"><li class="tool-approval-fact" data-approval-fact="tool">Write file</li>'
    + '<li class="tool-approval-fact" data-approval-fact="scope">Workspace files</li></ul>'
    + '<div class="tool-approval-actions"><button class="tool-approve-btn" type="button" data-action="approve" data-approval-scope="once" data-tool-call-id="call_no_reason" data-call-id="call_no_reason" data-approval-id="approval_no_reason" title="Allow this tool call" aria-label="Allow Write file once">Allow once</button>'
    + '<button class="tool-approve-btn tool-approve-always-btn" type="button" data-action="approve" data-approval-scope="always" data-tool-call-id="call_no_reason" data-call-id="call_no_reason" data-approval-id="approval_no_reason" title="Allow this tool call and stop asking for Write file" aria-label="Always allow Write file">Always allow</button>'
    + '<button class="tool-deny-btn" type="button" data-action="deny" data-tool-call-id="call_no_reason" data-call-id="call_no_reason" data-approval-id="approval_no_reason" title="Deny this tool call" aria-label="Deny Write file">Deny</button></div></div>';

  assert.equal(html, expectedMarkup);
});

test('renderApprovalBlock degrades older or malformed policy metadata to neutral copy', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_old',
    toolName: 'external_tool',
    policyScope: { unsafe: true },
    policyConsequence: '',
    mode: 'inline',
  });
  const root = parseFragment(html);

  assert.equal(root.querySelector('.tool-approval-policy-fallback').textContent, 'Review requested input');
  assert.equal(root.querySelector('[data-approval-fact="scope"]'), null);
});

test('renderApprovalBlock treats policy fields as independently optional', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_partial_policy',
    toolName: 'future_tool',
    policyScope: 'Requested tool',
    policyConsequence: null,
    mode: 'inline',
  });
  const root = parseFragment(html);

  assert.equal(root.querySelector('[data-approval-fact="scope"]').textContent, 'Requested tool');
  // A known scope but no consequence: the chip carries it and no empty
  // consequence line is drawn.
  assert.equal(root.querySelector('.tool-approval-consequence'), null);
  assert.equal(root.querySelector('.tool-approval-policy-fallback'), null);
});

test('renderApprovalBlock rejects unknown future policy presentation strings', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_policy_bounds',
    toolName: 'write_file',
    policyScope: `<script>${'x'.repeat(200)}</script>`,
    policyConsequence: 'May change data.',
    mode: 'card',
  });
  const root = parseFragment(html);
  assert.equal(root.querySelector('script'), null);
  assert.equal(root.querySelector('[data-approval-fact="scope"]'), null);
  // 'May change data.' is not in the consequence enum either, so both policy
  // strings are rejected and the card falls back to neutral copy.
  assert.equal(root.querySelector('.tool-approval-consequence'), null);
  assert.equal(root.querySelector('.tool-approval-policy-fallback').textContent, 'Review requested input');
});

test('renderApprovalBlock escapes user-controlled strings', () => {
  const html = renderApprovalBlock({
    toolCallId: '"><script>x</script>',
    toolName: 'Read<>',
    displayToolName: 'Read<>',
    prompt: 'Run <script>evil()</script>?',
    policyScope: 'Requested tool',
    reason: 'Because <script>reason()</script>',
    mode: 'card',
  });
  assert.doesNotMatch(html, /<script>/, 'no raw <script> should survive escaping');
  assert.match(html, /&lt;script&gt;/, 'script tag should appear escaped');
  assert.match(html, /Because &lt;script&gt;reason\(\)&lt;\/script&gt;/);
  assert.match(html, /Read&lt;&gt;/, 'tool name should appear escaped');
});

test('renderApprovalBlock uses the injected escapeHtml when provided', () => {
  const seen = [];
  const escapeHtml = (value) => {
    seen.push(value);
    return `~${String(value).replace(/[<>&"']/g, '?')}~`;
  };
  const html = renderApprovalBlock({
    toolCallId: 'call_x',
    toolName: 'Tool',
    displayToolName: 'Tool',
    prompt: 'Hello',
    mode: 'inline',
  }, { escapeHtml });
  assert.ok(seen.length > 0, 'custom escapeHtml should be called');
  assert.match(html, /~Hello~/);
  assert.match(html, /~call_x~/);
});

test('renderApprovalBlock quotes the command being approved as a bounded code block', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_cmd',
    toolName: 'run_command',
    displayToolName: 'Bash',
    prompt: 'Jenny wants to run: npm test',
    commandText: 'npm test -- --grep "approval"',
    mode: 'inline',
  });
  const root = parseFragment(html);
  const command = root.querySelector('.tool-approval-command code');
  assert.ok(command, 'expected the command preview block');
  assert.equal(command.textContent, 'npm test -- --grep "approval"');
});

test('renderApprovalBlock clips an oversized command preview with an honest marker', () => {
  const longCommand = 'x'.repeat(700);
  const html = renderApprovalBlock({
    toolCallId: 'call_long',
    toolName: 'run_command',
    prompt: 'Approve?',
    commandText: longCommand,
    mode: 'inline',
  });
  const root = parseFragment(html);
  const command = root.querySelector('.tool-approval-command code');
  assert.ok(command);
  assert.ok(command.textContent.startsWith('x'.repeat(600)));
  assert.match(command.textContent, /\(\+100 more chars\)/);
});

test('renderApprovalBlock omits the command block when empty or identical to the prompt', () => {
  const emptyHtml = renderApprovalBlock({
    toolCallId: 'call_none',
    toolName: 'Read',
    prompt: 'Approve file read?',
    mode: 'inline',
  });
  assert.equal(parseFragment(emptyHtml).querySelector('.tool-approval-command'), null);

  const duplicateHtml = renderApprovalBlock({
    toolCallId: 'call_dup',
    toolName: 'Read',
    prompt: 'src/app.js',
    commandText: 'src/app.js',
    mode: 'inline',
  });
  assert.equal(parseFragment(duplicateHtml).querySelector('.tool-approval-command'), null);
});

test('renderApprovalBlock escapes hostile command text', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_esc',
    toolName: 'run_command',
    prompt: 'Approve?',
    commandText: 'echo "<script>alert(1)</script>"',
    mode: 'card',
  });
  const root = parseFragment(html);
  assert.equal(root.querySelector('script'), null);
  assert.match(root.querySelector('.tool-approval-command code').textContent, /<script>alert\(1\)<\/script>/);
});

test('a model-authored purpose becomes the headline and is marked as stated', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_purpose',
    toolName: 'python_execute',
    displayToolName: 'Python',
    prompt: 'Approve Python?',
    purpose: 'Check which colour keys the page uses but never defines',
    facts: [{ kind: 'execute', label: 'Jenny cannot check what this does' }],
    mode: 'card',
  });
  const headline = parseFragment(html).querySelector('.tool-approval-prompt');

  assert.equal(headline.textContent, 'Jenny says Check which colour keys the page uses but never defines');
  assert.equal(headline.getAttribute('data-approval-intent'), 'stated');
  assert.doesNotMatch(html, /Approve Python\?/);
});

test('an absent purpose leaves the derived prompt as the headline', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_no_purpose', toolName: 'python_execute', prompt: 'Approve Python?', mode: 'card',
  });
  const headline = parseFragment(html).querySelector('.tool-approval-prompt');

  assert.equal(headline.textContent, 'Approve Python?');
  assert.equal(headline.getAttribute('data-approval-intent'), 'derived');
});

test('facts are bounded, escaped, and malformed entries are dropped rather than rendered blank', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_facts',
    toolName: 'run_command',
    displayToolName: 'Bash',
    facts: [
      { kind: 'execute', label: '<script>alert(1)</script>' },
      { kind: '', label: 'no kind' },
      null,
      { kind: 'write', label: 'x'.repeat(400) },
      { kind: 'read', label: 'third' },
      { kind: 'read', label: 'fourth' },
      { kind: 'read', label: 'fifth is past the cap' },
    ],
    mode: 'card',
  });
  const root = parseFragment(html);
  const chips = [...root.querySelectorAll('.tool-approval-fact')];

  assert.equal(root.querySelector('script'), null);
  // The two malformed entries are dropped, not rendered blank, and the fifth
  // surviving fact is past MAX_FACTS: one tool chip plus four facts.
  assert.equal(chips.length, 5);
  assert.equal(chips[0].textContent, 'Bash');
  assert.equal(chips[1].textContent, '<script>alert(1)</script>');
  assert.equal(chips[2].textContent.length, 160);
  assert.doesNotMatch(html, /fifth is past the cap/);
});

test('a multi-line payload folds behind a disclosure; a one-liner stays visible', () => {
  const folded = renderApprovalBlock({
    toolCallId: 'call_multi', toolName: 'python_execute', prompt: 'Approve Python?',
    commandText: 'import re\nprint(re)', mode: 'card',
  });
  const foldedRoot = parseFragment(folded);
  assert.equal(foldedRoot.querySelector('.tool-approval-disclosure > summary').textContent,
    'Show all 2 lines of Python');
  assert.ok(foldedRoot.querySelector('.tool-approval-disclosure .tool-approval-command'));

  const inlineOne = renderApprovalBlock({
    toolCallId: 'call_one', toolName: 'run_command', prompt: 'Approve Bash?',
    commandText: 'npm test', mode: 'card',
  });
  const inlineRoot = parseFragment(inlineOne);
  assert.equal(inlineRoot.querySelector('.tool-approval-disclosure'), null);
  assert.equal(inlineRoot.querySelector('.tool-approval-command').textContent, 'npm test');
});

test('the approval card carries no side-border accent', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-tools.css'), 'utf8');
  const block = css.slice(css.indexOf('.tool-approval-block {'));
  assert.doesNotMatch(block.slice(0, block.indexOf('}')), /border-left/);
});

test('a stated intent is attributed to Jenny in the visible text; a derived prompt is not', () => {
  const stated = parseFragment(renderApprovalBlock({
    toolCallId: 'call_intent', toolName: 'run_command', prompt: 'Approve Bash?',
    purpose: 'Run the focused tests', mode: 'card',
  }));
  const prompt = stated.querySelector('.tool-approval-prompt');
  assert.equal(prompt.getAttribute('data-approval-intent'), 'stated');
  const source = prompt.querySelector('.tool-approval-intent-source');
  assert.ok(source, 'the attribution is in the DOM, not only in a data attribute');
  assert.equal(source.textContent, 'Jenny says');
  assert.equal(prompt.textContent, 'Jenny says Run the focused tests');

  const derived = parseFragment(renderApprovalBlock({
    toolCallId: 'call_intent', toolName: 'run_command', prompt: 'Approve Bash?', mode: 'card',
  }));
  assert.equal(derived.querySelector('.tool-approval-intent-source'), null);
  assert.equal(derived.querySelector('.tool-approval-prompt').textContent, 'Approve Bash?');
});

test('the disclosure counts the whole payload in the tool\'s own unit, not the clipped preview', () => {
  // 40 lines, well past the 600-char preview cap: the summary must still say
  // 40, because that is what the reader is approving.
  const code = Array.from({ length: 40 }, (_, index) => `value_${index} = ${'x'.repeat(30)}`).join('\n');
  const python = parseFragment(renderApprovalBlock({
    toolCallId: 'call_long', toolName: 'python_execute', prompt: 'Approve Python?',
    commandText: code, mode: 'card',
  }));
  assert.equal(python.querySelector('.tool-approval-disclosure > summary').textContent,
    'Show all 40 lines of Python');
  assert.match(python.querySelector('.tool-approval-command').textContent, /more chars\)$/);

  const shell = parseFragment(renderApprovalBlock({
    toolCallId: 'call_sh', toolName: 'run_command', prompt: 'Approve Bash?',
    commandText: 'cd app\nnpm test', mode: 'card',
  }));
  assert.equal(shell.querySelector('.tool-approval-disclosure > summary').textContent,
    'Show all 2 lines of shell');

  const moves = parseFragment(renderApprovalBlock({
    toolCallId: 'call_mv', toolName: 'move_file', prompt: 'Approve moves?',
    commandText: 'a.txt -> b.txt\nc.txt -> d.txt\ne.txt -> f.txt', mode: 'card',
  }));
  assert.equal(moves.querySelector('.tool-approval-disclosure > summary').textContent,
    'Show all 3 moves');
});

test('free text on the card loses format controls and marks a clip visibly', () => {
  // A right-to-left override in a model-authored purpose would render the
  // headline backwards; the bounded text must not carry it.
  const html = renderApprovalBlock({
    toolCallId: 'call_bidi', toolName: 'delete_file', prompt: 'Approve delete?',
    purpose: 'Deletes \u202Etxt.sgol\u202C and a\u200Bb',
    reason: 'r'.repeat(600),
    mode: 'card',
  });
  const root = parseFragment(html);
  const headline = root.querySelector('.tool-approval-prompt').textContent;
  assert.doesNotMatch(headline, /[\u202E\u202C\u200B]/);
  assert.equal(headline, 'Jenny says Deletes txt.sgol and ab');

  // The backend bounds a reason at 512 + '...'; the card's own bound sits
  // above that so a sanitized reason is never clipped twice, and a longer
  // raw reason (persisted rows never met the sanitizer) ends in an ellipsis.
  const reason = root.querySelector('.tool-approval-consequence').textContent;
  assert.equal(Array.from(reason).length, 520);
  assert.ok(reason.endsWith('\u2026'), 'a clipped reason must not read as a whole sentence');
  const sanitizedShape = renderApprovalBlock({
    toolCallId: 'call_bidi', toolName: 'delete_file', prompt: 'Approve delete?',
    reason: `${'s'.repeat(512)}...`, mode: 'card',
  });
  assert.equal(parseFragment(sanitizedShape).querySelector('.tool-approval-consequence').textContent,
    `${'s'.repeat(512)}...`);
});
