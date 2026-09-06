const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { SetupService, parsePullLine } = require('../services/setup-service');
const { createConfigService } = require('./helpers/setup-service-test-support');

/* Ollama detection fallbacks + pull output parsing (split from
   setup-service.test.js to respect the file-size ceiling). */

test('detectOllama reports running + version from the API', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.5.1' }) }),
  });
  const result = await service.detectOllama();
  assert.equal(result.running, true);
  assert.equal(result.installed, true);
  assert.equal(result.version, '0.5.1');
  assert.equal(result.source, 'api');
});

test('detectOllama falls back to a PATH lookup when the API is unreachable', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    commandLookupImpl: async () => 'C:/Program Files/Ollama/ollama.exe',
  });
  const result = await service.detectOllama();
  assert.equal(result.running, false);
  assert.equal(result.installed, true);
  assert.equal(result.source, 'path');
  assert.match(result.installPath, /ollama/i);
});

test('detectOllama reports not installed when API + PATH both miss', async () => {
  // Pin fileExists so this stays hermetic on machines that happen to have a
  // real Ollama install at the well-known winget path (the absolute-path
  // fallback is exercised separately below).
  const service = new SetupService({
    configService: createConfigService(),
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    commandLookupImpl: async () => '',
    fileExists: () => false,
  });
  const result = await service.detectOllama();
  assert.equal(result.installed, false);
  assert.equal(result.running, false);
  assert.equal(result.source, 'none');
});

test('detectOllama falls back to the known absolute install path when API + PATH both miss', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    commandLookupImpl: async () => '',
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:/Users/x/AppData/Local', ProgramFiles: 'C:/Program Files' },
    fileExists: (candidate) => /Programs[\\/]Ollama[\\/]ollama\.exe$/.test(candidate),
  });
  const result = await service.detectOllama();
  assert.equal(result.installed, true);
  assert.equal(result.running, false);
  assert.equal(result.source, 'path-fallback');
  assert.match(result.installPath, /ollama\.exe$/);
});

test('parsePullLine recognizes status words and layer progress', () => {
  assert.equal(parsePullLine(''), null);
  assert.equal(parsePullLine('pulling manifest').kind, 'status');
  assert.equal(parsePullLine('verifying sha256 digest').kind, 'status');
  assert.equal(parsePullLine('success').kind, 'success');
  const layer = parsePullLine('pulling 1a2b3c4d5e6f... 42% 4.2 GB/10.0 GB');
  assert.equal(layer.kind, 'layer');
  assert.equal(layer.digest, '1a2b3c4d5e6f');
  assert.equal(layer.percent, 42);
  assert.equal(layer.total, 10 * 1024 ** 3);
});

test('setup service emits real pull percent from CR-delimited progress and snaps to 100', async () => {
  const events = [];
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('pulling manifest\n'));
        child.stdout.emit('data', Buffer.from('pulling abc123def456... 10% 1.0 GB/10.0 GB\r'));
        child.stdout.emit('data', Buffer.from('pulling abc123def456... 50% 5.0 GB/10.0 GB\r'));
        child.stdout.emit('data', Buffer.from('success\n'));
        child.emit('exit', 0);
      });
      return child;
    },
    requestIdProvider: () => 'pull-real-1',
  });
  service.on('model-pull-progress', (event) => events.push(event));

  const pull = service.startOllamaPull({ model: 'gemma4:12b' });
  const result = await pull.promise;

  assert.equal(result.status, 'completed');
  assert.equal(result.percent, 100);
  assert.equal(result.totalBytes, 10 * 1024 ** 3);
  assert.equal(result.bytes, 5 * 1024 ** 3);
  assert.ok(events.length <= 2, 'burst progress must be throttled while terminal state still emits');
});

test('setup service strips ANSI redraw codes from the emitted pull summary', async () => {
  // Regression for the fresh-install onboarding bug: ollama wraps its in-place
  // progress redraw in cursor/erase/synchronized-output control sequences, which
  // piped stdio carries verbatim. handleData must strip them so the wizard's
  // progress label never shows raw escape codes (e.g. "...2m21s\x1b[K\x1b[?25h").
  const ESC = String.fromCharCode(27);
  const events = [];
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit(
          'data',
          Buffer.from(`pulling abc123def456... 50% 5.0 GB/10.0 GB 2m21s${ESC}[K${ESC}[?25h${ESC}[?2026l\r`)
        );
        child.emit('exit', 0);
      });
      return child;
    },
    requestIdProvider: () => 'pull-ansi-1',
  });
  service.on('model-pull-progress', (event) => events.push(event));

  const pull = service.startOllamaPull({ model: 'gemma4:12b' });
  const result = await pull.promise;
  // The visible label is clean: no ESC byte and no leaked control-sequence text.
  assert.ok(!pull.lastOutputLine.includes(ESC), 'summary must not carry the ESC byte');
  assert.ok(
    !pull.lastOutputLine.includes('[K') && !pull.lastOutputLine.includes('[?25h'),
    'summary must not carry leaked control codes'
  );
  // ...while the numeric progress is still parsed correctly from the same line.
  assert.equal(result.totalBytes, 10 * 1024 ** 3);
  assert.equal(result.bytes, 5 * 1024 ** 3);
});

test('disposeActivePulls drains every in-flight pull and reports unconfirmed child exits', async () => {
  const kills = [];
  let spawnCount = 0;
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      spawnCount += 1;
      const which = spawnCount;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { kills.push(which); };
      return child;
    },
  });

  const events = [];
  service.on('model-pull-progress', (payload) => events.push(payload));
  service.startOllamaPull({ model: 'llama3.2:latest', requestId: 'reap-1' });
  service.startOllamaPull({ model: 'qwen3:latest', requestId: 'reap-2' });

  const reaped = await service.disposeActivePulls();

  assert.equal(reaped, 2, 'both in-flight pulls must be reaped');
  assert.deepEqual(kills.sort(), [1, 2], 'each pull child must be killed');
  assert.equal(service.pullService.activeByModel.size, 0);
  assert.equal(service.pullService.activeByRequestId.size, 0);
  const failed = events.filter((p) => p.status === 'failed');
  assert.equal(failed.length, 2, 'unconfirmed exits must remain visible as failures');
  assert.equal(await service.disposeActivePulls(), 0, 'a second reap is a no-op');
});
