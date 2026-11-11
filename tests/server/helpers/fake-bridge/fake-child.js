'use strict';

// A child-process-shaped object for the bridge supervisors: stdin (Writable),
// stdout (Readable), pid, exitCode, kill() and an `exit` event. It speaks the
// bridge control channel (one JSON object per line) and hands each parsed line
// to whatever logic is bound to it. No process is spawned.

const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');

const { MAX_LINE_BYTES } = require('../../../../server/team/transport/control-channel');

let nextPid = 424200;

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = nextPid;
    nextPid += 1;
    this.exitCode = null;
    this.signalCode = null;
    this.exited = false;
    this.received = [];
    this.handlers = {};
    let pending = Buffer.alloc(0);
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        pending = Buffer.concat([pending, chunk]);
        let newline = pending.indexOf(0x0a);
        while (newline !== -1 && !this.exited) {
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          this.feed(line);
          newline = pending.indexOf(0x0a);
        }
        if (pending.length > MAX_LINE_BYTES) this.protocolFailure();
        done();
      },
      final: (done) => {
        done();
        setImmediate(() => { if (!this.exited && this.handlers.onStdinEnd) this.handlers.onStdinEnd(); });
      },
    });
    this.stdout = new Readable({ read() {} });
  }

  /** Binds the logic that reacts to the parent: { onMessage, onStdinEnd, onTerminate }. */
  bind(handlers) {
    this.handlers = handlers;
  }

  feed(line) {
    let message;
    try {
      message = line.length <= MAX_LINE_BYTES ? JSON.parse(line.toString('utf8')) : null;
    } catch {
      message = null;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.protocolFailure();
      return;
    }
    this.received.push(message);
    if (this.handlers.onMessage) this.handlers.onMessage(message);
  }

  protocolFailure() {
    this.write({ t: 'error', reason: 'protocol_invalid' });
    this.exit(2);
  }

  /** Writes one control line to the parent. Ignored once the child has exited. */
  write(message) {
    this.writeRaw(`${JSON.stringify(message)}\n`);
  }

  writeRaw(text) {
    if (!this.exited) this.stdout.push(text);
  }

  exit(code, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    if (this.handlers.onTerminate) this.handlers.onTerminate();
    this.stdout.push(null);
    this.stdin.destroy();
    setImmediate(() => this.emit('exit', code, signal));
  }

  /** Test hook: the child dies on its own. */
  crash(code = 1) {
    this.exit(code);
  }

  kill() {
    this.exit(null, 'SIGTERM');
    return true;
  }
}

module.exports = { FakeChildProcess, MAX_LINE_BYTES };
