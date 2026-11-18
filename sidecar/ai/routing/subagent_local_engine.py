"""The local model a cloud primary's delegate children may run on (row 179).

Electron describes a ready managed local server (NInfer or llama-server) as
``local_subagent_engine`` and brokers its key separately. The sidecar sees an
ordinary OpenAI-compatible endpoint and builds the child from it; nothing here
knows how the server is run.
"""

from __future__ import annotations

from dataclasses import MISSING, fields, replace

from sidecar.ai.config_models import (
    SYSTEM_PROMPT_DEFAULT,
    SYSTEM_PROMPT_MINIMAL,
    SYSTEM_PROMPT_PROFILE_AUTO,
    RuntimeConfig,
)
from sidecar.ai.local_subagent_endpoint import (  # noqa: F401 - re-exported for callers.
    LOCAL_SUBAGENT_ALIAS,
    LOCAL_SUBAGENT_ENGINE_TYPE,
    LocalSubagentEngine,
    parse_local_subagent_engine,
)
from sidecar.ai.model_profile_resolution import (
    _append_system_prompt_addendum,
    apply_model_profile,
)


def _without_parent_addendum(parent: RuntimeConfig) -> str:
    """The parent's prompt without its model's profile addendum (the stack appended it)."""
    prompt = str(parent.system_prompt or "").rstrip()
    addendum = str(parent.resolved_app_profile_prompt_addendum or "").strip()
    if addendum and prompt.endswith(addendum):
        return prompt[: -len(addendum)].rstrip()
    return prompt


def local_child_config(parent: RuntimeConfig, helper: LocalSubagentEngine) -> RuntimeConfig:
    """The child's config: the helper endpoint and the local model's profile, no cloud key."""
    system_prompt = _without_parent_addendum(parent)
    if system_prompt == SYSTEM_PROMPT_MINIMAL:
        system_prompt = SYSTEM_PROMPT_DEFAULT
    # Whatever the parent's model resolved belongs to that model; start clean.
    profile_defaults = {
        item.name: item.default for item in fields(RuntimeConfig)
        if item.name.startswith("resolved_app_profile_") and item.default is not MISSING
    }
    config = replace(
        parent,
        **profile_defaults,
        engine_type=LOCAL_SUBAGENT_ENGINE_TYPE,
        model=helper.model,
        api_url=helper.base_url,
        openai_compatible_api_key=helper.api_key,
        api_provider_key=None,
        api_provider_descriptor=None,
        api_provider_model_limits=None,
        api_provider_subagent_models=(),
        chatgpt_access_token=None,
        chatgpt_account_id=None,
        chatgpt_model_catalog=(),
        chatgpt_base_url=None,
        fallback_models=(),
        reasoning_effort="",
        context_length=helper.context_length,
        context_length_override=None,
        app_profile="",
        # The parent's API route stored the minimal profile; a local model
        # needs the local tool guidance, so the profile resolves afresh.
        system_prompt_profile=SYSTEM_PROMPT_PROFILE_AUTO,
        system_prompt=system_prompt,
        managed_prefill_progress=helper.prefill_progress,
        json_schema_response_format=helper.json_schema_response_format,
    )
    config, _profile = apply_model_profile(
        config, engine_type=LOCAL_SUBAGENT_ENGINE_TYPE, model=helper.model,
    )
    # The server's own window is the hard bound; a profile clamp may only lower it.
    context = config.context_length
    if helper.context_length is not None:
        context = min(context or helper.context_length, helper.context_length)
    return replace(
        config,
        context_length=context,
        system_prompt=_append_system_prompt_addendum(
            config.system_prompt, config.resolved_app_profile_prompt_addendum,
        ),
    )
