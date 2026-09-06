'use strict';

const { PluginViewRuntimeAuthority } = require('./view/view-runtime-authority');
const { PluginViewBridgeRouter } = require('./view/bridge-router');
const { VIEW_LIMITS, STAGE7_LIMITS } = require('./view/stage7-budgets');
const { PluginProviderRuntimeIntegration } = require('./provider/provider-runtime-integration');
const { createPluginProviderAuthService } = require('./provider/provider-auth-service');
const { createStage7RuntimeCoordinator } = require('./runtime/stage7-runtime-coordinator');

const OFFICIAL_PROVIDER_PUBLISHER = 'jenny-official';

function createStage7ControlPlane({ runtimeCoordinator, viewHost, pluginService,
  chatgptAuthService, artifactHandlers = {}, onProviderChanged = async () => ({ ok: true }),
  activateProvider = async () => ({ ok: false, reason: 'provider_activation_unavailable' }),
  sessionProviderCall = null,
  authorizeSessionView = null,
  onSessionViewDestroyed = null,
  log = () => {}, providerAuthLog = log } = {}) {
  if (!runtimeCoordinator || !viewHost || !pluginService) {
    throw new TypeError('stage7 control plane dependencies invalid');
  }
  const providerRuntime = new PluginProviderRuntimeIntegration({
    onChanged: onProviderChanged, log,
  });
  const viewAuthority = new PluginViewRuntimeAuthority({ host: viewHost, log });
  const providerAuth = createPluginProviderAuthService({
    chatgptAuthService,
    isProviderActive: (providerId) => providerRuntime.snapshot().providers.includes(providerId),
    onAuthChanged: onProviderChanged,
    log: providerAuthLog,
  });
  let artifactPayload = null;
  const clearArtifactPayload = (viewInstanceId = null) => {
    if (viewInstanceId && artifactPayload?.viewInstanceId !== viewInstanceId) return;
    artifactPayload = null;
  };
  async function readScopedSettings(context) {
    const state = await pluginService.getState();
    if (!state?.ok || !Array.isArray(state.plugins)) {
      return { ok: false, reason: state?.reason || 'plugin_settings_unavailable' };
    }
    const plugin = state.plugins.find((item) => item?.publisher_id === context.publisherId
      && item?.plugin_id === context.pluginId);
    const contribution = plugin?.contributions?.find(
      (item) => item?.contribution_id === context.contributionId,
    );
    if (!plugin || !contribution) return { ok: false, reason: 'plugin_settings_unavailable' };
    return { ok: true, value: {
      publisher_id: context.publisherId,
      plugin_id: context.pluginId,
      contribution_id: context.contributionId,
      settings: contribution.settings || null,
    } };
  }
  function resolveProviderRequest(payload, context) {
    const providerId = typeof payload?.provider_id === 'string' ? payload.provider_id : '';
    const descriptor = context?.descriptor;
    if (descriptor?.publisher_id !== OFFICIAL_PROVIDER_PUBLISHER
      || descriptor.kind !== 'setup_scene'
      || !descriptor.content?.provider_ref
      || providerId !== descriptor.content.provider_ref) {
      return { ok: false, reason: 'provider_view_authority_rejected' };
    }
    const provider = providerRuntime.resolve(providerId, {
      generation_id: context.generationId,
      commit_epoch: context.commitEpoch,
    });
    return provider ? { ok: true, providerId } : { ok: false, reason: 'provider_not_active' };
  }
  async function withProviderRequest(payload, context, operation) {
    const resolved = resolveProviderRequest(payload, context);
    return resolved.ok ? operation(resolved.providerId) : resolved;
  }
  const builtInArtifactHandlers = {
    readChunk: async (payload = {}, context = {}) => {
      if (!artifactPayload
        || (artifactPayload.viewInstanceId
          && artifactPayload.viewInstanceId !== context.viewInstanceId)
        || artifactPayload.artifactDigest !== context.artifactDigest
        || artifactPayload.contributionId !== context.contributionId
        || artifactPayload.generationId !== context.generationId
        || artifactPayload.commitEpoch !== context.commitEpoch) {
        return { ok: false, reason: 'artifact_payload_unavailable' };
      }
      if (!artifactPayload.viewInstanceId) artifactPayload.viewInstanceId = context.viewInstanceId;
      const bytes = artifactPayload.bytes;
      const offset = Number.isSafeInteger(payload.offset) && payload.offset >= 0 ? payload.offset : 0;
      if (offset > bytes.length) return { ok: false, reason: 'artifact_offset_invalid' };
      // Base64 plus the result envelope must remain inside the 64 KiB bridge
      // response ceiling. The contract's 64 KiB artifact chunk is a hard
      // maximum; 40 KiB is the largest conservative JSON-safe transport slice.
      const requested = Number.isSafeInteger(payload.max_bytes) && payload.max_bytes > 0
        ? Math.min(payload.max_bytes, 40 * 1024) : 40 * 1024;
      const end = Math.min(bytes.length, offset + requested);
      return { ok: true, value: { offset, next_offset: end, total_bytes: bytes.length,
        done: end >= bytes.length, encoding: 'base64',
        chunk: bytes.subarray(offset, end).toString('base64') } };
    },
    ready: async () => ({ ok: true, value: { accepted: true } }),
    error: async () => ({ ok: true, value: { accepted: true } }),
  };
  const handlers = {
    get_context: async (_payload, context) => ({ ok: true, value: {
      publisher_id: context.publisherId, plugin_id: context.pluginId,
      contribution_id: context.contributionId, generation_id: context.generationId,
      commit_epoch: context.commitEpoch,
      ...(context.sessionProviderAuthorized === true ? {
        session_provider_authorized: true,
      } : {}),
    } }),
    read_settings: async (_payload, context) => readScopedSettings(context),
    update_settings: async (payload, context) => pluginService.updateSettings({
      ...payload, publisher_id: context.publisherId, plugin_id: context.pluginId,
      contribution_id: context.contributionId,
    }),
    provider_auth_status: async (payload, context) => withProviderRequest(
      payload, context, (providerId) => providerAuth.status(providerId),
    ),
    provider_auth_start: async (payload, context) => withProviderRequest(
      payload, context, (providerId) => providerAuth.start(providerId, {}),
    ),
    provider_auth_cancel: async (payload, context) => withProviderRequest(
      payload, context, (providerId) => providerAuth.cancel(providerId),
    ),
    provider_auth_sign_out: async (payload, context) => withProviderRequest(
      payload, context, (providerId) => providerAuth.signOut(providerId),
    ),
    provider_activate: async (payload, context) => withProviderRequest(
      payload, context, async (providerId) => {
        const result = await activateProvider(providerId);
        if (result?.ok === true) {
          const viewInstanceId = context.viewInstanceId;
          setImmediate(() => viewHost.sendHostCommand?.('provider_activated', {
            provider_id: providerId,
          }, viewInstanceId));
        }
        return result;
      },
    ),
    artifact_read_chunk: artifactHandlers.readChunk || builtInArtifactHandlers.readChunk,
    artifact_ready: artifactHandlers.ready || builtInArtifactHandlers.ready,
    artifact_error: artifactHandlers.error || builtInArtifactHandlers.error,
  };
  const bridgeRouter = new PluginViewBridgeRouter({
    resolveContext: (event) => {
      const context = viewHost.contextForEvent(event);
      const descriptor = viewHost.active?.descriptor;
      return context && descriptor ? {
        ...context,
        publisherId: descriptor.publisher_id,
        pluginId: descriptor.plugin_id,
        generationId: descriptor.generation_id,
        descriptor,
      } : null;
    },
    handlers,
    sessionProviderHandler: sessionProviderCall,
    log,
  });
  viewHost.setOnViewDestroyed?.(async (viewInstanceId, reason, destroyedContext = {}) => {
    if (reason === 'view_crash_restart') {
      if (artifactPayload?.viewInstanceId === viewInstanceId) artifactPayload.viewInstanceId = null;
    } else clearArtifactPayload(viewInstanceId);
    bridgeRouter.detach(viewInstanceId);
    if (typeof onSessionViewDestroyed === 'function') {
      try {
        return await onSessionViewDestroyed({ ...destroyedContext, viewInstanceId }, reason);
      } catch (_error) { return { ok: false, reason: 'session_view_teardown_failed' }; }
    }
    return { ok: true };
  });
  const unsubscribeProviderAuth = providerAuth.onStatusChange((auth) => {
    const active = viewHost.active;
    if (!active) return;
    bridgeRouter.publish(active.viewInstanceId, 'provider_auth_changed', { auth },
      (event) => viewHost.sendEvent(event));
  });
  const coordinator = createStage7RuntimeCoordinator({
    runtimeCoordinator, viewAuthority, providerRuntime,
  });

  function bridgeEnvelope(event, raw = {}) {
    const context = viewHost.contextForEvent(event);
    if (!context) return null;
    let payload;
    if (raw.method === 'request') {
      payload = raw.operation === 'session_provider_call'
        ? { call_schema_version: 1, request_id: raw.request_id,
          action: raw.payload?.action,
          payload_json: JSON.stringify(raw.payload?.payload ?? {}) }
        : { call_schema_version: 5, request_id: raw.request_id,
          operation: raw.operation, payload_json: JSON.stringify(raw.payload ?? {}) };
    } else payload = { request_id: raw.request_id, topic: raw.topic };
    return {
      bridge_schema_version: 1,
      view_instance_id: context.viewInstanceId,
      contribution_id: context.contributionId,
      artifact_digest: context.artifactDigest,
      commit_epoch: context.commitEpoch,
      lifecycle_epoch: context.lifecycleEpoch,
      method: raw.method,
      payload_json: JSON.stringify(payload),
      limits: VIEW_LIMITS,
    };
  }

  return Object.freeze({
    runtimeCoordinator: coordinator,
    bridge: (event, raw) => {
      const envelope = bridgeEnvelope(event, raw);
      return envelope ? bridgeRouter.route(event, envelope)
        : { result_schema_version: 5, request_id: 'bridge_request', status: 'rejected',
          reason_code: 'bridge_sender_rejected', retryable: false, payload_json: 'null' };
    },
    openView: (descriptor, options) => viewHost.open(descriptor, options),
    openViewContribution: async (identity, options) => {
      const descriptor = viewAuthority.findDescriptor(identity || {});
      if (!descriptor) return { ok: false, reason: 'view_contribution_not_active' };
      let candidateArtifactPayload = null;
      if (identity?.artifact_payload_json !== undefined) {
        if (typeof identity.artifact_payload_json !== 'string') {
          return { ok: false, reason: 'artifact_payload_invalid' };
        }
        const bytes = Buffer.from(identity.artifact_payload_json, 'utf8');
        if (bytes.length > STAGE7_LIMITS.artifact_payload_bytes) {
          return { ok: false, reason: 'artifact_payload_too_large' };
        }
        try { JSON.parse(identity.artifact_payload_json); } catch (_error) {
          return { ok: false, reason: 'artifact_payload_invalid' };
        }
        candidateArtifactPayload = {
          bytes,
          artifactDigest: descriptor.artifact_digest,
          contributionId: descriptor.contribution_id,
          generationId: descriptor.generation_id,
          commitEpoch: descriptor.commit_epoch,
        };
      }
      let sessionBinding = null;
      if (identity?.sessionId !== undefined) {
        if (typeof authorizeSessionView !== 'function') {
          return { ok: false, reason: 'plugin_session_view_unavailable' };
        }
        const authorized = await authorizeSessionView(identity.sessionId, descriptor);
        if (!authorized?.ok) return authorized;
        sessionBinding = {
          sessionId: String(identity.sessionId || '').trim(),
          sessionIncarnation: authorized.sessionIncarnation,
        };
      }
      const opened = await viewHost.open(descriptor, { ...options, ...sessionBinding });
      if (opened?.ok) {
        artifactPayload = candidateArtifactPayload && {
          ...candidateArtifactPayload,
          viewInstanceId: opened.view_instance_id,
        };
      }
      return opened;
    },
    setBounds: (bounds) => viewHost.setBounds(bounds),
    setZoom: (factor) => viewHost.setZoom(factor),
    closeView: () => { clearArtifactPayload(); return viewHost.destroyAll('user_closed'); },
    focusView: () => viewHost.focus(),
    getState: () => ({ ok: true, stage: 7, views: viewAuthority.snapshot(),
      providers: providerRuntime.snapshot() }),
    dispose: async () => {
      clearArtifactPayload();
      try { unsubscribeProviderAuth?.(); } catch (_error) { /* ignore */ }
      providerRuntime.dispose();
      await viewAuthority.dispose();
    },
  });
}

module.exports = { createStage7ControlPlane };
