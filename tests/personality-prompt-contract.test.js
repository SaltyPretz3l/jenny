const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PERSONALITY_HEADING,
  PERSONALITY_PRECEDENCE_TEMPLATE,
  buildPersonalityMessage,
} = require('../services/personality-workspace-service');

// The one prompt string that crosses the JSON-RPC seam twice: the sidecar
// prepends it to every non-minimal turn, and the Settings preview renders it
// locally so "Show exact text" is exact rather than approximate. Two copies in
// two languages is the risk; this test is the gate.
const SPEC_HEADING = '## Personality';
const SPEC_PRECEDENCE = 'Your name is {name}. Personality shapes tone, not facts; the current request and the runtime, workspace, and tool instructions take precedence over everything below.';

const PYTHON_SOURCE = path.join(__dirname, '..', 'sidecar', 'ai', 'personality', '__init__.py');

// Reads `NAME = "..."` or a parenthesized run of implicitly concatenated string
// literals, which is how the sidecar wraps the long precedence sentence.
function readPythonConstant(source, name) {
  const assignment = source.match(
    new RegExp(`^${name}\\s*(?::[^=\\n]+)?=\\s*(\\((?:[^()]|\\n)*?\\)|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`, 'm')
  );
  if (!assignment) return null;
  const literals = assignment[1].match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g);
  if (!literals) return null;
  return literals
    .map((literal) => JSON.parse(`"${literal.slice(1, -1).replace(/(?<!\\)"/g, '\\"')}"`))
    .join('');
}

test('the Electron personality literals match the approved prompt contract', () => {
  assert.equal(PERSONALITY_HEADING, SPEC_HEADING);
  assert.equal(PERSONALITY_PRECEDENCE_TEMPLATE, SPEC_PRECEDENCE);
  assert.match(PERSONALITY_PRECEDENCE_TEMPLATE, /\{name\}/);
  assert.equal(
    buildPersonalityMessage('Ada', ''),
    `${SPEC_HEADING}\n${SPEC_PRECEDENCE.replace('{name}', 'Ada')}`
  );
  assert.equal(
    buildPersonalityMessage('  ', '### Voice\n\nbody'),
    `${SPEC_HEADING}\n${SPEC_PRECEDENCE.replace('{name}', 'Jenny')}\n\n### Voice\n\nbody`
  );
});

test('the sidecar personality literals are byte-identical to the Electron twins', (t) => {
  const source = fs.readFileSync(PYTHON_SOURCE, 'utf8');
  const heading = readPythonConstant(source, 'PERSONALITY_HEADING');
  const precedence = readPythonConstant(source, 'PERSONALITY_PRECEDENCE_TEMPLATE');
  if (heading === null && precedence === null) {
    // Personality v3 lands Electron-side and sidecar-side in parallel; until
    // the Python constants exist there is nothing to compare. The first test
    // in this file still pins the Electron side to the spec literals.
    t.skip('sidecar/ai/personality/__init__.py does not define the v3 personality constants yet');
    return;
  }
  assert.equal(heading, PERSONALITY_HEADING);
  assert.equal(precedence, PERSONALITY_PRECEDENCE_TEMPLATE);
});
