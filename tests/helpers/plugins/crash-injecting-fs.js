'use strict';

// A crash-injecting wrapper around any fs facade
// (services/plugins/store/fs-facade.js). This is the W4 durability packet's
// core apparatus, and it works only because W3 exposed every durability
// primitive as a SEPARATE facade call instead of folding them into one opaque
// "atomic write": mkdir / writeFile / fsyncFile / renameFile / fsyncDir are
// five distinct interception points, so a crash can land between any two of
// them.
//
// "Crash" here means power loss, not an exception the store might catch and
// compensate for: StoreCrashError is thrown from inside the facade and the
// caller is expected to abandon the whole operation, exactly as a killed
// process would. Tests then run recovery against whatever bytes survived.
//
// Crash points are counted over MUTATING calls only (writeFile, fsyncFile,
// renameFile, fsyncDir, remove, mkdir). Reads cannot damage the store, so
// numbering them would inflate the sweep with points that prove nothing.
//
// Determinism: for a fixed pre-state and a fixed operation, the sequence of
// mutating calls is fixed, so crash point k means the same thing on every run.
// That is what lets `enumerateCrashPoints` do one dry run to size the sweep and
// then replay k = 1..N exhaustively.

const MUTATING_METHODS = Object.freeze([
  'writeFile',
  'fsyncFile',
  'renameFile',
  'fsyncDir',
  'remove',
  'mkdir',
]);

const READ_METHODS = Object.freeze(['readFile', 'list', 'stat']);

class StoreCrashError extends Error {
  constructor(crashPoint, method, path) {
    super(`simulated crash at mutation ${crashPoint} (${method} ${path})`);
    this.name = 'StoreCrashError';
    this.code = 'ESTORECRASH';
    this.crashPoint = crashPoint;
    this.method = method;
    this.path = path;
  }
}

function isStoreCrash(error) {
  return Boolean(error) && error.name === 'StoreCrashError';
}

// Wraps `inner`. Options:
//   crashAtMutation   throw StoreCrashError BEFORE the nth mutating call takes
//                     effect (1-based). The call never happens -- this models a
//                     machine that died before the write reached the device.
//   crashAfterMutation
//                     let the nth mutating call take effect, then throw. Models
//                     a write that reached the device before the machine died,
//                     which is the harder half of the pair: the store must be
//                     safe whether or not the last write survived.
//   tornWriteAtMutation
//                     truncate the nth writeFile's contents to half, apply it,
//                     then throw. Models a partially-flushed page. The store's
//                     temp+rename recipe should make this invisible; the point
//                     is to prove that rather than assume it.
//   onMutation        async hook invoked BEFORE the nth mutating call. Used by
//                     the concurrency suite to interleave a competing operation
//                     at an exact await boundary, which is the only way to
//                     exercise "every post-await mutation revalidates lease
//                     ownership and current generation" deterministically.
class CrashInjectingFsFacade {
  constructor(inner, {
    crashAtMutation = null,
    crashAfterMutation = null,
    tornWriteAtMutation = null,
    onMutation = null,
    onMutationAt = null,
  } = {}) {
    this.inner = inner;
    this.crashAtMutation = crashAtMutation;
    this.crashAfterMutation = crashAfterMutation;
    this.tornWriteAtMutation = tornWriteAtMutation;
    this.onMutation = onMutation;
    this.onMutationAt = onMutationAt;
    this.mutationCount = 0;
    this.calls = [];
    this.crashed = null;

    for (const method of READ_METHODS) {
      this[method] = async (...args) => {
        this._assertNotCrashed(method, String(args[0] ?? ''));
        this.calls.push({ method, path: String(args[0] ?? ''), mutating: false });
        return this.inner[method](...args);
      };
    }
    for (const method of MUTATING_METHODS) {
      this[method] = (...args) => this._mutate(method, args);
    }
  }

  // Once a crash has fired the machine is OFF: every later call fails too.
  // Without this latch a store that catches its own errors could carry on past
  // the injected fault -- appendEvidence's degraded-observability try/catch did
  // exactly that, so crashing at any journal or audit boundary let the whole
  // operation run to completion and release its lease. Those points then
  // counted toward the sweep while proving nothing about process abandonment.
  _assertNotCrashed(method, targetPath) {
    if (this.crashed) {
      throw new StoreCrashError(this.crashed.point, method, targetPath);
    }
  }

  async _mutate(method, args) {
    this._assertNotCrashed(method, String(args[0] ?? ''));
    this.mutationCount += 1;
    const point = this.mutationCount;
    const targetPath = String(args[0] ?? '');
    this.calls.push({ method, path: targetPath, mutating: true, point });

    if (this.onMutation && (this.onMutationAt === null || this.onMutationAt === point)) {
      await this.onMutation({ point, method, path: targetPath });
    }

    if (this.crashAtMutation === point) {
      this.crashed = { point, method, path: targetPath, applied: false };
      throw new StoreCrashError(point, method, targetPath);
    }

    if (this.tornWriteAtMutation === point && method === 'writeFile') {
      const full = String(args[1] ?? '');
      const half = full.slice(0, Math.floor(full.length / 2));
      await this.inner.writeFile(args[0], half);
      this.crashed = { point, method, path: targetPath, applied: 'torn' };
      throw new StoreCrashError(point, method, targetPath);
    }

    const result = await this.inner[method](...args);

    if (this.crashAfterMutation === point) {
      this.crashed = { point, method, path: targetPath, applied: true };
      throw new StoreCrashError(point, method, targetPath);
    }
    return result;
  }

  // Every distinct boundary a crash could land on, for reporting.
  mutationTrace() {
    return this.calls.filter((call) => call.mutating).map((call) => `${call.point}:${call.method}`);
  }
}

function createCrashInjectingFs(inner, options) {
  return new CrashInjectingFsFacade(inner, options);
}

// Dry-runs `operation` with no crash injected and reports how many mutating
// calls it made, so a caller can then sweep k = 1..count exhaustively.
// `buildStore` must return a FRESH facade + baseDir each time it is called:
// every crash replay needs an identical pre-state, and rebuilding is cheaper
// and less error-prone than snapshotting a facade's private internals.
async function enumerateCrashPoints(buildStore, operation) {
  const { facade, baseDir } = await buildStore();
  const probe = createCrashInjectingFs(facade);
  await operation(probe, baseDir);
  return { count: probe.mutationCount, trace: probe.mutationTrace() };
}

// Runs `operation` once with a crash injected at `point`, in the given mode,
// against a freshly built store. Returns the surviving facade so the caller can
// run recovery against it. A crash is the expected outcome, so StoreCrashError
// is swallowed; any OTHER error propagates, because that would be a real defect
// rather than the injected fault.
//
// `crashed` reports whether the fault actually FIRED, and `crashInfo.point`
// where. Sweeps must assert on it: a replay in which the injected point was
// never reached is not a crash replay, and counting it as one silently shrinks
// the sweep.
//
// `propagated` separately reports whether the error escaped the operation. It
// is deliberately NOT the crash signal: store code legitimately converts I/O
// failures into domain results (readJsonFile reports 'corrupted' for any read
// error, appendEvidence downgrades a journal failure to degraded observability),
// so an un-propagated fault is normal. What makes the replay a true crash is the
// latch above -- once the fault fires no further bytes reach the store, so the
// surviving state is exactly the state a killed process would have left.
async function runWithCrash(buildStore, operation, point, mode = 'before') {
  const { facade, baseDir } = await buildStore();
  const optionKey = mode === 'after'
    ? 'crashAfterMutation'
    : mode === 'torn'
      ? 'tornWriteAtMutation'
      : 'crashAtMutation';
  const injecting = createCrashInjectingFs(facade, { [optionKey]: point });
  let propagated = false;
  try {
    await operation(injecting, baseDir);
  } catch (error) {
    if (!isStoreCrash(error)) throw error;
    propagated = true;
  }
  return {
    facade,
    baseDir,
    injecting,
    crashed: injecting.crashed !== null,
    propagated,
    crashInfo: injecting.crashed,
  };
}

module.exports = {
  MUTATING_METHODS,
  StoreCrashError,
  CrashInjectingFsFacade,
  createCrashInjectingFs,
  enumerateCrashPoints,
  runWithCrash,
  isStoreCrash,
};
