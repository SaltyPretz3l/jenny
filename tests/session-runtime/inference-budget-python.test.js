'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const test = require('node:test');
const { RootRunBudgetStore } = require('../../services/session-runtime/budgets');
const { createInferenceBudget } = require('../../services/session-runtime/inference-budget');
const { InferenceOperations } = require('../../services/session-runtime/inference-operations');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');

const producer = String.raw`
import json
import sys
from types import SimpleNamespace
from sidecar.ai.routing.generation_runtime import generate_step
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.inference_admission import build_inference_admission_callback
from tests.sidecar.runtime.test_inference_admission import _execution_context
from pathlib import Path

def write(message):
    print(json.dumps(message), flush=True)

def reader_factory(_rpc_id, **_kwargs):
    return lambda _timeout: json.loads(sys.stdin.readline())

admit = build_inference_admission_callback(
    request_id="request_1", session_id="session_1", engine_type="ollama",
    execution_context=_execution_context(Path(sys.argv[1])), require_budget=True,
    write_message=write, response_reader_factory=reader_factory, cancel_handle=None,
)
def generate(**kwargs):
    write({"method": "provider.called", "max_tokens": kwargs["max_tokens"]})
    return GenerationResult(content="ok")
engine = SimpleNamespace(get_inference_budget_context_length=lambda: 32768,
    get_model_max_output_tokens=lambda: None, generate_with_tools=generate)
kernel = SimpleNamespace(_engine=engine,
    _config=SimpleNamespace(engine_type="ollama", model="controlled", max_tokens=128,
        temperature=0.0, reasoning_effort=None, feature_flags={}, fallback_models=[]),
    _engine_messages=lambda messages, primary_system_text: messages,
    _system_prompt_for_engine=str)
runtime = LoopRuntime(request_id="request_1", session_id="session_1", inference_admission=admit)
for index in range(2):
    try:
        result, _ = generate_step(kernel, latest_user_content="hello",
            working_messages=[{"role": "user", "content": "hello"}], reasoning_effort=None,
            prompt_cache_enabled=False, source_key="main", system_prompt="system",
            tool_schemas=[], cache_break_detector=None, runtime=runtime)
        write({"method": "result", "content": result.content})
    except Exception as error:
        write({"method": "refused", "reason": str(error)})
`;

test('real Python generation reserves durable ceilings before execution and cannot exceed the root', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-budget-wire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RootRunBudgetStore(root);
  const limits = { inference_requests: 1, input_tokens: 32768, output_tokens: 32768 };
  store.create({ rootRunId: 'root_1', authorityFingerprint: 'a'.repeat(64), allowedProviderIds: ['ollama'], limits });
  const budget = createInferenceBudget({ store, rootRunId: 'root_1', workId: 'work_1',
    attemptId: 'attempt_1', providerId: 'ollama', authorityFingerprint: 'a'.repeat(64) });
  const lanes = new RuntimeLaneAdmission();
  const route = captureRuntimeRoute({ engine_type: 'ollama', provider_id: 'ollama',
    configuration_revision: 'config:1', resource_class: 'local', requires_gpu: false });
  const gateway = new InferenceOperations({ lanes, route, budget, requestId: 'request_1',
    sessionId: 'session_1', authorityRevision: 'authority_7', assertCurrent: () => true });
  const python = path.resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  const child = spawn(python, ['-c', producer, root], { cwd: path.resolve('.'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); gateway.close({ producerSettled: true }); });
  const output = []; const failures = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      output.push(message);
      if (message.method === 'runtime.operation') {
        child.stdin.write(`${JSON.stringify({ id: message.id, result: gateway.handle(message.params) })}\n`);
      } else if (message.method === 'provider.called') {
        const durable = new RootRunBudgetStore(root).get('root_1');
        assert.deepEqual(durable.charged, limits);
        assert.equal(durable.reservations.length, 1);
        assert.equal(durable.reservations[0].settlement, null);
      }
    } catch (error) { failures.push(error); child.kill(); }
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  assert.equal(code, 0, stderr);
  assert.deepEqual(failures, []);
  assert.equal(output.filter(item => item.method === 'provider.called').length, 1);
  assert.equal(output.find(item => item.method === 'result').content, 'ok');
  assert.match(output.find(item => item.method === 'refused').reason, /budget_exhausted/u);
  assert.deepEqual(store.get('root_1').charged, limits);
  assert.deepEqual(store.get('root_1').reservations[0].settlement, { consumption: 'unknown', usage: null });
  assert.equal(lanes.snapshot().active_leases, 0);
});
