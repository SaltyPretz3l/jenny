'use strict';

const crypto = require('node:crypto');
const { HookDedupeStore } = require('./dedupe-store');

function disposedResult() { return { ok: false, reason: 'hook_dispatcher_disposed' }; }

class HookDispatcher {
  constructor({ descriptors = () => [], invoke, currentAuthority, outbox = null,
    dedupe = new HookDedupeStore(), maximumQueue = 64,
    captureAuthority = () => null, guardAuthority = () => ({ ok: true }) } = {}) {
    this._descriptors = descriptors;
    this._invoke = invoke;
    this._current = currentAuthority;
    this._dedupe = dedupe;
    this._outbox = outbox;
    this._maximum = maximumQueue;
    this._queue = [];
    this._draining = null;
    this._disposed = false;
    this._captureAuthority = captureAuthority;
    this._guardAuthority = guardAuthority;
    this._recovery = this._outbox?.settleInterruptedPending?.()
      || Promise.resolve({ ok: false, reason: 'hook_outbox_unavailable' });
  }

  async enqueue(event) {
    if (this._disposed) return disposedResult();
    const policyToken = this._captureAuthority();
    const gated = this._guardAuthority(policyToken);
    if (!gated?.ok) return gated;
    const recovered = await this._recovery;
    if (this._disposed) return disposedResult();
    if (!recovered?.ok) return { ok: false, reason: 'hook_outbox_unavailable' };
    const bytes = Buffer.byteLength(JSON.stringify(event || {}), 'utf8');
    if (bytes > 65_536 || event?.causal_depth !== 1) return { ok: false, reason: 'hook_event_rejected' };
    if (this._queue.length >= this._maximum) return { ok: false, reason: 'hook_queue_full' };
    const id = event.event_id || crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
    if (this._dedupe.seen(id)) return { ok: true, duplicate: true };
    if (!this._outbox) return { ok: false, reason: 'hook_outbox_unavailable' };
    const pending = await this._outbox.putPending({ ...event, event_id: id });
    if (this._disposed) {
      if (pending?.ok && !pending.duplicate) {
        await this._outbox.settle(id, 'failed', 0, 'hook_dispatcher_disposed');
      }
      return disposedResult();
    }
    if (!pending?.ok || pending.duplicate) return pending;
    this._dedupe.record(id);
    this._queue.push({ event: { ...event, event_id: id }, policyToken });
    this._draining ||= this._drain().finally(() => { this._draining = null; });
    return { ok: true, event_id: id };
  }

  async _drain() {
    while (this._queue.length && !this._disposed) {
      const queued = this._queue.shift();
      const event = queued.event;
      if (!this._guardAuthority(queued.policyToken)?.ok) {
        await this._outbox.settle(event.event_id, 'failed', 0, 'managed_policy_revoked');
        continue;
      }
      const authority = await this._current();
      const matching = this._descriptors().filter((item) => item.event === event.event
        && item.publisher_id === event.publisher_id && item.plugin_id === event.plugin_id
        && item.active_generation_id === authority.active_generation_id
        && item.commit_epoch === authority.commit_epoch).slice(0, 8);
      let attempts = 0;
      let terminal = 'delivered';
      let reason = '';
      descriptorLoop: for (const descriptor of matching) {
        const maximumAttempts = descriptor.replay_safe === true ? 2 : 1;
        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
          let timer;
          try {
            if (!this._guardAuthority(queued.policyToken)?.ok) {
              terminal = 'failed';
              reason = 'managed_policy_revoked';
              break descriptorLoop;
            }
            attempts += 1;
            const result = await Promise.race([
              this._invoke({ descriptor, event, purpose: 'hook_delivery',
                forbidden: ['lifecycle', 'consent', 'secret', 'spawn', 'hook_emit'] }),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('hook_deadline_exceeded')),
                  Math.min(descriptor.deadline_ms, 2000));
              }),
            ]);
            clearTimeout(timer);
            if (!this._guardAuthority(queued.policyToken)?.ok) {
              terminal = 'failed';
              reason = 'managed_policy_revoked';
              break descriptorLoop;
            }
            if (result?.ok !== false) break;
            if (result.dispatched !== false || attempt === maximumAttempts) {
              terminal = result.dispatched === false ? 'failed' : 'indeterminate';
              reason = result.reason || 'hook_delivery_failed';
              break;
            }
          } catch (_error) {
            clearTimeout(timer);
            terminal = 'indeterminate';
            reason = 'hook_delivery_ambiguous';
            break;
          }
        }
      }
      await this._outbox.settle(event.event_id, terminal, attempts, reason);
    }
  }

  async idle() { await this._draining; }
  async revokeAll(reason = 'managed_policy_revoked') {
    const queued = this._queue.splice(0);
    await Promise.all(queued.map((item) => (
      this._outbox?.settle?.(item.event.event_id, 'failed', 0, reason)
    )));
    return { ok: true, rejected_count: queued.length };
  }
  async dispose() { this._disposed = true; this._queue.length = 0; await this._draining; }
}

module.exports = { HookDispatcher };
