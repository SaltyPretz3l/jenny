const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { SetupService } = require('../services/setup-service');
const { DEFAULT_SETUP } = require('../services/shell-config-setup-state');

function cloneSetup(setup = DEFAULT_SETUP) {
  return {
    ...setup,
    steps: {
      ...setup.steps,
    },
  };
}

function createConfigService(state = {}) {
  const store = {
    setup: cloneSetup(state.setup),
  };
  return {
    getSetupState: () => cloneSetup(store.setup),
    updateSetupState(patch) {
      store.setup = { ...store.setup, ...patch };
      return this.getSetupState();
    },
  };
}

test('deleteOllamaModel deletes a valid tag on exit 0', async () => {
  let spawnArgs = null;
  const service = new SetupService({
    configService: createConfigService(),
    platform: 'linux',
    env: {},
    fileExists: () => false,
    spawnImpl: (cmd, args) => {
      spawnArgs = { cmd, args };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.emit('exit', 0);
      });
      return child;
    },
  });

  const result = await service.deleteOllamaModel({ model: 'llama3.2:latest' });

  assert.equal(result.status, 'deleted');
  assert.equal(result.model, 'llama3.2:latest');
  assert.ok(spawnArgs, 'spawn should have been called');
  assert.equal(spawnArgs.cmd, 'ollama');
  assert.deepEqual(spawnArgs.args, ['rm', 'llama3.2:latest']);
});

test('deleteOllamaModel rejects an invalid tag before spawning', async () => {
  let spawnCount = 0;
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      spawnCount += 1;
      return new EventEmitter();
    },
  });

  const result = await service.deleteOllamaModel({ model: '--rf /' });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'invalid_tag');
  assert.equal(spawnCount, 0);
});

test('deleteOllamaModel rejects an empty/missing tag before spawning', async () => {
  let spawnCount = 0;
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      spawnCount += 1;
      return new EventEmitter();
    },
  });

  const result = await service.deleteOllamaModel({});

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'invalid_tag');
  assert.equal(spawnCount, 0);
});

test('deleteOllamaModel maps "not found" stderr to not_found', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from("Error: model 'ghost:latest' not found\n"));
        child.emit('exit', 1);
      });
      return child;
    },
  });

  const result = await service.deleteOllamaModel({ model: 'ghost:latest' });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'not_found');
});

test('deleteOllamaModel maps a generic non-zero exit to delete_failed', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from('Error: something else went wrong\n'));
        child.emit('exit', 1);
      });
      return child;
    },
  });

  const result = await service.deleteOllamaModel({ model: 'llama3.2:latest' });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'delete_failed');
});

test('deleteOllamaModel surfaces a structured error when spawn throws', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      throw new Error('ENOENT: ollama not found');
    },
  });

  const result = await service.deleteOllamaModel({ model: 'llama3.2:latest' });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'delete_failed');
  assert.equal(result.message, 'Could not start model removal.');
  assert.doesNotMatch(result.message, /ENOENT/);
});

test('deleteOllamaModel refuses to run while a pull of the same tag is in flight', async () => {
  let spawnCount = 0;
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      spawnCount += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      // Never exits during this test -- pull stays "in flight".
      return child;
    },
  });

  service.startOllamaPull({ model: 'llama3.2:latest' });
  // Only the pull's spawn should have run so far.
  assert.equal(spawnCount, 1);

  const result = await service.deleteOllamaModel({ model: 'llama3.2:latest' });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'pull_in_progress');
  // deleteOllamaModel must not have spawned `ollama rm`.
  assert.equal(spawnCount, 1);
});

test('deleteOllamaModel allows deleting a different tag while another pull is in flight', async () => {
  let spawnCount = 0;
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: (cmd, args) => {
      spawnCount += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      if (args && args[0] === 'rm') {
        setImmediate(() => child.emit('exit', 0));
      }
      return child;
    },
  });

  service.startOllamaPull({ model: 'llama3.2:latest' });
  const result = await service.deleteOllamaModel({ model: 'qwen3:latest' });

  assert.equal(result.status, 'deleted');
  assert.equal(spawnCount, 2);
});

test('deleteOllamaModel never throws to the caller', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      throw new Error('boom');
    },
  });

  const spawnThrow = await service.deleteOllamaModel({ model: 'llama3.2:latest' });
  assert.equal(spawnThrow.status, 'failed');
  assert.equal(spawnThrow.code, 'delete_failed');
  assert.equal(spawnThrow.message, 'Could not start model removal.');
  assert.doesNotMatch(spawnThrow.message, /boom/);

  const emptyTag = await service.deleteOllamaModel({ model: '' });
  assert.equal(emptyTag.status, 'failed');
  assert.equal(emptyTag.code, 'invalid_tag');

  const noPayload = await service.deleteOllamaModel();
  assert.equal(noPayload.status, 'failed');
  assert.equal(noPayload.code, 'invalid_tag');
});
