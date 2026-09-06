'use strict';

const crypto = require('node:crypto');
const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { stableStringify } = require('../package/canonical-metadata');
const { createMemoryFsFacade } = require('../store/fs-facade');
const { writeRemoteMcpBinding } = require('../store/remote-mcp-binding-store');
const { compileRemoteDescriptor } = require('./descriptor-compiler');
const { createRemoteMcpDiagnostics } = require('./diagnostics');
const { evaluateInvocationAuthority } = require('./invocation-authority');
const { extractMcpHeaders, validateSchemaInstance } = require('./json-schema-validator');
const { RemoteMcpScheduler } = require('./operation-scheduler');
const { RemoteMcpTransport } = require('./transport');

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function fail(reason, code = PLUGIN_ERROR_CODES.REMOTE_TRANSPORT_FAILED) {
  return { ok: false, code, reason, retryable: false };
}

function callShape(contribution, target, args) {
  if (contribution.kind === 'tool') {
    return { method: 'tools/call', params: { name: contribution.remote_name, arguments: args } };
  }
  if (contribution.kind === 'prompt') {
    return { method: 'prompts/get', params: { name: contribution.remote_name, arguments: args } };
  }
  if (contribution.kind === 'resource') {
    return { method: 'resources/read', params: { uri: target?.uri } };
  }
  return null;
}

class RemoteMcpService {
  constructor({ networkBroker, credentialBroker = null, facade, baseDir = '',
    scheduler = new RemoteMcpScheduler(), diagnostics = createRemoteMcpDiagnostics(),
    transportFactory = (options) => new RemoteMcpTransport(options) } = {}) {
    this._networkBroker = networkBroker;
    this._credentialBroker = credentialBroker;
    this._facade = facade;
    this._baseDir = baseDir;
    this._scheduler = scheduler;
    this._diagnostics = diagnostics;
    this._transportFactory = transportFactory;
    this._descriptors = new Map();
    this._discoveryControllers = new Set();
    this._disposed = false;
  }

  async discover({ bindingDraft, consent, context, credential = null } = {}) {
    if (this._disposed) return fail('remote_service_disposed');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (context?.signal?.aborted) abort();
    else context?.signal?.addEventListener('abort', abort, { once: true });
    this._discoveryControllers.add(controller);
    try {
      const transport = this._transportFactory({ networkBroker: this._networkBroker,
        binding: bindingDraft, consent, credential,
        context: { ...context, signal: controller.signal } });
      const compiled = await compileRemoteDescriptor({ transport, bindingDraft,
        facade: createMemoryFsFacade(), diagnostics: this._diagnostics });
      if (this._disposed) return fail('remote_service_disposed');
      if (!compiled.ok) return compiled;
      const stored = await writeRemoteMcpBinding(
        this._facade, this._baseDir, compiled.binding
      );
      if (this._disposed) return fail('remote_service_disposed');
      if (!stored.ok) return stored;
      const descriptor = { ...compiled, binding: stored.binding };
      this._descriptors.set(descriptor.binding.binding_digest, {
        ...descriptor, consent, context: { ...context, signal: null },
      });
      return { ok: true, binding: descriptor.binding,
        contributions: descriptor.runtime_binding.contributions, rejected: descriptor.rejected };
    } finally {
      context?.signal?.removeEventListener('abort', abort);
      this._discoveryControllers.delete(controller);
    }
  }

  async invoke({ binding, invocation, current, policy, arguments: args = {}, context,
    signal = null, authAuthority = null } = {}) {
    if (this._disposed) return fail('remote_service_disposed');
    const descriptor = this._descriptors.get(binding?.binding_digest);
    if (!descriptor) return fail('remote_descriptor_rediscovery_required');
    const contribution = descriptor.runtime_binding.contributions
      .find((item) => item.namespaced_name === invocation?.namespaced_name);
    const authority = evaluateInvocationAuthority({ binding,
      runtimeBinding: descriptor.runtime_binding, contribution, invocation, current, policy });
    if (!authority.ok) return authority;
    const compiledSchema = descriptor.compiled_schemas.get(contribution.namespaced_name);
    const validated = validateSchemaInstance(compiledSchema, args);
    if (!validated.ok) return fail(validated.reason, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
    const headers = extractMcpHeaders(compiledSchema, args);
    if (!headers.ok) return fail(headers.reason, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
    const target = descriptor.targets.get(contribution.namespaced_name);
    const shaped = callShape(contribution, target, args);
    if (!shaped || (contribution.kind === 'resource' && !target?.uri)) {
      return fail('remote_contribution_invalid');
    }
    return this._scheduler.submit(binding.binding_digest, async (operationSignal) => {
      let credential = null;
      if (policy.authorization === 'required' && (!authAuthority || !this._credentialBroker)) {
        return fail('remote_authorization_required', PLUGIN_ERROR_CODES.REMOTE_AUTH_REQUIRED);
      }
      if (policy.authorization === 'required') {
        const loaded = await this._credentialBroker.get(authAuthority, {
          revoked: policy.revoked_descriptor_digests?.has(binding.descriptor_digest) === true,
        });
        if (!loaded.ok) return loaded;
        credential = loaded.credential;
      }
      const transport = this._transportFactory({ networkBroker: this._networkBroker,
        binding, consent: descriptor.consent, credential,
        context: { ...descriptor.context, ...context, signal: operationSignal } });
      const result = await transport.call(shaped.method, shaped.params, { extraHeaders: headers.headers });
      if (!result.ok) {
        this._diagnostics.emit('WARN', 'plugins.remote_mcp.call_failed', {
          descriptor_digest: binding.descriptor_digest, reason: result.reason,
        });
        const { www_authenticate: _challenge, ...redactedResult } = result;
        return redactedResult;
      }
      return { ok: true, result: result.result, notifications: result.notifications,
        provenance: { publisher_id: binding.publisher_id, plugin_id: binding.plugin_id,
          contribution_id: binding.contribution_id, descriptor_digest: binding.descriptor_digest,
          binding_digest: binding.binding_digest, response_digest: digest(stableStringify(result.result)) } };
    }, { signal });
  }

  descriptorForBinding(bindingDigest) {
    const descriptor = this._descriptors.get(String(bindingDigest || ''));
    if (!descriptor) return null;
    return {
      binding: descriptor.binding,
      runtime_binding: descriptor.runtime_binding,
      contributions: descriptor.runtime_binding.contributions,
    };
  }

  descriptorForName(namespacedName, allowedBindingDigests = null) {
    const name = String(namespacedName || '');
    const descriptors = [...this._descriptors.values()].reverse();
    for (const descriptor of descriptors) {
      if (allowedBindingDigests
        && !allowedBindingDigests.has(descriptor.binding.binding_digest)) continue;
      const contribution = descriptor.runtime_binding.contributions
        .find((item) => item.namespaced_name === name);
      if (contribution) {
        return {
          binding: descriptor.binding,
          runtime_binding: descriptor.runtime_binding,
          contribution,
        };
      }
    }
    return null;
  }

  networkCounters() {
    return this._networkBroker?.getCounters?.() || {};
  }

  dispose() {
    this._disposed = true;
    for (const controller of this._discoveryControllers) controller.abort();
    this._discoveryControllers.clear();
    this._descriptors.clear();
    this._scheduler.dispose();
  }
}

module.exports = { digest, callShape, RemoteMcpService };
